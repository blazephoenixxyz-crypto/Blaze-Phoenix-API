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

import { CORS_HEADERS, prepareFromParams } from './quoteApi';
import { decodeQuote, registryDocument } from './codec';
import { QUOTER_ABI, ROUTER_ABI, SOLVER_ABI, HUB_ABI, CORE_ABI, BLAZE_ERRORS_ABI, ABI_SOURCE_REVISION } from '../src/abis/blaze';

const PROTOCOL_VERSION = '2025-06-18';

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
  exact: { type: 'boolean', description: 'true → previewPlanExact (execution-grade dry-run, no calldata)' },
  version: { type: 'string', description: 'protocol version: latest (default) | 1 | 2 | 2.0.0' },
} as const;

export const MCP_TOOLS = [
  {
    name: 'prepare_quote',
    description:
      'Prepare an on-chain BlazePhoenix quote to run on YOUR OWN RPC. Returns the exact eth_call (Quoter address + calldata, '
      + 'as a ready JSON-RPC request and a curl line) plus a `request` object. Run the call on your node, then pass '
      + '`request` and the result hex to decode_quote. This server performs no RPC. ' + LOCAL_SERVER,
    inputSchema: { type: 'object', required: ['chain', 'in', 'out', 'amountIn'], properties: QUOTE_PARAMS },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'decode_quote',
    description:
      'Decode the eth_call result YOUR node returned for a prepare_quote call: net output after the 0.28% fee, the minimum the '
      + 'Router enforces on-chain, price impact, the Phoenix Check verdict (ok / caution / danger / blocked — fails closed; quote it '
      + 'when asked if a swap is safe) and, with a recipient, verified unsigned calldata. Pure computation.',
    inputSchema: {
      type: 'object',
      required: ['request', 'result'],
      properties: {
        request: { type: 'object', description: 'the `request` object prepare_quote returned, verbatim' },
        result: { type: 'string', description: 'the 0x hex result of the eth_call on your node' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_deployments',
    description:
      'The versioned BlazePhoenix deployment registry: Core, Hub, Solver, Quoter and Router addresses per chain and protocol '
      + 'version (1.0.0 live; 2.0.0 the final generation), and which version each chain runs now.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_abi',
    description: 'ABI of a BlazePhoenix contract, generated from the Solidity sources (quoter | router | solver | hub | core | errors).',
    inputSchema: {
      type: 'object',
      required: ['contract'],
      properties: { contract: { type: 'string', enum: ['quoter', 'router', 'solver', 'hub', 'core', 'errors'] } },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
] as const;

type Json = Record<string, unknown>;

const json = (body: Json, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });

const rpcResult = (id: unknown, result: Json) => json({ jsonrpc: '2.0', id, result });
const rpcError = (id: unknown, code: number, message: string) =>
  json({ jsonrpc: '2.0', id, error: { code, message } });

const ABIS: Record<string, readonly unknown[]> = {
  quoter: QUOTER_ABI, router: ROUTER_ABI, solver: SOLVER_ABI, hub: HUB_ABI, core: CORE_ABI, errors: BLAZE_ERRORS_ABI,
};

/** Every tool is pure: no fetch, no RPC. isError mirrors the payload's ok flag. */
export function callTool(name: string, args: Json): { text: string; isError: boolean } {
  const out = (body: Json) => ({ text: JSON.stringify(body), isError: body.ok === false });
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
    const abi = ABIS[c];
    return out(abi ? { ok: true, contract: c, revision: ABI_SOURCE_REVISION, abi } : { ok: false, code: 'bad_contract', error: `contract must be one of: ${Object.keys(ABIS).join(', ')}` });
  }
  return out({ ok: false, code: 'unknown_tool', error: `unknown tool: ${name}. Quoting on your own RPC lives in the local server — ${LOCAL_SERVER}` });
}

export async function handleMcp(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  // Stateless server: no SSE stream to offer on GET (the spec allows 405 here).
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'MCP streamable-HTTP: POST JSON-RPC to this endpoint. Docs: https://blazephoenix.xyz/agents' }, 405);
  }

  let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Json };
  try { msg = await request.json(); } catch { return rpcError(null, -32700, 'parse error'); }
  if (Array.isArray(msg)) return rpcError(null, -32600, 'batching not supported');

  const { id, method, params } = msg;
  // Notifications (no id) are acknowledged without a body.
  if (id === undefined || id === null) return new Response(null, { status: 202, headers: CORS_HEADERS });

  try {
    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'blazephoenix', title: 'BlazePhoenix registry + codec (zero RPC)', version: '2.0.0' },
        instructions:
          'BlazePhoenix on-chain DEX aggregator (Base, Ethereum, Optimism, Arbitrum, Robinhood Chain). Quotes run on the '
          + 'user\'s OWN RPC — this hosted endpoint performs no RPC: prepare_quote gives the exact eth_call to run on the '
          + 'user\'s node, decode_quote turns the result into the quote, the Phoenix Check and verified calldata. '
          + LOCAL_SERVER + '. Full knowledge corpus: https://blazephoenix.xyz/llms-full.txt',
      });
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') return rpcResult(id, { tools: MCP_TOOLS as unknown as Json[] });
    if (method === 'tools/call') {
      const name = (params?.name as string) ?? '';
      const args = (params?.arguments as Json) ?? {};
      const { text, isError } = callTool(name, args);
      return rpcResult(id, { content: [{ type: 'text', text }], isError });
    }
    return rpcError(id, -32601, `method not found: ${method}`);
  } catch {
    return rpcError(id, -32603, 'internal error');
  }
}
