// =============================================================================
//  GET /api/version — which source commit this Worker was deployed from.
//
//  The commit is handed in at deploy time, never guessed at runtime:
//    wrangler deploy --var COMMIT_SHA:$(git rev-parse HEAD)
//  Only a full 40-hex lowercase SHA is reported; anything else (absent, short,
//  a branch name, padded, upper case, all zeros) is `commit: null`,
//  `commitKnown: false`. Absent is not zero. A mirror compares this commit with
//  its own HEAD to prove the served code is the published code.
// =============================================================================

import { SITE } from '../src/config/site';
import { CORS_HEADERS } from './quoteApi';

export function handleVersion(env: { COMMIT_SHA?: string }): Response {
  const sha = env.COMMIT_SHA;
  const known = typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) && !/^0{40}$/.test(sha);
  return new Response(JSON.stringify({
    ok: true,
    service: 'blazephoenix-api',
    commit: known ? sha : null,
    commitKnown: known,
    protocolVersion: SITE.protocol.version,
    note: 'commit = the source commit this Worker was deployed from (set at deploy: wrangler deploy --var COMMIT_SHA:$(git rev-parse HEAD)); null = not recorded',
  }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS_HEADERS },
  });
}
