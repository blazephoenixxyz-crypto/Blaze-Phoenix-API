// Checks that need no network, no key and no build: source checks, then the worker modules
// themselves, transpiled in-process by the TypeScript compiler from devDependencies.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  const { encodeFunctionResult, decodeFunctionData } = await import('viem');
  const { CHAINS } = await load('src/config/chains.ts');
  const { DEPLOYMENTS } = await load('src/config/deployments.ts');
  const { QUOTER_ABI, ROUTER_ABI } = await load('src/abis/blaze.ts');
  const { decodeQuote } = await load('worker/codec.ts');
  const { resolveTokenParam, parseQuoteParams, prepareFromParams, handleQuoteFirstParty, BZPX_COMING_SOON,
    handleManifest, handleDeployments, handleDiscovery, handleHealth } = await load('worker/quoteApi.ts');
  const { handleBadge, handleSolvencyReport, SOLVENCY_COMING_SOON } = await load('worker/solvency.ts');
  const { handleOpenapi } = await load('worker/openapi.ts');
  const { handleMcp } = await load('worker/mcp.ts');

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
  // BZPX: coming soon. No chain resolves the ticker, the refusal says so, and no response
  // carries a BZPX or staking address. Mutants: put `bzpx: '0x…'` and `case 'BZPX'` back in
  // chains.ts/quoteApi.ts (resolve + refusal checks go red); put the staking address back in
  // dex(…) or SITE.token (the response scan goes red); read or name a contract in the badge
  // or the /cli banner (same). The scan needs no address literal: every 0x address a
  // response carries must be one this repo publishes on purpose (registry, weth, dollar
  // asset, fee split, admin, zero, the native sentinel).
  const bzpxSyms = ['BZPX', 'bzpx', ' Bzpx '];
  check('bzpx: the ticker resolves on no chain',
    Object.keys(CHAINS).every((id) => bzpxSyms.every((sym) => resolveTokenParam(sym, Number(id)) === undefined)));
  check('bzpx: no chain config carries a bzpx field or a non-zero staking address',
    Object.values(CHAINS).every((c) => !('bzpx' in c) && /^0x0{40}$/.test(c.contracts.staking)));
  const allChains = Object.keys(CHAINS);
  const bzIns = allChains.map((id) => parseQuoteParams(new URLSearchParams(`chain=${id}&in=BZPX&out=WETH&amountIn=1000`)));
  const bzOuts = allChains.map((id) => parseQuoteParams(new URLSearchParams(`chain=${id}&in=WETH&out=bzpx&amountIn=1000`)));
  const bzPrep = prepareFromParams(new URLSearchParams(`chain=${allChains[0]}&in=BZPX&out=WETH&amountIn=1000`));
  check('bzpx: in=BZPX -> bad_token_in with the coming-soon refusal, on every chain',
    bzIns.length >= 5 && bzIns.every((r) => !r.ok && r.code === 'bad_token_in' && r.message.includes(BZPX_COMING_SOON)));
  check('bzpx: out=BZPX -> bad_token_out with the coming-soon refusal, on every chain',
    bzOuts.every((r) => !r.ok && r.code === 'bad_token_out' && r.message.includes(BZPX_COMING_SOON)));
  check('bzpx: prepare (REST and MCP) carries the refusal and no longer lists BZPX as built in',
    !bzPrep.ok && bzPrep.message.includes(BZPX_COMING_SOON) && !/and BZPX are built in/.test(bzPrep.message));
  const badgeRes = await handleBadge();
  const badge = await badgeRes.clone().json();
  check('solvency: /api/badge answers coming_soon fail-closed (no verdict, no read time)',
    badgeRes.status === 200 && badge.status === 'coming_soon' && badge.message === SOLVENCY_COMING_SOON
    && badge.color === 'lightgrey' && badge.readAtMs === null && !/isSolvent|true|false/.test(badge.message));
  const solvRes = await handleSolvencyReport();
  const solvHtml = await solvRes.clone().text();
  check('solvency: /solvency says proof-of-solvency is coming soon', solvRes.status === 200 && solvHtml.includes(SOLVENCY_COMING_SOON));
  const noNet = /\b(base|basescan|ethereum|optimism|arbitrum|robinhood|8453)\b/i;
  check('solvency: badge and page name no contract and no network',
    [JSON.stringify(badge), solvHtml].every((t) => !/0x[0-9a-fA-F]{40}/.test(t) && !noNet.test(t.replace('blazephoenix.xyz', ''))));
  const mcpList = await handleMcp(new Request('https://x/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }));
  const { default: worker } = await load('worker/index.ts');
  const cliRes = await worker.fetch(new Request('https://blazephoenix.xyz/cli'), {}, { waitUntil() {} });
  const bodies = [handleManifest(), handleDeployments(), handleDiscovery(), handleHealth(), handleOpenapi(),
    badgeRes, solvRes, mcpList, cliRes, bzPrep.message].map((r) => (typeof r === 'string' ? r : r.text()));
  const served = (await Promise.all(bodies)).join('\n').toLowerCase();
  const { SITE } = await load('src/config/site.ts');
  const published = new Set([
    '0x' + '0'.repeat(40), '0x' + 'e'.repeat(40), SITE.protocol.admin, ...SITE.protocol.feeSplit.map((f) => f.address),
    ...Object.values(CHAINS).flatMap((c) => [c.weth, c.usdc]),
    ...DEPLOYMENTS.versions.flatMap((d) => Object.values(d.chains).flatMap((e) => Object.values(e))),
  ].filter((a) => typeof a === 'string').map((a) => a.toLowerCase()));
  const strays = [...new Set(served.match(/0x[0-9a-f]{40}(?![0-9a-f])/g) ?? [])].filter((a) => !published.has(a));
  check(`bzpx: every address a response carries is a published one, so none is a BZPX or staking address (${strays.join(', ') || 'none stray'})`,
    served.length > 1000 && cliRes.status === 200 && strays.length === 0
    && !/"bzpx"\s*:\s*"0x/.test(served) && !/"token"\s*:\s*\{[^}]*"address"/.test(served));
  check('solvency: no served text calls the badge or the solvency report live',
    !/live isSolvent|live proof-of-solvency|live staking|solvency-live|solvency on your own rpc/.test(served)
    && /proof-of-solvency: coming soon \(html page/.test(served));
  check('bzpx: no chain config or SITE.token carries a bzpx field or a token address',
    !/bzpx\??:\s*['"`]?0x/i.test(read('src/config/chains.ts')) && !('address' in SITE.token) && !('chain' in SITE.token));
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

  // Calldata is emitted only for a preview prepared with a recipient AND a non-zero userMinOut
  // (decode is pure: a minimum derived from the answer alone protects nothing). The minimum in
  // the calldata is the greatest of userMinOut, netOut less slippage and the on-chain floor,
  // and exact mode never emits calldata. Documented in README, llms.txt and the OpenAPI.
  const NOW = 1_800_000_000;
  const rcpt = '0x00000000000000000000000000000000000000b1';
  const txReq = (bps, umo) => ({ ...req1, ...(umo ? { fn: 'previewPlanWithMinOut', userMinOut: umo.toString() } : {}), recipient: rcpt, slippageBps: bps, deadline: String(NOW + 120) });
  const decodeTx = (umo, bps = 50) => {
    const r = txReq(bps, umo);
    const pv = preview(live, pack(live, down), umo ?? 0n);
    return decodeQuote(r, encodeFunctionResult({ abi: QUOTER_ABI, functionName: r.fn, result: [pv, pv.route, false] }), NOW);
  };
  const noUmo = decodeTx(undefined);
  check('calldata: a recipient without userMinOut emits no tx and answers txError min_required',
    noUmo.ok && noUmo.body.tx === undefined && noUmo.body.minOut === undefined && noUmo.body.txError?.code === 'min_required');
  const netMinusSlip = 2_310_265_267n - (2_310_265_267n * 50n) / 10_000n;
  const mAbove = decodeTx(2_300_000_000n);
  check('calldata: userMinOut above netOut less slippage -> tx minOut is userMinOut',
    mAbove.ok && mAbove.body.tx !== undefined && mAbove.body.minOut === '2300000000');
  const mBelow = decodeTx(2_290_000_000n);
  check('calldata: userMinOut below netOut less slippage -> tx minOut is netOut less slippage',
    mBelow.ok && mBelow.body.tx !== undefined && mBelow.body.minOut === netMinusSlip.toString());
  const mFloor = decodeTx(1n, 5000);
  check('calldata: slippage and userMinOut both under the on-chain floor -> tx minOut is the floor',
    mFloor.ok && mFloor.body.tx !== undefined && mFloor.body.minOut === live.singleOutFloor.toString());
  const xTx = decodeQuote({ ...req1, fn: 'previewPlanExact', userMinOut: '2290000000', recipient: rcpt, slippageBps: 50, deadline: String(NOW + 120) },
    encodeFunctionResult({ abi: QUOTER_ABI, functionName: 'previewPlanExact', result: [{ ...live, singleOut: live.totalOut }, live.totalOut] }), NOW);
  check('calldata: exact mode with a recipient and userMinOut emits no tx', xTx.ok && xTx.body.mode === 'exact' && xTx.body.tx === undefined);

  // The first-party quote (the site's bot, our own RPC) emits swapExactIn calldata when given a
  // recipient: same rule as the decode — max(userMinOut, netOut less slippageBps (default 50),
  // never under effectiveMinOut). Its node answer is mocked here, then fetch is restored.
  {
    const USER = '0x00000000000000000000000000000000000000b0';
    const FLOOR = honest.netOut - (honest.netOut * 50n) / BPS;
    const fpAt = async (qs) => {
      let rpcCalls = 0;
      globalThis.fetch = async () => {
        rpcCalls++;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1,
          result: encodeFunctionResult({ abi: QUOTER_ABI, functionName: 'previewPlan', result: [honest, live, false] }) }), { status: 200 });
      };
      try {
        const b = await (await handleQuoteFirstParty(new URL(`https://blazephoenix.xyz/api/quote?chain=base&in=${base.weth}&out=${base.usdc}&amountIn=${ONE}${qs}`))).json();
        return { b, rpcCalls, min: b?.tx ? decodeFunctionData({ abi: ROUTER_ABI, data: b.tx.data }).args[2] : undefined };
      } finally {
        globalThis.fetch = realFetch;
      }
    };
    check('first-party quote: the floor sits between effectiveMinOut and netOut (fixture sanity)',
      honest.effectiveMinOut < FLOOR && FLOOR < honest.netOut && honest.canExecute);
    const fp0 = await fpAt('');
    check('first-party quote: no recipient -> quote from one RPC call, no tx', fp0.b.ok === true && fp0.rpcCalls === 1 && fp0.b.tx === undefined);
    const fpR = `&recipient=${USER}`;
    check('first-party quote: recipient, no userMinOut/slippageBps -> signs the 50 bps floor', (await fpAt(fpR)).min === FLOOR);
    check('first-party quote: userMinOut=1 -> signs the floor, not 1', (await fpAt(`${fpR}&userMinOut=1`)).min === FLOOR);
    check('first-party quote: userMinOut = floor - 1 -> signs the floor', (await fpAt(`${fpR}&userMinOut=${FLOOR - 1n}`)).min === FLOOR);
    check('first-party quote: userMinOut = floor + 1 -> signs userMinOut (the caller\'s minimum is kept)',
      (await fpAt(`${fpR}&userMinOut=${FLOOR + 1n}`)).min === FLOOR + 1n);
    check('first-party quote: slippageBps=0 -> signs netOut', (await fpAt(`${fpR}&slippageBps=0`)).min === honest.netOut);
    check('first-party quote: slippageBps=200 -> signs effectiveMinOut (never under it)',
      (await fpAt(`${fpR}&slippageBps=200`)).min === honest.effectiveMinOut);
  }

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
  // ── Staking: two independent deployments, each pinned by (chainId, address, codehash). ──
  // Test chainIds 31337 and 31338 stand for the two deployments; the same address on both is the
  // case CREATE produces from one deployer and nonce, so only the chainId and the code tell them apart.
  try {
    const v = await import('viem');
    const gen = await load('src/abis/staking.generated.ts');
    const { STAKING_ABI } = await load('src/abis/staking.ts');
    const cfg = await load('src/config/staking.ts');
    const { handleVersion } = await load('worker/version.ts');
    const { formatAbiItem } = await import('viem/utils');
    const canon = (abi) => abi.map((x) => (x.type === 'constructor' ? 'constructor' : `${x.type} ${formatAbiItem(x)}`));

    // api_staking_abi_parity_with_src. The generated file is the compiler's ABI of the staking
    // source at STAKING_ABI_SOURCE_REVISION (scripts/gen-staking-abi.mjs --check proves that against
    // a checkout); here: the file is unedited, and the ABI the worker uses is that file, item for item.
    check('staking abi: the generated file hashes to its recorded digest (no hand edit)',
      v.keccak256(v.toBytes(JSON.stringify(gen.STAKING_ABI))) === gen.STAKING_ABI_DIGEST
      && /^[0-9a-f]{40}$/.test(gen.STAKING_ABI_SOURCE_REVISION));
    // api_staking_abi_interface_pin. The digest above is self-attested (a hand edit can rewrite it);
    // this pin is not: the item count and the hash of the whole ABI (names, inputs, outputs,
    // mutability), fixed here and never read from the file. CI recompiles the revision the file
    // names and runs gen-staking-abi.mjs --check; a new interface changes this pin with the file.
    check('staking abi: 174 items whose content hashes to the interface pinned in this suite, not to the file\'s own digest',
      gen.STAKING_ABI.length === 174
      && v.keccak256(v.toBytes(JSON.stringify(gen.STAKING_ABI))) === '0x854d437b9f3e47e55a17eb278017ba2c3f0ef32a6d2bb5577812419ec50309ef');
    const served = canon(STAKING_ABI);
    const fromSrc = canon(gen.STAKING_ABI);
    check('staking abi: the worker ABI is the generated one, no phantom item and none missing',
      served.length === fromSrc.length && served.every((k, i) => k === fromSrc[i])
      && JSON.stringify(STAKING_ABI) === JSON.stringify(gen.STAKING_ABI));
    const errs = (name) => STAKING_ABI.filter((x) => x.type === 'error' && x.name === name).length;
    const decodes = (name) => {
      try { return v.decodeErrorResult({ abi: STAKING_ABI, data: v.toFunctionSelector(`${name}()`) }).errorName === name; } catch { return false; }
    };
    check('staking abi: Staking__AlreadyFunded is not in the source, so not in the ABI',
      errs('Staking__AlreadyFunded') === 0 && !decodes('Staking__AlreadyFunded'));
    check('staking abi: reverts the source can raise decode by name (UtilTooHigh, EnforcedPause, StaleEquity, PaidIntoBreach, EmissionNotEnded)',
      ['Staking__UtilTooHigh', 'EnforcedPause', 'Staking__StaleEquity', 'Staking__PaidIntoBreach', 'Staking__EmissionNotEnded'].every(decodes));
    const report = {
      backing: 2n ** 256n - 1n, owed: 1n, surplus: 0n, deficit: 0n, solvent: true, collateralRatioWad: 10n ** 18n + 1n,
      totalStaked: 10n ** 18n, totalDebt: 0n, rewardReserve: 1n, protocolReserve: 0n, pendingDistribution: 0n, totalBadDebt: 0n, totalUncollectedInterest: 0n,
    };
    const solvencyRet = v.encodeFunctionResult({ abi: STAKING_ABI, functionName: 'solvency', result: report });
    const back = v.decodeFunctionResult({ abi: STAKING_ABI, functionName: 'solvency', data: solvencyRet });
    check('staking abi: solvency() round-trips the SolvencyReport struct (uint256 max, 1 wei)',
      Object.keys(report).every((k) => back[k] === report[k]));

    // staking_config_absent_is_not_zero_address
    const ADDR = '0x00000000000000000000000000000000005fa1e0';
    const CODE_A = '0x6080604052348015600e575f5ffd5b50600a';
    const CODE_B = '0x6080604052348015600e575f5ffd5b50600b';
    const depA = { chainId: 31337, address: ADDR, codehash: v.keccak256(CODE_A) };
    const depB = { chainId: 31338, address: ADDR, codehash: v.keccak256(CODE_B) };
    check('staking config: the published source configures no deployment -> not_deployed, on any chain id',
      Object.keys(cfg.STAKING_DEPLOYMENTS).length === 0
      && [31337, 31338, 1, 0, -1, 2 ** 53, NaN].every((id) => { const r = cfg.stakingDeployment(id); return !r.ok && r.code === 'not_deployed'; })
      && cfg.stakingChainIds().length === 0);
    const bad = (entry, key = entry.chainId) => {
      cfg.STAKING_DEPLOYMENTS[key] = entry;
      try { const r = cfg.stakingDeployment(key); return !r.ok && r.code === 'bad_config'; } finally { delete cfg.STAKING_DEPLOYMENTS[key]; }
    };
    check('staking config: the zero address is never a deployment (absent is not zero)', bad({ ...depA, address: ZERO }));
    check('staking config: a zero codehash, or the codehash of no code, is never a pin',
      bad({ ...depA, codehash: `0x${'0'.repeat(64)}` }) && bad({ ...depA, codehash: v.keccak256('0x') }) && bad({ ...depA, codehash: undefined }));
    check('staking config: an entry whose chainId is not its key is refused', bad(depA, 31338));
    check('staking config: a 19- or 21-byte address, or one nibble short or long, is refused',
      [ADDR.slice(0, -2), `${ADDR}00`, ADDR.slice(0, -1), `${ADDR}0`].every((address) => bad({ ...depA, address })));
    // staking_config_address_checksum (EIP-55). Mixed case must be the checksum case; all-lowercase
    // carries no checksum and is accepted; all-uppercase is not a checksum form and is refused. What
    // the lookup returns is the checksum form, so the manifest never republishes an address a strict
    // consumer refuses. viem's getAddress is the oracle, not the code under test.
    const lower = '0xabcdef0000000000000000000000000000000001';
    const sum = v.getAddress(lower);
    const upper = `0x${lower.slice(2).toUpperCase()}`;
    const flipAt = 2 + sum.slice(2).search(/[a-f]/i);
    const flipped = sum.slice(0, flipAt) + (sum[flipAt] === sum[flipAt].toLowerCase() ? sum[flipAt].toUpperCase() : sum[flipAt].toLowerCase()) + sum.slice(flipAt + 1);
    const okAs = (address, expect) => {
      cfg.STAKING_DEPLOYMENTS[31337] = { ...depA, address };
      try { const r = cfg.stakingDeployment(31337); return r.ok && r.deployment.address === expect; } finally { delete cfg.STAKING_DEPLOYMENTS[31337]; }
    };
    check('staking config: a mixed-case address with a wrong EIP-55 checksum is refused (one letter flipped)',
      flipAt > 1 && flipped !== sum && bad({ ...depA, address: flipped }) && bad({ ...depA, address: '0xAbCdEf0000000000000000000000000000000001' }));
    check('staking config: all-uppercase is not a checksum form and is refused', upper !== sum && bad({ ...depA, address: upper }));
    // Boundary: this address has hex letters where the hash nibble is exactly 8, the lowest that upper-cases.
    const nib8 = '0xabcdef0000000000000000000000000000000006';
    const nib8Hash = v.keccak256(v.stringToBytes(nib8.slice(2))).slice(2);
    check('staking config: all-lowercase and the correct checksum are accepted and both resolve to the checksum form (hash nibble 8 included)',
      okAs(lower, sum) && okAs(sum, sum) && okAs(ADDR, v.getAddress(ADDR))
      && nib8Hash[2] === '8' && nib8Hash[4] === '8' && okAs(nib8, v.getAddress(nib8)) && okAs(v.getAddress(nib8), v.getAddress(nib8)));
    // Seeded PRNG: 64 random addresses; lowercase passes and resolves to viem's checksum, one random
    // letter flipped on the checksum form fails, unless the address has no letter at all.
    let aseed = 0x5eed0055;
    const arnd = () => { aseed = (aseed * 1103515245 + 12345) >>> 0; return aseed; };
    const fuzzAddr = Array.from({ length: 64 }, () => `0x${Array.from({ length: 40 }, () => (arnd() >>> 16 & 15).toString(16)).join('')}`);
    check('staking config: 64 seeded addresses: lowercase -> checksum form; one letter flipped on the checksum form -> refused',
      fuzzAddr.every((a) => {
        const s = v.getAddress(a);
        const letters = [...s.slice(2)].map((c, i) => (/[a-z]/i.test(c) ? i + 2 : -1)).filter((i) => i >= 0);
        if (!okAs(a, s) || !okAs(s, s)) return false;
        if (letters.length === 0) return true;
        const i = letters[arnd() % letters.length];
        const f = s.slice(0, i) + (s[i] === s[i].toLowerCase() ? s[i].toUpperCase() : s[i].toLowerCase()) + s.slice(i + 1);
        return bad({ ...depA, address: f });
      }));
    // staking_config_lookup_is_projected: the lookup hands out {chainId, address, codehash} and
    // nothing else from the entry, so no extra field reaches a reader.
    cfg.STAKING_DEPLOYMENTS[31337] = { ...depA, rpcs: ['http://example.invalid'], name: 'X' };
    try {
      const r = cfg.stakingDeployment(31337);
      check('staking config: the lookup returns exactly {chainId, address, codehash} from an entry with extra fields',
        r.ok && JSON.stringify(Object.keys(r.deployment).sort()) === '["address","chainId","codehash"]');
    } finally { delete cfg.STAKING_DEPLOYMENTS[31337]; }
    Object.assign(cfg.STAKING_DEPLOYMENTS, { 31337: depA, 31338: depB });
    try {
      const a = cfg.stakingDeployment(31337);
      const b = cfg.stakingDeployment(31338);
      check('staking config: two independent deployments at one address resolve each to its own codehash',
        a.ok && b.ok && a.deployment.codehash === depA.codehash && b.deployment.codehash === depB.codehash
        && cfg.stakingChainIds().join() === '31337,31338' && !cfg.stakingDeployment(31339).ok);
    } finally {
      delete cfg.STAKING_DEPLOYMENTS[31337];
      delete cfg.STAKING_DEPLOYMENTS[31338];
    }
    // version_reports_commit_sha. Seeded PRNG: the same 64 SHAs every run.
    let seed = 0x5eed1112;
    const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed; };
    const sha = () => Array.from({ length: 5 }, () => rnd().toString(16).padStart(8, '0')).join('');
    const shas = Array.from({ length: 64 }, sha);
    const served2 = await Promise.all(shas.map(async (s) => (await handleVersion({ COMMIT_SHA: s }).json()).commit));
    check('version: /api/version reports the deploy commit it was given, 64 seeded SHAs',
      served2.every((c, i) => c === shas[i]));
    const s0 = shas[0];
    const refused = [undefined, '', 'main', s0.slice(1), `${s0}0`, `${s0}\n`, ` ${s0}`, s0.toUpperCase(), `0x${s0}`, '0'.repeat(40)];
    const answers = await Promise.all(refused.map(async (s) => { const r = handleVersion({ COMMIT_SHA: s }); return [r.status, await r.json()]; }));
    check('version: absent or malformed COMMIT_SHA -> commit null and commitKnown false, never a guess',
      answers.every(([st, b]) => st === 200 && b.commit === null && b.commitKnown === false));
  } catch (e) {
    check(`staking and version checks ran to the end (${e?.stack ?? e})`, false);
  }
} catch (e) {
  check(`behaviour checks ran to the end (${e?.stack ?? e})`, false);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
// canExecute is swap math, not the token transfer. Every surface that hands out
// calldata must say so and point to the Router eth_call from the payer, and must not
// call the bytes ready to send.
const oapi = read('worker/openapi.ts');
check('no surface calls the calldata ready-to-send / signable / ready for sendTransaction',
  ![api, codec, mcp, oapi].some((s) => /ready-to-send|ready-to-broadcast|ready-to-sign|signable calldata|ready for sendTransaction/.test(s)));
// "verified calldata" alone reads as verified-to-execute; the verification is against the request.
const readme = read('README.md');
check('no surface says bare "verified calldata" (it is verified against the request, and swap math only)',
  ![api, codec, mcp, oapi, readme].some((s) => /verified calldata/.test(s)));
check('one TX_SCOPE text names the Router eth_call from the payer and the token cases',
  /export const TX_SCOPE = [^;]*eth_call to the Router from the paying address[^;]*tax, cap a wallet or exempt/.test(codec));
check('decode preview carries TX_SCOPE beside every tx',
  /executeWith: \{ router: contracts\.router, chainId: req\.chainId, \.\.\.\(tx \? \{ note: TX_SCOPE \} : \{\}\) \}/.test(codec));
check('/api/quote carries TX_SCOPE in executeWith.note when it emits tx',
  /tx \? ` \$\{TX_SCOPE\}` : ''/.test(api));
check('hosted MCP recipient, decode_quote and instructions point to a simulation from the payer',
  /recipient:[^\n]*simulate it as an eth_call to the Router from the payer/.test(mcp)
  && /simulate it as an eth_call to the Router from the paying address/.test(mcp)
  && /simulate that calldata from the paying address/.test(mcp));

// The calldata contract is written where integrators read it: the OpenAPI parameters, README and llms.txt.
const llms = read('llms.txt');
check('docs: OpenAPI userMinOut is required for calldata (min_required) and exact emits none',
  /name: 'userMinOut'[^\n]*\n\s*description: '[^\n]*required for calldata[^\n]*min_required/.test(oapi)
  && /name: 'exact'[^\n]*\n\s*description: '[^\n]*emits no calldata/.test(oapi));
check('docs: README and llms.txt say calldata needs userMinOut (min_required) and exact emits none',
  [readme, llms].every((d) => /userMinOut/.test(d) && /min_required/.test(d) && /exact=1` never emits calldata/.test(d)));

// /api/version is routed like every other API path and is handed the Worker env.
const index = read('worker/index.ts');
check('/api/version is an API path, answered by handleVersion(env)',
  /API_PATHS = \[[^\]]*'\/api\/version'/.test(index) && /path === '\/api\/version'\) return mark\(handleVersion\(env\)\)/.test(index));

// api_staking_abi_check_compares_content. scripts/gen-staking-abi.mjs --check is the guard that
// recompiles the staking source (CI job staking-abi). Run the real script on a stand-in solc that
// returns a given ABI: the ABI the file was generated from matches; a difference of the same
// length (one letter of one name, one nibble of the revision) is red, as is one item fewer; and
// --check never writes the file.
{
  const gen = await load('src/abis/staking.generated.ts');
  const genPath = join(root, 'src/abis/staking.generated.ts');
  const before = readFileSync(genPath);
  const tmp = mkdtempSync(join(tmpdir(), 'staking-abi-check-'));
  try {
    mkdirSync(join(tmp, 'node_modules', 'solc'), { recursive: true });
    mkdirSync(join(tmp, 'staking', 'src'), { recursive: true });
    for (const f of ['BlazePhoenixStaking.sol', 'BlazePhoenixMathLib.sol']) writeFileSync(join(tmp, 'staking', 'src', f), '// stand-in\n');
    writeFileSync(join(tmp, 'node_modules', 'solc', 'package.json'), '{"type":"commonjs","main":"index.js"}');
    writeFileSync(join(tmp, 'node_modules', 'solc', 'index.js'), `const abi = require(process.env.STANDIN_ABI);
module.exports = { version: () => ${JSON.stringify(gen.STAKING_ABI_COMPILER.replace(/^solc /, ''))},
  compile: () => JSON.stringify({ contracts: { 'src/BlazePhoenixStaking.sol': { BlazePhoenixStaking: { abi } } } }) };
`);
    let n = 0;
    const runCheck = (abi, rev = gen.STAKING_ABI_SOURCE_REVISION) => {
      const abiFile = join(tmp, `abi-${n++}.json`);
      writeFileSync(abiFile, JSON.stringify(abi));
      try {
        const out = execFileSync(process.execPath, [join(root, 'scripts/gen-staking-abi.mjs'), join(tmp, 'staking'), '--check'], {
          env: { ...process.env, NODE_MODULES: join(tmp, 'node_modules'), STAKING_REV: rev, STANDIN_ABI: abiFile },
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, out };
      } catch (e) { return { code: e.status, out: String(e.stderr ?? '') }; }
    };
    const abi = JSON.parse(JSON.stringify(gen.STAKING_ABI));
    const same = runCheck(abi);
    check('staking abi --check: the ABI the file was generated from matches (exit 0)', same.code === 0 && /matches/.test(same.out));
    const i = abi.findIndex((x) => x.type === 'function');
    const name = abi[i].name;
    const letter = abi.map((x, k) => (k === i ? { ...x, name: name.slice(0, -1) + (name.endsWith('a') ? 'b' : 'a') } : x));
    check('staking abi --check: one letter of one function name changed (same file length) is red (exit 1)',
      runCheck(letter).code === 1);
    const rev = gen.STAKING_ABI_SOURCE_REVISION;
    check('staking abi --check: the file names another revision (one nibble, same file length) is red (exit 1)',
      runCheck(abi, rev.slice(0, -1) + (rev.endsWith('0') ? '1' : '0')).code === 1);
    check('staking abi --check: one item fewer is red (exit 1)', runCheck(abi.slice(1)).code === 1);
    check('staking abi --check: never writes the generated file', readFileSync(genPath).equals(before));
  } finally {
    if (!readFileSync(genPath).equals(before)) writeFileSync(genPath, before);
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ci_staking_abi_job. The workflow is what runs --check against the staking source, and nothing
// else reads it: a step removed, --check dropped, continue-on-error or an if: would stay green.
// Read as text (no YAML dependency): a job is its 4-space block, a step its 6-space "- " item.
const ciYml = read('.github/workflows/ci.yml');
const ciBlock = (re) => (re.exec(ciYml) ?? [])[1] ?? '';
const ciSteps = (block) => block.split(/^ {6}- /m).slice(1)
  .map((s) => s.split('\n').filter((l, k) => k === 0 || l === '' || /^ {8}/.test(l)).join('\n'));
const ciOn = ciBlock(/^on:\n((?:(?: {2,}.*)?\n)*)/m);
const abiJob = ciBlock(/^ {2}staking-abi:\n((?:(?: {4,}.*)?\n)*)/m);
const abiSteps = ciSteps(abiJob);
check('ci: staking-abi runs on push to main and on every pull request',
  /^ {2}push:\n {4}branches: \[main\]$/m.test(ciOn) && /^ {2}pull_request:/m.test(ciOn));
check('ci: staking-abi runs gen-staking-abi.mjs --check at the repository root, with no if:, continue-on-error or STAKING_REV',
  abiSteps.some((s) => /^run: node scripts\/gen-staking-abi\.mjs staking --check\s*$/m.test(s) && !/working-directory/.test(s))
  && !/^\s*(?:- )?(?:if|continue-on-error):/m.test(abiJob) && !/STAKING_REV/.test(abiJob));
const revStep = abiSteps.find((s) => /^\s*id: rev\s*$/m.test(s)) ?? '';
const stakingCheckout = abiSteps.find((s) => /^\s*repository: blazephoenixxyz-crypto\/Blaze-Phoenix-Staking\s*$/m.test(s)) ?? '';
let revOut = '';
const revTmp = mkdtempSync(join(tmpdir(), 'ci-rev-'));
try {
  writeFileSync(join(revTmp, 'out'), '');
  execFileSync('bash', ['-c', (/^\s*run: (.*)$/m.exec(revStep) ?? [])[1] ?? 'false'],
    { cwd: root, env: { ...process.env, GITHUB_OUTPUT: join(revTmp, 'out') }, stdio: 'ignore' });
  revOut = readFileSync(join(revTmp, 'out'), 'utf8');
} catch { /* red below */ } finally { rmSync(revTmp, { recursive: true, force: true }); }
const namedRev = (/^export const STAKING_ABI_SOURCE_REVISION = '([0-9a-f]{40})' as const;$/m.exec(read('src/abis/staking.generated.ts')) ?? [])[1];
check('ci: staking-abi checks out the staking repository at the revision the generated file names',
  !!namedRev && revOut === `rev=${namedRev}\n`
  && /^\s*ref: \$\{\{ steps\.rev\.outputs\.rev \}\}\s*$/m.test(stakingCheckout) && /^\s*path: staking\s*$/m.test(stakingCheckout));
// ci_token_read_only. The jobs run code from two lockfiles (the API's and the staking checkout's):
// the workflow token is read-only and no checkout leaves it in .git/config.
const ciCode = ciYml.replace(/^\s*#.*$/gm, '');
const checkouts = ciSteps(ciYml.replace(/^ {2}\S.*$/gm, '')).filter((s) => /^\s*uses: actions\/checkout@/m.test(s));
check('ci: the workflow token is read-only (top-level permissions: contents: read; no write anywhere)',
  /^permissions:\n {2}contents: read\n(?! )/m.test(ciCode) && !/write/.test(ciCode));
check('ci: every actions/checkout sets persist-credentials: false',
  checkouts.length > 0 && checkouts.length === (ciCode.match(/uses: actions\/checkout@/g) ?? []).length
  && checkouts.every((s) => /^\s*persist-credentials: false\s*$/m.test(s)));

console.log(failed === 0 ? `✅ ${passed} passed, 0 failed` : `❌ ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
