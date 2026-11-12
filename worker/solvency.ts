// =============================================================================
//  PROOF-OF-SOLVENCY: COMING SOON
//
//    GET /solvency    → a short HTML page that says proof-of-solvency is
//                       coming soon.
//    GET /api/badge   → a shields.io "endpoint" JSON with the same message.
//
//  Both answer fail-closed: no contract is read, no solvency verdict is
//  asserted, and no contract address or network is named until the staking
//  engine is published. The bodies are pure builders, exported for the
//  offline tests.
// =============================================================================

import { CORS_HEADERS } from './quoteApi';

/** The one message both surfaces carry. */
export const SOLVENCY_COMING_SOON = 'Proof-of-solvency: coming soon';

/** shields.io endpoint schema — https://shields.io/badges/endpoint-badge.
 *  `status` and the null read time are extra fields shields.io ignores; they
 *  tell every other reader that no verdict was read. */
export function badgeJson(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    label: 'BlazePhoenix staking',
    message: SOLVENCY_COMING_SOON,
    color: 'lightgrey',
    cacheSeconds: 300,
    status: 'coming_soon',
    readAt: null,
    readAtMs: null,
  };
}

export function solvencyHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BlazePhoenix Staking — ${SOLVENCY_COMING_SOON}</title>
<meta name="description" content="BlazePhoenix staking. ${SOLVENCY_COMING_SOON}.">
<link rel="canonical" href="https://blazephoenix.xyz/solvency">
<style>
 body{background:#070b14;color:#e7e5e4;font-family:ui-monospace,Menlo,monospace;
      max-width:760px;margin:0 auto;padding:40px 20px;line-height:1.6}
 h1{font-size:1.5rem} a{color:#29e0ff}
</style>
</head>
<body>
<h1>BlazePhoenix Staking</h1>
<p><strong>${SOLVENCY_COMING_SOON}.</strong></p>
<p><a href="https://blazephoenix.xyz">blazephoenix.xyz</a> ·
Agent guide: <a href="https://blazephoenix.xyz/llms.txt">/llms.txt</a></p>
</body>
</html>`;
}

// ── handlers ─────────────────────────────────────────────────────────────────

export async function handleSolvencyReport(): Promise<Response> {
  return new Response(solvencyHtml(), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=600',
    },
  });
}

export async function handleBadge(): Promise<Response> {
  return new Response(JSON.stringify(badgeJson()), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
      ...CORS_HEADERS,
    },
  });
}
