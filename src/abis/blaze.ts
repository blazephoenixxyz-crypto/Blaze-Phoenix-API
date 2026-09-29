// =============================================================================
//  BlazePhoenix protocol ABIs — GENERATED from the Blaze-Phoenix-Dex Solidity
//  sources (solc 0.8.36), never written by hand. The generated file is a copy
//  of @blazephoenix/sdk's src/abis.generated.ts (mirrored under sdk/), and
//  `npm run test:mock` fails the day the two differ.
//
//  One ABI serves both generations: every function the site calls on 1.0.0
//  (previewPlan, previewPlanWithMinOut, previewPlanExact, swapExactIn,
//  swapExactInWithPermit2) has the identical signature and tuple layout in
//  2.0.0 — the selector tests in scripts/mock-tests.ts prove it against the
//  transcribed Solidity. 2.0.0 adds previewAndEncode, batchQuote,
//  swapExactInNative, swapBestExactIn, VERSION() and ExecutionProof; 1.0.0
//  routers additionally emit Surplus, appended below so their logs decode.
//
//  Regenerate: in the SDK repo, `npm i --no-save solc@0.8.36 && npm run gen:abis`,
//  then copy src/abis.generated.ts here and into sdk/src/.
// =============================================================================

import {
  QUOTER_ABI as QUOTER_ABI_GEN,
  ROUTER_ABI as ROUTER_ABI_GEN,
} from './blaze.generated';

export {
  CORE_ABI, HUB_ABI, SOLVER_ABI, BLAZE_ERRORS_ABI, ABI_SOURCE_REVISION,
} from './blaze.generated';

export const QUOTER_ABI = QUOTER_ABI_GEN;

/** 1.0.0 routers only: execution beat the quote, paid fee-exempt to the user. */
export const SURPLUS_EVENT_V1 = {
  type: 'event',
  name: 'Surplus',
  inputs: [
    { name: 'token', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
  ],
  anonymous: false,
} as const;

export const ROUTER_ABI = [...ROUTER_ABI_GEN, SURPLUS_EVENT_V1] as const;
