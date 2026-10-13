// Provider keys live ONLY here, read from Worker secrets at request time:
//   wrangler secret put ALCHEMY_KEYS   (comma-separated)
//   wrangler secret put DRPC_KEY
// They never enter src/ (which ships to browsers) or any response body; the
// Worker uses them for its own cached reads (/api/stats), never on behalf of a
// caller. Absent secrets → public nodes only.
import { ALCHEMY_NET, type SupportedChainId } from '../src/config/chains';

const DRPC_NET: Record<SupportedChainId, string> = {
  1: 'ethereum', 8453: 'base', 10: 'optimism', 42161: 'arbitrum', 4663: 'robinhood',
};

let alchemy: string[] = [];
let drpc = '';

export function setProviderKeys(env: { ALCHEMY_KEYS?: string; DRPC_KEY?: string }): void {
  alchemy = (env.ALCHEMY_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  drpc = (env.DRPC_KEY ?? '').trim();
}

/** Keyed endpoints for the Worker's own reads: one Alchemy, then dRPC last. */
export function keyedRpcs(chainId: SupportedChainId): string[] {
  const out: string[] = [];
  const net = ALCHEMY_NET[chainId];
  if (net && alchemy.length) out.push(`https://${net}.g.alchemy.com/v2/${alchemy[Math.floor(Math.random() * alchemy.length)]}`);
  if (drpc) out.push(`https://lb.drpc.live/${DRPC_NET[chainId]}/${drpc}`);
  return out;
}
