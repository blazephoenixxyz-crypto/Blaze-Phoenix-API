// =============================================================================
//  THE CODEC — quote without our RPC.
//
//  Integrators' reads run on THEIR nodes. The site never makes an RPC call on
//  an integrator's behalf any more; what it still offers is pure computation:
//
//    prepare  (GET  /api/quote/prepare)  → the exact eth_call to run on your node
//    decode   (POST /api/quote/decode)   → your node's answer → quote, Phoenix
//                                          Check, and ready-to-sign calldata
//
//  Both are pure functions of their input: no fetch, no state, no key. The SDK
//  and the local MCP server do the same thing in-process, without us at all.
//
//  TRUST: `decode` never takes a contract address from the caller. The Quoter
//  and Router are re-resolved from config/deployments.ts by (chain, version),
//  so no request can make this endpoint emit a transaction to a foreign
//  contract under the blazephoenix.xyz name. On 2.x the Quoter's own calldata
//  (previewAndEncode) is decoded and verified field by field before it is
//  returned — the same rule the SDK applies.
// =============================================================================

import {
  decodeFunctionData, decodeFunctionResult, encodeFunctionData, getAbiItem, getAddress,
  type Hex,
} from 'viem';
import { QUOTER_ABI, ROUTER_ABI } from '../src/abis/blaze';
import { CHAINS, type SupportedChainId } from '../src/config/chains';
import { SITE } from '../src/config/site';
import {
  DEPLOYMENTS, compareVersions, deployedVersions, isV2, type ContractSet, type DeployedChainId,
} from '../src/config/deployments';

export type Address = `0x${string}`;

type Leg = {
  pool: Address; hooks: Address; kind: number; fee: number; tickSpacing: number;
  zeroForOne: boolean; stable: boolean; amountIn: bigint; expectedOut: bigint; auxId: Hex;
};
type Hop = { tokenIn: Address; tokenOut: Address; amountIn: bigint; expectedOut: bigint; legs: readonly Leg[] };
export type Route = {
  hops: readonly Hop[]; totalOut: bigint; singleOut: bigint; singleOutFloor: bigint;
  expectedImpactBps: bigint; confidenceWad: bigint; estGas: bigint; hasSurplus: boolean; isV4Bundle: boolean;
};
export type Preview = {
  route: Route; grossOut: bigint; protocolFee: bigint; safetyBuffer: bigint; netOut: bigint;
  ironFloor: bigint; userMinOut: bigint; effectiveMinOut: bigint; estGas: bigint; hops: bigint;
  legs: bigint; topology: number; bridgeUsed: Address; canExecute: boolean;
};

export const HARD_IMPACT_BPS = 2_000;
export const CAUTION_IMPACT_BPS = 200;
export const DEFAULT_SLIPPAGE_BPS = 50;
/** An eth_call result bigger than this is not a Quoter answer. */
export const MAX_RESULT_HEX = 400_000;

// ── version resolution ───────────────────────────────────────────────────────

const SELECTOR = /^v?(latest|\d+(\.\d+){0,2})$/i;

export function resolveVersion(chainId: SupportedChainId, selector: string | null | undefined):
  | { ok: true; version: string; contracts: ContractSet }
  | { ok: false; code: string; message: string } {
  const sel = (selector ?? 'latest').trim().replace(/^v/i, '') || 'latest';
  if (!SELECTOR.test(sel)) return { ok: false, code: 'bad_version', message: 'version must be latest, 1, 2 or a full semver like 2.0.0' };
  const cands = deployedVersions(chainId as DeployedChainId).filter((v) => {
    if (sel === 'latest') return true;
    const want = sel.split('.');
    const have = v.version.split('.');
    return want.every((p, i) => p === have[i]);
  });
  const v = cands[0];
  if (!v) {
    const deployed = deployedVersions(chainId as DeployedChainId).map((x) => x.version);
    return { ok: false, code: 'not_deployed', message: `no deployment matching version "${sel}" on chain ${chainId} (deployed: ${deployed.join(', ') || 'none'})` };
  }
  return { ok: true, version: v.version, contracts: { ...(v.chains[chainId as DeployedChainId] as ContractSet) } };
}

/** The registry document integrators (SDK 1.x, local MCP servers) consume. */
export function registryDocument() {
  const versions = [...DEPLOYMENTS.versions].sort((a, b) => compareVersions(b.version, a.version));
  const active: Record<string, { version: string; contracts: ContractSet }> = {};
  for (const id of Object.keys(CHAINS).map(Number) as SupportedChainId[]) {
    const v = deployedVersions(id as DeployedChainId)[0];
    if (v) active[String(id)] = { version: v.version, contracts: { ...(v.chains[id as DeployedChainId] as ContractSet) } };
  }
  return { schema: 1 as const, updatedAt: DEPLOYMENTS.updatedAt, versions, active };
}

// ── Phoenix Check (shared with the first-party quote path) ───────────────────

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function routeIsConsistent(route: Route, tokenIn: string, tokenOut: string): boolean {
  const h = route.hops;
  if (h.length === 0) return false;
  if (!same(h[0].tokenIn, tokenIn) || !same(h[h.length - 1].tokenOut, tokenOut)) return false;
  for (let i = 1; i < h.length; i++) if (!same(h[i].tokenIn, h[i - 1].tokenOut)) return false;
  return h.every((x) => x.legs.length > 0);
}

/** The Phoenix Check of an exact result. The route already passed `exactMismatches` (it connects
 *  tokenIn to tokenOut and matches the request), so the verdict is the price-impact one. The Router's
 *  on-chain floor is not part of previewPlanExact, hence no ironFloor block here. */
export function exactChecks(route: Route, tokenIn: string, tokenOut: string) {
  // Same producer as the preview path. The route already passed `exactMismatches`, so it can execute
  // as far as this read can tell; the Router's floor belongs to the swap itself, not to this read.
  const c = phoenixChecks({ route, canExecute: true, ironFloor: 0n, effectiveMinOut: 0n } as unknown as Preview, tokenIn, tokenOut, 'previewPlanExact');
  return { verdict: c.verdict, basis: 'previewPlanExact', priceImpact: c.priceImpact, routeShape: c.routeShape };
}

export function phoenixChecks(pv: Preview, tokenIn: string, tokenOut: string, basis: string) {
  const impactBps = Math.min(10_000, Math.max(0, Number(pv.route.expectedImpactBps) || 0));
  const consistent = routeIsConsistent(pv.route, tokenIn, tokenOut);
  const impact = impactBps >= HARD_IMPACT_BPS ? 'danger' : impactBps >= CAUTION_IMPACT_BPS ? 'caution' : 'ok';
  const verdict = !pv.canExecute || !consistent ? 'blocked' : impact;
  return {
    // Worst-of rule, fail-closed: never greener than the weakest invariant.
    verdict,
    priceImpact: {
      bps: impactBps,
      verdict: pv.canExecute ? impact : 'blocked',
      hardLineBps: HARD_IMPACT_BPS,
      note: 'Governing price impact from the on-chain route. Above the hard line this is a bad fill.',
    },
    ironFloor: {
      enforcedOnChain: true,
      armed: pv.effectiveMinOut > 0n,
      ironFloor: pv.ironFloor.toString(),
      effectiveMinOut: pv.effectiveMinOut.toString(),
      note: 'The Router re-derives a minimum-output floor at execution and hard-clamps it; a caller can only tighten it, never relax it.',
    },
    routeShape: {
      consistent,
      note: consistent ? 'route connects tokenIn → tokenOut' : 'route does not connect tokenIn → tokenOut — refused',
    },
    crossCheck: {
      basis,
      reproducible: true,
      note: 'This number is computed by the same contract that settles the swap, so quote equals execution. Compare it against any independent price source to detect liquidity on venues this route does not read.',
    },
    disclaimer: 'Deterministic checks derived from on-chain state, not financial advice. "not established" and "blocked" are real answers — we fail closed rather than guess.',
  };
}

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

// ── prepare ──────────────────────────────────────────────────────────────────

export type QuoterFn =
  | 'previewPlan' | 'previewPlanWithMinOut' | 'previewPlanExact'
  | 'previewAndEncode' | 'previewAndEncodeWithMinOut';

/** Everything decode needs, echoed back verbatim by the caller. No addresses
 *  of contracts: those are re-resolved from the registry on decode. */
export interface PreparedRequest {
  chainId: number;
  version: string;
  fn: QuoterFn;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  nativeIn: boolean;
  nativeOut: boolean;
  userMinOut?: string;
  recipient?: Address;
  slippageBps?: number;
  /** Absolute unix seconds (baked into the calldata on 2.x). */
  deadline?: string;
}

export interface PrepareInput {
  chainId: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  nativeIn: boolean;
  nativeOut: boolean;
  exact: boolean;
  recipient?: Address;
  slippageBps?: number;
  deadlineSec: number;
  userMinOut?: bigint;
  version?: string | null;
}

export function prepareQuote(p: PrepareInput, nowSec: number):
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string } {
  const dep = resolveVersion(p.chainId, p.version);
  if (!dep.ok) return { ok: false, status: 400, code: dep.code, message: dep.message };
  const v2 = isV2(dep.version);
  const userMinOut = p.userMinOut ?? 0n;
  const deadline = p.recipient ? BigInt(nowSec + p.deadlineSec) : undefined;

  let fn: QuoterFn;
  let data: Hex;
  if (p.exact) {
    fn = 'previewPlanExact';
    data = encodeFunctionData({ abi: QUOTER_ABI, functionName: fn, args: [p.tokenIn, p.tokenOut, p.amountIn] });
  } else if (p.recipient && v2 && !p.nativeIn) {
    // 2.x: ONE eth_call returns the preview AND the Router calldata executing it.
    if (userMinOut > 0n) {
      fn = 'previewAndEncodeWithMinOut';
      data = encodeFunctionData({ abi: QUOTER_ABI, functionName: fn, args: [p.tokenIn, p.tokenOut, p.amountIn, userMinOut, p.recipient, deadline!] });
    } else {
      fn = 'previewAndEncode';
      data = encodeFunctionData({ abi: QUOTER_ABI, functionName: fn, args: [p.tokenIn, p.tokenOut, p.amountIn, p.recipient, deadline!] });
    }
  } else if (userMinOut > 0n) {
    fn = 'previewPlanWithMinOut';
    data = encodeFunctionData({ abi: QUOTER_ABI, functionName: fn, args: [p.tokenIn, p.tokenOut, p.amountIn, userMinOut] });
  } else {
    fn = 'previewPlan';
    data = encodeFunctionData({ abi: QUOTER_ABI, functionName: fn, args: [p.tokenIn, p.tokenOut, p.amountIn] });
  }
  const request: PreparedRequest = {
    chainId: p.chainId, version: dep.version, fn,
    tokenIn: p.tokenIn, tokenOut: p.tokenOut, amountIn: p.amountIn.toString(),
    nativeIn: p.nativeIn, nativeOut: p.nativeOut,
    ...(userMinOut > 0n ? { userMinOut: userMinOut.toString() } : {}),
    ...(p.recipient ? { recipient: p.recipient, slippageBps: p.slippageBps ?? DEFAULT_SLIPPAGE_BPS, deadline: deadline!.toString() } : {}),
  };
  const call = { to: dep.contracts.quoter, data };
  const rpcRequest = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [call, 'latest'] };
  return {
    ok: true,
    body: {
      ok: true,
      mode: 'prepare',
      chainId: p.chainId,
      protocolVersion: dep.version,
      contracts: { quoter: dep.contracts.quoter, router: dep.contracts.router },
      call: { ...call, function: fn, signature: sigOf(fn) },
      rpcRequest,
      curl: `curl -s "$RPC_URL" -H 'content-type: application/json' -d '${JSON.stringify(rpcRequest)}'`,
      request,
      decode: {
        method: 'POST',
        path: '/api/quote/decode',
        body: { request: '<the `request` object above, verbatim>', result: '<the eth_call result hex from YOUR node>' },
        note: 'Pure: no RPC on our side. The SDK (@blazephoenix/sdk 1.x) and the local MCP server decode in-process instead.',
      },
      note: 'Run this eth_call on YOUR OWN node — BlazePhoenix performs no RPC for integrators. '
        + (fn.startsWith('previewAndEncode')
          ? 'On 2.x the Quoter returns the preview AND the exact Router calldata; decode verifies it before handing it to you.'
          : 'The result is the Quoter preview; decode turns it into the quote, the Phoenix Check and (with recipient) the swap calldata.'),
    },
  };
}

function sigOf(fn: QuoterFn): string {
  const it = getAbiItem({ abi: QUOTER_ABI, name: fn }) as { inputs: readonly { type: string; name?: string }[] };
  return `${fn}(${it.inputs.map((i) => `${i.type}${i.name ? ` ${i.name}` : ''}`).join(', ')})`;
}

// ── decode ───────────────────────────────────────────────────────────────────

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const INT = /^\d{1,78}$/;
export const UINT256_MAX = (1n << 256n) - 1n;
/** The ONE integer-string rule of the API: decimal digits, no sign, and <= 2^256-1 (78 digits alone
 *  admit values above it). Every entry point (REST, decode, the OpenAPI pattern's limit) shares it. */
export const isUint256Str = (s: string): boolean => INT.test(s) && BigInt(s) <= UINT256_MAX;
const FNS: readonly QuoterFn[] = ['previewPlan', 'previewPlanWithMinOut', 'previewPlanExact', 'previewAndEncode', 'previewAndEncodeWithMinOut'];

type Fail = { ok: false; status: number; code: string; message: string };
const bad = (code: string, message: string): Fail => ({ ok: false, status: 400, code, message });

/** Strict validation of the echoed request (never trusts contract addresses). */
export function parsePreparedRequest(raw: unknown): { ok: true; req: PreparedRequest; contracts: ContractSet } | Fail {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('bad_request', 'request must be the object /api/quote/prepare returned');
  const r = raw as Record<string, unknown>;
  const chainId = Number(r.chainId);
  if (!(chainId in CHAINS)) return bad('bad_chain', 'request.chainId is not a BlazePhoenix chain');
  if (typeof r.version !== 'string') return bad('bad_version', 'request.version missing');
  const dep = resolveVersion(chainId as SupportedChainId, r.version);
  if (!dep.ok || dep.version !== r.version) return bad('bad_version', `request.version ${String(r.version)} is not deployed on chain ${chainId}`);
  if (typeof r.fn !== 'string' || !FNS.includes(r.fn as QuoterFn)) return bad('bad_request', 'request.fn is not a Quoter preview function');
  if (typeof r.tokenIn !== 'string' || !HEX_ADDR.test(r.tokenIn)) return bad('bad_token_in', 'request.tokenIn must be an address');
  if (typeof r.tokenOut !== 'string' || !HEX_ADDR.test(r.tokenOut)) return bad('bad_token_out', 'request.tokenOut must be an address');
  if (typeof r.amountIn !== 'string' || !isUint256Str(r.amountIn) || BigInt(r.amountIn) === 0n) return bad('bad_amount', 'request.amountIn must be a positive integer string');
  if (r.userMinOut !== undefined && (typeof r.userMinOut !== 'string' || !isUint256Str(r.userMinOut))) return bad('bad_request', 'request.userMinOut must be an integer string');
  if (r.recipient !== undefined && (typeof r.recipient !== 'string' || !HEX_ADDR.test(r.recipient))) return bad('bad_recipient', 'request.recipient must be an address');
  if (r.deadline !== undefined && (typeof r.deadline !== 'string' || !isUint256Str(r.deadline))) return bad('bad_deadline', 'request.deadline must be unix seconds');
  if (r.slippageBps !== undefined && (!Number.isInteger(r.slippageBps) || (r.slippageBps as number) < 0 || (r.slippageBps as number) > 5_000)) {
    return bad('bad_slippage', 'request.slippageBps must be an integer between 0 and 5000');
  }
  if (r.recipient !== undefined && r.deadline === undefined) return bad('bad_deadline', 'request.deadline missing');
  const fn = r.fn as QuoterFn;
  if (fn.startsWith('previewAndEncode') && (!isV2(dep.version) || r.recipient === undefined)) {
    return bad('bad_request', `${fn} needs a 2.x deployment and a recipient`);
  }
  return {
    ok: true,
    contracts: dep.contracts,
    req: {
      chainId, version: dep.version, fn,
      tokenIn: getAddress(r.tokenIn), tokenOut: getAddress(r.tokenOut), amountIn: r.amountIn,
      nativeIn: r.nativeIn === true, nativeOut: r.nativeOut === true,
      ...(r.userMinOut !== undefined ? { userMinOut: r.userMinOut as string } : {}),
      ...(r.recipient !== undefined ? { recipient: getAddress(r.recipient as string) } : {}),
      ...(r.slippageBps !== undefined ? { slippageBps: r.slippageBps as number } : {}),
      ...(r.deadline !== undefined ? { deadline: r.deadline as string } : {}),
    },
  };
}

const minOutFor = (netOut: bigint, slippageBps: number, floor: bigint): bigint => {
  const bySlip = netOut - (netOut * BigInt(slippageBps)) / 10_000n;
  return bySlip > floor ? bySlip : floor;
};
const fp = (r: Route) => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? `${v}n` : typeof v === 'string' ? v.toLowerCase() : v));

/** The fields a Quoter preview must satisfy by construction (`_pack`), and the ones that tie it
 *  to the request it answers. A result that breaks one was not produced by the Quoter for this
 *  request, so nothing — no verdict, no calldata — is built on it. */
export function previewMismatches(pv: Preview, req: PreparedRequest): string[] {
  const out: string[] = [];
  const asked = req.userMinOut ? BigInt(req.userMinOut) : 0n;
  if (pv.userMinOut !== asked) out.push('userMinOut is not the requested one');
  if (pv.ironFloor !== pv.route.singleOutFloor) out.push('ironFloor is not the route floor');
  if (pv.effectiveMinOut !== (pv.userMinOut > pv.ironFloor ? pv.userMinOut : pv.ironFloor)) out.push('effectiveMinOut is not max(userMinOut, ironFloor)');
  if (pv.netOut > pv.grossOut) out.push('netOut above grossOut');
  if (pv.canExecute && pv.netOut < pv.effectiveMinOut) out.push('executable below its own minimum');
  if (overspends(pv.route, BigInt(req.amountIn))) out.push('route spends more than the requested amountIn');
  return out;
}

/** Hop 0 may commit less than the request (a partial fill, refunded by the Router), never more. */
function overspends(route: Route, amountIn: bigint): boolean {
  const h0 = route.hops[0];
  if (!h0) return false;
  const committed = h0.legs.reduce((s, l) => s + l.amountIn, 0n);
  return h0.amountIn > amountIn || committed > amountIn;
}

/** The protocol fee on a gross output, rounded up: the Router's deduction, and the one the 2.x
 *  Quoter applies in previewPlanExact (`gross - mulDivUp(gross, PROTOCOL_FEE_BPS, BPS)`). */
export const protocolFeeOn = (gross: bigint): bigint =>
  (gross * BigInt(SITE.protocol.feeBps) + 9_999n) / 10_000n;

/** What previewPlanExact measures, and what it does not. */
export const EXACT_SCOPE = {
  tested: 'every leg of the route dry-run on its own pool in the current block: the output the pools would pay',
  notTested: 'the token transfer itself: no tokens move from a holder, so a token that blocks, taxes or redirects its own '
    + 'transfer still quotes here. To test that, simulate the swap transaction from the holder on your node.',
} as const;

/** 2.x takes the protocol fee where its Router takes it: on the output of a single hop, on the
 *  INPUT of the anchor hop of a multi-hop route (every hop when none is a bridge). On a 2.x
 *  multi-hop route every figure in the route is therefore already net, and exactOut is the total. */
const feeOnHopInput = (req: PreparedRequest, route: Route): boolean => isV2(req.version) && route.hops.length > 1;

/** previewPlanExact by construction: the route connects the request and spends at most its
 *  amountIn on hop 0; each hop's output is the sum of its legs and is the next hop's input (on a
 *  2.x multi-hop route, a charged hop's input is that output less the fee); the last hop's output
 *  is route.totalOut == route.singleOut. The scalar: gross on 1.x (measured on the deployed
 *  Quoters); on 2.x net — the total less the fee rounded up on one hop, the total itself on more. */
export function exactMismatches(route: Route, exactOut: bigint, req: PreparedRequest): string[] {
  const out: string[] = [];
  const h = route.hops;
  const onInput = feeOnHopInput(req, route);
  if (!routeIsConsistent(route, req.tokenIn, req.tokenOut)) out.push('route does not connect tokenIn → tokenOut');
  if (overspends(route, BigInt(req.amountIn))) out.push('route spends more than the requested amountIn');
  h.forEach((hop, i) => {
    if (hop.legs.reduce((s, l) => s + l.expectedOut, 0n) !== hop.expectedOut) out.push(`hop ${i} output is not the sum of its legs`);
    if (i === 0) return;
    const prev = h[i - 1].expectedOut;
    if (hop.amountIn !== prev && !(onInput && hop.amountIn === prev - protocolFeeOn(prev))) {
      out.push(`hop ${i} input is not hop ${i - 1} output${onInput ? ' (nor that output net of the fee)' : ''}`);
    }
  });
  if (h.length > 0 && h[h.length - 1].expectedOut !== route.totalOut) out.push('totalOut is not the last hop output');
  if (route.singleOut !== route.totalOut) out.push('singleOut is not totalOut');
  const v2 = isV2(req.version);
  const want = onInput ? route.totalOut : v2 ? route.totalOut - protocolFeeOn(route.totalOut) : route.totalOut;
  // 2.x: exactOut is a FLOOR within one fee of the bound. The Quoter's funding pass re-prices the route
  // on the venues as the Router funds it (the fee comes off the input where the Router takes it there,
  // and a venue's output is a step function of its input), so the scalar can sit a few wei under
  // `want`, never above it, and never a whole extra fee under it (that would be a second deduction).
  // 1.x returns the dry-run total itself: equality.
  const wrong = v2 ? exactOut > want || exactOut <= want - protocolFeeOn(want) : exactOut !== want;
  if (wrong) {
    out.push(onInput ? 'exactOut is not the route total (2.x multi-hop: the fee is already out)'
      : v2 ? 'exactOut is not totalOut net of the protocol fee' : 'exactOut is not the route total');
  }
  return out;
}

export function decodeQuote(rawReq: unknown, rawResult: unknown, nowSec = Math.floor(Date.now() / 1000)):
  | { ok: true; body: Record<string, unknown> }
  | Fail {
  const parsed = parsePreparedRequest(rawReq);
  if (!parsed.ok) return parsed;
  const { req, contracts } = parsed;
  if (typeof rawResult !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(rawResult) || rawResult.length > MAX_RESULT_HEX) {
    return bad('bad_result', 'result must be the 0x hex your node returned for the prepared eth_call');
  }
  const result = rawResult as Hex;
  if (result === '0x') return { ok: false, status: 422, code: 'no_route', message: 'empty eth_call result — the Quoter reverted on your node (no route)' };

  const amountIn = BigInt(req.amountIn);
  const meta = { decodedBy: 'blazephoenix.xyz (pure, no RPC)', rpc: 'yours', version: req.version };
  try {
    if (req.fn === 'previewPlanExact') {
      const [route, exactOut] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: 'previewPlanExact', data: result }) as unknown as [Route, bigint];
      if (route.hops.length === 0 && exactOut === 0n) {
        return { ok: false, status: 422, code: 'no_route', message: 'the Quoter found no route on your node (empty route)' };
      }
      const mismatch = exactMismatches(route, exactOut, req);
      if (mismatch.length) {
        return { ok: false, status: 422, code: 'result_mismatch', message: `result is not the Quoter's answer to this request: ${mismatch.join(', ')}` };
      }
      // amountOut is net of the protocol fee on every path (the documented contract).
      // On a 2.x multi-hop route the fee was taken from an input, in another token: there is
      // no gross output to report, so the fee fields say where it was taken instead.
      const fees = feeOnHopInput(req, route)
        ? { amountOut: exactOut.toString(), quote: { netOut: exactOut.toString(), feeBps: SITE.protocol.feeBps, feeTakenOn: 'anchor-hop input' } }
        : (() => {
            const gross = route.totalOut;
            const fee = protocolFeeOn(gross);
            return {
              amountOut: (gross - fee).toString(),
              grossAmountOut: gross.toString(),
              quote: { grossOut: gross.toString(), protocolFee: fee.toString(), netOut: (gross - fee).toString(), feeBps: SITE.protocol.feeBps, feeTakenOn: 'output' },
            };
          })();
      return {
        ok: true,
        body: {
          ok: true, mode: 'exact', chainId: req.chainId, protocolVersion: req.version,
          tokenIn: req.tokenIn, tokenOut: req.tokenOut, amountIn: req.amountIn,
          ...fees,
          route: jsonSafe(route), exact: EXACT_SCOPE, checks: exactChecks(route, req.tokenIn, req.tokenOut), wrapRequired: req.nativeIn && !isV2(req.version), meta,
        },
      };
    }

    let pv: Preview;
    let quoterCall: Hex | undefined;
    if (req.fn === 'previewAndEncode' || req.fn === 'previewAndEncodeWithMinOut') {
      [pv, quoterCall] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: req.fn, data: result }) as unknown as [Preview, Hex];
    } else {
      [pv] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: req.fn, data: result }) as unknown as [Preview];
    }
    const mismatch = previewMismatches(pv, req);
    if (mismatch.length) {
      return { ok: false, status: 422, code: 'result_mismatch', message: `result is not the Quoter's answer to this request: ${mismatch.join(', ')}` };
    }
    const checks = phoenixChecks(pv, req.tokenIn, req.tokenOut, 'Quoter preview via eth_call on YOUR node, decoded by the site');

    let tx: { to: Address; data: Hex; value: string } | undefined;
    let entry: string | undefined;
    let encodedBy: 'quoter' | 'site' | undefined;
    let minOut: bigint | undefined;
    let txError: { code: string; message: string } | undefined;
    if (req.recipient && req.deadline) {
      const deadline = BigInt(req.deadline);
      const userMinOut = req.userMinOut ? BigInt(req.userMinOut) : 0n;
      minOut = minOutFor(pv.netOut, req.slippageBps ?? DEFAULT_SLIPPAGE_BPS, pv.effectiveMinOut);
      if (userMinOut > minOut) minOut = userMinOut;
      if (deadline <= BigInt(nowSec)) {
        txError = { code: 'deadline_passed', message: 'request.deadline is not in the future — prepare again; no transaction is emitted' };
      } else if (userMinOut === 0n) {
        // The result is caller-supplied and this decode is pure: it cannot tell your node's
        // answer from a forged but self-consistent one, so a minimum derived only from the
        // result protects nothing (Dex bounty L87; root reported 2026-10-06). Calldata is
        // emitted only under a floor the caller pinned from its own source.
        minOut = undefined;
        txError = { code: 'min_required', message: 'decode cannot authenticate the result (no RPC): prepare again with userMinOut set from a source you trust — e.g. this quote checked against an independent price — to get a transaction' };
      } else if (!pv.canExecute || !checks.routeShape.consistent) {
        txError = { code: 'not_executable', message: 'the Quoter says this route cannot execute now — no transaction is emitted' };
      } else if (quoterCall !== undefined) {
        if (quoterCall === '0x') {
          txError = { code: 'not_executable', message: 'the Quoter returned no calldata (route cannot execute)' };
        } else {
          // Verify the Quoter's bytes against the request — field by field.
          const d = decodeFunctionData({ abi: ROUTER_ABI, data: quoterCall });
          const bad: string[] = [];
          if (d.functionName !== 'swapExactIn') bad.push(`function ${d.functionName}`);
          const [route, aIn, uMin, rcpt, dl] = d.args as unknown as [Route, bigint, bigint, Address, bigint];
          if (aIn !== amountIn) bad.push('amountIn');
          if (!same(rcpt, req.recipient)) bad.push('recipient');
          if (dl !== deadline) bad.push('deadline');
          if (uMin < pv.effectiveMinOut || uMin === 0n) bad.push('minimum below the on-chain floor');
          if (fp(route) !== fp(pv.route)) bad.push('route differs from the preview');
          if (bad.length) {
            txError = { code: 'calldata_mismatch', message: `Quoter calldata refused: ${bad.join(', ')}` };
          } else {
            const finalMin = minOut > uMin ? minOut : uMin;
            tx = {
              to: contracts.router,
              data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'swapExactIn', args: [route as never, aIn, finalMin, rcpt, dl] }),
              value: '0',
            };
            minOut = finalMin;
            entry = 'swapExactIn';
            encodedBy = 'quoter';
          }
        }
      } else if (req.nativeIn) {
        if (isV2(req.version)) {
          tx = {
            to: contracts.router,
            data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'swapExactInNative', args: [pv.route as never, minOut, req.recipient, deadline] }),
            value: req.amountIn,
          };
          entry = 'swapExactInNative';
          encodedBy = 'site';
        } else {
          txError = { code: 'wrap_required', message: 'native ETH input on a 1.x Router: wrap to WETH (WETH.deposit) and quote WETH' };
        }
      } else {
        tx = {
          to: contracts.router,
          data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'swapExactIn', args: [pv.route as never, amountIn, minOut, req.recipient, deadline] }),
          value: '0',
        };
        entry = 'swapExactIn';
        encodedBy = 'site';
      }
    }

    const impactBps = checks.priceImpact.bps;
    return {
      ok: true,
      body: {
        ok: true,
        mode: 'preview',
        chainId: req.chainId,
        protocolVersion: req.version,
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        amountOut: pv.netOut.toString(),
        grossAmountOut: pv.grossOut.toString(),
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
        ...(tx ? { tx, minOut: minOut!.toString(), deadline: req.deadline, entry, encodedBy } : {}),
        ...(txError ? { txError } : {}),
        ...(tx && !req.nativeIn ? {
          approval: {
            token: req.tokenIn, spender: contracts.router, amount: req.amountIn,
            note: 'approve the Router for tokenIn once (exact amount recommended) before sending tx',
          },
        } : {}),
        wrapRequired: req.nativeIn && !isV2(req.version),
        unwrapAfter: req.nativeOut,
        executeWith: { router: contracts.router, chainId: req.chainId },
        meta,
      },
    };
  } catch {
    return { ok: false, status: 422, code: 'decode_failed', message: `result is not a ${req.fn} answer (wrong node, wrong chain, or a revert)` };
  }
}

/** For the rpc_required answer on the legacy endpoints. */
export const RPC_REQUIRED_MESSAGE =
  'BlazePhoenix quotes now run on YOUR RPC: the site performs no RPC for integrators. '
  + 'Run the prepared eth_call below on your own node and POST the result to /api/quote/decode — '
  + 'or use @blazephoenix/sdk 1.x / the local MCP server (@blazephoenix/mcp), which do all of it in-process.';
