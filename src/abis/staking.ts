// =============================================================================
//  BlazePhoenixStaking ABI — GENERATED from the Blaze-Phoenix-Staking Solidity
//  source (scripts/gen-staking-abi.mjs → staking.generated.ts), never written by
//  hand: every function, event and error the source declares, and nothing it
//  does not. The deployments it is read from are in config/staking.ts.
// =============================================================================

export { STAKING_ABI, STAKING_ABI_SOURCE_REVISION } from './staking.generated';

// Immutable parameters from the contract (constants). Known ahead of deploy.
export const STAKING_PARAMS = {
  totalEmission: '180,000,000',
  emissionYears: 7,
  maxStakePerWallet: '30,000,000',
  lockMinDays: 90,
  lockMaxDays: 2555,
  maxLtvPct: 50,
  liquidationLtvPct: 95,
  liquidationBonusPct: 5,
  reserveFactorPct: 3,
  boostMaxX: '2.75',
  interestFloorPct: 1,
  kinkUtilPct: 80,
  kinkRatePct: 5,
} as const;

export const SECONDS_PER_YEAR = 31_536_000n;
