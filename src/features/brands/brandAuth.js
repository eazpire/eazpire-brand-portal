/**
 * Brand Portal magic-link authentication (open signup → create user on first request)
 */

import { json, getCorsHeaders } from "../../utils/response.js";
import { getBrandDb, brandDbUnavailable, newId, ensureBrandSchema } from "./db.js";
import {
  hashToken,
  magicLinkExpiry,
  signBrandSession,
  sessionCookieHeader,
  clearSessionCookieHeader,
  brandCookieName,
  requireBrandSession,
} from "./rbac.js";
import { sendBrandMagicLinkEmail } from "./email.js";
import {
  authTokenStatus,
  readVerifyToken,
  renderMagicLinkConfirmPage,
  redirectWithHeaders,
  wantsJsonVerifyResponse,
} from "./brandAuthVerifyUi.js";

const POLL_PREFIX = "brand_login_poll:";
const POLL_HASH_PREFIX = "brand_login_poll_hash:";
const EXCHANGE_PREFIX = "brand_session_exchange:";
const POLL_TTL_SEC = 15 * 60;
const EXCHANGE_TTL_SEC = 120;

function brandBaseUrl(env) {
  return String(env.BRAND_PORTAL_URL || "https://brand.eazpire.com").replace(/\/$/, "");
}

function brandVerifyFailure(env, request, url, cors, errorCode) {
  if (wantsJsonVerifyResponse(request, url)) {
    return {
      kind: "json",
      status: errorCode === "token_required" ? 400 : 401,
      body: { ok: false, error: errorCode },
      headers: cors,
    };
  }
  return {
    kind: "redirect",
    status: 302,
    location: `${brandBaseUrl(env)}/?auth_error=${encodeURIComponent(errorCode)}`,
    headers: cors,
  };
}

async function ensureBrandUser(db, email) {
  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  let user = await db
    .prepare(`SELECT * FROM brand_users WHERE lower(email) = ? LIMIT 1`)
    .bind(normalized)
    .first();
  if (user) return user;

  const now = Date.now();
  const id = newId("bu");
  await db
    .prepare(
      `INSERT INTO brand_users (id, email, display_name, status, created_at, updated_at)
       VALUES (?, ?, NULL, 'active', ?, ?)`
    )
    .bind(id, normalized, now, now)
    .run();

  return db.prepare(`SELECT * FROM brand_users WHERE id = ?`).bind(id).first();
}

async function insertAuthToken(env, db, brandUserId) {
  const rawToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const tokenHash = await hashToken(rawToken);
  const tokenId = newId("bat");
  await db
    .prepare(
      `INSERT INTO brand_auth_tokens (id, brand_user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(tokenId, brandUserId, tokenHash, magicLinkExpiry(), Date.now())
    .run();
  return {
    rawToken,
    verifyUrl: `${brandBaseUrl(env)}/auth/verify?token=${encodeURIComponent(rawToken)}`,
  };
}

async function issueBrandMagicLink(env, email) {
  const db = getBrandDb(env);
  if (!db) return { ok: false, reason: "brand_db_unavailable" };
  await ensureBrandSchema(env);

  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return { ok: false, reason: "invalid_email" };
  }

  const user = await ensureBrandUser(db, normalized);
  if (!user || user.status !== "active") {
    return { ok: false, reason: "user_inactive" };
  }

  const { rawToken, verifyUrl } = await insertAuthToken(env, db, user.id);
  const mail = await sendBrandMagicLinkEmail(env, { to: normalized, verifyUrl });
  if (!mail.ok && !mail.skipped) {
    return { ok: false, reason: mail.error || "email_failed", detail: mail.detail };
  }
  // Dev: allow skipped email (no RESEND) — still return token path via poll after verify
  return { ok: true, email: normalized, rawToken, verifyUrl, mail_skipped: !!mail.skipped };
}

function newPollToken() {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function newExchangeToken() {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

async function writePoll(env, pollToken, record) {
  if (!env.JOBS?.put) return false;
  await env.JOBS.put(`${POLL_PREFIX}${pollToken}`, JSON.stringify(record), {
    expirationTtl: POLL_TTL_SEC,
  });
  return true;
}

async function readPoll(env, pollToken) {
  if (!env.JOBS?.get || !pollToken) return null;
  const raw = await env.JOBS.get(`${POLL_PREFIX}${pollToken}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function createBrandLoginPoll(env, { email, rawToken = null } = {}) {
  const pollToken = newPollToken();
  const record = {
    email: String(email || "")
      .trim()
      .toLowerCase(),
    status: "pending",
    expires_at: Date.now() + POLL_TTL_SEC * 1000,
    created_at: Date.now(),
  };
  if (rawToken) {
    const tokenHash = await hashToken(rawToken);
    record.token_hash = tokenHash;
    if (env.JOBS?.put) {
      await env.JOBS.put(`${POLL_HASH_PREFIX}${tokenHash}`, pollToken, {
        expirationTtl: POLL_TTL_SEC,
      });
    }
  }
  await writePoll(env, pollToken, record);
  return pollToken;
}

export async function markBrandLoginPollVerified(env, rawToken, { jwt, email } = {}) {
  if (!env.JOBS?.get || !rawToken || !jwt) return;
  const tokenHash = await hashToken(rawToken);
  const pollToken = await env.JOBS.get(`${POLL_HASH_PREFIX}${tokenHash}`);
  if (!pollToken) return;
  const record = await readPoll(env, pollToken);
  if (!record || record.status === "verified") return;

  const exchangeToken = newExchangeToken();
  await env.JOBS.put(
    `${EXCHANGE_PREFIX}${exchangeToken}`,
    JSON.stringify({ jwt, email, used_at: null }),
    { expirationTtl: EXCHANGE_TTL_SEC }
  );
  record.status = "verified";
  record.exchange_token = exchangeToken;
  record.verified_at = Date.now();
  await writePoll(env, pollToken, record);
}

export async function handleBrandAuthRequest(request, env) {
  const cors = getCorsHeaders(request);
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || "").trim();
  const result = await issueBrandMagicLink(env, email);

  if (!result.ok && result.reason === "invalid_email") {
    return json({ ok: false, error: "invalid_email" }, 400, cors);
  }
  if (!result.ok && result.reason === "brand_db_unavailable") {
    return json(brandDbUnavailable(), 503, cors);
  }
  if (!result.ok) {
    return json({ ok: false, error: result.reason || "auth_failed", detail: result.detail }, 400, cors);
  }

  const pollToken = await createBrandLoginPoll(env, {
    email: result.email,
    rawToken: result.rawToken,
  });

  const payload = { ok: true, sent: !result.mail_skipped, poll_token: pollToken || undefined };
  if (result.mail_skipped && env.BRAND_DEV_RETURN_VERIFY_URL === "1") {
    payload.dev_verify_url = result.verifyUrl;
  }
  return json(payload, 200, cors);
}

export async function handleBrandAuthPoll(request, env) {
  const cors = getCorsHeaders(request);
  const pollToken = String(new URL(request.url).searchParams.get("poll_token") || "").trim();
  if (!pollToken) return json({ ok: false, error: "poll_token_required" }, 400, cors);

  const record = await readPoll(env, pollToken);
  if (!record) return json({ ok: true, status: "expired" }, 200, cors);
  if (record.expires_at && record.expires_at < Date.now()) {
    return json({ ok: true, status: "expired" }, 200, cors);
  }
  if (record.status === "verified" && record.exchange_token) {
    return json(
      { ok: true, status: "verified", exchange_token: record.exchange_token },
      200,
      cors
    );
  }
  return json({ ok: true, status: "pending" }, 200, cors);
}

export async function handleBrandAuthExchange(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);
  const body = await request.json().catch(() => ({}));
  const exchangeToken = String(body.exchange_token || "").trim();
  if (!exchangeToken) return json({ ok: false, error: "exchange_token_required" }, 400, cors);
  if (!env.JOBS?.get) return json({ ok: false, error: "kv_unavailable" }, 503, cors);

  const key = `${EXCHANGE_PREFIX}${exchangeToken}`;
  const raw = await env.JOBS.get(key);
  if (!raw) return json({ ok: false, error: "invalid_or_expired_exchange" }, 401, cors);
  let row;
  try {
    row = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "invalid_or_expired_exchange" }, 401, cors);
  }
  if (!row?.jwt || row.used_at) {
    return json({ ok: false, error: "invalid_or_expired_exchange" }, 401, cors);
  }
  await env.JOBS.delete(key).catch(() => {});
  return json(
    { ok: true },
    200,
    { ...cors, "Set-Cookie": sessionCookieHeader(brandCookieName(), row.jwt) }
  );
}

/** Re-issue session if magic link was just consumed (email preview / double submit / poll race). */
const USED_TOKEN_GRACE_MS = 10 * 60 * 1000;

async function completeBrandLogin(env, db, row, rawToken) {
  await db
    .prepare(`UPDATE brand_auth_tokens SET used_at = ? WHERE id = ?`)
    .bind(Date.now(), row.id)
    .run();

  const jwt = await signBrandSession(env, {
    uid: row.user_id,
    email: row.email,
  });

  await markBrandLoginPollVerified(env, rawToken, { jwt, email: row.email });
  return jwt;
}

export async function handleBrandAuthVerify(request, env) {
  const cors = getCorsHeaders(request);
  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const url = new URL(request.url);
  const rawToken = await readVerifyToken(request, url);
  if (!rawToken) {
    const failure = brandVerifyFailure(env, request, url, cors, "token_required");
    if (failure.kind === "json") return json(failure.body, failure.status, failure.headers);
    return redirectWithHeaders(failure.location, failure.status, failure.headers);
  }

  const shouldConsume =
    request.method === "POST" ||
    (wantsJsonVerifyResponse(request, url) && url.searchParams.get("confirm") === "1");

  if (!shouldConsume) {
    const html = renderMagicLinkConfirmPage({
      actionPath: "/auth/verify",
      token: rawToken,
      title: "Sign in to Brand Portal",
      lead: "Click below to open your brand workspace. This step stops email scanners from using your link before you do.",
      buttonLabel: "Continue to Brand Portal",
    });
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...cors,
      },
    });
  }

  const tokenHash = await hashToken(rawToken);
  const row = await db
    .prepare(
      `SELECT t.*, u.id AS user_id, u.email, u.status AS user_status
       FROM brand_auth_tokens t
       JOIN brand_users u ON u.id = t.brand_user_id
       WHERE t.token_hash = ?
       LIMIT 1`
    )
    .bind(tokenHash)
    .first();

  const status = authTokenStatus(row);

  // Idempotent: link already used (scanner + user, or double-click) → still sign in within grace window
  if (status === "token_already_used" && row?.user_status === "active") {
    const usedAt = Number(row.used_at || 0);
    if (usedAt && Date.now() - usedAt < USED_TOKEN_GRACE_MS) {
      const jwt = await signBrandSession(env, { uid: row.user_id, email: row.email });
      await markBrandLoginPollVerified(env, rawToken, { jwt, email: row.email });
      if (wantsJsonVerifyResponse(request, url)) {
        return json(
          { ok: true, reused: true },
          200,
          { ...cors, "Set-Cookie": sessionCookieHeader(brandCookieName(), jwt) }
        );
      }
      return redirectWithHeaders(brandBaseUrl(env) + "/", 303, {
        ...cors,
        "Set-Cookie": sessionCookieHeader(brandCookieName(), jwt),
        "cache-control": "no-store",
      });
    }
  }

  if (status !== "valid" || row?.user_status !== "active") {
    const code = status !== "valid" ? status : "user_inactive";
    const failure = brandVerifyFailure(env, request, url, cors, code);
    if (failure.kind === "json") return json(failure.body, failure.status, failure.headers);
    return redirectWithHeaders(failure.location, failure.status, failure.headers);
  }

  const jwt = await completeBrandLogin(env, db, row, rawToken);

  if (wantsJsonVerifyResponse(request, url)) {
    return json(
      { ok: true },
      200,
      { ...cors, "Set-Cookie": sessionCookieHeader(brandCookieName(), jwt) }
    );
  }

  // 303 after POST avoids form re-submit → token_already_used loops
  return redirectWithHeaders(brandBaseUrl(env) + "/", 303, {
    ...cors,
    "Set-Cookie": sessionCookieHeader(brandCookieName(), jwt),
    "cache-control": "no-store",
  });
}

export async function handleBrandAuthLogout(request, env) {
  const cors = getCorsHeaders(request);
  return json(
    { ok: true },
    200,
    { ...cors, "Set-Cookie": clearSessionCookieHeader(brandCookieName()) }
  );
}

export async function handleBrandAuthMe(request, env) {
  const cors = getCorsHeaders(request);
  const session = await requireBrandSession(request, env);
  if (!session) return json({ ok: false, error: "unauthorized" }, 401, cors);

  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const user = await db
    .prepare(`SELECT id, email, display_name, status FROM brand_users WHERE id = ?`)
    .bind(session.uid)
    .first();
  if (!user) return json({ ok: false, error: "unauthorized" }, 401, cors);

  const brand = await db
    .prepare(
      `SELECT id, name, handle, tagline, about, logo_r2_key, status, created_at, updated_at
       FROM brands WHERE owner_user_id = ? AND status != 'deleted' ORDER BY created_at ASC LIMIT 1`
    )
    .bind(user.id)
    .first();

  return json(
    {
      ok: true,
      user: { id: user.id, email: user.email, display_name: user.display_name },
      brand: brand || null,
      needs_onboarding: !brand,
    },
    200,
    cors
  );
}
