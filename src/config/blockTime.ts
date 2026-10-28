// One block-time table for every consumer (the API's tape and stats, the site's live tape).
// Seconds per block, as measured. Robinhood Chain (4663) runs ~0.104 s blocks.
export type BlockTimeChainId = 1 | 8453 | 10 | 42161 | 4663;

export const BLOCK_TIME_SEC: Record<BlockTimeChainId, number> = {
  1: 12, 8453: 2, 10: 2, 42161: 0.25, 4663: 0.104,
};
