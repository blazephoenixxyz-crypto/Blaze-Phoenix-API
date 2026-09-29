// =============================================================================
//  Cloudflare Workers entry — serves the static /out bundle AND the read-only
//  API surface (quote, manifest, health, stats, tape, verify, MCP, solvency).
//
//  THERE IS NO WRITE ENDPOINT, AND THAT IS A PROPERTY, NOT AN OMISSION.
//  `/api/airdrop` lived here until 2026-08-26: it harvested wallet addresses
//  behind a spin-the-reel + share gate, deduped by hashed IP, capped at 95k a
//  day. It was removed with the mechanic it served. The reasoning is on the
//  airdrop page itself, but the short version belongs here too, because it is
//  what keeps this file free of state: a submission form is the surface an
//  industrial farmer exploits BETTER than a human — whoever runs 20,000
//  wallets fills 20,000 forms; whoever has one fills one. Measuring real
//  on-chain behaviour needs nothing from the visitor, so this Worker asks for
//  nothing and stores nothing.
//
//  SAFETY: every handler is wrapped in try/catch and errors stay inside their
//  own path. EVERYTHING else — and any handler error — falls through to
//  env.ASSETS, so a bug in an API handler can never take the static site down.
// =============================================================================

import {
  handleQuote, handleQuoteBatch, handleManifest, handleDiscovery, handleHealth, handleStats, handleTape,
  handlePrepare, handlePrepareBatch, handleDecode, handleDeployments, handleAbi,
  CORS_HEADERS,
} from './quoteApi';
import { handleOpenapi } from './openapi';
import { handleSolvencyReport, handleBadge } from './solvency';
import { handleMcp } from './mcp';
import { markdownMirrorPath } from './negotiate';
import { handleVerify } from './verify';
import { classifyRequest, type RequestClass } from './requestClass';

interface Env {
  // Static-assets binding (declared in wrangler.jsonc → assets.binding).
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  // Airdrop bindings/secrets — all optional; the handler degrades if absent.
  AIRDROP_KV?: unknown;
  GH_TOKEN?: string;
  GH_OWNER?: string;
  GH_REPO?: string;
  GH_BRANCH?: string;
  GH_DIR?: string;
  IP_SALT?: string;
  // Deploy Hook URL for the scheduled rebuild (see scheduled() below).
  // Set as a secret, never in wrangler.jsonc: whoever holds it can queue builds.
  DEPLOY_HOOK_URL?: string;
}

// Vulnerability-scanner shield. Bots probe every public site for accidentally
// exposed secrets/backups (.env, database dumps, config backups, .git, …). We
// have none — it is a static site — so we short-circuit these with a tiny 404
// instead of rendering and serving the full 404 page, saving an ASSETS
// subrequest, CPU and bandwidth on the ~junk that dominates the logs. The real
// per-request quota saver is a Cloudflare WAF/rate-limit rule at the EDGE (runs
// before the Worker); this is the belt-and-suspenders layer. NONE of the site's
// real assets match: it serves only .html/.js/.css and a fixed set of
// .json/.jsonld/.xml/.txt/.png/.svg/.mp4/.pdf/.webmanifest, never these.
const SCANNER_RE =
  /(?:^|\/)(?:\.env|\.git|\.aws|\.ssh|\.svn|\.hg|\.DS_Store|\.htaccess|\.htpasswd|web\.config|wp-login|wp-admin|xmlrpc\.php|phpmyadmin|phpunit|vendor\/|\.vscode|\.idea|local_settings|appsettings|credentials|id_rsa|id_dsa|secrets\.)|\.(?:sql|sqlite|sqlite3|db|bak|bkp|backup|old|orig|save|tmp|temp|swp|swo|log|ini|conf|cfg|pem|key|crt|p12|pfx|php|phtml|asp|aspx|jsp|cgi|py)(?=$|[?.~/-])|\.\.\/|~$/i;

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    // ─── Actor class: allow the good, meter only the bad — see requestClass.ts ───
    // Decided ONCE per request from the proof Cloudflare already made
    // (verifiedBot / bot score), never from geography. FAIL-OPEN: no signal →
    // 'human'. This layer NEVER refuses on its own — the refusing is the edge
    // WAF's job (it runs before the Worker, so it actually saves the
    // invocation). Here we only (a) surface the verdict on metered responses
    // for observability and (b) shorten the cache TTL a suspect earns, so a
    // sweep of unique amounts pays a colder cache without any human ever
    // being told no.
    const actor: RequestClass = classifyRequest(
      (request as unknown as { cf?: import('./requestClass').CfLike }).cf,
    );
    // ─── Trailing-slash normalisation for WORKER-OWNED routes ───
    // next.config sets trailingSlash: true, so every internal link and every
    // crawler request for a page route arrives as "/solvency/", while the
    // handlers below matched the bare "/solvency". The mismatch fell through to
    // the static assets, which have no such file, and Google recorded the
    // canonical solvency page as a 404 (confirmed in Search Console). Compare
    // against a slash-stripped path so both forms resolve to the same handler;
    // "/" itself is preserved.
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

    // Malformed legacy verify URLs (…/verify/undefined0x…) were emitted by an
    // earlier build and are still being retried by crawlers. They can never be
    // valid, so answer 410 Gone rather than 404: Gone is permanent and drops
    // them from the index quickly instead of leaving them in a retry loop.
    if (/^\/verify\/undefined/i.test(path)) {
      return new Response('Gone', {
        status: 410,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex' },
      });
    }

    // MCP server — BlazePhoenix as a native tool for AI agents (stateless
    // streamable-HTTP). Same safety contract: errors never leave /mcp.
    if (path === '/mcp') {
      try { return await handleMcp(request); } catch {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } }), {
          status: 500, headers: { 'content-type': 'application/json' },
        });
      }
    }


    // /cli — the terminal front door (a dApp that answers in your shell).
    // Deliberately its OWN path, never User-Agent sniffing on / (that would be
    // cloaking). Try: curl -s blazephoenix.xyz/cli
    if (path === '/cli') {
      const CLI = [
        '  ___ _              ___ _                  _     ',
        ' | _ ) |__ _______  | _ \\ |_  ___  ___ _ _ (_)_ __',
        ' | _ \\ / _` |_ / -_) |  _/ ' + "'" + ' \\/ _ \\/ -_) ' + "'" + ' \\| \\ \\ /',
        ' |___/_\\__,_/__\\___| |_| |_||_\\___/\\___|_||_|_/_\\_\\',
        '',
        ' On-chain DEX aggregator · Base | Ethereum | Optimism | Arbitrum',
        ' compute, don\'t trust — the quote IS the execution logic.',
        '',
        ' [Solvency]  cast call 0x3f60C7aa0c36a78D200405feBE143d2Cf3fA0c77 \\',
        '               "isSolvent()(bool)" --rpc-url https://mainnet.base.org',
        ' [Quote]     curl -s "https://blazephoenix.xyz/api/quote/prepare?chain=base&in=WETH&out=USDC&amountIn=1000000000000000000"',
        '             → run the returned eth_call on YOUR node (we perform no RPC for integrators)',
        ' [SDK]       npm i @blazephoenix/sdk viem   ·   quotes in-process, on your RPC',
        ' [Facts]     curl -s https://blazephoenix.xyz/facts.json',
        ' [Agents]    claude mcp add blazephoenix -e BLAZEPHOENIX_RPC_BASE=<your node> -- npx -y @blazephoenix/mcp',
        ' [Corpus]    curl -s https://blazephoenix.xyz/llms-full.txt',
        '',
        ' Every claim above is reproducible. Run the Nakamoto Test on us — and',
        ' on everyone else: https://blazephoenix.xyz/learn/the-nakamoto-test',
        '',
      ].join('\n');
      return new Response(CLI, {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
      });
    }

    // Google Search Console ownership — serve the verification file DIRECTLY,
    // so it never depends on Cloudflare's static-asset .html handling (which
    // can strip the extension / redirect). Exact content Google expects.
    if (url.pathname === '/googlec37d3f004dd72923.html' && request.method === 'GET') {
      return new Response('google-site-verification: googlec37d3f004dd72923.html', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }

    // Naver Search Advisor verification — same pattern as the Google file.
    // Static assets 307 the .html extension away (html_handling), and Naver's
    // verifier may not follow redirects, so the worker answers the exact path.
    if (url.pathname === '/naver346192bc8f8777e4462b5afe83c52cb5.html' && request.method === 'GET') {
      return new Response('naver-site-verification: naver346192bc8f8777e4462b5afe83c52cb5.html', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }

    // /index.txt — the plain-text site index for agents/bots. Next.js owns this
    // path for the homepage RSC payload (client-side navigation), so we only
    // override it for NON-RSC requests (agents, crawlers, curl — never the app's
    // own navigation, which sends an `RSC` header). Falls through to the RSC
    // payload otherwise. Content lives at /site-index.txt (generated at build).
    if (url.pathname === '/index.txt' && request.method === 'GET' && !request.headers.get('rsc')) {
      try {
        const r = await env.ASSETS.fetch(new Request(new URL('/site-index.txt', url.origin)));
        if (r.ok) {
          return new Response(r.body, {
            status: 200,
            headers: {
              'content-type': 'text/plain; charset=utf-8',
              'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
            },
          });
        }
      } catch { /* fall through to the Next.js asset */ }
    }

    // Scanner shield — refuse obvious secret/backup probes immediately.
    if (SCANNER_RE.test(path)) {
      return new Response('Not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
      });
    }

    // Public integration surface (quote API, batch, manifest, OpenAPI) — same
    // safety contract as every other handler: any error stays inside /api/*.
    // Integrator endpoints perform NO RPC (prepare/decode/deployments/abi are
    // pure; /api/quote and /api/quote/batch answer rpc_required with the
    // prepared call). stats/tape/badge/verify are the site's own edge-cached
    // dashboards — one read per cache window, whatever the caller count.
    const API_PATHS = ['/api', '/api/quote', '/api/quote/batch', '/api/quote/prepare', '/api/quote/decode', '/api/deployments', '/api/abi', '/api/manifest', '/api/openapi.json', '/api/health', '/api/stats', '/api/badge', '/api/tape', '/api/verify'];
    if (API_PATHS.includes(path)) {
      try {
        // The actor verdict goes out in a header on ALL API responses, through a
        // wrapper rather than N edits in the N `return`s of this block: the rule
        // lives in one place, and a new `return` inherits it without anyone having
        // to remember. It is observability, not policy — nothing here refuses anyone.
        const mark = (r: Response): Response => {
          const h = new Headers(r.headers);
          h.set('x-bzp-actor', actor);
          return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
        };
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
        const postOnly = () => new Response(JSON.stringify({ ok: false, error: 'method not allowed — POST' }), {
          status: 405, headers: { allow: 'POST, OPTIONS', 'content-type': 'application/json', ...CORS_HEADERS },
        });
        if (path === '/api/quote/batch') {
          if (request.method !== 'POST') return postOnly();
          return mark(await handleQuoteBatch(request));
        }
        if (path === '/api/quote/decode') {
          if (request.method !== 'POST') return postOnly();
          return mark(await handleDecode(request));
        }
        if (path === '/api/quote/prepare' && request.method === 'POST') {
          return mark(await handlePrepareBatch(request));
        }
        if (request.method !== 'GET') {
          return new Response(JSON.stringify({ ok: false, error: 'method not allowed' }), {
            status: 405, headers: { allow: 'GET, OPTIONS', 'content-type': 'application/json', ...CORS_HEADERS },
          });
        }
        if (path === '/api/quote') return mark(await handleQuote(url));
        if (path === '/api/quote/prepare') return mark(handlePrepare(url));
        if (path === '/api/deployments') return mark(handleDeployments());
        if (path === '/api/abi') return mark(handleAbi(url));
        if (path === '/api/openapi.json') return mark(handleOpenapi());
        if (path === '/api') return mark(handleDiscovery());
        if (path === '/api/health') return mark(handleHealth());
        if (path === '/api/stats') return mark(await handleStats());
        if (path === '/api/badge') return mark(await handleBadge());
        if (path === '/api/tape') return mark(await handleTape(url));
        if (path === '/api/verify') return mark(await handleVerify(url, env));
        return mark(handleManifest());
      } catch {
        return new Response(JSON.stringify({ ok: false, code: 'internal', error: 'internal' }), {
          status: 500, headers: { 'content-type': 'application/json', ...CORS_HEADERS },
        });
      }
    }

    // Live proof-of-solvency report — semantic HTML generated from the chain.
    // Own branch (it is a PAGE, not a CORS/JSON API); errors fall to a plain
    // 503 inside the handler and can never affect static assets.
    if (path === '/solvency') {
      try {
        if (request.method !== 'GET') {
          return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } });
        }
        return await handleSolvencyReport();
      } catch {
        return new Response('solvency report temporarily unavailable', {
          status: 503, headers: { 'content-type': 'text/plain', 'retry-after': '30' },
        });
      }
    }


    // Agent-native content negotiation: GET /learn/<slug> with
    // `Accept: text/markdown` returns the pre-built /md mirror directly (no
    // redirect hop; Content-Location + Link: canonical tell the agent what it
    // got). Needs assets.run_worker_first for /learn/* in wrangler.jsonc —
    // those requests become Worker invocations, a cost accepted ONLY on the
    // learn surface. Any failure falls through to the normal HTML.
    if (request.method === 'GET') {
      const mdPath = markdownMirrorPath(url.pathname, request.headers.get('accept'));
      if (mdPath) {
        try {
          const md = await env.ASSETS.fetch(new Request(new URL(mdPath, url.origin)));
          if (md.ok) {
            return new Response(md.body, {
              status: 200,
              headers: {
                'content-type': 'text/markdown; charset=utf-8',
                'vary': 'Accept',
                'content-location': mdPath,
                'link': `<https://blazephoenix.xyz${url.pathname.replace(/\/$/, '')}>; rel="canonical"`,
                'x-robots-tag': 'noindex',
                'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
              },
            });
          }
        } catch { /* fall through to HTML */ }
      }
    }

    // Everything else: the static site (honours _headers, _redirects, 404-page).
    // NOTE: /learn/* never reaches the Worker (run_worker_first is deliberately
    // off — see wrangler.jsonc); the markdown-mirror alternate is advertised in
    // the article HTML itself (learn/[slug] generateMetadata), at zero cost.
    return env.ASSETS.fetch(request);
  },

  // ─── THE HEARTBEAT, MOVED OFF GITHUB ──────────────────────────────────────
  // Every generated surface (Token Radar, vitality, presence, OG cards,
  // llms-full, knowledge graph) is produced by `npm run build`. Without a
  // scheduled rebuild the site freezes at whatever the last push produced: the
  // radar sits on stale tokens and nothing new is pinged to IndexNow.
  //
  // The rebuild is triggered from here rather than from a separate CI cron, so
  // a single build pipeline produces the site.
  //
  // A Deploy Hook is just a URL you POST to. Cloudflare deduplicates repeat
  // fires that arrive before a build starts, and rate-limits to 10 builds/min
  // per Worker, so a stuck cron cannot become a build storm.
  async scheduled(
    _event: { cron: string; scheduledTime: number },
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ): Promise<void> {
    const hook = env.DEPLOY_HOOK_URL;
    if (!hook) {
      // Loud in the logs, but never throw: a missing secret must not turn into
      // a retrying cron that reads like an outage.
      console.warn('DEPLOY_HOOK_URL not set — scheduled rebuild skipped');
      return;
    }
    ctx.waitUntil(
      fetch(hook, { method: 'POST' })
        .then(async (r) => {
          console.log(
            `deploy hook -> ${r.status}${r.ok ? ' queued' : ` ${await r.text()}`}`,
          );
        })
        .catch((e) => {
          console.error('deploy hook failed', e);
        }),
    );
  },
};
