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
    handleManifest, handleDeployments, handleDiscovery, handleHealth, handleDecode } = await load('worker/quoteApi.ts');
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

  // ── USD value (worker/usd.ts): Quoter netOuts through one Multicall3 call on the caller's node.
  // Each check names, in its comment, the mutant of worker/usd.ts that turns it red.
  {
    const { prepareUsd, decodeUsd: decodeUsdRaw, MULTICALL3, UINT128_MAX } = await load('worker/usd.ts');
    // A throw is a red check of its own (code 'threw'), never a crash that hides which guard broke.
    const decodeUsd = (req, res, hash) => { try { return decodeUsdRaw(req, res, hash); } catch (e) { return { ok: false, code: 'threw', message: String(e?.message ?? e) }; } };
    const { callTool, MCP_TOOLS } = await load('worker/mcp.ts');
    const { parseAbi, decodeFunctionData: dfd, encodeFunctionResult: efr, encodeErrorResult } = await import('viem');
    const MC = parseAbi([
      'struct Call3 { address target; bool allowFailure; bytes callData; }',
      'struct Result { bool success; bytes returnData; }',
      'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
      'function getBlockNumber() view returns (uint256 blockNumber)',
      'function decimals() view returns (uint8)',
    ]);
    const T = '0x00000000000000000000000000000000000000A1';
    const X = (i) => `0x${(0xB0 + i).toString(16).padStart(40, '0')}`;
    const BLOCK = 38_000_000n;
    const ok = (returnData) => ({ success: true, returnData });
    const fail = (returnData = '0x') => ({ success: false, returnData });
    const blockOf = (b = BLOCK) => ok(efr({ abi: MC, functionName: 'getBlockNumber', result: b }));
    const dec = (d) => ok(efr({ abi: MC, functionName: 'decimals', result: d }));
    // A previewPlan answer whose route walks `path` (2+ tokens) and nets `netOut`.
    const pp = (path, amountIn, netOut, hopIns = []) => {
      const hops = path.slice(1).map((to, i) => ({ tokenIn: path[i], tokenOut: to, amountIn: hopIns[i] ?? amountIn, expectedOut: netOut, legs: [leg(1, hopIns[i] ?? amountIn, netOut)] }));
      const route = { hops, totalOut: netOut, singleOut: netOut, singleOutFloor: 0n, expectedImpactBps: 0n, confidenceWad: 0n, estGas: 1n, hasSurplus: false, isV4Bundle: false };
      const pv = { route, grossOut: netOut, protocolFee: 0n, safetyBuffer: 0n, netOut, ironFloor: 0n, userMinOut: 0n, effectiveMinOut: 0n, estGas: 1n, hops: BigInt(hops.length), legs: BigInt(hops.length), topology: 0, bridgeUsed: ZERO, canExecute: netOut > 0n };
      return ok(efr({ abi: QUOTER_ABI, functionName: 'previewPlan', result: [pv, route, false] }));
    };
    const agg = (entries) => efr({ abi: MC, functionName: 'aggregate3', result: entries });
    const callsOf = (body) => dfd({ abi: MC, data: body.call.data }).args[0];
    const A = 2n * ONE;
    const p1 = prepareUsd(8453, null, T, A);
    const r1 = p1.body.request;
    // Parity vector, the same numbers as the SDK test: dT 18, dD 6, A 2e18; direct 5000000;
    // T->WETH 1e15, WETH->USDC(1e18) 3000000000 -> WETH via 3000000 -> value 3000000, "3", unit "1.5".
    const parityEntries = [blockOf(), dec(18), dec(6), pp([T, base.usdc], A, 5_000_000n), pp([T, base.weth], A, 10n ** 15n), pp([base.weth, base.usdc], ONE, 3_000_000_000n)];
    const par = decodeUsd(r1, agg(parityEntries));
    // mutant M-j: min -> max over vias (b < a -> b > a)
    check('usd parity vector: value 3000000, usd "3", unitPrice "1.5", label USD (via USDC), one request',
      par.ok && par.body.usdValue === '3000000' && par.body.usd === '3' && par.body.unitPrice === '1.5'
      && par.body.label === 'USD (via USDC)' && par.body.rpc.requests === 1 && par.body.blockNumber === String(BLOCK));
    // mutant: bps = diff*10000/min instead of /max
    check('usd parity vector: spread {min 3000000, max 5000000, diff 2000000, bps 4000}',
      par.ok && JSON.stringify(par.body.spread) === JSON.stringify({ min: '3000000', max: '5000000', diff: '2000000', bps: '4000' }));
    // mutant: the WETH via scaled by outX*outD without / refX
    check('usd parity vector: WETH via measured at 3000000, scaledFrom 1e18',
      par.ok && par.body.vias[1].status === 'measured' && par.body.vias[1].usd === '3000000' && par.body.vias[1].scaledFrom === String(ONE));
    // mutant: the aggregate3 targets taken from anything but the registry Quoter / Multicall3
    const c1 = callsOf(p1.body);
    check('usd prepare: one aggregate3 to Multicall3 = block, 2 decimals, 3 Quoter previewPlan calls at the registry Quoter',
      p1.body.call.to === MULTICALL3 && c1.length === 6 && c1[0].target === MULTICALL3 && c1.slice(3).every((c) => c.target === DEPLOYMENTS.versions.find((d) => d.version === '1.0.0').chains[8453].quoter)
      && c1.every((c) => c.allowFailure === true) && p1.body.rpcRequest.params[1] === 'latest');
    // agree: both vias equal -> spread bps 0 (mutant: spread only from 3 measured vias)
    const agree = decodeUsd(r1, agg([blockOf(), dec(18), dec(6), pp([T, base.usdc], A, 3_000_000n), pp([T, base.weth], A, 10n ** 15n), pp([base.weth, base.usdc], ONE, 3_000_000_000n)]));
    check('usd agree: two equal vias -> spread bps 0, value 3000000', agree.ok && agree.body.usdValue === '3000000' && agree.body.spread?.bps === '0');
    // one via reverts inside the multicall (mutant: drop the success test -> "undecodable", not the reason)
    const revert = encodeErrorResult({ abi: parseAbi(['error Error(string)']), errorName: 'Error', args: ['no route'] });
    const one = decodeUsd(r1, agg([blockOf(), dec(18), dec(6), fail(revert), pp([T, base.weth], A, 10n ** 15n), pp([base.weth, base.usdc], ONE, 3_000_000_000n)]));
    check('usd one via reverts: not measured with the decoded reason; the value comes from the other via, no spread',
      one.ok && one.body.vias[0].status === 'not measured' && /call reverted: Error\(no route\)/.test(one.body.vias[0].reason)
      && one.body.usdValue === '3000000' && one.body.spread === null);
    // all fail (mutant: no measured via -> 0n instead of null)
    const none = decodeUsd(r1, agg([blockOf(), dec(18), dec(6), fail(), fail(), pp([base.weth, base.usdc], ONE, 3_000_000_000n)]));
    check('usd all vias fail: usdValue null, usd and unitPrice "not measured", never 0',
      none.ok && none.body.usdValue === null && none.body.usd === 'not measured' && none.body.unitPrice === 'not measured' && !JSON.stringify(none.body).includes('"usd":"0"'));
    // empty route and netOut 0 (mutant: drop the netOut === 0 test -> a measured via worth 0)
    const zero = decodeUsd(r1, agg([blockOf(), dec(18), dec(6), pp([T, base.usdc], A, 0n), pp([T, base.weth], A, 10n ** 15n), pp([base.weth, base.usdc], ONE, 0n)]));
    check('usd netOut 0 on every via: not measured (absent is not zero)',
      zero.ok && zero.body.usdValue === null && zero.body.vias.every((v) => v.status === 'not measured' && /netOut is 0/.test(v.reason)));
    const empty = ok(efr({ abi: QUOTER_ABI, functionName: 'previewPlan', result: [{ route: { hops: [], totalOut: 0n, singleOut: 0n, singleOutFloor: 0n, expectedImpactBps: 0n, confidenceWad: 0n, estGas: 0n, hasSurplus: false, isV4Bundle: false }, grossOut: 0n, protocolFee: 0n, safetyBuffer: 0n, netOut: 7n, ironFloor: 0n, userMinOut: 0n, effectiveMinOut: 0n, estGas: 0n, hops: 0n, legs: 0n, topology: 0, bridgeUsed: ZERO, canExecute: false }, { hops: [], totalOut: 0n, singleOut: 0n, singleOutFloor: 0n, expectedImpactBps: 0n, confidenceWad: 0n, estGas: 0n, hasSurplus: false, isV4Bundle: false }, false] }));
    // mutant: drop the hops.length === 0 test (netOut 7 with no route would count)
    const emp = decodeUsd(r1, agg([blockOf(), dec(18), dec(6), empty, fail(), fail()]));
    check('usd empty route: not measured even when netOut is non-zero', emp.ok && emp.body.vias[0].reason === 'empty route' && emp.body.usdValue === null);
    // mutant: drop the routeIsConsistent test (a route for other tokens would be priced)
    const wrong = decodeUsd(r1, agg([blockOf(), dec(18), dec(6), pp([base.weth, base.usdc], A, 5_000_000n), fail(), fail()]));
    check('usd a route that does not connect the leg tokens is not measured', wrong.ok && /does not connect/.test(wrong.body.vias[0].reason) && wrong.body.usdValue === null);
    // A = 0 and A > uint128 (mutant: drop the upper bound)
    check('usd amount 0 and 2^128 refused (bad_amount) at prepare and at decode, never a value of 0',
      [0n, UINT128_MAX + 1n].every((a) => { const p = prepareUsd(8453, null, T, a); const d = decodeUsd({ ...r1, amountIn: a.toString() }, agg(parityEntries)); return !p.ok && p.code === 'bad_amount' && !d.ok && d.code === 'bad_amount'; })
      && prepareUsd(8453, null, T, UINT128_MAX).ok);
    // T = USDC: identity, no Quoter call (mutant: drop the identity branch -> a USDC->USDC via)
    const pU = prepareUsd(8453, null, base.usdc, 10_000_000n);
    const idt = decodeUsd(pU.body.request, agg([blockOf(), dec(6)]));
    const idtNoDec = decodeUsd(pU.body.request, agg([blockOf(), fail()]));
    // mutant: identity unitPrice hard-coded "1" (or usd formatted without the measured decimals)
    check('usd T = USDC unreadable decimals: usd and unitPrice both "not measured", never unitPrice "1" alone',
      idtNoDec.ok && idtNoDec.body.usdValue === '10000000' && idtNoDec.body.usd === 'not measured' && idtNoDec.body.unitPrice === 'not measured');
    check('usd T = USDC: one aggregate3 = block + decimals(USDC), no Quoter call; identity via, usd "10", unitPrice "1", block read',
      callsOf(pU.body).length === 2 && callsOf(pU.body)[1].target === base.usdc && idt.ok && idt.body.blockNumber === String(BLOCK) && idt.body.dollarDecimals === 6 && idt.body.vias.length === 1 && idt.body.vias[0].status === 'identity'
      && idt.body.usdValue === '10000000' && idt.body.usd === '10' && idt.body.unitPrice === '1' && idt.body.spread === null);
    // T = WETH: no via WETH (mutant: drop the T == WETH test -> a WETH->WETH leg)
    const pW = prepareUsd(8453, null, base.weth, ONE);
    check('usd T = WETH: the direct via only (one Quoter call)', callsOf(pW.body).length === 4 && pW.body.request.vias.length === 1);
    // decimals failure (mutant: a failed decimals read defaulting to 18)
    const nodec = decodeUsd(r1, agg([blockOf(), fail(), dec(6), ...parityEntries.slice(3)]));
    check('usd decimals of the token unreadable: tokenDecimals null, unitPrice "not measured", value still measured',
      nodec.ok && nodec.body.tokenDecimals === null && nodec.body.unitPrice === 'not measured' && nodec.body.usdValue === '3000000' && nodec.body.usd === '3');
    // Route-discovered X: direct T -> X0 -> USDC; stage 1, run at block hash HASH, answers with the
    // second call pinned at that hash (EIP-1898, requireCanonical) and at its block number.
    const HASH = `0x${'ab'.repeat(32)}`;
    const discEntries = [blockOf(), dec(18), dec(6), pp([T, X(0), base.usdc], A, 5_000_000n, [A, 40n * ONE]), pp([T, base.weth], A, 10n ** 15n), pp([base.weth, base.usdc], ONE, 3_000_000_000n)];
    const disc = decodeUsd(r1, agg(discEntries), HASH);
    const nx = disc.ok && disc.body.next;
    const pinOf = (h) => JSON.stringify({ blockHash: h, requireCanonical: true });
    // mutant: rpcRequest at 'latest' or at the block number instead of the stage-1 block hash
    // (M-a: stage 2 pinned by number; M-c: requireCanonical false; M-f: decode ignores usd.blockHash)
    check('usd route-discovered X: stage 1 returns `next` with 3 vias, pinned at the stage-1 block hash with requireCanonical, ref = the X spent by the route',
      disc.ok && disc.body.complete === false && nx.request.vias.length === 3 && JSON.stringify(nx.rpcRequest.params[1]) === pinOf(HASH)
      && nx.request.blockHash === HASH && nx.request.blockNumber === String(BLOCK)
      && nx.request.vias[2].path[1].toLowerCase() === X(0).toLowerCase() && nx.request.vias[2].ref === String(40n * ONE) && callsOf(nx).length === 3 + 1 + 2 + 2);
    const st2 = [blockOf(), dec(18), dec(6), pp([T, X(0), base.usdc], A, 5_000_000n, [A, 40n * ONE]), pp([T, base.weth], A, 10n ** 15n), pp([base.weth, base.usdc], ONE, 3_000_000_000n), pp([T, X(0)], A, 40n * ONE), pp([X(0), base.usdc], 40n * ONE, 4_000_000n)];
    const fin = decodeUsd(nx.request, agg(st2));
    check('usd stage 2: three vias from one block, rpc.requests 2, value = min (3000000), X via 4000000',
      fin.ok && fin.body.complete && fin.body.rpc.requests === 2 && fin.body.vias.length === 3 && fin.body.vias[2].usd === '4000000' && fin.body.usdValue === '3000000');
    // mutant: drop the pinned-block check
    const stale = decodeUsd(nx.request, agg([blockOf(BLOCK + 1n), ...st2.slice(1)]));
    check('usd stage 2 from another block is refused (result_mismatch), never mixed blocks', !stale.ok && stale.code === 'result_mismatch');
    // caller cannot add a via that is an anchor (mutant: drop the seen-set test)
    const forged = { ...nx.request, vias: [...nx.request.vias.slice(0, 2), { path: [T, base.weth, base.usdc], ref: '1' }] };
    check('usd stage 2 refuses a discovered via through WETH or the dollar token', decodeUsd(forged, agg(st2)).code === 'bad_request');
    // cap 8 (mutant: room = MAX_VIAS instead of MAX_VIAS - vias already there)
    const many = [T, ...Array.from({ length: 9 }, (_, i) => X(i)), base.usdc];
    const cap = decodeUsd(r1, agg([blockOf(), dec(18), dec(6), pp(many, A, 5_000_000n), pp([T, base.weth], A, 10n ** 15n), pp([base.weth, base.usdc], ONE, 3_000_000_000n)]), HASH);
    check('usd cap: a route crossing 9 tokens gives 8 vias in all (direct, WETH, 6 discovered)', cap.ok && cap.body.next.request.vias.length === 8);
    // entry count mismatch (mutant: drop the length check)
    check('usd result with a missing entry is refused', decodeUsd(r1, agg(parityEntries.slice(0, 5))).code === 'result_mismatch');
    // a block entry that succeeded with bytes that are not a uint256 (mutant: decode the block without the try)
    check('usd result whose block entry is unreadable is refused (result_mismatch), no throw', decodeUsd(r1, agg([ok('0x'), ...parityEntries.slice(1)])).code === 'result_mismatch');
    // Robinhood: the dollar token is USDG and the label says so (mutant: one label for every chain)
    const rh = DEPLOYMENTS.versions.some((d) => d.chains[4663] && d.chains[4663].quoter !== ZERO);
    check('usd label: USD (via USDG) on Robinhood Chain', !rh || prepareUsd(4663, null, T, A).body.label === 'USD (via USDG)');

    // The block on Arbitrum chains. A node at tag `tag`: on Arbitrum and Robinhood Chain (Orbit)
    // block.number, so Multicall3.getBlockNumber, is the L1 block and ArbSys(0x64).arbBlockNumber()
    // is the block the tag names (measured live 11-20: Arbitrum tag 525778791 -> getBlockNumber
    // 26452919). Elsewhere 0x64 has no code: success with no data. `rest` answers calls 1..n.
    const ARBSYS_ADDR = '0x0000000000000000000000000000000000000064';
    const L1_BLOCK = 26_452_919n;
    const nodeAt = (chainId, body, tag, rest) => {
      const arb = [42161, 4663].includes(chainId);
      return agg(callsOf(body).map((c, i) => {
        if (c.target.toLowerCase() === ARBSYS_ADDR) return arb ? blockOf(tag) : ok('0x');
        if (c.target.toLowerCase() === MULTICALL3.toLowerCase()) return blockOf(arb ? L1_BLOCK : tag);
        return rest[i - 1];
      }));
    };
    // Arbitrum, two stages (mutant: Multicall3.getBlockNumber on every chain -> stage 1 reports the
    // L1 block 26452919 and pins stage 2 to it)
    {
      const aU = CHAINS[42161].usdc, aW = CHAINS[42161].weth, TAG = 525_778_791n;
      const pa = prepareUsd(42161, null, T, A);
      const s1 = pa.ok ? decodeUsd(pa.body.request, nodeAt(42161, pa.body, TAG, [dec(18), dec(6),
        pp([T, X(0), aU], A, 5_000_000n, [A, 40n * ONE]), pp([T, aW], A, 10n ** 15n), pp([aW, aU], ONE, 3_000_000_000n)]), HASH) : pa;
      const nxa = s1.ok ? s1.body.next : undefined;
      const s2 = nxa ? decodeUsd(nxa.request, nodeAt(42161, nxa, TAG, [dec(18), dec(6),
        pp([T, X(0), aU], A, 5_000_000n, [A, 40n * ONE]), pp([T, aW], A, 10n ** 15n), pp([aW, aU], ONE, 3_000_000_000n),
        pp([T, X(0)], A, 40n * ONE), pp([X(0), aU], 40n * ONE, 4_000_000n)])) : s1;
      check('usd Arbitrum: the block is ArbSys.arbBlockNumber (the block RPC tags count), not the L1 block.number; stage 2 is pinned to it and completes there',
        pa.ok && callsOf(pa.body)[0].target.toLowerCase() === ARBSYS_ADDR && callsOf(pa.body)[0].callData === '0xa3b1b31d'
        && s1.ok && s1.body.blockNumber === String(TAG) && nxa?.request.blockNumber === String(TAG) && JSON.stringify(nxa?.rpcRequest.params[1]) === pinOf(HASH)
        && s2.ok && s2.body.complete && s2.body.blockNumber === String(TAG) && s2.body.usdValue === '3000000');
    }
    // Robinhood Chain (Orbit) at a given block (mutant M-i: 4663 left out of ARBSYS_BLOCK_CHAINS)
    if (rh) {
      const rU = CHAINS[4663].usdc;
      const pr = prepareUsd(4663, null, T, A);
      const vr = decodeUsd(pr.body.request, nodeAt(4663, pr.body, 0x200n, [dec(18), dec(6), pp([T, rU], A, 2_000_000n), fail(), fail()]));
      check('usd Robinhood Chain: the block is read from ArbSys, the reported block is the tag block',
        callsOf(pr.body)[0].target.toLowerCase() === ARBSYS_ADDR && vr.ok && vr.body.blockNumber === '512' && vr.body.usdValue === '2000000');
    }
    // Base keeps Multicall3.getBlockNumber; 0x64 has no code there (mutant: ArbSys on every chain)
    {
      const vb = decodeUsd(r1, nodeAt(8453, p1.body, BLOCK, parityEntries.slice(1)));
      check('usd Base: the block is Multicall3.getBlockNumber, not ArbSys',
        callsOf(p1.body)[0].target === MULTICALL3 && vb.ok && vb.body.blockNumber === String(BLOCK) && vb.body.usdValue === '3000000');
    }
    // ArbSys answers no data (mutant: the block decode without the try, or an error that names
    // Multicall3 on Arbitrum)
    {
      const pa = prepareUsd(42161, null, T, A);
      const na = decodeUsd(pa.body.request, agg([ok('0x'), dec(18), dec(6), fail(), fail(), fail()]));
      check('usd Arbitrum: ArbSys answers no data -> result_mismatch 422 naming ArbSys.arbBlockNumber, never a value at an unknown block',
        !na.ok && na.code === 'result_mismatch' && na.status === 422 && /ArbSys\.arbBlockNumber/.test(na.message));
    }

    // ── One block hash for both stages (EIP-1898). A pin by block NUMBER reads whatever block holds
    // that height when stage 2 runs: after a reorg at the same height it is another block, and the
    // height check still passes. A mock node: `canon` maps height -> fork of the canonical block,
    // `head` is what 'latest' names, `blockHash` is 'honour' | 'ignore' (answers at head) | 'reject'.
    // `plans(fork)` answers calls 1..n of a body. Hashes: fork byte + height.
    const hashOf = (n, fork = 0) => `0x${fork.toString(16).padStart(2, '0')}${n.toString(16).padStart(62, '0')}`;
    const mockNode = (head, plans, blockHash = 'honour') => {
      const node = { head, canon: new Map([[head, 0]]), blockHash, sent: [] };
      node.run = (prepared) => {
        const tag = prepared.rpcRequest.params[1];
        node.sent.push(tag);
        let n;
        if (tag === 'latest') n = node.head;
        else if (typeof tag === 'string') n = BigInt(tag);
        else {
          if (node.blockHash === 'reject') throw new Error('invalid argument 1: hex string expected');
          if (node.blockHash === 'ignore') n = node.head;
          else {
            const hit = [...node.canon].find(([h, f]) => hashOf(h, f) === tag.blockHash);
            if (!hit) throw new Error('header not found'); // replaced by a reorg: the node no longer serves it as canonical
            n = hit[0];
          }
        }
        const f = node.canon.get(n) ?? 0;
        return agg(callsOf(prepared).map((c, i) => (i === 0 ? blockOf(n) : plans(f)[i - 1])));
      };
      node.advance = () => { node.head += 1n; node.canon.set(node.head, 0); };
      node.reorg = () => { for (const h of node.canon.keys()) node.canon.set(h, node.canon.get(h) + 1); };
      return node;
    };
    // Fork 0: the direct route crosses X0, X0 via 4000000, value 3000000. Fork 1 (the block that
    // replaced it at the same height): X0 -> USDC answers 1000000, so a mixed read would report less.
    const plansAt = (f) => [dec(18), dec(6), pp([T, X(0), base.usdc], A, 5_000_000n, [A, 40n * ONE]), pp([T, base.weth], A, 10n ** 15n),
      pp([base.weth, base.usdc], ONE, 3_000_000_000n), pp([T, X(0)], A, 40n * ONE), pp([X(0), base.usdc], 40n * ONE, f === 0 ? 4_000_000n : 1_000_000n)];
    const threw = (fn) => { try { fn(); return false; } catch { return true; } };
    {
      // prepare: the optional blockHash pins stage 1 (mutant: blockHash accepted but stage 1 left at 'latest')
      const h0 = hashOf(BLOCK);
      const ph = prepareUsd(8453, null, T, A, h0);
      check('usd prepare with blockHash: stage 1 pinned at {blockHash, requireCanonical: true}, request echoes blockHash',
        ph.ok && JSON.stringify(ph.body.rpcRequest.params[1]) === pinOf(h0) && ph.body.request.blockHash === h0);
      check('usd prepare without blockHash: stage 1 at latest, no blockHash in the request',
        p1.ok && p1.body.rpcRequest.params[1] === 'latest' && !('blockHash' in p1.body.request));
      // mutant: drop the blockHash shape check
      const badH = prepareUsd(8453, null, T, A, '0x1234');
      check('usd prepare with a blockHash that is not 32 bytes: 400 bad_request', !badH.ok && badH.code === 'bad_request' && badH.status === 400);

      // reorg between the two stages (mutant M-a: stage 2 pinned by number -> the replacing block answers, mixed value)
      const n = mockNode(BLOCK, plansAt);
      const s1 = decodeUsd(ph.body.request, n.run(ph.body), h0);
      const nxr = s1.ok ? s1.body.next : undefined;
      n.reorg();
      let r2;
      const lost = !!nxr && threw(() => { r2 = decodeUsd(nxr.request, n.run(nxr), h0); });
      check('usd reorg between stage 1 and stage 2: stage 2 is pinned at the stage-1 hash, the node refuses it, no value from mixed blocks',
        !!nxr && JSON.stringify(nxr.rpcRequest.params[1]) === pinOf(h0) && lost && r2 === undefined);
      // the same flow without a reorg completes at that block, value 3000000 (mutant: ref/min regressions)
      const n0 = mockNode(BLOCK, plansAt);
      const a1 = decodeUsd(ph.body.request, n0.run(ph.body), h0);
      const a2 = a1.ok && a1.body.next ? decodeUsd(a1.body.next.request, n0.run(a1.body.next), h0) : a1;
      check('usd two stages at one hash, no reorg: complete, value 3000000, rpc.requests 2, both calls pinned at the hash',
        a2.ok && a2.body.complete && a2.body.usdValue === '3000000' && a2.body.rpc.requests === 2 && n0.sent.every((t) => JSON.stringify(t) === pinOf(h0)));

      // missing hash (mutant M-b: fall back to a number pin -> `next` at the block number;
      // mutant M-e: "not measured" with usdValue '0')
      const nh = decodeUsd(r1, agg(discEntries));
      check('usd stage 1 decoded without blockHash and the route needs stage 2: "not measured" result (ok, complete), no `next`, no number pin, never 0',
        nh.ok && nh.body.complete === true && !('next' in nh.body) && nh.body.usdValue === null && nh.body.usd === 'not measured'
        && nh.body.unitPrice === 'not measured' && Array.isArray(nh.body.vias) && nh.body.vias.length === 0 && nh.body.rpc.requests === 1
        && typeof nh.body.reason === 'string' && /blockHash/.test(nh.body.reason));
      // a single-stage value needs no hash: one call is one block (mutant: not measured on every hashless decode)
      check('usd stage 1 without blockHash and no discovered via: still measured (one call is one block)', par.ok && par.body.usdValue === '3000000');
      // a stage-2 request without blockHash (pinned by number) is not measured (mutant M-h: decode it as before)
      const legacy = { ...nx.request }; delete legacy.blockHash;
      const lg = decodeUsd(legacy, agg(st2));
      check('usd stage 2 request without blockHash: "not measured" result, never a value read at a number pin',
        lg.ok && lg.body.complete === true && lg.body.usdValue === null && lg.body.usd === 'not measured' && lg.body.vias.length === 0);
      // stage-2 blockHash malformed (mutant: drop the stage-2 hash shape check)
      check('usd stage 2 request with a malformed blockHash: 400 bad_request', decodeUsd({ ...nx.request, blockHash: '0xzz' }, agg(st2)).code === 'bad_request');
      // request.blockHash and usd.blockHash disagree (mutant M-g: one silently wins)
      const clash = decodeUsd(ph.body.request, agg(discEntries), hashOf(BLOCK, 9));
      check('usd decode: usd.blockHash differs from request.blockHash -> 400 bad_request', !clash.ok && clash.code === 'bad_request');
      // request.blockHash alone is the echo of the prepared pin (mutant: only usd.blockHash read)
      const echo = decodeUsd(ph.body.request, agg(discEntries));
      check('usd decode: the blockHash echoed in the prepared request pins stage 2', echo.ok && JSON.stringify(echo.body.next?.rpcRequest.params[1]) === pinOf(h0));

      // header of another block: the caller read the header of BLOCK, ran stage 1 at latest = BLOCK+1
      // (mutant M-d: drop the stage-2 block check -> a value from two blocks)
      const nm = mockNode(BLOCK, plansAt);
      nm.advance();
      const m1 = decodeUsd(r1, nm.run(p1.body), hashOf(BLOCK));
      const m2 = m1.ok && m1.body.next ? decodeUsd(m1.body.next.request, nm.run(m1.body.next)) : m1;
      check('usd blockHash of another block than stage 1 ran at: stage 2 reads that block, result_mismatch 422, no value',
        m1.ok && m1.body.next?.request.blockNumber === String(BLOCK + 1n) && !m2.ok && m2.code === 'result_mismatch' && m2.status === 422);

      // node without blockHash support: ignores the object and answers at its head, or rejects it
      const ni = mockNode(BLOCK, plansAt, 'ignore');
      const i1 = decodeUsd(ph.body.request, ni.run(ph.body), h0);
      ni.advance();
      const i2 = i1.ok && i1.body.next ? decodeUsd(i1.body.next.request, ni.run(i1.body.next)) : i1;
      check('usd node that ignores blockHash and moved on: stage 2 refused (result_mismatch), no value from two blocks',
        i1.ok && !!i1.body.next && !i2.ok && i2.code === 'result_mismatch');
      const nr = mockNode(BLOCK, plansAt, 'reject');
      const ok1 = decodeUsd(r1, nr.run(p1.body));
      check('usd node that rejects blockHash: stage 1 at latest decodes to "not measured" without a hash, stage 2 is never pinned by number',
        threw(() => nr.run(ph.body)) && ok1.ok && ok1.body.usd === 'not measured' && !('next' in ok1.body) && nr.sent.every((t) => typeof t !== 'string' || t === 'latest'));
    }

    // Wiring: REST prepare (usd=1 only), decode { usd }, MCP tools.
    const sp = (q) => new URLSearchParams(q);
    const plain = prepareFromParams(sp('chain=base&in=WETH&out=USDC&amountIn=1000000000000000000'));
    const withUsd = prepareFromParams(sp('chain=base&in=WETH&out=USDC&amountIn=1000000000000000000&usd=1'));
    check('usd REST: prepare without usd=1 is unchanged (no usd block, request.usd absent)', plain.ok && !('usd' in plain.body) && !('usd' in plain.body.request));
    check('usd REST: prepare with usd=1 adds usd.in (Multicall3 call for the input) and request.usd = true',
      withUsd.ok && withUsd.body.usd.in.call.to === MULTICALL3 && withUsd.body.request.usd === true && withUsd.body.usd.in.request.token === base.weth);
    const tool = MCP_TOOLS.find((t) => t.name === 'decode_usd_value');
    const viaMcp = callTool('decode_usd_value', { request: r1, result: agg(parityEntries) });
    check('usd MCP: decode_usd_value is listed and returns the parity value', !!tool && !viaMcp.isError && viaMcp.body.usdValue === '3000000');
    const prepMcp = callTool('prepare_quote', { chain: 'base', in: 'WETH', out: 'USDC', amountIn: '1000000000000000000', usd: true });
    const qpv = preview(oneHop([3_000_000_000n], 0n), pack(oneHop([3_000_000_000n], 0n), down));
    const dq = callTool('decode_quote', { request: prepMcp.body.request, result: encodeFunctionResult({ abi: QUOTER_ABI, functionName: 'previewPlan', result: [qpv, qpv.route, false] }) });
    check('usd MCP: prepare_quote usd:true -> decode_quote carries usdOut valuing tokenOut at amountOut',
      !prepMcp.isError && !dq.isError && dq.body.usdOut?.request?.token === base.usdc && dq.body.usdOut.request.amountIn === dq.body.amountOut);
    // blockHash on every surface (mutant: REST/MCP drop the blockHash)
    const hh = `0x${'cd'.repeat(32)}`;
    const withH = prepareFromParams(sp(`chain=base&in=WETH&out=USDC&amountIn=1000000000000000000&usd=1&blockHash=${hh}`));
    check('usd REST: prepare usd=1&blockHash pins usd.in at that hash', withH.ok && JSON.stringify(withH.body.usd.in.rpcRequest.params[1]) === pinOf(hh));
    const badRest = prepareFromParams(sp('chain=base&in=WETH&out=USDC&amountIn=1000000000000000000&usd=1&blockHash=0x12'));
    check('usd REST: a malformed blockHash -> 400 bad_request', !badRest.ok && badRest.code === 'bad_request');
    const prepH = callTool('prepare_quote', { chain: 'base', in: 'WETH', out: 'USDC', amountIn: '1000000000000000000', usd: true, blockHash: hh });
    check('usd MCP: prepare_quote blockHash pins usd.in', !prepH.isError && JSON.stringify(prepH.body.usd?.in?.rpcRequest?.params[1]) === pinOf(hh));
    const decH = callTool('decode_usd_value', { request: r1, result: agg(discEntries), blockHash: hh });
    check('usd MCP: decode_usd_value blockHash pins `next` at that hash', !decH.isError && JSON.stringify(decH.body.next?.rpcRequest.params[1]) === pinOf(hh));
    const decTool = MCP_TOOLS.find((t) => t.name === 'decode_usd_value');
    check('usd MCP: decode_usd_value declares blockHash', !!decTool?.inputSchema?.properties?.blockHash);
    const httpH = await handleDecode(new Request('https://blazephoenix.xyz/api/quote/decode', { method: 'POST', body: JSON.stringify({ usd: { request: r1, result: agg(discEntries), blockHash: hh } }) }));
    const httpB = await httpH.json();
    check('usd REST: decode { usd: { blockHash } } pins `next` at that hash', httpH.status === 200 && JSON.stringify(httpB.next?.rpcRequest.params[1]) === pinOf(hh));
    // ── CodeRabbit review of 46f56ba. Each check names the mutant of the fix that turns it red.
    // chainId: a JSON object whose toString is null makes Number() throw (mutant M-k: drop the primitive check -> 'threw')
    const objChain = decodeUsd({ ...r1, chainId: { toString: null } }, agg(parityEntries));
    check('usd decode: an object chainId (null toString) -> bad_chain, no throw', !objChain.ok && objChain.code === 'bad_chain');
    const objHttp = await handleDecode(new Request('https://blazephoenix.xyz/api/quote/decode', { method: 'POST', body: JSON.stringify({ usd: { request: { ...r1, chainId: { toString: null } }, result: agg(parityEntries) } }) }));
    check('usd REST: an object chainId -> 400 bad_chain', objHttp.status === 400 && (await objHttp.json()).code === 'bad_chain');
    check('usd decode: chainId as the number prepare wrote and as a decimal string still decode',
      typeof r1.chainId === 'number' && decodeUsd(r1, agg(parityEntries)).ok && decodeUsd({ ...r1, chainId: '8453' }, agg(parityEntries)).ok);
    // Spend bound (mutant M-l: drop the overspends test in measureLeg): a leg route that spends more than the leg amount
    // is not this leg's answer, so it is "not measured", never valued as the requested amount.
    const over = decodeUsd(r1, agg([blockOf(), dec(18), dec(6), pp([T, base.usdc], 2n * A, 9_000_000n), pp([T, base.weth], A, 10n ** 15n), pp([base.weth, base.usdc], ONE, 3_000_000_000n)]));
    check('usd direct leg spending 2A for a request of A: not measured (spends more), value from the WETH via',
      over.ok && over.body.vias[0].status === 'not measured' && /spends more/.test(over.body.vias[0].reason) && over.body.usdValue === '3000000');
    const overRef = decodeUsd(r1, agg([blockOf(), dec(18), dec(6), pp([T, base.usdc], A, 5_000_000n), pp([T, base.weth], A, 10n ** 15n), pp([base.weth, base.usdc], ONE + 1n, 3_000_000_000n)]));
    check('usd X -> dollar leg spending refX + 1 wei: that via not measured, value from the direct via',
      overRef.ok && overRef.body.vias[1].status === 'not measured' && /spends more/.test(overRef.body.vias[1].reason) && overRef.body.usdValue === '5000000');
    const partial = decodeUsd(r1, agg([blockOf(), dec(18), dec(6), pp([T, base.usdc], A, 5_000_000n, [A - 1n]), pp([T, base.weth], A, 10n ** 15n), pp([base.weth, base.usdc], ONE, 3_000_000_000n)]));
    check('usd partial fill (hop 0 commits A - 1 wei) is still measured', partial.ok && partial.body.vias[0].status === 'measured' && partial.body.usdValue === '3000000');
    // Stage 2 re-reads the direct route at the pinned block; it must cross the tokens stage 1 found with the same refs
    // (mutant M-m: drop the stage-2 route check; M-n: compare the tokens but not the refs).
    const otherX = [blockOf(), ...st2.slice(1, 3), pp([T, X(1), base.usdc], A, 5_000_000n, [A, 40n * ONE]), ...st2.slice(4)];
    const mixX = decodeUsd(nx.request, agg(otherX));
    check('usd stage 2 whose direct route crosses another token than stage 1 found -> result_mismatch 422, never a mixed value',
      !mixX.ok && mixX.code === 'result_mismatch' && mixX.status === 422);
    const otherRef = [blockOf(), ...st2.slice(1, 3), pp([T, X(0), base.usdc], A, 5_000_000n, [A, 40n * ONE + 1n]), ...st2.slice(4)];
    const mixRef = decodeUsd(nx.request, agg(otherRef));
    check('usd stage 2 whose direct route moves another amount of X (ref + 1 wei) -> result_mismatch', !mixRef.ok && mixRef.code === 'result_mismatch');
    const goneDirect = decodeUsd(nx.request, agg([blockOf(), ...st2.slice(1, 3), fail(), ...st2.slice(4)]));
    check('usd stage 2 whose direct route reverts (stage 1 measured it) -> result_mismatch', !goneDirect.ok && goneDirect.code === 'result_mismatch');
    // OpenAPI (mutants M-o: drop required on usd; M-p: 200 declares the quote schema only)
    const { OPENAPI } = await load('worker/openapi.ts');
    const dec0 = OPENAPI.paths['/api/quote/decode'].post;
    const usdIn = dec0.requestBody.content['application/json'].schema.properties.usd;
    check('openapi: decode `usd` requires request and result, blockHash optional',
      JSON.stringify(usdIn.required) === '["request","result"]' && !!usdIn.properties.blockHash);
    const variants = dec0.responses['200'].content['application/json'].schema.oneOf ?? [];
    const usdVar = variants.find((v) => JSON.stringify(v.properties?.mode?.enum) === '["usd"]');
    const quoteVar = variants.find((v) => JSON.stringify(v.properties?.mode?.enum) === '["preview","exact"]');
    const declares = (v, body) => !!v && Object.keys(body).every((k) => k in v.properties);
    const nm = decodeUsd(r1, agg(discEntries));
    check('openapi: decode 200 has a USD variant declaring every key of a complete value, a `next` answer and a "not measured" one',
      declares(usdVar, fin.body) && declares(usdVar, disc.body) && nm.ok && nm.body.usd === 'not measured' && declares(usdVar, nm.body));
    check('openapi: decode 200 quote variant declares usd and usdOut', !!quoteVar && 'usd' in quoteVar.properties && 'usdOut' in quoteVar.properties);
    // Docs (mutant: the old wording back)
    const llmsTxt = read('llms.txt');
    check('docs: llms.txt counts legs per via, not hops', !/at most 2 hops each/.test(llmsTxt) && /at most 2 legs each/.test(llmsTxt));
    check('docs: llms.txt calls a via through X a scaled estimate, not the output received',
      !/net output actually received/.test(llmsTxt) && /scaled estimate/.test(llmsTxt));
    const usdDesc = MCP_TOOLS.find((t) => t.name === 'decode_usd_value').description;
    check('MCP: decode_usd_value says prepare_quote blockHash pins usd.in only and usdOut must be pinned by the caller',
      /pins usd\.in only/.test(usdDesc) && /usdOut of decode_quote is prepared at latest[^.]*blockHash/.test(usdDesc));
    const discNote = (await handleDiscovery().json()).endpoints.usdValue.note;
    check('discovery: usdValue note shows prepare with blockHash, the hash-pinned call, and a fresh hash after a reorg',
      /&blockHash=/.test(discNote) && /hash-pinned usd\.in\.rpcRequest/.test(discNote) && /prepare again with a fresh hash/.test(discNote));
    const dq0 = callTool('decode_quote', { request: plain.body.request, result: encodeFunctionResult({ abi: QUOTER_ABI, functionName: 'previewPlan', result: [qpv, qpv.route, false] }) });
    check('usd MCP: decode_quote without request.usd has no usdOut', !dq0.isError && !('usdOut' in dq0.body));
  }
  // ── Token finder (worker/findToken.ts): unverified proposals from the SDK's index lookups, no chain
  // read, no RPC taken. Each check names, in its comment, the mutant of worker/findToken.ts that turns it red.
  {
    const { handleFindToken } = await load('worker/findToken.ts');
    const { findToken: sdkFindToken, WARNINGS } = await import('@blazephoenix/sdk/find');
    const A = '0x00000000000000000000000000000000000000a1';
    const B = '0x00000000000000000000000000000000000000b2';
    const WETH_BASE = '0x4200000000000000000000000000000000000006';
    const answer = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    /** Index stub: CoinGecko proposes A, Dexscreener proposes A and B on Base (and a WETH quote token that does not match). */
    const indexes = (opts = {}) => {
      const seen = [];
      const fn = async (input) => {
        const u = String(input instanceof Request ? input.url : input);
        seen.push(u);
        if (u.startsWith('https://api.coingecko.com/api/v3/search')) return answer({ coins: [{ id: 'pepe', symbol: 'PEPE', name: 'Pepe' }] });
        if (u.startsWith('https://api.coingecko.com/api/v3/coins/pepe')) return answer({ platforms: { base: A } });
        if (u.startsWith('https://api.dexscreener.com/latest/dex/search')) {
          if (opts.dexDown) return answer({ error: 'down' }, 500);
          return answer({ pairs: [
            { chainId: 'base', baseToken: { address: B, symbol: 'PEPE', name: 'Pepe' }, quoteToken: { address: WETH_BASE, symbol: 'WETH', name: 'Wrapped Ether' } },
            { chainId: 'base', baseToken: { address: A, symbol: 'PEPE', name: 'Pepe' }, quoteToken: { address: WETH_BASE, symbol: 'WETH', name: 'Wrapped Ether' } },
          ] });
        }
        return answer({ error: 'unexpected' }, 599);
      };
      return { fn, seen };
    };
    // Any request outside the index stub (a node, a host the caller named) lands here.
    const realFetch = globalThis.fetch;
    const stray = [];
    globalThis.fetch = async (input) => { stray.push(String(input instanceof Request ? input.url : input)); return answer({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'stub' } }); };
    try {
      const run = async (qs, opts) => {
        const ix = indexes(opts);
        const res = await handleFindToken(new URL(`https://blazephoenix.xyz/api/token/find?${qs}`), { findToken: sdkFindToken, fetch: ix.fn });
        return { res, body: await res.json(), seen: ix.seen };
      };
      const ok = await run('chain=base&query=PEPE');
      const byAddr = new Map((ok.body.candidates ?? []).map((c) => [c.address.toLowerCase(), c]));
      // mutant: candidates mapped without `sources` (or proposals merged per index) -> red
      check('find: 200 unverified proposals, A from both indexes and B from Dexscreener, chainId on each',
        ok.res.status === 200 && ok.body.status === 'unverified proposals' && byAddr.size === 2
        && JSON.stringify(byAddr.get(A)?.sources?.slice().sort()) === '["coingecko","dexscreener"]'
        && JSON.stringify(byAddr.get(B)?.sources) === '["dexscreener"]'
        && (ok.body.candidates ?? []).every((c) => c.chainId === 8453));
      // mutant: candidates returned as the SDK's (`...c`: rank, label, depth, liquidity) -> red
      check('find: a candidate carries address, chainId and sources only (no rank, label, depth, liquidity)',
        (ok.body.candidates ?? []).every((c) => JSON.stringify(Object.keys(c).sort()) === '["address","chainId","sources"]'));
      // mutant: WARNINGS.mostLiquid or WARNINGS.trust added to the warnings -> red
      check('find: no "most liquid", no ranking and no claim of an on-chain read in the answer',
        !/most liquid|"rank"|read on your RPC\./i.test(JSON.stringify(ok.body)));
      // mutant: proposed = r.candidates.length - r.omitted or 0; drop WARNINGS.notSafety -> red
      check('find: warnings are exactly the ticker warning with N = 2 and liquidity is not safety',
        JSON.stringify(ok.body.warnings) === JSON.stringify([WARNINGS.dyor(2), WARNINGS.notSafety])
        && ok.body.warnings[0] === '2 tokens use this ticker; impostors copy tickers; do your own research.'
        && /^Liquidity is not safety/.test(ok.body.warnings[1]));
      // mutant: `verify` dropped, or it names neither the SDK findToken nor the MCP find_token -> red
      check('find: verify points to findToken in @blazephoenix/sdk/find and the local MCP find_token',
        /findToken/.test(ok.body.verify?.sdk ?? '') && /@blazephoenix\/sdk\/find/.test(ok.body.verify?.sdk ?? '')
        && /find_token/.test(ok.body.verify?.mcp ?? ''));
      // mutant: reader: NO_READ dropped (the SDK then wants an rpc -> 400) or any chain read wired in -> red
      check('find: only the two index hosts are fetched, nothing reaches any other host',
        ok.seen.length > 0 && ok.seen.every((u) => /^https:\/\/api\.(coingecko|dexscreener)\.com\//.test(u)) && stray.length === 0);
      // mutant: `sources: 'centralized'` dropped from the findToken call (SDK >= 1.8.0 then defaults to its
      // on-chain index, which wants an rpc -> 400 bad_request) or `measured` dropped -> red
      const calls = [];
      const spy = async (req) => { calls.push(req); return sdkFindToken(req); };
      const spied = await handleFindToken(new URL('https://blazephoenix.xyz/api/token/find?chain=base&query=PEPE'), { findToken: spy, fetch: indexes().fn });
      const spiedBody = await spied.json();
      check("find: findToken runs with sources 'centralized' and no rpc; the answer says not measured on-chain and points to findToken on your RPC",
        spied.status === 200 && calls.length === 1 && calls[0].sources === 'centralized' && !('rpc' in calls[0])
        && spiedBody.measured === 'not measured on-chain' && ok.body.measured === 'not measured on-chain'
        && /findToken\(\{[^}]*rpc: '<your RPC>'/.test(spiedBody.verify?.sdk ?? ''));
      // mutant: cache-control removed or set to a max-age -> red
      check('find: answer is never cached (no-store) and open CORS', ok.res.headers.get('cache-control') === 'no-store'
        && ok.res.headers.get('access-control-allow-origin') === '*');

      // mutant: the rpc guard dropped and `rpc: p.get('rpc')` passed to findToken instead of NO_READ (fetch to the caller's URL) -> red
      const evil = await run('chain=base&query=PEPE&rpc=' + encodeURIComponent('https://evil.example/key123'));
      check('find: an rpc parameter -> 400 rpc_not_accepted, and the caller URL is never fetched',
        evil.res.status === 400 && evil.body.code === 'rpc_not_accepted' && evil.seen.length === 0
        && !stray.some((u) => /evil\.example/.test(u)));

      const down = await run('chain=base&query=PEPE', { dexDown: true });
      // mutant: failedSources filtered on s.ok, or the partial-count warning dropped -> red
      check('find: a failed index is named in failedSources and sources, its error kept, the count said to be partial',
        down.res.status === 200 && JSON.stringify(down.body.failedSources) === '["dexscreener"]'
        && (down.body.sources ?? []).some((s) => s.name === 'dexscreener' && s.ok === false && /HTTP 500/.test(s.error ?? ''))
        && down.body.candidates?.length === 1 && (down.body.warnings ?? []).some((w) => /only the indexes that answered; failed: dexscreener/.test(w)));
      const rh = await run('chain=robinhood&query=PEPE');
      // mutant: failedSources removed -> red; no index fetched for a chain neither index covers
      check('find: Robinhood Chain, neither index covers it: both named as failed, 0 is said to be partial, nothing fetched',
        rh.res.status === 200 && JSON.stringify(rh.body.failedSources) === '["coingecko","dexscreener"]'
        && rh.body.candidates?.length === 0 && rh.seen.length === 0 && (rh.body.warnings ?? []).some((w) => /failed: coingecko, dexscreener/.test(w)));

      // mutant: chain guard dropped (the SDK's bad_chain has another message) -> red
      const badChain = await run('chain=solana&query=PEPE');
      check('find: unknown chain -> 400 bad_chain with the chain list, nothing fetched',
        badChain.res.status === 400 && badChain.body.code === 'bad_chain' && /use one of/.test(badChain.body.error) && badChain.seen.length === 0);
      // mutant: query guard dropped (the SDK answers bad_request) -> red
      const noQuery = await run('chain=base&query=%20');
      check('find: blank query -> 400 bad_query, nothing fetched', noQuery.res.status === 400 && noQuery.body.code === 'bad_query' && noQuery.seen.length === 0);
    } finally {
      globalThis.fetch = realFetch;
    }
    // mutant: route registered before the GET-only guard, or left out of API_PATHS -> red
    const idx = read('worker/index.ts');
    const route = idx.indexOf("if (path === '/api/token/find') return mark(await handleFindToken(url));");
    check('find: /api/token/find is in API_PATHS and routed after the GET-only guard (POST -> 405)',
      /API_PATHS = \[[^\]]*'\/api\/token\/find'/.test(idx) && route > idx.indexOf("if (request.method !== 'GET') {"));
    // mutant: OpenAPI describes a POST, or an rpc parameter -> red
    const { OPENAPI } = await load('worker/openapi.ts');
    const op = OPENAPI.paths['/api/token/find'];
    check('find: OpenAPI has GET only, parameters chain and query, no rpc',
      !!op?.get && !op.post && JSON.stringify(op.get.parameters.map((x) => x.name)) === '["chain","query"]');
    // mutant: `measured` left out of the OpenAPI 200 answer -> red
    check('find: OpenAPI 200 answer requires measured and says not measured on-chain',
      op?.get?.responses?.['200']?.content?.['application/json']?.schema?.required?.includes('measured')
      && /measured "not measured on-chain"/.test(op?.get?.responses?.['200']?.description ?? ''));
    check('find: README and llms.txt say unverified proposals, no RPC taken, verify on your own node',
      /unverified proposals/.test(read('README.md')) && /takes no RPC/.test(read('README.md'))
      && /unverified proposals/.test(read('llms.txt')) && /rpc_not_accepted/.test(read('llms.txt')));
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
    // CI passes the checkout as a relative path (`staking`); createRequire refuses a relative one.
    const relAbi = join(tmp, `abi-${n++}.json`);
    writeFileSync(relAbi, JSON.stringify(abi));
    let rel;
    try {
      rel = { code: 0, out: execFileSync(process.execPath, [join(root, 'scripts/gen-staking-abi.mjs'), 'staking', '--check'], {
        cwd: tmp, env: { ...process.env, NODE_MODULES: 'node_modules', STAKING_REV: gen.STAKING_ABI_SOURCE_REVISION, STANDIN_ABI: relAbi },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) { rel = { code: e.status, out: String(e.stderr ?? '') }; }
    check('staking abi --check: a relative checkout and node_modules path, as CI passes them, matches (exit 0)', rel.code === 0 && /matches/.test(rel.out));
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
