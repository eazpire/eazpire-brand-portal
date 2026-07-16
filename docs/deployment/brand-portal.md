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

### Three distinct auth concepts (do not conflate)

| Concept | What it is | Where |
|---------|------------|--------|
| **BYO Printify / Shopify** | Brand’s own print shop credentials | Connections |
| **Link eazpire Account** | eazpire shopper/customer identity for Creator design access | Settings → Customer Account OAuth |
| **eazpire API keys** | Machine access to Brand API (`eaz_brand_…`) | Settings → eazpire API keys |

**Link eazpire Account** (Settings): Customer Account OAuth (`/auth/customer/start` → callback) stores `shopify_customer_id` on `brand_users` so Creator brand workspaces work. Required before creators can put designs on that brand’s products. This is **not** the BYO Shopify shop under Connections and **not** an API key.

**eazpire API keys** (Settings): Create / list / revoke. Raw key is shown **once** on create (SHA-256 hash stored). Use `Authorization: Bearer eaz_brand_…` or header `X-Eazpire-Brand-Key`. Portal UI keeps using the session cookie; the same handlers accept either.

### Dual-publish vs Link eazpire Account

- **Catalog dual-publish / unpublish / sync / overview / team read** — allowed with a valid Brand API key (scoped to `brand_id`) **or** portal session. Linked eazpire Account is **not** required for these.
- **Creator design / memberships / workspace** — require linked customer identity (portal session + Link eazpire Account). API key calls to `brand-api-memberships` return `eazpire_account_link_required`.

## Brand API (dual-publish onto eazpire)

Portal and external clients use the same handlers on `brand.eazpire.com`. Prefer versioned paths; `?op=` aliases still work.

**Public docs (for brand owners / integrators):** [https://brand.eazpire.com/docs](https://brand.eazpire.com/docs) (also `/api-docs`). Linked from Settings → eazpire API keys.

### Versioned paths (`/api/v1/…`)

| Path | Method | Purpose | Scope |
|------|--------|---------|-------|
| `/api/v1/overview` | GET | Brand profile + stats | `overview:read` |
| `/api/v1/brand` | GET | Brand profile only | `brand:read` |
| `/api/v1/brand` | POST | Update name / tagline / about / handle | `brand:write` |
| `/api/v1/connections` | GET | Connection status (no secrets) | `connections:read` |
| `/api/v1/products` | GET | Catalog + `dual_publish_status` | `products:read` |
| `/api/v1/products/{id}` | GET | Single product | `products:read` |
| `/api/v1/products/{id}` | POST | Update local title / status | `products:write` |
| `/api/v1/products/sync` | POST | Refresh from BYO Printify | `products:sync` |
| `/api/v1/products/publish` | POST | Publish to **eazpire** Shopify | `products:publish` |
| `/api/v1/products/unpublish` | POST | Draft eazpire listings + mark unpublished | `products:publish` |
| `/api/v1/team` | GET | Team members (read) | `team:read` |
| `/api/v1/team/invite` | POST | Invite by email | `team:invite` |
| `/api/v1/team/update` | POST | Update publish_mode / status | `team:write` |
| `/api/v1/team/revoke` | POST | Revoke member | `team:write` |
| `/api/v1/memberships` | GET | Personal memberships (session only) | — |
| `/api/v1/keys` | GET | List API keys (session only) | — |
| `/api/v1/webhooks` | GET | List webhooks (no secret) | `webhooks:read` |
| `/api/v1/webhooks` | POST | Create webhook (returns signing secret once) | `webhooks:write` |
| `/api/v1/webhooks/{id}` | POST | Update url / events / status | `webhooks:write` |
| `/api/v1/webhooks/{id}/revoke` | POST | Disable (or `{ hard: true }` delete) | `webhooks:write` |
| `/api/v1/webhooks/{id}/test` | POST | Send `webhook.ping` | `webhooks:write` |
| `/api/v1/orders` | GET | Orders on eazpire for dual-published brand products (read-only) | `orders:read` |
| `/api/v1/orders/{id}` | GET | Order detail if it contains this brand’s line items | `orders:read` |

Orders are **platform eazpire shop** sales filtered by `brand_products.eazpire_shopify_product_id` — not the brand’s BYO Shopify orders. Suspended brands get `403 brand_suspended`. No fulfill/refund. Inbound Shopify→brand order webhooks are out of scope for MVP (poll the API).

Equivalent `?op=` names include `brand-api-overview`, `brand-api-brand`, `brand-api-brand-update`, `brand-api-connections`, `brand-api-products`, `brand-api-product-get`, `brand-api-product-update`, `brand-api-sync`, `brand-api-publish`, `brand-api-unpublish`, `brand-api-team`, `brand-api-team-invite`, `brand-api-team-update`, `brand-api-team-revoke`, `brand-api-memberships`, `brand-api-keys` / create / revoke, `brand-api-webhooks` / create / update / revoke / test, `brand-api-orders`, `brand-api-order-get`.

### Scopes

New keys default to all of: `overview:read`, `brand:read`, `brand:write`, `connections:read`, `products:read`, `products:write`, `products:sync`, `products:publish`, `team:read`, `team:invite`, `team:write`, `webhooks:read`, `webhooks:write`, `orders:read`. Settings UI can pick a subset or `*`. Session auth has full access (`*`).

### Webhooks

Outbound HTTPS callbacks after catalog actions. Signing secret encrypted at rest (AES-GCM via `BRAND_SECRETS_KEY`); plaintext shown once on create.

| Event | Trigger |
|-------|---------|
| `product.published` | Successful dual-publish |
| `product.unpublished` | Unpublish / draft on eazpire |
| `product.updated` | Local product title/status write |
| `product.synced` | Printify sync finished (`synced` count) |
| `webhook.ping` | Manual test |

Headers: `X-Eazpire-Event`, `X-Eazpire-Delivery-Id`, `X-Eazpire-Signature: sha256=<hmac_hex>` (HMAC-SHA256 of raw body). Retries 3× on 5xx/timeout; auto-disable after repeated failures. HTTPS only (localhost HTTP allowed); private/metadata IPs blocked.

Migration: `migrations-brand/0005_brand_webhooks.sql` (+ `ensureBrandSchema`).

### Example curl

```bash
# List products
curl -sS "https://brand.eazpire.com/api/v1/products" \
  -H "Authorization: Bearer eaz_brand_YOUR_KEY"

# Update brand profile
curl -sS -X POST "https://brand.eazpire.com/api/v1/brand" \
  -H "Authorization: Bearer eaz_brand_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tagline":"Made for creators"}'

# Invite team member
curl -sS -X POST "https://brand.eazpire.com/api/v1/team/invite" \
  -H "Authorization: Bearer eaz_brand_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"creator@example.com","publish_mode":"review"}'

# Publish selected products (or omit ids + use limit for next unpublished)
curl -sS -X POST "https://brand.eazpire.com/api/v1/products/publish" \
  -H "Authorization: Bearer eaz_brand_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"product_ids":["bp_…"]}'

# Register webhook (secret returned once)
curl -sS -X POST "https://brand.eazpire.com/api/v1/webhooks" \
  -H "Authorization: Bearer eaz_brand_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/hooks/eazpire","events":["product.published","product.unpublished"]}'

# List eazpire orders for dual-published products
curl -sS "https://brand.eazpire.com/api/v1/orders?limit=25" \
  -H "Authorization: Bearer eaz_brand_YOUR_KEY"

# Order detail (404 if no brand line items)
curl -sS "https://brand.eazpire.com/api/v1/orders/ORDER_ID" \
  -H "Authorization: Bearer eaz_brand_YOUR_KEY"

# Same via ?op=
curl -sS "https://brand.eazpire.com/?op=brand-api-overview" \
  -H "X-Eazpire-Brand-Key: eaz_brand_YOUR_KEY"
```

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

Suspended brands (`status = suspended`) cannot publish/unpublish/sync via the Brand API.

Migration: `migrations-brand/0004_brand_api_keys.sql` (+ `ensureBrandSchema`).

## Admin Brands (`admin.eazpire.com/brands`)

Partner-portals worker binds the same `BRAND_DB` and exposes:

- `admin-brand-list` / `admin-brand-get` (includes `api_keys_count` — no secret values)
- `admin-brand-suspend` / `admin-brand-activate`
- `admin-brand-force-unpublish` (drafts eazpire listings; needs `SHOPIFY_ACCESS_TOKEN` on partner worker)

Connection health is returned **without secrets**. App drawer: Partner · Creations · Brands.

## Connections (BYO)

- **Printify:** API token + shop id (encrypted in D1)
- **Shopify:** Admin API token paste, or OAuth when `BRAND_SHOPIFY_CLIENT_*` is set

## Related code

- `src/brand-worker.js`
- `src/features/brands/` (incl. `brandDualPublish.js`, `brandApiKeys.js`, `brandAuthContext.js`, `adminBrandOps.js`)
- `admin-brands-portal/`
- `docs/project/development-backlog/infrastructure/IDEA-029-brand-portal.md`
