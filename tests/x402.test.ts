import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";

// x402 middleware syncs with facilitator on first request — allow extra time
setDefaultTimeout(15_000);
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import nacl from "tweetnacl";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const dataDir = join(
  import.meta.dir,
  `tmp-x402-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
);
mkdirSync(dataDir, { recursive: true });

// Enable x402 mode BEFORE importing server
process.env.DATA_DIR = dataDir;
process.env.ANCHOR_INTERVAL_MS = "0";
process.env.AUTH_NONCE_PRUNE_INTERVAL_MS = "0";
process.env.TASK_EXPIRY_INTERVAL_MS = "0";
process.env.PORT = "3098";
process.env.X402_ENABLED = "true";
process.env.X402_PAY_TO = "EiGrpvErat2fQLFdx2W9GKUCGRdrQfdv1jtqBN2rCjYU";
process.env.X402_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // devnet test network

const { default: server } = await import(`../src/index?x402=${Date.now()}`);
const { closeDb } = await import("../src/db");

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
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

class Agent {
  privateKey: Uint8Array;
  pubkey: string;
  boxKeyPair: nacl.BoxKeyPair;

  constructor() {
    this.privateKey = ed.utils.randomPrivateKey();
    this.pubkey = toHex(ed.getPublicKey(this.privateKey));
    this.boxKeyPair = nacl.box.keyPair();
  }

  sign(method: string, path: string, timestamp: string, nonce: string): string {
    const msg = `${method}:${path}:${timestamp}:${nonce}`;
    const sig = ed.sign(new TextEncoder().encode(msg), this.privateKey);
    return toHex(sig);
  }
}

async function signedFetch(
  agent: Agent,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const ts = Date.now().toString();
  const n = toHex(nacl.randomBytes(16));
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
    topic: "testing.x402",
    content_type: "signal",
    encrypted_body: Buffer.from(ciphertext).toString("base64"),
    nonce: Buffer.from(nonce).toString("base64"),
    body_hash: bodyHash,
    author_signature: signature,
    price_lamports: opts.price ?? 0,
  };
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("x402 payment integration", () => {
  it("node/info reports x402 payment mode", async () => {
    const res = await server.fetch(new Request("http://localhost/node/info"));
    const info = await res.json();
    expect(info.payment_mode).toBe("x402");
    expect(info.x402_network).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  });

  it("request_key for flux.sealed is free (x402 grants access)", async () => {
    const alice = new Agent();
    const bob = new Agent();

    await signedFetch(alice, "POST", "/agents/register");
    await signedFetch(bob, "POST", "/agents/register");

    const pub = sealedPublishBody(alice, { tier: "flux.sealed" });
    const pubRes = await signedFetch(alice, "POST", "/content/publish", pub);
    expect(pubRes.status).toBe(201);
    const { cuid } = (await pubRes.json()) as { cuid: string };

    // Request key for sealed content — should be free even with x402 enabled
    const keyRes = await signedFetch(bob, "POST", `/content/${cuid}/request_key`, {
      requester_box_pubkey: Buffer.from(bob.boxKeyPair.publicKey).toString("base64"),
    });
    expect(keyRes.status).toBe(201);
    const keyData = await keyRes.json();
    expect((keyData as any).status).toBe("pending");
  });

  it("request_key for T0 returns 402 Payment Required without payment", async () => {
    const alice = new Agent();
    const bob = new Agent();

    await signedFetch(alice, "POST", "/agents/register");
    await signedFetch(bob, "POST", "/agents/register");

    const pub = sealedPublishBody(alice, { tier: "T0", price: 100_000 });
    const pubRes = await signedFetch(alice, "POST", "/content/publish", pub);
    expect(pubRes.status).toBe(201);
    const { cuid } = (await pubRes.json()) as { cuid: string };

    // Request key for T0 content without x402 payment — should get 402
    const keyRes = await signedFetch(bob, "POST", `/content/${cuid}/request_key`, {
      requester_box_pubkey: Buffer.from(bob.boxKeyPair.publicKey).toString("base64"),
    });
    expect(keyRes.status).toBe(402);

    // x402 v2: payment requirements are in the Payment-Required header (base64 JSON)
    const paymentHeader = keyRes.headers.get("payment-required");
    expect(paymentHeader).toBeTruthy();
    const payReq = JSON.parse(Buffer.from(paymentHeader!, "base64").toString());
    expect(payReq.x402Version).toBe(2);
    expect(payReq.accepts).toBeDefined();
    expect(Array.isArray(payReq.accepts)).toBe(true);
    expect(payReq.accepts.length).toBeGreaterThan(0);

    // Check the payment requirements include Solana and correct payTo
    const req = payReq.accepts[0];
    expect(req.scheme).toBe("exact");
    expect(req.network).toContain("solana");
    expect(req.payTo).toBe("EiGrpvErat2fQLFdx2W9GKUCGRdrQfdv1jtqBN2rCjYU");
  });

  it("T0 402 response includes non-zero price (lamports conversion)", async () => {
    const alice = new Agent();
    const bob = new Agent();

    await signedFetch(alice, "POST", "/agents/register");
    await signedFetch(bob, "POST", "/agents/register");

    const pub = sealedPublishBody(alice, { tier: "T0", price: 100_000 });
    const pubRes = await signedFetch(alice, "POST", "/content/publish", pub);
    const { cuid } = (await pubRes.json()) as { cuid: string };

    const keyRes = await signedFetch(bob, "POST", `/content/${cuid}/request_key`, {
      requester_box_pubkey: Buffer.from(bob.boxKeyPair.publicKey).toString("base64"),
    });
    expect(keyRes.status).toBe(402);

    const paymentHeader = keyRes.headers.get("payment-required");
    const payReq = JSON.parse(Buffer.from(paymentHeader!, "base64").toString());
    // amount should be 15000 (100,000 lamports × $150/SOL / 1e9 × 1e6 USDC decimals)
    expect(Number(payReq.accepts[0].amount)).toBe(15000);
  });

  it("T0 with price_usdc uses native USDC pricing (no lamports conversion)", async () => {
    const alice = new Agent();
    const bob = new Agent();

    await signedFetch(alice, "POST", "/agents/register");
    await signedFetch(bob, "POST", "/agents/register");

    // Publish with price_usdc = 50000 base units ($0.05 USDC) and no lamports price
    const pub = sealedPublishBody(alice, { tier: "T0", price: 0 });
    (pub as any).price_usdc = 50_000;
    const pubRes = await signedFetch(alice, "POST", "/content/publish", pub);
    expect(pubRes.status).toBe(201);
    const { cuid } = (await pubRes.json()) as { cuid: string };

    const keyRes = await signedFetch(bob, "POST", `/content/${cuid}/request_key`, {
      requester_box_pubkey: Buffer.from(bob.boxKeyPair.publicKey).toString("base64"),
    });
    expect(keyRes.status).toBe(402);

    const paymentHeader = keyRes.headers.get("payment-required");
    const payReq = JSON.parse(Buffer.from(paymentHeader!, "base64").toString());
    // price_usdc takes precedence over lamports conversion
    expect(Number(payReq.accepts[0].amount)).toBe(50000);
  });

  it("GET /content/:cuid is NOT gated by x402 (ciphertext is public)", async () => {
    const alice = new Agent();
    await signedFetch(alice, "POST", "/agents/register");

    const pub = sealedPublishBody(alice, { tier: "T0", price: 100_000 });
    const pubRes = await signedFetch(alice, "POST", "/content/publish", pub);
    const { cuid } = (await pubRes.json()) as { cuid: string };

    // GET content should still work — only request_key is gated
    const getRes = await signedFetch(alice, "GET", `/content/${cuid}`);
    expect(getRes.status).toBe(200);
    const data = (await getRes.json()) as any;
    expect(data.tier).toBe("T0");
    expect(data.encrypted_body).toBeDefined();
  });
});
