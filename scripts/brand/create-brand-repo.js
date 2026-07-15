#!/usr/bin/env node
/**
 * Creates eazpire-brand-portal via GitHub API.
 * Token: BRAND_REPO_PUSH_TOKEN, PARTNER_REPO_PUSH_TOKEN, ANDROID_REPO_PUSH_TOKEN, GITHUB_TOKEN, GH_TOKEN
 *
 * npm run brand:create-repo
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "../..");

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

loadLocalEnv();

const token = (
  process.env.BRAND_REPO_PUSH_TOKEN ||
  process.env.PARTNER_REPO_PUSH_TOKEN ||
  process.env.ANDROID_REPO_PUSH_TOKEN ||
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  ""
).trim();

if (!token) {
  console.error("❌ Kein GitHub-Token (BRAND_REPO_PUSH_TOKEN / PARTNER_REPO_PUSH_TOKEN / GITHUB_TOKEN).");
  console.error("   Setup: docs/setup/BRAND_REPO_SETUP.md");
  process.exit(1);
}

async function createRepo() {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const body = {
    name: "eazpire-brand-portal",
    description: "Eazpire Brand Portal mirror (from eazpire/eazpire)",
    private: false,
    auto_init: true,
  };

  let res = await fetch("https://api.github.com/orgs/eazpire/repos", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (res.status === 201) {
    console.log("✅ Repo eazpire/eazpire-brand-portal erstellt.");
    return;
  }

  const data = await res.json().catch(() => ({}));
  if (res.status === 422 && data.errors?.[0]?.message?.includes("name already exists")) {
    console.log("ℹ️  Repo existiert bereits.");
    return;
  }

  if (res.status === 404) {
    console.log("ℹ️  Kein Org-Zugriff — erstelle unter User-Account…");
    res = await fetch("https://api.github.com/user/repos", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (res.status === 201) {
      const user = await fetch("https://api.github.com/user", { headers }).then((r) => r.json());
      console.log(`✅ Repo ${user.login}/eazpire-brand-portal erstellt.`);
      console.log(`   Setze BRAND_REPO_OWNER=${user.login} für Sync-URL.`);
      return;
    }
  }

  console.error("❌ Fehler:", res.status, data.message || JSON.stringify(data));
  if (res.status === 403) console.error("   Tipp: Token braucht repo-Scope und ggf. SSO für Org eazpire.");
  process.exit(1);
}

createRepo();
