#!/usr/bin/env node
/**
 * Sync brand portal sources to mirror repo eazpire/eazpire-brand-portal
 * Usage: node scripts/brand/sync-to-brand-repo.js
 *
 * Token: BRAND_REPO_PUSH_TOKEN, PARTNER_REPO_PUSH_TOKEN, ANDROID_REPO_PUSH_TOKEN, GITHUB_TOKEN, GH_TOKEN
 */

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "../..");
const REPO_OWNER = (process.env.BRAND_REPO_OWNER || "eazpire").trim();
const REPO_NAME = "eazpire-brand-portal";

const COPY_PATHS = [
  "brand-ui",
  "brand-portal",
  "brand-static",
  "src/brand-worker.js",
  "src/features/brands",
  "src/utils/response.js",
  "migrations-brand",
  "wrangler-brand.toml",
  "scripts/utils/sync-brand-static.js",
  "scripts/utils/ensure-brand-dns.cjs",
  "scripts/brand",
  "test/brands",
  "docs/deployment/brand-portal.md",
  "package.json",
  "package-lock.json",
  "vitest.config.js",
];

function loadLocalEnv() {
  for (const name of [".dev.vars", ".env", ".env.local"]) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) continue;
    try {
      for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (!m) continue;
        const key = m[1].trim();
        if (process.env[key]) continue;
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    } catch (_) {}
  }
}

function resolvePushToken() {
  for (const key of [
    "BRAND_REPO_PUSH_TOKEN",
    "PARTNER_REPO_PUSH_TOKEN",
    "ANDROID_REPO_PUSH_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
  ]) {
    const value = String(process.env[key] || "").trim();
    if (value) return { value, source: key };
  }
  return null;
}

function failMissingToken() {
  console.error(`
❌ Kein GitHub Push-Token für ${REPO_OWNER}/${REPO_NAME}.

GitHub Actions → Secrets:
  • BRAND_REPO_PUSH_TOKEN — oder PARTNER_REPO_PUSH_TOKEN / ANDROID_REPO_PUSH_TOKEN als Fallback

Lokal: Token in .dev.vars, dann npm run brand:sync
Setup: docs/setup/BRAND_REPO_SETUP.md
`);
  process.exit(1);
}

loadLocalEnv();
const tokenInfo = resolvePushToken();
if (!tokenInfo) failMissingToken();

const TOKEN = tokenInfo.value;
const REPO_URL = `https://x-access-token:${TOKEN}@github.com/${REPO_OWNER}/${REPO_NAME}.git`;
const SYNC_DIR =
  process.env.BRAND_SYNC_DIR ||
  (process.env.GITHUB_ACTIONS === "true"
    ? path.join(os.tmpdir(), `eazpire-brand-portal-sync-${process.env.GITHUB_RUN_ID || Date.now()}`)
    : path.join(ROOT, "eazpire-brand-portal-sync"));

function redact(cmd) {
  return cmd.replace(REPO_URL, `https://***@github.com/${REPO_OWNER}/${REPO_NAME}.git`);
}

function run(cmd, cwd = ROOT) {
  console.log(`🔧 ${redact(cmd)}`);
  execSync(cmd, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function emptyDirExceptGit(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === ".git") continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

function cloneOrUpdateMirror() {
  if (!fs.existsSync(SYNC_DIR)) {
    run(`git clone ${REPO_URL} "${SYNC_DIR}"`);
    return;
  }
  if (!fs.existsSync(path.join(SYNC_DIR, ".git"))) {
    fs.rmSync(SYNC_DIR, { recursive: true, force: true });
    run(`git clone ${REPO_URL} "${SYNC_DIR}"`);
    return;
  }
  run(`git remote set-url origin ${REPO_URL}`, SYNC_DIR);
  run("git fetch origin main", SYNC_DIR);
  run("git checkout main", SYNC_DIR);
  run("git pull origin main --rebase", SYNC_DIR);
}

function main() {
  console.log(`📦 Sync brand portal → ${REPO_OWNER}/${REPO_NAME}`);
  console.log(`   Token: ${tokenInfo.source}\n`);

  execSync("node scripts/utils/sync-brand-static.js", { cwd: ROOT, stdio: "inherit" });

  cloneOrUpdateMirror();
  emptyDirExceptGit(SYNC_DIR);

  for (const rel of COPY_PATHS) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) {
      console.warn(`⚠️  Skip missing: ${rel}`);
      continue;
    }
    copyRecursive(src, path.join(SYNC_DIR, rel));
  }

  fs.writeFileSync(
    path.join(SYNC_DIR, "README.md"),
    `# eazpire-brand-portal\n\nMirror of Brand Portal UI + worker from [eazpire/eazpire](https://github.com/eazpire/eazpire).\n\nLive: https://brand.eazpire.com\n\nDeploy: \`npm run deploy:brand\` (\`wrangler-brand.toml\`)\n\nDocs: \`docs/deployment/brand-portal.md\`\n`
  );

  run('git config user.name "eazpire-bot"', SYNC_DIR);
  run('git config user.email "actions@github.com"', SYNC_DIR);
  run("git add -A", SYNC_DIR);

  let status = "";
  try {
    status = execSync("git status --porcelain", { cwd: SYNC_DIR, encoding: "utf-8" });
  } catch (_) {}

  if (!status.trim()) {
    console.log("ℹ️  No changes to sync.");
    return;
  }

  run(`git commit -m "Sync brand portal from eazpire ${new Date().toISOString().slice(0, 19)}"`, SYNC_DIR);
  run("git push origin main", SYNC_DIR);
  console.log(`\n✅ Synced to ${REPO_OWNER}/${REPO_NAME}`);
}

main();
