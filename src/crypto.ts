import nacl from "tweetnacl";
import sealedbox from "tweetnacl-sealedbox-js";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// @noble/ed25519 v2 requires setting the sha512 hash
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// -- Symmetric encryption (NaCl SecretBox) --

export function generateContentKey(): Uint8Array {
  return nacl.randomBytes(nacl.secretbox.keyLength);
}

export function encryptBody(
  body: string,
  contentKey: Uint8Array
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const msg = new TextEncoder().encode(body);
  const ciphertext = nacl.secretbox(msg, nonce, contentKey);
  if (!ciphertext) throw new Error("Encryption failed");
  return { ciphertext, nonce };
}

export function decryptBody(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  contentKey: Uint8Array
): string {
  const plaintext = nacl.secretbox.open(ciphertext, nonce, contentKey);
  if (!plaintext) throw new Error("Decryption failed — wrong key or tampered data");
  return new TextDecoder().decode(plaintext);
}

// -- Sealed box (asymmetric envelope for key delivery) --

export function createEnvelope(
  contentKey: Uint8Array,
  recipientPubkey: Uint8Array
): Uint8Array {
  return sealedbox.seal(contentKey, recipientPubkey);
}

export function openEnvelope(
  envelope: Uint8Array,
  recipientPubkey: Uint8Array,
  recipientSecretKey: Uint8Array
): Uint8Array {
  const opened = sealedbox.open(envelope, recipientPubkey, recipientSecretKey);
  if (!opened) throw new Error("Failed to open envelope — wrong key");
  return opened;
}

// -- Ed25519 signing (Solana-compatible) --

export function signContent(
  bodyHash: Uint8Array,
  privateKey: Uint8Array
): Uint8Array {
  return ed.sign(bodyHash, privateKey);
}

export function verifySignature(
  bodyHash: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array
): boolean {
  return ed.verify(signature, bodyHash, publicKey);
}

// -- Hashing --

export function sha256hex(data: Uint8Array): string {
  const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex");
  return hash;
}

export function sha256bytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(
    new Bun.CryptoHasher("sha256").update(data).digest()
  );
}

// -- Key generation helpers --

export function generateKeypair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const secretKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(secretKey);
  return { publicKey, secretKey };
}

// NaCl X25519 keypair for sealed box (different from ed25519 signing keypair)
export function generateBoxKeypair(): nacl.BoxKeyPair {
  return nacl.box.keyPair();
}

// -- Encoding helpers --

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex length");
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("Invalid hex string");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
