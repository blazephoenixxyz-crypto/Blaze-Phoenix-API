// =============================================================================
//  USD VALUE — what a token amount is worth in the chain's dollar token,
//  measured by the Quoter on YOUR node. No oracle, no third-party price API.
//
//    prepare → one Multicall3.aggregate3 eth_call (block number, decimals and
//              one Quoter previewPlan per leg of every via; the block number is
//              ArbSys.arbBlockNumber on Arbitrum and Robinhood Chain, whose
//              block.number is the L1 block)
//    decode  → either the value, or a second aggregate3 pinned at the block of
//              the first one when the direct route discovers more vias
//
//  The dollar token D is CHAINS[chain].usdc (USDC; USDG on Robinhood Chain) and
//  is treated as 1 USD: the value is "USD (via USDC)", not a dollar price.
//  Each via is a measured netOut (after the 0.28% fee, including price impact):
//    direct  T -> D for A                          value = out
//    via X   T -> X for A, then X -> D for refX    value = floor(outX * outD / refX)
//  The X -> D leg is priced at refX and scaled linearly, so its impact is the
//  impact at refX, not at outX. The value is the MINIMUM over measured vias.
//  A via that reverts, finds no route or nets 0 is "not measured"; when no via
//  is measured the value is "not measured", never 0. Pure: no fetch, no state.
// =============================================================================

import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, formatUnits, getAddress, parseAbi, toHex, type Hex } from 'viem';
import { BLAZE_ERRORS_ABI, QUOTER_ABI } from '../src/abis/blaze';
import { CHAINS, type SupportedChainId } from '../src/config/chains';
import { MAX_RESULT_HEX, resolveVersion, routeIsConsistent, type Address, type Preview, type Route } from './codec';

/** Multicall3, same address on every BlazePhoenix chain (eth_getCode checked on all five, 2026-11-20). */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
/** Vias per value, the direct one included. */
export const MAX_VIAS = 8;
export const UINT128_MAX = (1n << 128n) - 1n;
const WAD = 10n ** 18n;

const MC3_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getBlockNumber() view returns (uint256 blockNumber)',
]);
const ERC20_ABI = parseAbi(['function decimals() view returns (uint8)']);
/** ArbSys precompile: on Arbitrum and Arbitrum Orbit chains `block.number` (and so
 *  Multicall3.getBlockNumber) is the L1 block; arbBlockNumber() is the L2 block that RPC
 *  block tags count, so the reported block and the pinned block are the same number. */
export const ARBSYS: Address = '0x0000000000000000000000000000000000000064';
const ARBSYS_ABI = parseAbi(['function arbBlockNumber() view returns (uint256)']);
/** Chains whose block number is read from ArbSys: Arbitrum One and Robinhood Chain (Orbit). */
export const ARBSYS_BLOCK_CHAINS: readonly number[] = [42161, 4663];
const arbBlock = (chainId: number) => ARBSYS_BLOCK_CHAINS.includes(chainId);

export const USD_BASIS = 'Each via is the netOut the Quoter reports for A in one block: after the 0.28% fee, including price impact; '
  + 'an X -> dollar leg is priced at refX and scaled linearly. The value is the minimum over measured vias; the dollar token counts as 1 USD.';

type Via = { path: Address[]; ref?: bigint };
type LegSpec = { tokenIn: Address; tokenOut: Address; amountIn: bigint };
type Fail = { ok: false; status: number; code: string; message: string };
const bad = (code: string, message: string, status = 400): Fail => ({ ok: false, status, code, message });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const INT = /^\d{1,78}$/;

export const dollarLabel = (chainId: number) => (chainId === 4663 ? 'USD (via USDG)' : 'USD (via USDC)');

/** The vias every value starts with: direct, then via WETH (unless T is WETH). T == D has none (identity). */
function defaultVias(chainId: SupportedChainId, token: Address): Via[] {
  const { usdc: d, weth } = CHAINS[chainId];
  if (same(token, d)) return [];
  const direct: Via = { path: [token, d] };
  return same(token, weth) ? [direct] : [direct, { path: [token, weth, d], ref: WAD }];
}

function legsOf(v: Via, amountIn: bigint): LegSpec[] {
  if (v.path.length === 2) return [{ tokenIn: v.path[0], tokenOut: v.path[1], amountIn }];
  return [
    { tokenIn: v.path[0], tokenOut: v.path[1], amountIn },
    { tokenIn: v.path[1], tokenOut: v.path[2], amountIn: v.ref! },
  ];
}

function aggregateCall(chainId: SupportedChainId, quoter: Address, token: Address, amountIn: bigint, vias: Via[]): Hex {
  const d = CHAINS[chainId].usdc;
  const decimals = (target: Address) => ({ target, allowFailure: true, callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'decimals' }) });
  const calls = [
    // The block the RPC tags count: block.number is the L1 block on Arbitrum chains.
    arbBlock(chainId)
      ? { target: ARBSYS, allowFailure: true, callData: encodeFunctionData({ abi: ARBSYS_ABI, functionName: 'arbBlockNumber' }) }
      : { target: MULTICALL3, allowFailure: true, callData: encodeFunctionData({ abi: MC3_ABI, functionName: 'getBlockNumber' }) },
    // T == D (identity): block + decimals(D) only, no Quoter call; the amount is already in the dollar token.
    ...(same(token, d) ? [decimals(d)] : [decimals(token), decimals(d)]),
    ...vias.flatMap((v) => legsOf(v, amountIn)).map((l) => ({
      target: quoter, allowFailure: true,
      callData: encodeFunctionData({ abi: QUOTER_ABI, functionName: 'previewPlan', args: [l.tokenIn, l.tokenOut, l.amountIn] }),
    })),
  ];
  return encodeFunctionData({ abi: MC3_ABI, functionName: 'aggregate3', args: [calls] });
}

const viaJson = (v: Via) => ({ path: v.path, ...(v.ref !== undefined ? { ref: v.ref.toString() } : {}) });

function preparedBody(chainId: SupportedChainId, version: string, quoter: Address, token: Address, amountIn: bigint,
  vias: Via[], stage: 1 | 2, blockNumber?: bigint) {
  const call = { to: MULTICALL3, data: aggregateCall(chainId, quoter, token, amountIn, vias) };
  const rpcRequest = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [call, blockNumber !== undefined ? toHex(blockNumber) : 'latest'] };
  return {
    ok: true,
    mode: 'usd-prepare',
    stage,
    label: dollarLabel(chainId),
    call: { ...call, function: 'aggregate3', signature: 'aggregate3((address target, bool allowFailure, bytes callData)[] calls)' },
    rpcRequest,
    request: {
      kind: 'usd', stage, chainId, version, token, amountIn: amountIn.toString(), vias: vias.map(viaJson),
      ...(blockNumber !== undefined ? { blockNumber: blockNumber.toString() } : {}),
    },
    decode: { method: 'POST', path: '/api/quote/decode', body: { usd: { request: '<the `request` object above, verbatim>', result: '<the eth_call result hex from YOUR node>' } } },
    note: stage === 1
      ? 'Run this eth_call on YOUR node and decode it. If the direct route crosses other tokens, decode returns a second call pinned at the same block.'
      : 'Second and last call: every via, pinned at the block of the first call, so all of them come from one block.',
  };
}

/** Prepare the first eth_call of a USD value. Pure. */
export function prepareUsd(chainId: SupportedChainId, version: string | null | undefined, token: Address, amountIn: bigint):
  { ok: true; body: Record<string, unknown> } | Fail {
  const dep = resolveVersion(chainId, version);
  if (!dep.ok) return bad(dep.code, dep.message);
  if (amountIn <= 0n || amountIn > UINT128_MAX) return bad('bad_amount', 'amountIn must be between 1 and 2^128-1 for a USD value');
  const t = getAddress(token);
  return { ok: true, body: preparedBody(chainId, dep.version, dep.contracts.quoter, t, amountIn, defaultVias(chainId, t), 1) };
}

type ParsedUsd = { chainId: SupportedChainId; version: string; quoter: Address; token: Address; amountIn: bigint; stage: 1 | 2; vias: Via[]; blockNumber?: bigint };

function parseUsdRequest(raw: unknown): { ok: true; r: ParsedUsd } | Fail {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('bad_request', 'usd.request must be the object the USD prepare returned');
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'usd') return bad('bad_request', 'usd.request.kind must be "usd"');
  const chainId = Number(r.chainId);
  if (!(chainId in CHAINS)) return bad('bad_chain', 'usd.request.chainId is not a BlazePhoenix chain');
  const cid = chainId as SupportedChainId;
  if (typeof r.version !== 'string') return bad('bad_version', 'usd.request.version missing');
  const dep = resolveVersion(cid, r.version);
  if (!dep.ok || dep.version !== r.version) return bad('bad_version', `usd.request.version ${String(r.version)} is not deployed on chain ${chainId}`);
  if (typeof r.token !== 'string' || !HEX_ADDR.test(r.token)) return bad('bad_token_in', 'usd.request.token must be an address');
  if (typeof r.amountIn !== 'string' || !INT.test(r.amountIn)) return bad('bad_amount', 'usd.request.amountIn must be an integer string');
  const amountIn = BigInt(r.amountIn);
  if (amountIn <= 0n || amountIn > UINT128_MAX) return bad('bad_amount', 'usd.request.amountIn must be between 1 and 2^128-1');
  if (r.stage !== 1 && r.stage !== 2) return bad('bad_request', 'usd.request.stage must be 1 or 2');
  const token = getAddress(r.token);
  const base = defaultVias(cid, token);
  if (r.stage === 1) return { ok: true, r: { chainId: cid, version: dep.version, quoter: dep.contracts.quoter, token, amountIn, stage: 1, vias: base } };

  // Stage 2: the default vias (re-derived, never read from the caller), then the discovered ones, checked.
  if (typeof r.blockNumber !== 'string' || !INT.test(r.blockNumber)) return bad('bad_request', 'usd.request.blockNumber missing');
  if (!Array.isArray(r.vias) || r.vias.length > MAX_VIAS || r.vias.length <= base.length) return bad('bad_request', `usd.request.vias: ${base.length + 1}-${MAX_VIAS} entries`);
  const { usdc: d, weth } = CHAINS[cid];
  const seen = new Set([token, d, weth].map((a) => a.toLowerCase()));
  const vias: Via[] = [...base];
  for (const v of r.vias.slice(base.length) as unknown[]) {
    const p = (v as { path?: unknown })?.path;
    const ref = (v as { ref?: unknown })?.ref;
    if (!Array.isArray(p) || p.length !== 3 || !p.every((a) => typeof a === 'string' && HEX_ADDR.test(a))) return bad('bad_request', 'usd.request.vias: each discovered via is [token, X, dollar]');
    if (!same(p[0], token) || !same(p[2], d) || seen.has((p[1] as string).toLowerCase())) return bad('bad_request', 'usd.request.vias: a discovered via must start at the token, end at the dollar token and add a new X');
    if (typeof ref !== 'string' || !INT.test(ref) || BigInt(ref) === 0n || BigInt(ref) > UINT128_MAX) return bad('bad_request', 'usd.request.vias: ref must be an integer in 1..2^128-1');
    seen.add((p[1] as string).toLowerCase());
    vias.push({ path: [token, getAddress(p[1] as string), d], ref: BigInt(ref) });
  }
  return { ok: true, r: { chainId: cid, version: dep.version, quoter: dep.contracts.quoter, token, amountIn, stage: 2, vias, blockNumber: BigInt(r.blockNumber) } };
}

type Res = { success: boolean; returnData: Hex };
type Leg = { out: bigint; route: Route } | { reason: string };

function revertReason(data: Hex): string {
  if (data === '0x') return 'call reverted (no reason)';
  try {
    const e = decodeErrorResult({ abi: BLAZE_ERRORS_ABI, data });
    return `call reverted: ${e.errorName}(${(e.args as readonly unknown[] | undefined)?.join(', ') ?? ''})`;
  } catch {
    return `call reverted (${data.slice(0, 10)})`;
  }
}

function measureLeg(res: Res, spec: LegSpec): Leg {
  if (!res.success) return { reason: revertReason(res.returnData) };
  let pv: Preview;
  try {
    [pv] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: 'previewPlan', data: res.returnData }) as unknown as [Preview];
  } catch {
    return { reason: 'undecodable Quoter result' };
  }
  if (pv.route.hops.length === 0) return { reason: 'empty route' };
  if (!routeIsConsistent(pv.route, spec.tokenIn, spec.tokenOut)) return { reason: 'route does not connect the leg tokens' };
  if (pv.netOut === 0n) return { reason: 'netOut is 0' };
  return { out: pv.netOut, route: pv.route };
}

function decimalsOf(res: Res | undefined): number | null {
  if (!res?.success) return null;
  try {
    const d = Number(decodeFunctionResult({ abi: ERC20_ABI, functionName: 'decimals', data: res.returnData }));
    return Number.isInteger(d) && d >= 0 && d <= 77 ? d : null;
  } catch {
    return null;
  }
}

/** The tokens the direct route crosses, in route order, minus T, D, WETH and repeats, each with the amount
 *  of it the route moves (the hop that spends it): that amount is the reference size of its X -> D leg. */
function discoveredVias(route: Route, token: Address, chainId: SupportedChainId, room: number): Via[] {
  const { usdc: d, weth } = CHAINS[chainId];
  const seen = new Set([token, d, weth].map((a) => a.toLowerCase()));
  const out: Via[] = [];
  for (const hop of route.hops) {
    for (const x of [hop.tokenIn, hop.tokenOut]) {
      if (out.length >= room || seen.has(x.toLowerCase())) continue;
      seen.add(x.toLowerCase());
      const spend = route.hops.find((h) => same(h.tokenIn, x));
      if (!spend || spend.amountIn === 0n || spend.amountIn > UINT128_MAX) continue;
      out.push({ path: [token, getAddress(x), d], ref: spend.amountIn });
    }
  }
  return out;
}

/** Decode one USD eth_call result: the value, or (stage 1 only) the second call to run. Pure. */
export function decodeUsd(rawReq: unknown, rawResult: unknown): { ok: true; body: Record<string, unknown> } | Fail {
  const parsed = parseUsdRequest(rawReq);
  if (!parsed.ok) return parsed;
  const q = parsed.r;
  if (typeof rawResult !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(rawResult) || rawResult.length > MAX_RESULT_HEX) {
    return bad('bad_result', 'usd.result must be the 0x hex your node returned for the prepared eth_call');
  }
  const legs = q.vias.flatMap((v) => legsOf(v, q.amountIn));
  let results: readonly Res[];
  try {
    results = decodeFunctionResult({ abi: MC3_ABI, functionName: 'aggregate3', data: rawResult as Hex }) as readonly Res[];
  } catch {
    return bad('bad_result', 'usd.result is not an aggregate3 answer', 422);
  }
  const identity = same(q.token, CHAINS[q.chainId].usdc);
  const head = identity ? 2 : 3;
  if (results.length !== head + legs.length) return bad('result_mismatch', `usd.result has ${results.length} entries, this request makes ${head + legs.length}`, 422);
  const arb = arbBlock(q.chainId);
  const what = arb ? 'ArbSys.arbBlockNumber' : 'Multicall3.getBlockNumber';
  if (!results[0].success) return bad('result_mismatch', `usd.result: the block number read (${what}) failed`, 422);
  let block: bigint;
  try {
    block = (arb
      ? decodeFunctionResult({ abi: ARBSYS_ABI, functionName: 'arbBlockNumber', data: results[0].returnData })
      : decodeFunctionResult({ abi: MC3_ABI, functionName: 'getBlockNumber', data: results[0].returnData })) as bigint;
  } catch {
    return bad('result_mismatch', `usd.result: ${what} answered no block number`, 422);
  }
  if (q.blockNumber !== undefined && block !== q.blockNumber) {
    return bad('result_mismatch', `usd.result is from block ${block}, the call is pinned at ${q.blockNumber}`, 422);
  }
  const dD = decimalsOf(results[head - 1]);
  const dT = identity ? dD : decimalsOf(results[1]);
  const measured = legs.map((l, i) => measureLeg(results[head + i], l));

  // Stage 1: if the direct route crosses other tokens, every via is re-read in ONE call at this block.
  const direct = measured[0];
  if (q.stage === 1 && direct && 'out' in direct) {
    const extra = discoveredVias(direct.route, q.token, q.chainId, MAX_VIAS - q.vias.length);
    if (extra.length > 0) {
      const next = preparedBody(q.chainId, q.version, q.quoter, q.token, q.amountIn, [...q.vias, ...extra], 2, block);
      return { ok: true, body: { ok: true, mode: 'usd', complete: false, blockNumber: block.toString(), next } };
    }
  }

  const d = CHAINS[q.chainId].usdc;
  const vias: Record<string, unknown>[] = [];
  const values: bigint[] = [];
  if (q.vias.length === 0) {
    values.push(q.amountIn);
    vias.push({ path: [d], status: 'identity', usd: q.amountIn.toString(), legs: [] });
  }
  let k = 0;
  for (const v of q.vias) {
    const vl = legsOf(v, q.amountIn);
    const ms = vl.map(() => measured[k++]);
    const legJson = vl.map((l, i) => ({
      tokenIn: l.tokenIn, tokenOut: l.tokenOut, amountIn: l.amountIn.toString(),
      ...('out' in ms[i] ? { out: (ms[i] as { out: bigint }).out.toString() } : {}),
    }));
    const failed = ms.find((m) => 'reason' in m) as { reason: string } | undefined;
    if (failed) {
      vias.push({ path: v.path, status: 'not measured', reason: failed.reason, legs: legJson, ...(v.ref !== undefined ? { scaledFrom: v.ref.toString() } : {}) });
      continue;
    }
    const outs = ms.map((m) => (m as { out: bigint }).out);
    const usd = outs.length === 1 ? outs[0] : (outs[0] * outs[1]) / v.ref!;
    if (usd === 0n) {
      vias.push({ path: v.path, status: 'not measured', reason: 'scaled value is 0', legs: legJson, scaledFrom: v.ref!.toString() });
      continue;
    }
    values.push(usd);
    vias.push({ path: v.path, status: 'measured', usd: usd.toString(), legs: legJson, ...(v.ref !== undefined ? { scaledFrom: v.ref.toString() } : {}) });
  }

  const usdValue = values.length ? values.reduce((a, b) => (b < a ? b : a)) : null;
  const max = values.length ? values.reduce((a, b) => (b > a ? b : a)) : null;
  const spread = values.length >= 2 && usdValue !== null && max !== null
    ? { min: usdValue.toString(), max: max.toString(), diff: (max - usdValue).toString(), bps: (((max - usdValue) * 10_000n) / max).toString() }
    : null;
  const usd = usdValue !== null && dD !== null ? formatUnits(usdValue, dD) : 'not measured';
  const unitPrice = usdValue !== null && dT !== null && dD !== null
    ? formatUnits((usdValue * 10n ** BigInt(dT + 18)) / (q.amountIn * 10n ** BigInt(dD)), 18)
    : 'not measured';
  return {
    ok: true,
    body: {
      ok: true, mode: 'usd', complete: true,
      chainId: q.chainId, version: q.version, label: dollarLabel(q.chainId), dollarToken: d, dollarDecimals: dD,
      token: q.token, amountIn: q.amountIn.toString(), tokenDecimals: dT, blockNumber: block.toString(),
      usdValue: usdValue === null ? null : usdValue.toString(), usd, unitPrice, vias, spread,
      rpc: { requests: q.stage }, basis: USD_BASIS,
    },
  };
}

/** A decoded quote whose request asked for USD values (`usd: true`) also carries the prepared call that
 *  values its output (tokenOut at amountOut). Pure: one more eth_call for the caller's node. */
export function attachUsdOut(rawReq: unknown, body: Record<string, unknown>): Record<string, unknown> {
  const r = rawReq as { usd?: unknown; chainId?: unknown; version?: unknown; tokenOut?: unknown } | undefined;
  if (r?.usd !== true || body.ok !== true || typeof body.amountOut !== 'string' || typeof body.tokenOut !== 'string') return body;
  const p = prepareUsd(Number(body.chainId) as SupportedChainId, String(body.protocolVersion), body.tokenOut as Address, BigInt(body.amountOut));
  return { ...body, usdOut: p.ok ? p.body : { ok: false, code: p.code, error: p.message } };
}
