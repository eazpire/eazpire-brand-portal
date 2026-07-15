#!/usr/bin/env node
/**
 * Copy RESEND + JWT secrets from creator-engine to eazpire-brand-portal
 * via internal-sync-partner-worker-secrets (supports script_name override).
 *
 * Usage: node scripts/brand/sync-secrets-via-creator.cjs
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "../..");
const WRANGLER = path.join(ROOT, "wrangler.toml");
const DISPATCH_URL =
  process.env.CREATOR_DISPATCH_URL ||
  "https://creator-engine.eazpire.workers.dev/apps/creator-dispatch";

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
  if (!fs.existsSync(WRANGLER)) return "";
  const text = fs.readFileSync(WRANGLER, "utf8");
  const re = new RegExp(`^${name}\\s*=\\s*(.+)$`, "m");
  const m = text.match(re);
  if (!m) return "";
  let val = m[1].replace(/\s+#.*$/, "").trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  return val;
}

function loadCfAccountId() {
  const fromToml = readTomlVar("CLOUDFLARE_ACCOUNT_ID");
  if (fromToml) return fromToml;
  const envFiles = { ...loadDotEnv(path.join(ROOT, ".dev.vars")), ...loadDotEnv(path.join(ROOT, ".env")) };
  if (envFiles.CLOUDFLARE_ACCOUNT_ID) return envFiles.CLOUDFLARE_ACCOUNT_ID;

  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts/utils/wrangler-with-local-env.cjs"), "whoami"],
    { cwd: ROOT, encoding: "utf8" }
  );
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  const m = out.match(/Account ID\s*\│\s*([a-f0-9]{32})/i) || out.match(/([a-f0-9]{32})/);
  return m ? m[1] : "";
}

async function main() {
  const envFiles = { ...loadDotEnv(path.join(ROOT, ".dev.vars")), ...loadDotEnv(path.join(ROOT, ".env")) };
  const cfToken =
    readTomlVar("CLOUDFLARE_API_TOKEN") ||
    process.env.CLOUDFLARE_API_TOKEN ||
    envFiles.CLOUDFLARE_API_TOKEN ||
    "";
  const adminKey =
    readTomlVar("INTERNAL_SHARED_SECRET") ||
    process.env.INTERNAL_SHARED_SECRET ||
    envFiles.INTERNAL_SHARED_SECRET ||
    "";
  const accountId = loadCfAccountId();

  if (!cfToken) {
    console.error("❌ CLOUDFLARE_API_TOKEN fehlt.");
    process.exit(1);
  }
  if (!adminKey) {
    console.error("❌ INTERNAL_SHARED_SECRET fehlt.");
    process.exit(1);
  }
  if (!accountId) {
    console.error("❌ Cloudflare Account ID nicht ermittelbar.");
    process.exit(1);
  }

  const url = `${DISPATCH_URL}?op=internal-sync-partner-worker-secrets`;
  console.log("🔄 Sync brand-worker secrets via creator-engine…");

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-EAZ-ADMIN-KEY": adminKey,
    },
    body: JSON.stringify({
      account_id: accountId,
      cloudflare_api_token: cfToken,
      script_name: "eazpire-brand-portal",
    }),
  });

  let data = {};
  try {
    data = await resp.json();
  } catch {
    console.error("❌ Ungültige Antwort:", resp.status);
    process.exit(1);
  }

  if (!resp.ok || !data.ok) {
    console.error("❌ Sync fehlgeschlagen:", JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log("✅ Brand-worker secrets synced:", (data.synced || []).join(", "));
  if (data.skipped?.length) console.log("⚠️  Skipped:", data.skipped.join(", "));
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
