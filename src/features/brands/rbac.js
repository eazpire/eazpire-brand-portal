/**
 * Brand session JWT + cookie helpers
 */

import { SignJWT, jwtVerify } from "jose";

const BRAND_COOKIE = "brand_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 7;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

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
