/**
 * Brand webhook CRUD API (session OR API key with webhooks:read / webhooks:write).
 */

import { json, getCorsHeaders } from "../../utils/response.js";
import { newId } from "./db.js";
import { resolveBrandAuthContext } from "./brandAuthContext.js";
import { BRAND_API_SCOPES } from "./rbac.js";
import { encryptSecret } from "./secrets.js";
import {
  validateWebhookUrl,
  normalizeWebhookEvents,
  generateWebhookSigningSecret,
  mapWebhookRow,
  deliverToWebhook,
  BRAND_WEBHOOK_EVENTS,
} from "./brandWebhookDelivery.js";

function publicWebhook(row) {
  const mapped = mapWebhookRow(row);
  if (!mapped) return null;
  delete mapped.secret_hint;
  return mapped;
}

/** GET ?op=brand-api-webhooks | brand-webhooks-list */
export async function handleBrandWebhooksList(request, env) {
  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.WEBHOOKS_READ,
    allowSuspended: true,
  });
  if (resolved.error) return resolved.error;
  const { cors, db, brand } = resolved;

  const rows = await db
    .prepare(
      `SELECT id, brand_id, url, events, status, created_at, updated_at, last_delivery_at, last_error, failure_count
       FROM brand_webhooks WHERE brand_id = ? ORDER BY created_at DESC`
    )
    .bind(brand.id)
    .all();

  return json(
    {
      ok: true,
      webhooks: (rows?.results || []).map(publicWebhook),
      available_events: BRAND_WEBHOOK_EVENTS.filter((e) => e !== "webhook.ping"),
    },
    200,
    cors
  );
}

/** POST ?op=brand-api-webhooks-create | brand-webhooks-create  body: { url, events? } */
export async function handleBrandWebhooksCreate(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.WEBHOOKS_WRITE,
  });
  if (resolved.error) return resolved.error;
  const { db, brand } = resolved;

  const body = await request.json().catch(() => ({}));
  const urlCheck = validateWebhookUrl(body.url);
  if (!urlCheck.ok) return json({ ok: false, error: urlCheck.error }, 400, cors);

  const events = normalizeWebhookEvents(body.events);
  const rawSecret = generateWebhookSigningSecret();
  const secretCipher = await encryptSecret(env, rawSecret);
  const id = newId("bwh");
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO brand_webhooks
        (id, brand_id, url, secret_ciphertext, events, status, created_at, updated_at, last_delivery_at, last_error, failure_count)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, 0)`
    )
    .bind(id, brand.id, urlCheck.url.toString(), secretCipher, JSON.stringify(events), now, now)
    .run();

  return json(
    {
      ok: true,
      webhook: {
        id,
        url: urlCheck.url.toString(),
        events,
        status: "active",
        created_at: now,
        updated_at: now,
        last_delivery_at: null,
        last_error: null,
        failure_count: 0,
      },
      /** Signing secret — shown once; store securely */
      secret: rawSecret,
    },
    200,
    cors
  );
}

/** POST ?op=brand-api-webhooks-update  body: { webhook_id|id, url?, events?, status? } */
export async function handleBrandWebhooksUpdate(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST" && request.method !== "PATCH" && request.method !== "PUT") {
    return json({ ok: false, error: "method_not_allowed" }, 405, cors);
  }

  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.WEBHOOKS_WRITE,
  });
  if (resolved.error) return resolved.error;
  const { db, brand } = resolved;

  const url = new URL(request.url);
  const body = await request.json().catch(() => ({}));
  const webhookId = String(
    body.webhook_id || body.id || url.searchParams.get("webhook_id") || url.searchParams.get("id") || ""
  ).trim();
  if (!webhookId) return json({ ok: false, error: "webhook_id_required" }, 400, cors);

  const row = await db
    .prepare(`SELECT * FROM brand_webhooks WHERE id = ? AND brand_id = ? LIMIT 1`)
    .bind(webhookId, brand.id)
    .first();
  if (!row) return json({ ok: false, error: "not_found" }, 404, cors);

  let nextUrl = row.url;
  let nextEvents = row.events;
  let nextStatus = row.status;

  if (body.url != null) {
    const urlCheck = validateWebhookUrl(body.url);
    if (!urlCheck.ok) return json({ ok: false, error: urlCheck.error }, 400, cors);
    nextUrl = urlCheck.url.toString();
  }
  if (body.events != null) {
    nextEvents = JSON.stringify(normalizeWebhookEvents(body.events));
  }
  if (body.status != null) {
    const s = String(body.status).trim().toLowerCase();
    if (s !== "active" && s !== "disabled") {
      return json({ ok: false, error: "invalid_status", allowed: ["active", "disabled"] }, 400, cors);
    }
    nextStatus = s;
  }

  const now = Date.now();
  const resetFailures = nextStatus === "active" && row.status !== "active";
  await db
    .prepare(
      `UPDATE brand_webhooks
       SET url = ?, events = ?, status = ?, updated_at = ?,
           failure_count = CASE WHEN ? THEN 0 ELSE failure_count END,
           last_error = CASE WHEN ? THEN NULL ELSE last_error END
       WHERE id = ?`
    )
    .bind(nextUrl, nextEvents, nextStatus, now, resetFailures ? 1 : 0, resetFailures ? 1 : 0, webhookId)
    .run();

  const updated = await db
    .prepare(
      `SELECT id, brand_id, url, events, status, created_at, updated_at, last_delivery_at, last_error, failure_count
       FROM brand_webhooks WHERE id = ?`
    )
    .bind(webhookId)
    .first();

  return json({ ok: true, webhook: publicWebhook(updated) }, 200, cors);
}

/** POST/DELETE ?op=brand-api-webhooks-revoke — soft-disable (or hard delete with hard:true) */
export async function handleBrandWebhooksRevoke(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST" && request.method !== "DELETE") {
    return json({ ok: false, error: "method_not_allowed" }, 405, cors);
  }

  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.WEBHOOKS_WRITE,
  });
  if (resolved.error) return resolved.error;
  const { db, brand } = resolved;

  const url = new URL(request.url);
  const body = request.method === "DELETE" ? {} : await request.json().catch(() => ({}));
  const webhookId = String(
    body.webhook_id || body.id || url.searchParams.get("webhook_id") || url.searchParams.get("id") || ""
  ).trim();
  if (!webhookId) return json({ ok: false, error: "webhook_id_required" }, 400, cors);

  const hard = body.hard === true || url.searchParams.get("hard") === "1";

  const row = await db
    .prepare(`SELECT id, status FROM brand_webhooks WHERE id = ? AND brand_id = ? LIMIT 1`)
    .bind(webhookId, brand.id)
    .first();
  if (!row) return json({ ok: false, error: "not_found" }, 404, cors);

  if (hard) {
    await db.prepare(`DELETE FROM brand_webhook_deliveries WHERE webhook_id = ?`).bind(webhookId).run();
    await db.prepare(`DELETE FROM brand_webhooks WHERE id = ?`).bind(webhookId).run();
    return json({ ok: true, deleted: true }, 200, cors);
  }

  if (row.status === "disabled") return json({ ok: true, already: true }, 200, cors);

  await db
    .prepare(`UPDATE brand_webhooks SET status = 'disabled', updated_at = ? WHERE id = ?`)
    .bind(Date.now(), webhookId)
    .run();

  return json({ ok: true, revoked: true }, 200, cors);
}

/** POST ?op=brand-api-webhooks-test  body: { webhook_id } — send webhook.ping to that endpoint */
export async function handleBrandWebhooksTest(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.WEBHOOKS_WRITE,
  });
  if (resolved.error) return resolved.error;
  const { db, brand } = resolved;

  const url = new URL(request.url);
  const body = await request.json().catch(() => ({}));
  const webhookId = String(
    body.webhook_id || body.id || url.searchParams.get("webhook_id") || url.searchParams.get("id") || ""
  ).trim();
  if (!webhookId) return json({ ok: false, error: "webhook_id_required" }, 400, cors);

  const row = await db
    .prepare(`SELECT * FROM brand_webhooks WHERE id = ? AND brand_id = ? LIMIT 1`)
    .bind(webhookId, brand.id)
    .first();
  if (!row) return json({ ok: false, error: "not_found" }, 404, cors);
  if (row.status !== "active") {
    return json({ ok: false, error: "webhook_disabled" }, 400, cors);
  }

  const ok = await deliverToWebhook(env, row, "webhook.ping", {
    message: "eazpire brand webhook test ping",
  });

  return json(
    {
      ok: true,
      sent: !!ok,
      event: "webhook.ping",
      webhook_id: webhookId,
    },
    200,
    cors
  );
}

export { publicWebhook };
