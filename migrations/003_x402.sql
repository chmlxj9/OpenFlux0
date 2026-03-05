-- x402 production hardening:
-- - native USDC pricing (optional override for lamports)
-- - unique purchase index for x402 idempotency

-- NOTE: db.ts applies this migration with idempotent guards.
ALTER TABLE content ADD COLUMN price_usdc INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_unique_x402_purchase
    ON ledger(pubkey, ref_id, reason)
    WHERE reason = 'content_purchase_x402';

CREATE INDEX IF NOT EXISTS idx_ledger_x402_sale_lookup
    ON ledger(pubkey, ref_id, reason)
    WHERE reason = 'content_sale_x402';
