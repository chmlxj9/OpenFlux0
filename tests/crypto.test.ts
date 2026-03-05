import { describe, it, expect } from "bun:test";
import {
  generateContentKey,
  encryptBody,
  decryptBody,
  generateKeypair,
  signContent,
  verifySignature,
  sha256bytes,
  generateBoxKeypair,
  createEnvelope,
  openEnvelope,
  toHex,
  fromHex,
  toBase64,
  fromBase64,
} from "../src/crypto";

describe("SecretBox encryption", () => {
  it("encrypts and decrypts a message", () => {
    const key = generateContentKey();
    const plaintext = '{"signal": "TSLA bullish", "confidence": 0.9}';
    const { ciphertext, nonce } = encryptBody(plaintext, key);
    const result = decryptBody(ciphertext, nonce, key);
    expect(result).toBe(plaintext);
  });

  it("fails with wrong key", () => {
    const key1 = generateContentKey();
    const key2 = generateContentKey();
    const { ciphertext, nonce } = encryptBody("secret", key1);
    expect(() => decryptBody(ciphertext, nonce, key2)).toThrow();
  });
});

describe("Ed25519 signing", () => {
  it("signs and verifies", () => {
    const { publicKey, secretKey } = generateKeypair();
    const data = new TextEncoder().encode("hello world");
    const hash = sha256bytes(data);
    const sig = signContent(hash, secretKey);
    expect(verifySignature(hash, sig, publicKey)).toBe(true);
  });

  it("rejects tampered data", () => {
    const { publicKey, secretKey } = generateKeypair();
    const data = new TextEncoder().encode("hello world");
    const hash = sha256bytes(data);
    const sig = signContent(hash, secretKey);

    const tampered = new Uint8Array(hash);
    tampered[0] ^= 0xff;
    expect(verifySignature(tampered, sig, publicKey)).toBe(false);
  });
});

describe("SealedBox envelope", () => {
  it("creates and opens envelope", () => {
    const contentKey = generateContentKey();
    const boxKp = generateBoxKeypair();
    const envelope = createEnvelope(contentKey, boxKp.publicKey);
    const opened = openEnvelope(envelope, boxKp.publicKey, boxKp.secretKey);
    expect(toHex(opened)).toBe(toHex(contentKey));
  });
});

describe("Encoding helpers", () => {
  it("hex roundtrip", () => {
    const data = new Uint8Array([0, 1, 127, 255]);
    expect(fromHex(toHex(data))).toEqual(data);
  });

  it("base64 roundtrip", () => {
    const data = new Uint8Array([10, 20, 30, 40, 50]);
    expect(fromBase64(toBase64(data))).toEqual(data);
  });
});
