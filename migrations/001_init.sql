-- OpenFlux0 v0 — Schema

-- Agents (identified by Solana pubkey)
CREATE TABLE IF NOT EXISTS agents (
    pubkey TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    daily_spent INTEGER NOT NULL DEFAULT 0,
    daily_reset_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Principal policies (spending caps)
CREATE TABLE IF NOT EXISTS principal_policies (
    pubkey TEXT PRIMARY KEY REFERENCES agents(pubkey),
    max_per_query INTEGER NOT NULL DEFAULT 50000,
    max_per_task INTEGER NOT NULL DEFAULT 5000000000,
    daily_spend_cap INTEGER NOT NULL DEFAULT 50000000000
);

-- Content items
CREATE TABLE IF NOT EXISTS content (
    cuid TEXT PRIMARY KEY,
    author_pubkey TEXT NOT NULL REFERENCES agents(pubkey),
    tier TEXT NOT NULL CHECK (tier IN ('flux.open', 'flux.sealed', 'T0')),
    topic TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'signal',
    body TEXT,
    encrypted_body BLOB,
    nonce BLOB,
    body_hash TEXT NOT NULL,
    author_signature TEXT NOT NULL,
    price_lamports INTEGER NOT NULL DEFAULT 0,
    ttl_seconds INTEGER,
    expires_at TEXT,
    rating_sum REAL NOT NULL DEFAULT 0,
    rating_count INTEGER NOT NULL DEFAULT 0,
    query_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_topic ON content(topic);
CREATE INDEX IF NOT EXISTS idx_content_tier ON content(tier);
CREATE INDEX IF NOT EXISTS idx_content_created ON content(created_at DESC);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
    cuid UNINDEXED,
    topic,
    content_type,
    body,
    content='content',
    content_rowid='rowid'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS content_ai AFTER INSERT ON content BEGIN
    INSERT INTO content_fts(rowid, cuid, topic, content_type, body)
    VALUES (new.rowid, new.cuid, new.topic, new.content_type, COALESCE(new.body, ''));
END;

CREATE TRIGGER IF NOT EXISTS content_ad AFTER DELETE ON content BEGIN
    INSERT INTO content_fts(content_fts, rowid, cuid, topic, content_type, body)
    VALUES ('delete', old.rowid, old.cuid, old.topic, old.content_type, COALESCE(old.body, ''));
END;

-- Key envelopes (sealed content key delivery)
CREATE TABLE IF NOT EXISTS key_envelopes (
    cuid TEXT NOT NULL REFERENCES content(cuid),
    requester_pubkey TEXT NOT NULL REFERENCES agents(pubkey),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
    envelope BLOB,
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT,
    PRIMARY KEY (cuid, requester_pubkey)
);

-- Ratings (one per agent per CUID)
CREATE TABLE IF NOT EXISTS ratings (
    cuid TEXT NOT NULL REFERENCES content(cuid),
    rater_pubkey TEXT NOT NULL REFERENCES agents(pubkey),
    relevance REAL NOT NULL CHECK (relevance BETWEEN 0 AND 1),
    useful INTEGER NOT NULL CHECK (useful IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (cuid, rater_pubkey)
);

-- Tasks (BBS)
CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    poster_pubkey TEXT NOT NULL REFERENCES agents(pubkey),
    claimer_pubkey TEXT REFERENCES agents(pubkey),
    task_type TEXT NOT NULL,
    instruction TEXT NOT NULL,
    source_cuid TEXT REFERENCES content(cuid),
    bounty_lamports INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'claimed', 'submitted', 'completed', 'expired')),
    deadline_seconds INTEGER NOT NULL DEFAULT 300,
    claimed_at TEXT,
    deadline_at TEXT,
    result TEXT,
    proof TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    settled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(task_type);

-- Ledger (audit trail)
CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pubkey TEXT NOT NULL REFERENCES agents(pubkey),
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    ref_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Hash anchors (Solana devnet Merkle roots)
CREATE TABLE IF NOT EXISTS hash_anchors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merkle_root TEXT NOT NULL,
    tx_signature TEXT,
    cuid_list TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    anchored_at TEXT
);
