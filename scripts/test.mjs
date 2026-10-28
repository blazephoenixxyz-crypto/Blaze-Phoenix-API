// Checks that need no network, no key and no build: source checks, then the worker modules
// themselves, transpiled in-process by the TypeScript compiler from devDependencies.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

let passed = 0;
let failed = 0;
const check = (name, cond) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
};

// The Exact Pass answers each pool's callback with a revert and never pays, so no
// token moves: it cannot measure a token's own transfer fee or block. The MCP tool
// description must not promise that it does.
const mcp = read('worker/mcp.ts');
check('exact pass: worker/mcp.ts does not promise an execution-grade dry-run',
  !mcp.includes('execution-grade dry-run') && !mcp.includes('including transfer-fee tokens'));
check('exact pass: worker/mcp.ts points to a simulation from the holder',
  /exact:[^\n]*simulate the swap from the holder/.test(mcp));

// Provider keys are injected at deploy time and never committed.
const chains = read('src/config/chains.ts');
check('provider keys are blank in the published source',
  /ALCHEMY_KEYS[^=\n]*=\s*\[\s*\]/.test(chains) || /ALCHEMY_KEYS[^=\n]*=\s*['"]{2}/.test(chains));
check('DRPC key is blank in the published source', /DRPC_KEY[^=\n]*=\s*['"]{2}/.test(chains));

// One integer rule (<= 2^256-1), one body ceiling for REST and /mcp, one block-time table.
const codec = read('worker/codec.ts');
const api = read('worker/quoteApi.ts');
check('integer rule: one shared uint256 check, no 77-digit regex left in quoteApi',
  /export const isUint256Str/.test(codec) && !/\{1,77\}/.test(api) && /isUint256Str\(rawAmt/.test(api));
check('/mcp reads its body through the same capped reader as REST (413)',
  /readJsonBody\(request\)/.test(mcp) && /too_large[^\n]*\n?[^\n]*413|413/.test(mcp));
check('block times: one table, Robinhood 0.104 s, read by the API',
  /4663: 0\.104/.test(read('src/config/blockTime.ts')) && /BLOCK_TIME_SEC/.test(api) && !/4663: 2,/.test(api));
check('exact decode: the envelope carries checks, and 2.x exactOut is a floor within one fee of the bound',
  /checks: exactChecks\(/.test(codec) && /exactOut <= want - protocolFeeOn\(want\)/.test(codec));

// V2 (2.0.0, pending) is not deployed to Ethereum L1; V1 on Ethereum stays live.
const dep = read('src/config/deployments.ts');
const v2 = dep.slice(dep.indexOf("version: '2.0.0'"), dep.indexOf("version: '1.0.0'"));
const v1 = dep.slice(dep.indexOf("version: '1.0.0'"));
check('registry: 2.0.0 carries no chain 1 entry', v2.includes('chains:') && !/^\s*1:\s*[{]/m.test(v2));
check('registry: 1.0.0 still lists chain 1', /^\s*1:\s*[{]/m.test(v1));

// ── Behaviour. Each .ts file is transpiled on its own (types stripped, nothing bundled) into a
// scratch tree and imported, so these checks run the code that ships. fetch is stubbed where a
// path could reach it.
const scratch = join(root, 'node_modules', '.cache', 'api-test');
const emitted = new Map();
function emit(file) {
  const known = emitted.get(file);
  if (known) return known;
  const out = join(scratch, relative(root, file)).replace(/\.ts$/, '.mjs');
  emitted.set(file, out);
  const js = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]+)\2/g, (all, lead, q, spec) => {
    const base = resolve(dirname(file), spec);
    const src = [`${base}.ts`, join(base, 'index.ts')].find((p) => existsSync(p));
    return src ? `${lead}${q}${pathToFileURL(emit(src)).href}${q}` : all;
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, js);
  return out;
}
const load = (f) => import(pathToFileURL(emit(join(root, f))).href);

try {
  const { encodeFunctionResult } = await import('viem');
  const { CHAINS } = await load('src/config/chains.ts');
  const { DEPLOYMENTS } = await load('src/config/deployments.ts');
  const { QUOTER_ABI } = await load('src/abis/blaze.ts');
  const { decodeQuote } = await load('worker/codec.ts');
  const { resolveTokenParam, parseQuoteParams, prepareFromParams, handleQuoteFirstParty } = await load('worker/quoteApi.ts');

  // Symbols resolve only to the token they name. `chain.usdc` holds each chain's one dollar
  // asset: USDG on Robinhood Chain, USDC elsewhere. The other symbol does not resolve to it.
  check('symbols: USDC resolves to the dollar asset on Base', resolveTokenParam('USDC', 8453) === CHAINS[8453].usdc);
  check('symbols: USDC does not resolve on Robinhood Chain, whose dollar asset is USDG', resolveTokenParam('USDC', 4663) === undefined);
  check('symbols: USDG resolves to the dollar asset on Robinhood Chain', resolveTokenParam('usdg', 4663) === CHAINS[4663].usdc);
  check('symbols: USDG does not resolve on Base', resolveTokenParam('USDG', 8453) === undefined);
  const rhIn = parseQuoteParams(new URLSearchParams('chain=robinhood&in=USDC&out=WETH&amountIn=1000000'));
  check('symbols: in=USDC on Robinhood Chain -> bad_token_in, naming USDG',
    !rhIn.ok && rhIn.code === 'bad_token_in' && /USDG/.test(rhIn.message));
  const rhOut = parseQuoteParams(new URLSearchParams('chain=robinhood&in=WETH&out=usdc&amountIn=1000000000000000000'));
  check('symbols: out=USDC on Robinhood Chain -> bad_token_out', !rhOut.ok && rhOut.code === 'bad_token_out');
  const rhPrep = prepareFromParams(new URLSearchParams('chain=robinhood&in=USDC&out=WETH&amountIn=1000000'));
  check('symbols: prepare (REST and MCP) points to USDG on Robinhood Chain and lists USDC with that caveat',
    !rhPrep.ok && /USDG/.test(rhPrep.message) && !/USDC and BZPX are built in/.test(rhPrep.message));
  // The first-party quote looks unknown tickers up by name. USDC on Robinhood Chain is answered
  // on the spot: nothing is fetched, neither a symbol lookup nor a read.
  const realFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (input) => { fetched.push(String(input?.url ?? input)); return new Response('{}', { status: 503 }); };
  try {
    const fp = await handleQuoteFirstParty(new URL('https://blazephoenix.xyz/api/quote?chain=robinhood&in=USDC&out=WETH&amountIn=1000000'));
    const body = await fp.json();
    check('symbols: first-party quote of USDC on Robinhood Chain -> 400 bad_token_in, nothing fetched',
      fp.status === 400 && body.code === 'bad_token_in' && fetched.length === 0);
  } finally {
    globalThis.fetch = realFetch;
  }

  // A preview's numbers are the Quoter's own derivation from its route (`_pack`): grossOut is
  // route.totalOut, the protocol fee and the safety buffer come off it, netOut is what is left,
  // hops and legs count the route, and the route adds up hop by hop. Decode holds all of it.
  const ZERO = '0x0000000000000000000000000000000000000000';
  const AUX = `0x${'0'.repeat(64)}`;
  const ONE = 10n ** 18n;
  const BPS = 10_000n;
  const base = CHAINS[8453];
  // A leg, positional: (venue, hooks, kind, fee, tickSpacing, zeroForOne, stable, amountIn, expectedOut, auxId).
  const leg = (i, amountIn, expectedOut) => [`0x${'0'.repeat(39)}${i}`, ZERO, 1, 500, 10, true, false, amountIn, expectedOut, AUX];
  /** One hop WETH -> USDC on Base over these leg outputs, 1 WETH split across them. */
  const oneHop = (outs, floor) => {
    const n = BigInt(outs.length);
    const total = outs.reduce((s, x) => s + x, 0n);
    const legs = outs.map((o, i) => leg(i + 1, i === 0 ? ONE - (ONE / n) * (n - 1n) : ONE / n, o));
    return {
      hops: [{ tokenIn: base.weth, tokenOut: base.usdc, amountIn: ONE, expectedOut: total, legs }],
      totalOut: total, singleOut: outs[0], singleOutFloor: floor,
      expectedImpactBps: 3n, confidenceWad: 0n, estGas: 420_000n, hasSurplus: false, isV4Bundle: false,
    };
  };
  const legsIn = (r) => r.hops.reduce((s, h) => s + BigInt(h.legs.length), 0n);
  const bufferBps = (r) => { const n = legsIn(r); return n > 2n ? (n - 2n < 10n ? n - 2n : 10n) : 0n; };
  const down = (x) => x / BPS; // 1.x rounds the fee and the buffer down
  const up = (x) => (x + BPS - 1n) / BPS; // 2.x rounds them up
  const feeOf = (gross, round, charges = 1) => { let a = gross; for (let c = 0; c < charges; c++) a -= round(a * 28n); return gross - a; };
  const derive = (gross, fee, r, round) => {
    const after = gross - fee;
    const safetyBuffer = round(after * bufferBps(r));
    return { grossOut: gross, protocolFee: fee, safetyBuffer, netOut: after > safetyBuffer ? after - safetyBuffer : 0n };
  };
  const pack = (r, round, charges = 1) => derive(r.totalOut, feeOf(r.totalOut, round, charges), r, round);
  const preview = (r, scalars, userMinOut = 0n) => {
    const eff = userMinOut > r.singleOutFloor ? userMinOut : r.singleOutFloor;
    return {
      route: r, ...scalars, ironFloor: r.singleOutFloor, userMinOut, effectiveMinOut: eff, estGas: r.estGas,
      hops: BigInt(r.hops.length), legs: legsIn(r), topology: 0, bridgeUsed: ZERO, canExecute: scalars.netOut > 0n && scalars.netOut >= eff,
    };
  };
  const req1 = { chainId: 8453, version: '1.0.0', fn: 'previewPlan', tokenIn: base.weth, tokenOut: base.usdc, amountIn: ONE.toString(), nativeIn: false, nativeOut: false };
  const decode = (pv, req = req1) => decodeQuote(req, encodeFunctionResult({ abi: QUOTER_ABI, functionName: req.fn, result: [pv, pv.route, false] }));
  const refused = (pv, why, req = req1) => { const d = decode(pv, req); return !d.ok && d.code === 'result_mismatch' && why.test(d.message); };

  // Totals measured on the live Base 1.0.0 Quoter, previewPlan(WETH, USDC, 1e18), 28 Oct 2026:
  // one hop, five legs, totalOut 2317447406 -> protocolFee 6488852, safetyBuffer 693287, netOut 2310265267.
  const live = oneHop([927_000_000n, 695_200_000n, 347_600_000n, 231_700_000n, 115_947_406n], 2_280_000_000n);
  const T = live.totalOut;
  const honest = preview(live, pack(live, down));
  check('preview: the 1.x derivation reproduces the measured Base answer',
    T === 2_317_447_406n && honest.protocolFee === 6_488_852n && honest.safetyBuffer === 693_287n && honest.netOut === 2_310_265_267n);
  const ok1 = decode(honest);
  check('preview: the Quoter\'s own answer decodes, amountOut = netOut', ok1.ok && ok1.body.amountOut === '2310265267');
  const small = oneHop([200_000n, 150_000n, 75_000n, 50_000n, 25_000n], 450_000n);
  const claimed = { ...preview(small, pack(small, down)), grossOut: 999_999n, protocolFee: 1n, netOut: 951_000n };
  check('preview: a route totalling 500000 under scalars of 999999 gross, fee 1, 951000 net -> result_mismatch',
    refused(claimed, /grossOut/));
  check('preview: grossOut other than route.totalOut -> result_mismatch',
    refused(preview(live, derive(2n * T, feeOf(2n * T, down), live, down)), /grossOut is not/));
  check('preview: protocolFee other than the fee on grossOut -> result_mismatch', refused(preview(live, derive(T, 1n, live, down)), /protocolFee/));
  check('preview: safetyBuffer other than the route\'s buffer -> result_mismatch',
    refused({ ...honest, safetyBuffer: 0n, netOut: T - honest.protocolFee }, /safetyBuffer/));
  check('preview: netOut other than grossOut less fee and buffer -> result_mismatch', refused({ ...honest, netOut: honest.netOut + 1_000n }, /netOut is not/));
  check('preview: hops or legs other than the route\'s counts -> result_mismatch',
    refused({ ...honest, hops: 2n }, /hops/) && refused({ ...honest, legs: 4n }, /legs are not/));
  const legOff = structuredClone(live);
  legOff.hops[0].legs[1][8] += 1n;
  check('preview: a hop output that is not the sum of its legs -> result_mismatch', refused(preview(legOff, pack(legOff, down)), /sum of its legs/));
  const totalOff = { ...live, totalOut: T + 1_000n };
  check('preview: a totalOut that is not the last hop output -> result_mismatch', refused(preview(totalOff, pack(totalOff, down)), /last hop/));
  // The exact pass holds the same sums (previewPlanExact returns the route and, on 1.x, its total).
  const exact = (r) => decodeQuote({ ...req1, fn: 'previewPlanExact' },
    encodeFunctionResult({ abi: QUOTER_ABI, functionName: 'previewPlanExact', result: [{ ...r, singleOut: r.totalOut }, r.totalOut] }));
  const xOk = exact(live);
  const xOff = exact(legOff);
  check('exact: the route decodes on the exact pass, and not with a hop output off the sum of its legs',
    xOk.ok && !xOff.ok && xOff.code === 'result_mismatch' && /sum of its legs/.test(xOff.message));

  // 2.x, with the registry holding a Base 2.0.0 set for these checks: the fee and the buffer
  // round up; the fee is charged once, or once per hop on a multi-hop route that holds no
  // bridge; legs priced on an assumed fee add to the buffer, under the same 10 bps cap.
  const set2 = DEPLOYMENTS.versions.find((v) => v.version === '2.0.0').chains[8453];
  const saved = { ...set2 };
  Object.assign(set2, {
    core: '0x00000000000000000000000000000000000000c0', hub: '0x00000000000000000000000000000000000000a1',
    solver: '0x00000000000000000000000000000000000000a2', router: '0x00000000000000000000000000000000000000a3',
    quoter: '0x00000000000000000000000000000000000000a4',
  });
  try {
    const AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631';
    const X = 1_523_456_789_012_345_678_901n;
    const two = {
      ...live, totalOut: X, singleOut: X, singleOutFloor: (X * 99n) / 100n,
      hops: [live.hops[0], { tokenIn: base.usdc, tokenOut: AERO, amountIn: T, expectedOut: X, legs: [leg(6, T, X)] }],
    };
    const req2 = { ...req1, version: '2.0.0', tokenOut: AERO };
    const after = X - feeOf(X, up);
    check('preview 2.x: the fee charged once -> decodes', decode(preview(two, pack(two, up)), req2).ok);
    check('preview 2.x: the fee charged on every hop -> decodes', decode(preview(two, pack(two, up, 2)), req2).ok);
    check('preview 2.x: a buffer at the 10 bps cap -> decodes',
      decode(preview(two, { ...pack(two, up), safetyBuffer: up(after * 10n), netOut: after - up(after * 10n) }), req2).ok);
    check('preview 2.x: no fee -> result_mismatch', refused(preview(two, derive(X, 0n, two, up)), /protocolFee/, req2));
    check('preview 2.x: a buffer above the 10 bps cap -> result_mismatch',
      refused(preview(two, { ...pack(two, up), safetyBuffer: up(after * 11n), netOut: after - up(after * 11n) }), /safetyBuffer/, req2));
    check('preview 2.x: a buffer under the legs\' share -> result_mismatch',
      refused(preview(two, { ...pack(two, up), safetyBuffer: 0n, netOut: after }), /safetyBuffer/, req2));
  } finally {
    Object.assign(set2, saved);
  }
} catch (e) {
  check(`behaviour checks ran to the end (${e?.stack ?? e})`, false);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failed === 0 ? `✅ ${passed} passed, 0 failed` : `❌ ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
