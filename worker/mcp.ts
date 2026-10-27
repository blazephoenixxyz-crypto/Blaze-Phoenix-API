// =============================================================================
//  REMOTE MCP ENDPOINT — POST /mcp (streamable-HTTP, stateless). ZERO RPC.
//
//  Agents quote on THEIR OWN RPC. The full toolset (get_quote, build_swap,
//  simulate_swap, check_solvency, …) is the LOCAL MCP server:
//
//      claude mcp add blazephoenix -e BLAZEPHOENIX_RPC_BASE=<your node> -- npx -y @blazephoenix/mcp
//
//  which runs on the user's machine and reads the chain through the user's
//  nodes. This hosted endpoint never performs an RPC call: it serves the
//  versioned deployment registry, the generated ABIs, and the pure codec —
//  prepare_quote returns the exact eth_call to run on your node, decode_quote
//  turns your node's answer into the quote, the Phoenix Check and verified
//  calldata. Same contract as the REST API (worker/codec.ts); never throws.
// =============================================================================

import { CORS_HEADERS, prepareFromParams, readJsonBody } from './quoteApi';
import { decodeQuote, registryDocument } from './codec';
import { QUOTER_ABI, ROUTER_ABI, SOLVER_ABI, HUB_ABI, CORE_ABI, BLAZE_ERRORS_ABI, ABI_SOURCE_REVISION } from '../src/abis/blaze';

/** Protocol revisions this server speaks, newest first. initialize echoes the
 *  client's version when it is listed here and answers with the newest
 *  otherwise. Everything served (tools only, stateless, no sessions, no
 *  server-to-client requests) means the same thing in all four. 2026-07-28
 *  is NOT listed: it replaces initialize with per-request _meta and
 *  server/discover, which this endpoint does not implement yet. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested : LATEST_PROTOCOL_VERSION;
}

/** The REST CORS set plus the headers a browser MCP client sends. Stateless:
 *  no Mcp-Session-Id is ever issued, so there is nothing to expose. */
export const MCP_CORS_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, authorization',
};

const LOCAL_SERVER =
  'For one-step quotes, swaps and solvency on your own RPC, run the local server: '
  + 'claude mcp add blazephoenix -e BLAZEPHOENIX_RPC_BASE=<your node> -- npx -y @blazephoenix/mcp';

const QUOTE_PARAMS = {
  chain: { type: 'string', description: 'base | eth | optimism | arbitrum | robinhood (or a chain id)' },
  in: { type: 'string', description: 'input token — 0x address, or ETH / WETH / USDC / BZPX' },
  out: { type: 'string', description: 'output token — 0x address, or ETH / WETH / USDC / BZPX' },
  amountIn: { type: 'string', description: 'input amount in base units (wei-style integer string)' },
  recipient: { type: 'string', description: 'optional 0x address; with it, decode_quote returns signable calldata' },
  slippageBps: { type: 'integer', description: '0–5000 (default 50); never below the on-chain floor' },
  userMinOut: { type: 'string', description: 'optional explicit minimum output, base units' },
  deadlineSec: { type: 'integer', description: 'deadline horizon in seconds, 10–3600 (default 120)' },
  exact: { type: 'boolean', description: 'true → previewPlanExact: every leg dry-run on its pool in this block (no calldata). No tokens move from a holder, so a token that blocks or taxes its own transfer still quotes; simulate the swap from the holder to test that' },
  version: { type: 'string', description: 'protocol version: latest (default) | 1 | 2 | 2.0.0' },
} as const;

// outputSchema: the exact top-level shape each tool returns (nested objects are
// typed, not spelled out, to keep tools/list small). ok:false carries code+error.
const S = { type: 'string' } as const;
const O = { type: 'object' } as const;
const B = { type: 'boolean' } as const;
const I = { type: 'integer' } as const;
const ERR = { code: S, error: S } as const;
const outSchema = (properties: Record<string, unknown>) =>
  ({ type: 'object', required: ['ok'], properties: { ok: { type: 'boolean', description: 'false: see code, error' }, ...properties } }) as const;

export const MCP_TOOLS = [
  {
    name: 'prepare_quote',
    title: 'Prepare an on-chain quote',
    description:
      'Prepare an on-chain BlazePhoenix quote to run on YOUR OWN RPC. Returns the exact eth_call (Quoter address + calldata, '
      + 'as a ready JSON-RPC request and a curl line) plus a `request` object. Run the call on your node, then pass '
      + '`request` and the result hex to decode_quote. This server performs no RPC.',
    inputSchema: { type: 'object', required: ['chain', 'in', 'out', 'amountIn'], properties: QUOTE_PARAMS },
    outputSchema: outSchema({
      mode: { const: 'prepare' }, chainId: I, protocolVersion: S, contracts: O, call: O, rpcRequest: O, curl: S,
      request: O, decode: O, note: S, ...ERR,
    }),
    annotations: { title: 'Prepare an on-chain quote', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'decode_quote',
    title: 'Decode a quote result',
    description:
      'Decode the eth_call result YOUR node returned for a prepare_quote call: net output after the 0.28% fee, the minimum the '
      + 'Router enforces on-chain, price impact, the Phoenix Check verdict (ok / caution / danger / blocked — fails closed) '
      + 'and, with a recipient, verified unsigned calldata. Pure computation.',
    inputSchema: {
      type: 'object',
      required: ['request', 'result'],
      properties: {
        request: { type: 'object', description: 'the `request` object prepare_quote returned, verbatim' },
        result: { type: 'string', description: 'the 0x hex result of the eth_call on your node' },
      },
    },
    outputSchema: outSchema({
      mode: { enum: ['preview', 'exact'] }, chainId: I, protocolVersion: S, tokenIn: S, tokenOut: S, amountIn: S,
      amountOut: S, grossAmountOut: S, quote: O, route: O, checks: O, exact: O, tx: O, minOut: S, deadline: S, entry: S,
      encodedBy: S, txError: O, approval: O, wrapRequired: B, unwrapAfter: B, executeWith: O, meta: O, ...ERR,
    }),
    annotations: { title: 'Decode a quote result', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_deployments',
    title: 'Deployment registry',
    description:
      'The versioned BlazePhoenix deployment registry: Core, Hub, Solver, Quoter and Router addresses per chain and protocol '
      + 'version (1.0.0 live; 2.0.0 the final generation), and which version each chain runs now.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: outSchema({ schema: I, updatedAt: S, versions: { type: 'array' }, active: O, localServer: S }),
    annotations: { title: 'Deployment registry', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_abi',
    title: 'Contract ABI',
    description:
      'The JSON ABI of one BlazePhoenix contract, generated from the Solidity sources, with the source revision it was built '
      + 'from. Use it to encode your own calls to the addresses get_deployments returns, or pass `errors` to decode a revert '
      + 'reason from a failed swap or quote. Returns { contract, revision, abi }; an unknown name returns ok:false with the '
      + 'accepted list. Pure lookup, no RPC.',
    inputSchema: {
      type: 'object',
      required: ['contract'],
      properties: {
        contract: {
          type: 'string',
          enum: ['quoter', 'router', 'solver', 'hub', 'core', 'errors'],
          description: 'quoter (quotes and previews) | router (swap entry point) | solver | hub | core | errors (the protocol custom-error set, for decoding reverts)',
        },
      },
    },
    outputSchema: outSchema({ contract: S, revision: S, abi: { type: 'array' }, ...ERR }),
    annotations: { title: 'Contract ABI', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
] as const;

type Json = Record<string, unknown>;

const json = (body: Json, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...MCP_CORS_HEADERS },
  });

const rpcResult = (id: unknown, result: Json) => json({ jsonrpc: '2.0', id, result });
const rpcError = (id: unknown, code: number, message: string, status = 200, data?: Json) =>
  json({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }, status);

const ABIS: Record<string, readonly unknown[]> = {
  quoter: QUOTER_ABI, router: ROUTER_ABI, solver: SOLVER_ABI, hub: HUB_ABI, core: CORE_ABI, errors: BLAZE_ERRORS_ABI,
};

/** Every tool is pure: no fetch, no RPC. isError mirrors the payload's ok flag;
 *  body is the same object as text, for structuredContent. */
export function callTool(name: string, args: Json): { text: string; isError: boolean; body: Json } {
  const out = (body: Json) => ({ text: JSON.stringify(body), isError: body.ok === false, body });
  if (name === 'prepare_quote') {
    const sp = new URLSearchParams();
    for (const k of Object.keys(QUOTE_PARAMS)) {
      const v = args[k];
      if (v === undefined || v === null || v === '') continue;
      if (k === 'exact') { if (v === true || v === 'true' || v === '1') sp.set('exact', '1'); continue; }
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') sp.set(k, String(v));
    }
    if (!sp.has('chain')) sp.set('chain', 'base');
    const r = prepareFromParams(sp);
    return out(r.ok ? r.body : { ok: false, code: r.code, error: r.message });
  }
  if (name === 'decode_quote') {
    const r = decodeQuote(args.request, args.result);
    return out(r.ok ? r.body : { ok: false, code: r.code, error: r.message });
  }
  if (name === 'get_deployments') {
    return out({ ok: true, ...registryDocument(), localServer: LOCAL_SERVER });
  }
  if (name === 'get_abi') {
    const c = String(args.contract ?? '').toLowerCase();
    const abi = Object.prototype.hasOwnProperty.call(ABIS, c) ? ABIS[c] : undefined; // own keys only
    return out(abi ? { ok: true, contract: c, revision: ABI_SOURCE_REVISION, abi } : { ok: false, code: 'bad_contract', error: `contract must be one of: ${Object.keys(ABIS).join(', ')}` });
  }
  return out({ ok: false, code: 'unknown_tool', error: `unknown tool: ${name}. Quoting on your own RPC lives in the local server — ${LOCAL_SERVER}` });
}

export async function handleMcp(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
  // Stateless server: no SSE stream to offer on GET (the spec allows 405 here).
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'MCP streamable-HTTP: POST JSON-RPC to this endpoint. Docs: https://blazephoenix.xyz/agents' }, 405);
  }

  let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Json };
  // Same body ceiling as the REST endpoints (512 KiB), applied before anything is parsed.
  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.code === 'too_large'
      ? rpcError(null, -32600, body.message, 413)
      : rpcError(null, -32700, 'parse error');
  }
  msg = body.value as typeof msg;
  if (Array.isArray(msg)) return rpcError(null, -32600, 'batching not supported');

  const { id, method, params } = msg;
  // Streamable HTTP: an unsupported MCP-Protocol-Version header is a 400. A
  // missing header is allowed (pre-2025-06-18 clients, and initialize itself).
  // The error shape (-32022 + supported list) is the one 2026-07-28 clients
  // use to fall back; older clients only need the 400.
  const hdr = request.headers.get('mcp-protocol-version');
  if (hdr !== null && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(hdr.trim())) {
    return rpcError(id ?? null, -32022, `unsupported MCP-Protocol-Version: ${hdr.slice(0, 40)}`, 400,
      { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: hdr.slice(0, 40) });
  }
  // Notifications (no id) are acknowledged without a body.
  if (id === undefined || id === null) return new Response(null, { status: 202, headers: MCP_CORS_HEADERS });

  try {
    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: 'blazephoenix', title: 'BlazePhoenix registry + codec (zero RPC)', version: '2.0.0' },
        instructions:
          'BlazePhoenix on-chain DEX aggregator (Base, Ethereum, Optimism, Arbitrum, Robinhood Chain). Quotes run on the '
          + 'user\'s OWN RPC — this hosted endpoint performs no RPC: prepare_quote gives the exact eth_call to run on the '
          + 'user\'s node, decode_quote turns the result into the quote, the Phoenix Check and verified calldata.',
      });
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') return rpcResult(id, { tools: MCP_TOOLS as unknown as Json[] });
    if (method === 'tools/call') {
      const name = (params?.name as string) ?? '';
      const args = (params?.arguments as Json) ?? {};
      const { text, isError, body } = callTool(name, args);
      return rpcResult(id, { content: [{ type: 'text', text }], structuredContent: body, isError });
    }
    return rpcError(id, -32601, `method not found: ${method}`);
  } catch {
    return rpcError(id, -32603, 'internal error');
  }
}
