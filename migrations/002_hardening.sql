-- OpenFlux hardening migration:
-- - auth nonce replay guard
-- - explicit requester box public key
-- - idempotent T0 purchase ledger uniqueness

ALTER TABLE key_envelopes ADD COLUMN requester_box_pubkey TEXT;

CREATE TABLE IF NOT EXISTS auth_nonces (
    pubkey TEXT NOT NULL,
    nonce TEXT NOT NULL,
    used_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (pubkey, nonce)
);

CREATE INDEX IF NOT EXISTS idx_auth_nonces_used_at ON auth_nonces(used_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_unique_content_purchase
    ON ledger(pubkey, ref_id, reason)
    WHERE reason = 'content_purchase';
