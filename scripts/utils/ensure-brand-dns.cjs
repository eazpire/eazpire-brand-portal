#!/usr/bin/env node
/**
 * Ensure brand.eazpire.com DNS (proxied AAAA 100::) for Worker routes.
 */
const fs = require("fs");
const path = require("path");

function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim().replace(/\s+#.*$/, "");
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

function loadToken() {
  loadDotEnvFile(path.join(process.cwd(), ".dev.vars"));
  loadDotEnvFile(path.join(process.cwd(), ".env"));
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN;
  const wranglerPath = path.join(process.cwd(), "wrangler.toml");
  if (!fs.existsSync(wranglerPath)) throw new Error("CLOUDFLARE_API_TOKEN missing (env or wrangler.toml)");
  const text = fs.readFileSync(wranglerPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const m = trimmed.match(/^CLOUDFLARE_API_TOKEN\s*=\s*(.+)$/);
    if (!m) continue;
    let val = m[1].replace(/\s+#.*$/, "").trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    return val;
  }
  throw new Error("CLOUDFLARE_API_TOKEN missing (env, .dev.vars, or wrangler.toml)");
}

async function cf(token, url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const data = await res.json();
  if (!data.success) throw new Error(JSON.stringify(data.errors || data));
  return data;
}

async function ensureRecord(token, zoneId, name, type, content) {
  const list = await cf(
    token,
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&type=${type}`
  );
  const existing = (list.result || []).find((r) => r.name === name);
  if (existing) {
    console.log(`✓ DNS exists: ${name} (${existing.type})`);
    return existing;
  }
  const created = await cf(token, `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ type, name, content, proxied: true, ttl: 1 }),
  });
  console.log(`✅ DNS created: ${name} → ${content}`);
  return created.result;
}

async function main() {
  const token = loadToken();
  const zones = await cf(token, "https://api.cloudflare.com/client/v4/zones?name=eazpire.com");
  const zone = zones.result?.[0];
  if (!zone) throw new Error("zone eazpire.com not found");
  console.log(`Zone: ${zone.name} (${zone.id})`);
  await ensureRecord(token, zone.id, "brand.eazpire.com", "AAAA", "100::");
  console.log("Done.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
