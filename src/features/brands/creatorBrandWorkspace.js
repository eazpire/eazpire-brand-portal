/**
 * Creator workspace under Brand — memberships + active context (brand-db).
 */

import { json, getCorsHeaders } from "../../utils/response.js";
import { getAuthUser } from "../../utils/auth.js";
import { getBrandDb, brandDbUnavailable, ensureBrandSchema } from "./db.js";
import { requireBrandSession } from "./rbac.js";

async function ensureContextTable(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS creator_brand_context (
        owner_id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`
    )
    .run();
}

/**
 * Activate invited memberships for a brand portal user (email match).
 */
export async function activateBrandInvitesForUser(db, { userId, email }) {
  if (!db || !userId || !email) return 0;
  const now = Date.now();
  const res = await db
    .prepare(
      `UPDATE brand_members
       SET status = 'active', user_id = ?, accepted_at = COALESCE(accepted_at, ?), updated_at = ?
       WHERE lower(email) = lower(?) AND status = 'invited' AND role != 'owner'`
    )
    .bind(userId, now, now, email)
    .run();
  return res?.meta?.changes || 0;
}

async function listWorkspacesForOwner(db, ownerId) {
  await ensureContextTable(db);

  const owned = await db
    .prepare(
      `SELECT b.id AS brand_id, b.name, b.handle, b.logo_r2_key, 'owner' AS role, 'auto_publish' AS publish_mode
       FROM brands b
       JOIN brand_users u ON u.id = b.owner_user_id
       WHERE u.shopify_customer_id = ? AND b.status != 'deleted'`
    )
    .bind(ownerId)
    .all();

  const member = await db
    .prepare(
      `SELECT b.id AS brand_id, b.name, b.handle, b.logo_r2_key, m.role, m.publish_mode
       FROM brand_members m
       JOIN brands b ON b.id = m.brand_id
       WHERE m.shopify_customer_id = ? AND m.status = 'active' AND b.status != 'deleted' AND m.role != 'owner'`
    )
    .bind(ownerId)
    .all();

  const map = new Map();
  for (const row of [...(owned?.results || []), ...(member?.results || [])]) {
    if (!row?.brand_id) continue;
    if (!map.has(row.brand_id)) map.set(row.brand_id, row);
  }

  const ctx = await db
    .prepare(`SELECT brand_id FROM creator_brand_context WHERE owner_id = ?`)
    .bind(ownerId)
    .first();

  const workspaces = [...map.values()].map((w) => ({
    brand_id: w.brand_id,
    name: w.name,
    handle: w.handle,
    logo_r2_key: w.logo_r2_key || null,
    role: w.role,
    publish_mode: w.publish_mode === "auto_publish" ? "auto_publish" : "review",
    active: ctx?.brand_id === w.brand_id,
  }));

  const active = workspaces.find((w) => w.active) || null;
  return { workspaces, active };
}

/** Creator-engine: list / set workspace for logged-in Shopify customer */
export async function handleCreatorBrandWorkspaces(request, env) {
  const cors = getCorsHeaders(request);
  const auth = await getAuthUser(request, env);
  const ownerId = auth?.owner_id ? String(auth.owner_id) : null;
  if (!ownerId) return json({ ok: false, error: "login_required" }, 401, cors);

  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);
  await ensureContextTable(db);

  if (request.method === "GET") {
    const data = await listWorkspacesForOwner(db, ownerId);
    return json({ ok: true, ...data }, 200, cors);
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const brandId = body.brand_id != null ? String(body.brand_id).trim() : "";
    const clear = body.clear === true || brandId === "";

    if (clear) {
      await db.prepare(`DELETE FROM creator_brand_context WHERE owner_id = ?`).bind(ownerId).run();
      const data = await listWorkspacesForOwner(db, ownerId);
      return json({ ok: true, ...data }, 200, cors);
    }

    const data = await listWorkspacesForOwner(db, ownerId);
    const allowed = data.workspaces.find((w) => w.brand_id === brandId);
    if (!allowed) return json({ ok: false, error: "brand_not_allowed" }, 403, cors);

    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO creator_brand_context (owner_id, brand_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(owner_id) DO UPDATE SET brand_id = excluded.brand_id, updated_at = excluded.updated_at`
      )
      .bind(ownerId, brandId, now)
      .run();

    const next = await listWorkspacesForOwner(db, ownerId);
    return json({ ok: true, ...next }, 200, cors);
  }

  return json({ ok: false, error: "method_not_allowed" }, 405, cors);
}

/** Resolve active brand workspace for a Shopify customer (owner_id). */
export async function getActiveCreatorBrandContext(env, ownerId) {
  const db = getBrandDb(env);
  if (!db || !ownerId) return null;
  await ensureBrandSchema(env);
  await ensureContextTable(db);
  const { active } = await listWorkspacesForOwner(db, String(ownerId));
  return active;
}

/** Brand portal: memberships for the signed-in brand user (as invited creator). */
export async function handleBrandMyMemberships(request, env) {
  const cors = getCorsHeaders(request);
  const session = await requireBrandSession(request, env);
  if (!session) return json({ ok: false, error: "unauthorized" }, 401, cors);
  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const user = await db
    .prepare(`SELECT id, email, shopify_customer_id FROM brand_users WHERE id = ?`)
    .bind(session.uid)
    .first();
  if (!user) return json({ ok: false, error: "unauthorized" }, 401, cors);

  await activateBrandInvitesForUser(db, { userId: user.id, email: user.email });

  const rows = await db
    .prepare(
      `SELECT m.id, m.brand_id, m.role, m.publish_mode, m.status, m.accepted_at, b.name, b.handle
       FROM brand_members m
       JOIN brands b ON b.id = m.brand_id
       WHERE (m.user_id = ? OR lower(m.email) = lower(?)) AND m.role != 'owner' AND b.status != 'deleted'
       ORDER BY m.updated_at DESC`
    )
    .bind(user.id, user.email)
    .all();

  return json(
    {
      ok: true,
      shopify_customer_id: user.shopify_customer_id || null,
      memberships: rows?.results || [],
    },
    200,
    cors
  );
}

export async function handleBrandAcceptInvite(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);
  const session = await requireBrandSession(request, env);
  if (!session) return json({ ok: false, error: "unauthorized" }, 401, cors);
  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const user = await db
    .prepare(`SELECT id, email, shopify_customer_id FROM brand_users WHERE id = ?`)
    .bind(session.uid)
    .first();
  if (!user) return json({ ok: false, error: "unauthorized" }, 401, cors);

  const activated = await activateBrandInvitesForUser(db, { userId: user.id, email: user.email });
  if (user.shopify_customer_id) {
    await db
      .prepare(
        `UPDATE brand_members SET shopify_customer_id = ?, updated_at = ?
         WHERE lower(email) = lower(?) AND status = 'active'`
      )
      .bind(user.shopify_customer_id, Date.now(), user.email)
      .run();
  }

  return json({ ok: true, activated }, 200, cors);
}

export { ensureContextTable };
