# Brand Portal Deployment

Brand Owner portal on a **dedicated Cloudflare Worker** (`eazpire-brand-portal`).

| Host | App | Source |
|------|-----|--------|
| `brand.eazpire.com` | Brand portal SPA | `brand-portal/` + `brand-ui/` |

**Git mirror:** [eazpire/eazpire-brand-portal](https://github.com/eazpire/eazpire-brand-portal) — setup in [BRAND_REPO_SETUP.md](../setup/BRAND_REPO_SETUP.md) (`npm run brand:create-repo`, `npm run brand:sync`).

## Architecture

```
brand-ui/ + brand-portal/
        ↓ sync-brand-static.js
brand-static/ + brandStaticBundle.js
        ↓
src/brand-worker.js  →  wrangler-brand.toml  →  Cloudflare route brand.eazpire.com
        ↓
src/features/brands/  (API, auth, connections, products, team)
migrations-brand/     (D1 brand-db)
```

Phase 1 does **not** include shop brand pages or Creator workspace under brand.

## Build static assets

```bash
npm run sync:brand-static
```

## Deploy brand worker

```bash
# Local (CLOUDFLARE_API_TOKEN in wrangler.toml / .env)
npm run deploy:brand

# DNS once
npm run brand:dns
```

GitHub Action: `.github/workflows/deploy-brand-portal.yml` (push to `main` when brand paths change).

## Worker configuration (`wrangler-brand.toml`)

1. D1 `brand-db` — id in toml; migrations: `migrations-brand/`
2. KV `JOBS` (magic-link poll / OAuth state — same namespace as creator-engine)
3. `[assets]` → `brand-static/` with `run_worker_first` for `/auth/*`
4. Route: `brand.eazpire.com/*`
5. R2 `creator-uploads` for brand logos

### Secrets

Copy JWT/RESEND from creator-engine (recommended):

```bash
npm run brand:secrets:sync
```

Or from `.dev.vars`:

```bash
npm run brand:secrets
```

Or manually:

```bash
wrangler secret put RESEND_API_KEY -c wrangler-brand.toml
wrangler secret put JWT_APP_SECRET -c wrangler-brand.toml
# optional dedicated keys:
wrangler secret put BRAND_JWT_SECRET -c wrangler-brand.toml
wrangler secret put BRAND_SECRETS_KEY -c wrangler-brand.toml
# optional BYO Shopify OAuth for brands' own shops:
wrangler secret put BRAND_SHOPIFY_CLIENT_ID -c wrangler-brand.toml
wrangler secret put BRAND_SHOPIFY_CLIENT_SECRET -c wrangler-brand.toml
# dual-publish to eazpire store + Link eazpire Account:
wrangler secret put SHOPIFY_ACCESS_TOKEN -c wrangler-brand.toml
# optional: SHOPIFY_CUSTOMER_CLIENT_ID (defaults exist in code)
```

### Vars

- `BRAND_PORTAL_URL` — `https://brand.eazpire.com`
- `BRAND_DEV_RETURN_VERIFY_URL` — set `1` only in local/dev to return magic-link URL when Resend is missing
- `PUBLIC_FILE_BASE_URL` — for logo URLs
- `CREATOR_ENGINE_URL` — token exchange for **Link eazpire Account**
- `SHOPIFY_SHOP` / `SHOPIFY_SHOP_ID` — platform shop for dual-publish + Customer Account OAuth

### Apply migrations

```bash
node scripts/utils/wrangler-with-local-env.cjs d1 migrations apply brand-db --remote -c wrangler-brand.toml
```

## Auth

Magic link via Resend (`brand-auth-request` → `/auth/verify` → cookie `brand_session`).

Open signup: first magic-link request creates a `brand_users` row; onboarding creates the brand.

**Link eazpire Account** (Settings): Customer Account OAuth (`/auth/customer/start` → callback) stores `shopify_customer_id` on `brand_users` for Creator brand workspaces. This is **not** the BYO Shopify shop under Connections.

## Connections (BYO)

- **Printify:** API token + shop id (encrypted in D1)
- **Shopify:** Admin API token paste, or OAuth when `BRAND_SHOPIFY_CLIENT_*` is set

## Related code

- `src/brand-worker.js`
- `src/features/brands/`
- `docs/project/development-backlog/infrastructure/IDEA-029-brand-portal.md`
