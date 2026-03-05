#!/usr/bin/env bun
/**
 * x402 Client Demo — full pay-for-content flow
 *
 * Start the server first:
 *   X402_ENABLED=true X402_PAY_TO=EiGrpvErat2fQLFdx2W9GKUCGRdrQfdv1jtqBN2rCjYU PORT=3098 bun run dev
 *
 * Then run this script:
 *   bun run scripts/x402-client.ts
 *
 * Requires USDC in ~/.config/solana/id.json wallet.
 * For devnet testing, get USDC at https://faucet.circle.com/
 */

import { readFileSync } from "fs";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import nacl from "tweetnacl";
import { createKeyPairSignerFromBytes } from "@solana/signers";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const BASE = process.env.BASE_URL ?? "http://localhost:3098";

// ── Helpers ────────────────────────────────────────────

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

// ── Agent identity (ed25519 keypair for SolSign auth) ──

class Agent {
  privateKey: Uint8Array;
  pubkey: string;
  boxKeyPair: nacl.BoxKeyPair;

  constructor(privateKey?: Uint8Array) {
    this.privateKey = privateKey ?? ed.utils.randomPrivateKey();
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
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<Response> {
  const ts = Date.now().toString();
  const n = toHex(nacl.randomBytes(16));
  const sig = agent.sign(method, path, ts, n);
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `SolSign ${agent.pubkey}:${sig}:${ts}:${n}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── Main flow ──────────────────────────────────────────

async function main() {
  console.log(`\n[x402-client] Connecting to ${BASE}\n`);

  // Check server
  const healthRes = await fetch(`${BASE}/health`).catch(() => null);
  if (!healthRes?.ok) {
    console.error("Server not reachable. Start it with:");
    console.error(
      "  X402_ENABLED=true X402_PAY_TO=EiGrpvErat2fQLFdx2W9GKUCGRdrQfdv1jtqBN2rCjYU PORT=3098 bun run dev"
    );
    process.exit(1);
  }

  const info = (await (await fetch(`${BASE}/node/info`)).json()) as any;
  console.log("[server] payment_mode:", info.payment_mode, "| network:", info.x402_network);
  if (info.payment_mode !== "x402") {
    console.error("Server not in x402 mode. Set X402_ENABLED=true");
    process.exit(1);
  }

  // ── Load buyer wallet (Solana keypair with USDC) ──
  const keypairBytes = new Uint8Array(
    JSON.parse(readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8"))
  );
  const buyerPrivateKey = keypairBytes.slice(0, 32); // ed25519 seed
  const bob = new Agent(buyerPrivateKey);

  const signer = await createKeyPairSignerFromBytes(keypairBytes);
  console.log(`\n[bob] Agent pubkey: ${bob.pubkey.slice(0, 16)}…`);
  console.log(`[bob] Solana address: ${signer.address}`);

  // Create x402 payment client
  const client = new x402Client();
  registerExactSvmScheme(client, { signer });
  const httpClient = new x402HTTPClient(client);

  // ── 1. Register agents ───────────────────────────────
  const alice = new Agent();
  console.log(`[alice] Agent pubkey: ${alice.pubkey.slice(0, 16)}…`);

  let res = await signedFetch(alice, "POST", "/agents/register");
  console.log(`\n[step 1] Alice registered: ${res.status}`);

  res = await signedFetch(bob, "POST", "/agents/register");
  console.log(`[step 2] Bob registered: ${res.status}`);

  // ── 2. Alice publishes T0 content ────────────────────
  const ciphertext = nacl.randomBytes(64);
  const nonce = nacl.randomBytes(24);
  const bodyHash = sha256hex(ciphertext);
  const authorSig = toHex(ed.sign(fromHex(bodyHash), alice.privateKey));

  res = await signedFetch(alice, "POST", "/content/publish", {
    tier: "T0",
    topic: "x402.demo",
    content_type: "signal",
    encrypted_body: Buffer.from(ciphertext).toString("base64"),
    nonce: Buffer.from(nonce).toString("base64"),
    body_hash: bodyHash,
    author_signature: authorSig,
    price_lamports: 100_000, // ~$0.015 USDC at $150/SOL
  });
  const { cuid } = (await res.json()) as { cuid: string };
  console.log(`[step 3] T0 content published: ${cuid} (${res.status})`);

  // ── 3. Bob requests key — should get 402 ─────────────
  const keyPath = `/content/${cuid}/request_key`;
  const keyBody = {
    requester_box_pubkey: Buffer.from(bob.boxKeyPair.publicKey).toString("base64"),
  };

  res = await signedFetch(bob, "POST", keyPath, keyBody);
  console.log(`\n[step 4] request_key without payment → ${res.status}`);

  if (res.status !== 402) {
    console.error("  Expected 402! Got:", await res.text());
    process.exit(1);
  }

  // ── 4. Parse payment requirements ────────────────────
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => res.headers.get(name)
  );
  const req = (paymentRequired as any).accepts?.[0];
  console.log("  scheme:", req?.scheme);
  console.log("  network:", req?.network);
  console.log("  payTo:", req?.payTo);
  console.log("  amount:", req?.amount, "USDC base units");
  console.log("  feePayer:", req?.extra?.feePayer);

  // ── 5. Create payment payload + sign Solana tx ───────
  console.log("\n[step 5] Creating USDC transfer on Solana...");
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
  console.log("  Payment signed ✓ (header: PAYMENT-SIGNATURE)");

  // ── 6. Retry with payment ────────────────────────────
  console.log("\n[step 6] Retrying request_key with X-PAYMENT header...");
  res = await signedFetch(bob, "POST", keyPath, keyBody, paymentHeaders);
  const result = await res.json();
  console.log(`  Status: ${res.status}`);
  console.log("  Response:", JSON.stringify(result, null, 2));

  if (res.status === 201) {
    console.log("\n✅ Bob paid for T0 content via x402 and got key access!");
  } else {
    console.log("\n❌ Unexpected result — check server logs");
  }
}

main().catch((e) => {
  console.error("\nFatal:", e.message ?? e);
  process.exit(1);
});
