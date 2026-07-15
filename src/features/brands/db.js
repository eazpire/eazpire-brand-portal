/**
 * Brand Portal D1 helpers
 */

export function getBrandDb(env) {
  return env?.BRAND_DB || null;
}

export function brandDbUnavailable() {
  return { ok: false, error: "brand_db_unavailable" };
}

export function newId(prefix = "b") {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function ensureBrandSchema(env) {
  const db = getBrandDb(env);
  if (!db) return false;
  if (env.__brandSchemaReady) return true;

  const stmts = [
    `CREATE TABLE IF NOT EXISTS brand_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE,
      display_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_users_email ON brand_users(email)`,
    `CREATE TABLE IF NOT EXISTS brand_auth_tokens (
      id TEXT PRIMARY KEY,
      brand_user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_brand_auth_tokens_hash ON brand_auth_tokens(token_hash)`,
    `CREATE TABLE IF NOT EXISTS brands (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      handle TEXT NOT NULL COLLATE NOCASE,
      tagline TEXT,
      about TEXT,
      logo_r2_key TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      profile_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_brands_handle ON brands(handle)`,
    `CREATE INDEX IF NOT EXISTS idx_brands_owner ON brands(owner_user_id)`,
    `CREATE TABLE IF NOT EXISTS brand_connections (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'disconnected',
      meta_json TEXT,
      secret_ciphertext TEXT,
      last_ok_at INTEGER,
      connected_at INTEGER,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_connections_brand_type ON brand_connections(brand_id, type)`,
    `CREATE TABLE IF NOT EXISTS brand_products (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL,
      printify_product_id TEXT,
      shopify_product_id TEXT,
      title TEXT,
      status TEXT,
      thumbnail_url TEXT,
      external_json TEXT,
      last_synced_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_brand_products_brand ON brand_products(brand_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_products_printify ON brand_products(brand_id, printify_product_id)`,
    `CREATE TABLE IF NOT EXISTS brand_members (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE,
      user_id TEXT,
      role TEXT NOT NULL DEFAULT 'creator',
      publish_mode TEXT NOT NULL DEFAULT 'review',
      status TEXT NOT NULL DEFAULT 'invited',
      invited_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_members_brand_email ON brand_members(brand_id, email)`,
    `CREATE INDEX IF NOT EXISTS idx_brand_members_brand ON brand_members(brand_id)`,
    // Phase 2 columns (ignore errors if already present)
    `ALTER TABLE brand_users ADD COLUMN shopify_customer_id TEXT`,
    `ALTER TABLE brand_users ADD COLUMN shopify_linked_at INTEGER`,
    `ALTER TABLE brand_products ADD COLUMN eazpire_shopify_product_id TEXT`,
    `ALTER TABLE brand_products ADD COLUMN eazpire_handle TEXT`,
    `ALTER TABLE brand_products ADD COLUMN dual_publish_status TEXT`,
    `ALTER TABLE brand_products ADD COLUMN dual_publish_error TEXT`,
    `ALTER TABLE brand_products ADD COLUMN dual_published_at INTEGER`,
    `ALTER TABLE brand_members ADD COLUMN accepted_at INTEGER`,
    `ALTER TABLE brand_members ADD COLUMN shopify_customer_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_brand_users_shopify_customer ON brand_users(shopify_customer_id)`,
    `CREATE TABLE IF NOT EXISTS creator_brand_context (
      owner_id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  ];

  for (const sql of stmts) {
    try {
      await db.prepare(sql).run();
    } catch (e) {
      console.warn("[brand-schema]", e?.message || e);
    }
  }
  env.__brandSchemaReady = true;
  return true;
}
