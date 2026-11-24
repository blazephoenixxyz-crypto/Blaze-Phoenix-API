// =============================================================================
//  GET /api/token/find?chain=base&query=PEPE — UNVERIFIED proposals for a name
//  or ticker: which addresses two third-party indexes (CoinGecko, Dexscreener)
//  propose on one chain, and which index proposed each. Nothing more.
//
//  Your RPC, not ours: this endpoint reads NO chain and takes no RPC URL (an
//  `rpc` parameter is refused, never fetched: the Worker is not a proxy to
//  hosts a caller names). The only outbound requests are the SDK's own index
//  lookups. Proposals are not ranked by liquidity and none is labelled; the
//  answer carries `verify`, how to read each candidate on YOUR node (findToken
//  from @blazephoenix/sdk/find, or the find_token tool of the local MCP).
//
//  The index lookups are the SDK's, unchanged: findToken runs with sources
//  'centralized' (the SDK's on-chain index would need an RPC; the Worker's own
//  keys are never used for it) and a reader that refuses every chain read, so
//  only its proposal step does any work. The answer says `measured: 'not
//  measured on-chain'`; the on-chain index and depth run in findToken on YOUR RPC.
//  (The SDK exports no proposals-only function; when it does, call that.)
// =============================================================================

import { BlazeError } from '@blazephoenix/sdk';
import { findToken as sdkFindToken, WARNINGS, type FindReader } from '@blazephoenix/sdk/find';
import { resolveChainParam } from '../src/lib/chainAlias';
import { CHAIN_ORDER, isDexLive } from '../src/config/chains';
import { CORS_HEADERS } from './quoteApi';

export interface FindDeps {
  findToken: typeof sdkFindToken;
  /** fetch for the indexes (default: the SDK's, globalThis.fetch). */
  fetch?: typeof fetch;
}

export const STATUS = 'unverified proposals';
/** Nothing in the answer was measured on chain: the index lookups only (SDK sources 'centralized'). */
export const MEASURED = 'not measured on-chain';

export const VERIFY = {
  note: 'Nothing here was read on chain: an index can propose any address. Read each candidate on YOUR RPC before using it.',
  sdk: "findToken({ query, chainId, rpc: '<your RPC>' }) from @blazephoenix/sdk/find: code, symbol, name, decimals, look-alike check, depth measured by the Quoter, venue balances",
  mcp: 'the find_token tool of the local MCP server (npx -y @blazephoenix/mcp, reading your node from BLAZEPHOENIX_RPC_URL or BLAZEPHOENIX_RPC_<CHAIN>)',
} as const;

const HELP = 'GET /api/token/find?chain=base&query=PEPE → unverified proposals from CoinGecko and Dexscreener. '
  + 'This endpoint reads no chain and takes no RPC: verify each candidate on your own node with findToken from @blazephoenix/sdk/find '
  + 'or the find_token tool of the local MCP.';

/** Refuses every chain read: the proposals are returned as proposed, never read here. */
const refuse = async (): Promise<never> => { throw new Error('not read here: verify on your RPC'); };
export const NO_READ: FindReader = { hasCode: refuse, erc20: refuse, balanceOf: refuse, usdValue: refuse };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS_HEADERS },
  });
}

const fail = (status: number, code: string, error: string) => json(status, { ok: false, code, error, help: HELP });

export async function handleFindToken(url: URL, deps: FindDeps = { findToken: sdkFindToken }): Promise<Response> {
  const p = url.searchParams;
  if (p.has('rpc')) return fail(400, 'rpc_not_accepted', 'this endpoint takes no RPC and reads no chain: run findToken or find_token on your own node to verify');
  const chainId = resolveChainParam(p.get('chain') ?? p.get('chainId'));
  if (!chainId) return fail(400, 'bad_chain', `unknown chain — use one of: ${CHAIN_ORDER.join(', ')} (or base/eth/optimism/arbitrum/robinhood)`);
  if (!isDexLive(chainId)) return fail(400, 'chain_not_live', 'DEX not deployed on this chain yet');
  const query = p.get('query');
  if (query === null || query.trim() === '') return fail(400, 'bad_query', 'query: a name or ticker');

  try {
    const r = await deps.findToken({ query, chainId, sources: 'centralized', reader: NO_READ, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    const proposed = r.candidates.length + r.omitted;
    const failedSources = r.sources.filter((s) => !s.ok).map((s) => s.name);
    // Absent is not zero: with an index down, the count covers only the indexes that answered.
    const partial = failedSources.length > 0 ? [`The count covers only the indexes that answered; failed: ${failedSources.join(', ')}.`] : [];
    return json(200, {
      ok: true,
      status: STATUS,
      measured: MEASURED,
      query: r.query,
      chainId: r.chainId,
      candidates: r.candidates.map((c) => ({ address: c.address, chainId: r.chainId, sources: c.sources })),
      omitted: r.omitted,
      sources: r.sources,
      failedSources,
      verify: VERIFY,
      warnings: [WARNINGS.dyor(proposed), ...partial, WARNINGS.notSafety],
    });
  } catch (e) {
    if (e instanceof BlazeError && (e.code === 'bad_request' || e.code === 'bad_chain')) return fail(400, e.code, e.message);
    return fail(502, 'find_failed', e instanceof Error ? e.message : String(e));
  }
}
