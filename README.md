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
```

## What differs from the deployed source

This tree was copied from the production source at commit `4ffce4b` of the private
site repository. Three things differ, and nothing else under `worker/` and `src/`:

1. **Provider keys are empty.** `ALCHEMY_KEYS` and `DRPC_KEY` in
   `src/config/chains.ts` are blank. The production values are API credentials,
   injected at deploy time.
2. **Comments only.** The header comments of `worker/requestClass.ts` are in
   English, and one comment in `worker/index.ts` is shortened. No code changed.
3. **Not part of this API.** The website UI and the Telegram handler live in the
   site repository.

With comments stripped, the only remaining differences are the two empty key
values above.

## Security

To report a vulnerability, see [SECURITY.md](./SECURITY.md).

Related repositories:
[SDK](https://github.com/blazephoenixxyz-crypto/SDK) ·
[MCP server](https://github.com/blazephoenixxyz-crypto/blazephoenix-mcp) ·
[Contracts](https://github.com/blazephoenixxyz-crypto/Blaze-Phoenix-Dex)
