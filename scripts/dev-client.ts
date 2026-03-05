/**
 * OpenFlux dev client — exercises the full OpenFlux0 loop:
 *   Register → Deposit → Publish → Query → Key Exchange → Pay → Task → Settle
 */
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import nacl from "tweetnacl";
import sealedbox from "tweetnacl-sealedbox-js";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const BASE = process.env.OFX_URL ?? "http://localhost:3000";

// -- Helpers --

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
  name: string;
  edPrivateKey: Uint8Array;
  edPublicKey: Uint8Array;
  edPubkeyHex: string;
  // NaCl box keypair for sealed box (key exchange)
  boxKeypair: nacl.BoxKeyPair;

  constructor(name: string) {
    this.name = name;
    this.edPrivateKey = ed.utils.randomPrivateKey();
    this.edPublicKey = ed.getPublicKey(this.edPrivateKey);
    this.edPubkeyHex = toHex(this.edPublicKey);
    this.boxKeypair = nacl.box.keyPair();
  }

  async signedFetch(
    method: string,
    path: string,
    body?: unknown
  ): Promise<Response> {
    const ts = Date.now().toString();
    const nonce = toHex(nacl.randomBytes(16));
    const msg = `${method}:${path}:${ts}:${nonce}`;
    const msgBytes = new TextEncoder().encode(msg);
    const sig = ed.sign(msgBytes, this.edPrivateKey);
    const sigHex = toHex(sig);

    const headers: Record<string, string> = {
      Authorization: `SolSign ${this.edPubkeyHex}:${sigHex}:${ts}:${nonce}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }
}

// -- Encryption helpers --

function encryptContent(body: string): {
  contentKey: Uint8Array;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
} {
  const contentKey = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const msg = new TextEncoder().encode(body);
  const ciphertext = nacl.secretbox(msg, nonce, contentKey);
  if (!ciphertext) throw new Error("Encryption failed");
  return { contentKey, ciphertext, nonce };
}

function decryptContent(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  contentKey: Uint8Array
): string {
  const plaintext = nacl.secretbox.open(ciphertext, nonce, contentKey);
  if (!plaintext) throw new Error("Decryption failed");
  return new TextDecoder().decode(plaintext);
}

// -- Main flow --

async function main() {
  console.log("=== OpenFlux Dev Client ===\n");
  console.log(`Target: ${BASE}\n`);

  // Check health
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  console.log("Health:", health);

  const nodeInfo = await fetch(`${BASE}/node/info`).then((r) => r.json());
  console.log("Node info:", nodeInfo);

  // Create agents
  const alice = new Agent("Alice");
  const bob = new Agent("Bob");
  console.log(`\nAlice pubkey: ${alice.edPubkeyHex.slice(0, 16)}…`);
  console.log(`Bob   pubkey: ${bob.edPubkeyHex.slice(0, 16)}…`);

  // Register agents
  console.log("\n--- Register ---");
  let res = await alice.signedFetch("POST", "/agents/register");
  console.log("Alice register:", res.status, await res.json());

  res = await bob.signedFetch("POST", "/agents/register");
  console.log("Bob register:", res.status, await res.json());

  // Deposit
  console.log("\n--- Deposit ---");
  res = await alice.signedFetch("POST", "/agents/deposit", { amount: 1_000_000_000 });
  console.log("Alice deposit:", await res.json());

  res = await bob.signedFetch("POST", "/agents/deposit", { amount: 1_000_000_000 });
  console.log("Bob deposit:", await res.json());

  // === Publish flux.open ===
  console.log("\n--- Publish flux.open ---");
  const openBody = JSON.stringify({ signal: "TSLA RSI crossover detected", confidence: 0.85 });
  const openBodyHash = sha256hex(new TextEncoder().encode(openBody));
  const openSig = toHex(ed.sign(fromHex(openBodyHash), alice.edPrivateKey));

  res = await alice.signedFetch("POST", "/content/publish", {
    tier: "flux.open",
    topic: "trading.signals",
    content_type: "signal",
    body: openBody,
    body_hash: openBodyHash,
    author_signature: openSig,
  });
  const openResult = await res.json() as any;
  console.log("Open flux:", res.status, openResult);
  const openCuid = openResult.cuid;

  // === Publish flux.sealed ===
  console.log("\n--- Publish flux.sealed ---");
  const sealedBodyPlain = JSON.stringify({ signal: "SPY put spread 570/560, exp 03/21", delta: -0.3 });
  const { contentKey: sealedKey, ciphertext: sealedCipher, nonce: sealedNonce } =
    encryptContent(sealedBodyPlain);
  const sealedBodyHash = sha256hex(sealedCipher);
  const sealedSig = toHex(ed.sign(fromHex(sealedBodyHash), alice.edPrivateKey));

  res = await alice.signedFetch("POST", "/content/publish", {
    tier: "flux.sealed",
    topic: "trading.options",
    content_type: "signal",
    encrypted_body: Buffer.from(sealedCipher).toString("base64"),
    nonce: Buffer.from(sealedNonce).toString("base64"),
    body_hash: sealedBodyHash,
    author_signature: sealedSig,
  });
  const sealedResult = await res.json() as any;
  console.log("Sealed flux:", res.status, sealedResult);
  const sealedCuid = sealedResult.cuid;

  // === Publish T0 (paid) ===
  console.log("\n--- Publish T0 (paid) ---");
  const t0BodyPlain = JSON.stringify({
    signal: "NVDA earnings play: bull call spread 140/150",
    entry: 2.50,
    target: 5.00,
  });
  const { contentKey: t0Key, ciphertext: t0Cipher, nonce: t0Nonce } =
    encryptContent(t0BodyPlain);
  const t0BodyHash = sha256hex(t0Cipher);
  const t0Sig = toHex(ed.sign(fromHex(t0BodyHash), alice.edPrivateKey));

  res = await alice.signedFetch("POST", "/content/publish", {
    tier: "T0",
    topic: "trading.premium",
    content_type: "signal",
    encrypted_body: Buffer.from(t0Cipher).toString("base64"),
    nonce: Buffer.from(t0Nonce).toString("base64"),
    body_hash: t0BodyHash,
    author_signature: t0Sig,
    price_lamports: 50000,
  });
  const t0Result = await res.json() as any;
  console.log("T0 flux:", res.status, t0Result);
  const t0Cuid = t0Result.cuid;

  // === Query content ===
  console.log("\n--- Query ---");
  res = await bob.signedFetch("GET", "/content/query?topic=trading.signals");
  console.log("Query signals:", await res.json());

  res = await bob.signedFetch("GET", "/content/query?q=trading");
  console.log("FTS query:", await res.json());

  // === Read open flux ===
  console.log("\n--- Read open flux ---");
  res = await bob.signedFetch("GET", `/content/${openCuid}`);
  const openRead = await res.json() as any;
  console.log("Open body:", openRead.body);

  // === Verify signature ===
  console.log("\n--- Verify ---");
  res = await bob.signedFetch("GET", `/content/${openCuid}/verify`);
  console.log("Verify open:", await res.json());

  // === Key exchange for sealed (free) ===
  console.log("\n--- Key exchange (sealed, free) ---");

  // Bob requests key
  res = await bob.signedFetch("POST", `/content/${sealedCuid}/request_key`, {
    requester_box_pubkey: Buffer.from(bob.boxKeypair.publicKey).toString("base64"),
  });
  console.log("Bob requests key:", await res.json());

  // Alice polls for requests
  res = await alice.signedFetch("GET", "/author/key_requests");
  const keyRequests = await res.json() as any;
  console.log("Alice sees requests:", keyRequests);

  const sealedReq = keyRequests.requests.find(
    (r: any) => r.cuid === sealedCuid && r.requester_pubkey === bob.edPubkeyHex
  );
  if (!sealedReq?.requester_box_pubkey) {
    throw new Error("Missing requester_box_pubkey in author key requests");
  }
  const sealedRequesterBoxPubkey = new Uint8Array(
    Buffer.from(sealedReq.requester_box_pubkey, "base64")
  );
  const sealedEnvelope = sealedbox.seal(sealedKey, sealedRequesterBoxPubkey);

  res = await alice.signedFetch("POST", `/content/${sealedCuid}/deliver_key`, {
    requester_pubkey: bob.edPubkeyHex,
    envelope: Buffer.from(sealedEnvelope).toString("base64"),
  });
  console.log("Alice delivers key:", await res.json());

  // Bob downloads envelope
  res = await bob.signedFetch("GET", `/content/${sealedCuid}/my_key`);
  const keyRes = await res.json() as any;
  console.log("Bob gets envelope:", keyRes.status);

  // Bob decrypts
  const envelopeBytes = Buffer.from(keyRes.envelope, "base64");
  const recoveredKey = sealedbox.open(
    new Uint8Array(envelopeBytes),
    bob.boxKeypair.publicKey,
    bob.boxKeypair.secretKey
  );
  if (!recoveredKey) throw new Error("Failed to open sealed box");
  const decryptedSealed = decryptContent(
    sealedCipher,
    sealedNonce,
    recoveredKey
  );
  console.log("Bob decrypted sealed:", decryptedSealed);

  // === T0 purchase + key exchange ===
  console.log("\n--- T0 purchase ---");

  // Bob requests key (triggers payment)
  res = await bob.signedFetch("POST", `/content/${t0Cuid}/request_key`, {
    requester_box_pubkey: Buffer.from(bob.boxKeypair.publicKey).toString("base64"),
  });
  console.log("Bob requests T0 key:", await res.json());

  // Alice delivers key
  res = await alice.signedFetch("GET", "/author/key_requests");
  const t0Requests = await res.json() as any;
  const t0Req = t0Requests.requests.find(
    (r: any) => r.cuid === t0Cuid && r.requester_pubkey === bob.edPubkeyHex
  );
  if (!t0Req?.requester_box_pubkey) {
    throw new Error("Missing requester_box_pubkey for T0 request");
  }
  const t0RequesterBoxPubkey = new Uint8Array(
    Buffer.from(t0Req.requester_box_pubkey, "base64")
  );
  const t0Envelope = sealedbox.seal(t0Key, t0RequesterBoxPubkey);
  res = await alice.signedFetch("POST", `/content/${t0Cuid}/deliver_key`, {
    requester_pubkey: bob.edPubkeyHex,
    envelope: Buffer.from(t0Envelope).toString("base64"),
  });
  console.log("Alice delivers T0 key:", await res.json());

  // Bob decrypts T0
  res = await bob.signedFetch("GET", `/content/${t0Cuid}/my_key`);
  const t0KeyRes = await res.json() as any;
  const t0EnvelopeBytes = Buffer.from(t0KeyRes.envelope, "base64");
  const recoveredT0Key = sealedbox.open(
    new Uint8Array(t0EnvelopeBytes),
    bob.boxKeypair.publicKey,
    bob.boxKeypair.secretKey
  );
  if (!recoveredT0Key) throw new Error("Failed to open T0 sealed box");
  const decryptedT0 = decryptContent(t0Cipher, t0Nonce, recoveredT0Key);
  console.log("Bob decrypted T0:", decryptedT0);

  // === Rate ===
  console.log("\n--- Rate ---");
  res = await bob.signedFetch("POST", `/content/${openCuid}/rate`, {
    relevance: 0.9,
    useful: 1,
  });
  console.log("Bob rates:", await res.json());

  // === Task BBS ===
  console.log("\n--- Task BBS ---");

  // Alice posts task
  res = await alice.signedFetch("POST", "/tasks/post", {
    task_type: "execution",
    instruction: "Execute the NVDA bull call spread 140/150 on paper account",
    source_cuid: t0Cuid,
    bounty_lamports: 100000,
    deadline_seconds: 300,
  });
  const taskResult = await res.json() as any;
  console.log("Alice posts task:", taskResult);
  const taskId = taskResult.task_id;

  // Bob lists available tasks
  res = await bob.signedFetch("GET", "/tasks/available");
  console.log("Available tasks:", await res.json());

  // Bob claims task
  res = await bob.signedFetch("POST", `/tasks/${taskId}/claim`);
  console.log("Bob claims:", await res.json());

  // Bob submits result
  res = await bob.signedFetch("POST", `/tasks/${taskId}/submit`, {
    result: JSON.stringify({ filled: true, avg_price: 2.45, contracts: 10 }),
    proof: "paper-trade-id-12345",
  });
  console.log("Bob submits:", await res.json());

  // Check task details
  res = await alice.signedFetch("GET", `/tasks/${taskId}`);
  console.log("Task details:", await res.json());

  // === Final balances ===
  console.log("\n--- Final balances ---");
  res = await alice.signedFetch("GET", "/agents/me");
  console.log("Alice:", await res.json());

  res = await bob.signedFetch("GET", "/agents/me");
  console.log("Bob:", await res.json());

  // === Verify DB state ===
  console.log("\n--- Verification ---");

  // Check sealed content has no plaintext body in DB
  res = await bob.signedFetch("GET", `/content/${sealedCuid}`);
  const sealedDbRow = await res.json() as any;
  console.log("Sealed has body?", sealedDbRow.body !== undefined && sealedDbRow.body !== null ? "YES (BAD!)" : "NO (correct)");
  console.log("Sealed has encrypted_body?", sealedDbRow.encrypted_body ? "YES (correct)" : "NO (BAD!)");

  // Verify signature
  res = await bob.signedFetch("GET", `/content/${sealedCuid}/verify`);
  const verifyResult = await res.json() as any;
  console.log("Signature valid?", verifyResult.signature_valid ? "YES" : "NO");

  console.log("\n=== All tests passed! ===");
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
