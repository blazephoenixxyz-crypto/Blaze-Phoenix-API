// =============================================================================
//  BlazePhoenix — VERSIONED DEPLOYMENT REGISTRY (the single source of truth)
//
//  ▶ TO GO LIVE WITH THE FINAL CONTRACTS: fill the 2.0.0 block below — Core,
//    Hub, Solver, Router, Quoter per chain — and deploy the site. Nothing else
//    to edit. From that commit on:
//      • config/chains.ts serves the NEWEST deployed version per chain, so the
//        swap UI, the X-Ray, the stats and the solvency page switch over;
//      • GET /api/deployments (and /api/manifest) publish it, so every SDK 1.x
//        and every local MCP server picks it up within ~10 minutes — WITHOUT a
//        new release — after verifying it on the integrator's own RPC (code at
//        every address, VERSION() == "2.0.0", Quoter/Router/Solver wired to the
//        same Hub and Solver). A typo here fails closed there, never open.
//    A chain can go live alone: fill only that chain's row (router + quoter
//    are what flip it; hub/solver/core are needed by the verification above).
//
//  RULES THAT KEEP INTEGRATORS SAFE
//    • Never EDIT an address of a version that is already live — deploy a new
//      version instead. SDKs pin the addresses they shipped with and ignore a
//      registry that tries to move them (and say so in their logs).
//    • `version` is the string the contracts' VERSION() returns ("2.0.0").
//    • Zero address = not deployed on that chain.
//
//  The same schema is embedded in @blazephoenix/sdk (src/deployments.ts).
// =============================================================================

export type Address = `0x${string}`;

export const ZERO: Address = '0x0000000000000000000000000000000000000000';

export type DeployedChainId = 1 | 8453 | 10 | 42161 | 4663;

export interface ContractSet {
  /** BlazePhoenixCore — the deployed library Solver/Quoter/Router link (2.x). */
  core: Address;
  hub: Address;
  solver: Address;
  router: Address;
  quoter: Address;
}

export type DeploymentStatus = 'live' | 'pending' | 'deprecated';

export interface DeploymentVersion {
  version: string;
  status: DeploymentStatus;
  /** Blaze-Phoenix-Dex revision the bytecode was built from. */
  source?: string;
  notes?: string;
  chains: Record<DeployedChainId, ContractSet>;
}

const PENDING: ContractSet = { core: ZERO, hub: ZERO, solver: ZERO, router: ZERO, quoter: ZERO };

export const DEPLOYMENTS: { schema: 1; updatedAt: string; versions: DeploymentVersion[] } = {
  schema: 1,
  updatedAt: '2026-09-25',
  versions: [
    // ── 2.0.0 — the final generation (Blaze-Phoenix-Dex src/, VERSION "2.0.0") ──
    //    ▶ FILL THESE when deployed. Leave a chain at ZERO until it is.
    {
      version: '2.0.0',
      status: 'pending',
      source: 'blazephoenixxyz-crypto/Blaze-Phoenix-Dex@07c8563',
      notes: 'Final generation: Core, Hub, Solver, Quoter (previewAndEncode, batchQuote), Router (native entry, swapBestExactIn, ExecutionProof).',
      chains: {
        8453: { ...PENDING },
        1: { ...PENDING },
        10: { ...PENDING },
        42161: { ...PENDING },
        4663: { ...PENDING },
      },
    },
    // ── 1.0.0 — live since launch. Do not edit: integrators pin these. ──
    {
      version: '1.0.0',
      status: 'live',
      notes: 'The generation live on chain since launch.',
      chains: {
        1: {
          core: ZERO,
          hub: '0xc4FA9a5720fe3294D3AA9fc427E2a760591E57ae',
          solver: '0xc124d91258db0C14bf13b826CF64E16bfEA8a73e',
          router: '0xE1aE5f49013920CF71De8CED4043e14C4d63416b',
          quoter: '0x4a20AA0912388ff7A9221Ab6BFC224cc20Baa0c3',
        },
        8453: {
          core: ZERO,
          hub: '0x428554DEe93A1B8B5Bc6Fd19adDAfe55106fc04C',
          solver: '0xB1902990260975dD4C89ad74B1f317bc100CB830',
          router: '0x2a779f9Be49aac57495A8B6467Cc325a8a47Eb9f',
          quoter: '0x4cEF0615614B212895F45Aa1D4833B16666E18d3',
        },
        // Optimism shares Arbitrum's deployment addresses (identical bytecode).
        10: {
          core: ZERO,
          hub: '0x23113e72165a034265Ab8Bf2277CCB7a85Cb7483',
          solver: '0x0c0d96B237FABa8FE5e8aE77754Ef29109D2B33f',
          router: '0x7262e7483ab6f0db7b8f90eC3a9de3B02Ab36F6A',
          quoter: '0xfB18EF6f62A0278A273Af4b7A46b454F9E482dc2',
        },
        42161: {
          core: ZERO,
          hub: '0x23113e72165a034265Ab8Bf2277CCB7a85Cb7483',
          solver: '0x0c0d96B237FABa8FE5e8aE77754Ef29109D2B33f',
          router: '0x7262e7483ab6f0db7b8f90eC3a9de3B02Ab36F6A',
          quoter: '0xfB18EF6f62A0278A273Af4b7A46b454F9E482dc2',
        },
        4663: {
          core: ZERO,
          hub: '0x23113e72165a034265Ab8Bf2277CCB7a85Cb7483',
          solver: '0x0c0d96B237FABa8FE5e8aE77754Ef29109D2B33f',
          router: '0x7262e7483ab6f0db7b8f90eC3a9de3B02Ab36F6A',
          quoter: '0xE1aE5f49013920CF71De8CED4043e14C4d63416b',
        },
      },
    },
  ],
};

const isZero = (a: string) => /^0x0{40}$/i.test(a);

/** Executable once the Router and the Quoter exist. */
export function isSetDeployed(s: ContractSet | undefined): s is ContractSet {
  return !!s && !isZero(s.router) && !isZero(s.quoter);
}

const semver = (v: string) => v.split('.').map((n) => Number(n) || 0);
export function compareVersions(a: string, b: string): number {
  const pa = semver(a); const pb = semver(b);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Deployed versions on a chain, newest first. */
export function deployedVersions(chainId: DeployedChainId): DeploymentVersion[] {
  return DEPLOYMENTS.versions
    .filter((v) => v.status !== 'deprecated' && isSetDeployed(v.chains[chainId]))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** The version the site (and 'latest' integrators) use on a chain: the newest
 *  deployed one; falls back to an all-zero 1.0.0 set when none is. */
export function activeDeployment(chainId: DeployedChainId): { version: string; contracts: ContractSet } {
  const v = deployedVersions(chainId)[0];
  return v
    ? { version: v.version, contracts: { ...v.chains[chainId] } }
    : { version: '1.0.0', contracts: { ...PENDING } };
}

/** Major version ≥ 2: previewAndEncode, batchQuote, swapExactInNative,
 *  swapBestExactIn, ExecutionProof — and no Surplus event. */
export function isV2(version: string): boolean {
  return (semver(version)[0] ?? 0) >= 2;
}
