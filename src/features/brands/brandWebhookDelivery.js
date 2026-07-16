/**
 * Brand webhook delivery: HMAC signing, SSRF-safe URL checks, retries, waitUntil scheduling.
 */

import { getBrandDb, newId, ensureBrandSchema } from "./db.js";
import { encryptSecret, decryptSecret } from "./secrets.js";

export const BRAND_WEBHOOK_EVENTS = [
  "product.published",
  "product.unpublished",
  "product.updated",
  "product.synced",
  "webhook.ping",
];

const MAX_FAILURES_BEFORE_DISABLE = 8;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 400, 1600];
const DELIVERY_TIMEOUT_MS = 8000;

/** Blocked hostnames / IP patterns for SSRF protection */
const BLOCKED_HOST_RE =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1|\[::1\])/i;
const PRIVATE_IPV4_RE =
  /^(10\.|127\.|169\.254\.|192\.168\.|0\.)|^(172\.(1[6-9]|2\d|3[0-1])\.)/;

/**
 * Validate webhook endpoint URL. HTTPS required except localhost/127.0.0.1 for local testing.
 * @returns {{ ok: true, url: URL } | { ok: false, error: string }}
 */
export function validateWebhookUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: false, error: "url_required" };

  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "invalid_url" };
  }

  const host = u.hostname.toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";

  if (u.protocol === "http:") {
    if (!isLocal) return { ok: false, error: "https_required" };
  } else if (u.protocol !== "https:") {
    return { ok: false, error: "https_required" };
  }

  if (u.username || u.password) return { ok: false, error: "url_credentials_not_allowed" };

  if (!isLocal) {
    if (BLOCKED_HOST_RE.test(host) || PRIVATE_IPV4_RE.test(host)) {
      return { ok: false, error: "url_private_or_metadata_blocked" };
    }
    // Literal IPv6 private/link-local (rough)
    if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
      return { ok: false, error: "url_private_or_metadata_blocked" };
    }
  }

  return { ok: true, url: u };
}

export function normalizeWebhookEvents(input) {
  const allowed = new Set(BRAND_WEBHOOK_EVENTS.filter((e) => e !== "webhook.ping"));
  let list = [];
  if (Array.isArray(input)) {
    list = input.map((e) => String(e).trim()).filter((e) => allowed.has(e));
  } else if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) {
        list = parsed.map((e) => String(e).trim()).filter((e) => allowed.has(e));
      }
    } catch {
      /* ignore */
    }
  }
  if (!list.length) {
    return ["product.published", "product.unpublished", "product.updated", "product.synced"];
  }
  return [...new Set(list)];
}

function randomWebhookSecret(len = 32) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return `whsec_${out}`;
}

export function generateWebhookSigningSecret() {
  return randomWebhookSecret(36);
}

async function hmacSha256Hex(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(body) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function mapWebhookRow(row, { includeSecretPrefix = true } = {}) {
  if (!row) return null;
  let events = [];
  try {
    events = JSON.parse(row.events || "[]");
  } catch {
    events = [];
  }
  return {
    id: row.id,
    url: row.url,
    events,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_delivery_at: row.last_delivery_at,
    last_error: row.last_error || null,
    failure_count: Number(row.failure_count || 0),
    secret_hint: includeSecretPrefix ? "whsec_…" : undefined,
  };
}

/**
 * Build standard event envelope + deliver to all matching active webhooks for brand.
 * Non-blocking when ctx.waitUntil is provided.
 */
export function emitBrandWebhook(env, ctx, brandId, event, data = {}) {
  const run = deliverBrandEvent(env, brandId, event, data).catch((e) => {
    console.warn("[brand-webhook] emit failed", event, e?.message || e);
  });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(run);
  }
  return run;
}

export async function deliverBrandEvent(env, brandId, event, data = {}) {
  const db = getBrandDb(env);
  if (!db || !brandId || !event) return { delivered: 0 };
  await ensureBrandSchema(env);

  const rows = await db
    .prepare(
      `SELECT * FROM brand_webhooks
       WHERE brand_id = ? AND status = 'active'
       ORDER BY created_at ASC`
    )
    .bind(brandId)
    .all();

  const webhooks = (rows?.results || []).filter((row) => {
    if (event === "webhook.ping") return true;
    let events = [];
    try {
      events = JSON.parse(row.events || "[]");
    } catch {
      events = [];
    }
    return events.includes(event);
  });

  if (!webhooks.length) return { delivered: 0 };

  let delivered = 0;
  for (const wh of webhooks) {
    const ok = await deliverOne(env, db, wh, event, data);
    if (ok) delivered += 1;
  }
  return { delivered };
}

/** Deliver one event to a specific webhook row (used by test endpoint). */
export async function deliverToWebhook(env, webhook, event, data = {}) {
  const db = getBrandDb(env);
  if (!db || !webhook?.id) return false;
  await ensureBrandSchema(env);
  return deliverOne(env, db, webhook, event, data);
}

async function deliverOne(env, db, webhook, event, data) {
  const deliveryId = newId("del");
  const createdAt = Date.now();
  const payloadObj = {
    id: deliveryId,
    event,
    created_at: createdAt,
    brand_id: webhook.brand_id,
    data: data && typeof data === "object" ? data : {},
  };
  const body = JSON.stringify(payloadObj);
  const payloadHash = await sha256Hex(body);

  await db
    .prepare(
      `INSERT INTO brand_webhook_deliveries
        (id, webhook_id, event, payload_hash, status, attempts, response_code, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?)`
    )
    .bind(deliveryId, webhook.id, event, payloadHash, createdAt)
    .run();

  let secret;
  try {
    secret = await decryptSecret(env, webhook.secret_ciphertext);
  } catch (e) {
    await markDelivery(db, webhook.id, deliveryId, {
      status: "failed",
      attempts: 0,
      responseCode: null,
      error: "secret_decrypt_failed",
    });
    return false;
  }

  const signature = await hmacSha256Hex(secret, body);
  let lastCode = null;
  let lastErr = null;
  let attempts = 0;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (BACKOFF_MS[i]) await sleep(BACKOFF_MS[i]);
    attempts = i + 1;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
      const res = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "eazpire-brand-webhooks/1.0",
          "X-Eazpire-Event": event,
          "X-Eazpire-Delivery-Id": deliveryId,
          "X-Eazpire-Signature": `sha256=${signature}`,
        },
        body,
        signal: controller.signal,
        redirect: "error",
      });
      clearTimeout(timer);
      lastCode = res.status;
      if (res.status >= 200 && res.status < 300) {
        await markDelivery(db, webhook.id, deliveryId, {
          status: "success",
          attempts,
          responseCode: lastCode,
          error: null,
          resetFailures: true,
        });
        return true;
      }
      lastErr = `http_${res.status}`;
      // Retry only on 5xx
      if (res.status < 500) break;
    } catch (e) {
      lastErr = String(e?.name === "AbortError" ? "timeout" : e?.message || e).slice(0, 200);
    }
  }

  await markDelivery(db, webhook.id, deliveryId, {
    status: "failed",
    attempts,
    responseCode: lastCode,
    error: lastErr || "delivery_failed",
  });
  return false;
}

async function markDelivery(db, webhookId, deliveryId, opts) {
  const now = Date.now();
  await db
    .prepare(
      `UPDATE brand_webhook_deliveries
       SET status = ?, attempts = ?, response_code = ?
       WHERE id = ?`
    )
    .bind(opts.status, opts.attempts, opts.responseCode, deliveryId)
    .run();

  if (opts.resetFailures) {
    await db
      .prepare(
        `UPDATE brand_webhooks
         SET last_delivery_at = ?, last_error = NULL, failure_count = 0, updated_at = ?
         WHERE id = ?`
      )
      .bind(now, now, webhookId)
      .run();
    return;
  }

  const row = await db
    .prepare(`SELECT failure_count FROM brand_webhooks WHERE id = ?`)
    .bind(webhookId)
    .first();
  const failures = Number(row?.failure_count || 0) + 1;
  const disable = failures >= MAX_FAILURES_BEFORE_DISABLE;
  await db
    .prepare(
      `UPDATE brand_webhooks
       SET last_delivery_at = ?, last_error = ?, failure_count = ?,
           status = CASE WHEN ? THEN 'disabled' ELSE status END,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(now, String(opts.error || "").slice(0, 400), failures, disable ? 1 : 0, now, webhookId)
    .run();
}

export { mapWebhookRow, hmacSha256Hex };
