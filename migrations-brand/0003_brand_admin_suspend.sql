-- Phase 3: admin suspend metadata for brands

ALTER TABLE brands ADD COLUMN suspend_reason TEXT;
ALTER TABLE brands ADD COLUMN suspended_at INTEGER;
ALTER TABLE brands ADD COLUMN suspended_by TEXT;

CREATE INDEX IF NOT EXISTS idx_brands_status ON brands(status);
