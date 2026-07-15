/**
 * Mirror brand catalog products onto the eazpire Shopify store (platform credentials).
 * Tags: brand, eaz-brand:{handle} — metafield custom.brand_handle when accepted.
 */

import { json, getCorsHeaders } from "../../utils/response.js";
import { getBrandDb, brandDbUnavailable, ensureBrandSchema } from "./db.js";
import { requireBrandSession } from "./rbac.js";
import { getOwnedBrand } from "./brandProfile.js";
import { shopifyAPI } from "../../utils/shopify.js";

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

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function handleBrandDualPublish(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);
  const session = await requireBrandSession(request, env);
  if (!session) return json({ ok: false, error: "unauthorized" }, 401, cors);

  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const brand = await getOwnedBrand(db, session.uid);
  if (!brand) return json({ ok: false, error: "brand_required" }, 400, cors);

  const body = await request.json().catch(() => ({}));
  const productId = String(body.product_id || "").trim();
  const limit = Math.min(Math.max(Number(body.limit || 20) || 20, 1), 50);

  let rows;
  if (productId) {
    rows = await db
      .prepare(`SELECT * FROM brand_products WHERE brand_id = ? AND id = ?`)
      .bind(brand.id, productId)
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
    return json({ ok: true, published: 0, message: "nothing_to_publish" }, 200, cors);
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

  const published = results.filter((r) => r.ok).length;
  return json({ ok: true, published, results }, 200, cors);
}

export { slugify };
