-- Fix x402 ledger index cardinality:
-- Multiple buyers can purchase the same content, so author/operator rows must
-- not be uniquely constrained by (pubkey, ref_id, reason).

DROP INDEX IF EXISTS idx_ledger_unique_x402_sale;

CREATE INDEX IF NOT EXISTS idx_ledger_x402_sale_lookup
    ON ledger(pubkey, ref_id, reason)
    WHERE reason = 'content_sale_x402';
