// =============================================================================
//  GET /api/verify — the facts file, but ALIVE.
//
//  facts.json is proof-carrying: every claim ships the command that reproduces
//  it. For the facts whose proof is a ZERO-ARGUMENT `cast call`, this endpoint
//  re-executes that exact read against a public RPC and returns the value with
//  the block height it was read at. "Compute, don't trust" as an API:
//
//    GET /api/verify            → which facts are live-verifiable
//    GET /api/verify?fact=<id>  → { value, block, reproduce } for one fact
//
//  SECURITY: the contract address, method and RPC all come from the committed
//  facts.json — never from the caller. Only zero-argument reads qualify, so
//  this endpoint cannot be steered at arbitrary contracts or calldata.
//  Cost: public-RPC eth_calls (free), edge-cached 5 minutes.
// =============================================================================

import { toFunctionSelector, decodeAbiParameters, parseAbiParameters } from 'viem';
import { CHAINS } from '../src/config/chains';
import { CORS_HEADERS } from './quoteApi';

interface AssetsEnv { ASSETS: { fetch: (req: Request) => Promise<Response> } }

interface Fact { id: string; domain?: string; claim: string; proof: string; url?: string }

const RPC_TIMEOUT_MS = 3_500;

// `cast call <address> '<name>()(<rets>)' --rpc-url <url>` — single or double
// quotes; the signature must be zero-argument (enforced again below).
const CAST_RE = /cast call (0x[0-9a-fA-F]{40})\s+['"]([^'"]+)['"]\s+--rpc-url\s+(\S+)/;
const SIG_RE = /^([A-Za-z_]\w*)\(\)(?:\(([^()]*)\))?$/;

interface Executable { to: `0x${string}`; method: string; returns: string; rpc: string }

export function parseProof(proof: string): Executable | null {
  const m = CAST_RE.exec(proof);
  if (!m) return null;
  const sig = SIG_RE.exec(m[2]);
  if (!sig) return null; // has arguments, or malformed — not auto-executable
  return { to: m[1] as `0x${string}`, method: sig[1], returns: sig[2] ?? '', rpc: m[3] };
}

async function rpcJson(rpc: string, body: unknown): Promise<{ result?: string } | null> {
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
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as { result?: string };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function rpcCandidates(proofRpc: string): string[] {
  const list = [proofRpc];
  // Base facts get the site's own RPC fallbacks; other chains use the proof's
  // RPC as-is (all current executable facts are Base).
  if (proofRpc.includes('base.org')) {
    for (const rpc of (CHAINS[8453]?.rpcs ?? []).slice(0, 3)) {
      if (!list.includes(rpc)) list.push(rpc);
    }
  }
  return list;
}

const json = (status: number, payload: unknown, cacheSecs = 300): Response =>
  new Response(JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? `public, max-age=${cacheSecs}, stale-while-revalidate=3600` : 'no-store',
      ...CORS_HEADERS,
    },
  });

export async function handleVerify(url: URL, env: AssetsEnv): Promise<Response> {
  const factsRes = await env.ASSETS.fetch(new Request(new URL('/facts.json', url.origin)));
  if (!factsRes.ok) return json(500, { ok: false, code: 'facts_unreadable', error: 'facts.json not readable' });
  const facts = ((await factsRes.json()) as { facts?: Fact[] }).facts ?? [];

  const id = url.searchParams.get('fact');
  if (!id) {
    const verifiable = facts
      .map((f) => ({ f, x: parseProof(f.proof) }))
      .filter((e): e is { f: Fact; x: Executable } => e.x !== null)
      .map(({ f, x }) => ({ id: f.id, method: `${x.method}()`, to: x.to }));
    return json(200, {
      ok: true,
      name: 'BlazePhoenix live fact verification',
      description:
        'Re-executes the exact zero-argument on-chain read carried by a fact in /facts.json and returns the value with the block it was read at. Facts with prose proofs remain reproducible by hand — see each fact’s `proof` field.',
      usage: `${url.origin}/api/verify?fact=<id>`,
      verifiable,
      total: facts.length,
      facts: `${url.origin}/facts.json`,
    }, 3600);
  }

  const fact = facts.find((f) => f.id === id);
  if (!fact) return json(404, { ok: false, code: 'unknown_fact', error: `no fact with id "${id}" in facts.json` });

  const exec = parseProof(fact.proof);
  if (!exec) {
    return json(422, {
      ok: false,
      code: 'not_executable',
      error: 'this fact’s proof is prose (or takes arguments) — reproduce it by hand',
      id: fact.id,
      claim: fact.claim,
      proof: fact.proof,
      url: fact.url,
    });
  }

  const data = toFunctionSelector(`function ${exec.method}()`);
  for (const rpc of rpcCandidates(exec.rpc)) {
    const block = await rpcJson(rpc, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    const call = await rpcJson(rpc, {
      jsonrpc: '2.0', id: 2, method: 'eth_call',
      params: [{ to: exec.to, data }, 'latest'],
    });
    if (!call?.result || call.result === '0x') continue;

    let decoded: unknown = null;
    if (exec.returns) {
      try {
        const values = decodeAbiParameters(parseAbiParameters(exec.returns), call.result as `0x${string}`);
        decoded = values.length === 1 ? values[0] : values;
      } catch { /* leave raw only */ }
    }
    return json(200, {
      ok: true,
      id: fact.id,
      claim: fact.claim,
      verified: {
        to: exec.to,
        method: `${exec.method}()`,
        block: block?.result ? parseInt(block.result, 16) : null,
        raw: call.result,
        decoded,
        checkedAt: new Date().toISOString(),
      },
      reproduce: fact.proof,
      url: fact.url,
    });
  }
  return json(502, { ok: false, code: 'rpc_unreachable', error: 'all RPCs failed — retry shortly', id: fact.id, reproduce: fact.proof });
}
