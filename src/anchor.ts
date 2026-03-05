import {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { getDb } from "./db";
import { config } from "./config";
import { sha256bytes } from "./crypto";

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

export type MerkleProofStep = {
  position: "left" | "right";
  hash: string;
};

export type MerkleProof = {
  leaf_index: number;
  siblings: MerkleProofStep[];
  root: string;
};

/**
 * Build a Merkle tree from leaf hashes. Returns the root hash.
 * Leaves and intermediate nodes are sha256(left + right).
 */
export function buildMerkleRoot(leafHashes: string[]): string {
  if (leafHashes.length === 0) return "";
  if (leafHashes.length === 1) return leafHashes[0];

  let level = leafHashes.map((h) => Buffer.from(h, "hex"));

  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        const combined = Buffer.concat([level[i], level[i + 1]]);
        next.push(Buffer.from(sha256bytes(new Uint8Array(combined))));
      } else {
        // Odd node: promote
        next.push(level[i]);
      }
    }
    level = next;
  }

  return level[0].toString("hex");
}

export function buildMerkleProof(
  leafHashes: string[],
  leafIndex: number
): MerkleProof | null {
  if (leafHashes.length === 0) return null;
  if (leafIndex < 0 || leafIndex >= leafHashes.length) return null;
  if (leafHashes.length === 1) {
    return { leaf_index: leafIndex, siblings: [], root: leafHashes[0] };
  }

  let index = leafIndex;
  let level = leafHashes.map((h) => Buffer.from(h, "hex"));
  const siblings: MerkleProofStep[] = [];

  while (level.length > 1) {
    const next: Buffer[] = [];

    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : null;

      if (right) {
        const parent = Buffer.from(
          sha256bytes(new Uint8Array(Buffer.concat([left, right])))
        );
        next.push(parent);

        if (index === i) {
          siblings.push({ position: "right", hash: right.toString("hex") });
          index = Math.floor(i / 2);
        } else if (index === i + 1) {
          siblings.push({ position: "left", hash: left.toString("hex") });
          index = Math.floor(i / 2);
        }
      } else {
        // Odd node promotion
        next.push(left);
        if (index === i) {
          index = Math.floor(i / 2);
        }
      }
    }

    level = next;
  }

  return {
    leaf_index: leafIndex,
    siblings,
    root: level[0].toString("hex"),
  };
}

export function verifyMerkleProof(
  leafHash: string,
  proof: MerkleProof,
  expectedRoot: string
): boolean {
  let current = Buffer.from(leafHash, "hex");
  for (const step of proof.siblings) {
    const sibling = Buffer.from(step.hash, "hex");
    const combined =
      step.position === "left"
        ? Buffer.concat([sibling, current])
        : Buffer.concat([current, sibling]);
    current = Buffer.from(sha256bytes(new Uint8Array(combined)));
  }
  return current.toString("hex") === expectedRoot;
}

/**
 * Anchor pending content hashes to Solana via memo transaction.
 */
export async function anchorHashes(): Promise<{
  merkleRoot: string;
  txSignature: string;
  cuidCount: number;
} | null> {
  const db = getDb();

  // Find content not yet anchored
  const rows = db
    .query(`
      SELECT c.cuid, c.body_hash
      FROM content c
      WHERE c.cuid NOT IN (
        SELECT json_each.value
        FROM hash_anchors, json_each(hash_anchors.cuid_list)
        WHERE COALESCE(hash_anchors.tx_signature, '') <> ''
      )
      ORDER BY c.created_at ASC
      LIMIT 100
    `)
    .all() as { cuid: string; body_hash: string }[];

  if (rows.length < config.anchorMinItems) {
    return null;
  }

  const cuids = rows.map((r) => r.cuid);
  const hashes = rows.map((r) => r.body_hash);
  const merkleRoot = buildMerkleRoot(hashes);

  // Insert anchor record (pre-tx)
  const result = db
    .query(
      "INSERT INTO hash_anchors (merkle_root, cuid_list) VALUES (?, ?) RETURNING id"
    )
    .get(merkleRoot, JSON.stringify(cuids)) as { id: number };

  // Send memo tx to Solana
  let txSignature = "";
  try {
    if (!config.anchorKeypair) {
      console.log("[anchor] No ANCHOR_KEYPAIR set, skipping Solana tx");
      db.query(
        "UPDATE hash_anchors SET tx_signature = ?, anchored_at = datetime('now') WHERE id = ?"
      ).run("dry-run", result.id);
      return { merkleRoot, txSignature: "dry-run", cuidCount: cuids.length };
    }

    const connection = new Connection(config.solanaRpcUrl, "confirmed");
    const payer = Keypair.fromSecretKey(bs58.decode(config.anchorKeypair));

    const memoData = `ofx:${merkleRoot}`;
    const instruction = new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memoData),
    });

    const tx = new Transaction().add(instruction);
    txSignature = await sendAndConfirmTransaction(connection, tx, [payer]);

    db.query(
      "UPDATE hash_anchors SET tx_signature = ?, anchored_at = datetime('now') WHERE id = ?"
    ).run(txSignature, result.id);

    console.log(
      `[anchor] Anchored ${cuids.length} items, root=${merkleRoot.slice(0, 16)}…, tx=${txSignature.slice(0, 16)}…`
    );
  } catch (e) {
    console.error("[anchor] Solana tx failed:", e);
    // Remove failed attempt so these CUIDs remain eligible for retry.
    db.query("DELETE FROM hash_anchors WHERE id = ?").run(result.id);
  }

  return { merkleRoot, txSignature, cuidCount: cuids.length };
}
