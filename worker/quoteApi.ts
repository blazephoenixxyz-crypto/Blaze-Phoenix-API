// =============================================================================
//  PUBLIC INTEGRATION API — 100% the integrator's RPC.
//
//  The site performs NO RPC on an integrator's behalf. We don't pay for their
//  reads and they don't depend on our nodes. What the API offers instead is
//  pure computation and the registry:
//
//    GET  /api/quote/prepare?chain=base&in=WETH&out=USDC&amountIn=…  → the eth_call to run on YOUR node
//    POST /api/quote/prepare   { requests: [...] }                    → the same, as one JSON-RPC batch
//    POST /api/quote/decode    { request, result }                    → quote + Phoenix Check + calldata
//    GET  /api/deployments                                            → versioned contract registry
//    GET  /api/abi?contract=quoter                                    → generated ABIs
//    GET  /api/manifest                                               → contracts / token / events
//
//  GET /api/quote and POST /api/quote/batch — the old relayed endpoints — now
//  answer 400 `rpc_required` WITH the prepared call inline, so a caller that
//  never read the changelog still sees exactly what to run and where.
//  @blazephoenix/sdk 1.x and the local MCP server (@blazephoenix/mcp) do all
//  of it in-process and never touch this Worker for a quote.
//
//  FIRST-PARTY ONLY: the site's own Telegram bot still quotes through the
//  site's read pool (handleQuoteFirstParty) — the same way the swap screen
//  does for a human visitor. No public route reaches that path.
//
//  Design rules: no key, open CORS, no state; strict param validation up front
//  (pure helpers, unit-tested in scripts/mock-tests.ts) with stable error
//  codes; this module NEVER throws to the caller — worker/index.ts wraps it.
// =============================================================================

import {
  encodeFunctionData,
  decodeFunctionResult,
  decodeErrorResult,
  toEventSelector,
  getAddress,
} from 'viem';
import { QUOTER_ABI, ROUTER_ABI, CORE_ABI, HUB_ABI, SOLVER_ABI, BLAZE_ERRORS_ABI, ABI_SOURCE_REVISION } from '../src/abis/blaze';
import { CHAINS, CHAIN_ORDER, isDexLive, alchemyFor, DRPC, type SupportedChainId } from '../src/config/chains';
import { isV2 } from '../src/config/deployments';
import {
  prepareQuote, decodeQuote, registryDocument, phoenixChecks, RPC_REQUIRED_MESSAGE, type Preview,
} from './codec';
import { resolveChainParam } from '../src/lib/chainAlias';
import { SITE } from '../src/config/site';
import { resolveSymbolViaDex, SYMBOLISH, type ResolvedSymbol } from '../src/lib/symbolResolve';

// ── constants ────────────────────────────────────────────────────────────────

const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const RPC_TIMEOUT_MS = 3_500; // per endpoint
const MAX_RPCS = 4;           // bounded upstream fan-out per request
const MAX_DEADLINE_SEC = 3_600;

export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

/** Batch ceiling: each quote may walk up to MAX_RPCS endpoints, and Cloudflare
 *  caps subrequests per invocation — 10×4 stays comfortably inside the limit. */
export const MAX_BATCH = 10;

// ── param parsing (pure — unit tested) ───────────────────────────────────────

export interface QuoteParams {
  chainId: SupportedChainId;
  /** Address the contracts quote with (native ETH already mapped to WETH). */
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  /** True when the caller asked with `in=ETH` (a swap would need a wrap first). */
  nativeIn: boolean;
  /** True when the caller asked with `out=ETH` (the Router delivers WETH). */
  nativeOut: boolean;
  exact: boolean;
  recipient?: `0x${string}`;
  slippageBps?: number;
  deadlineSec: number;
  /** Caller-tightened minimum (base units of tokenOut). */
  userMinOut?: bigint;
  /** Protocol version selector: latest | 1 | 2 | 2.0.0 (see /api/deployments). */
  version?: string;
}

export type ParseResult =
  | { ok: true; params: QuoteParams }
  | { ok: false; status: number; code: string; message: string };

const err = (status: number, code: string, message: string): ParseResult =>
  ({ ok: false, status, code, message });

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const INT = /^[0-9]{1,77}$/; // < 78 digits always fits uint256's 78-digit ceiling

/** Resolve a token param: 0x-address, or the universal symbols every chain
 *  config carries (ETH → native sentinel, WETH, USDC, BZPX where live). */
export function resolveTokenParam(
  v: string | null,
  chainId: SupportedChainId,
): `0x${string}` | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (HEX_ADDR.test(s)) {
    try { return getAddress(s); } catch { return undefined; }
  }
  const chain = CHAINS[chainId];
  switch (s.toUpperCase()) {
    case 'ETH': return NATIVE_ETH as `0x${string}`;
    case 'WETH': return chain.weth;
    case 'USDC': return chain.usdc;
    case 'BZPX': return chain.bzpx; // undefined off Base → clean 400 below
    default: return undefined;
  }
}


/** Parse + validate every /api/quote search param. Pure: no I/O, no Date. */
export function parseQuoteParams(searchParams: URLSearchParams): ParseResult {
  const chainId = resolveChainParam(searchParams.get('chain') ?? searchParams.get('chainId'));
  if (!chainId) {
    return err(400, 'bad_chain',
      `unknown chain — use one of: ${CHAIN_ORDER.join(', ')} (or base/eth/optimism/arbitrum/robinhood)`);
  }
  if (!isDexLive(chainId)) return err(400, 'chain_not_live', 'DEX not deployed on this chain yet');

  const rawIn = searchParams.get('in') ?? searchParams.get('tokenIn');
  const rawOut = searchParams.get('out') ?? searchParams.get('tokenOut');
  const tIn = resolveTokenParam(rawIn, chainId);
  const tOut = resolveTokenParam(rawOut, chainId);
  if (!tIn) {
    return err(400, 'bad_token_in',
      'tokenIn: no traded token with this symbol found on this chain — pass the 0x token address');
  }
  if (!tOut) {
    return err(400, 'bad_token_out',
      'tokenOut: no traded token with this symbol found on this chain — pass the 0x token address');
  }

  const nativeIn = tIn.toLowerCase() === NATIVE_ETH.toLowerCase();
  const nativeOut = tOut.toLowerCase() === NATIVE_ETH.toLowerCase();
  const weth = CHAINS[chainId].weth;
  const tokenIn = nativeIn ? weth : tIn;
  const tokenOut = nativeOut ? weth : tOut;
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    return err(400, 'same_token', 'tokenIn and tokenOut are the same token');
  }

  const rawAmt = searchParams.get('amountIn') ?? searchParams.get('amount');
  if (!rawAmt || !INT.test(rawAmt.trim())) {
    return err(400, 'bad_amount',
      'amountIn must be a positive integer in the token’s base units (wei-style)');
  }
  const amountIn = BigInt(rawAmt.trim());
  if (amountIn <= 0n) return err(400, 'bad_amount', 'amountIn must be > 0');

  let recipient: `0x${string}` | undefined;
  const rawRcpt = searchParams.get('recipient');
  if (rawRcpt) {
    if (!HEX_ADDR.test(rawRcpt.trim())) return err(400, 'bad_recipient', 'recipient must be a 0x address');
    try { recipient = getAddress(rawRcpt.trim()); } catch { return err(400, 'bad_recipient', 'recipient checksum invalid'); }
  }

  let slippageBps: number | undefined;
  const rawSlip = searchParams.get('slippageBps');
  if (rawSlip !== null) {
    const n = Number(rawSlip);
    if (!Number.isInteger(n) || n < 0 || n > 5_000) {
      return err(400, 'bad_slippage', 'slippageBps must be an integer between 0 and 5000');
    }
    slippageBps = n;
  }

  let deadlineSec = 120;
  const rawDl = searchParams.get('deadlineSec');
  if (rawDl !== null) {
    const n = Number(rawDl);
    if (!Number.isInteger(n) || n < 10 || n > MAX_DEADLINE_SEC) {
      return err(400, 'bad_deadline', `deadlineSec must be an integer between 10 and ${MAX_DEADLINE_SEC}`);
    }
    deadlineSec = n;
  }

  let userMinOut: bigint | undefined;
  const rawMin = searchParams.get('userMinOut');
  if (rawMin !== null) {
    if (!INT.test(rawMin.trim())) return err(400, 'bad_min_out', 'userMinOut must be an integer in tokenOut base units');
    userMinOut = BigInt(rawMin.trim());
  }

  const version = searchParams.get('version') ?? undefined;
  if (version !== undefined && !/^v?(latest|\d+(\.\d+){0,2})$/i.test(version.trim())) {
    return err(400, 'bad_version', 'version must be latest, 1, 2 or a full semver like 2.0.0');
  }

  return {
    ok: true,
    params: {
      chainId, tokenIn, tokenOut, amountIn, nativeIn, nativeOut,
      exact: searchParams.get('exact') === '1',
      recipient, slippageBps, deadlineSec,
      ...(userMinOut !== undefined ? { userMinOut } : {}),
      ...(version !== undefined ? { version: version.trim() } : {}),
    },
  };
}

// ── JSON safety (pure — unit tested) ─────────────────────────────────────────

/** Deep-convert bigints to decimal strings so structures survive JSON. */
export function jsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = jsonSafe(val);
    return out;
  }
  return v;
}

// ── eth_call with RPC fallback (FIRST-PARTY ONLY: the site's own bot) ────────

async function ethCall(
  chainId: SupportedChainId,
  to: `0x${string}`,
  data: `0x${string}`,
): Promise<{ result?: `0x${string}`; revertData?: `0x${string}`; rpcTried: number }> {
  const rpcs = CHAINS[chainId].rpcs.slice(0, MAX_RPCS);
  let tried = 0;
  for (const rpc of rpcs) {
    tried++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        signal: ctrl.signal,
        // Our keyed endpoints (Alchemy/dRPC) are origin-locked to the site
        // domain, so the worker presents the site origin to pass that lock.
        headers: {
          'content-type': 'application/json',
          origin: 'https://blazephoenix.xyz',
          referer: 'https://blazephoenix.xyz/',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'],
        }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as {
        result?: `0x${string}`;
        error?: { message?: string; data?: `0x${string}` };
      };
      if (body.result) return { result: body.result, rpcTried: tried };
      // A revert is a REAL answer (no route / bad pair) — don't retry others.
      const rd = body.error?.data;
      if (rd && typeof rd === 'string' && rd.startsWith('0x') && rd.length > 2) {
        return { revertData: rd, rpcTried: tried };
      }
      // Structureless RPC error → try the next endpoint.
    } catch {
      /* timeout / network — next endpoint */
    } finally {
      clearTimeout(timer);
    }
  }
  return { rpcTried: tried };
}

/** Human-readable revert: decodes the protocol's coded custom errors. */
function describeRevert(data: `0x${string}`): string {
  try {
    const e = decodeErrorResult({ abi: BLAZE_ERRORS_ABI, data });
    return `${e.errorName}(${(e.args as readonly unknown[] | undefined)?.join(', ') ?? ''})`;
  } catch {
    return 'execution reverted';
  }
}

// ── response helpers ─────────────────────────────────────────────────────────

function json(status: number, body: unknown, cacheSecs = 0, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheSecs > 0 ? `public, max-age=${cacheSecs}` : 'no-store',
      // Bots back off politely instead of hammering a degraded RPC pool.
      ...(status === 502 ? { 'retry-after': '3' } : {}),
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

// ── RPC-saving layer: singleflight + one-block edge cache ────────────────────
//
//  N identical requests in the same instant → ONE eth_call (singleflight);
//  identical requests within ~1 block → served from the PoP cache (edge TTL).
//  Execution-grade paths are untouched: `exact=1` and recipient-carrying
//  requests are never TTL-cached (deadlines + money-grade freshness), though
//  simultaneous identical ones still coalesce (same instant = no staleness).
//  Every response says what it is: meta.cache = miss | coalesced | hit.

/** Full param fingerprint — the sharing key. Includes recipient/slippage so
 *  only *truly identical* requests ever share anything. */
export function quoteCacheKey(p: QuoteParams): string {
  return [
    p.chainId, p.tokenIn.toLowerCase(), p.tokenOut.toLowerCase(), p.amountIn.toString(),
    p.exact ? 1 : 0, p.recipient?.toLowerCase() ?? '', p.slippageBps ?? '', p.deadlineSec,
    p.userMinOut?.toString() ?? '', p.version ?? '',
  ].join('|');
}

/** Preview-quote TTL ≈ one block: 2s on the L2s, 10s on Ethereum. */
export function quoteTtlSecs(chainId: SupportedChainId): number {
  return chainId === 1 ? 10 : 2;
}

/** Negative-cache TTL for a REVERTING quote (no route — a dead or nonexistent
 *  pair). Bots hammer the same nonexistent pairs in loops; caching the "no"
 *  collapses millions of identical fake requests into ONE eth_call instead of
 *  one each. Kept short so a pair that goes live is quotable within the window. */
const NEG_TTL_SECS = 30;

const INFLIGHT = new Map<string, Promise<{ status: number; body: Record<string, unknown> }>>();

/** Coalesce concurrent identical work: leader runs `fn`, followers await the
 *  same promise. Returns whether this caller shared a leader's flight. */
export async function singleflight<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; shared: boolean }> {
  const existing = INFLIGHT.get(key) as Promise<T> | undefined;
  if (existing) return { value: await existing, shared: true };
  const flight = fn();
  INFLIGHT.set(key, flight as never);
  try {
    return { value: await flight, shared: false };
  } finally {
    INFLIGHT.delete(key);
  }
}

const CACHE_ORIGIN = 'https://blazephoenix.xyz/__edge-cache/quote';

function edgeCache(): Cache | undefined {
  // Cloudflare Workers runtime only — absent under Node (tests) and that's fine.
  return typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : undefined;
}

export async function edgeGet(key: string): Promise<Record<string, unknown> | undefined> {
  try {
    const hit = await edgeCache()?.match(`${CACHE_ORIGIN}?k=${encodeURIComponent(key)}`);
    if (!hit) return undefined;
    return (await hit.json()) as Record<string, unknown>;
  } catch { return undefined; }
}

export async function edgePut(key: string, body: Record<string, unknown>, ttl: number): Promise<void> {
  try {
    await edgeCache()?.put(
      `${CACHE_ORIGIN}?k=${encodeURIComponent(key)}`,
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` },
      }),
    );
  } catch { /* cache is an optimization, never a failure */ }
}

function setMetaCache(body: Record<string, unknown>, v: 'miss' | 'coalesced' | 'hit'): void {
  const meta = body.meta as Record<string, unknown> | undefined;
  if (meta && typeof meta === 'object') meta.cache = v;
}

/** execQuote wrapped in the sharing layer — used by single AND batch paths.
 *  The cache entry is a small envelope { s: status, b: body } so a NEGATIVE
 *  answer (422 no-route) can be cached and replayed with its real status rather
 *  than forced to 200. Old body-only entries (pre-deploy) read as a miss and
 *  self-heal. */
async function cachedExec(p: QuoteParams): Promise<{ status: number; body: Record<string, unknown>; cache: string }> {
  const key = quoteCacheKey(p);
  const cacheable = !p.recipient && !p.exact;

  if (cacheable) {
    const hit = (await edgeGet(key)) as { s?: number; b?: Record<string, unknown> } | undefined;
    if (hit && typeof hit.s === 'number' && hit.b) {
      setMetaCache(hit.b, 'hit');
      return { status: hit.s, body: hit.b, cache: 'hit' };
    }
  }

  const { value, shared } = await singleflight(key, () => execQuote(p));
  if (shared) {
    // Followers get their own copy so per-request patches never collide.
    const body = structuredClone(value.body);
    setMetaCache(body, 'coalesced');
    return { status: value.status, body, cache: 'coalesced' };
  }
  setMetaCache(value.body, 'miss');
  // Cache a positive for ~one block; cache a "no route" (dead/nonexistent pair)
  // for a short window — a real, repeatable answer that bots hammer in loops, so
  // millions of identical fake requests collapse to one eth_call. NEVER cache a
  // 5xx (transient RPC failure) or a 4xx param error (those never reach RPC).
  if (cacheable) {
    if (value.status === 200) {
      await edgePut(key, { s: 200, b: value.body }, quoteTtlSecs(p.chainId));
    } else if (value.status === 422) {
      await edgePut(key, { s: 422, b: value.body }, NEG_TTL_SECS);
    }
  }
  return { ...value, cache: 'miss' };
}

// ── universal symbol resolution (single-quote path only) ────────────────────
// `in=TOSHI` should just work: unknown tickers are resolved to the address
// with the deepest on-chain liquidity on the target chain (Dexscreener), and
// the resolution is echoed back in `resolved` so nothing is silent. The batch
// endpoint deliberately skips this (subrequest budget) — addresses there.

/** Symbol resolution is an external Dexscreener fetch; cache the HIT and the
 *  MISS so a repeated (hallucinated) ticker costs one fetch, not one each.
 *  Positive 1h (a token's address is stable), negative 5min (a new token could
 *  appear). Per-colo, fail-open — an absent cache just re-resolves. */
async function resolveSymbolCached(
  chainId: SupportedChainId,
  raw: string,
): Promise<ResolvedSymbol | undefined> {
  const key = `__sym|${chainId}|${raw.toLowerCase()}`;
  const hit = await edgeGet(key);
  if (hit) {
    if (hit.miss) return undefined;
    return hit.v as ResolvedSymbol;
  }
  const res = await resolveSymbolViaDex(chainId, raw);
  await edgePut(key, res ? { v: res } : { miss: true }, res ? 3_600 : 300);
  return res;
}

async function resolveUnknownSymbols(searchParams: URLSearchParams): Promise<{
  sp: URLSearchParams;
  resolved: Record<string, ResolvedSymbol>;
}> {
  const resolved: Record<string, ResolvedSymbol> = {};
  const chainId = resolveChainParam(searchParams.get('chain') ?? searchParams.get('chainId'));
  if (!chainId) return { sp: searchParams, resolved };

  const sp = new URLSearchParams(searchParams);
  const sides = [
    { keys: ['in', 'tokenIn'] as const, label: 'tokenIn' },
    { keys: ['out', 'tokenOut'] as const, label: 'tokenOut' },
  ];
  await Promise.all(sides.map(async ({ keys, label }) => {
    const key = keys.find((k) => searchParams.get(k) !== null);
    if (!key) return;
    const raw = (searchParams.get(key) ?? '').trim();
    // Already an address or a built-in symbol → nothing to do.
    if (!raw || resolveTokenParam(raw, chainId) || !SYMBOLISH.test(raw)) return;
    const hit = await resolveSymbolCached(chainId, raw);
    if (hit) {
      sp.set(key, hit.address);
      resolved[label] = hit;
    }
  }));
  return { sp, resolved };
}

// ── Integrator surface: zero RPC ─────────────────────────────────────────────

const INTEGRATE = {
  sdk: 'npm i @blazephoenix/sdk viem — quotes, verified calldata and execution on your RPC, in-process',
  mcp: 'npx -y @blazephoenix/mcp with BLAZEPHOENIX_RPC_<CHAIN>=… — agent tools on your machine and your RPC',
  prepare: 'GET /api/quote/prepare (same params) → the eth_call to run on your node',
  decode: 'POST /api/quote/decode { request, result } → quote + Phoenix Check + calldata (pure, no RPC)',
  deployments: 'GET /api/deployments — versioned contract registry',
};

/** Validate + build the prepared eth_call for one set of params (pure). */
export function prepareFromParams(searchParams: URLSearchParams, nowSec = Math.floor(Date.now() / 1000)):
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string } {
  const parsed = parseQuoteParams(searchParams);
  if (!parsed.ok) {
    // Unknown tickers are the one thing the old relay resolved server-side
    // (an outbound fetch per request). The integrator surface no longer
    // fetches anything, so it says what to pass instead.
    if (parsed.code === 'bad_token_in' || parsed.code === 'bad_token_out') {
      return { ...parsed, message: `${parsed.message} (ETH, WETH, USDC and BZPX are built in; everything else by address)` };
    }
    return parsed;
  }
  const p = parsed.params;
  return prepareQuote({
    chainId: p.chainId, tokenIn: p.tokenIn, tokenOut: p.tokenOut, amountIn: p.amountIn,
    nativeIn: p.nativeIn, nativeOut: p.nativeOut, exact: p.exact,
    ...(p.recipient ? { recipient: p.recipient } : {}),
    ...(p.slippageBps !== undefined ? { slippageBps: p.slippageBps } : {}),
    deadlineSec: p.deadlineSec,
    ...(p.userMinOut !== undefined ? { userMinOut: p.userMinOut } : {}),
    ...(p.version !== undefined ? { version: p.version } : {}),
  }, nowSec);
}

/** GET /api/quote/prepare — zero RPC. */
export function handlePrepare(url: URL): Response {
  const r = prepareFromParams(url.searchParams);
  if (!r.ok) return json(r.status, { ok: false, code: r.code, error: r.message });
  return json(200, r.body);
}

/** POST /api/quote/prepare { requests: [...] } — one JSON-RPC batch for your node. */
export async function handlePrepareBatch(request: Request): Promise<Response> {
  const raw = await readJsonBody(request);
  if (!raw.ok) return json(400, { ok: false, code: raw.code, error: raw.message });
  const parsed = parseBatchBody(raw.value, MAX_PREPARE_BATCH);
  if (!parsed.ok) return json(parsed.status, { ok: false, code: parsed.code, error: parsed.message });
  const now = Math.floor(Date.now() / 1000);
  const items = parsed.items.map((sp) => {
    const r = prepareFromParams(sp, now);
    return r.ok ? r.body : { ok: false, code: r.code, error: r.message };
  });
  const rpcBatch = items
    .map((it, i) => ((it as { ok?: boolean }).ok ? { ...((it as { rpcRequest: Record<string, unknown> }).rpcRequest), id: i } : null))
    .filter(Boolean);
  return json(200, {
    ok: true,
    mode: 'prepare',
    count: items.length,
    rpcBatch,
    items,
    note: 'POST rpcBatch to YOUR node as one JSON-RPC batch (ids = item index), then decode each result with its item.request.',
  });
}

/** POST /api/quote/decode { request, result } | { items: [{ request, result }] } — zero RPC. */
export async function handleDecode(request: Request): Promise<Response> {
  const raw = await readJsonBody(request);
  if (!raw.ok) return json(400, { ok: false, code: raw.code, error: raw.message });
  const body = raw.value as { request?: unknown; result?: unknown; items?: unknown };
  if (Array.isArray(body?.items)) {
    if (body.items.length === 0 || body.items.length > MAX_PREPARE_BATCH) {
      return json(400, { ok: false, code: 'too_many', error: `items: 1–${MAX_PREPARE_BATCH}` });
    }
    const results = body.items.map((it) => {
      const r = decodeQuote((it as { request?: unknown })?.request, (it as { result?: unknown })?.result);
      return r.ok ? r.body : { ok: false, code: r.code, error: r.message };
    });
    return json(200, { ok: true, count: results.length, results });
  }
  const r = decodeQuote(body?.request, body?.result);
  if (!r.ok) return json(r.status, { ok: false, code: r.code, error: r.message });
  return json(200, r.body);
}

/** Bounded JSON body reader: the codec is pure CPU, so the only thing worth
 *  bounding is how much of it a single request can buy. */
const MAX_BODY_BYTES = 512 * 1024;
export const MAX_PREPARE_BATCH = 32;
async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; code: string; message: string }> {
  const len = Number(request.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) return { ok: false, code: 'too_large', message: `body over ${MAX_BODY_BYTES} bytes` };
  let text: string;
  try { text = await request.text(); } catch { return { ok: false, code: 'bad_json', message: 'unreadable body' }; }
  if (text.length > MAX_BODY_BYTES) return { ok: false, code: 'too_large', message: `body over ${MAX_BODY_BYTES} bytes` };
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, code: 'bad_json', message: 'body is not valid JSON' }; }
}

// ── GET /api/quote — the old relay, retired: answers with what to run instead ──

export async function handleQuote(url: URL): Promise<Response> {
  const r = prepareFromParams(url.searchParams);
  if (!r.ok) return json(r.status, { ok: false, code: r.code, error: r.message });
  return json(400, {
    ok: false,
    code: 'rpc_required',
    error: RPC_REQUIRED_MESSAGE,
    prepared: r.body,
    integrate: INTEGRATE,
    docs: 'https://blazephoenix.xyz/?tab=api',
  });
}

// ── FIRST-PARTY quote (the site's own Telegram bot) — our read pool ──────────
// Not routed from any public path. It exists so the site's own bot answers
// humans the way the swap screen does; integrators use prepare/decode or the SDK.

export async function handleQuoteFirstParty(url: URL): Promise<Response> {
  // Cheap pre-validation BEFORE any external fetch: a bad chain or a malformed
  // amount is rejected here, so a request with a hallucinated symbol AND junk
  // params never pays a Dexscreener symbol resolution.
  const preChainId = resolveChainParam(url.searchParams.get('chain') ?? url.searchParams.get('chainId'));
  if (!preChainId) {
    return json(400, { ok: false, code: 'bad_chain',
      error: `unknown chain — use one of: ${CHAIN_ORDER.join(', ')} (or base/eth/optimism/arbitrum/robinhood)` });
  }
  if (!isDexLive(preChainId)) {
    return json(400, { ok: false, code: 'chain_not_live', error: 'DEX not deployed on this chain yet' });
  }
  const rawAmt = url.searchParams.get('amountIn') ?? url.searchParams.get('amount');
  if (!rawAmt || !INT.test(rawAmt.trim())) {
    return json(400, { ok: false, code: 'bad_amount',
      error: 'amountIn must be a positive integer in the token’s base units (wei-style)' });
  }

  const { sp, resolved } = await resolveUnknownSymbols(url.searchParams);
  const parsed = parseQuoteParams(sp);
  if (!parsed.ok) {
    return json(parsed.status, { ok: false, code: parsed.code, error: parsed.message });
  }
  const r = await cachedExec(parsed.params);
  if (r.status === 200 && Object.keys(resolved).length > 0) {
    r.body.resolved = resolved; // symbol → address transparency, always
    r.body.resolvedNote = 'symbols resolved by deepest on-chain liquidity — pass 0x addresses for precision';
  }
  if (r.status === 200) {
    // Self-describing payload: a consumer (human, bot or AI agent) who sees
    // ONLY this response still knows the units and where everything lives.
    r.body.units = 'all amounts are integer base units (wei-style) as decimal strings';
    r.body.links = {
      docs: 'https://blazephoenix.xyz/?tab=api',
      openapi: 'https://blazephoenix.xyz/api/openapi.json',
      manifest: 'https://blazephoenix.xyz/api/manifest',
      sdk: 'https://github.com/blazephoenixxyz-crypto/SDK',
    };
  }
  return json(r.status, r.body, r.status === 200 ? quoteTtlSecs(parsed.params.chainId) : 0,
    { 'x-bzp-cache': r.cache });
}

// ── POST /api/quote/batch ────────────────────────────────────────────────────

/** Validate the batch envelope (pure — unit tested): array of plain objects
 *  whose values become the same search params the GET endpoint accepts. */
export function parseBatchBody(raw: unknown, max = MAX_BATCH):
  | { ok: true; items: URLSearchParams[] }
  | { ok: false; status: number; code: string; message: string } {
  const bad = (code: string, message: string) => ({ ok: false as const, status: 400, code, message });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return bad('bad_body', 'body must be a JSON object: { "requests": [ … ] }');
  }
  const reqs = (raw as { requests?: unknown }).requests;
  if (!Array.isArray(reqs) || reqs.length === 0) {
    return bad('bad_body', 'requests must be a non-empty array');
  }
  if (reqs.length > max) {
    return bad('too_many', `max ${max} requests per batch`);
  }
  const items: URLSearchParams[] = [];
  for (const r of reqs) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      return bad('bad_item', 'each request must be an object of quote parameters');
    }
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        sp.set(k, String(v));
      } else {
        return bad('bad_item', `parameter "${k}" must be a string/number/boolean`);
      }
    }
    items.push(sp);
  }
  return { ok: true, items };
}

/** The old relayed batch, retired like GET /api/quote: answers with the
 *  prepared JSON-RPC batch to run on the caller's own node. */
export async function handleQuoteBatch(request: Request): Promise<Response> {
  const raw = await readJsonBody(request);
  if (!raw.ok) return json(400, { ok: false, code: raw.code, error: raw.message });
  const parsed = parseBatchBody(raw.value);
  if (!parsed.ok) {
    return json(parsed.status, { ok: false, code: parsed.code, error: parsed.message });
  }
  const now = Math.floor(Date.now() / 1000);
  const items = parsed.items.map((sp) => {
    const r = prepareFromParams(sp, now);
    return r.ok ? r.body : { ok: false, code: r.code, error: r.message };
  });
  return json(400, {
    ok: false,
    code: 'rpc_required',
    error: RPC_REQUIRED_MESSAGE,
    prepared: items,
    integrate: INTEGRATE,
    docs: 'https://blazephoenix.xyz/?tab=api',
  });
}

// ── quote execution (FIRST-PARTY: the site's own bot) ────────────────────────

async function execQuote(p: QuoteParams): Promise<{ status: number; body: Record<string, unknown> }> {
  const quoter = CHAINS[p.chainId].contracts.quoter;
  const router = CHAINS[p.chainId].contracts.router;

  const data = encodeFunctionData({
    abi: QUOTER_ABI,
    functionName: p.exact ? 'previewPlanExact' : 'previewPlan',
    args: [p.tokenIn, p.tokenOut, p.amountIn],
  });

  const t0 = Date.now();
  const call = await ethCall(p.chainId, quoter, data);
  const latencyMs = Date.now() - t0;

  if (call.revertData) {
    return { status: 422, body: {
      ok: false,
      code: 'no_route',
      error: `quoter reverted: ${describeRevert(call.revertData)}`,
      chainId: p.chainId,
    } };
  }
  if (!call.result) {
    return { status: 502, body: { ok: false, code: 'rpc_unreachable', error: 'all RPC endpoints failed — retry shortly' } };
  }

  try {
    if (p.exact) {
      const [route, exactOut] = decodeFunctionResult({
        abi: QUOTER_ABI, functionName: 'previewPlanExact', data: call.result,
      }) as unknown as [Record<string, unknown>, bigint];
      return { status: 200, body: {
        ok: true,
        mode: 'exact',
        chainId: p.chainId,
        tokenIn: p.tokenIn,
        tokenOut: p.tokenOut,
        amountIn: p.amountIn.toString(),
        amountOut: exactOut.toString(),
        route: jsonSafe(route),
        wrapRequired: p.nativeIn,
        meta: { quotedAt: Date.now(), latencyMs, rpcTried: call.rpcTried, rpc: 'first-party' },
      } };
    }

    const [pv] = decodeFunctionResult({
      abi: QUOTER_ABI, functionName: 'previewPlan', data: call.result,
    }) as unknown as [{
      route: { expectedImpactBps: bigint; estGas: bigint; hasSurplus: boolean } & Record<string, unknown>;
      grossOut: bigint; protocolFee: bigint; netOut: bigint; ironFloor: bigint;
      effectiveMinOut: bigint; estGas: bigint; hops: bigint; legs: bigint; canExecute: boolean;
    }, unknown, boolean];

    // Optional ready-to-broadcast calldata (ERC-20 input only — native ETH
    // needs a WETH wrap first, which is the caller's move).
    let tx: { to: `0x${string}`; data: `0x${string}`; value: '0' } | undefined;
    if (p.recipient && !p.nativeIn && pv.canExecute) {
      const minOut = p.slippageBps !== undefined
        ? pv.netOut - (pv.netOut * BigInt(p.slippageBps)) / 10_000n
        : pv.effectiveMinOut;
      tx = {
        to: router,
        data: encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: 'swapExactIn',
          // The decoded route struct round-trips straight back into calldata.
          args: [
            pv.route as never, p.amountIn, minOut, p.recipient,
            BigInt(Math.floor(Date.now() / 1000) + p.deadlineSec),
          ],
        }),
        value: '0',
      };
    }

    const impactBps = Math.min(10_000, Math.max(0, Number(pv.route.expectedImpactBps) || 0));
    // Phoenix Check — ONE implementation (worker/codec.ts) shared with the
    // zero-RPC decode endpoint, so the bot and integrators read the same verdict.
    const checks = phoenixChecks(pv as unknown as Preview, p.tokenIn, p.tokenOut, 'previewPlan (on-chain eth_call)');

    return { status: 200, body: {
      ok: true,
      mode: 'preview',
      chainId: p.chainId,
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      amountIn: p.amountIn.toString(),
      // The number a bot compares across aggregators: net output after fee.
      amountOut: pv.netOut.toString(),
      quote: {
        grossOut: pv.grossOut.toString(),
        protocolFee: pv.protocolFee.toString(),
        netOut: pv.netOut.toString(),
        ironFloor: pv.ironFloor.toString(),
        effectiveMinOut: pv.effectiveMinOut.toString(),
        impactBps,
        estGas: pv.estGas.toString(),
        hops: Number(pv.hops),
        legs: Number(pv.legs),
        canExecute: pv.canExecute,
        hasSurplus: pv.route.hasSurplus,
        feeBps: SITE.protocol.feeBps,
      },
      route: jsonSafe(pv.route),
      checks,
      ...(tx ? { tx } : {}),
      wrapRequired: p.nativeIn,
      unwrapAfter: p.nativeOut, // out=ETH quotes deliver WETH — unwrap is yours
      executeWith: {
        router,
        function: 'swapExactIn(route, amountIn, userMinOut, recipient, deadline)',
        note: p.nativeIn
          ? 'native ETH input: wrap to WETH first (WETH.deposit), then approve + swap'
          : 'approve the router (or use Permit2) for tokenIn, then send tx.data to router',
      },
      meta: { quotedAt: Date.now(), latencyMs, rpcTried: call.rpcTried, rpc: 'first-party' },
    } };
  } catch {
    return { status: 500, body: { ok: false, code: 'decode_failed', error: 'unexpected quoter response shape' } };
  }
}

// ── GET /api/stats — live protocol numbers, straight from the chain ─────────
// Fills counted from the Router's own Swap events over a bounded recent block
// window per chain — reproducible by anyone with the same getLogs call. This
// is the number the founder posts and the number an indexer sanity-checks;
// they can never disagree because they come from the same place. Edge-cached
// 5 minutes so even heavy polling costs almost nothing upstream.

/** Stats-only RPC timeout. See the note in rpcJson below for why it is shorter
 *  than RPC_TIMEOUT_MS: this path tries four endpoints, the quote path two. */
const STATS_RPC_TIMEOUT_MS = 2_500;

const SWAP_TOPIC0 = toEventSelector('Swap(address,address,address,uint256,uint256,uint256)');
const EXECUTION_PROOF_TOPIC0 = toEventSelector('ExecutionProof(address,address,uint256,uint256,uint256,uint256)');

/** getLogs windows that stay under public-RPC caps (mirror the live tape). */
const STATS_SPAN: Record<SupportedChainId, bigint> = {
  1: 3_000n, 8453: 9_000n, 10: 9_000n, 42161: 9_500n, 4663: 9_000n,
};
const SECS_PER_BLOCK: Record<SupportedChainId, number> = {
  1: 12, 8453: 2, 10: 2, 42161: 0.25, 4663: 2,
};

async function rpcJson(chainId: SupportedChainId, method: string, params: unknown[]): Promise<unknown> {
  // FOUR endpoints, not two. The original budget was two, on the reasoning that
  // stats are edge-cached so a tight budget is cheap — sound logic, overtaken by
  // the pool rotting underneath it.
  //
  // Measured directly, 2026-08-29:
  //   eth.llamarpc.com                 HTTP 521, down
  //   ethereum-rpc.publicnode.com      eth_blockNumber fine, but eth_getLogs now
  //                                    answers "Archive requests require a
  //                                    personal token" — and getLogs IS this
  //                                    endpoint's whole job
  //   base-rpc.publicnode.com          same gating
  //   mainnet.base.org                 healthy, 0.75s for the full 9,000-block
  //                                    window, well inside the 3.5s timeout
  //
  // publicnode sits at rpcs[1] on Ethereum, Base and Optimism, so on three of
  // five chains a two-endpoint budget was really a ONE-endpoint budget against
  // a rate-limited public node. That is why /api/stats reported 0 of 5 chains
  // reachable while /api/quote — which uses eth_call, a different rate class —
  // kept working from the same Worker.
  //
  // Deliberately NOT reordering the public providers: which upstreams to trust
  // is the owner's call. But the ladder now runs to its real end. The keyed
  // endpoints sit at positions 6-7 of CHAINS[id].rpcs, so a slice(0, 4) could
  // never reach them: the scan gave up while the strongest nodes we have sat
  // unused, and the public dataset recorded 21 of 50 chain-days measured — 42%
  // coverage — with the gap annotated as RET-2026-006. The house RPC policy
  // (chains.ts) is public first, Alchemy when public fails, dRPC strictly last
  // because it is the scarcest; this ladder is exactly that, for a read that
  // runs at most once per five minutes per chain on a cache miss.
  const ladder = [
    ...CHAINS[chainId].rpcs.slice(0, 4),
    ...alchemyFor(chainId).slice(0, 1),
    DRPC[chainId],
  ].filter((u, i, a) => u && a.indexOf(u) === i);
  for (const rpc of ladder) {
    const ctrl = new AbortController();
    // Its own, shorter timeout — widening the budget from two endpoints to four
    // would otherwise quadruple the worst case on a cache miss (4 x 3.5s per
    // method, and chainStats issues three). The full 9,000-block getLogs was
    // measured at 0.75s against a healthy node, so 2.5s still leaves better than
    // 3x headroom while keeping the miss bounded.
    const timer = setTimeout(() => ctrl.abort(), STATS_RPC_TIMEOUT_MS);
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          origin: 'https://blazephoenix.xyz',
          referer: 'https://blazephoenix.xyz/',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { result?: unknown };
      if (body.result !== undefined) return body.result;
    } catch { /* next endpoint */ } finally { clearTimeout(timer); }
  }
  return undefined;
}

async function chainStats(chainId: SupportedChainId) {
  const c = CHAINS[chainId];
  const base = {
    chainId, name: c.name, router: c.contracts.router,
    windowBlocks: Number(STATS_SPAN[chainId]),
    windowHoursApprox: Math.round((Number(STATS_SPAN[chainId]) * SECS_PER_BLOCK[chainId]) / 360) / 10,
  };
  const tipHex = (await rpcJson(chainId, 'eth_blockNumber', [])) as string | undefined;
  if (!tipHex) return { ...base, ok: false as const };
  const tip = BigInt(tipHex);
  const from = tip > STATS_SPAN[chainId] ? tip - STATS_SPAN[chainId] : 0n;
  const range = { fromBlock: `0x${from.toString(16)}`, toBlock: 'latest' };
  // "Execution beat the quote" is measured per generation, never assumed:
  //  1.x routers emit Surplus(token, amount) — paid to the user fee-exempt.
  //  2.x routers emit ExecutionProof(user, tokenOut, quoted, realized, …) on
  //  every fill; a surplus fill is one whose realised output exceeds the quote.
  // Counted (not priced): amounts span many tokens and we refuse to fake a USD total.
  const v2 = isV2(c.protocolVersion);
  const [logs, surplusLogs] = await Promise.all([
    rpcJson(chainId, 'eth_getLogs', [{ address: c.contracts.router, topics: [SWAP_TOPIC0], ...range }]),
    rpcJson(chainId, 'eth_getLogs', [{
      address: c.contracts.router,
      topics: [v2 ? EXECUTION_PROOF_TOPIC0 : toEventSelector('Surplus(address,uint256)')],
      ...range,
    }]),
  ]) as [{ topics?: string[] }[] | undefined, { data?: string }[] | undefined];
  if (!Array.isArray(logs)) return { ...base, ok: false as const };
  const traders = new Set<string>();
  for (const log of logs) if (log.topics?.[1]) traders.add(log.topics[1]);
  let surplusPayouts = 0;
  if (Array.isArray(surplusLogs)) {
    if (!v2) surplusPayouts = surplusLogs.length;
    else {
      for (const l of surplusLogs) {
        const d = l.data ?? '';
        if (d.length < 2 + 64 * 2) continue;
        const quoted = BigInt(`0x${d.slice(2, 66)}`);
        const realized = BigInt(`0x${d.slice(66, 130)}`);
        if (realized > quoted) surplusPayouts++;
      }
    }
  }
  return {
    ...base, ok: true as const,
    protocolVersion: c.protocolVersion,
    fills: logs.length,
    uniqueTraders: traders.size,
    surplusPayouts,
    surplusBasis: v2 ? 'ExecutionProof: realized > quoted' : 'Surplus events',
    latestBlock: Number(tip),
  };
}


// ── GET /api/tape — shared deep swap history for the Live Tape ───────────────
// New visitors have no cache and public RPCs cap getLogs windows, so a fresh
// browser could see an empty tape. The worker scans BACKWARD in bounded chunks
// (early-exit at TAPE_KEEP events, hard chunk cap) and the result is edge-
// cached — one deep scan serves every visitor for 2 minutes.
const TAPE_KEEP = 15;
const TAPE_MAX_CHUNKS = 12;
export async function handleTape(url: URL): Promise<Response> {
  const chainId = resolveChainParam(url.searchParams.get('chain') ?? url.searchParams.get('chainId')) ?? 8453;
  if (!isDexLive(chainId)) return json(400, { ok: false, error: 'chain not live' });
  // v2: the body gained chunksScanned/chunksOk/measured. Bump so the 2-minute
  // edge cache cannot keep serving v1 bodies that lack them.
  const CACHE_KEY = `__tape_v2_${chainId}`;
  const hit = await edgeGet(CACHE_KEY);
  if (hit) return json(200, hit, 60);
  const c = CHAINS[chainId];
  const tipHex = (await rpcJson(chainId, 'eth_blockNumber', [])) as string | undefined;
  if (!tipHex) return json(502, { ok: false, error: 'rpc unreachable' });
  const tip = BigInt(tipHex);
  const span = STATS_SPAN[chainId];
  const swaps: { txHash: string; user: string; tokenIn: string; tokenOut: string; amountIn: string; amountOut: string; legs: number; blockNumber: string }[] = [];
  let to = tip;
  // COVERAGE, added 2026-08-29 — the same defect /api/stats had, in its sibling.
  // Only the opening eth_blockNumber failure returned 502; every getLogs chunk
  // below sat inside `if (Array.isArray(logs))` with no else, so all twelve
  // could fail and this endpoint would still answer ok:true with swaps: [].
  // Demonstrated live: at 01:31 /api/stats reported Ethereum ok:false, and at
  // 01:32 /api/tape answered ok:true, swaps: [] for the same chain, the same
  // eth_getLogs, the same minute. The body is edge-cached, so a transient
  // failure froze as an assertion of emptiness — on a surface /stats lists in
  // its Dataset markup as a citable distribution.
  let chunksScanned = 0;
  let chunksOk = 0;
  for (let i = 0; i < TAPE_MAX_CHUNKS && swaps.length < TAPE_KEEP && to > 0n; i++) {
    const from = to > span ? to - span : 0n;
    const logs = (await rpcJson(chainId, 'eth_getLogs', [{
      address: c.contracts.router, topics: [SWAP_TOPIC0],
      fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`,
    }])) as { transactionHash?: string; blockNumber?: string; topics?: string[]; data?: string }[] | undefined;
    chunksScanned++;
    if (Array.isArray(logs)) {
      chunksOk++;
      for (const l of logs) {
        if (!l.topics || l.topics.length < 4 || !l.data || l.data.length < 2 + 64 * 3) continue;
        const word = (n: number) => l.data!.slice(2 + n * 64, 2 + (n + 1) * 64);
        swaps.push({
          txHash: l.transactionHash ?? '',
          user: `0x${l.topics[1].slice(26)}`,
          tokenIn: `0x${l.topics[2].slice(26)}`,
          tokenOut: `0x${l.topics[3].slice(26)}`,
          amountIn: BigInt(`0x${word(0)}`).toString(),
          amountOut: BigInt(`0x${word(1)}`).toString(),
          legs: Number(BigInt(`0x${word(2)}`)),
          blockNumber: (l.blockNumber ? BigInt(l.blockNumber) : 0n).toString(),
        });
      }
    }
    to = from > 0n ? from - 1n : 0n;
    if (from === 0n) break;
  }
  swaps.sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)));
  const body = {
    ok: true, chainId, latestBlock: Number(tip), secPerBlock: SECS_PER_BLOCK[chainId],
    note: 'Router Swap events, deep-scanned in bounded chunks — reproduce with eth_getLogs (topic0 in /api/manifest). Read `swaps` TOGETHER with chunksOk/chunksScanned: an empty list with chunksOk = 0 means the scan failed, not that the Router is idle.',
    // How much of the intended scan actually returned. measured=false is the
    // signal that an empty `swaps` carries no information.
    chunksScanned,
    chunksOk,
    measured: chunksOk > 0,
    swaps: swaps.slice(0, TAPE_KEEP),
  };
  await edgePut(CACHE_KEY, body, 120);
  return json(200, body, 60);
}

export async function handleStats(): Promise<Response> {
  // v3: the response gained chainsOk/chainsTotal/coverage/measured. Bumping the
  // key so the 5-minute edge cache cannot keep serving v2 bodies that lack them.
  const CACHE_KEY = '__stats_v3';
  const hit = await edgeGet(CACHE_KEY);
  if (hit) return json(200, hit, 60);

  const chains = await Promise.all(
    CHAIN_ORDER.filter((id) => isDexLive(id)).map((id) => chainStats(id)),
  );
  // COVERAGE, added 2026-08-29 — the aggregate used to be unreadable.
  //
  // totalFills sums `ch.ok ? ch.fills : 0`, so a chain whose scan FAILED
  // contributes the same 0 as a chain that was scanned and genuinely had no
  // swaps. With ok:true beside it, the response reads as "we measured, and it
  // is zero" in both cases. Measured that morning: 0 of 5 chains reachable,
  // and the response still said ok:true, totalFills:0. Ten days of
  // public/datasets/history.ndjson show the same shape — never more than 3 of
  // 5 chains up, every row recording a confident zero.
  //
  // That matters more than a dashboard cosmetic: /proof-of-traction promises in
  // writing that "if an endpoint is unreachable the figure is left blank rather
  // than filled with a stale value". The PAGE honours it (it renders nothing).
  // This endpoint did not, and it is what feeds the citable dataset.
  //
  // The fields below are ADDITIVE on purpose. Making totalFills null when
  // coverage is zero is the stricter fail-closed reading, and it is also a
  // breaking change for anything already consuming the number — that is the
  // owner's call, not a side effect of this fix. With chainsOk exposed, a
  // reader can already tell the two cases apart, which is the whole defect.
  const chainsOk = chains.filter((ch) => ch.ok).length;
  const body = {
    ok: true,
    updatedAt: Date.now(),
    note: 'fills = Swap events on the Router over the recent block window — reproduce with the same eth_getLogs call (topic0 in /api/manifest)',
    // Read totalFills TOGETHER with these two. totalFills is a sum over the
    // chains that answered; when chainsOk is 0 it is the sum of nothing, not a
    // measurement of zero.
    chainsOk,
    chainsTotal: chains.length,
    coverage: chains.length ? Number((chainsOk / chains.length).toFixed(2)) : 0,
    measured: chainsOk > 0,
    totalFills: chains.reduce((n, ch) => n + (ch.ok ? ch.fills : 0), 0),
    totalSurplusPayouts: chains.reduce((n, ch) => n + (ch.ok ? (ch as { surplusPayouts?: number }).surplusPayouts ?? 0 : 0), 0),
    chains,
  };
  await edgePut(CACHE_KEY, body, 300);
  return json(200, body, 60);
}

// ── GET /api — discovery root: the API explains itself ──────────────────────
// Universal entry point: a human, a bot or an AI agent that lands on /api with
// zero prior knowledge leaves with everything (HATEOAS, revived for agents).

export function handleDiscovery(): Response {
  return json(200, {
    ok: true,
    name: `${SITE.name} Integration API`,
    version: SITE.protocol.version,
    description:
      'On-chain DEX-aggregator integration for Base (8453), Ethereum (1), Optimism (10), '
      + 'Arbitrum (42161) and Robinhood Chain (4663). Quotes run on YOUR RPC: this API performs '
      + 'no RPC for integrators — it prepares the eth_call for your node and decodes the answer, '
      + 'and publishes the versioned contract registry. No key, no signup, open CORS. Amounts are '
      + 'integer base units (wei-style) as decimal strings.',
    endpoints: {
      prepare: { method: 'GET', path: '/api/quote/prepare', example: '/api/quote/prepare?chain=base&in=WETH&out=USDC&amountIn=1000000000000000000', note: 'the eth_call to run on your node (add recipient for swap calldata)' },
      prepareBatch: { method: 'POST', path: '/api/quote/prepare', note: `{ requests: [...] } → one JSON-RPC batch, max ${MAX_PREPARE_BATCH}` },
      decode: { method: 'POST', path: '/api/quote/decode', note: '{ request, result } → quote, Phoenix Check, verified calldata (pure)' },
      deployments: { method: 'GET', path: '/api/deployments', note: 'versioned registry: Core/Hub/Solver/Quoter/Router per chain and version' },
      abi: { method: 'GET', path: '/api/abi?contract=quoter', note: 'ABIs generated from the Solidity sources' },
      quote: { method: 'GET', path: '/api/quote', note: 'retired relay — answers 400 rpc_required with the prepared call inline' },
      quoteBatch: { method: 'POST', path: '/api/quote/batch', note: 'retired relay — answers 400 rpc_required with the prepared calls inline' },
      manifest: { method: 'GET', path: '/api/manifest', note: 'contracts, token, event topic0s per chain' },
      openapi: { method: 'GET', path: '/api/openapi.json' },
      health: { method: 'GET', path: '/api/health' },
      stats: { method: 'GET', path: '/api/stats', note: 'live fills per chain from on-chain Swap events (reproducible)' },
      badge: { method: 'GET', path: '/api/badge', note: 'shields.io endpoint JSON — live isSolvent() badge for any README' },
      solvency: { method: 'GET', path: '/solvency', note: 'live proof-of-solvency report (HTML, full solvency() struct from chain)' },
      llms: { method: 'GET', path: '/llms.txt', note: 'agent-readable integration guide' },
    },
    docs: 'https://blazephoenix.xyz/?tab=api',
    sdk: 'https://github.com/blazephoenixxyz-crypto/SDK',
    mcp: 'https://github.com/blazephoenixxyz-crypto/blazephoenix-mcp',
    integrate: INTEGRATE,
    contact: SITE.contactEmail,
  }, 3_600);
}

// ── GET /api/deployments — the versioned registry (zero RPC) ─────────────────
// What SDK 1.x and the local MCP servers resolve against. Short cache: a new
// deployment should reach integrators within minutes of the site deploy that
// publishes it — and every consumer re-verifies it on its own RPC anyway.
export function handleDeployments(): Response {
  return json(200, {
    ok: true,
    ...registryDocument(),
    abiRevision: ABI_SOURCE_REVISION,
    abi: '/api/abi',
    note: 'A contract set is live on a chain when its router and quoter are non-zero. Addresses of a live version never change; new code ships as a new version. Consumers verify on their own RPC: code at every address, VERSION(), and the Quoter/Router/Solver wiring.',
  }, 300);
}

// ── GET /api/abi?contract=… — generated ABIs (zero RPC) ──────────────────────
const ABIS: Record<string, readonly unknown[]> = {
  quoter: QUOTER_ABI, router: ROUTER_ABI, solver: SOLVER_ABI, hub: HUB_ABI, core: CORE_ABI, errors: BLAZE_ERRORS_ABI,
};
export function handleAbi(url: URL): Response {
  const c = (url.searchParams.get('contract') ?? '').trim().toLowerCase();
  if (!c) {
    return json(200, {
      ok: true, revision: ABI_SOURCE_REVISION, contracts: Object.keys(ABIS),
      example: '/api/abi?contract=quoter',
      note: 'Generated from Blaze-Phoenix-Dex with solc 0.8.36. 1.0.0 deployments answer every 1.x function with the same signature; 2.0.0 adds previewAndEncode, batchQuote, swapExactInNative, swapBestExactIn, VERSION() and ExecutionProof.',
    }, 3_600);
  }
  const abi = ABIS[c];
  if (!abi) return json(400, { ok: false, code: 'bad_contract', error: `contract must be one of: ${Object.keys(ABIS).join(', ')}` });
  return json(200, { ok: true, contract: c, revision: ABI_SOURCE_REVISION, abi }, 3_600);
}

// ── GET /api/health — monitoring surface (uptime bots, integrators) ─────────
// Deliberately zero upstream calls: it reports service + config state fast and
// free, so anyone can poll it aggressively without costing us RPC.

export function handleHealth(): Response {
  // `live` IS NOT A REACHABILITY PROBE, and the response now says so in the
  // body rather than only in the OpenAPI prose.
  //
  // isDexLive() is a compile-time config constant: it answers "is the DEX
  // deployed on this chain", never "did we just reach it". The endpoint makes
  // zero upstream calls by design, which is why it can be polled freely — but
  // the endpoint is called `health`, the field is called `live`, and the value
  // is `true`, so an uptime bot reads all five chains as up. Measured
  // 2026-08-29 at 01:19: this returned live:true for Ethereum while /api/stats
  // reported Ethereum ok:false and /open published Ethereum at 0% availability
  // over 0/10 days. Three of our own surfaces, three different answers.
  //
  // Additive fix: `probed: false` beside every entry, and a note naming the
  // endpoint that DOES measure. Renaming `live` would be the cleaner shape and
  // is a breaking change for anything already parsing it — the owner's call,
  // not a side effect of this one.
  return json(200, {
    ok: true,
    service: 'blazephoenix-api',
    version: SITE.protocol.version,
    now: Date.now(),
    note: 'live = configured and deployed on this chain, NOT a reachability probe. This endpoint makes zero upstream calls so it can be polled freely. For MEASURED reachability read /api/stats and compare chainsOk against chainsTotal.',
    chains: CHAIN_ORDER.map((id) => ({
      chainId: id, name: CHAINS[id].name, live: isDexLive(id), probed: false,
    })),
  }, 10);
}

// ── GET /api/manifest ────────────────────────────────────────────────────────

/** Machine-readable protocol manifest: everything an indexer, aggregator or
 *  bot needs to wire BlazePhoenix without reading a single docs page. */
export function handleManifest(): Response {
  const chains = CHAIN_ORDER.map((id) => {
    const c = CHAINS[id];
    return {
      chainId: id,
      name: c.name,
      // Same meaning as in /api/health: deployed-on-this-chain, never probed.
      live: isDexLive(id), probed: false,
      protocolVersion: c.protocolVersion,
      explorer: c.explorer,
      contracts: c.contracts,
      weth: c.weth,
      usdc: c.usdc,
      ...(c.bzpx ? { bzpx: c.bzpx } : {}),
    };
  });
  return json(200, {
    ok: true,
    name: SITE.name,
    version: SITE.protocol.version,
    url: 'https://blazephoenix.xyz',
    docs: 'https://blazephoenix.xyz/?tab=api',
    // Quotes run on the integrator's RPC; these are the zero-RPC helpers.
    deployments: 'https://blazephoenix.xyz/api/deployments',
    prepare: 'https://blazephoenix.xyz/api/quote/prepare',
    decode: 'https://blazephoenix.xyz/api/quote/decode',
    integrate: INTEGRATE,
    token: SITE.token,
    feeBps: SITE.protocol.feeBps,
    chains,
    events: {
      // topic0 hashes indexers filter on (Router address = `contracts.router`).
      Swap: {
        signature: 'Swap(address indexed user, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 legs)',
        topic0: toEventSelector('Swap(address,address,address,uint256,uint256,uint256)'),
      },
      ExecutionProof: {
        signature: 'ExecutionProof(address indexed user, address indexed tokenOut, uint256 quoted, uint256 realized, uint256 floorUsed, uint256 blockNumber)',
        topic0: EXECUTION_PROOF_TOPIC0,
        versions: '2.x',
      },
      Fee: {
        signature: 'Fee(address indexed token, uint256 amount, uint256 toT1, uint256 toT2)',
        topic0: toEventSelector('Fee(address,uint256,uint256,uint256)'),
        versions: '2.x',
      },
      Surplus: {
        signature: 'Surplus(address indexed token, uint256 amount)',
        topic0: toEventSelector('Surplus(address,uint256)'),
        versions: '1.x',
      },
    },
    contact: SITE.contactEmail,
  }, 3_600);
}
