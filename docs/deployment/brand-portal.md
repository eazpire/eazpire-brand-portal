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

## Brand API (dual-publish onto eazpire)

Portal and external clients use the same `?op=` endpoints on `brand.eazpire.com` (session cookie). Aliases prefer clear names:

| Op | Method | Purpose |
|----|--------|---------|
| `brand-api-overview` / `brand-overview` | GET | Brand summary |
| `brand-api-products` / `brand-products` | GET | Catalog + `dual_publish_status` |
| `brand-products-sync` | POST | Refresh from BYO Printify |
| `brand-api-publish` / `brand-products-publish` / `brand-dual-publish` | POST | Publish selected/unpublished products to **eazpire** Shopify |
| `brand-api-unpublish` / `brand-products-unpublish` / `brand-dual-unpublish` | POST | Draft eazpire listings + mark unpublished |

Publish body: `{ product_id }` or `{ product_ids: [] }` or `{ limit: 20 }` (next unpublished).  
Unpublish body: `{ product_ids: [] }` or `{ all: true }`.

Requires platform secret **`SHOPIFY_ACCESS_TOKEN`** on the brand worker (eazpire store Admin API — not the brand’s BYO shop token). Sync with:

```bash
npm run brand:secrets:sync
# or
wrangler secret put SHOPIFY_ACCESS_TOKEN -c wrangler-brand.toml
```

Also set vars `SHOPIFY_SHOP` / `SHOPIFY_SHOP_ID` (already in `wrangler-brand.toml`).

Tags / metafields on eazpire listings: `eaz-brand:{handle}`, `custom.brand_handle`, `custom.brand_name` (not `custom.brand`).

Suspended brands (`status = suspended`) cannot publish/unpublish via the portal API.

## Admin Brands (`admin.eazpire.com/brands`)

Partner-portals worker binds the same `BRAND_DB` and exposes:

- `admin-brand-list` / `admin-brand-get`
- `admin-brand-suspend` / `admin-brand-activate`
- `admin-brand-force-unpublish` (drafts eazpire listings; needs `SHOPIFY_ACCESS_TOKEN` on partner worker)

Connection health is returned **without secrets**. App drawer: Partner · Creations · Brands.

## Connections (BYO)

- **Printify:** API token + shop id (encrypted in D1)
- **Shopify:** Admin API token paste, or OAuth when `BRAND_SHOPIFY_CLIENT_*` is set

## Related code

- `src/brand-worker.js`
- `src/features/brands/` (incl. `brandDualPublish.js`, `adminBrandOps.js`)
- `admin-brands-portal/`
- `docs/project/development-backlog/infrastructure/IDEA-029-brand-portal.md`
