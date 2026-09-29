// =============================================================================
//  BlazePhoenixStaking ABI — matches the deployed contract (v3.0.0).
//  Mirrors BlazePhoenixStaking.sol exactly: the aggregate views getGlobalStats /
//  getUserInfo / solvency, the per-position helpers, and the user actions.
//  Drop the contract address in config/chains.ts (contracts.staking) to go live.
// =============================================================================

const SOLVENCY_REPORT = [
  { name: 'backing', type: 'uint256' },
  { name: 'owed', type: 'uint256' },
  { name: 'surplus', type: 'uint256' },
  { name: 'deficit', type: 'uint256' },
  { name: 'solvent', type: 'bool' },
  { name: 'collateralRatioWad', type: 'uint256' },
  { name: 'totalStaked', type: 'uint256' },
  { name: 'totalDebt', type: 'uint256' },
  { name: 'rewardReserve', type: 'uint256' },
  { name: 'protocolReserve', type: 'uint256' },
  { name: 'pendingDistribution', type: 'uint256' },
  { name: 'totalBadDebt', type: 'uint256' },
  { name: 'totalUncollectedInterest', type: 'uint256' },
] as const;

export const STAKING_ABI = [
  // ── Solvency / verification surface ──────────────────────────────────────
  { type: 'function', name: 'solvency', stateMutability: 'view', inputs: [], outputs: [{ name: 'r', type: 'tuple', components: SOLVENCY_REPORT }] },
  { type: 'function', name: 'isSolvent', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'collateralRatio', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'owed', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'backing', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'auditInvariants', stateMutability: 'view', inputs: [], outputs: [{ name: 'violations', type: 'uint8' }] },
  { type: 'function', name: 'emergencyMode', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },

  // ── Permissionless circuit-breaker — anyone may halt, but ONLY when the
  //    chain itself proves insolvency (_hardBreach). Reverts NoBreach on a
  //    healthy protocol, so it cannot be abused to grief. ─────────────────────
  { type: 'function', name: 'tripBreaker', stateMutability: 'nonpayable', inputs: [], outputs: [] },

  // ── Aggregate global stats (one call) ────────────────────────────────────
  //  0 totalStaked        1 totalDebt          2 totalBoostedEffective
  //  3 totalBoostedPure   4 utilizationWad     5 annualRateBps
  //  6 rewardReserve      7 protocolReserve    8 emissionStart
  //  9 emissionEnd       10 rewardPerSec      11 totalLiquidations
  // 12 totalBadDebt      13 totalInterestAccruedGlobal  14 owed  15 maxDaysNow
  {
    type: 'function', name: 'getGlobalStats', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'totalStaked_', type: 'uint256' }, { name: 'totalDebt_', type: 'uint256' },
      { name: 'totalBoostedEffective_', type: 'uint256' }, { name: 'totalBoostedPure_', type: 'uint256' },
      { name: 'utilizationWad', type: 'uint256' }, { name: 'annualRateBps', type: 'uint256' },
      { name: 'rewardReserve_', type: 'uint256' }, { name: 'protocolReserve_', type: 'uint256' },
      { name: 'emissionStart_', type: 'uint256' }, { name: 'emissionEnd_', type: 'uint256' },
      { name: 'rewardPerSec', type: 'uint256' }, { name: 'totalLiquidations_', type: 'uint256' },
      { name: 'totalBadDebt_', type: 'uint256' }, { name: 'totalInterestAccruedGlobal_', type: 'uint256' },
      { name: 'owed_', type: 'uint256' }, { name: 'maxDaysNow', type: 'uint256' },
    ],
  },
  { type: 'function', name: 'activeBorrowerCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maintenanceBudget', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'currentInterestRateBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'pureStakerApr', stateMutability: 'view', inputs: [{ name: 'lockDays_', type: 'uint256' }], outputs: [{ name: 'aprBps', type: 'uint256' }] },
  { type: 'function', name: 'boostByDays', stateMutability: 'pure', inputs: [{ name: 'lockDays_', type: 'uint256' }], outputs: [{ name: 'bps', type: 'uint256' }] },

  // ── Aggregate per-position view (one call) ───────────────────────────────
  //  0 staked   1 debt   2 effectiveStake   3 maxBorrowAvailable
  //  4 health   5 daysLeft   6 stakingRewards   7 pureYield
  //  8 rateBps  9 lockDays  10 unlockTime  11 boostBps  12 remainingCap  13 maxDaysNow
  {
    type: 'function', name: 'getUserInfo', stateMutability: 'view', inputs: [{ name: 'user_', type: 'address' }],
    outputs: [
      { name: 'staked', type: 'uint256' }, { name: 'debt', type: 'uint256' },
      { name: 'effectiveStake', type: 'uint256' }, { name: 'maxBorrowAvailable', type: 'uint256' },
      { name: 'health', type: 'uint256' }, { name: 'daysLeft', type: 'uint256' },
      { name: 'stakingRewards', type: 'uint256' }, { name: 'pureYield', type: 'uint256' },
      { name: 'rateBps', type: 'uint256' }, { name: 'lockDays', type: 'uint256' },
      { name: 'unlockTime', type: 'uint256' }, { name: 'boostBps', type: 'uint256' },
      { name: 'remainingCap', type: 'uint256' }, { name: 'maxDaysNow', type: 'uint256' },
    ],
  },
  { type: 'function', name: 'pendingRewards', stateMutability: 'view', inputs: [{ name: 'user_', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'pendingPureYield', stateMutability: 'view', inputs: [{ name: 'user_', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxBorrowOf', stateMutability: 'view', inputs: [{ name: 'user_', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxLockDaysAvailable', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },

  // ── User actions ─────────────────────────────────────────────────────────
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ name: 'amount_', type: 'uint256' }, { name: 'lockDays_', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'borrow', stateMutability: 'nonpayable', inputs: [{ name: 'amount_', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'repay', stateMutability: 'nonpayable', inputs: [{ name: 'amount_', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'amount_', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'claimRewards', stateMutability: 'nonpayable', inputs: [], outputs: [] }, // settles emission AND pure-yield
  { type: 'function', name: 'claimPureYield', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'lock', stateMutability: 'nonpayable', inputs: [{ name: 'lockDays_', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'emergencyWithdraw', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'liquidate', stateMutability: 'nonpayable', inputs: [{ name: 'user_', type: 'address' }], outputs: [] },

  // ── Events (activity feed) ───────────────────────────────────────────────
  { type: 'event', name: 'Deposited', inputs: [{ name: 'user', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }, { name: 'newStake', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Borrowed', inputs: [{ name: 'user', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }, { name: 'totalDebt_', type: 'uint256', indexed: false }, { name: 'rateBps', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Repaid', inputs: [{ name: 'user', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }, { name: 'remaining', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Withdrawn', inputs: [{ name: 'user', type: 'address', indexed: true }, { name: 'gross', type: 'uint256', indexed: false }, { name: 'debtCleared', type: 'uint256', indexed: false }, { name: 'penalty', type: 'uint256', indexed: false }, { name: 'net', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'RewardClaimed', inputs: [{ name: 'user', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Liquidated', inputs: [{ name: 'user', type: 'address', indexed: true }, { name: 'keeper', type: 'address', indexed: true }, { name: 'seized', type: 'uint256', indexed: false }, { name: 'debt', type: 'uint256', indexed: false }, { name: 'keeperBonus', type: 'uint256', indexed: false }, { name: 'leftover', type: 'uint256', indexed: false }, { name: 'uncoveredBadDebt', type: 'uint256', indexed: false }] },

  // ── Custom errors (mirror BlazePhoenixStaking.sol) — let viem decode reverts ─
  { type: 'error', name: 'Staking__ZeroAmount', inputs: [] },
  { type: 'error', name: 'Staking__ZeroAddress', inputs: [] },
  { type: 'error', name: 'Staking__InsufficientStake', inputs: [] },
  { type: 'error', name: 'Staking__LTVExceeded', inputs: [] },
  { type: 'error', name: 'Staking__NotLiquidatable', inputs: [] },
  { type: 'error', name: 'Staking__TransferFailed', inputs: [] },
  { type: 'error', name: 'Staking__AlreadyFunded', inputs: [] },
  { type: 'error', name: 'Staking__HasDebt', inputs: [] },
  { type: 'error', name: 'Staking__NoDebt', inputs: [] },
  { type: 'error', name: 'Staking__FlashLoanProtection', inputs: [] },
  { type: 'error', name: 'Staking__CapExceeded', inputs: [] },
  { type: 'error', name: 'Staking__LockTooShort', inputs: [] },
  { type: 'error', name: 'Staking__LockTooLong', inputs: [] },
  { type: 'error', name: 'Staking__NoLock', inputs: [] },
  { type: 'error', name: 'Staking__CannotReduceLock', inputs: [] },
  { type: 'error', name: 'Staking__StillLocked', inputs: [] },
  { type: 'error', name: 'Staking__NoStake', inputs: [] },
  { type: 'error', name: 'Staking__LockExceedsEmissionEnd', inputs: [] },
  { type: 'error', name: 'Staking__EmissionEnded', inputs: [] },
  { type: 'error', name: 'Staking__EmergencyActive', inputs: [] },
  { type: 'error', name: 'Staking__EmergencyNotActive', inputs: [] },
  { type: 'error', name: 'Staking__InvariantBreached', inputs: [] },
  { type: 'error', name: 'Staking__NoBreach', inputs: [] },
] as const;

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
