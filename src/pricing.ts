const LAMPORTS_PER_SOL = 1_000_000_000;
const USDC_BASE_PER_USDC = 1_000_000;
const SOL_USDC_RATE = 150; // OpenFlux0 fixed rate: 1 SOL = $150.

export function lamportsToUsdcPrice(lamports: number): string {
  const sol = lamports / LAMPORTS_PER_SOL;
  const usd = sol * SOL_USDC_RATE;
  return `$${usd.toFixed(6)}`;
}

export function usdcBaseToPrice(baseUnits: number): string {
  const usd = baseUnits / USDC_BASE_PER_USDC;
  return `$${usd.toFixed(6)}`;
}

export function usdcBaseToLamports(baseUnits: number): number {
  const usd = baseUnits / USDC_BASE_PER_USDC;
  const sol = usd / SOL_USDC_RATE;
  return Math.round(sol * LAMPORTS_PER_SOL);
}
