-- Phase 2: dual-publish fields, Shopify customer link, member activation

ALTER TABLE brand_users ADD COLUMN shopify_customer_id TEXT;
ALTER TABLE brand_users ADD COLUMN shopify_linked_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_brand_users_shopify_customer ON brand_users(shopify_customer_id);

ALTER TABLE brand_products ADD COLUMN eazpire_shopify_product_id TEXT;
ALTER TABLE brand_products ADD COLUMN eazpire_handle TEXT;
ALTER TABLE brand_products ADD COLUMN dual_publish_status TEXT;
ALTER TABLE brand_products ADD COLUMN dual_publish_error TEXT;
ALTER TABLE brand_products ADD COLUMN dual_published_at INTEGER;

ALTER TABLE brand_members ADD COLUMN accepted_at INTEGER;
ALTER TABLE brand_members ADD COLUMN shopify_customer_id TEXT;

CREATE TABLE IF NOT EXISTS creator_brand_context (
  owner_id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
