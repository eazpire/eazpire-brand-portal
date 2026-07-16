/**
 * Brand profile CRUD + overview stats
 */

import { json, getCorsHeaders } from "../../utils/response.js";
import { getBrandDb, brandDbUnavailable, newId, ensureBrandSchema } from "./db.js";
import { requireBrandSession, BRAND_API_SCOPES } from "./rbac.js";
import { resolveBrandAuthContext } from "./brandAuthContext.js";

const HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizeHandle(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function getOwnedBrand(db, userId) {
  return db
    .prepare(
      `SELECT * FROM brands WHERE owner_user_id = ? AND status != 'deleted' ORDER BY created_at ASC LIMIT 1`
    )
    .bind(userId)
    .first();
}

export async function handleBrandCreate(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);
  const session = await requireBrandSession(request, env);
  if (!session) return json({ ok: false, error: "unauthorized" }, 401, cors);

  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const existing = await getOwnedBrand(db, session.uid);
  if (existing) {
    return json({ ok: false, error: "brand_already_exists", brand: existing }, 409, cors);
  }

  const body = await request.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  const handle = normalizeHandle(body.handle || name);
  if (!name) return json({ ok: false, error: "name_required" }, 400, cors);
  if (!handle || !HANDLE_RE.test(handle) || handle.length < 2 || handle.length > 48) {
    return json({ ok: false, error: "invalid_handle" }, 400, cors);
  }

  const clash = await db.prepare(`SELECT id FROM brands WHERE handle = ?`).bind(handle).first();
  if (clash) return json({ ok: false, error: "handle_taken" }, 409, cors);

  const now = Date.now();
  const id = newId("brand");
  await db
    .prepare(
      `INSERT INTO brands (id, owner_user_id, name, handle, tagline, about, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    )
    .bind(
      id,
      session.uid,
      name,
      handle,
      String(body.tagline || "").trim() || null,
      String(body.about || "").trim() || null,
      now,
      now
    )
    .run();

  // Owner as member
  await db
    .prepare(
      `INSERT INTO brand_members (id, brand_id, email, user_id, role, publish_mode, status, invited_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'owner', 'auto_publish', 'active', ?, ?, ?)`
    )
    .bind(newId("bm"), id, session.email, session.uid, session.uid, now, now)
    .run();

  const brand = await db.prepare(`SELECT * FROM brands WHERE id = ?`).bind(id).first();
  return json({ ok: true, brand }, 200, cors);
}

export async function handleBrandUpdate(request, env) {
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
  const name = body.name != null ? String(body.name).trim() : brand.name;
  let handle = brand.handle;
  if (body.handle != null) {
    handle = normalizeHandle(body.handle);
    if (!HANDLE_RE.test(handle) || handle.length < 2 || handle.length > 48) {
      return json({ ok: false, error: "invalid_handle" }, 400, cors);
    }
    if (handle !== brand.handle) {
      const clash = await db.prepare(`SELECT id FROM brands WHERE handle = ? AND id != ?`).bind(handle, brand.id).first();
      if (clash) return json({ ok: false, error: "handle_taken" }, 409, cors);
    }
  }
  if (!name) return json({ ok: false, error: "name_required" }, 400, cors);

  const tagline = body.tagline != null ? String(body.tagline).trim() || null : brand.tagline;
  const about = body.about != null ? String(body.about).trim() || null : brand.about;
  const now = Date.now();

  await db
    .prepare(
      `UPDATE brands SET name = ?, handle = ?, tagline = ?, about = ?, updated_at = ? WHERE id = ?`
    )
    .bind(name, handle, tagline, about, now, brand.id)
    .run();

  const updated = await db.prepare(`SELECT * FROM brands WHERE id = ?`).bind(brand.id).first();
  return json({ ok: true, brand: updated }, 200, cors);
}

export async function handleBrandLogoUpload(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);
  const session = await requireBrandSession(request, env);
  if (!session) return json({ ok: false, error: "unauthorized" }, 401, cors);

  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const brand = await getOwnedBrand(db, session.uid);
  if (!brand) return json({ ok: false, error: "brand_required" }, 400, cors);
  if (!env.R2?.put) return json({ ok: false, error: "r2_unavailable" }, 503, cors);

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    return json({ ok: false, error: "file_required" }, 400, cors);
  }

  const buf = await file.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > 2 * 1024 * 1024) {
    return json({ ok: false, error: "invalid_file_size" }, 400, cors);
  }

  const type = String(file.type || "image/png");
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
  const key = `brand-logos/${brand.id}/${Date.now()}.${ext}`;
  await env.R2.put(key, buf, { httpMetadata: { contentType: type } });

  await db
    .prepare(`UPDATE brands SET logo_r2_key = ?, updated_at = ? WHERE id = ?`)
    .bind(key, Date.now(), brand.id)
    .run();

  const publicBase = String(env.PUBLIC_FILE_BASE_URL || "").replace(/\/$/, "");
  const logo_url = publicBase ? `${publicBase}/files/${key}` : key;

  return json({ ok: true, logo_r2_key: key, logo_url }, 200, cors);
}

export async function handleBrandOverview(request, env) {
  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.OVERVIEW_READ,
    allowMissingBrand: true,
    allowSuspended: true,
  });
  if (resolved.error) return resolved.error;
  const { cors, db, brand, auth } = resolved;

  if (!brand) {
    // Portal session without a brand yet — API keys are always brand-scoped
    if (auth.type === "api_key") {
      return json({ ok: false, error: "brand_required" }, 400, cors);
    }
    return json({ ok: true, needs_onboarding: true, stats: null }, 200, cors);
  }

  const connections = await db
    .prepare(`SELECT type, status, last_ok_at, connected_at, meta_json FROM brand_connections WHERE brand_id = ?`)
    .bind(brand.id)
    .all();

  const productCount = await db
    .prepare(`SELECT COUNT(*) AS c FROM brand_products WHERE brand_id = ?`)
    .bind(brand.id)
    .first();

  const memberCount = await db
    .prepare(`SELECT COUNT(*) AS c FROM brand_members WHERE brand_id = ? AND status IN ('invited','active') AND role != 'owner'`)
    .bind(brand.id)
    .first();

  const byType = {};
  for (const row of connections?.results || []) {
    byType[row.type] = {
      status: row.status,
      last_ok_at: row.last_ok_at,
      connected_at: row.connected_at,
    };
  }

  return json(
    {
      ok: true,
      brand: {
        id: brand.id,
        name: brand.name,
        handle: brand.handle,
        tagline: brand.tagline,
        status: brand.status,
        about: brand.about || null,
      },
      stats: {
        products: Number(productCount?.c || 0),
        members: Number(memberCount?.c || 0),
        pending_reviews: 0,
        connections: byType,
      },
      auth_type: auth.type,
    },
    200,
    cors
  );
}

export { getOwnedBrand, normalizeHandle, HANDLE_RE };
