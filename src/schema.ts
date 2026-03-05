import { z } from "zod";

// -- Request schemas --

export const PublishSchema = z.object({
  tier: z.enum(["flux.open", "flux.sealed", "T0"]),
  topic: z.string().min(1).max(256),
  content_type: z.string().min(1).max(64).default("signal"),
  // For flux.open: plaintext body (JSON string)
  body: z.string().optional(),
  // For flux.sealed / T0: encrypted payload
  encrypted_body: z.string().optional(), // base64
  nonce: z.string().optional(), // base64
  body_hash: z.string().min(64).max(64), // sha256 hex
  author_signature: z.string().min(1), // hex
  price_lamports: z.number().int().min(0).default(0),
  price_usdc: z.number().int().min(0).optional(), // USDC base units (6 decimals); optional T0 price input for x402
  ttl_seconds: z.number().int().positive().optional(),
});

export const QuerySchema = z.object({
  q: z.string().optional(),
  topic: z.string().optional(),
  tier: z.enum(["flux.open", "flux.sealed", "T0"]).optional(),
  sort: z.enum(["recent", "rating", "popular"]).default("recent"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const RateSchema = z.object({
  relevance: z.number().min(0).max(1),
  useful: z.number().int().min(0).max(1),
});

export const DepositSchema = z.object({
  amount: z.number().int().positive(),
});

export const DeliverKeySchema = z.object({
  requester_pubkey: z.string().min(1),
  envelope: z.string().min(1), // base64
});

export const RequestKeySchema = z.object({
  requester_box_pubkey: z.string().min(1), // base64 (NaCl box public key, 32 bytes)
});

export const PostTaskSchema = z.object({
  task_type: z.string().min(1).max(128),
  instruction: z.string().min(1).max(4096),
  source_cuid: z.string().optional(),
  bounty_lamports: z.number().int().positive(),
  deadline_seconds: z.number().int().min(30).max(86400).default(300),
});

export const SubmitTaskSchema = z.object({
  result: z.string().min(1),
  proof: z.string().optional(),
});

// -- Response types --

export type ContentMeta = {
  cuid: string;
  author_pubkey: string;
  tier: string;
  topic: string;
  content_type: string;
  price_lamports: number;
  rating_avg: number | null;
  rating_count: number;
  query_count: number;
  created_at: string;
  expires_at: string | null;
};
