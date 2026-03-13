CREATE TABLE IF NOT EXISTS anchor_items (
    anchor_id INTEGER NOT NULL REFERENCES hash_anchors(id) ON DELETE CASCADE,
    cuid TEXT NOT NULL REFERENCES content(cuid),
    PRIMARY KEY (anchor_id, cuid)
);

CREATE INDEX IF NOT EXISTS idx_anchor_items_cuid ON anchor_items(cuid);

INSERT OR IGNORE INTO anchor_items (anchor_id, cuid)
SELECT ha.id, c.cuid
FROM hash_anchors ha, json_each(ha.cuid_list) je
JOIN content c ON c.cuid = je.value;
