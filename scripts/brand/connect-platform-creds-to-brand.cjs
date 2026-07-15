#!/usr/bin/env node
/**
 * Attach platform Printify + Shopify credentials (from .dev.vars / wrangler.toml)
 * to a brand as encrypted BYO connections (same AES-GCM path as brandConnections.js).
 *
 * Usage:
 *   node scripts/brand/connect-platform-creds-to-brand.cjs --handle=govgn
 *
 * Security: does not print full tokens; does not commit secrets.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { applyWranglerEnvToProcess } = require("../utils/load-wrangler-env.cjs");
const { webcrypto } = require("crypto");

const ROOT = path.resolve(__dirname, "../..");
const subtle = webcrypto.subtle;

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function readTomlVar(name) {
  const text = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8");
  const re = new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, "m");
  const m = text.match(re);
  return m ? m[1] : "";
}

function maskSecret(value) {
  const s = String(value || "");
  if (s.length <= 8) return "••••••••";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

function d1Query(sql) {
  applyWranglerEnvToProcess();
  const wranglerBin = path.join(ROOT, "node_modules/wrangler/bin/wrangler.js");
  const r = spawnSync(
    process.execPath,
    [
      wranglerBin,
      "d1",
      "execute",
      "brand-db",
      "--remote",
      "-c",
      "wrangler-brand.toml",
      "--command",
      sql,
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8", env: process.env }
  );
  if (r.status !== 0) {
    throw new Error(`D1 query failed: ${r.stderr || r.stdout || r.status}`);
  }
  const data = JSON.parse(r.stdout || "[]");
  return data[0]?.results || [];
}

function wranglerSecretPut(name, value) {
  applyWranglerEnvToProcess();
  const wranglerBin = path.join(ROOT, "node_modules/wrangler/bin/wrangler.js");
  const r = spawnSync(
    process.execPath,
    [wranglerBin, "secret", "put", name, "-c", "wrangler-brand.toml"],
    { cwd: ROOT, encoding: "utf8", env: process.env, input: value }
  );
  if (r.status !== 0) {
    throw new Error(`secret put ${name} failed: ${r.stderr || r.stdout}`);
  }
}

function ensureBrandSecretsKeyInDevVars(key) {
  const p = path.join(ROOT, ".dev.vars");
  let text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  if (/^BRAND_SECRETS_KEY=/m.test(text)) {
    text = text.replace(/^BRAND_SECRETS_KEY=.*$/m, `BRAND_SECRETS_KEY=${key}`);
  } else {
    text = text.trimEnd() + `\n\n# Brand portal BYO credential encryption (do not commit)\nBRAND_SECRETS_KEY=${key}\n`;
  }
  fs.writeFileSync(p, text, "utf8");
}

async function deriveKey(raw) {
  const hash = await subtle.digest("SHA-256", new TextEncoder().encode(String(raw || "").trim()));
  return subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptSecret(rawKey, plaintext) {
  const key = await deriveKey(rawKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(String(plaintext || ""))
  );
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return Buffer.from(combined).toString("base64");
}

async function printifyShops(token) {
  const res = await fetch("https://api.printify.com/v1/shops.json", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "eazpire-brand-connect-script",
    },
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function shopifyShop(shop, token) {
  const domain = String(shop || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const res = await fetch(`https://${domain}/admin/api/2024-10/shop.json`, {
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

async function upsertConnection({ brandId, type, status, meta, ciphertext, lastOkAt }) {
  const now = Date.now();
  const existing = d1Query(
    `SELECT id FROM brand_connections WHERE brand_id = '${sqlEscape(brandId)}' AND type = '${sqlEscape(type)}' LIMIT 1`
  );
  const metaJson = sqlEscape(JSON.stringify(meta || {}));
  const cipherSql = sqlEscape(ciphertext);

  if (existing[0]?.id) {
    d1Query(
      `UPDATE brand_connections
       SET status = '${sqlEscape(status)}',
           meta_json = '${metaJson}',
           secret_ciphertext = '${cipherSql}',
           last_ok_at = ${lastOkAt || "NULL"},
           connected_at = COALESCE(connected_at, ${now}),
           updated_at = ${now}
       WHERE id = '${sqlEscape(existing[0].id)}'`
    );
    return existing[0].id;
  }

  const id = newId("bc");
  d1Query(
    `INSERT INTO brand_connections
      (id, brand_id, type, status, meta_json, secret_ciphertext, last_ok_at, connected_at, updated_at)
     VALUES (
       '${sqlEscape(id)}',
       '${sqlEscape(brandId)}',
       '${sqlEscape(type)}',
       '${sqlEscape(status)}',
       '${metaJson}',
       '${cipherSql}',
       ${lastOkAt || "NULL"},
       ${now},
       ${now}
     )`
  );
  return id;
}

async function main() {
  const handle = (argValue("handle") || "govgn").toLowerCase();
  const envFiles = {
    ...loadDotEnv(path.join(ROOT, ".dev.vars")),
    ...loadDotEnv(path.join(ROOT, ".env")),
  };

  const printifyToken = envFiles.PRINTIFY_API_KEY || process.env.PRINTIFY_API_KEY || "";
  const printifyShopId =
    envFiles.PRINTIFY_SHOP_ID || readTomlVar("PRINTIFY_SHOP_ID") || process.env.PRINTIFY_SHOP_ID || "";
  const shopifyToken = envFiles.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || "";
  const shopifyShopDomain =
    envFiles.SHOPIFY_SHOP || readTomlVar("SHOPIFY_SHOP") || process.env.SHOPIFY_SHOP || "allyoucanpink.myshopify.com";

  if (!printifyToken) throw new Error("PRINTIFY_API_KEY missing in .dev.vars");
  if (!shopifyToken) throw new Error("SHOPIFY_ACCESS_TOKEN missing in .dev.vars");

  let brandSecretsKey = envFiles.BRAND_SECRETS_KEY || process.env.BRAND_SECRETS_KEY || "";
  let keyCreated = false;
  if (!brandSecretsKey || brandSecretsKey.includes("your_") || brandSecretsKey.length < 24) {
    brandSecretsKey = crypto.randomBytes(32).toString("hex");
    keyCreated = true;
    console.log("Generating BRAND_SECRETS_KEY and setting on brand worker…");
    wranglerSecretPut("BRAND_SECRETS_KEY", brandSecretsKey);
    ensureBrandSecretsKeyInDevVars(brandSecretsKey);
    console.log("BRAND_SECRETS_KEY set on eazpire-brand-portal + .dev.vars (gitignored).");
  } else {
    // Ensure worker has the same key (idempotent put)
    console.log("Ensuring BRAND_SECRETS_KEY is on brand worker…");
    wranglerSecretPut("BRAND_SECRETS_KEY", brandSecretsKey);
  }

  const brands = d1Query(
    `SELECT b.id, b.name, b.handle, b.status, u.email
     FROM brands b
     LEFT JOIN brand_users u ON u.id = b.owner_user_id
     WHERE lower(b.handle) = '${sqlEscape(handle)}'
     LIMIT 1`
  );
  if (!brands[0]) throw new Error(`Brand handle not found: ${handle}`);
  const brand = brands[0];
  console.log(`Brand: ${brand.name} (${brand.handle}) id=${brand.id} owner=${brand.email || "?"}`);

  // --- Printify ---
  console.log("Validating Printify…");
  const shopsRes = await printifyShops(printifyToken);
  if (!shopsRes.ok) {
    throw new Error(`Printify auth failed (HTTP ${shopsRes.status})`);
  }
  const shops = Array.isArray(shopsRes.data) ? shopsRes.data : shopsRes.data?.data || [];
  let shopId = String(printifyShopId || "").trim();
  if (!shopId && shops.length === 1) shopId = String(shops[0].id);
  if (!shopId) {
    console.log(
      "Printify shops:",
      shops.map((s) => ({ id: String(s.id), title: s.title })).slice(0, 20)
    );
    throw new Error("PRINTIFY_SHOP_ID required (multiple shops)");
  }
  const shop = shops.find((s) => String(s.id) === String(shopId));
  if (!shop && shops.length) {
    throw new Error(`Printify shop_id ${shopId} not in account shops`);
  }
  const now = Date.now();
  const printifyCipher = await encryptSecret(
    brandSecretsKey,
    JSON.stringify({ api_token: printifyToken, shop_id: shopId })
  );
  await upsertConnection({
    brandId: brand.id,
    type: "printify",
    status: "connected",
    ciphertext: printifyCipher,
    lastOkAt: now,
    meta: {
      shop_id: shopId,
      shop_name: shop?.title || null,
      token_hint: maskSecret(printifyToken),
      shops_count: shops.length,
      source: "platform_creds_script",
    },
  });
  console.log(
    `Printify connected: shop_id=${shopId} shop_name=${shop?.title || "?"} token=${maskSecret(printifyToken)}`
  );

  // --- Shopify ---
  console.log("Validating Shopify…");
  const shopDomain = shopifyShopDomain.includes(".")
    ? shopifyShopDomain
    : `${shopifyShopDomain}.myshopify.com`;
  const ping = await shopifyShop(shopDomain, shopifyToken);
  if (!ping.ok) {
    throw new Error(`Shopify auth failed (HTTP ${ping.status})`);
  }
  const shopName = ping.data?.shop?.name || shopDomain;
  const shopifyCipher = await encryptSecret(
    brandSecretsKey,
    JSON.stringify({ access_token: shopifyToken, shop_domain: shopDomain })
  );
  let productCount = null;
  try {
    const countRes = await fetch(`https://${shopDomain}/admin/api/2024-10/products/count.json`, {
      headers: { "X-Shopify-Access-Token": shopifyToken },
    });
    if (countRes.ok) {
      const cj = await countRes.json();
      productCount = cj.count ?? null;
    }
  } catch {
    /* optional */
  }
  await upsertConnection({
    brandId: brand.id,
    type: "shopify",
    status: "connected",
    ciphertext: shopifyCipher,
    lastOkAt: now,
    meta: {
      shop_domain: shopDomain,
      shop_name: shopName,
      token_hint: maskSecret(shopifyToken),
      product_count: productCount,
      source: "platform_creds_script",
    },
  });
  console.log(
    `Shopify connected: shop=${shopDomain} name=${shopName} products=${productCount} token=${maskSecret(shopifyToken)}`
  );

  // Verify rows
  const rows = d1Query(
    `SELECT type, status, last_ok_at,
            CASE WHEN secret_ciphertext IS NOT NULL AND length(secret_ciphertext) > 0 THEN 1 ELSE 0 END AS has_secret,
            meta_json
     FROM brand_connections
     WHERE brand_id = '${sqlEscape(brand.id)}'`
  );

  console.log("\n=== Verification (redacted) ===");
  console.log(
    JSON.stringify(
      {
        brand_id: brand.id,
        handle: brand.handle,
        name: brand.name,
        owner_email: brand.email || null,
        brand_secrets_key_created: keyCreated,
        connections: rows.map((r) => ({
          type: r.type,
          status: r.status,
          has_secret: r.has_secret,
          last_ok_at: r.last_ok_at,
          meta: (() => {
            try {
              return JSON.parse(r.meta_json || "{}");
            } catch {
              return {};
            }
          })(),
        })),
        live_ping: {
          printify_ok: shopsRes.ok,
          printify_shop_selected: Boolean(shopId),
          shopify_ok: ping.ok,
          shopify_shop_domain: shopDomain,
        },
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error("❌", e.message || e);
  process.exit(1);
});
