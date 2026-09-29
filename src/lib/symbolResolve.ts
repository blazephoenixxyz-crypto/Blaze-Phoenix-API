// =============================================================================
//  Symbol → address resolution — makes `in=TOSHI` work for ANY traded token.
//
//  Strategy: Dexscreener's public search, filtered to the target chain, and the
//  candidate with the DEEPEST on-chain liquidity wins. Liquidity is the least
//  fakeable ranking signal (a squatter must out-capitalize the real token to
//  outrank it). The resolved address is always echoed back to the caller, and
//  the docs say it plainly: pass 0x addresses when you need precision.
//
//  Shared by the Worker API (server-side) and the API-tab playground fallback
//  (in-browser) — one resolver, one behaviour. Pure ranking logic is exported
//  separately so the offline test suite can prove it.
// =============================================================================

import type { SupportedChainId } from '../config/chains';

/** Dexscreener chain slugs for our supported chains. */
export const DEX_SLUG: Record<SupportedChainId, string> = {
  1: 'ethereum',
  8453: 'base',
  10: 'optimism',
  42161: 'arbitrum',
  4663: 'robinhood', // Robinhood IS on Dexscreener (slug: robinhood).
};

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;

/** Loose "looks like a ticker" test — used to decide when to even try. */
export const SYMBOLISH = /^[A-Za-z0-9$._-]{1,20}$/;

export interface ResolvedSymbol {
  symbol: string;
  address: `0x${string}`;
  name?: string;
  liquidityUsd: number;
}

interface DexPairToken { address?: string; symbol?: string; name?: string }
export interface DexPair {
  chainId?: string;
  baseToken?: DexPairToken;
  quoteToken?: DexPairToken;
  liquidity?: { usd?: number };
}

/** Pure ranking: among pairs on `slug`, find the token whose symbol matches
 *  (case-insensitive, base or quote side) with the deepest USD liquidity. */
export function pickBestPair(
  pairs: DexPair[] | undefined,
  slug: string,
  symbol: string,
): ResolvedSymbol | undefined {
  if (!Array.isArray(pairs)) return undefined;
  const want = symbol.toLowerCase();
  let best: ResolvedSymbol | undefined;
  for (const p of pairs) {
    if (p?.chainId !== slug) continue;
    const liq = Number(p.liquidity?.usd) || 0;
    for (const side of [p.baseToken, p.quoteToken]) {
      if (!side?.address || !side.symbol) continue;
      if (side.symbol.toLowerCase() !== want) continue;
      if (!HEX_ADDR.test(side.address)) continue;
      if (!best || liq > best.liquidityUsd) {
        best = {
          symbol: side.symbol,
          address: side.address as `0x${string}`,
          name: side.name,
          liquidityUsd: liq,
        };
      }
    }
  }
  return best;
}

/** Resolve a ticker on a chain via Dexscreener search (bounded, never throws). */
export async function resolveSymbolViaDex(
  chainId: SupportedChainId,
  symbol: string,
  timeoutMs = 3_500,
): Promise<ResolvedSymbol | undefined> {
  if (!SYMBOLISH.test(symbol)) return undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`,
      { signal: ctrl.signal, headers: { accept: 'application/json' } },
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as { pairs?: DexPair[] };
    return pickBestPair(body.pairs, DEX_SLUG[chainId], symbol);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
