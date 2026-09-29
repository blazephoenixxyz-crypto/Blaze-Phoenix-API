// Central place for off-chain links / project metadata.
export const SITE = {
  name: 'BlazePhoenix',
  tagline: 'Decentralized · Autonomous · Ungovernable',
  thesis: 'Compute, do not trust.',
  author: '@SigmaCrit',
  authorUrl: 'https://x.com/SigmaCrit',
  // Domain-suffixed address (satisfies listing forms that require the email to
  // match the official domain). Delivered via Cloudflare Email Routing, which
  // forwards contact@blazephoenix.xyz → the Proton inbox (set up in the CF
  // dashboard: Email → Email Routing). Change here only if the alias changes.
  contactEmail: 'contact@blazephoenix.xyz',
  token: {
    symbol: 'BZPX',
    chain: 'Base',
    address: '0x23113e72165a034265Ab8Bf2277CCB7a85Cb7483',
    basescan: 'https://basescan.org/token/0x23113e72165a034265Ab8Bf2277CCB7a85Cb7483',
    totalSupply: '1,000,000,000',
  },
  // Protocol deploy manifest (public, on-chain-verifiable) — surfaced in the
  // Swap "Contracts & deploys" panel and the machine-readable manifest for
  // bots / aggregators. Contract addresses themselves live in config/chains.ts.
  protocol: {
    version: '1.0.0',
    feeBps: 28,               // 0.28% on quoted output; surplus is fee-exempt → user
    feeSplit: [
      { share: 30, address: '0x921B9Edb035379F7D81c8b77A3647AeB1Ad20BCe' },
      { share: 70, address: '0x56ac837BFea66Aa52CC5ed65cc8393046e54A610' },
    ],
    admin: '0x5f599f13cb760A9ee3d2DA9dAB1083Db6dF3e4c8',
    audit: 'pending', // external audit before third-party TVL (see SECURITY.md)
  },
  // Social — used by the viral airdrop share-gate and the footer.
  social: {
    twitter: 'https://x.com/blazephoenyx',
    twitterHandle: '@blazephoenyx',
    farcaster: 'https://farcaster.xyz/blazephoenix',
    farcasterHandle: '@BlazePhoenix',
    telegram: 'https://t.me/Blue_PhoenixOfficial',
    telegramHandle: '@Blue_PhoenixOfficial',
    github: 'https://github.com/blazephoenixxyz-crypto',
    githubHandle: 'blazephoenixxyz-crypto',
  },
  // Developer identity for E-E-A-T authorship (schema.org Person). Pseudonymous
  // by design; sameAs points only at public, self-published profiles.
  dev: {
    name: 'Mitra',
    handle: '@Sigmacrit',
    x: 'https://x.com/Sigmacrit',
    dorahacks: 'https://dorahacks.io/hacker/Mitraxyz',
  },
  // Developer surface — public repos + machine endpoints surfaced in the API
  // tab and the footer so integrators/bots find them from anywhere.
  repos: {
    site: 'https://github.com/blazephoenixxyz-crypto/blaze-phoenix-site',
    sdk: 'https://github.com/blazephoenixxyz-crypto/SDK',
    sdkInstall: 'npm i viem github:blazephoenixxyz-crypto/SDK',
  },
  airdropSupply: '130,000,000',
  // Documents live in /public/docs. Drop a newer build at the same path to update.
  docs: {
    whitepaper: '/docs/BlazePhoenix_Whitepaper.pdf',
    litepaper: '/docs/BlazePhoenix_Litepaper.pdf',
    whitepaperVersion: 'Version 2.3 · September 2026',
  },
  // SEO — broad crypto keyword surface for organic ranking.
  seo: {
    keywords: [
      'BlazePhoenix', 'BZPX', 'BZPX token', 'BlazePhoenix airdrop', 'crypto airdrop 2026',
      'DEX aggregator', 'on-chain DEX', 'decentralized exchange', 'Base DEX', 'Base airdrop',
      'best crypto airdrop', 'free crypto airdrop', 'staking', 'crypto staking', 'DeFi',
      'decentralized finance', 'swap tokens', 'token swap', 'Ethereum DEX', 'Arbitrum DEX',
      'Optimism DEX', 'self-custody', 'non-custodial swap', 'crypto roulette', 'Satoshi airdrop',
      'BZPX airdrop', 'how to get airdrop', 'web3 DEX', 'autonomous protocol', 'liquidity aggregator',
      // High-intent transactional queries
      'buy BZPX', 'BZPX price', 'swap on Base', 'Base chain swap', 'best DEX aggregator 2026',
      'cheapest token swap', 'best swap rates crypto', 'no KYC swap', 'no KYC DEX',
      'multichain DEX aggregator', 'ETH to USDC swap', 'swap without registration',
      // Security research / bounty intent — the audience here is researchers, so
      // the queries are the ones a hunter actually types, not the ones a marketer
      // imagines: they search for the programme and the scope, not for the brand.
      'DeFi bug bounty', 'crypto bug bounty program', 'smart contract bug bounty',
      'Solidity bug bounty', 'DEX bug bounty', 'staking contract bug bounty',
      'bug bounty 2026', 'web3 bug bounty', 'BZPX bug bounty', 'BlazePhoenix bug bounty',
      'paid smart contract audit bounty', 'responsible disclosure DeFi',
      'bug bounty hunter DeFi', 'crypto security researcher rewards',
      // Staking / yield intent
      'BZPX staking', 'crypto staking APR', 'lock and earn crypto', 'solvency-enforced staking',
      'crypto lending no oracle', 'borrow against staked tokens', 'DeFi yield 2026',
      'staking boost rewards', 'permissionless staking',
      // Trust / mechanism differentiators
      'MEV protected swap', 'on-chain price quote', 'surplus to user DEX',
      'permissionless DeFi', 'trustless exchange', 'verify solvency on-chain',
      'Uniswap alternative', 'Aerodrome aggregator', '1inch alternative Base',
    ],
  },
  license: 'BUSL-1.1',
} as const;
