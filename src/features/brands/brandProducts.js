/**
 * Read-sync brand products from Printify
 */

import { json, getCorsHeaders } from "../../utils/response.js";
import { getBrandDb, brandDbUnavailable, newId, ensureBrandSchema } from "./db.js";
import { requireBrandSession } from "./rbac.js";
import { getOwnedBrand } from "./brandProfile.js";
import { getBrandPrintifyCredentials } from "./brandConnections.js";

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

export async function handleBrandProductsList(request, env) {
  const cors = getCorsHeaders(request);
  const session = await requireBrandSession(request, env);
  if (!session) return json({ ok: false, error: "unauthorized" }, 401, cors);
  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const brand = await getOwnedBrand(db, session.uid);
  if (!brand) return json({ ok: false, error: "brand_required" }, 400, cors);

  const url = new URL(request.url);
  const statusFilter = String(url.searchParams.get("status") || "").trim().toLowerCase();

  let sql = `SELECT id, printify_product_id, shopify_product_id, title, status, thumbnail_url, last_synced_at, updated_at
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

export async function handleBrandProductsSync(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);
  const session = await requireBrandSession(request, env);
  if (!session) return json({ ok: false, error: "unauthorized" }, 401, cors);
  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const brand = await getOwnedBrand(db, session.uid);
  if (!brand) return json({ ok: false, error: "brand_required" }, 400, cors);

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

  return json({ ok: true, synced, pages: page }, 200, cors);
}
