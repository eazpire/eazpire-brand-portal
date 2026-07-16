/**
 * Mirror brand catalog products onto the eazpire Shopify store (platform credentials).
 * Tags: brand, eaz-brand:{handle} — metafields custom.brand_handle / custom.brand_name.
 */

import { json, getCorsHeaders } from "../../utils/response.js";
import { shopifyAPI } from "../../utils/shopify.js";
import { resolveBrandAuthContext } from "./brandAuthContext.js";
import { BRAND_API_SCOPES } from "./rbac.js";
import { emitBrandWebhook } from "./brandWebhookDelivery.js";

function shopDomain(env) {
  return String(env.SHOPIFY_SHOP || "allyoucanpink.myshopify.com")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function upsertEazpireListing(env, { brand, product }) {
  const shop = shopDomain(env);
  if (!env.SHOPIFY_ACCESS_TOKEN) {
    throw new Error("shopify_access_token_missing");
  }

  const handle = `brand-${brand.handle}-${product.printify_product_id || product.id}`.slice(0, 100);
  const title = product.title || `Brand product ${product.printify_product_id || ""}`;
  const tags = ["brand", `eaz-brand:${brand.handle}`, `brand:${brand.handle}`].join(", ");
  const bodyHtml = `<p>${escapeHtml(brand.name)}</p>${
    brand.tagline ? `<p>${escapeHtml(brand.tagline)}</p>` : ""
  }`;

  const images = product.thumbnail_url ? [{ src: product.thumbnail_url }] : [];

  if (product.eazpire_shopify_product_id) {
    const payload = {
      product: {
        id: Number(product.eazpire_shopify_product_id),
        title,
        body_html: bodyHtml,
        vendor: brand.name,
        product_type: "Brand",
        tags,
        status: "active",
      },
    };
    const updated = await shopifyAPI(env, shop, `products/${product.eazpire_shopify_product_id}.json`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    await setBrandMetafields(env, shop, product.eazpire_shopify_product_id, brand);
    return {
      shopify_product_id: String(updated?.product?.id || product.eazpire_shopify_product_id),
      handle: updated?.product?.handle || product.eazpire_handle || handle,
    };
  }

  const created = await shopifyAPI(env, shop, "products.json", {
    method: "POST",
    body: JSON.stringify({
      product: {
        title,
        body_html: bodyHtml,
        vendor: brand.name,
        product_type: "Brand",
        handle,
        tags,
        status: "active",
        images,
        variants: [
          {
            price: "29.99",
            requires_shipping: true,
            inventory_management: null,
          },
        ],
      },
    }),
  });

  const pid = String(created?.product?.id || "");
  if (pid) await setBrandMetafields(env, shop, pid, brand);

  return {
    shopify_product_id: pid,
    handle: created?.product?.handle || handle,
  };
}

async function setBrandMetafields(env, shop, productId, brand) {
  try {
    await shopifyAPI(env, shop, "graphql.json", {
      method: "POST",
      body: JSON.stringify({
        query: `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors { field message }
          }
        }`,
        variables: {
          metafields: [
            {
              ownerId: `gid://shopify/Product/${productId}`,
              namespace: "custom",
              key: "brand_handle",
              type: "single_line_text_field",
              value: brand.handle,
            },
            {
              ownerId: `gid://shopify/Product/${productId}`,
              namespace: "custom",
              key: "brand_name",
              type: "single_line_text_field",
              value: brand.name,
            },
          ],
        },
      }),
    });
  } catch (e) {
    console.warn("[brand-dual-publish] metafieldsSet failed", e?.message || e);
  }
}

/**
 * Draft (hide) an eazpire listing. Clears dual-publish status in D1.
 * Does not delete the Shopify product (safer for ops / recovery).
 */
async function draftEazpireListing(env, product) {
  const shop = shopDomain(env);
  const pid = String(product.eazpire_shopify_product_id || "").trim();
  if (!pid) return { skipped: true, reason: "no_eazpire_id" };
  if (!env.SHOPIFY_ACCESS_TOKEN) {
    throw new Error("shopify_access_token_missing");
  }

  await shopifyAPI(env, shop, `products/${pid}.json`, {
    method: "PUT",
    body: JSON.stringify({
      product: {
        id: Number(pid),
        status: "draft",
      },
    }),
  });
  return { shopify_product_id: pid, status: "draft" };
}

/**
 * Core publish helper — usable by brand session API and admin force ops.
 * @param {{ productIds?: string[], limit?: number, ctx?: object }} opts
 */
export async function publishBrandProductsToEazpire(env, db, brand, opts = {}) {
  const productIds = Array.isArray(opts.productIds)
    ? opts.productIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const limit = Math.min(Math.max(Number(opts.limit || 20) || 20, 1), 50);

  let rows;
  if (productIds.length === 1) {
    rows = await db
      .prepare(`SELECT * FROM brand_products WHERE brand_id = ? AND id = ?`)
      .bind(brand.id, productIds[0])
      .all();
  } else if (productIds.length > 1) {
    const placeholders = productIds.map(() => "?").join(",");
    rows = await db
      .prepare(
        `SELECT * FROM brand_products WHERE brand_id = ? AND id IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`
      )
      .bind(brand.id, ...productIds, limit)
      .all();
  } else {
    rows = await db
      .prepare(
        `SELECT * FROM brand_products
         WHERE brand_id = ? AND (dual_publish_status IS NULL OR dual_publish_status != 'published')
         ORDER BY updated_at DESC LIMIT ?`
      )
      .bind(brand.id, limit)
      .all();
  }

  const products = rows?.results || [];
  if (!products.length) {
    return { published: 0, results: [], message: "nothing_to_publish" };
  }

  const results = [];
  for (const product of products) {
    const now = Date.now();
    try {
      const out = await upsertEazpireListing(env, { brand, product });
      await db
        .prepare(
          `UPDATE brand_products
           SET eazpire_shopify_product_id = ?, eazpire_handle = ?, dual_publish_status = 'published',
               dual_publish_error = NULL, dual_published_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(out.shopify_product_id, out.handle, now, now, product.id)
        .run();
      results.push({ id: product.id, ok: true, ...out });
      emitBrandWebhook(env, opts.ctx, brand.id, "product.published", {
        product_id: product.id,
        printify_product_id: product.printify_product_id,
        title: product.title,
        eazpire_shopify_product_id: out.shopify_product_id,
        eazpire_handle: out.handle,
        dual_publish_status: "published",
      });
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 400);
      await db
        .prepare(
          `UPDATE brand_products
           SET dual_publish_status = 'error', dual_publish_error = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(msg, now, product.id)
        .run();
      results.push({ id: product.id, ok: false, error: msg });
    }
  }

  return {
    published: results.filter((r) => r.ok).length,
    results,
  };
}

/**
 * Core unpublish helper — drafts eazpire listings and clears dual-publish status.
 * @param {{ productIds?: string[], all?: boolean, ctx?: object }} opts
 */
export async function unpublishBrandProductsFromEazpire(env, db, brand, opts = {}) {
  const productIds = Array.isArray(opts.productIds)
    ? opts.productIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const all = opts.all === true;

  let rows;
  if (productIds.length) {
    const placeholders = productIds.map(() => "?").join(",");
    rows = await db
      .prepare(
        `SELECT * FROM brand_products
         WHERE brand_id = ? AND id IN (${placeholders})
           AND eazpire_shopify_product_id IS NOT NULL AND eazpire_shopify_product_id != ''`
      )
      .bind(brand.id, ...productIds)
      .all();
  } else if (all) {
    rows = await db
      .prepare(
        `SELECT * FROM brand_products
         WHERE brand_id = ?
           AND eazpire_shopify_product_id IS NOT NULL AND eazpire_shopify_product_id != ''
         ORDER BY updated_at DESC LIMIT 200`
      )
      .bind(brand.id)
      .all();
  } else {
    return { unpublished: 0, results: [], message: "product_ids_or_all_required" };
  }

  const products = rows?.results || [];
  if (!products.length) {
    return { unpublished: 0, results: [], message: "nothing_to_unpublish" };
  }

  const results = [];
  for (const product of products) {
    const now = Date.now();
    try {
      const out = await draftEazpireListing(env, product);
      await db
        .prepare(
          `UPDATE brand_products
           SET dual_publish_status = 'unpublished', dual_publish_error = NULL,
               dual_published_at = NULL, updated_at = ?
           WHERE id = ?`
        )
        .bind(now, product.id)
        .run();
      results.push({ id: product.id, ok: true, ...out });
      emitBrandWebhook(env, opts.ctx, brand.id, "product.unpublished", {
        product_id: product.id,
        printify_product_id: product.printify_product_id,
        title: product.title,
        eazpire_shopify_product_id: product.eazpire_shopify_product_id,
        eazpire_handle: product.eazpire_handle,
        dual_publish_status: "unpublished",
      });
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 400);
      await db
        .prepare(
          `UPDATE brand_products
           SET dual_publish_status = 'error', dual_publish_error = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(msg, now, product.id)
        .run();
      results.push({ id: product.id, ok: false, error: msg });
    }
  }

  return {
    unpublished: results.filter((r) => r.ok).length,
    results,
  };
}

/** POST ?op=brand-dual-publish | brand-products-publish | brand-api-publish
 * Dual-publish allowed with valid Brand API key (brand-scoped) OR portal session.
 * Link eazpire Account is NOT required for catalog dual-publish — only for Creator design workspace. */
export async function handleBrandDualPublish(request, env, ctx) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.PRODUCTS_PUBLISH,
  });
  if (resolved.error) return resolved.error;
  const { db, brand } = resolved;

  const body = await request.json().catch(() => ({}));
  const productId = String(body.product_id || "").trim();
  const productIds = Array.isArray(body.product_ids)
    ? body.product_ids.map((id) => String(id).trim()).filter(Boolean)
    : productId
      ? [productId]
      : [];
  const limit = Math.min(Math.max(Number(body.limit || 20) || 20, 1), 50);

  const out = await publishBrandProductsToEazpire(env, db, brand, { productIds, limit, ctx });
  return json({ ok: true, ...out }, 200, cors);
}

/** POST ?op=brand-products-unpublish | brand-api-unpublish | brand-dual-unpublish */
export async function handleBrandDualUnpublish(request, env, ctx) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.PRODUCTS_PUBLISH,
  });
  if (resolved.error) return resolved.error;
  const { db, brand } = resolved;

  const body = await request.json().catch(() => ({}));
  const productId = String(body.product_id || "").trim();
  const productIds = Array.isArray(body.product_ids)
    ? body.product_ids.map((id) => String(id).trim()).filter(Boolean)
    : productId
      ? [productId]
      : [];
  const all = body.all === true;

  if (!productIds.length && !all) {
    return json({ ok: false, error: "product_ids_or_all_required" }, 400, cors);
  }

  const out = await unpublishBrandProductsFromEazpire(env, db, brand, { productIds, all, ctx });
  return json({ ok: true, ...out }, 200, cors);
}

export { slugify, upsertEazpireListing, draftEazpireListing };
