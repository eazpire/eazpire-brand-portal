/**
 * Read-sync brand products from Printify + single-product get/update
 */

import { json, getCorsHeaders } from "../../utils/response.js";
import { newId } from "./db.js";
import { getBrandPrintifyCredentials } from "./brandConnections.js";
import { resolveBrandAuthContext } from "./brandAuthContext.js";
import { BRAND_API_SCOPES } from "./rbac.js";
import { emitBrandWebhook } from "./brandWebhookDelivery.js";

async function printifyGet(token, path) {
  const res = await fetch(`https://api.printify.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "eazpire-brand-portal",
    },
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function extractShopifyId(product) {
  const ext = product?.external || {};
  if (ext.id) return String(ext.id);
  if (product?.shopify_product_id) return String(product.shopify_product_id);
  return null;
}

function mapProductRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    printify_product_id: row.printify_product_id,
    shopify_product_id: row.shopify_product_id,
    title: row.title,
    status: row.status,
    thumbnail_url: row.thumbnail_url,
    last_synced_at: row.last_synced_at,
    updated_at: row.updated_at,
    eazpire_shopify_product_id: row.eazpire_shopify_product_id,
    eazpire_handle: row.eazpire_handle,
    dual_publish_status: row.dual_publish_status,
    dual_publish_error: row.dual_publish_error,
    dual_published_at: row.dual_published_at,
  };
}

export async function handleBrandProductsList(request, env) {
  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.PRODUCTS_READ,
    allowSuspended: true,
  });
  if (resolved.error) return resolved.error;
  const { cors, db, brand } = resolved;

  const url = new URL(request.url);
  const statusFilter = String(url.searchParams.get("status") || "").trim().toLowerCase();

  let sql = `SELECT id, printify_product_id, shopify_product_id, title, status, thumbnail_url, last_synced_at, updated_at,
                    eazpire_shopify_product_id, eazpire_handle, dual_publish_status, dual_publish_error, dual_published_at
             FROM brand_products WHERE brand_id = ?`;
  const binds = [brand.id];
  if (statusFilter === "active" || statusFilter === "draft") {
    sql += ` AND lower(COALESCE(status,'')) = ?`;
    binds.push(statusFilter);
  }
  sql += ` ORDER BY updated_at DESC LIMIT 500`;

  const rows = await db.prepare(sql).bind(...binds).all();
  return json({ ok: true, products: rows?.results || [] }, 200, cors);
}

/** GET single product by id (query product_id or path rewrite) */
export async function handleBrandProductGet(request, env) {
  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.PRODUCTS_READ,
    allowSuspended: true,
  });
  if (resolved.error) return resolved.error;
  const { cors, db, brand } = resolved;

  const url = new URL(request.url);
  const productId = String(url.searchParams.get("product_id") || url.searchParams.get("id") || "").trim();
  if (!productId) return json({ ok: false, error: "product_id_required" }, 400, cors);

  const row = await db
    .prepare(
      `SELECT id, printify_product_id, shopify_product_id, title, status, thumbnail_url, last_synced_at, updated_at,
              eazpire_shopify_product_id, eazpire_handle, dual_publish_status, dual_publish_error, dual_published_at
       FROM brand_products WHERE brand_id = ? AND id = ? LIMIT 1`
    )
    .bind(brand.id, productId)
    .first();

  if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
  return json({ ok: true, product: mapProductRow(row) }, 200, cors);
}

/**
 * Update local catalog metadata (title / status).
 * Does not write back to Printify — re-sync may overwrite title/status from Printify.
 */
export async function handleBrandProductUpdate(request, env, ctx) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST" && request.method !== "PATCH" && request.method !== "PUT") {
    return json({ ok: false, error: "method_not_allowed" }, 405, cors);
  }

  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.PRODUCTS_WRITE,
  });
  if (resolved.error) return resolved.error;
  const { db, brand } = resolved;

  const url = new URL(request.url);
  const body = await request.json().catch(() => ({}));
  const productId = String(
    body.product_id || body.id || url.searchParams.get("product_id") || url.searchParams.get("id") || ""
  ).trim();
  if (!productId) return json({ ok: false, error: "product_id_required" }, 400, cors);

  const row = await db
    .prepare(`SELECT * FROM brand_products WHERE brand_id = ? AND id = ? LIMIT 1`)
    .bind(brand.id, productId)
    .first();
  if (!row) return json({ ok: false, error: "not_found" }, 404, cors);

  let title = row.title;
  let status = row.status;
  if (body.title != null) {
    title = String(body.title).trim().slice(0, 200);
    if (!title) return json({ ok: false, error: "invalid_title" }, 400, cors);
  }
  if (body.status != null) {
    const s = String(body.status).trim().toLowerCase();
    if (s !== "active" && s !== "draft") {
      return json({ ok: false, error: "invalid_status", allowed: ["active", "draft"] }, 400, cors);
    }
    status = s;
  }

  const now = Date.now();
  await db
    .prepare(`UPDATE brand_products SET title = ?, status = ?, updated_at = ? WHERE id = ?`)
    .bind(title, status, now, productId)
    .run();

  const updated = await db
    .prepare(
      `SELECT id, printify_product_id, shopify_product_id, title, status, thumbnail_url, last_synced_at, updated_at,
              eazpire_shopify_product_id, eazpire_handle, dual_publish_status, dual_publish_error, dual_published_at
       FROM brand_products WHERE id = ?`
    )
    .bind(productId)
    .first();

  emitBrandWebhook(env, ctx, brand.id, "product.updated", {
    product: mapProductRow(updated),
  });

  return json({ ok: true, product: mapProductRow(updated) }, 200, cors);
}

export async function handleBrandProductsSync(request, env, ctx) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.PRODUCTS_SYNC,
  });
  if (resolved.error) return resolved.error;
  const { db, brand } = resolved;

  const creds = await getBrandPrintifyCredentials(env, brand.id);
  if (!creds?.api_token || !creds.shop_id) {
    return json({ ok: false, error: "printify_not_connected" }, 400, cors);
  }

  let page = 1;
  let synced = 0;
  const now = Date.now();
  const seen = new Set();

  while (page <= 20) {
    const res = await printifyGet(
      creds.api_token,
      `/shops/${creds.shop_id}/products.json?limit=50&page=${page}`
    );
    if (!res.ok) {
      return json({ ok: false, error: "printify_fetch_failed", detail: res.data, status: res.status }, 400, cors);
    }

    const list = Array.isArray(res.data?.data) ? res.data.data : Array.isArray(res.data) ? res.data : [];
    if (!list.length) break;

    for (const p of list) {
      const printifyId = String(p.id);
      seen.add(printifyId);
      const title = p.title || `Product ${printifyId}`;
      const status = p.visible === false ? "draft" : p.status || "active";
      const thumb =
        p.images?.[0]?.src ||
        p.preview_image ||
        (Array.isArray(p.images) && p.images[0]?.src) ||
        null;
      const shopifyId = extractShopifyId(p);

      const existing = await db
        .prepare(`SELECT id FROM brand_products WHERE brand_id = ? AND printify_product_id = ?`)
        .bind(brand.id, printifyId)
        .first();

      if (existing) {
        await db
          .prepare(
            `UPDATE brand_products
             SET title = ?, status = ?, thumbnail_url = ?, shopify_product_id = COALESCE(?, shopify_product_id),
                 external_json = ?, last_synced_at = ?, updated_at = ?
             WHERE id = ?`
          )
          .bind(title, status, thumb, shopifyId, JSON.stringify({ id: p.id, visible: p.visible }), now, now, existing.id)
          .run();
      } else {
        await db
          .prepare(
            `INSERT INTO brand_products
              (id, brand_id, printify_product_id, shopify_product_id, title, status, thumbnail_url, external_json, last_synced_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            newId("bp"),
            brand.id,
            printifyId,
            shopifyId,
            title,
            status,
            thumb,
            JSON.stringify({ id: p.id, visible: p.visible }),
            now,
            now,
            now
          )
          .run();
      }
      synced += 1;
    }

    if (list.length < 50) break;
    page += 1;
  }

  emitBrandWebhook(env, ctx, brand.id, "product.synced", {
    synced,
    pages: page,
  });

  return json({ ok: true, synced, pages: page }, 200, cors);
}
