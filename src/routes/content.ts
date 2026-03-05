import { Hono } from "hono";
import { getDb } from "../db";
import {
  PublishSchema,
  QuerySchema,
  RateSchema,
  RequestKeySchema,
  DeliverKeySchema,
  type ContentMeta,
} from "../schema";
import { verifySignature, fromHex, toBase64, sha256hex } from "../crypto";
import { buildMerkleProof } from "../anchor";
import { newCuid } from "../utils/cuid";
import { config } from "../config";
import { usdcBaseToLamports } from "../pricing";

const app = new Hono<{ Variables: { pubkey: string } }>();

class RouteError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function withImmediateTransaction<T>(db: ReturnType<typeof getDb>, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// POST /content/publish
app.post("/publish", async (c) => {
  const pubkey = c.get("pubkey");
  const body = await c.req.json();
  const parsed = PublishSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const data = parsed.data;
  const db = getDb();

  const author = db.query("SELECT 1 FROM agents WHERE pubkey = ?").get(pubkey);
  if (!author) {
    return c.json({ error: "Agent not registered" }, 404);
  }

  // Per-user daily publish limit
  const todayCount = db
    .query(
      "SELECT COUNT(*) as cnt FROM content WHERE author_pubkey = ? AND created_at > datetime('now', '-1 day')"
    )
    .get(pubkey) as { cnt: number };
  if (todayCount.cnt >= config.maxPublishesPerDay) {
    return c.json(
      { error: `Daily publish limit reached (${config.maxPublishesPerDay}/day)` },
      429 as any
    );
  }

  let computedBodyHash: string;
  let encryptedBody: Buffer | null = null;
  let nonce: Buffer | null = null;

  // Validate tier-specific requirements
  if (data.tier === "flux.open") {
    if (!data.body) return c.json({ error: "flux.open requires plaintext body" }, 400);
    if (data.encrypted_body || data.nonce) {
      return c.json({ error: "flux.open must not include encrypted_body or nonce" }, 400);
    }
    computedBodyHash = sha256hex(new TextEncoder().encode(data.body));
  } else {
    if (!data.encrypted_body || !data.nonce)
      return c.json({ error: "sealed/T0 requires encrypted_body and nonce" }, 400);
    if (data.body) {
      return c.json({ error: "sealed/T0 must not include plaintext body" }, 400);
    }

    encryptedBody = Buffer.from(data.encrypted_body, "base64");
    nonce = Buffer.from(data.nonce, "base64");
    if (encryptedBody.length === 0) {
      return c.json({ error: "encrypted_body must be valid base64 bytes" }, 400);
    }
    if (nonce.length !== 24) {
      return c.json({ error: "nonce must decode to 24 bytes" }, 400);
    }
    computedBodyHash = sha256hex(new Uint8Array(encryptedBody));
  }

  if (data.tier === "T0" && data.price_lamports <= 0 && (!data.price_usdc || data.price_usdc <= 0)) {
    return c.json({ error: "T0 requires price_lamports > 0 or price_usdc > 0" }, 400);
  }
  if (computedBodyHash !== data.body_hash.toLowerCase()) {
    return c.json({ error: "body_hash does not match submitted payload" }, 400);
  }

  // Verify author signature over body_hash
  try {
    const hashBytes = fromHex(computedBodyHash);
    const sigBytes = fromHex(data.author_signature);
    const pubkeyBytes = fromHex(pubkey);
    if (!verifySignature(hashBytes, sigBytes, pubkeyBytes)) {
      return c.json({ error: "Invalid author signature" }, 400);
    }
  } catch {
    return c.json({ error: "Signature verification failed" }, 400);
  }

  const cuid = newCuid();

  const expiresAt = data.ttl_seconds
    ? new Date(Date.now() + data.ttl_seconds * 1000).toISOString()
    : null;

  try {
    db.query(`
      INSERT INTO content (cuid, author_pubkey, tier, topic, content_type, body,
        encrypted_body, nonce, body_hash, author_signature, price_lamports,
        price_usdc, ttl_seconds, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cuid,
      pubkey,
      data.tier,
      data.topic,
      data.content_type,
      data.tier === "flux.open" ? data.body! : null,
      encryptedBody,
      nonce,
      computedBodyHash,
      data.author_signature,
      data.price_lamports,
      data.price_usdc ?? null,
      data.ttl_seconds ?? null,
      expiresAt
    );
  } catch (e: any) {
    return c.json({ error: e.message ?? "Failed to publish content" }, 400);
  }

  return c.json({ cuid, tier: data.tier, topic: data.topic }, 201);
});

// GET /content/query
app.get("/query", (c) => {
  const params = QuerySchema.safeParse(c.req.query());
  if (!params.success) {
    return c.json({ error: params.error.flatten() }, 400);
  }

  const { q, topic, tier, sort, limit, offset } = params.data;
  const db = getDb();

  let sql: string;
  const bindings: (string | number)[] = [];

  if (q) {
    // FTS5 search
    sql = `
      SELECT c.cuid, c.author_pubkey, c.tier, c.topic, c.content_type,
             c.price_lamports, c.rating_sum, c.rating_count, c.query_count,
             c.created_at, c.expires_at
      FROM content_fts fts
      JOIN content c ON fts.cuid = c.cuid
      WHERE content_fts MATCH ?
    `;
    bindings.push(q);
  } else {
    sql = `
      SELECT cuid, author_pubkey, tier, topic, content_type,
             price_lamports, rating_sum, rating_count, query_count,
             created_at, expires_at
      FROM content WHERE 1=1
    `;
  }

  if (topic) {
    sql += " AND topic = ?";
    bindings.push(topic);
  }
  if (tier) {
    sql += " AND tier = ?";
    bindings.push(tier);
  }

  // Exclude expired content
  sql += " AND (expires_at IS NULL OR expires_at > datetime('now'))";

  const orderMap = {
    recent: "created_at DESC",
    rating: "CASE WHEN rating_count > 0 THEN rating_sum / rating_count ELSE 0 END DESC",
    popular: "query_count DESC",
  };
  sql += ` ORDER BY ${orderMap[sort]} LIMIT ? OFFSET ?`;
  bindings.push(limit, offset);

  const rows = db.query(sql).all(...bindings) as any[];

  const results: ContentMeta[] = rows.map((r) => ({
    cuid: r.cuid,
    author_pubkey: r.author_pubkey,
    tier: r.tier,
    topic: r.topic,
    content_type: r.content_type,
    price_lamports: r.price_lamports,
    rating_avg: r.rating_count > 0 ? r.rating_sum / r.rating_count : null,
    rating_count: r.rating_count,
    query_count: r.query_count,
    created_at: r.created_at,
    expires_at: r.expires_at,
  }));

  return c.json({ results, count: results.length });
});

// GET /content/:cuid
app.get("/:cuid", (c) => {
  const cuid = c.req.param("cuid");
  const db = getDb();

  const row = db.query("SELECT * FROM content WHERE cuid = ?").get(cuid) as any;
  if (!row) return c.json({ error: "Content not found" }, 404);

  // Increment query count
  db.query("UPDATE content SET query_count = query_count + 1 WHERE cuid = ?").run(cuid);

  if (row.tier === "flux.open") {
    return c.json({
      cuid: row.cuid,
      author_pubkey: row.author_pubkey,
      tier: row.tier,
      topic: row.topic,
      content_type: row.content_type,
      body: row.body,
      body_hash: row.body_hash,
      author_signature: row.author_signature,
      created_at: row.created_at,
    });
  }

  // Sealed / T0: return ciphertext
  return c.json({
    cuid: row.cuid,
    author_pubkey: row.author_pubkey,
    tier: row.tier,
    topic: row.topic,
    content_type: row.content_type,
    encrypted_body: row.encrypted_body
      ? toBase64(new Uint8Array(row.encrypted_body))
      : null,
    nonce: row.nonce ? toBase64(new Uint8Array(row.nonce)) : null,
    body_hash: row.body_hash,
    author_signature: row.author_signature,
    price_lamports: row.price_lamports,
    created_at: row.created_at,
  });
});

// POST /content/:cuid/rate
app.post("/:cuid/rate", async (c) => {
  const cuid = c.req.param("cuid");
  const pubkey = c.get("pubkey");
  const body = await c.req.json();
  const parsed = RateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const db = getDb();
  const content = db.query("SELECT 1 FROM content WHERE cuid = ?").get(cuid);
  if (!content) return c.json({ error: "Content not found" }, 404);

  const existing = db
    .query("SELECT 1 FROM ratings WHERE cuid = ? AND rater_pubkey = ?")
    .get(cuid, pubkey);
  if (existing) return c.json({ error: "Already rated" }, 409);

  const { relevance, useful } = parsed.data;
  const score = (relevance + useful) / 2;

  db.transaction(() => {
    db.query(
      "INSERT INTO ratings (cuid, rater_pubkey, relevance, useful) VALUES (?, ?, ?, ?)"
    ).run(cuid, pubkey, relevance, useful);
    db.query(
      "UPDATE content SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE cuid = ?"
    ).run(score, cuid);
  })();

  return c.json({ cuid, rated: true });
});

// GET /content/:cuid/verify
app.get("/:cuid/verify", (c) => {
  const cuid = c.req.param("cuid");
  const db = getDb();

  const row = db
    .query("SELECT body_hash, author_signature, author_pubkey FROM content WHERE cuid = ?")
    .get(cuid) as { body_hash: string; author_signature: string; author_pubkey: string } | null;
  if (!row) return c.json({ error: "Content not found" }, 404);

  let signatureValid = false;
  try {
    const hashBytes = fromHex(row.body_hash);
    const sigBytes = fromHex(row.author_signature);
    const pubBytes = fromHex(row.author_pubkey);
    signatureValid = verifySignature(hashBytes, sigBytes, pubBytes);
  } catch {
    signatureValid = false;
  }

  // Check for Merkle anchor
  const anchor = db
    .query(`
      SELECT ha.merkle_root, ha.tx_signature, ha.anchored_at, ha.cuid_list
      FROM hash_anchors ha
      JOIN json_each(ha.cuid_list) je ON je.value = ?
      WHERE COALESCE(ha.tx_signature, '') <> ''
      ORDER BY ha.created_at DESC
      LIMIT 1
    `)
    .get(cuid) as {
    merkle_root: string;
    tx_signature: string;
    anchored_at: string;
    cuid_list: string;
  } | null;

  let merkleProof:
    | {
        leaf_hash: string;
        leaf_index: number;
        siblings: { position: "left" | "right"; hash: string }[];
      }
    | null = null;

  if (anchor) {
    try {
      const cuidList = JSON.parse(anchor.cuid_list) as string[];
      const leafIndex = cuidList.findIndex((v) => v === cuid);
      if (leafIndex >= 0) {
        const placeholders = cuidList.map(() => "?").join(", ");
        const hashRows = db
          .query(
            `SELECT cuid, body_hash FROM content WHERE cuid IN (${placeholders})`
          )
          .all(...cuidList) as { cuid: string; body_hash: string }[];
        const hashMap = new Map(hashRows.map((h) => [h.cuid, h.body_hash]));
        const leafHashes = cuidList.map((id) => hashMap.get(id)).filter(Boolean) as string[];

        if (leafHashes.length === cuidList.length) {
          const proof = buildMerkleProof(leafHashes, leafIndex);
          if (proof && proof.root === anchor.merkle_root) {
            merkleProof = {
              leaf_hash: row.body_hash,
              leaf_index: leafIndex,
              siblings: proof.siblings,
            };
          }
        }
      }
    } catch {
      merkleProof = null;
    }
  }

  return c.json({
    cuid,
    signature_valid: signatureValid,
    author_pubkey: row.author_pubkey,
    body_hash: row.body_hash,
    anchor: anchor
        ? {
            merkle_root: anchor.merkle_root,
            tx_signature: anchor.tx_signature,
            anchored_at: anchor.anchored_at,
            merkle_proof: merkleProof,
          }
      : null,
  });
});

// POST /content/:cuid/request_key — request content key
app.post("/:cuid/request_key", async (c) => {
  const cuid = c.req.param("cuid");
  const pubkey = c.get("pubkey");
  const db = getDb();
  const body = await c.req.json().catch(() => ({}));
  const parsed = RequestKeySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const requesterBoxPubkeyB64 = parsed.data.requester_box_pubkey;
  const requesterBoxPubkey = Buffer.from(requesterBoxPubkeyB64, "base64");
  if (requesterBoxPubkey.length !== 32) {
    return c.json({ error: "requester_box_pubkey must decode to 32 bytes" }, 400);
  }

  try {
    const outcome = withImmediateTransaction(db, () => {
      const content = db
        .query("SELECT tier, price_lamports, price_usdc, author_pubkey FROM content WHERE cuid = ?")
        .get(cuid) as {
        tier: string;
        price_lamports: number;
        price_usdc: number | null;
        author_pubkey: string;
      } | null;
      if (!content) {
        throw new RouteError(404, "Content not found");
      }

      if (content.tier === "flux.open") {
        throw new RouteError(400, "flux.open does not need key exchange");
      }

      const existing = db
        .query("SELECT status FROM key_envelopes WHERE cuid = ? AND requester_pubkey = ?")
        .get(cuid, pubkey) as { status: string } | null;

      // T0 payment flow
      if (content.tier === "T0") {
        if (config.x402Enabled) {
          // x402 mode: USDC payment was verified by middleware and sent to
          // the node operator's payTo address. Distribute internally via ledger:
          // buyer audit entry + author credit (minus fee) + operator fee.
          const logged = db
            .query(
              "SELECT 1 FROM ledger WHERE pubkey = ? AND ref_id = ? AND reason = 'content_purchase_x402'"
            )
            .get(pubkey, cuid);
          if (!logged) {
            const price =
              content.price_usdc != null && content.price_usdc > 0
                ? usdcBaseToLamports(content.price_usdc)
                : content.price_lamports;
            const fee = Math.floor((price * config.nodeQueryFeeBps) / 10000);
            const authorPayment = price - fee;

            // Buyer audit (no balance debit — payment was external USDC)
            db.query(
              "INSERT INTO ledger (pubkey, amount, reason, ref_id) VALUES (?, ?, ?, ?)"
            ).run(pubkey, -price, "content_purchase_x402", cuid);

            // Author credit
            db.query("UPDATE agents SET balance = balance + ? WHERE pubkey = ?").run(
              authorPayment,
              content.author_pubkey
            );
            db.query(
              "INSERT INTO ledger (pubkey, amount, reason, ref_id) VALUES (?, ?, ?, ?)"
            ).run(content.author_pubkey, authorPayment, "content_sale_x402", cuid);

            // Node operator fee
            if (fee > 0 && config.nodeOperatorPubkey) {
              const operator = db
                .query("SELECT 1 FROM agents WHERE pubkey = ?")
                .get(config.nodeOperatorPubkey);
              if (operator) {
                db.query("UPDATE agents SET balance = balance + ? WHERE pubkey = ?").run(
                  fee,
                  config.nodeOperatorPubkey
                );
                db.query(
                  "INSERT INTO ledger (pubkey, amount, reason, ref_id) VALUES (?, ?, ?, ?)"
                ).run(config.nodeOperatorPubkey, fee, "query_fee_x402", cuid);
              }
            }
          }
        } else {
          // Ledger mode: debit buyer's server-side balance
          const paid = db
            .query(
              "SELECT 1 FROM ledger WHERE pubkey = ? AND ref_id = ? AND amount < 0 AND reason = 'content_purchase'"
            )
            .get(pubkey, cuid);

          if (!paid) {
            const buyer = db
              .query("SELECT balance, daily_spent, daily_reset_at FROM agents WHERE pubkey = ?")
              .get(pubkey) as {
              balance: number;
              daily_spent: number;
              daily_reset_at: string;
            } | null;
            if (!buyer) throw new RouteError(404, "Agent not registered");

            let dailySpent = buyer.daily_spent;
            const resetAt = new Date(`${buyer.daily_reset_at}Z`);
            if (!Number.isNaN(resetAt.getTime()) && Date.now() - resetAt.getTime() > 24 * 60 * 60 * 1000) {
              dailySpent = 0;
              db.query(
                "UPDATE agents SET daily_spent = 0, daily_reset_at = datetime('now') WHERE pubkey = ?"
              ).run(pubkey);
            }

            const price = content.price_lamports;
            if (buyer.balance < price) throw new RouteError(400, "Insufficient balance");

            const policy = db
              .query("SELECT daily_spend_cap FROM principal_policies WHERE pubkey = ?")
              .get(pubkey) as { daily_spend_cap: number } | null;
            if (policy && dailySpent + price > policy.daily_spend_cap) {
              throw new RouteError(400, "Daily spending cap exceeded");
            }

            const fee = Math.floor((price * config.nodeQueryFeeBps) / 10000);
            const authorPayment = price - fee;

            db.query(
              "UPDATE agents SET balance = balance - ?, daily_spent = ? WHERE pubkey = ?"
            ).run(price, dailySpent + price, pubkey);
            db.query(
              "INSERT INTO ledger (pubkey, amount, reason, ref_id) VALUES (?, ?, ?, ?)"
            ).run(pubkey, -price, "content_purchase", cuid);

            db.query("UPDATE agents SET balance = balance + ? WHERE pubkey = ?").run(
              authorPayment,
              content.author_pubkey
            );
            db.query(
              "INSERT INTO ledger (pubkey, amount, reason, ref_id) VALUES (?, ?, ?, ?)"
            ).run(content.author_pubkey, authorPayment, "content_sale", cuid);

            if (fee > 0 && config.nodeOperatorPubkey) {
              const operator = db
                .query("SELECT 1 FROM agents WHERE pubkey = ?")
                .get(config.nodeOperatorPubkey);
              if (operator) {
                db.query("UPDATE agents SET balance = balance + ? WHERE pubkey = ?").run(
                  fee,
                  config.nodeOperatorPubkey
                );
                db.query(
                  "INSERT INTO ledger (pubkey, amount, reason, ref_id) VALUES (?, ?, ?, ?)"
                ).run(config.nodeOperatorPubkey, fee, "query_fee", cuid);
              }
            }
          }
        }
      }

      if (existing?.status === "delivered") {
        return { delivered: true };
      }

      db.query(`
        INSERT INTO key_envelopes (cuid, requester_pubkey, requester_box_pubkey)
        VALUES (?, ?, ?)
        ON CONFLICT(cuid, requester_pubkey) DO UPDATE
          SET requester_box_pubkey = excluded.requester_box_pubkey,
              requested_at = datetime('now')
      `).run(cuid, pubkey, requesterBoxPubkeyB64);

      return { delivered: false };
    });

    if (outcome.delivered) {
      return c.json({ message: "Key already delivered — use GET /content/:cuid/my_key" });
    }

    return c.json({ message: "Key requested", cuid, status: "pending" }, 201);
  } catch (e: any) {
    if (e instanceof RouteError) {
      return c.json({ error: e.message }, e.status);
    }
    return c.json({ error: e.message ?? "Failed to request key" }, 400);
  }
});

// GET /content/:cuid/my_key — buyer downloads their envelope
app.get("/:cuid/my_key", (c) => {
  const cuid = c.req.param("cuid");
  const pubkey = c.get("pubkey");
  const db = getDb();

  const row = db
    .query("SELECT status, envelope FROM key_envelopes WHERE cuid = ? AND requester_pubkey = ?")
    .get(cuid, pubkey) as { status: string; envelope: Buffer | null } | null;

  if (!row) return c.json({ error: "No key request found" }, 404);
  if (row.status === "pending") return c.json({ status: "pending", message: "Key not yet delivered by author" });

  return c.json({
    status: "delivered",
    envelope: row.envelope ? toBase64(new Uint8Array(row.envelope)) : null,
  });
});

export default app;

// -- Author key management routes (mounted separately) --

export const authorRoutes = new Hono<{ Variables: { pubkey: string } }>();

// GET /author/key_requests — author polls for pending requests
authorRoutes.get("/key_requests", (c) => {
  const pubkey = c.get("pubkey");
  const db = getDb();

  const rows = db
    .query(`
      SELECT ke.cuid, ke.requester_pubkey, ke.requester_box_pubkey, ke.requested_at
      FROM key_envelopes ke
      JOIN content c ON ke.cuid = c.cuid
      WHERE c.author_pubkey = ? AND ke.status = 'pending'
      ORDER BY ke.requested_at ASC
    `)
    .all(pubkey) as {
    cuid: string;
    requester_pubkey: string;
    requester_box_pubkey: string | null;
    requested_at: string;
  }[];

  return c.json({ requests: rows });
});

// POST /content/:cuid/deliver_key — author uploads sealed envelope
app.post("/:cuid/deliver_key", async (c) => {
  const cuid = c.req.param("cuid");
  const pubkey = c.get("pubkey");
  const body = await c.req.json();
  const parsed = DeliverKeySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const db = getDb();

  // Verify caller is the author
  const content = db
    .query("SELECT author_pubkey FROM content WHERE cuid = ?")
    .get(cuid) as { author_pubkey: string } | null;
  if (!content) return c.json({ error: "Content not found" }, 404);
  if (content.author_pubkey !== pubkey) {
    return c.json({ error: "Only the author can deliver keys" }, 403);
  }

  const envelope = db
    .query("SELECT status FROM key_envelopes WHERE cuid = ? AND requester_pubkey = ?")
    .get(cuid, parsed.data.requester_pubkey) as { status: string } | null;
  if (!envelope) return c.json({ error: "No pending key request from this agent" }, 404);
  if (envelope.status === "delivered") return c.json({ error: "Key already delivered" }, 409);

  db.query(`
    UPDATE key_envelopes
    SET envelope = ?, status = 'delivered', delivered_at = datetime('now')
    WHERE cuid = ? AND requester_pubkey = ?
  `).run(
    Buffer.from(parsed.data.envelope, "base64"),
    cuid,
    parsed.data.requester_pubkey
  );

  return c.json({ message: "Key delivered", cuid, requester: parsed.data.requester_pubkey });
});
