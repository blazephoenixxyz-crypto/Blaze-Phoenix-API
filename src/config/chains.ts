// =============================================================================
//  BlazePhoenix — chain configuration
//
//  DEX CONTRACT ADDRESSES DO NOT LIVE HERE ANY MORE → config/deployments.ts.
//  That file is the versioned registry (1.0.0 live, 2.0.0 = the final Core /
//  Hub / Solver / Quoter / Router). Each chain below serves the NEWEST version
//  deployed on it, so filling the 2.0.0 block there switches the site, the API
//  registry, the SDK and the MCP servers over in one edit. Staking stays here.
//
//  RPCs: each chain holds an ORDERED list of endpoints. The viem/wagmi transport
//  is built as a `fallback([...])` so if the first RPC fails the next is used
//  automatically. Users can prepend their OWN private RPC from the footer panel
//  (stored in localStorage, see lib/rpc.ts) — "100% descentralizado".
// =============================================================================

import { defineChain } from 'viem';
import { activeDeployment, type DeployedChainId } from './deployments';

export const ZERO = '0x0000000000000000000000000000000000000000' as const;

export type SupportedChainId = 1 | 8453 | 10 | 42161 | 4663;

export interface BlazeContracts {
  /** BlazePhoenixCore (2.x deployed library); zero on 1.x. */
  core: `0x${string}`;
  hub: `0x${string}`;
  solver: `0x${string}`;
  router: `0x${string}`;
  quoter: `0x${string}`;
  staking: `0x${string}`;
}

export interface ChainConfig {
  id: SupportedChainId;
  name: string;
  short: string;
  layer: 'L1' | 'L2';
  explorer: string;
  nativeSymbol: string;
  weth: `0x${string}`;
  /** Canonical bridge USDC on this chain (the deep, universal quote asset). */
  usdc: `0x${string}`;
  /** Project token (BZPX). Only set where the token is live. */
  bzpx?: `0x${string}`;
  /** Ordered RPC list — first that responds wins (fallback transport). */
  rpcs: string[];
  /** Protocol version the contracts below speak ("1.0.0" | "2.0.0"). */
  protocolVersion: string;
  contracts: BlazeContracts;
}

/** The active (newest deployed) DEX contracts for a chain + its staking engine. */
function dex(chainId: DeployedChainId, staking: `0x${string}`): Pick<ChainConfig, 'protocolVersion' | 'contracts'> {
  const a = activeDeployment(chainId);
  return { protocolVersion: a.version, contracts: { ...a.contracts, staking } };
}

// ⚠ SECURITY: the keys below ship inside a public static bundle — anyone can
// read them in the JS. That is normal for a front-end dApp, BUT you MUST lock
// each key to your domain in the provider dashboard (Alchemy → "Allowlist /
// HTTP referrer" = blazephoenix.xyz; dRPC → origin restriction). Otherwise the
// key can be reused by third parties. Users' own RPCs (footer) always win.

// Alchemy keys — SIX independent projects, each with its own monthly request
// budget and its own daily throughput ceiling. They are not a redundancy list
// to be walked in order: walking them in order would burn key #1 to its cap
// while #6 sat untouched. lib/rpc.ts spreads sessions across them (see the
// distribution note there) and rotates on failure.
export const ALCHEMY_KEYS: string[] = []; // the production keys are injected at deploy time and are not published
/** Alchemy subdomain per chain (they differ from our own slugs). */
export const ALCHEMY_NET: Record<SupportedChainId, string> = {
  1: 'eth-mainnet', 8453: 'base-mainnet', 10: 'opt-mainnet',
  42161: 'arb-mainnet', 4663: 'robinhood-mainnet',
};
const alchemy = (net: string) => ALCHEMY_KEYS.map((k) => `https://${net}.g.alchemy.com/v2/${k}`);
/** Every Alchemy endpoint for a chain, in key order (rotation happens above). */
export function alchemyFor(chainId: SupportedChainId): string[] {
  const net = ALCHEMY_NET[chainId];
  return net ? alchemy(net) : [];
}

// dRPC — one keyed, load-balanced endpoint per chain (private-mempool capable).
//
// ROUTING POLICY (inverted from the original design, deliberately): dRPC is the
// SCARCEST resource we have, so it is now the LAST resort for reads, not the
// first. Reads go to free public nodes; Alchemy catches them when a public node
// is down; dRPC is reached only when everything above it has been failing for
// minutes. Its private mempool is still where a SWAP is broadcast — that is
// worth spending on, because that is where sandwiching happens. Full policy
// and the reasoning per surface: lib/rpc.ts.
export const DRPC_KEY = ''; // the production key is injected at deploy time and is not published
const drpcUrl = (net: string) => `https://lb.drpc.live/${net}/${DRPC_KEY}`;
// Robinhood chain (4663) IS on dRPC (same keyed load-balancer as every chain);
// its own public node is the fallback.
export const ROBINHOOD_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const DRPC: Record<SupportedChainId, string> = {
  1:     drpcUrl('ethereum'),
  8453:  drpcUrl('base'),
  10:    drpcUrl('optimism'),
  42161: drpcUrl('arbitrum'),
  4663:  drpcUrl('robinhood'),
};

// viem/wagmi Chain object for Robinhood (not shipped in viem/chains). Shared by
// the read clients (useQuote, liveTape) and the wallet config (wagmi).
export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC, DRPC[4663]] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

export const CHAINS: Record<SupportedChainId, ChainConfig> = {
  // ── Ethereum L1 ──────────────────────────────────────────────────────────
  // dRPC (private mempool) LEADS every Ethereum trade; Alchemy + public nodes
  // are fallback. rpcsForTrade keeps dRPC first here regardless of trade size.
  1: {
    id: 1,
    name: 'Ethereum',
    short: 'ETH',
    layer: 'L1',
    explorer: 'https://etherscan.io',
    nativeSymbol: 'ETH',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    // READ order: free public nodes first, Alchemy as the paid safety net,
    // dRPC last. Trade broadcast uses a different order — see lib/rpc.ts.
    rpcs: [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.llamarpc.com',
      'https://cloudflare-eth.com',
      'https://rpc.ankr.com/eth',
      'https://1rpc.io/eth',
      'https://eth.drpc.org',
      ...alchemy('eth-mainnet'),
      DRPC[1],
    ],
    ...dex(1, ZERO),
  },

  // ── Base L2 (BZPX token + staking live here) ─────────────────────────────
  // Public pool (Alchemy + base endpoints) leads small trades; the keyed dRPC
  // closes the list and is promoted to FIRST for trades ≥ 0.2 ETH (rpcsForTrade).
  8453: {
    id: 8453,
    name: 'Base',
    short: 'BASE',
    layer: 'L2',
    explorer: 'https://basescan.org',
    nativeSymbol: 'ETH',
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    bzpx: '0x23113e72165a034265Ab8Bf2277CCB7a85Cb7483',
    rpcs: [
      'https://mainnet.base.org',
      'https://base-rpc.publicnode.com',
      'https://base.llamarpc.com',
      'https://base.drpc.org',
      'https://1rpc.io/base',
      ...alchemy('base-mainnet'),
      DRPC[8453],
    ],
    // BlazePhoenixStaking v3.0.0 — verified on Base (180M BZPX / 7-year
    // emission, isSolvent() = true at deploy). Flips isStakingLive → true.
    ...dex(8453, '0x3f60C7aa0c36a78D200405feBE143d2Cf3fA0c77'),
  },

  // ── Optimism L2 ──────────────────────────────────────────────────────────
  10: {
    id: 10,
    name: 'Optimism',
    short: 'OP',
    layer: 'L2',
    explorer: 'https://optimistic.etherscan.io',
    nativeSymbol: 'ETH',
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    rpcs: [
      'https://mainnet.optimism.io',
      'https://optimism-rpc.publicnode.com',
      'https://optimism.llamarpc.com',
      'https://optimism.drpc.org',
      'https://1rpc.io/op',
      ...alchemy('opt-mainnet'),
      DRPC[10],
    ],
    ...dex(10, ZERO),
  },

  // ── Arbitrum One L2 ──────────────────────────────────────────────────────
  42161: {
    id: 42161,
    name: 'Arbitrum',
    short: 'ARB',
    layer: 'L2',
    explorer: 'https://arbiscan.io',
    nativeSymbol: 'ETH',
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    rpcs: [
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum-one-rpc.publicnode.com',
      'https://arbitrum.llamarpc.com',
      'https://arbitrum.drpc.org',
      'https://1rpc.io/arb',
      ...alchemy('arb-mainnet'),
      DRPC[42161],
    ],
    ...dex(42161, ZERO),
  },

  // ── Robinhood Chain L2 (chain id 4663) ─────────────────────────────────────
  // Aggregator deployed + wired (7 factories incl. the Uni V2 whale + V4). Uses
  // its own public RPC (no dRPC/Alchemy). USD asset is USDG, not USDC.
  // ⚠ VERIFY the explorer URL below before relying on its links — unconfirmed.
  4663: {
    id: 4663,
    name: 'Robinhood',
    short: 'RH',
    layer: 'L2',
    explorer: 'https://robinhoodchain.blockscout.com',
    nativeSymbol: 'ETH',
    weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    usdc: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', // USDG (the chain's USD asset)
    rpcs: [
      ROBINHOOD_RPC,
      ...alchemy('robinhood-mainnet'),
      DRPC[4663],
    ],
    ...dex(4663, ZERO),
  },
};

/** The keyed dRPC endpoint preferred for a chain's larger trades (and all of
 *  Ethereum's). The actual ordering decision lives in lib/rpc.ts rpcsForTrade. */
export function preferredDrpc(chainId: number): string | undefined {
  return DRPC[chainId as SupportedChainId];
}

// Generic dRPC public endpoints — shown as the example/placeholder in the RPC
// panel so users have a known-good free node to paste (no key required).
export const DRPC_EXAMPLE: Record<SupportedChainId, string> = {
  1: 'https://eth.drpc.org',
  8453: 'https://base.drpc.org',
  10: 'https://optimism.drpc.org',
  42161: 'https://arbitrum.drpc.org',
  4663: ROBINHOOD_RPC,
};

export const CHAIN_ORDER: SupportedChainId[] = [8453, 1, 10, 42161, 4663];

export const SUPPORTED_CHAIN_IDS = CHAIN_ORDER;

export function getChain(id: number): ChainConfig | undefined {
  return CHAINS[id as SupportedChainId];
}

/** DEX (router + quoter) is live on this chain once the addresses are filled. */
export function isDexLive(id: number): boolean {
  const c = CHAINS[id as SupportedChainId];
  return !!c && c.contracts.router !== ZERO && c.contracts.quoter !== ZERO;
}

/** Staking is live on this chain once the address is filled. */
export function isStakingLive(id: number): boolean {
  const c = CHAINS[id as SupportedChainId];
  return !!c && c.contracts.staking !== ZERO;
}
