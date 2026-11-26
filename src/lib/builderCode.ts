// =============================================================================
//  Base Builder Code (ERC-8021). One copy for every surface that hands out a
//  Router call: the quote API and the MCP endpoint.
// =============================================================================

type Hex = `0x${string}`;

/** ERC-8021 data suffix carrying the BlazePhoenix Base Builder Code (bc_rr7fua1b), appended to
 *  the Router call on Base so Base can attribute the volume. The Router's ABI decoder ignores
 *  trailing calldata: the swap executes identically with or without it. Same bytes as the SDK's
 *  BASE_BUILDER_SUFFIX. */
export const BASE_BUILDER_SUFFIX = '0x62635f72723766756131620b0080218021802180218021802180218021' as const;

/** The suffix for a swap on `chainId`: Base only. */
export function builderSuffix(chainId: number): Hex | undefined {
  return chainId === 8453 ? BASE_BUILDER_SUFFIX : undefined;
}

/** A Router call with the suffix appended (Base only). */
export function withBuilderCode<T extends { data: Hex }>(chainId: number, tx: T): T {
  const s = builderSuffix(chainId);
  return s ? { ...tx, data: `${tx.data}${s.slice(2)}` as Hex } : tx;
}
