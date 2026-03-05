import {
  paymentMiddlewareFromHTTPServer,
  x402ResourceServer,
  x402HTTPResourceServer,
} from "@x402/hono";
import type { RoutesConfig } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import type { Context, Next } from "hono";
import { config } from "./config";
import { getDb } from "./db";
import { lamportsToUsdcPrice, usdcBaseToPrice } from "./pricing";

function buildRoutes(): RoutesConfig {
  return {
    "POST /content/*/request_key": {
      accepts: {
        scheme: "exact",
        network: config.x402Network as `${string}:${string}`,
        payTo: config.x402PayTo,
        // Dynamic pricing: look up the CUID's price from DB at request time
        price: async (ctx) => {
          const parts = ctx.path.split("/");
          // path: /content/{cuid}/request_key -> parts[2] = cuid
          const cuid = parts[2];
          if (!cuid) return "$0";

          const row = getDb()
            .query("SELECT price_lamports, price_usdc, tier FROM content WHERE cuid = ?")
            .get(cuid) as { price_lamports: number; price_usdc: number | null; tier: string } | null;

          if (!row || row.tier !== "T0") return "$0";

          // Prefer native USDC pricing (already in base units)
          if (row.price_usdc != null && row.price_usdc > 0) {
            return usdcBaseToPrice(row.price_usdc);
          }

          if (row.price_lamports <= 0) return "$0";
          return lamportsToUsdcPrice(row.price_lamports);
        },
      },
      description: "Purchase access to T0 content",
    },
  };
}

function isTestnetNetwork(network: string): boolean {
  const lower = network.toLowerCase();
  return (
    lower.includes("devnet") ||
    lower.includes("testnet") ||
    lower.includes("sepolia") ||
    lower.includes("amoy") ||
    lower.includes("fuji")
  );
}

function buildPaymentMiddleware(facilitatorUrl: string) {
  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient).register("solana:*", new ExactSvmScheme());
  const routes = buildRoutes();

  const httpServer = new x402HTTPResourceServer(
    resourceServer,
    routes
  ).onProtectedRequest(async (ctx) => {
    // Extract CUID from path
    const parts = ctx.path.split("/");
    const cuid = parts[2];
    if (!cuid) return { grantAccess: true };

    const row = getDb()
      .query("SELECT tier FROM content WHERE cuid = ?")
      .get(cuid) as { tier: string } | null;

    // Grant free access for non-T0 content (flux.sealed is free key exchange)
    if (!row || row.tier !== "T0") {
      return { grantAccess: true };
    }

    // T0: continue to x402 payment flow (will return 402 if no payment header)
  });

  const middleware = paymentMiddlewareFromHTTPServer(httpServer, {
    appName: "OpenFlux",
    testnet: isTestnetNetwork(config.x402Network),
  });

  return middleware;
}

export function createX402Middleware() {
  if (!config.x402PayTo) {
    throw new Error("X402_PAY_TO must be set when X402_ENABLED=true");
  }

  const primaryUrl = config.x402FacilitatorUrl;
  const fallbackUrl = config.x402FacilitatorFallbackUrl;
  const primary = buildPaymentMiddleware(primaryUrl);
  const fallback =
    fallbackUrl && fallbackUrl !== primaryUrl
      ? buildPaymentMiddleware(fallbackUrl)
      : null;

  // Wrap to gracefully handle facilitator errors and retry via fallback.
  return async (c: Context, next: Next) => {
    try {
      return await primary(c, next);
    } catch (primaryErr: any) {
      if (!fallback) {
        console.error("[x402] Primary facilitator error:", primaryErr?.message ?? primaryErr);
        return c.json({ error: "Payment service temporarily unavailable" }, 503);
      }

      console.warn(
        `[x402] Primary facilitator failed (${primaryUrl}), retrying fallback (${fallbackUrl})`
      );
      try {
        return await fallback(c, next);
      } catch (fallbackErr: any) {
        console.error(
          "[x402] Fallback facilitator error:",
          fallbackErr?.message ?? fallbackErr
        );
        return c.json({ error: "Payment service temporarily unavailable" }, 503);
      }
    }
  };
}
