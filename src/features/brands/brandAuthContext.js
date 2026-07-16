/**
 * Shared brand auth context: session cookie OR Brand API key → brand row
 */

import { json, getCorsHeaders } from "../../utils/response.js";
import { getBrandDb, brandDbUnavailable, ensureBrandSchema } from "./db.js";
import { requireBrandAuth, authHasScope } from "./rbac.js";

async function loadBrandForAuth(db, auth) {
  if (auth.brandId) {
    return db
      .prepare(`SELECT * FROM brands WHERE id = ? AND status != 'deleted' LIMIT 1`)
      .bind(auth.brandId)
      .first();
  }
  if (!auth.uid) return null;
  return db
    .prepare(
      `SELECT * FROM brands WHERE owner_user_id = ? AND status != 'deleted' ORDER BY created_at ASC LIMIT 1`
    )
    .bind(auth.uid)
    .first();
}

/**
 * @param {{ scope?: string, allowMissingBrand?: boolean, allowSuspended?: boolean }} opts
 * allowMissingBrand: session overview can return needs_onboarding
 */
export async function resolveBrandAuthContext(request, env, opts = {}) {
  const { scope = null, allowMissingBrand = false, allowSuspended = false } = opts;
  const cors = getCorsHeaders(request);

  const auth = await requireBrandAuth(request, env);
  if (!auth) return { error: json({ ok: false, error: "unauthorized" }, 401, cors) };
  if (scope && !authHasScope(auth, scope)) {
    return {
      error: json({ ok: false, error: "insufficient_scope", required: scope }, 403, cors),
    };
  }

  const db = getBrandDb(env);
  if (!db) return { error: json(brandDbUnavailable(), 503, cors) };
  await ensureBrandSchema(env);

  const brand = await loadBrandForAuth(db, auth);

  if (!brand && !allowMissingBrand) {
    return { error: json({ ok: false, error: "brand_required" }, 400, cors) };
  }
  if (brand && !allowSuspended && brand.status === "suspended") {
    return { error: json({ ok: false, error: "brand_suspended" }, 403, cors) };
  }

  return { cors, db, auth, brand };
}
