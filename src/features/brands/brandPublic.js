/**
 * Public (no auth) brand APIs for shop index / profile pages
 */

import { json, getCorsHeaders } from "../../utils/response.js";
import { getBrandDb, brandDbUnavailable, ensureBrandSchema } from "./db.js";

export async function handleBrandPublicList(request, env) {
  const cors = getCorsHeaders(request);
  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 48) || 48, 1), 100);

  const rows = await db
    .prepare(
      `SELECT b.id, b.name, b.handle, b.tagline, b.about, b.logo_r2_key, b.created_at,
              (SELECT COUNT(*) FROM brand_products p WHERE p.brand_id = b.id) AS product_count
       FROM brands b
       WHERE b.status = 'active'
       ORDER BY b.created_at DESC
       LIMIT ?`
    )
    .bind(limit)
    .all();

  const publicBase = String(env.PUBLIC_FILE_BASE_URL || "").replace(/\/$/, "");
  const brands = (rows?.results || []).map((b) => ({
    id: b.id,
    name: b.name,
    handle: b.handle,
    tagline: b.tagline,
    about: b.about,
    logo_url: b.logo_r2_key && publicBase ? `${publicBase}/files/${b.logo_r2_key}` : null,
    product_count: Number(b.product_count || 0),
    created_at: b.created_at,
    profile_url: `/brands/${b.handle}`,
  }));

  return json({ ok: true, brands }, 200, cors);
}

export async function handleBrandPublicGet(request, env) {
  const cors = getCorsHeaders(request);
  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const url = new URL(request.url);
  const handle = String(url.searchParams.get("handle") || "")
    .trim()
    .toLowerCase();
  if (!handle) return json({ ok: false, error: "handle_required" }, 400, cors);

  const brand = await db
    .prepare(
      `SELECT id, name, handle, tagline, about, logo_r2_key, created_at, status
       FROM brands WHERE handle = ? AND status = 'active' LIMIT 1`
    )
    .bind(handle)
    .first();

  if (!brand) return json({ ok: false, error: "not_found" }, 404, cors);

  const products = await db
    .prepare(
      `SELECT id, printify_product_id, shopify_product_id, title, status, thumbnail_url, last_synced_at
       FROM brand_products WHERE brand_id = ? ORDER BY updated_at DESC LIMIT 100`
    )
    .bind(brand.id)
    .all();

  const publicBase = String(env.PUBLIC_FILE_BASE_URL || "").replace(/\/$/, "");

  return json(
    {
      ok: true,
      brand: {
        id: brand.id,
        name: brand.name,
        handle: brand.handle,
        tagline: brand.tagline,
        about: brand.about,
        logo_url: brand.logo_r2_key && publicBase ? `${publicBase}/files/${brand.logo_r2_key}` : null,
        profile_url: `/brands/${brand.handle}`,
        created_at: brand.created_at,
      },
      products: products?.results || [],
    },
    200,
    cors
  );
}
