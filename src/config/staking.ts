// =============================================================================
//  BlazePhoenix staking — deployments
//
//  Staking runs as two independent deployments: each its own contract on its own
//  chain, with its own token balance, reserves and solvency. Each is pinned here
//  by (chainId, address, codehash), keyed by its chainId. Nothing else names a
//  staking address.
//
//  A chain with no entry has NO staking deployment, and every lookup says
//  `not_deployed`. The zero address is never a deployment: absent is not zero.
//
//  codehash = keccak256 of the runtime code at the address, immutables included,
//  so the two deployments carry different pins even at one address. Measure it
//  on your own node: keccak256(eth_getCode(address)). Readers compare it before
//  they trust anything the address answers.
// =============================================================================

import { keccak256, stringToBytes } from 'viem';

export interface StakingDeploymentConfig {
  chainId: number;
  address: `0x${string}`;
  codehash: `0x${string}`;
}

/** Filled at deploy time, one entry per deployment. Empty: nothing is deployed. */
export const STAKING_DEPLOYMENTS: Record<number, StakingDeploymentConfig> = {};

/** keccak256 of empty code: what eth_getCode hashes to at an address with no contract. */
export const EMPTY_CODEHASH = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';

export type StakingLookup =
  | { ok: true; deployment: StakingDeploymentConfig }
  | { ok: false; code: 'not_deployed' | 'bad_config'; message: string };

/** EIP-55 checksum case of a 0x + 40-hex address: a hex letter is upper-case where the keccak256 of
 *  the lower-case hex has a nibble >= 8 at that position. Only form the config hands out. */
function checksumCase(address: string): `0x${string}` {
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256(stringToBytes(lower)).slice(2);
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out as `0x${string}`;
}

function configFault(key: number, d: StakingDeploymentConfig | undefined): string | undefined {
  if (!d || d.chainId !== key) return `the entry under chainId ${key} names another chainId`;
  if (typeof d.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(d.address) || /^0x0{40}$/.test(d.address)) {
    return 'address is not a non-zero 20-byte address';
  }
  // EIP-55: all-lowercase carries no checksum and is accepted; any letter in upper case means the
  // whole address must be the checksum case (all-uppercase included: it is not a checksum form).
  if (d.address !== d.address.toLowerCase() && d.address !== checksumCase(d.address)) {
    return 'address case is not its EIP-55 checksum';
  }
  if (typeof d.codehash !== 'string' || !/^0x[0-9a-f]{64}$/.test(d.codehash) || /^0x0{64}$/.test(d.codehash)
    || d.codehash === EMPTY_CODEHASH) {
    return 'codehash is not the keccak256 of deployed code';
  }
  return undefined;
}

/** The deployment on this chain, or why there is none. A malformed entry is refused, not repaired. */
export function stakingDeployment(chainId: number): StakingLookup {
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !Object.prototype.hasOwnProperty.call(STAKING_DEPLOYMENTS, chainId)) {
    return { ok: false, code: 'not_deployed', message: `no staking deployment on chain ${chainId}` };
  }
  const d = STAKING_DEPLOYMENTS[chainId];
  const fault = configFault(chainId, d);
  // What leaves is a projection: these three fields, the address in checksum case, nothing else
  // the entry may carry.
  return fault
    ? { ok: false, code: 'bad_config', message: `staking config for chain ${chainId}: ${fault}` }
    : { ok: true, deployment: { chainId: d.chainId, address: checksumCase(d.address), codehash: d.codehash } };
}

/** Chain ids with a well-formed deployment entry, ascending. Configured and pinned, never probed. */
export function stakingChainIds(): number[] {
  return Object.keys(STAKING_DEPLOYMENTS).map(Number).filter((id) => stakingDeployment(id).ok).sort((a, b) => a - b);
}
