-- Brand API keys (machine access to eazpire Brand API — not BYO Shopify / not Link eazpire Account)

CREATE TABLE IF NOT EXISTS brand_api_keys (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  FOREIGN KEY (brand_id) REFERENCES brands(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_api_keys_hash ON brand_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_brand_api_keys_brand ON brand_api_keys(brand_id);
