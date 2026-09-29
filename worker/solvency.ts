// =============================================================================
//  PROOF-OF-SOLVENCY CONTENT ENGINE
//
//  Two edge-served surfaces generated LIVE from the Base staking contract:
//
//    GET /solvency    → a semantic HTML report (h1/tables, crawler-perfect):
//                       the full solvency() struct, refreshed from chain and
//                       edge-cached ~10 min. Risk bots, funds and researchers
//                       scraping "solvency invariant verification" land here
//                       and find real numbers with reproduce instructions.
//
//    GET /api/badge   → a shields.io "endpoint" JSON, so ANY GitHub README
//                       can embed a live solvency badge:
//                       ![](https://img.shields.io/endpoint?url=https://blazephoenix.xyz/api/badge)
//                       Every badge in the wild = a live proof + a backlink.
//
//  Pure builders (badgeJson / solvencyHtml) are exported for offline tests;
//  network touching stays in the handlers.
// =============================================================================

import { encodeFunctionData, decodeFunctionResult, formatUnits } from 'viem';
import { STAKING_ABI } from '../src/abis/staking';
import { CHAINS } from '../src/config/chains';
import { CORS_HEADERS, edgeGet, edgePut, singleflight } from './quoteApi';

const BASE = CHAINS[8453];
const RPC_TIMEOUT_MS = 3_500;

export interface SolvencyReport {
  backing: bigint; owed: bigint; surplus: bigint; deficit: bigint;
  solvent: boolean; collateralRatioWad: bigint; totalStaked: bigint;
  totalDebt: bigint; rewardReserve: bigint; protocolReserve: bigint;
  pendingDistribution: bigint; totalBadDebt: bigint; totalUncollectedInterest: bigint;
}

// ── pure builders (unit-tested) ──────────────────────────────────────────────

/** shields.io endpoint schema — https://shields.io/badges/endpoint-badge */
export function badgeJson(solvent: boolean | null, readAtMs?: number | null): Record<string, unknown> {
  return {
    schemaVersion: 1,
    label: 'BlazePhoenix staking',
    message: solvent === null ? 'chain unreachable' : `isSolvent() = ${solvent}`,
    color: solvent === null ? 'lightgrey' : solvent ? 'teal' : 'red',
    cacheSeconds: 300,
    // The read age, which this endpoint carried nowhere. The value passes a
    // 300s edge cache and then tells shields.io to hold it another 300s, so a
    // badge embedded in someone else's README could assert solvency up to ten
    // minutes stale with no way for any consumer to know. shields.io ignores
    // fields it does not recognise, so this costs the badge nothing and gives
    // every other reader the one number that makes the verdict interpretable.
    // null means the age is unknown — see readSolvencyCached.
    readAt: typeof readAtMs === 'number' ? new Date(readAtMs).toISOString() : null,
    readAtMs: typeof readAtMs === 'number' ? readAtMs : null,
  };
}

const bz = (v: bigint) => {
  // BZPX has 18 decimals; render as a grouped integer for readability.
  const s = formatUnits(v, 18);
  const [int, frac] = s.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac.slice(0, 4)}` : grouped;
};

export function solvencyHtml(r: SolvencyReport, readAtMs: number | null): string {
  const ratioPct = Number(r.collateralRatioWad / 10n ** 14n) / 100; // wad → %
  const rows: [string, string][] = [
    ['backing', `${bz(r.backing)} BZPX`],
    ['owed', `${bz(r.owed)} BZPX`],
    ['surplus', `${bz(r.surplus)} BZPX`],
    ['deficit', `${bz(r.deficit)} BZPX`],
    ['collateralRatio', `${ratioPct.toFixed(2)}%`],
    ['totalStaked', `${bz(r.totalStaked)} BZPX`],
    ['totalDebt', `${bz(r.totalDebt)} BZPX`],
    ['rewardReserve', `${bz(r.rewardReserve)} BZPX`],
    ['protocolReserve', `${bz(r.protocolReserve)} BZPX`],
    ['pendingDistribution', `${bz(r.pendingDistribution)} BZPX`],
    ['totalBadDebt', `${bz(r.totalBadDebt)} BZPX`],
    ['totalUncollectedInterest', `${bz(r.totalUncollectedInterest)} BZPX`],
  ];
  const tr = rows.map(([k, v]) =>
    `<tr><td><code>${k}</code></td><td>${v}</td></tr>`).join('\n      ');
  const status = r.solvent ? 'SOLVENT ✅' : 'INSOLVENT ⚠️';
  const iso = typeof readAtMs === 'number' ? new Date(readAtMs).toISOString() : 'unknown (served from a cache entry written before read times were recorded)';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BlazePhoenix Staking — Live Proof-of-Solvency Report (${status})</title>
<meta name="description" content="Live on-chain solvency invariant verification for the BlazePhoenix staking engine on Base: isSolvent() = ${r.solvent}, collateral ratio ${ratioPct.toFixed(2)}%, full solvency() struct decoded from contract ${BASE.contracts.staking}. Reproducible by anyone.">
<link rel="canonical" href="https://blazephoenix.xyz/solvency">
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: 'BlazePhoenix Staking — live proof-of-solvency report',
    description: `On-chain solvency invariant verification: isSolvent() = ${r.solvent}. Every figure decoded live from the verified staking contract on Base.`,
    dateModified: iso,
    creator: { '@type': 'Organization', name: 'BlazePhoenix', url: 'https://blazephoenix.xyz' },
    license: 'https://blazephoenix.xyz/llms.txt',
  })}</script>
<style>
 body{background:#070b14;color:#e7e5e4;font-family:ui-monospace,Menlo,monospace;
      max-width:760px;margin:0 auto;padding:40px 20px;line-height:1.6}
 h1{font-size:1.5rem} h2{font-size:1.05rem;color:#29e0ff;margin-top:2rem}
 .ok{color:#2be6d6}.bad{color:#ef4444}
 table{border-collapse:collapse;width:100%;font-size:.85rem}
 td{border:1px solid #1e293b;padding:8px 10px}
 code{color:#7dd3ff} a{color:#29e0ff} .s{color:#94a3b8;font-size:.75rem}
</style>
</head>
<body>
<h1>BlazePhoenix Staking — Proof of Solvency</h1>
<p class="s">Read live from Base at ${iso} · contract
 <a href="${BASE.explorer}/address/${BASE.contracts.staking}#readContract">${BASE.contracts.staking}</a>
 · refreshes ~10 min · <a href="https://blazephoenix.xyz">blazephoenix.xyz</a></p>

<h2>Invariant status</h2>
<p><strong class="${r.solvent ? 'ok' : 'bad'}">isSolvent() = ${r.solvent}</strong>
 — the staking engine's solvency invariant, checkable by anyone, any block,
 no permission. This page decodes the full <code>solvency()</code> report:</p>

<table>
      ${tr}
</table>

<h2>Reproduce this report yourself</h2>
<p>Do not trust this page — verify it. Call the contract directly:</p>
<p><code>cast call ${BASE.contracts.staking} "isSolvent()(bool)" --rpc-url https://mainnet.base.org</code></p>
<p>Or open <a href="${BASE.explorer}/address/${BASE.contracts.staking}#readContract">Read Contract on Basescan</a>
 and call <code>isSolvent()</code> / <code>solvency()</code> / <code>auditInvariants()</code>.</p>

<h2>Machine-readable</h2>
<p>Live badge for any README:
<code>![solvency](https://img.shields.io/endpoint?url=https%3A%2F%2Fblazephoenix.xyz%2Fapi%2Fbadge)</code><br>
Embeddable widget: <code>&lt;iframe src="https://blazephoenix.xyz/widget/solvency.html"&gt;</code><br>
Protocol manifest: <a href="https://blazephoenix.xyz/api/manifest">/api/manifest</a> ·
Agent guide: <a href="https://blazephoenix.xyz/llms.txt">/llms.txt</a></p>
</body>
</html>`;
}

// ── chain read (bounded, cached by callers) ──────────────────────────────────

async function readSolvency(): Promise<{ report?: SolvencyReport; solvent?: boolean }> {
  const data = encodeFunctionData({ abi: STAKING_ABI, functionName: 'solvency' });
  for (const rpc of BASE.rpcs.slice(0, 3)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          origin: 'https://blazephoenix.xyz',
          referer: 'https://blazephoenix.xyz/',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ to: BASE.contracts.staking, data }, 'latest'],
        }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { result?: `0x${string}` };
      if (!body.result || body.result === '0x') continue;
      const r = decodeFunctionResult({
        abi: STAKING_ABI, functionName: 'solvency', data: body.result,
      }) as unknown as SolvencyReport;
      return { report: r, solvent: r.solvent };
    } catch { /* next rpc */ } finally { clearTimeout(timer); }
  }
  return {};
}

// ── one-read-per-window edge cache ───────────────────────────────────────────
// readSolvency is one eth_call, but WITHOUT this every /solvency AND /api/badge
// hit paid it. Coalesce concurrent reads (singleflight) and serve identical ones
// from the PoP cache for ~5 min, so a colo pays one RPC per window no matter the
// traffic. bigints are stored as decimal strings (JSON-safe) and rebuilt on read;
// readAtMs is carried too so the report's "read live at" stays HONEST when served
// from cache. Fail-open: an absent/stale cache falls back to the live read.
const SOLV_KEY = '__solvency_v1';
const SOLV_TTL_SECS = 300;

async function readSolvencyCached(): Promise<{ report?: SolvencyReport; solvent?: boolean; readAtMs: number | null }> {
  const hit = (await edgeGet(SOLV_KEY)) as Record<string, string> | undefined;
  if (hit && typeof hit.solvent === 'string') {
    const b = (k: string): bigint => BigInt(hit[k] ?? '0');
    const report: SolvencyReport = {
      backing: b('backing'), owed: b('owed'), surplus: b('surplus'), deficit: b('deficit'),
      solvent: hit.solvent === 'true',
      collateralRatioWad: b('collateralRatioWad'), totalStaked: b('totalStaked'),
      totalDebt: b('totalDebt'), rewardReserve: b('rewardReserve'),
      protocolReserve: b('protocolReserve'), pendingDistribution: b('pendingDistribution'),
      totalBadDebt: b('totalBadDebt'), totalUncollectedInterest: b('totalUncollectedInterest'),
    };
    // Was `Number(hit.readAtMs ?? '0') || Date.now()`. A cache entry written
    // before readAtMs existed has none, and the fallback stamped it with NOW —
    // so /solvency printed "read live at <now>" over data of unknown age. That
    // is the confident-zero defect with a clock instead of a counter. Unknown
    // is now null and every consumer renders it as unknown.
    const stamped = Number(hit.readAtMs ?? '0');
    return { report, solvent: report.solvent, readAtMs: Number.isFinite(stamped) && stamped > 0 ? stamped : null };
  }
  const now = Date.now();
  const { value } = await singleflight(SOLV_KEY, () => readSolvency());
  const r = value.report;
  if (r) {
    await edgePut(SOLV_KEY, {
      backing: r.backing.toString(), owed: r.owed.toString(), surplus: r.surplus.toString(),
      deficit: r.deficit.toString(), solvent: String(r.solvent),
      collateralRatioWad: r.collateralRatioWad.toString(), totalStaked: r.totalStaked.toString(),
      totalDebt: r.totalDebt.toString(), rewardReserve: r.rewardReserve.toString(),
      protocolReserve: r.protocolReserve.toString(), pendingDistribution: r.pendingDistribution.toString(),
      totalBadDebt: r.totalBadDebt.toString(), totalUncollectedInterest: r.totalUncollectedInterest.toString(),
      readAtMs: String(now),
    }, SOLV_TTL_SECS);
  }
  return { report: value.report, solvent: value.solvent, readAtMs: now };
}

// ── handlers ─────────────────────────────────────────────────────────────────

export async function handleSolvencyReport(): Promise<Response> {
  const { report, readAtMs } = await readSolvencyCached();
  if (!report) {
    return new Response('solvency report temporarily unavailable — retry shortly', {
      status: 503, headers: { 'content-type': 'text/plain', 'retry-after': '30' },
    });
  }
  return new Response(solvencyHtml(report, readAtMs), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=600, stale-while-revalidate=3600',
    },
  });
}

export async function handleBadge(): Promise<Response> {
  const { solvent, readAtMs } = await readSolvencyCached();
  return new Response(JSON.stringify(badgeJson(solvent ?? null, readAtMs)), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
      ...CORS_HEADERS,
    },
  });
}
