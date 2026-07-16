/**
 * Brand API key CRUD (portal Settings — session only).
 * Keys authenticate machine clients to Brand API ops; plaintext shown once on create.
 */

import { json, getCorsHeaders } from "../../utils/response.js";
import { getBrandDb, brandDbUnavailable, newId, ensureBrandSchema } from "./db.js";
import { requireBrandSession, hashToken, DEFAULT_BRAND_API_SCOPES, BRAND_API_KEY_PREFIX } from "./rbac.js";
import { getOwnedBrand } from "./brandProfile.js";

function randomKeySecret(len = 32) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function normalizeScopes(input) {
  if (Array.isArray(input) && input.length) {
    const allowed = new Set(DEFAULT_BRAND_API_SCOPES.concat(["*"]));
    const scopes = input.map((s) => String(s).trim()).filter((s) => allowed.has(s));
    return scopes.length ? scopes : [...DEFAULT_BRAND_API_SCOPES];
  }
  return [...DEFAULT_BRAND_API_SCOPES];
}

async function requireOwnerSessionBrand(request, env) {
  const cors = getCorsHeaders(request);
  const session = await requireBrandSession(request, env);
  if (!session) return { error: json({ ok: false, error: "unauthorized" }, 401, cors) };

  const db = getBrandDb(env);
  if (!db) return { error: json(brandDbUnavailable(), 503, cors) };
  await ensureBrandSchema(env);

  const brand = await getOwnedBrand(db, session.uid);
  if (!brand) return { error: json({ ok: false, error: "brand_required" }, 400, cors) };
  if (brand.status === "suspended") {
    return { error: json({ ok: false, error: "brand_suspended" }, 403, cors) };
  }
  return { cors, db, session, brand };
}

/** GET ?op=brand-api-keys | brand-api-keys-list */
export async function handleBrandApiKeysList(request, env) {
  const resolved = await requireOwnerSessionBrand(request, env);
  if (resolved.error) return resolved.error;
  const { cors, db, brand } = resolved;

  const rows = await db
    .prepare(
      `SELECT id, name, key_prefix, scopes, created_at, revoked_at, last_used_at
       FROM brand_api_keys WHERE brand_id = ? ORDER BY created_at DESC`
    )
    .bind(brand.id)
    .all();

  const keys = (rows?.results || []).map((row) => {
    let scopes = [];
    try {
      scopes = JSON.parse(row.scopes || "[]");
    } catch {
      scopes = [];
    }
    return {
      id: row.id,
      name: row.name,
      key_prefix: row.key_prefix,
      scopes,
      created_at: row.created_at,
      revoked_at: row.revoked_at,
      last_used_at: row.last_used_at,
      active: !row.revoked_at,
    };
  });

  return json({ ok: true, keys }, 200, cors);
}

/** POST ?op=brand-api-keys-create  body: { name, scopes? } — returns raw api_key once */
export async function handleBrandApiKeysCreate(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

  const resolved = await requireOwnerSessionBrand(request, env);
  if (resolved.error) return resolved.error;
  const { db, brand } = resolved;

  const body = await request.json().catch(() => ({}));
  const name = String(body.name || "").trim().slice(0, 80);
  if (!name) return json({ ok: false, error: "name_required" }, 400, cors);

  const scopes = normalizeScopes(body.scopes);
  const raw = `${BRAND_API_KEY_PREFIX}${randomKeySecret(36)}`;
  const keyHash = await hashToken(raw);
  const keyPrefix = raw.slice(0, 16);
  const id = newId("bak");
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO brand_api_keys (id, brand_id, name, key_prefix, key_hash, scopes, created_at, revoked_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
    )
    .bind(id, brand.id, name, keyPrefix, keyHash, JSON.stringify(scopes), now)
    .run();

  return json(
    {
      ok: true,
      key: {
        id,
        name,
        key_prefix: keyPrefix,
        scopes,
        created_at: now,
        active: true,
      },
      /** Shown once — store securely; never returned again */
      api_key: raw,
    },
    200,
    cors
  );
}

/** POST ?op=brand-api-keys-revoke  body: { key_id } */
export async function handleBrandApiKeysRevoke(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

  const resolved = await requireOwnerSessionBrand(request, env);
  if (resolved.error) return resolved.error;
  const { db, brand } = resolved;

  const body = await request.json().catch(() => ({}));
  const keyId = String(body.key_id || body.id || "").trim();
  if (!keyId) return json({ ok: false, error: "key_id_required" }, 400, cors);

  const row = await db
    .prepare(`SELECT id, revoked_at FROM brand_api_keys WHERE id = ? AND brand_id = ? LIMIT 1`)
    .bind(keyId, brand.id)
    .first();
  if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
  if (row.revoked_at) return json({ ok: true, already: true }, 200, cors);

  await db
    .prepare(`UPDATE brand_api_keys SET revoked_at = ? WHERE id = ?`)
    .bind(Date.now(), keyId)
    .run();

  return json({ ok: true, revoked: true }, 200, cors);
}

export async function countActiveBrandApiKeys(db, brandId) {
  if (!db || !brandId) return 0;
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM brand_api_keys WHERE brand_id = ? AND revoked_at IS NULL`)
    .bind(brandId)
    .first();
  return Number(row?.c || 0);
}
