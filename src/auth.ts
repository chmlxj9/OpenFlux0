import type { Context, Next } from "hono";
import { getDb } from "./db";
import { verifySignature, fromHex } from "./crypto";

const MAX_TIMESTAMP_DRIFT_MS = 60_000; // 60 seconds
const NONCE_RETENTION_SECONDS = 10 * 60;

export type AuthContext = {
  pubkey: string;
};

/**
 * Auth middleware: verifies SolSign header.
 * Format: Authorization: SolSign <pubkey_hex>:<signature_hex>:<timestamp_ms>:<nonce>
 * Signature is over: <METHOD>:<PATH>:<TIMESTAMP>:<NONCE>
 */
export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("SolSign ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const parts = authHeader.slice(8).split(":");
  if (parts.length !== 4) {
    return c.json({ error: "Malformed SolSign header" }, 401);
  }

  const [pubkeyHex, signatureHex, timestampStr, nonce] = parts;
  if (!/^\d+$/.test(timestampStr)) {
    return c.json({ error: "Invalid timestamp format" }, 401);
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) {
    return c.json({ error: "Invalid nonce format" }, 401);
  }

  const timestamp = Number(timestampStr);
  if (!Number.isFinite(timestamp)) {
    return c.json({ error: "Invalid timestamp value" }, 401);
  }

  // Check timestamp freshness
  const now = Date.now();
  if (Math.abs(now - timestamp) > MAX_TIMESTAMP_DRIFT_MS) {
    return c.json({ error: "Request timestamp too far from server time" }, 401);
  }

  // Build the message that was signed
  const method = c.req.method;
  const url = new URL(c.req.url);
  const path = url.search ? `${url.pathname}${url.search}` : url.pathname;
  const message = `${method}:${path}:${timestampStr}:${nonce}`;
  const messageBytes = new TextEncoder().encode(message);

  // Verify ed25519 signature
  try {
    const pubkey = fromHex(pubkeyHex);
    const signature = fromHex(signatureHex);
    const valid = verifySignature(messageBytes, signature, pubkey);

    if (!valid) {
      return c.json({ error: "Invalid signature" }, 401);
    }
  } catch {
    return c.json({ error: "Invalid key or signature format" }, 401);
  }

  // Replay defense: reject reused nonce for same pubkey.
  // Old rows are pruned opportunistically.
  const db = getDb();
  db.query(
    "DELETE FROM auth_nonces WHERE used_at < datetime('now', ?)"
  ).run(`-${NONCE_RETENTION_SECONDS} seconds`);
  try {
    db.query("INSERT INTO auth_nonces (pubkey, nonce) VALUES (?, ?)").run(
      pubkeyHex,
      nonce
    );
  } catch {
    return c.json({ error: "Replay detected" }, 401);
  }

  // Attach pubkey to context
  c.set("pubkey", pubkeyHex);
  await next();
}
