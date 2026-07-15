#!/usr/bin/env node
/**
 * Copy JWT_APP_SECRET + RESEND_API_KEY (+ optional BRAND_SECRETS_KEY) to eazpire-brand-portal.
 * Usage: node scripts/brand/ensure-brand-worker-secrets.cjs
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const SECRETS = [
  "JWT_APP_SECRET",
  "RESEND_API_KEY",
  "BRAND_SECRETS_KEY",
  "BRAND_JWT_SECRET",
  // Dual-publish onto eazpire Shopify store
  "SHOPIFY_ACCESS_TOKEN",
  // Link eazpire Account (Customer Account OAuth client; optional if using default/var)
  "SHOPIFY_CUSTOMER_CLIENT_ID",
];

function loadDevVars() {
  const p = path.join(ROOT, ".dev.vars");
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const vars = loadDevVars();
const wrangler = "node scripts/utils/wrangler-with-local-env.cjs";

for (const key of SECRETS) {
  const val = vars[key] || process.env[key];
  if (!val) {
    if (key === "JWT_APP_SECRET" || key === "RESEND_API_KEY") {
      console.warn(`⚠️  ${key} missing — skip (set in .dev.vars)`);
    }
    continue;
  }
  console.log(`Setting ${key} on eazpire-brand-portal…`);
  execSync(`${wrangler} secret put ${key} -c wrangler-brand.toml`, {
    cwd: ROOT,
    input: val,
    stdio: ["pipe", "inherit", "inherit"],
  });
}

console.log("✅ Brand worker secrets done.");
