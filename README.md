# BlazePhoenix API

Source of the BlazePhoenix HTTP API and remote MCP endpoint, published so that
security researchers can read exactly what they are testing.

The API is served from **https://blazephoenix.xyz** (`/api/*` and `/mcp`). It runs
as a Cloudflare Worker; this repository holds the Worker source and the small set
of modules it imports.

## Design property: your RPC, not ours

The quote path performs **no RPC on our side**. `GET /api/quote/prepare` returns the
exact `eth_call` to run on *your* node, and `POST /api/quote/decode` is a pure
function that turns your node's answer into the quote, the Phoenix Check verdict
and verified calldata. The SDK and the local MCP server do both steps in-process.

The legacy relay endpoints (`GET /api/quote`, `POST /api/quote/batch`) are retired:
they answer `400 rpc_required` with the prepared call inline.

## Networks and versions

Protocol V1 is live on Base (8453), Ethereum (1), Optimism (10), Arbitrum (42161) and
Robinhood Chain (4663). V2 (Router, Solver, Hub, Quoter and Gate, with the Core and Math
libraries) is pending, so `GET /api/deployments` lists it as pending, and it is not planned
for Ethereum L1. `prepare` takes an optional `version` (`latest`, `1`, `2` or a full version
such as `2.0.0`); without it, each chain uses its newest deployed version.

## Cost, what you bring, limits

- **Free and keyless.** No API key, no signup, open CORS.
- **You bring the RPC node for quotes.** `prepare` hands you the `eth_call`; you run it
  on your own node and send the answer to `decode`. The SDK and the local MCP server read
  their node URL from your configuration (`BLAZEPHOENIX_RPC_URL` or
  `BLAZEPHOENIX_RPC_<CHAIN>`).
- **Nothing to bring for the other reads.** `/api/stats`, `/api/tape`, `/api/badge`,
  `/api/verify` and `/solvency` read the chain from our side.
- **Batch limits.** `POST /api/quote/prepare` takes up to 32 requests, and
  `POST /api/quote/decode` up to 32 items.
- **Metering.** Only requests that Cloudflare's bot score marks as suspect are metered
  (`worker/requestClass.ts`); verified crawlers and ordinary clients are not.

For agents, [`llms.txt`](./llms.txt) describes this API in the [llmstxt.org](https://llmstxt.org) format.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/api` | Discovery root: endpoints, docs, SDK, contact |
| GET | `/api/openapi.json` | The OpenAPI description of this API |
| GET | `/api/quote/prepare` | The `eth_call` to run on your node |
| POST | `/api/quote/prepare` | Several prepared calls as one JSON-RPC batch |
| POST | `/api/quote/decode` | Your node's answer to quote, Phoenix Check, calldata (pure) |
| GET | `/api/deployments` | Versioned contract registry per chain |
| GET | `/api/abi` | Generated ABI of a protocol contract |
| GET | `/api/manifest` | Contracts, token and event topics |
| GET | `/api/health` | Service health and per-chain flags |
| GET | `/api/stats` | Fills and unique traders from on-chain `Swap` events |
| GET | `/api/tape` | Recent swaps |
| GET | `/api/badge` | shields.io endpoint for the staking `isSolvent()` badge |
| GET | `/api/verify` | Re-executes a proof-carrying fact live on-chain |
| GET | `/solvency` | Staking solvency view |
| POST | `/mcp` | Remote MCP endpoint (streamable HTTP, stateless) |
| GET | `/api/quote`, POST `/api/quote/batch` | Retired; answer `400 rpc_required` |

`worker/openapi.ts` is the authoritative description of request and response shapes.

## Layout

```
worker/   the Worker: router, quote codec, MCP tools, solvency, verify, OpenAPI
src/      the ABIs, chain and deployment config, and helpers the Worker imports
```

## Check it yourself

```bash
npm install
npm run typecheck
npm test
```

## What differs from the deployed source

This tree was copied from the production source at commit `4ffce4b` of the private
site repository. Four things differ, and nothing else under `worker/` and `src/`:

1. **Provider keys are empty.** `ALCHEMY_KEYS` and `DRPC_KEY` in
   `src/config/chains.ts` are blank. The production values are API credentials,
   injected at deploy time.
2. **Comments only.** The header comments of `worker/requestClass.ts` are in
   English, and one comment in `worker/index.ts` is shortened. No code changed.
3. **Not part of this API.** The website UI and the Telegram handler live in the
   site repository.
4. **One parameter description.** The `exact` parameter of the MCP quote tools in
   `worker/mcp.ts` says what `previewPlanExact` measures: each concentrated leg on its
   own pool, with no tokens moved, so a token's own transfer fee is tested by simulating
   the swap from the holder.

With comments stripped, the only remaining differences are the two empty key
values and the parameter description above.

## Security

To report a vulnerability, see [SECURITY.md](./SECURITY.md).
This API is in scope of the public [bug bounty](https://blazephoenix.xyz/bounty).

Related repositories:
[SDK](https://github.com/blazephoenixxyz-crypto/SDK) ·
[MCP server](https://github.com/blazephoenixxyz-crypto/blazephoenix-mcp) ·
[Contracts](https://github.com/blazephoenixxyz-crypto/Blaze-Phoenix-Dex)

## License

MIT, see [LICENSE](./LICENSE). The protocol contracts in
[Blaze-Phoenix-Dex](https://github.com/blazephoenixxyz-crypto/Blaze-Phoenix-Dex) carry their own license.
