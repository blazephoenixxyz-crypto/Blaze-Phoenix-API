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

console.log(failed === 0 ? `✅ ${passed} passed, 0 failed` : `❌ ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
