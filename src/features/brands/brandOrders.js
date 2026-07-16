/**
 * Read-only orders for brand products dual-published on eazpire (platform Shopify).
 * Not BYO brand-shop orders — those stay in the brand's own Shopify admin.
 */

import { json } from "../../utils/response.js";
import { shopifyAPI } from "../../utils/shopify.js";
import { resolveBrandAuthContext } from "./brandAuthContext.js";
import { BRAND_API_SCOPES } from "./rbac.js";

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 50;
const SHOPIFY_PAGE_SIZE = 100;
const MAX_SHOPIFY_PAGES = 5;

function shopDomain(env) {
  return String(env.SHOPIFY_SHOP || "allyoucanpink.myshopify.com")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

function normalizeProductId(id) {
  const s = String(id || "").trim();
  if (!s) return "";
  const gid = s.match(/gid:\/\/shopify\/Product\/(\d+)/i);
  if (gid) return gid[1];
  return s.replace(/\.0$/, "");
}

/**
 * @returns {Promise<{ ids: Set<string>, byId: Map<string, { brand_product_id: string, title: string|null, eazpire_handle: string|null }> }>}
 */
async function loadBrandEazpireProductIndex(db, brandId) {
  const rows = await db
    .prepare(
      `SELECT id, eazpire_shopify_product_id, title, eazpire_handle
       FROM brand_products
       WHERE brand_id = ?
         AND eazpire_shopify_product_id IS NOT NULL
         AND TRIM(eazpire_shopify_product_id) != ''`
    )
    .bind(brandId)
    .all();

  const ids = new Set();
  /** @type {Map<string, { brand_product_id: string, title: string|null, eazpire_handle: string|null }>} */
  const byId = new Map();
  for (const row of rows?.results || []) {
    const pid = normalizeProductId(row.eazpire_shopify_product_id);
    if (!pid) continue;
    ids.add(pid);
    byId.set(pid, {
      brand_product_id: row.id,
      title: row.title || null,
      eazpire_handle: row.eazpire_handle || null,
    });
  }
  return { ids, byId };
}

function mapShipping(addr) {
  if (!addr || typeof addr !== "object") return null;
  const name =
    addr.name ||
    [addr.first_name, addr.last_name].filter(Boolean).join(" ").trim() ||
    null;
  return {
    name,
    address1: addr.address1 || null,
    address2: addr.address2 || null,
    city: addr.city || null,
    province: addr.province || null,
    zip: addr.zip || null,
    country: addr.country || addr.country_code || null,
    phone: addr.phone || null,
  };
}

function mapCustomer(customer, orderEmail) {
  const email = customer?.email || orderEmail || null;
  if (!customer && !email) return null;
  return {
    first_name: customer?.first_name || null,
    last_name: customer?.last_name || null,
    email,
  };
}

function filterBrandLineItems(lineItems, productIndex) {
  const out = [];
  for (const li of lineItems || []) {
    const pid = normalizeProductId(li.product_id);
    if (!pid || !productIndex.ids.has(pid)) continue;
    const meta = productIndex.byId.get(pid) || {};
    out.push({
      id: String(li.id),
      product_id: pid,
      brand_product_id: meta.brand_product_id || null,
      eazpire_handle: meta.eazpire_handle || null,
      variant_id: li.variant_id != null ? String(li.variant_id) : null,
      title: li.title || meta.title || null,
      variant_title: li.variant_title || null,
      quantity: Number(li.quantity) || 0,
      sku: li.sku || null,
      price: li.price != null ? String(li.price) : null,
      fulfillment_status: li.fulfillment_status || null,
    });
  }
  return out;
}

function brandLineSubtotal(lineItems) {
  let sum = 0;
  for (const li of lineItems) {
    const price = Number(li.price);
    const qty = Number(li.quantity) || 0;
    if (Number.isFinite(price)) sum += price * qty;
  }
  return sum.toFixed(2);
}

function mapOrderPublic(order, brandLineItems, { detail = false } = {}) {
  const base = {
    id: String(order.id),
    name: order.name || `#${order.order_number || order.id}`,
    created_at: order.created_at || null,
    updated_at: order.updated_at || null,
    processed_at: order.processed_at || null,
    financial_status: order.financial_status || null,
    fulfillment_status: order.fulfillment_status || null,
    currency: order.currency || null,
    brand_line_item_count: brandLineItems.length,
    brand_subtotal: brandLineSubtotal(brandLineItems),
  };

  if (!detail) {
    return {
      ...base,
      line_items: brandLineItems.map((li) => ({
        id: li.id,
        product_id: li.product_id,
        title: li.title,
        quantity: li.quantity,
        price: li.price,
      })),
    };
  }

  return {
    ...base,
    customer: mapCustomer(order.customer, order.email),
    shipping_address: mapShipping(order.shipping_address),
    line_items: brandLineItems,
    note: order.note || null,
  };
}

function parseListParams(url) {
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.floor(limitRaw), 1), MAX_LIST_LIMIT)
    : DEFAULT_LIST_LIMIT;

  const sinceId = String(url.searchParams.get("since_id") || "").trim();
  const createdAtMin = String(url.searchParams.get("created_at_min") || "").trim();
  const financialStatus = String(url.searchParams.get("financial_status") || "")
    .trim()
    .toLowerCase();
  const fulfillmentStatus = String(url.searchParams.get("fulfillment_status") || "")
    .trim()
    .toLowerCase();
  const status = String(url.searchParams.get("status") || "any")
    .trim()
    .toLowerCase() || "any";

  return { limit, sinceId, createdAtMin, financialStatus, fulfillmentStatus, status };
}

function buildOrdersQuery(params, { createdAtMax = "" } = {}) {
  const q = new URLSearchParams();
  q.set("status", params.status || "any");
  q.set("limit", String(SHOPIFY_PAGE_SIZE));
  q.set("order", "created_at desc");
  if (params.createdAtMin) q.set("created_at_min", params.createdAtMin);
  if (createdAtMax) q.set("created_at_max", createdAtMax);
  if (params.financialStatus) q.set("financial_status", params.financialStatus);
  if (params.fulfillmentStatus) q.set("fulfillment_status", params.fulfillmentStatus);
  // User-facing since_id only on the first page (Shopify: id > since_id)
  if (params.sinceId && !createdAtMax) q.set("since_id", params.sinceId);
  return q.toString();
}

/**
 * GET list — orders on the eazpire platform shop that include this brand's dual-published products.
 * Suspended brands are denied (customer PII).
 */
export async function handleBrandOrdersList(request, env) {
  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.ORDERS_READ,
    allowSuspended: false,
  });
  if (resolved.error) return resolved.error;
  const { cors, db, brand } = resolved;

  if (!env.SHOPIFY_ACCESS_TOKEN) {
    return json({ ok: false, error: "shopify_access_token_missing" }, 503, cors);
  }

  const url = new URL(request.url);
  const params = parseListParams(url);
  const productIndex = await loadBrandEazpireProductIndex(db, brand.id);

  if (!productIndex.ids.size) {
    return json(
      {
        ok: true,
        orders: [],
        dual_published_product_count: 0,
        has_more: false,
        message:
          "No dual-published products on eazpire yet. Publish products first to see related orders.",
      },
      200,
      cors
    );
  }

  const matched = [];
  const seenIds = new Set();
  let createdAtMax = "";
  let hasMoreShopify = false;
  let scannedPages = 0;

  try {
    for (let page = 0; page < MAX_SHOPIFY_PAGES && matched.length < params.limit; page++) {
      const qs = buildOrdersQuery(params, { createdAtMax });
      const data = await shopifyAPI(env, shopDomain(env), `orders.json?${qs}`, { method: "GET" });
      const batch = data?.orders || [];
      scannedPages += 1;

      if (!batch.length) {
        hasMoreShopify = false;
        break;
      }

      let newInBatch = 0;
      for (const order of batch) {
        const oid = String(order.id);
        if (seenIds.has(oid)) continue;
        seenIds.add(oid);
        newInBatch += 1;

        const brandItems = filterBrandLineItems(order.line_items, productIndex);
        if (!brandItems.length) continue;
        matched.push(mapOrderPublic(order, brandItems, { detail: false }));
        if (matched.length >= params.limit) break;
      }

      const oldest = batch[batch.length - 1];
      const nextMax = oldest?.created_at || "";
      // Stop if no progress (same created_at_max) or short page
      if (!nextMax || nextMax === createdAtMax || newInBatch === 0) {
        hasMoreShopify = false;
        break;
      }
      createdAtMax = nextMax;
      hasMoreShopify = batch.length >= SHOPIFY_PAGE_SIZE;
      if (!hasMoreShopify) break;
    }
  } catch (err) {
    console.error("[brand-orders-list]", err?.message || err);
    return json(
      {
        ok: false,
        error: "shopify_orders_fetch_failed",
        message: String(err?.message || err),
      },
      502,
      cors
    );
  }

  return json(
    {
      ok: true,
      orders: matched,
      dual_published_product_count: productIndex.ids.size,
      has_more: hasMoreShopify && matched.length >= params.limit,
      scanned_pages: scannedPages,
    },
    200,
    cors
  );
}

/**
 * GET detail — only if the order includes at least one line item for this brand.
 */
export async function handleBrandOrderGet(request, env) {
  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.ORDERS_READ,
    allowSuspended: false,
  });
  if (resolved.error) return resolved.error;
  const { cors, db, brand } = resolved;

  if (!env.SHOPIFY_ACCESS_TOKEN) {
    return json({ ok: false, error: "shopify_access_token_missing" }, 503, cors);
  }

  const url = new URL(request.url);
  const orderId = String(url.searchParams.get("order_id") || url.searchParams.get("id") || "").trim();
  if (!orderId) return json({ ok: false, error: "order_id_required" }, 400, cors);

  const productIndex = await loadBrandEazpireProductIndex(db, brand.id);
  if (!productIndex.ids.size) {
    return json({ ok: false, error: "not_found" }, 404, cors);
  }

  try {
    const data = await shopifyAPI(env, shopDomain(env), `orders/${encodeURIComponent(orderId)}.json`, {
      method: "GET",
    });
    const order = data?.order;
    if (!order) return json({ ok: false, error: "not_found" }, 404, cors);

    const brandItems = filterBrandLineItems(order.line_items, productIndex);
    if (!brandItems.length) {
      return json({ ok: false, error: "not_found" }, 404, cors);
    }

    return json({ ok: true, order: mapOrderPublic(order, brandItems, { detail: true }) }, 200, cors);
  } catch (err) {
    if (err?.status === 404) {
      return json({ ok: false, error: "not_found" }, 404, cors);
    }
    console.error("[brand-order-get]", err?.message || err);
    return json(
      {
        ok: false,
        error: "shopify_orders_fetch_failed",
        message: String(err?.message || err),
      },
      502,
      cors
    );
  }
}
