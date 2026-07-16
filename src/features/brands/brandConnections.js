/**
 * BYO Printify + Shopify connections for brands
 */

import { json, getCorsHeaders } from "../../utils/response.js";
import { getBrandDb, brandDbUnavailable, newId, ensureBrandSchema } from "./db.js";
import { requireBrandSession, BRAND_API_SCOPES } from "./rbac.js";
import { encryptSecret, decryptSecret, maskSecret } from "./secrets.js";
import { getOwnedBrand } from "./brandProfile.js";
import { resolveBrandAuthContext } from "./brandAuthContext.js";

function parseMeta(row) {
  if (!row?.meta_json) return {};
  try {
    return JSON.parse(row.meta_json) || {};
  } catch {
    return {};
  }
}

async function upsertConnection(db, { brandId, type, status, meta, ciphertext, lastOkAt }) {
  const now = Date.now();
  const existing = await db
    .prepare(`SELECT id FROM brand_connections WHERE brand_id = ? AND type = ?`)
    .bind(brandId, type)
    .first();

  if (existing) {
    await db
      .prepare(
        `UPDATE brand_connections
         SET status = ?, meta_json = ?, secret_ciphertext = COALESCE(?, secret_ciphertext),
             last_ok_at = ?, connected_at = COALESCE(connected_at, ?), updated_at = ?
         WHERE id = ?`
      )
      .bind(
        status,
        JSON.stringify(meta || {}),
        ciphertext || null,
        lastOkAt || null,
        status === "connected" ? now : null,
        now,
        existing.id
      )
      .run();
    return existing.id;
  }

  const id = newId("bc");
  await db
    .prepare(
      `INSERT INTO brand_connections
        (id, brand_id, type, status, meta_json, secret_ciphertext, last_ok_at, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      brandId,
      type,
      status,
      JSON.stringify(meta || {}),
      ciphertext || null,
      lastOkAt || null,
      status === "connected" ? now : null,
      now
    )
    .run();
  return id;
}

async function printifyFetch(token, path) {
  const res = await fetch(`https://api.printify.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "eazpire-brand-portal",
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, data };
}

async function shopifyFetch(shop, token, path) {
  const domain = String(shop || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const res = await fetch(`https://${domain}/admin/api/2024-10${path}`, {
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, data };
}

/** Connection status only — never returns secrets (session or API key with connections:read) */
export async function handleBrandConnectionsList(request, env) {
  const resolved = await resolveBrandAuthContext(request, env, {
    scope: BRAND_API_SCOPES.CONNECTIONS_READ,
    allowSuspended: true,
  });
  if (resolved.error) return resolved.error;
  const { cors, db, brand } = resolved;

  const rows = await db
    .prepare(
      `SELECT id, type, status, meta_json, last_ok_at, connected_at, updated_at,
              CASE WHEN secret_ciphertext IS NOT NULL AND secret_ciphertext != '' THEN 1 ELSE 0 END AS has_secret
       FROM brand_connections WHERE brand_id = ?`
    )
    .bind(brand.id)
    .all();

  const connections = (rows?.results || []).map((r) => {
    const meta = parseMeta(r);
    return {
      type: r.type,
      status: r.status,
      last_ok_at: r.last_ok_at,
      connected_at: r.connected_at,
      has_secret: !!r.has_secret,
      shop_id: meta.shop_id || null,
      shop_name: meta.shop_name || null,
      shop_domain: meta.shop_domain || null,
      token_hint: meta.token_hint || null,
    };
  });

  return json({ ok: true, connections }, 200, cors);
}

export async function handleBrandPrintifyConnect(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);
  const session = await requireBrandSession(request, env);
  if (!session) return json({ ok: false, error: "unauthorized" }, 401, cors);
  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const brand = await getOwnedBrand(db, session.uid);
  if (!brand) return json({ ok: false, error: "brand_required" }, 400, cors);

  const body = await request.json().catch(() => ({}));
  const token = String(body.api_token || body.token || "").trim();
  let shopId = body.shop_id != null ? String(body.shop_id).trim() : "";
  if (!token) return json({ ok: false, error: "api_token_required" }, 400, cors);

  const shopsRes = await printifyFetch(token, "/shops.json");
  if (!shopsRes.ok) {
    return json(
      { ok: false, error: "printify_auth_failed", detail: shopsRes.data },
      400,
      cors
    );
  }

  const shops = Array.isArray(shopsRes.data) ? shopsRes.data : shopsRes.data?.data || [];
  if (!shopId && shops.length === 1) shopId = String(shops[0].id);
  if (!shopId) {
    return json(
      {
        ok: true,
        needs_shop_selection: true,
        shops: shops.map((s) => ({ id: String(s.id), title: s.title || s.id })),
      },
      200,
      cors
    );
  }

  const shop = shops.find((s) => String(s.id) === String(shopId));
  if (!shop && shops.length) {
    return json({ ok: false, error: "shop_not_found", shops }, 400, cors);
  }

  const ciphertext = await encryptSecret(env, JSON.stringify({ api_token: token, shop_id: shopId }));
  const now = Date.now();
  await upsertConnection(db, {
    brandId: brand.id,
    type: "printify",
    status: "connected",
    ciphertext,
    lastOkAt: now,
    meta: {
      shop_id: shopId,
      shop_name: shop?.title || null,
      token_hint: maskSecret(token),
      shops_count: shops.length,
    },
  });

  return json(
    {
      ok: true,
      connection: {
        type: "printify",
        status: "connected",
        shop_id: shopId,
        shop_name: shop?.title || null,
        token_hint: maskSecret(token),
      },
    },
    200,
    cors
  );
}

export async function handleBrandShopifyConnect(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);
  const session = await requireBrandSession(request, env);
  if (!session) return json({ ok: false, error: "unauthorized" }, 401, cors);
  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const brand = await getOwnedBrand(db, session.uid);
  if (!brand) return json({ ok: false, error: "brand_required" }, 400, cors);

  const body = await request.json().catch(() => ({}));
  let shop = String(body.shop || body.shop_domain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const token = String(body.access_token || body.token || "").trim();

  if (!shop || !token) {
    return json({ ok: false, error: "shop_and_token_required" }, 400, cors);
  }
  if (!shop.includes(".")) shop = `${shop}.myshopify.com`;

  const ping = await shopifyFetch(shop, token, "/shop.json");
  if (!ping.ok) {
    return json({ ok: false, error: "shopify_auth_failed", detail: ping.data }, 400, cors);
  }

  const shopName = ping.data?.shop?.name || shop;
  const ciphertext = await encryptSecret(env, JSON.stringify({ access_token: token, shop_domain: shop }));
  const now = Date.now();
  await upsertConnection(db, {
    brandId: brand.id,
    type: "shopify",
    status: "connected",
    ciphertext,
    lastOkAt: now,
    meta: {
      shop_domain: shop,
      shop_name: shopName,
      token_hint: maskSecret(token),
      product_count: null,
    },
  });

  // Optional product count
  const countRes = await shopifyFetch(shop, token, "/products/count.json");
  if (countRes.ok) {
    await upsertConnection(db, {
      brandId: brand.id,
      type: "shopify",
      status: "connected",
      lastOkAt: now,
      meta: {
        shop_domain: shop,
        shop_name: shopName,
        token_hint: maskSecret(token),
        product_count: countRes.data?.count ?? null,
      },
    });
  }

  return json(
    {
      ok: true,
      connection: {
        type: "shopify",
        status: "connected",
        shop_domain: shop,
        shop_name: shopName,
        token_hint: maskSecret(token),
      },
    },
    200,
    cors
  );
}

/** Start Shopify OAuth install URL for brand's shop (optional path). */
export async function handleBrandShopifyOAuthStart(request, env) {
  const cors = getCorsHeaders(request);
  const session = await requireBrandSession(request, env);
  if (!session) return json({ ok: false, error: "unauthorized" }, 401, cors);

  const url = new URL(request.url);
  let shop = String(url.searchParams.get("shop") || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!shop) return json({ ok: false, error: "shop_required" }, 400, cors);
  if (!shop.includes(".")) shop = `${shop}.myshopify.com`;

  const clientId = String(env.BRAND_SHOPIFY_CLIENT_ID || env.SHOPIFY_CLIENT_ID || "").trim();
  if (!clientId) {
    return json(
      {
        ok: false,
        error: "oauth_not_configured",
        message: "Use Admin API token paste for now, or set BRAND_SHOPIFY_CLIENT_ID.",
      },
      400,
      cors
    );
  }

  const redirectUri = `${String(env.BRAND_PORTAL_URL || "https://brand.eazpire.com").replace(/\/$/, "")}/auth/shopify/callback`;
  const scopes =
    String(env.BRAND_SHOPIFY_SCOPES || "").trim() ||
    "read_products,write_products,read_orders";
  const state = `${session.uid}.${Date.now()}`;
  if (env.JOBS?.put) {
    await env.JOBS.put(`brand_shopify_oauth:${state}`, JSON.stringify({ uid: session.uid, shop }), {
      expirationTtl: 600,
    });
  }

  const authUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);

  return json({ ok: true, authorize_url: authUrl.toString() }, 200, cors);
}

export async function handleBrandShopifyOAuthCallback(request, env) {
  const cors = getCorsHeaders(request);
  const url = new URL(request.url);
  const shop = String(url.searchParams.get("shop") || "").trim().toLowerCase();
  const code = String(url.searchParams.get("code") || "").trim();
  const state = String(url.searchParams.get("state") || "").trim();
  const base = String(env.BRAND_PORTAL_URL || "https://brand.eazpire.com").replace(/\/$/, "");

  if (!shop || !code || !state) {
    return Response.redirect(`${base}/connections?shopify_error=missing_params`, 302);
  }

  let stateRow = null;
  if (env.JOBS?.get) {
    const raw = await env.JOBS.get(`brand_shopify_oauth:${state}`);
    try {
      stateRow = raw ? JSON.parse(raw) : null;
    } catch {
      stateRow = null;
    }
  }
  if (!stateRow?.uid) {
    return Response.redirect(`${base}/connections?shopify_error=invalid_state`, 302);
  }

  const clientId = String(env.BRAND_SHOPIFY_CLIENT_ID || env.SHOPIFY_CLIENT_ID || "").trim();
  const clientSecret = String(env.BRAND_SHOPIFY_CLIENT_SECRET || env.SHOPIFY_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    return Response.redirect(`${base}/connections?shopify_error=oauth_not_configured`, 302);
  }

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData.access_token) {
    return Response.redirect(`${base}/connections?shopify_error=token_exchange_failed`, 302);
  }

  const db = getBrandDb(env);
  if (!db) return Response.redirect(`${base}/connections?shopify_error=db`, 302);
  await ensureBrandSchema(env);

  const brand = await getOwnedBrand(db, stateRow.uid);
  if (!brand) return Response.redirect(`${base}/?onboarding=1`, 302);

  const ciphertext = await encryptSecret(
    env,
    JSON.stringify({ access_token: tokenData.access_token, shop_domain: shop })
  );
  const now = Date.now();
  await upsertConnection(db, {
    brandId: brand.id,
    type: "shopify",
    status: "connected",
    ciphertext,
    lastOkAt: now,
    meta: {
      shop_domain: shop,
      shop_name: shop,
      token_hint: maskSecret(tokenData.access_token),
      via: "oauth",
      scope: tokenData.scope || null,
    },
  });

  await env.JOBS?.delete?.(`brand_shopify_oauth:${state}`).catch(() => {});
  return Response.redirect(`${base}/connections?shopify=connected`, 302);
}

export async function handleBrandConnectionPing(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);
  const session = await requireBrandSession(request, env);
  if (!session) return json({ ok: false, error: "unauthorized" }, 401, cors);
  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const brand = await getOwnedBrand(db, session.uid);
  if (!brand) return json({ ok: false, error: "brand_required" }, 400, cors);

  const body = await request.json().catch(() => ({}));
  const type = String(body.type || "").trim();
  if (!["printify", "shopify"].includes(type)) {
    return json({ ok: false, error: "invalid_type" }, 400, cors);
  }

  const row = await db
    .prepare(`SELECT * FROM brand_connections WHERE brand_id = ? AND type = ?`)
    .bind(brand.id, type)
    .first();
  if (!row?.secret_ciphertext) {
    return json({ ok: false, error: "not_connected" }, 400, cors);
  }

  let secret;
  try {
    secret = JSON.parse(await decryptSecret(env, row.secret_ciphertext));
  } catch {
    return json({ ok: false, error: "decrypt_failed" }, 500, cors);
  }

  const meta = parseMeta(row);
  let ok = false;
  let detail = null;

  if (type === "printify") {
    const res = await printifyFetch(secret.api_token, "/shops.json");
    ok = res.ok;
    detail = { shops: res.ok ? (Array.isArray(res.data) ? res.data.length : 0) : res.status };
  } else {
    const res = await shopifyFetch(secret.shop_domain || meta.shop_domain, secret.access_token, "/shop.json");
    ok = res.ok;
    detail = { shop_name: res.data?.shop?.name || null };
  }

  const now = Date.now();
  await db
    .prepare(
      `UPDATE brand_connections SET status = ?, last_ok_at = ?, updated_at = ? WHERE id = ?`
    )
    .bind(ok ? "connected" : "error", ok ? now : row.last_ok_at, now, row.id)
    .run();

  return json({ ok: true, healthy: ok, detail }, 200, cors);
}

export async function handleBrandConnectionDisconnect(request, env) {
  const cors = getCorsHeaders(request);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);
  const session = await requireBrandSession(request, env);
  if (!session) return json({ ok: false, error: "unauthorized" }, 401, cors);
  const db = getBrandDb(env);
  if (!db) return json(brandDbUnavailable(), 503, cors);
  await ensureBrandSchema(env);

  const brand = await getOwnedBrand(db, session.uid);
  if (!brand) return json({ ok: false, error: "brand_required" }, 400, cors);

  const body = await request.json().catch(() => ({}));
  const type = String(body.type || "").trim();
  if (!["printify", "shopify"].includes(type)) {
    return json({ ok: false, error: "invalid_type" }, 400, cors);
  }

  await db
    .prepare(
      `UPDATE brand_connections
       SET status = 'disconnected', secret_ciphertext = NULL, meta_json = '{}', last_ok_at = NULL, updated_at = ?
       WHERE brand_id = ? AND type = ?`
    )
    .bind(Date.now(), brand.id, type)
    .run();

  return json({ ok: true }, 200, cors);
}

/** Decrypt Printify credentials for product sync (internal). */
export async function getBrandPrintifyCredentials(env, brandId) {
  const db = getBrandDb(env);
  if (!db) return null;
  const row = await db
    .prepare(`SELECT * FROM brand_connections WHERE brand_id = ? AND type = 'printify' AND status = 'connected'`)
    .bind(brandId)
    .first();
  if (!row?.secret_ciphertext) return null;
  try {
    const secret = JSON.parse(await decryptSecret(env, row.secret_ciphertext));
    const meta = parseMeta(row);
    return {
      api_token: secret.api_token,
      shop_id: String(secret.shop_id || meta.shop_id || ""),
    };
  } catch {
    return null;
  }
}
