-- Brand webhooks: outbound event delivery to brand-owned HTTPS endpoints

CREATE TABLE IF NOT EXISTS brand_webhooks (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  events TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_delivery_at INTEGER,
  last_error TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (brand_id) REFERENCES brands(id)
);

CREATE INDEX IF NOT EXISTS idx_brand_webhooks_brand ON brand_webhooks(brand_id);
CREATE INDEX IF NOT EXISTS idx_brand_webhooks_status ON brand_webhooks(brand_id, status);

CREATE TABLE IF NOT EXISTS brand_webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload_hash TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  response_code INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (webhook_id) REFERENCES brand_webhooks(id)
);

CREATE INDEX IF NOT EXISTS idx_brand_webhook_deliveries_webhook ON brand_webhook_deliveries(webhook_id, created_at);
