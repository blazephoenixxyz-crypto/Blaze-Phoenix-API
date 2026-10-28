// Source checks that need no network, no key and no build.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

let passed = 0;
let failed = 0;
const check = (name, cond) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
};

// The Exact Pass answers each pool's callback with a revert and never pays, so no
// token moves: it cannot measure a token's own transfer fee or block. The MCP tool
// description must not promise that it does.
const mcp = read('worker/mcp.ts');
check('exact pass: worker/mcp.ts does not promise an execution-grade dry-run',
  !mcp.includes('execution-grade dry-run') && !mcp.includes('including transfer-fee tokens'));
check('exact pass: worker/mcp.ts points to a simulation from the holder',
  /exact:[^\n]*simulate the swap from the holder/.test(mcp));

// Provider keys are injected at deploy time and never committed.
const chains = read('src/config/chains.ts');
check('provider keys are blank in the published source',
  /ALCHEMY_KEYS[^=\n]*=\s*\[\s*\]/.test(chains) || /ALCHEMY_KEYS[^=\n]*=\s*['"]{2}/.test(chains));
check('DRPC key is blank in the published source', /DRPC_KEY[^=\n]*=\s*['"]{2}/.test(chains));

// One integer rule (<= 2^256-1), one body ceiling for REST and /mcp, one block-time table.
const codec = read('worker/codec.ts');
const api = read('worker/quoteApi.ts');
check('integer rule: one shared uint256 check, no 77-digit regex left in quoteApi',
  /export const isUint256Str/.test(codec) && !/\{1,77\}/.test(api) && /isUint256Str\(rawAmt/.test(api));
check('/mcp reads its body through the same capped reader as REST (413)',
  /readJsonBody\(request\)/.test(mcp) && /too_large[^\n]*\n?[^\n]*413|413/.test(mcp));
check('block times: one table, Robinhood 0.104 s, read by the API',
  /4663: 0\.104/.test(read('src/config/blockTime.ts')) && /BLOCK_TIME_SEC/.test(api) && !/4663: 2,/.test(api));
check('exact decode: the envelope carries checks, and 2.x exactOut is a floor within one fee of the bound',
  /checks: exactChecks\(/.test(codec) && /exactOut <= want - protocolFeeOn\(want\)/.test(codec));

// V2 (2.0.0, pending) is not deployed to Ethereum L1; V1 on Ethereum stays live.
const dep = read('src/config/deployments.ts');
const v2 = dep.slice(dep.indexOf("version: '2.0.0'"), dep.indexOf("version: '1.0.0'"));
const v1 = dep.slice(dep.indexOf("version: '1.0.0'"));
check('registry: 2.0.0 carries no chain 1 entry', v2.includes('chains:') && !/^\s*1:\s*[{]/m.test(v2));
check('registry: 1.0.0 still lists chain 1', /^\s*1:\s*[{]/m.test(v1));

console.log(failed === 0 ? `✅ ${passed} passed, 0 failed` : `❌ ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
