import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import nacl from "tweetnacl";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const dataDir = join(
  import.meta.dir,
  `tmp-openflux-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
);
mkdirSync(dataDir, { recursive: true });

process.env.DATA_DIR = dataDir;
process.env.ANCHOR_INTERVAL_MS = "0";
process.env.AUTH_NONCE_PRUNE_INTERVAL_MS = "0";
process.env.TASK_EXPIRY_INTERVAL_MS = "0";
process.env.ANCHOR_MIN_ITEMS = "1";
process.env.NODE_OPERATOR_PUBKEY = "";
process.env.X402_ENABLED = "false";
process.env.X402_PAY_TO = "";

const { default: server } = await import("../src/index");
const { getDb, closeDb } = await import("../src/db");
const { expireOverdueTasks } = await import("../src/routes/tasks");
const { anchorHashes, buildMerkleRoot, verifyMerkleProof } = await import(
  "../src/anchor"
);

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function sha256hex(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

class Agent {
  privateKey: Uint8Array;
  pubkey: string;
  boxKeypair: nacl.BoxKeyPair;

  constructor() {
    this.privateKey = ed.utils.randomPrivateKey();
    this.pubkey = toHex(ed.getPublicKey(this.privateKey));
    this.boxKeypair = nacl.box.keyPair();
  }

  sign(method: string, path: string, timestamp: string, nonce: string): string {
    const msg = `${method}:${path}:${timestamp}:${nonce}`;
    const sig = ed.sign(new TextEncoder().encode(msg), this.privateKey);
    return toHex(sig);
  }

  boxPubkeyBase64(): string {
    return Buffer.from(this.boxKeypair.publicKey).toString("base64");
  }
}

async function signedFetch(
  agent: Agent,
  method: string,
  path: string,
  body?: unknown,
  timestamp?: string,
  nonce?: string
): Promise<Response> {
  const ts = timestamp ?? Date.now().toString();
  const n = nonce ?? toHex(nacl.randomBytes(16));
  const sig = agent.sign(method, path, ts, n);
  return server.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        Authorization: `SolSign ${agent.pubkey}:${sig}:${ts}:${n}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  );
}

async function json(res: Response): Promise<any> {
  return await res.json();
}

function resetDb() {
  const db = getDb();
  db.exec("DELETE FROM auth_nonces");
  db.exec("DELETE FROM hash_anchors");
  db.exec("DELETE FROM ledger");
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM ratings");
  db.exec("DELETE FROM key_envelopes");
  db.exec("DELETE FROM content");
  db.exec("DELETE FROM principal_policies");
  db.exec("DELETE FROM agents");
}

beforeEach(() => {
  resetDb();
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

// Helper: build a valid flux.open publish body for an agent
function openPublishBody(agent: Agent, content: string = "test signal") {
  const body = JSON.stringify({ signal: content });
  const bodyHash = sha256hex(new TextEncoder().encode(body));
  const signature = toHex(ed.sign(fromHex(bodyHash), agent.privateKey));
  return {
    tier: "flux.open" as const,
    topic: "testing",
    content_type: "signal",
    body,
    body_hash: bodyHash,
    author_signature: signature,
  };
}

// Helper: build a valid sealed publish body for an agent
function sealedPublishBody(
  agent: Agent,
  opts: { tier?: "flux.sealed" | "T0"; price?: number } = {}
) {
  const ciphertext = nacl.randomBytes(32);
  const nonce = nacl.randomBytes(24);
  const bodyHash = sha256hex(ciphertext);
  const signature = toHex(ed.sign(fromHex(bodyHash), agent.privateKey));
  return {
    tier: opts.tier ?? ("flux.sealed" as const),
    topic: "testing.sealed",
    content_type: "signal",
    encrypted_body: Buffer.from(ciphertext).toString("base64"),
    nonce: Buffer.from(nonce).toString("base64"),
    body_hash: bodyHash,
    author_signature: signature,
    price_lamports: opts.price ?? 0,
  };
}

describe("OpenFlux scenario validation", () => {
  it("registers a valid signed agent", async () => {
    const alice = new Agent();
    const res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    const payload = await json(res);
    expect(payload.pubkey).toBe(alice.pubkey);
  });

  it("rejects non-numeric timestamps in SolSign", async () => {
    const alice = new Agent();
    const res = await signedFetch(
      alice,
      "POST",
      "/agents/register",
      undefined,
      "not-a-number"
    );
    expect(res.status).toBe(401);
  });

  it("rejects stale timestamps outside drift window", async () => {
    const alice = new Agent();
    const staleTs = (Date.now() - 120_000).toString();
    const res = await signedFetch(alice, "POST", "/agents/register", undefined, staleTs);
    expect(res.status).toBe(401);
  });

  it("rejects signature replay on a different path", async () => {
    const alice = new Agent();
    const ts = Date.now().toString();
    const nonce = "noncepath1";
    const sig = alice.sign("POST", "/agents/register", ts, nonce);

    const res = await server.fetch(
      new Request("http://localhost/agents/deposit", {
        method: "POST",
        headers: {
          Authorization: `SolSign ${alice.pubkey}:${sig}:${ts}:${nonce}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ amount: 1 }),
      })
    );
    expect(res.status).toBe(401);
  });

  it("rejects replayed nonce for identical request", async () => {
    const alice = new Agent();
    const ts = Date.now().toString();
    const nonce = "replaynonce1";

    let res = await signedFetch(
      alice,
      "POST",
      "/agents/register",
      undefined,
      ts,
      nonce
    );
    expect(res.status).toBe(201);

    res = await signedFetch(alice, "GET", "/agents/me", undefined, ts, nonce);
    expect(res.status).toBe(401);
  });

  it("rejects publish if body_hash does not match submitted body", async () => {
    const alice = new Agent();

    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);

    const actualBody = JSON.stringify({ signal: "AAPL bullish" });
    const mismatchedBody = JSON.stringify({ signal: "AAPL bearish" });
    const claimedHash = sha256hex(new TextEncoder().encode(mismatchedBody));
    const signature = toHex(ed.sign(fromHex(claimedHash), alice.privateKey));

    res = await signedFetch(alice, "POST", "/content/publish", {
      tier: "flux.open",
      topic: "trading.signals",
      content_type: "signal",
      body: actualBody,
      body_hash: claimedHash,
      author_signature: signature,
    });

    expect(res.status).toBe(400);
  });

  it("returns 413 when /content/publish payload exceeds max body size", async () => {
    const alice = new Agent();

    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);

    const oversizedBody = JSON.stringify({ signal: "x".repeat(70_000) });
    const bodyHash = sha256hex(new TextEncoder().encode(oversizedBody));
    const signature = toHex(ed.sign(fromHex(bodyHash), alice.privateKey));

    res = await signedFetch(alice, "POST", "/content/publish", {
      tier: "flux.open",
      topic: "trading.signals",
      content_type: "signal",
      body: oversizedBody,
      body_hash: bodyHash,
      author_signature: signature,
    });

    expect(res.status).toBe(413);
    const payload = await json(res);
    expect(payload.error).toContain("Payload Too Large");
  });

  it("rejects publish from unregistered agents", async () => {
    const alice = new Agent();
    const body = JSON.stringify({ signal: "AAPL bullish" });
    const bodyHash = sha256hex(new TextEncoder().encode(body));
    const signature = toHex(ed.sign(fromHex(bodyHash), alice.privateKey));

    const res = await signedFetch(alice, "POST", "/content/publish", {
      tier: "flux.open",
      topic: "trading.signals",
      content_type: "signal",
      body,
      body_hash: bodyHash,
      author_signature: signature,
    });

    expect(res.status).toBe(404);
  });

  it("rejects sealed publish with invalid nonce length", async () => {
    const alice = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);

    const ciphertext = new Uint8Array([11, 22, 33]);
    const badNonce = new Uint8Array(16).fill(9); // must be 24 bytes
    const bodyHash = sha256hex(ciphertext);
    const signature = toHex(ed.sign(fromHex(bodyHash), alice.privateKey));

    res = await signedFetch(alice, "POST", "/content/publish", {
      tier: "flux.sealed",
      topic: "trading.options",
      content_type: "signal",
      encrypted_body: Buffer.from(ciphertext).toString("base64"),
      nonce: Buffer.from(badNonce).toString("base64"),
      body_hash: bodyHash,
      author_signature: signature,
    });
    expect(res.status).toBe(400);
  });

  it("charges T0 buyer only once across repeated key requests", async () => {
    const alice = new Agent();
    const bob = new Agent();

    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", "/agents/register");
    expect(res.status).toBe(201);

    res = await signedFetch(bob, "POST", "/agents/deposit", { amount: 100_000 });
    expect(res.status).toBe(200);

    const ciphertext = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const nonce = new Uint8Array(24).fill(7);
    const bodyHash = sha256hex(ciphertext);
    const signature = toHex(ed.sign(fromHex(bodyHash), alice.privateKey));

    res = await signedFetch(alice, "POST", "/content/publish", {
      tier: "T0",
      topic: "trading.premium",
      content_type: "signal",
      encrypted_body: Buffer.from(ciphertext).toString("base64"),
      nonce: Buffer.from(nonce).toString("base64"),
      body_hash: bodyHash,
      author_signature: signature,
      price_lamports: 10_000,
    });
    expect(res.status).toBe(201);
    const { cuid } = await json(res);

    res = await signedFetch(bob, "POST", `/content/${cuid}/request_key`, {
      requester_box_pubkey: bob.boxPubkeyBase64(),
    });
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", `/content/${cuid}/request_key`, {
      requester_box_pubkey: bob.boxPubkeyBase64(),
    });
    expect(res.status).toBe(201);

    const db = getDb();
    const countRow = db
      .query(
        "SELECT COUNT(*) AS n FROM ledger WHERE pubkey = ? AND reason = 'content_purchase' AND ref_id = ?"
      )
      .get(bob.pubkey, cuid) as { n: number };
    expect(countRow.n).toBe(1);
  });

  it("is idempotent under concurrent T0 key requests", async () => {
    const alice = new Agent();
    const bob = new Agent();

    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", "/agents/deposit", { amount: 100_000 });
    expect(res.status).toBe(200);

    const ciphertext = new Uint8Array([9, 9, 9, 9, 9, 9]);
    const nonce = new Uint8Array(24).fill(4);
    const bodyHash = sha256hex(ciphertext);
    const signature = toHex(ed.sign(fromHex(bodyHash), alice.privateKey));

    res = await signedFetch(alice, "POST", "/content/publish", {
      tier: "T0",
      topic: "trading.concurrent",
      content_type: "signal",
      encrypted_body: Buffer.from(ciphertext).toString("base64"),
      nonce: Buffer.from(nonce).toString("base64"),
      body_hash: bodyHash,
      author_signature: signature,
      price_lamports: 10_000,
    });
    expect(res.status).toBe(201);
    const { cuid } = await json(res);

    const requests = await Promise.all(
      Array.from({ length: 8 }).map(() =>
        signedFetch(bob, "POST", `/content/${cuid}/request_key`, {
          requester_box_pubkey: bob.boxPubkeyBase64(),
        })
      )
    );
    for (const r of requests) {
      expect([200, 201].includes(r.status)).toBe(true);
    }

    const db = getDb();
    const purchaseCount = db
      .query(
        "SELECT COUNT(*) AS n FROM ledger WHERE pubkey = ? AND reason = 'content_purchase' AND ref_id = ?"
      )
      .get(bob.pubkey, cuid) as { n: number };
    const keyReqCount = db
      .query(
        "SELECT COUNT(*) AS n FROM key_envelopes WHERE cuid = ? AND requester_pubkey = ?"
      )
      .get(cuid, bob.pubkey) as { n: number };

    expect(purchaseCount.n).toBe(1);
    expect(keyReqCount.n).toBe(1);
  });

  it("rejects T0 key request when buyer has insufficient balance", async () => {
    const alice = new Agent();
    const bob = new Agent();

    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", "/agents/register");
    expect(res.status).toBe(201);

    const ciphertext = new Uint8Array([7, 8, 9, 10]);
    const nonce = new Uint8Array(24).fill(1);
    const bodyHash = sha256hex(ciphertext);
    const signature = toHex(ed.sign(fromHex(bodyHash), alice.privateKey));

    res = await signedFetch(alice, "POST", "/content/publish", {
      tier: "T0",
      topic: "trading.premium",
      content_type: "signal",
      encrypted_body: Buffer.from(ciphertext).toString("base64"),
      nonce: Buffer.from(nonce).toString("base64"),
      body_hash: bodyHash,
      author_signature: signature,
      price_lamports: 1_000_000,
    });
    expect(res.status).toBe(201);
    const { cuid } = await json(res);

    res = await signedFetch(bob, "POST", `/content/${cuid}/request_key`, {
      requester_box_pubkey: bob.boxPubkeyBase64(),
    });
    expect(res.status).toBe(400);

    const db = getDb();
    const purchase = db
      .query("SELECT COUNT(*) AS n FROM ledger WHERE pubkey = ? AND reason = 'content_purchase'")
      .get(bob.pubkey) as { n: number };
    const keyReq = db
      .query("SELECT COUNT(*) AS n FROM key_envelopes WHERE cuid = ? AND requester_pubkey = ?")
      .get(cuid, bob.pubkey) as { n: number };

    expect(purchase.n).toBe(0);
    expect(keyReq.n).toBe(0);
  });

  it("rejects key exchange operations on flux.open", async () => {
    const alice = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);

    const body = JSON.stringify({ signal: "open info" });
    const bodyHash = sha256hex(new TextEncoder().encode(body));
    const signature = toHex(ed.sign(fromHex(bodyHash), alice.privateKey));
    res = await signedFetch(alice, "POST", "/content/publish", {
      tier: "flux.open",
      topic: "general",
      content_type: "note",
      body,
      body_hash: bodyHash,
      author_signature: signature,
    });
    expect(res.status).toBe(201);
    const { cuid } = await json(res);

    res = await signedFetch(alice, "POST", `/content/${cuid}/request_key`, {
      requester_box_pubkey: alice.boxPubkeyBase64(),
    });
    expect(res.status).toBe(400);
  });

  it("requires requester_box_pubkey on key requests", async () => {
    const alice = new Agent();
    const bob = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", "/agents/register");
    expect(res.status).toBe(201);

    const ciphertext = new Uint8Array([12, 13, 14]);
    const nonce = new Uint8Array(24).fill(6);
    const bodyHash = sha256hex(ciphertext);
    const signature = toHex(ed.sign(fromHex(bodyHash), alice.privateKey));
    res = await signedFetch(alice, "POST", "/content/publish", {
      tier: "flux.sealed",
      topic: "private",
      content_type: "signal",
      encrypted_body: Buffer.from(ciphertext).toString("base64"),
      nonce: Buffer.from(nonce).toString("base64"),
      body_hash: bodyHash,
      author_signature: signature,
    });
    expect(res.status).toBe(201);
    const { cuid } = await json(res);

    res = await signedFetch(bob, "POST", `/content/${cuid}/request_key`, {});
    expect(res.status).toBe(400);
  });

  it("keeps my_key pending until author delivery and blocks non-author delivery", async () => {
    const alice = new Agent();
    const bob = new Agent();
    const mallory = new Agent();

    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(mallory, "POST", "/agents/register");
    expect(res.status).toBe(201);

    const ciphertext = new Uint8Array([3, 4, 5, 6]);
    const nonce = new Uint8Array(24).fill(2);
    const bodyHash = sha256hex(ciphertext);
    const signature = toHex(ed.sign(fromHex(bodyHash), alice.privateKey));
    res = await signedFetch(alice, "POST", "/content/publish", {
      tier: "flux.sealed",
      topic: "private",
      content_type: "signal",
      encrypted_body: Buffer.from(ciphertext).toString("base64"),
      nonce: Buffer.from(nonce).toString("base64"),
      body_hash: bodyHash,
      author_signature: signature,
    });
    expect(res.status).toBe(201);
    const { cuid } = await json(res);

    res = await signedFetch(bob, "POST", `/content/${cuid}/request_key`, {
      requester_box_pubkey: bob.boxPubkeyBase64(),
    });
    expect(res.status).toBe(201);

    res = await signedFetch(alice, "GET", "/author/key_requests");
    expect(res.status).toBe(200);
    const requestsPayload = await json(res);
    expect(requestsPayload.requests.length).toBe(1);
    expect(requestsPayload.requests[0].requester_box_pubkey).toBe(
      bob.boxPubkeyBase64()
    );

    res = await signedFetch(bob, "GET", `/content/${cuid}/my_key`);
    expect(res.status).toBe(200);
    const pending = await json(res);
    expect(pending.status).toBe("pending");

    const fakeEnvelope = Buffer.from(new Uint8Array([1, 2, 3])).toString("base64");
    res = await signedFetch(mallory, "POST", `/content/${cuid}/deliver_key`, {
      requester_pubkey: bob.pubkey,
      envelope: fakeEnvelope,
    });
    expect(res.status).toBe(403);
  });

  it("expires claimed tasks after deadline and rejects late submit", async () => {
    const alice = new Agent();
    const bob = new Agent();

    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(alice, "POST", "/agents/deposit", { amount: 1_000_000 });
    expect(res.status).toBe(200);

    res = await signedFetch(alice, "POST", "/tasks/post", {
      task_type: "execution",
      instruction: "run task",
      bounty_lamports: 100_000,
      deadline_seconds: 30,
    });
    expect(res.status).toBe(201);
    const { task_id } = await json(res);

    res = await signedFetch(bob, "POST", `/tasks/${task_id}/claim`);
    expect(res.status).toBe(200);

    const db = getDb();
    db.query("UPDATE tasks SET deadline_at = ? WHERE task_id = ?").run(
      new Date(Date.now() - 60_000).toISOString(),
      task_id
    );

    res = await signedFetch(bob, "POST", `/tasks/${task_id}/submit`, {
      result: JSON.stringify({ ok: true }),
    });
    expect(res.status).toBe(410);

    const task = db.query("SELECT status FROM tasks WHERE task_id = ?").get(task_id) as {
      status: string;
    };
    expect(task.status).toBe("expired");
  });

  it("prevents task self-claim and non-claimer submit", async () => {
    const alice = new Agent();
    const bob = new Agent();
    const mallory = new Agent();

    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(mallory, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(alice, "POST", "/agents/deposit", { amount: 1_000_000 });
    expect(res.status).toBe(200);

    res = await signedFetch(alice, "POST", "/tasks/post", {
      task_type: "execution",
      instruction: "do something",
      bounty_lamports: 100_000,
      deadline_seconds: 60,
    });
    expect(res.status).toBe(201);
    const { task_id } = await json(res);

    res = await signedFetch(alice, "POST", `/tasks/${task_id}/claim`);
    expect(res.status).toBe(400);

    res = await signedFetch(bob, "POST", `/tasks/${task_id}/claim`);
    expect(res.status).toBe(200);

    res = await signedFetch(mallory, "POST", `/tasks/${task_id}/submit`, {
      result: JSON.stringify({ ok: true }),
    });
    expect(res.status).toBe(403);
  });

  it("expires overdue claimed tasks in the background worker and refunds poster", async () => {
    const alice = new Agent();
    const bob = new Agent();

    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(alice, "POST", "/agents/deposit", { amount: 500_000 });
    expect(res.status).toBe(200);

    res = await signedFetch(alice, "POST", "/tasks/post", {
      task_type: "execution",
      instruction: "expiring task",
      bounty_lamports: 100_000,
      deadline_seconds: 60,
    });
    expect(res.status).toBe(201);
    const { task_id } = await json(res);

    res = await signedFetch(bob, "POST", `/tasks/${task_id}/claim`);
    expect(res.status).toBe(200);

    const db = getDb();
    db.query("UPDATE tasks SET deadline_at = ? WHERE task_id = ?").run(
      new Date(Date.now() - 60_000).toISOString(),
      task_id
    );

    const expired = expireOverdueTasks();
    expect(expired).toBe(1);

    const task = db
      .query("SELECT status FROM tasks WHERE task_id = ?")
      .get(task_id) as { status: string };
    expect(task.status).toBe("expired");

    const refund = db
      .query(
        "SELECT COUNT(*) AS n FROM ledger WHERE pubkey = ? AND reason = 'task_bounty_refund' AND ref_id = ?"
      )
      .get(alice.pubkey, task_id) as { n: number };
    expect(refund.n).toBe(1);
  });

  it("marks dry-run anchors as anchored and does not re-anchor same content", async () => {
    const alice = new Agent();

    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);

    const body = JSON.stringify({ signal: "MSFT momentum" });
    const bodyHash = sha256hex(new TextEncoder().encode(body));
    const signature = toHex(ed.sign(fromHex(bodyHash), alice.privateKey));

    res = await signedFetch(alice, "POST", "/content/publish", {
      tier: "flux.open",
      topic: "trading.signals",
      content_type: "signal",
      body,
      body_hash: bodyHash,
      author_signature: signature,
    });
    expect(res.status).toBe(201);
    const { cuid } = await json(res);

    const first = await anchorHashes();
    expect(first).not.toBeNull();
    expect(first?.txSignature).toBe("dry-run");

    const second = await anchorHashes();
    expect(second).toBeNull();

    const db = getDb();
    const row = db
      .query(
        "SELECT COUNT(*) AS n, MAX(tx_signature) AS txsig FROM hash_anchors WHERE COALESCE(tx_signature, '') <> ''"
      )
      .get() as { n: number; txsig: string };
    expect(row.n).toBe(1);
    expect(row.txsig).toBe("dry-run");

    res = await signedFetch(alice, "GET", `/content/${cuid}/verify`);
    expect(res.status).toBe(200);
    const verifyPayload = await json(res);
    expect(verifyPayload.anchor).not.toBeNull();
    expect(verifyPayload.anchor.merkle_proof).not.toBeNull();
    const proof = verifyPayload.anchor.merkle_proof;
    expect(
      verifyMerkleProof(
        proof.leaf_hash,
        {
          leaf_index: proof.leaf_index,
          siblings: proof.siblings,
          root: verifyPayload.anchor.merkle_root,
        },
        verifyPayload.anchor.merkle_root
      )
    ).toBe(true);
  });

  it("returns deterministic merkle roots and preserves odd leaf promotion", () => {
    const leafA = "aa".repeat(32);
    const leafB = "bb".repeat(32);
    const leafC = "cc".repeat(32);

    const root1 = buildMerkleRoot([leafA, leafB, leafC]);
    const root2 = buildMerkleRoot([leafA, leafB, leafC]);
    const rootShuffled = buildMerkleRoot([leafB, leafA, leafC]);

    expect(root1).toBe(root2);
    expect(root1).not.toBe(rootShuffled);
    expect(root1.length).toBe(64);
  });

  it("uses exact CUID membership for anchor lookup in verify endpoint", async () => {
    const alice = new Agent();

    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);

    const body = JSON.stringify({ signal: "anchor check" });
    const bodyHash = sha256hex(new TextEncoder().encode(body));
    const signature = toHex(ed.sign(fromHex(bodyHash), alice.privateKey));

    res = await signedFetch(alice, "POST", "/content/publish", {
      tier: "flux.open",
      topic: "anchors",
      content_type: "signal",
      body,
      body_hash: bodyHash,
      author_signature: signature,
    });
    expect(res.status).toBe(201);
    const { cuid } = await json(res);

    const db = getDb();
    const partial = cuid.slice(0, 8);
    db.query(
      "INSERT INTO hash_anchors (merkle_root, tx_signature, cuid_list, anchored_at) VALUES (?, ?, ?, datetime('now'))"
    ).run("11".repeat(32), "tx-partial", JSON.stringify([partial]));

    res = await signedFetch(alice, "GET", `/content/${cuid}/verify`);
    expect(res.status).toBe(200);
    const payload = await json(res);
    expect(payload.anchor).toBeNull();
  });

  // ── Rate limiting tests ──

  it("enforces per-user daily publish limit (rejects at 11th)", async () => {
    const alice = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);

    // Publish 10 items (the default limit)
    for (let i = 0; i < 10; i++) {
      res = await signedFetch(
        alice,
        "POST",
        "/content/publish",
        openPublishBody(alice, `signal ${i}`)
      );
      expect(res.status).toBe(201);
    }

    // 11th should be rejected with 429
    res = await signedFetch(
      alice,
      "POST",
      "/content/publish",
      openPublishBody(alice, "signal 10 — should fail")
    );
    expect(res.status).toBe(429);
    const body = await json(res);
    expect(body.error).toContain("Daily publish limit");
  });

  it("publish limit is per-user — different agents have separate counters", async () => {
    const alice = new Agent();
    const bob = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", "/agents/register");
    expect(res.status).toBe(201);

    // Alice publishes 10
    for (let i = 0; i < 10; i++) {
      res = await signedFetch(
        alice,
        "POST",
        "/content/publish",
        openPublishBody(alice, `alice-${i}`)
      );
      expect(res.status).toBe(201);
    }

    // Alice is capped
    res = await signedFetch(
      alice,
      "POST",
      "/content/publish",
      openPublishBody(alice, "alice overflow")
    );
    expect(res.status).toBe(429);

    // Bob can still publish
    res = await signedFetch(
      bob,
      "POST",
      "/content/publish",
      openPublishBody(bob, "bob-0")
    );
    expect(res.status).toBe(201);
  });

  // ── Additional robustness tests ──

  it("rejects duplicate agent registration", async () => {
    const alice = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);

    res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(409);
  });

  it("rejects deposit for unregistered agent", async () => {
    const alice = new Agent();
    const res = await signedFetch(alice, "POST", "/agents/deposit", { amount: 1000 });
    expect(res.status).toBe(404);
  });

  it("rejects negative and zero deposit amounts", async () => {
    const alice = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);

    res = await signedFetch(alice, "POST", "/agents/deposit", { amount: 0 });
    expect(res.status).toBe(400);

    res = await signedFetch(alice, "POST", "/agents/deposit", { amount: -100 });
    expect(res.status).toBe(400);
  });

  it("rejects rating the same content twice", async () => {
    const alice = new Agent();
    const bob = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", "/agents/register");
    expect(res.status).toBe(201);

    res = await signedFetch(
      alice,
      "POST",
      "/content/publish",
      openPublishBody(alice, "rateable")
    );
    expect(res.status).toBe(201);
    const { cuid } = await json(res);

    res = await signedFetch(bob, "POST", `/content/${cuid}/rate`, {
      relevance: 0.8,
      useful: 1,
    });
    expect(res.status).toBe(200);

    // Second rating should be rejected
    res = await signedFetch(bob, "POST", `/content/${cuid}/rate`, {
      relevance: 0.5,
      useful: 0,
    });
    expect(res.status).toBe(409);
  });

  it("rejects rating with out-of-range values", async () => {
    const alice = new Agent();
    const bob = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", "/agents/register");
    expect(res.status).toBe(201);

    res = await signedFetch(
      alice,
      "POST",
      "/content/publish",
      openPublishBody(alice, "bad rating target")
    );
    expect(res.status).toBe(201);
    const { cuid } = await json(res);

    res = await signedFetch(bob, "POST", `/content/${cuid}/rate`, {
      relevance: 1.5,
      useful: 1,
    });
    expect(res.status).toBe(400);

    res = await signedFetch(bob, "POST", `/content/${cuid}/rate`, {
      relevance: 0.5,
      useful: 2,
    });
    expect(res.status).toBe(400);
  });

  it("rejects rating nonexistent content", async () => {
    const bob = new Agent();
    let res = await signedFetch(bob, "POST", "/agents/register");
    expect(res.status).toBe(201);

    res = await signedFetch(bob, "POST", "/content/fakecuid123/rate", {
      relevance: 0.5,
      useful: 1,
    });
    expect(res.status).toBe(404);
  });

  it("rejects task post with insufficient balance", async () => {
    const alice = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    // No deposit — balance is 0

    res = await signedFetch(alice, "POST", "/tasks/post", {
      task_type: "execution",
      instruction: "do thing",
      bounty_lamports: 100_000,
      deadline_seconds: 60,
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain("Insufficient balance");
  });

  it("rolls back bounty hold when task creation fails", async () => {
    const alice = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);

    res = await signedFetch(alice, "POST", "/agents/deposit", { amount: 500_000 });
    expect(res.status).toBe(200);

    res = await signedFetch(alice, "POST", "/tasks/post", {
      task_type: "execution",
      instruction: "do thing",
      source_cuid: "nonexistent-cuid",
      bounty_lamports: 100_000,
      deadline_seconds: 60,
    });
    expect(res.status).toBe(400);

    const db = getDb();
    const agent = db
      .query("SELECT balance FROM agents WHERE pubkey = ?")
      .get(alice.pubkey) as { balance: number };
    expect(agent.balance).toBe(500_000);

    const taskHolds = db
      .query("SELECT COUNT(*) as cnt FROM ledger WHERE pubkey = ? AND reason = 'task_bounty_hold'")
      .get(alice.pubkey) as { cnt: number };
    expect(taskHolds.cnt).toBe(0);
  });

  it("rejects claiming an already-claimed task", async () => {
    const alice = new Agent();
    const bob = new Agent();
    const charlie = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(charlie, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(alice, "POST", "/agents/deposit", { amount: 500_000 });
    expect(res.status).toBe(200);

    res = await signedFetch(alice, "POST", "/tasks/post", {
      task_type: "execution",
      instruction: "do thing",
      bounty_lamports: 100_000,
      deadline_seconds: 300,
    });
    expect(res.status).toBe(201);
    const { task_id } = await json(res);

    res = await signedFetch(bob, "POST", `/tasks/${task_id}/claim`);
    expect(res.status).toBe(200);

    // Charlie tries to claim the same task
    res = await signedFetch(charlie, "POST", `/tasks/${task_id}/claim`);
    expect(res.status).toBe(409);
  });

  it("returns 404 for nonexistent content and task", async () => {
    const alice = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);

    res = await signedFetch(alice, "GET", "/content/nonexistent123");
    expect(res.status).toBe(404);

    res = await signedFetch(alice, "GET", "/tasks/nonexistent456");
    expect(res.status).toBe(404);
  });

  it("rejects T0 publish with zero price", async () => {
    const alice = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);

    res = await signedFetch(
      alice,
      "POST",
      "/content/publish",
      sealedPublishBody(alice, { tier: "T0", price: 0 })
    );
    expect(res.status).toBe(400);
  });

  it("rejects flux.open with encrypted_body or sealed with plaintext body", async () => {
    const alice = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);

    // flux.open with encrypted_body
    const ciphertext = nacl.randomBytes(16);
    const nonce = nacl.randomBytes(24);
    const bodyHash = sha256hex(ciphertext);
    const sig = toHex(ed.sign(fromHex(bodyHash), alice.privateKey));
    res = await signedFetch(alice, "POST", "/content/publish", {
      tier: "flux.open",
      topic: "test",
      body: "plaintext",
      encrypted_body: Buffer.from(ciphertext).toString("base64"),
      nonce: Buffer.from(nonce).toString("base64"),
      body_hash: bodyHash,
      author_signature: sig,
    });
    expect(res.status).toBe(400);

    // flux.sealed with plaintext body
    const plainBody = JSON.stringify({ x: 1 });
    const plainHash = sha256hex(new TextEncoder().encode(plainBody));
    const plainSig = toHex(ed.sign(fromHex(plainHash), alice.privateKey));
    res = await signedFetch(alice, "POST", "/content/publish", {
      tier: "flux.sealed",
      topic: "test",
      body: plainBody,
      encrypted_body: Buffer.from(ciphertext).toString("base64"),
      nonce: Buffer.from(nonce).toString("base64"),
      body_hash: plainHash,
      author_signature: plainSig,
    });
    expect(res.status).toBe(400);
  });

  it("query excludes expired content", async () => {
    const alice = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);

    res = await signedFetch(alice, "POST", "/content/publish", {
      ...openPublishBody(alice, "will expire"),
      ttl_seconds: 1,
    });
    expect(res.status).toBe(201);
    const { cuid } = await json(res);

    // Manually backdate created_at and expires_at
    const db = getDb();
    db.query(
      "UPDATE content SET created_at = datetime('now', '-2 days'), expires_at = datetime('now', '-1 day') WHERE cuid = ?"
    ).run(cuid);

    res = await signedFetch(alice, "GET", "/content/query?topic=testing");
    expect(res.status).toBe(200);
    const results = await json(res);
    const found = results.results.find((r: any) => r.cuid === cuid);
    expect(found).toBeUndefined();
  });

  it("query_count increments on each content fetch", async () => {
    const alice = new Agent();
    const bob = new Agent();
    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", "/agents/register");
    expect(res.status).toBe(201);

    res = await signedFetch(
      alice,
      "POST",
      "/content/publish",
      openPublishBody(alice, "count me")
    );
    expect(res.status).toBe(201);
    const { cuid } = await json(res);

    // Fetch 3 times
    await signedFetch(bob, "GET", `/content/${cuid}`);
    await signedFetch(bob, "GET", `/content/${cuid}`);
    await signedFetch(bob, "GET", `/content/${cuid}`);

    const db = getDb();
    const row = db
      .query("SELECT query_count FROM content WHERE cuid = ?")
      .get(cuid) as { query_count: number };
    expect(row.query_count).toBe(3);
  });

  it("task settlement credits correct amounts with node fee", async () => {
    const alice = new Agent();
    const bob = new Agent();
    const operator = new Agent();

    process.env.NODE_OPERATOR_PUBKEY = operator.pubkey;

    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(operator, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(alice, "POST", "/agents/deposit", { amount: 1_000_000 });
    expect(res.status).toBe(200);

    res = await signedFetch(alice, "POST", "/tasks/post", {
      task_type: "execution",
      instruction: "test fee",
      bounty_lamports: 100_000,
      deadline_seconds: 300,
    });
    expect(res.status).toBe(201);
    const { task_id } = await json(res);

    res = await signedFetch(bob, "POST", `/tasks/${task_id}/claim`);
    expect(res.status).toBe(200);

    res = await signedFetch(bob, "POST", `/tasks/${task_id}/submit`, {
      result: JSON.stringify({ done: true }),
    });
    expect(res.status).toBe(200);
    const result = await json(res);

    // 1% fee on 100_000 = 1000
    expect(result.fee).toBe(1000);
    expect(result.payout).toBe(99000);

    const db = getDb();
    const bobBalance = db
      .query("SELECT balance FROM agents WHERE pubkey = ?")
      .get(bob.pubkey) as { balance: number };
    expect(bobBalance.balance).toBe(99000);

    const operatorBalance = db
      .query("SELECT balance FROM agents WHERE pubkey = ?")
      .get(operator.pubkey) as { balance: number };
    expect(operatorBalance.balance).toBe(1000);

    process.env.NODE_OPERATOR_PUBKEY = "";
  });

  it("settles tasks even when the configured operator account is not registered", async () => {
    const alice = new Agent();
    const bob = new Agent();

    process.env.NODE_OPERATOR_PUBKEY = "ab".repeat(32);

    let res = await signedFetch(alice, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(bob, "POST", "/agents/register");
    expect(res.status).toBe(201);
    res = await signedFetch(alice, "POST", "/agents/deposit", { amount: 500_000 });
    expect(res.status).toBe(200);

    res = await signedFetch(alice, "POST", "/tasks/post", {
      task_type: "execution",
      instruction: "do thing",
      bounty_lamports: 100_000,
      deadline_seconds: 300,
    });
    expect(res.status).toBe(201);
    const { task_id } = await json(res);

    res = await signedFetch(bob, "POST", `/tasks/${task_id}/claim`);
    expect(res.status).toBe(200);

    res = await signedFetch(bob, "POST", `/tasks/${task_id}/submit`, {
      result: "done",
    });
    expect(res.status).toBe(200);
    const payload = await json(res);
    expect(payload.fee).toBe(0);
    expect(payload.payout).toBe(100_000);

    const db = getDb();
    const task = db
      .query("SELECT status FROM tasks WHERE task_id = ?")
      .get(task_id) as { status: string };
    expect(task.status).toBe("completed");

    const bobBalance = db
      .query("SELECT balance FROM agents WHERE pubkey = ?")
      .get(bob.pubkey) as { balance: number };
    expect(bobBalance.balance).toBe(100_000);

    process.env.NODE_OPERATOR_PUBKEY = "";
  });
});
