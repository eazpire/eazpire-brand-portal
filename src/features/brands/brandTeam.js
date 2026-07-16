/**
 * Brand team invites + publish_mode
 */

import { json, getCorsHeaders } from "../../utils/response.js";
import { newId } from "./db.js";
import { sendBrandInviteEmail } from "./email.js";
import { resolveBrandAuthContext } from "./brandAuthContext.js";
import { BRAND_API_SCOPES } from "./rbac.js";

export async function handleBrandTeamList(request, env) {
  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.TEAM_READ,
    allowSuspended: true,
  });
  if (resolved.error) return resolved.error;
  const { cors, db, brand } = resolved;

  const rows = await db
    .prepare(
      `SELECT id, email, role, publish_mode, status, created_at, updated_at
       FROM brand_members WHERE brand_id = ? AND role != 'owner' ORDER BY created_at DESC`
    )
    .bind(brand.id)
    .all();

  return json({ ok: true, members: rows?.results || [] }, 200, cors);
}

/** Invite creator by email — session or API key with team:invite */
export async function handleBrandTeamInvite(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.TEAM_INVITE,
  });
  if (resolved.error) return resolved.error;
  const { db, brand, auth } = resolved;

  const body = await request.json().catch(() => ({}));
  const email = String(body.email || "")
    .trim()
    .toLowerCase();
  const publishMode = String(body.publish_mode || "review").trim() === "auto_publish" ? "auto_publish" : "review";

  if (!email || !email.includes("@")) {
    return json({ ok: false, error: "invalid_email" }, 400, cors);
  }
  if (auth.type === "session" && auth.email && email === String(auth.email).toLowerCase()) {
    return json({ ok: false, error: "cannot_invite_self" }, 400, cors);
  }

  const existing = await db
    .prepare(`SELECT * FROM brand_members WHERE brand_id = ? AND lower(email) = ?`)
    .bind(brand.id, email)
    .first();

  const now = Date.now();
  let memberId;
  const invitedBy = auth.uid;

  if (existing) {
    if (existing.role === "owner") {
      return json({ ok: false, error: "is_owner" }, 400, cors);
    }
    await db
      .prepare(
        `UPDATE brand_members SET status = 'invited', publish_mode = ?, updated_at = ? WHERE id = ?`
      )
      .bind(publishMode, now, existing.id)
      .run();
    memberId = existing.id;
  } else {
    memberId = newId("bm");
    await db
      .prepare(
        `INSERT INTO brand_members
          (id, brand_id, email, user_id, role, publish_mode, status, invited_by, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'creator', ?, 'invited', ?, ?, ?)`
      )
      .bind(memberId, brand.id, email, publishMode, invitedBy, now, now)
      .run();
  }

  const portalUrl = String(env.BRAND_PORTAL_URL || "https://brand.eazpire.com").replace(/\/$/, "");
  const mail = await sendBrandInviteEmail(env, {
    to: email,
    brandName: brand.name,
    portalUrl,
  });

  const member = await db.prepare(`SELECT * FROM brand_members WHERE id = ?`).bind(memberId).first();
  return json(
    {
      ok: true,
      member: {
        id: member.id,
        email: member.email,
        role: member.role,
        publish_mode: member.publish_mode,
        status: member.status,
      },
      email_sent: !!mail.ok,
      email_skipped: !!mail.skipped,
    },
    200,
    cors
  );
}

/** Update publish_mode / status — session or API key with team:write */
export async function handleBrandTeamUpdate(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.TEAM_WRITE,
  });
  if (resolved.error) return resolved.error;
  const { db, brand } = resolved;

  const body = await request.json().catch(() => ({}));
  const memberId = String(body.member_id || "").trim();
  if (!memberId) return json({ ok: false, error: "member_id_required" }, 400, cors);

  const member = await db
    .prepare(`SELECT * FROM brand_members WHERE id = ? AND brand_id = ?`)
    .bind(memberId, brand.id)
    .first();
  if (!member || member.role === "owner") {
    return json({ ok: false, error: "member_not_found" }, 404, cors);
  }

  if (body.publish_mode != null) {
    const mode = String(body.publish_mode) === "auto_publish" ? "auto_publish" : "review";
    await db
      .prepare(`UPDATE brand_members SET publish_mode = ?, updated_at = ? WHERE id = ?`)
      .bind(mode, Date.now(), memberId)
      .run();
  }

  if (body.status === "revoked" || body.status === "active" || body.status === "invited") {
    await db
      .prepare(`UPDATE brand_members SET status = ?, updated_at = ? WHERE id = ?`)
      .bind(body.status, Date.now(), memberId)
      .run();
  }

  const updated = await db.prepare(`SELECT * FROM brand_members WHERE id = ?`).bind(memberId).first();
  return json(
    {
      ok: true,
      member: {
        id: updated.id,
        email: updated.email,
        role: updated.role,
        publish_mode: updated.publish_mode,
        status: updated.status,
        updated_at: updated.updated_at,
      },
    },
    200,
    cors
  );
}

/** Revoke member — session or API key with team:write */
export async function handleBrandTeamRevoke(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.TEAM_WRITE,
  });
  if (resolved.error) return resolved.error;
  const { db, brand } = resolved;

  const body = await request.json().catch(() => ({}));
  const memberId = String(body.member_id || "").trim();
  if (!memberId) return json({ ok: false, error: "member_id_required" }, 400, cors);

  const member = await db
    .prepare(`SELECT * FROM brand_members WHERE id = ? AND brand_id = ?`)
    .bind(memberId, brand.id)
    .first();
  if (!member || member.role === "owner") {
    return json({ ok: false, error: "member_not_found" }, 404, cors);
  }

  await db
    .prepare(`UPDATE brand_members SET status = 'revoked', updated_at = ? WHERE id = ?`)
    .bind(Date.now(), memberId)
    .run();

  const updated = await db.prepare(`SELECT * FROM brand_members WHERE id = ?`).bind(memberId).first();
  return json(
    {
      ok: true,
      member: {
        id: updated.id,
        email: updated.email,
        role: updated.role,
        publish_mode: updated.publish_mode,
        status: updated.status,
        updated_at: updated.updated_at,
      },
    },
    200,
    cors
  );
}
