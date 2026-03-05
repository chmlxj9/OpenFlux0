import { describe, it, expect } from "bun:test";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("SolSign auth", () => {
  it("creates a valid signed header", () => {
    const secretKey = ed.utils.randomPrivateKey();
    const publicKey = ed.getPublicKey(secretKey);
    const pubkeyHex = toHex(publicKey);

    const method = "GET";
    const path = "/agents/me";
    const ts = Date.now().toString();
    const nonce = "nonce12345";
    const msg = `${method}:${path}:${ts}:${nonce}`;
    const msgBytes = new TextEncoder().encode(msg);
    const sig = ed.sign(msgBytes, secretKey);
    const sigHex = toHex(sig);

    // Verify
    const valid = ed.verify(sig, msgBytes, publicKey);
    expect(valid).toBe(true);

    // Build header
    const header = `SolSign ${pubkeyHex}:${sigHex}:${ts}:${nonce}`;
    expect(header.startsWith("SolSign ")).toBe(true);
    expect(header.split(":").length).toBe(4);
  });
});
