import { resolve } from "path";

export const config = {
  get port() {
    return Number(process.env.PORT ?? 3000);
  },
  get host() {
    return process.env.HOST ?? "localhost";
  },
  get dataDir() {
    return resolve(process.env.DATA_DIR ?? "./data");
  },

  get nodeOperatorPubkey() {
    return process.env.NODE_OPERATOR_PUBKEY ?? "";
  },
  get nodeQueryFeeBps() {
    return Number(process.env.NODE_QUERY_FEE_BPS ?? 50);
  },
  get nodeTaskFeeBps() {
    return Number(process.env.NODE_TASK_FEE_BPS ?? 100);
  },

  get solanaRpcUrl() {
    return process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  },
  get anchorKeypair() {
    return process.env.ANCHOR_KEYPAIR ?? "";
  },

  get anchorIntervalMs() {
    return Number(process.env.ANCHOR_INTERVAL_MS ?? 300_000);
  },
  get anchorMinItems() {
    return Number(process.env.ANCHOR_MIN_ITEMS ?? 5);
  },
  get authNoncePruneIntervalMs() {
    return Number(process.env.AUTH_NONCE_PRUNE_INTERVAL_MS ?? 60_000);
  },
  get taskExpiryIntervalMs() {
    return Number(process.env.TASK_EXPIRY_INTERVAL_MS ?? 30_000);
  },
  get taskExpiryBatchSize() {
    return Number(process.env.TASK_EXPIRY_BATCH_SIZE ?? 100);
  },

  get maxPublishesPerDay() {
    return Number(process.env.MAX_PUBLISHES_PER_DAY ?? 10);
  },
  get maxBodyBytes() {
    return Number(process.env.MAX_BODY_BYTES ?? 65536); // 64 KB
  },

  // x402 payment integration
  get x402Enabled() {
    return process.env.X402_ENABLED !== "false";
  },
  get x402FacilitatorUrl() {
    return process.env.X402_FACILITATOR_URL ?? "https://x402.dexter.cash";
  },
  get x402FacilitatorFallbackUrl() {
    return process.env.X402_FACILITATOR_FALLBACK_URL ?? "https://facilitator.payai.network";
  },
  get x402PayTo() {
    return process.env.X402_PAY_TO ?? "YOUR_SOLANA_PAYTO_ADDRESS"; // Solana address to receive USDC payments
  },
  get x402Network() {
    return process.env.X402_NETWORK ?? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // mainnet
  },

  get version() {
    return "0.1.0";
  },
};
