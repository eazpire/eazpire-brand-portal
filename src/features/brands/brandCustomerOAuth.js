/**
 * Shopify Customer Account OAuth (PKCE) to link shopify_customer_id on brand_users.
 */

import { json, getCorsHeaders } from "../../utils/response.js";
import { getBrandDb, brandDbUnavailable, ensureBrandSchema } from "./db.js";
import { requireBrandSession, brandCookieName, readCookie, verifyBrandSession } from "./rbac.js";

const PKCE_COOKIE = "brand_customer_oauth_pkce";
const PKCE_MAX_AGE = 600;
const SCOPE = "openid email customer-account-api:full";

function shopId(env) {
  return String(env.SHOPIFY_SHOP_ID || "73952035098").trim();
}

function clientId(env) {
  return String(env.SHOPIFY_CUSTOMER_CLIENT_ID || "82087087-a2cc-40a8-91ff-70e29ce275dd").trim();
}

function brandPortalUrl(env) {
  return String(env.BRAND_PORTAL_URL || "https://brand.eazpire.com").replace(/\/$/, "");
}

function redirectUri(env) {
  return `${brandPortalUrl(env)}/auth/customer/callback`;
}

function creatorEngineBase(env) {
  return String(env.CREATOR_ENGINE_URL || "https://creator-engine.eazpire.workers.dev").replace(/\/$/, "");
}

function portalSettings(env) {
  return `${brandPortalUrl(env)}/settings`;
}

function oidcEndpoints(env) {
  const sid = shopId(env);
  return {
    authorizationEndpoint: "https://account.eazpire.com/authentication/oauth/authorize",
    tokenEndpoint: `https://shopify.com/authentication/${sid}/oauth/token`,
  };
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function generatePkce() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));
  const stateBytes = crypto.getRandomValues(new Uint8Array(16));
  const state = base64UrlEncode(stateBytes);
  return { codeVerifier, codeChallenge, state };
}

function pkceCookieHeader(payload, env) {
  const secure = env.BRAND_FORCE_INSECURE_COOKIE !== "1";
  const parts = [
    `${PKCE_COOKIE}=${encodeURIComponent(JSON.stringify(payload))}`,
    "Path=/auth",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${PKCE_MAX_AGE}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearPkceCookieHeader(env) {
  const secure = env.BRAND_FORCE_INSECURE_COOKIE !== "1";
  const parts = [`${PKCE_COOKIE}=`, "Path=/auth", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function readPkceCookie(request) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${PKCE_COOKIE}=([^;]+)`));
  if (!match) return null;
  try {
    return JSON.parse(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

function redirectWithCookies(location, cookies) {
  const headers = new Headers();
  headers.set("Location", location);
  const list = Array.isArray(cookies) ? cookies : [cookies];
  for (const c of list) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

function redirectSettingsError(env, code) {
  return redirectWithCookies(
    `${portalSettings(env)}?customer_link_error=${encodeURIComponent(code)}`,
    clearPkceCookieHeader(env)
  );
}

async function exchangeCodeForTokens(code, codeVerifier, env) {
  const { tokenEndpoint } = oidcEndpoints(env);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId(env),
    redirect_uri: redirectUri(env),
    code,
    code_verifier: codeVerifier,
  });
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": "EazpireBrand/1.0",
    },
    body: body.toString(),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("token_exchange_invalid_json");
  }
  if (!res.ok) {
    throw new Error(data?.error_description || data?.error || `token_exchange_${res.status}`);
  }
  return data;
}

async function ownerIdFromIdToken(idToken, env) {
  const url = `${creatorEngineBase(env)}/apps/creator-dispatch?op=exchange-shopify-token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "EazpireBrand/1.0" },
    body: JSON.stringify({ id_token: idToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok || !data.owner_id) {
    throw new Error(data.error || data.detail || "jwt_exchange_failed");
  }
  return String(data.owner_id);
}

export async function handleBrandCustomerOAuthStart(request, env) {
  const session = await requireBrandSession(request, env);
  if (!session) {
    return redirectWithCookies(`${brandPortalUrl(env)}/?auth_error=login_required`, clearPkceCookieHeader(env));
  }

  try {
    const pkce = await generatePkce();
    const { authorizationEndpoint } = oidcEndpoints(env);
    const authUrl = new URL(authorizationEndpoint);
    authUrl.searchParams.set("client_id", clientId(env));
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", redirectUri(env));
    authUrl.searchParams.set("scope", SCOPE);
    authUrl.searchParams.set("state", pkce.state);
    authUrl.searchParams.set("code_challenge", pkce.codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("prompt", "login select_account");

    const pkcePayload = {
      state: pkce.state,
      code_verifier: pkce.codeVerifier,
      brand_uid: session.uid,
    };
    return redirectWithCookies(authUrl.toString(), pkceCookieHeader(pkcePayload, env));
  } catch (e) {
    console.error("[brand-customer-oauth] start failed", e?.message || e);
    return redirectSettingsError(env, "oauth_start_failed");
  }
}

export async function handleBrandCustomerOAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const clearPkce = clearPkceCookieHeader(env);
  const settings = portalSettings(env);

  if (oauthError) {
    return redirectWithCookies(`${settings}?customer_link_error=${encodeURIComponent(oauthError)}`, clearPkce);
  }
  if (!code || !state) {
    return redirectWithCookies(`${settings}?customer_link_error=missing_code`, clearPkce);
  }

  const stored = readPkceCookie(request);
  if (!stored || stored.state !== state || !stored.code_verifier || !stored.brand_uid) {
    return redirectWithCookies(`${settings}?customer_link_error=invalid_state`, clearPkce);
  }

  // Prefer brand session cookie; fall back to pkce brand_uid
  const sessionToken = readCookie(request, brandCookieName());
  const session = (await verifyBrandSession(sessionToken, env)) || { uid: stored.brand_uid };
  const uid = String(session.uid || stored.brand_uid || "").trim();
  if (!uid) {
    return redirectWithCookies(`${settings}?customer_link_error=login_required`, clearPkce);
  }

  try {
    const tokens = await exchangeCodeForTokens(code, stored.code_verifier, env);
    const idToken = String(tokens.id_token || "").trim();
    const accessToken = String(tokens.access_token || "").trim();
    if (!idToken && !accessToken) {
      return redirectWithCookies(`${settings}?customer_link_error=no_token`, clearPkce);
    }

    let ownerId;
    if (idToken) {
      ownerId = await ownerIdFromIdToken(idToken, env);
    } else {
      const res = await fetch(`${creatorEngineBase(env)}/apps/creator-dispatch?op=exchange-shopify-token`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "EazpireBrand/1.0" },
        body: JSON.stringify({ access_token: accessToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.owner_id) {
        throw new Error(data.error || "access_token_exchange_failed");
      }
      ownerId = String(data.owner_id);
    }

    const db = getBrandDb(env);
    if (!db) {
      return redirectWithCookies(`${settings}?customer_link_error=brand_db_unavailable`, clearPkce);
    }
    await ensureBrandSchema(env);
    const now = Date.now();

    await db
      .prepare(
        `UPDATE brand_users SET shopify_customer_id = ?, shopify_linked_at = ?, updated_at = ? WHERE id = ?`
      )
      .bind(ownerId, now, now, uid)
      .run();

    // Propagate to any memberships tied to this brand user / email
    const user = await db.prepare(`SELECT email FROM brand_users WHERE id = ?`).bind(uid).first();
    if (user?.email) {
      await db
        .prepare(
          `UPDATE brand_members
           SET shopify_customer_id = ?, user_id = COALESCE(user_id, ?), status = CASE WHEN status = 'invited' THEN 'active' ELSE status END,
               accepted_at = COALESCE(accepted_at, ?), updated_at = ?
           WHERE lower(email) = lower(?)`
        )
        .bind(ownerId, uid, now, now, user.email)
        .run();
    }

    return redirectWithCookies(`${settings}?customer_linked=1`, clearPkce);
  } catch (e) {
    console.error("[brand-customer-oauth] callback failed", e?.message || e);
    const msg = encodeURIComponent(String(e?.message || "link_failed").slice(0, 120));
    return redirectWithCookies(`${settings}?customer_link_error=${msg}`, clearPkce);
  }
}

export async function handleBrandCustomerUnlink(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);
  const session = await requireBrandSession(request, env);
  if (!session) return json({ ok: false, error: "unauthorized" }, 401, cors);
  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);
  const now = Date.now();
  await db
    .prepare(`UPDATE brand_users SET shopify_customer_id = NULL, shopify_linked_at = NULL, updated_at = ? WHERE id = ?`)
    .bind(now, session.uid)
    .run();
  return json({ ok: true }, 200, cors);
}
