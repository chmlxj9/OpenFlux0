import { Hono } from "hono";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { getDb, closeDb } from "./db";
import { config } from "./config";
import { authMiddleware } from "./auth";
import { anchorHashes } from "./anchor";
import agentRoutes from "./routes/agents";
import contentRoutes, { authorRoutes } from "./routes/content";
import taskRoutes from "./routes/tasks";

const app = new Hono();

// Global middleware
app.use("*", logger());
app.use("/content/publish", bodyLimit({ maxSize: config.maxBodyBytes }));

// Global error handler
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    const message =
      err.message?.trim() ||
      (err.status === 413 ? "Payload Too Large" : "Request failed");
    return c.json({ error: message }, err.status);
  }
  console.error("[error]", err.message);
  return c.json({ error: "Internal server error" }, 500);
});

// Public endpoints (no auth)
app.get("/health", (c) => {
  return c.json({ status: "ok", version: config.version, timestamp: new Date().toISOString() });
});

app.get("/node/info", (c) => {
  return c.json({
    operator_pubkey: config.nodeOperatorPubkey || null,
    query_fee_bps: config.nodeQueryFeeBps,
    task_fee_bps: config.nodeTaskFeeBps,
    supported_tiers: ["flux.open", "flux.sealed", "T0"],
    payment_mode: config.x402Enabled ? "x402" : "ledger",
    x402_network: config.x402Enabled ? config.x402Network : null,
    max_publishes_per_day: config.maxPublishesPerDay,
    max_body_bytes: config.maxBodyBytes,
    version: config.version,
  });
});

// Authenticated endpoints
app.use("/agents/*", authMiddleware);
app.use("/content/*", authMiddleware);
app.use("/author/*", authMiddleware);
app.use("/tasks/*", authMiddleware);

// x402 payment middleware (after auth, before routes)
if (config.x402Enabled) {
  const { createX402Middleware } = await import("./x402");
  app.use("/content/*", createX402Middleware());
  console.log(
    `[x402] Payment middleware enabled, payTo=${config.x402PayTo}, primary=${config.x402FacilitatorUrl}, fallback=${config.x402FacilitatorFallbackUrl}`
  );
}

app.route("/agents", agentRoutes);
app.route("/content", contentRoutes);
app.route("/author", authorRoutes);
app.route("/tasks", taskRoutes);

// Initialize DB on startup
getDb();
console.log(`[openflux] Database initialized at ${config.dataDir}/openflux.db`);

// Hash anchoring timer
let anchorTimer: ReturnType<typeof setInterval> | null = null;
if (config.anchorIntervalMs > 0) {
  anchorTimer = setInterval(async () => {
    try {
      const result = await anchorHashes();
      if (result) {
        console.log(
          `[anchor] Anchored ${result.cuidCount} items, root=${result.merkleRoot.slice(0, 16)}…`
        );
      }
    } catch (e) {
      console.error("[anchor] Error:", e);
    }
  }, config.anchorIntervalMs);
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[openflux] Shutting down…");
  if (anchorTimer) clearInterval(anchorTimer);
  closeDb();
  process.exit(0);
});

console.log(`[openflux] v${config.version} listening on http://${config.host}:${config.port}`);

export default {
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
};
