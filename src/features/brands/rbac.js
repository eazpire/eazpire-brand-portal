/**
 * Brand session JWT + cookie helpers + Brand API key auth
 */

import { SignJWT, jwtVerify } from "jose";
import { getBrandDb, ensureBrandSchema } from "./db.js";

const BRAND_COOKIE = "brand_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 7;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

/** Raw keys look like eaz_brand_<random> — never stored plaintext */
export const BRAND_API_KEY_PREFIX = "eaz_brand_";

export const BRAND_API_SCOPES = {
  OVERVIEW_READ: "overview:read",
  BRAND_READ: "brand:read",
  BRAND_WRITE: "brand:write",
  CONNECTIONS_READ: "connections:read",
  PRODUCTS_READ: "products:read",
  PRODUCTS_WRITE: "products:write",
  PRODUCTS_SYNC: "products:sync",
  PRODUCTS_PUBLISH: "products:publish",
  TEAM_READ: "team:read",
  TEAM_INVITE: "team:invite",
  TEAM_WRITE: "team:write",
};

/** Default scopes for newly created keys (everything except `*`). */
export const DEFAULT_BRAND_API_SCOPES = Object.values(BRAND_API_SCOPES);

/** Allowed scope strings when creating a key (defaults + wildcard). */
export const ALLOWED_BRAND_API_SCOPES = DEFAULT_BRAND_API_SCOPES.concat(["*"]);

function getJwtSecret(env) {
  const s = String(env.BRAND_JWT_SECRET || env.JWT_APP_SECRET || "").trim();
  if (!s) throw new Error("brand_jwt_secret_missing");
  return new TextEncoder().encode(s);
}

export function brandCookieName() {
  return BRAND_COOKIE;
}

export function magicLinkExpiry() {
  return Date.now() + MAGIC_LINK_TTL_MS;
}

export async function hashToken(raw) {
  const data = new TextEncoder().encode(String(raw || ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signBrandSession(env, payload) {
  const secret = getJwtSecret(env);
  return new SignJWT({ ...payload, typ: "brand" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SEC}s`)
    .sign(secret);
}

export async function verifyBrandSession(token, env) {
  if (!token) return null;
  try {
    const secret = getJwtSecret(env);
    const { payload } = await jwtVerify(token, secret);
    if (payload?.typ !== "brand") return null;
    return payload;
  } catch {
    return null;
  }
}

export function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";").map((p) => p.trim())) {
    if (part.startsWith(`${name}=`)) {
      return decodeURIComponent(part.slice(name.length + 1));
    }
  }
  return null;
}

export function sessionCookieHeader(name, token, maxAgeSec = SESSION_TTL_SEC) {
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookieHeader(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function requireBrandSession(request, env) {
  const token = readCookie(request, brandCookieName());
  const payload = await verifyBrandSession(token, env);
  if (!payload?.uid) return null;
  return payload;
}

export function extractBrandApiKey(request) {
  const headerKey =
    request.headers.get("X-Eazpire-Brand-Key") || request.headers.get("x-eazpire-brand-key");
  if (headerKey) return String(headerKey).trim();
  const auth = request.headers.get("Authorization") || "";
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return null;
}

export function parseBrandApiScopes(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((s) => String(s).trim()).filter(Boolean);
    } catch {
      /* ignore */
    }
  }
  return [];
}

export function authHasScope(auth, scope) {
  if (!auth) return false;
  if (auth.type === "session") return true;
  const scopes = auth.scopes || [];
  return scopes.includes("*") || scopes.includes(scope);
}

/**
 * Accept cookie session OR Brand API key (Bearer eaz_brand_… / X-Eazpire-Brand-Key).
 * Session: portal UI. API key: machine access scoped to brand_id.
 */
export async function requireBrandAuth(request, env) {
  const rawKey = extractBrandApiKey(request);
  if (rawKey) {
    if (!rawKey.startsWith(BRAND_API_KEY_PREFIX)) return null;
    const db = getBrandDb(env);
    if (!db) return null;
    await ensureBrandSchema(env);
    const keyHash = await hashToken(rawKey);
    const row = await db
      .prepare(
        `SELECT id, brand_id, name, scopes, revoked_at
         FROM brand_api_keys WHERE key_hash = ? LIMIT 1`
      )
      .bind(keyHash)
      .first();
    if (!row || row.revoked_at) return null;

    const brand = await db
      .prepare(`SELECT id, owner_user_id, status FROM brands WHERE id = ? AND status != 'deleted' LIMIT 1`)
      .bind(row.brand_id)
      .first();
    if (!brand) return null;

    try {
      await db
        .prepare(`UPDATE brand_api_keys SET last_used_at = ? WHERE id = ?`)
        .bind(Date.now(), row.id)
        .run();
    } catch {
      /* non-fatal */
    }

    return {
      type: "api_key",
      uid: brand.owner_user_id,
      email: null,
      brandId: brand.id,
      scopes: parseBrandApiScopes(row.scopes),
      apiKeyId: row.id,
      apiKeyName: row.name,
    };
  }

  const session = await requireBrandSession(request, env);
  if (!session?.uid) return null;
  return {
    type: "session",
    uid: session.uid,
    email: session.email || null,
    brandId: null,
    scopes: ["*"],
  };
}
