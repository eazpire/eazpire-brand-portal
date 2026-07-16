/**
 * Admin Brands ops — list/detail/suspend/activate/force-unpublish.
 * Runs on partner-portals worker with BRAND_DB binding (no secrets from connections).
 */

import { json, getCorsHeaders } from "../../utils/response.js";
import { getBrandDb, brandDbUnavailable, ensureBrandSchema } from "./db.js";
import { unpublishBrandProductsFromEazpire } from "./brandDualPublish.js";

function publicBase(env) {
  return String(env.PUBLIC_FILE_BASE_URL || "").replace(/\/$/, "");
}

function connectionHealthRow(row) {
  if (!row) {
    return { connected: false, status: "disconnected", last_ok_at: null, connected_at: null, meta: null };
  }
  let meta = null;
  try {
    meta = row.meta_json ? JSON.parse(row.meta_json) : null;
  } catch {
    meta = null;
  }
  // Never expose secret_ciphertext or tokens — only non-secret meta keys
  const safeMeta = meta
    ? {
        shop_id: meta.shop_id || meta.printify_shop_id || null,
        shop_domain: meta.shop_domain || meta.shop || null,
        shop_name: meta.shop_name || null,
      }
    : null;
  return {
    connected: String(row.status || "").toLowerCase() === "connected",
    status: row.status || "disconnected",
    last_ok_at: row.last_ok_at || null,
    connected_at: row.connected_at || null,
    meta: safeMeta,
  };
}

async function loadConnectionMap(db, brandId) {
  const rows = await db
    .prepare(
      `SELECT type, status, meta_json, last_ok_at, connected_at
       FROM brand_connections WHERE brand_id = ?`
    )
    .bind(brandId)
    .all();
  const map = { printify: null, shopify: null };
  for (const row of rows?.results || []) {
    const t = String(row.type || "").toLowerCase();
    if (t === "printify" || t === "shopify") map[t] = row;
  }
  return {
    printify: connectionHealthRow(map.printify),
    shopify: connectionHealthRow(map.shopify),
  };
}

/** GET ?op=admin-brand-list */
export async function handleAdminBrandList(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const url = new URL(request.url);
  const statusFilter = String(url.searchParams.get("status") || "").trim().toLowerCase();
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 100) || 100, 1), 200);

  let sql = `
    SELECT b.id, b.name, b.handle, b.status, b.tagline, b.logo_r2_key, b.created_at, b.updated_at,
           b.suspend_reason, b.suspended_at,
           u.email AS owner_email, u.display_name AS owner_display_name,
           (SELECT COUNT(*) FROM brand_products p WHERE p.brand_id = b.id) AS product_count,
           (SELECT COUNT(*) FROM brand_products p
             WHERE p.brand_id = b.id AND p.dual_publish_status = 'published') AS dual_published_count,
           (SELECT COUNT(*) FROM brand_products p
             WHERE p.brand_id = b.id AND p.dual_publish_status = 'error') AS dual_error_count,
           (SELECT c.status FROM brand_connections c
             WHERE c.brand_id = b.id AND c.type = 'printify' LIMIT 1) AS printify_status,
           (SELECT c.status FROM brand_connections c
             WHERE c.brand_id = b.id AND c.type = 'shopify' LIMIT 1) AS shopify_status
    FROM brands b
    LEFT JOIN brand_users u ON u.id = b.owner_user_id
    WHERE b.status != 'deleted'`;
  const binds = [];

  if (statusFilter === "active" || statusFilter === "suspended") {
    sql += ` AND b.status = ?`;
    binds.push(statusFilter);
  }
  if (q) {
    sql += ` AND (lower(b.name) LIKE ? OR lower(b.handle) LIKE ? OR lower(COALESCE(u.email,'')) LIKE ?)`;
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  sql += ` ORDER BY b.updated_at DESC LIMIT ?`;
  binds.push(limit);

  const rows = await db.prepare(sql).bind(...binds).all();
  const base = publicBase(env);
  const brands = (rows?.results || []).map((b) => ({
    id: b.id,
    name: b.name,
    handle: b.handle,
    status: b.status,
    tagline: b.tagline,
    logo_url: b.logo_r2_key && base ? `${base}/files/${b.logo_r2_key}` : null,
    owner_email: b.owner_email || null,
    owner_display_name: b.owner_display_name || null,
    product_count: Number(b.product_count || 0),
    dual_published_count: Number(b.dual_published_count || 0),
    dual_error_count: Number(b.dual_error_count || 0),
    printify_connected: String(b.printify_status || "").toLowerCase() === "connected",
    shopify_connected: String(b.shopify_status || "").toLowerCase() === "connected",
    suspend_reason: b.suspend_reason || null,
    suspended_at: b.suspended_at || null,
    created_at: b.created_at,
    updated_at: b.updated_at,
  }));

  return json({ ok: true, brands }, 200, cors);
}

/** GET ?op=admin-brand-get&brand_id=… */
export async function handleAdminBrandGet(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const url = new URL(request.url);
  const brandId = String(url.searchParams.get("brand_id") || "").trim();
  const handle = String(url.searchParams.get("handle") || "")
    .trim()
    .toLowerCase();
  if (!brandId && !handle) {
    return json({ ok: false, error: "brand_id_or_handle_required" }, 400, cors);
  }

  const brand = brandId
    ? await db
        .prepare(
          `SELECT b.*, u.email AS owner_email, u.display_name AS owner_display_name,
                  u.shopify_customer_id AS owner_shopify_customer_id
           FROM brands b
           LEFT JOIN brand_users u ON u.id = b.owner_user_id
           WHERE b.id = ? LIMIT 1`
        )
        .bind(brandId)
        .first()
    : await db
        .prepare(
          `SELECT b.*, u.email AS owner_email, u.display_name AS owner_display_name,
                  u.shopify_customer_id AS owner_shopify_customer_id
           FROM brands b
           LEFT JOIN brand_users u ON u.id = b.owner_user_id
           WHERE b.handle = ? LIMIT 1`
        )
        .bind(handle)
        .first();

  if (!brand || brand.status === "deleted") {
    return json({ ok: false, error: "not_found" }, 404, cors);
  }

  const connections = await loadConnectionMap(db, brand.id);
  const products = await db
    .prepare(
      `SELECT id, printify_product_id, shopify_product_id, title, status, thumbnail_url,
              eazpire_shopify_product_id, eazpire_handle, dual_publish_status, dual_publish_error,
              dual_published_at, last_synced_at, updated_at
       FROM brand_products WHERE brand_id = ? ORDER BY updated_at DESC LIMIT 500`
    )
    .bind(brand.id)
    .all();

  const members = await db
    .prepare(
      `SELECT id, email, role, publish_mode, status, invited_by, accepted_at, created_at, updated_at
       FROM brand_members WHERE brand_id = ? ORDER BY created_at ASC LIMIT 200`
    )
    .bind(brand.id)
    .all();

  let api_keys_count = 0;
  try {
    const { countActiveBrandApiKeys } = await import("./brandApiKeys.js");
    api_keys_count = await countActiveBrandApiKeys(db, brand.id);
  } catch {
    api_keys_count = 0;
  }

  const base = publicBase(env);
  return json(
    {
      ok: true,
      brand: {
        id: brand.id,
        name: brand.name,
        handle: brand.handle,
        tagline: brand.tagline,
        about: brand.about,
        status: brand.status,
        logo_url: brand.logo_r2_key && base ? `${base}/files/${brand.logo_r2_key}` : null,
        owner_email: brand.owner_email || null,
        owner_display_name: brand.owner_display_name || null,
        owner_eazpire_linked: Boolean(brand.owner_shopify_customer_id),
        suspend_reason: brand.suspend_reason || null,
        suspended_at: brand.suspended_at || null,
        suspended_by: brand.suspended_by || null,
        created_at: brand.created_at,
        updated_at: brand.updated_at,
        api_keys_count,
      },
      connections,
      products: products?.results || [],
      members: members?.results || [],
    },
    200,
    cors
  );
}

/** POST ?op=admin-brand-suspend body: { brand_id, reason? } */
export async function handleAdminBrandSuspend(request, env, admin) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const body = await request.json().catch(() => ({}));
  const brandId = String(body.brand_id || "").trim();
  const reason = String(body.reason || "").trim().slice(0, 500) || null;
  if (!brandId) return json({ ok: false, error: "brand_id_required" }, 400, cors);

  const brand = await db.prepare(`SELECT id, status FROM brands WHERE id = ?`).bind(brandId).first();
  if (!brand || brand.status === "deleted") {
    return json({ ok: false, error: "not_found" }, 404, cors);
  }
  if (brand.status === "suspended") {
    return json({ ok: true, already: true, status: "suspended" }, 200, cors);
  }

  const now = Date.now();
  const actor = String(admin?.email || admin?.owner_id || "admin").slice(0, 120);
  await db
    .prepare(
      `UPDATE brands
       SET status = 'suspended', suspend_reason = ?, suspended_at = ?, suspended_by = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(reason, now, actor, now, brandId)
    .run();

  return json({ ok: true, status: "suspended", brand_id: brandId }, 200, cors);
}

/** POST ?op=admin-brand-activate body: { brand_id } */
export async function handleAdminBrandActivate(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const body = await request.json().catch(() => ({}));
  const brandId = String(body.brand_id || "").trim();
  if (!brandId) return json({ ok: false, error: "brand_id_required" }, 400, cors);

  const brand = await db.prepare(`SELECT id, status FROM brands WHERE id = ?`).bind(brandId).first();
  if (!brand || brand.status === "deleted") {
    return json({ ok: false, error: "not_found" }, 404, cors);
  }

  const now = Date.now();
  await db
    .prepare(
      `UPDATE brands
       SET status = 'active', suspend_reason = NULL, suspended_at = NULL, suspended_by = NULL, updated_at = ?
       WHERE id = ?`
    )
    .bind(now, brandId)
    .run();

  return json({ ok: true, status: "active", brand_id: brandId }, 200, cors);
}

/** POST ?op=admin-brand-force-unpublish body: { brand_id, product_ids?, all? } */
export async function handleAdminBrandForceUnpublish(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const body = await request.json().catch(() => ({}));
  const brandId = String(body.brand_id || "").trim();
  if (!brandId) return json({ ok: false, error: "brand_id_required" }, 400, cors);

  const brand = await db
    .prepare(`SELECT id, name, handle, tagline, status FROM brands WHERE id = ?`)
    .bind(brandId)
    .first();
  if (!brand || brand.status === "deleted") {
    return json({ ok: false, error: "not_found" }, 404, cors);
  }

  const productIds = Array.isArray(body.product_ids)
    ? body.product_ids.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const all = body.all === true || !productIds.length;

  const out = await unpublishBrandProductsFromEazpire(env, db, brand, {
    productIds: all ? [] : productIds,
    all,
  });

  return json({ ok: true, brand_id: brandId, ...out }, 200, cors);
}
