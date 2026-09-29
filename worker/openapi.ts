// =============================================================================
//  GET /api/openapi.json — machine-readable spec of the public integration
//  surface. Lets integrators codegen clients and lets AI agents discover and
//  wire the API without reading a docs page (pairs with /llms.txt).
// =============================================================================

import { CORS_HEADERS, MAX_BATCH, MAX_PREPARE_BATCH } from './quoteApi';

const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', enum: [false] },
    code: { type: 'string', description: 'stable machine code (bad_*, not_deployed, no_route, decode_failed, rpc_required…)' },
    error: { type: 'string' },
  },
  required: ['ok', 'code', 'error'],
} as const;

const QUOTE_SCHEMA = {
  type: 'object',
  description:
    'A quote decoded from YOUR node\'s eth_call answer (Quoter.previewPlan / previewAndEncode). Numeric fields travel as decimal strings.',
  properties: {
    ok: { type: 'boolean', enum: [true] },
    mode: { type: 'string', enum: ['preview', 'exact'] },
    chainId: { type: 'integer' },
    protocolVersion: { type: 'string', description: 'deployment version that answered (1.0.0 | 2.0.0)' },
    tokenIn: { type: 'string' },
    tokenOut: { type: 'string' },
    amountIn: { type: 'string' },
    amountOut: {
      type: 'string',
      description: 'net output after the protocol fee — compare THIS across venues',
    },
    quote: {
      type: 'object',
      properties: {
        grossOut: { type: 'string' },
        protocolFee: { type: 'string' },
        netOut: { type: 'string' },
        ironFloor: { type: 'string' },
        effectiveMinOut: { type: 'string' },
        impactBps: { type: 'integer', maximum: 10000 },
        estGas: { type: 'string' },
        hops: { type: 'integer' },
        legs: { type: 'integer' },
        canExecute: { type: 'boolean' },
        hasSurplus: { type: 'boolean' },
        feeBps: { type: 'integer' },
      },
    },
    route: {
      type: 'object',
      description: 'full executable route struct — pass verbatim to Router.swapExactIn',
    },
    checks: {
      type: 'object',
      description:
        'Phoenix Check — deterministic quote invariants for agents and answer engines. '
        + 'Fails closed (verdict: blocked | danger | caution | ok).',
      properties: {
        verdict: { type: 'string', enum: ['blocked', 'danger', 'caution', 'ok'] },
        priceImpact: {
          type: 'object',
          properties: {
            bps: { type: 'integer' },
            verdict: { type: 'string', enum: ['blocked', 'danger', 'caution', 'ok'] },
            hardLineBps: { type: 'integer', description: '2000 = 20%, the bad-fill line' },
          },
        },
        ironFloor: {
          type: 'object',
          properties: {
            enforcedOnChain: { type: 'boolean' },
            armed: { type: 'boolean' },
            ironFloor: { type: 'string' },
            effectiveMinOut: { type: 'string' },
          },
        },
        crossCheck: {
          type: 'object',
          properties: {
            basis: { type: 'string' },
            reproducible: { type: 'boolean' },
          },
        },
      },
    },
    tx: {
      type: 'object',
      description: 'present when `recipient` was prepared: unsigned, ready for sendTransaction. On 2.x the bytes are the Quoter\'s own (previewAndEncode), verified field by field.',
      properties: {
        to: { type: 'string', description: 'the Router of this version (re-resolved from the registry, never from the request)' },
        data: { type: 'string' },
        value: { type: 'string', description: '"0", or amountIn for swapExactInNative (2.x native ETH input)' },
      },
    },
    minOut: { type: 'string', description: 'minimum encoded in tx: netOut − slippage, never below the on-chain floor' },
    entry: { type: 'string', enum: ['swapExactIn', 'swapExactInNative'] },
    encodedBy: { type: 'string', enum: ['quoter', 'site'] },
    approval: { type: 'object', description: 'ERC-20 input: approve the Router for tokenIn before sending tx' },
    txError: { type: 'object', description: 'why no tx was emitted (not_executable, calldata_mismatch, wrap_required)' },
    wrapRequired: { type: 'boolean', description: 'in=ETH on a 1.x Router — wrap to WETH before swapping' },
    unwrapAfter: { type: 'boolean', description: 'out=ETH — the Router delivers WETH' },
    meta: {
      type: 'object',
      properties: {
        decodedBy: { type: 'string' },
        rpc: { type: 'string', enum: ['yours'] },
        version: { type: 'string' },
      },
    },
  },
  required: ['ok', 'mode', 'chainId', 'tokenIn', 'tokenOut', 'amountIn', 'amountOut', 'route'],
} as const;

const QUOTE_PARAMS = [
  {
    name: 'chain', in: 'query', required: true,
    description: 'chain id or name: 8453/base · 1/eth · 10/optimism · 42161/arbitrum · 4663/robinhood',
    schema: { type: 'string' },
  },
  {
    name: 'in', in: 'query', required: true,
    description: 'input token: 0x-address or ETH/WETH/USDC/BZPX (anything else by address — the API never guesses a token)',
    schema: { type: 'string' },
  },
  {
    name: 'out', in: 'query', required: true,
    description: 'output token: 0x-address or ETH/WETH/USDC/BZPX',
    schema: { type: 'string' },
  },
  {
    name: 'amountIn', in: 'query', required: true,
    description: 'input amount in the token’s base units (integer, wei-style)',
    schema: { type: 'string', pattern: '^[0-9]{1,77}$' },
  },
  {
    name: 'recipient', in: 'query', required: false,
    description: '0x-address — response then includes ready-to-send tx calldata',
    schema: { type: 'string' },
  },
  {
    name: 'slippageBps', in: 'query', required: false,
    description: '0–5000 (default 50); minOut = netOut − slippage, never below the on-chain floor',
    schema: { type: 'integer', minimum: 0, maximum: 5000 },
  },
  {
    name: 'userMinOut', in: 'query', required: false,
    description: 'explicit minimum output (base units) — tightens the on-chain floor',
    schema: { type: 'string', pattern: '^[0-9]{1,78}$' },
  },
  {
    name: 'version', in: 'query', required: false,
    description: 'protocol version: latest (default) | 1 | 2 | 2.0.0 — see /api/deployments',
    schema: { type: 'string' },
  },
  {
    name: 'deadlineSec', in: 'query', required: false,
    description: 'tx deadline horizon in seconds, 10–3600 (default 120)',
    schema: { type: 'integer', minimum: 10, maximum: 3600 },
  },
  {
    name: 'exact', in: 'query', required: false,
    description: 'exact=1 → execution-grade re-quote (previewPlanExact, slower)',
    schema: { type: 'string', enum: ['1'] },
  },
] as const;

export const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'BlazePhoenix Integration API (your RPC)',
    version: '2.0.0',
    description:
      'On-chain DEX-aggregator integration for Base, Ethereum, Optimism, Arbitrum and Robinhood Chain. '
      + 'Quotes run on YOUR RPC: this API performs no RPC for integrators. prepare → run the returned '
      + 'eth_call on your node → decode (pure) gives the quote, the Phoenix Check and, with `recipient`, '
      + 'verified unsigned Router calldata. /api/deployments publishes the versioned contract registry. '
      + 'No API key, no signup, open CORS. In-process instead: npm i @blazephoenix/sdk viem, or the local '
      + 'MCP server (npx -y @blazephoenix/mcp). Playground: https://blazephoenix.xyz/?tab=api',
    contact: { email: 'contact@blazephoenix.xyz', url: 'https://blazephoenix.xyz/?tab=api' },
  },
  servers: [{ url: 'https://blazephoenix.xyz' }],
  paths: {
    '/api/quote/prepare': {
      get: {
        operationId: 'prepareQuote',
        summary: 'The eth_call to run on YOUR node (zero RPC here)',
        parameters: QUOTE_PARAMS,
        responses: {
          '200': { description: 'prepared call + request to echo to decode', content: { 'application/json': { schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean', enum: [true] },
                    mode: { type: 'string', enum: ['prepare'] },
                    protocolVersion: { type: 'string' },
                    call: { type: 'object', description: '{ to: Quoter, data, function, signature }' },
                    rpcRequest: { type: 'object', description: 'ready JSON-RPC eth_call body for your node' },
                    curl: { type: 'string' },
                    request: { type: 'object', description: 'echo verbatim to /api/quote/decode' },
                  },
                } } } },
          '400': { description: 'invalid parameter (bad_*) or version not deployed (not_deployed)', content: { 'application/json': { schema: ERROR_SCHEMA } } },
        },
      },
      post: {
        operationId: 'prepareQuoteBatch',
        summary: `Up to ${MAX_PREPARE_BATCH} prepared calls as ONE JSON-RPC batch for your node`,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            properties: { requests: { type: 'array', maxItems: MAX_PREPARE_BATCH, items: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } } } },
            required: ['requests'],
          } } },
        },
        responses: {
          '200': { description: '{ rpcBatch, items } — ids in rpcBatch are item indexes', content: { 'application/json': {} } },
          '400': { description: 'invalid envelope', content: { 'application/json': { schema: ERROR_SCHEMA } } },
        },
      },
    },
    '/api/quote/decode': {
      post: {
        operationId: 'decodeQuote',
        summary: 'Your node\'s eth_call answer → quote, Phoenix Check, verified calldata (pure)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              request: { type: 'object', description: 'the `request` from /api/quote/prepare, verbatim' },
              result: { type: 'string', description: '0x hex result from your node' },
              items: { type: 'array', maxItems: MAX_PREPARE_BATCH, description: 'or many: [{ request, result }]' },
            },
          } } },
        },
        responses: {
          '200': { description: 'decoded quote', content: { 'application/json': { schema: QUOTE_SCHEMA } } },
          '400': { description: 'invalid request/result', content: { 'application/json': { schema: ERROR_SCHEMA } } },
          '422': { description: 'empty result (no_route) or not a Quoter answer (decode_failed)', content: { 'application/json': { schema: ERROR_SCHEMA } } },
        },
      },
    },
    '/api/deployments': {
      get: {
        operationId: 'getDeployments',
        summary: 'Versioned registry: Core/Hub/Solver/Quoter/Router per chain and version (what SDK 1.x and the MCP server resolve against)',
        responses: { '200': { description: 'registry (schema 1)', content: { 'application/json': {} } } },
      },
    },
    '/api/abi': {
      get: {
        operationId: 'getAbi',
        summary: 'Generated ABI of a protocol contract (quoter | router | solver | hub | core | errors)',
        parameters: [{ name: 'contract', in: 'query', required: false, schema: { type: 'string' } }],
        responses: { '200': { description: 'abi', content: { 'application/json': {} } } },
      },
    },
    '/api/quote': {
      get: {
        operationId: 'getQuote',
        deprecated: true,
        summary: 'Retired relay: answers 400 rpc_required with the prepared call inline — quotes run on your RPC',
        parameters: QUOTE_PARAMS,
        responses: {
          '400': { description: 'rpc_required (+ prepared) or a bad_* parameter', content: { 'application/json': { schema: ERROR_SCHEMA } } },
        },
      },
    },
    '/api/quote/batch': {
      post: {
        operationId: 'getQuoteBatch',
        deprecated: true,
        summary: `Retired relay (max ${MAX_BATCH}): answers 400 rpc_required with the prepared calls — use POST /api/quote/prepare`,
        responses: {
          '400': { description: 'rpc_required (+ prepared)', content: { 'application/json': { schema: ERROR_SCHEMA } } },
        },
      },
    },
    '/api/manifest': {
      get: {
        operationId: 'getManifest',
        summary: 'Machine-readable protocol manifest (contracts, token, event topics)',
        responses: { '200': { description: 'manifest', content: { 'application/json': {} } } },
      },
    },
    '/api': {
      get: {
        operationId: 'getDiscovery',
        summary: 'Discovery root — the API describes itself (endpoints, docs, SDK, contact)',
        responses: { '200': { description: 'discovery index', content: { 'application/json': {} } } },
      },
    },
    '/api/health': {
      get: {
        operationId: 'getHealth',
        summary: 'Service health + per-chain live flags (no upstream calls — poll freely)',
        responses: { '200': { description: 'health', content: { 'application/json': {} } } },
      },
    },
    '/api/stats': {
      get: {
        operationId: 'getStats',
        summary: 'Live protocol stats: fills + unique traders per chain from on-chain Swap events (reproducible; cached ~5min). Read totalFills TOGETHER with chainsOk/chainsTotal: it sums only the chains that answered, so with chainsOk=0 it is the sum of nothing, not a measured zero. `measured` is the boolean shortcut for chainsOk > 0.',
        responses: { '200': { description: 'stats', content: { 'application/json': {} } } },
      },
    },
    '/api/badge': {
      get: {
        operationId: 'getBadge',
        summary: 'shields.io endpoint JSON: live staking isSolvent() badge — embed with https://img.shields.io/endpoint?url=…/api/badge',
        responses: { '200': { description: 'badge (schemaVersion 1)', content: { 'application/json': {} } } },
      },
    },
    '/api/verify': {
      get: {
        operationId: 'verifyFact',
        summary: 'Re-execute a proof-carrying fact from /facts.json live on-chain (zero-argument reads only) and return the value with its block height; without ?fact, lists the verifiable fact ids',
        parameters: [{
          name: 'fact', in: 'query', required: false,
          description: 'fact id from /facts.json (e.g. leg-floor, solvency-live)',
          schema: { type: 'string' },
        }],
        responses: {
          '200': { description: 'live value + block height (or the list of verifiable ids)', content: { 'application/json': {} } },
          '404': { description: 'unknown fact id', content: { 'application/json': { schema: ERROR_SCHEMA } } },
          '422': { description: 'fact carries a prose proof, not a zero-argument call — reproduce by hand', content: { 'application/json': { schema: ERROR_SCHEMA } } },
          '502': { description: 'all upstream RPCs failed', content: { 'application/json': { schema: ERROR_SCHEMA } } },
        },
      },
    },
  },
} as const;

export function handleOpenapi(): Response {
  return new Response(JSON.stringify(OPENAPI), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      ...CORS_HEADERS,
    },
  });
}
