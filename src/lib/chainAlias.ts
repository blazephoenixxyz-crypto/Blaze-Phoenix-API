// =============================================================================
//  Chain aliasing shared by the public Quote API (worker) and the deep-link
//  parser (site). One resolver, one truth: numeric ids and human names both
//  land on a SupportedChainId, anything else is rejected.
// =============================================================================

// Relative import (not `@/`): this module is bundled by BOTH Next.js and
// wrangler/esbuild (worker), and a relative path resolves under every bundler.
import type { SupportedChainId } from '../config/chains';

const ALIASES: Record<string, SupportedChainId> = {
  '1': 1, eth: 1, ethereum: 1, mainnet: 1,
  '8453': 8453, base: 8453,
  '10': 10, op: 10, optimism: 10,
  '42161': 42161, arb: 42161, arbitrum: 42161, 'arbitrum-one': 42161,
  '4663': 4663, rh: 4663, robinhood: 4663, 'robinhood-chain': 4663,
};

/** Resolve a user-supplied chain token ("base", "8453", "eth"…) or undefined. */
export function resolveChainParam(v: string | null | undefined): SupportedChainId | undefined {
  if (!v) return undefined;
  return ALIASES[v.trim().toLowerCase()];
}
