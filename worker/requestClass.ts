// =============================================================================
//  requestClass — WHO is calling, decided by BEHAVIOUR and by proofs that
//  Cloudflare has already verified, never by geography.
//
//  WHY WE DO NOT FILTER BY COUNTRY. Datacentre traffic is concentrated in a few
//  countries, far above any plausible human share for crypto, and the temptation
//  is to block those countries. That is wrong for two independent reasons:
//    1. This site is GEO/LLM-first (13 locales, llms.txt, /md mirrors). The
//       crawlers we WANT — Googlebot, GPTBot, ClaudeBot, PerplexityBot — come
//       from datacentres, often the SAME ASNs as the abuse. A country block cuts
//       off the target audience together with the junk.
//    2. A country is not a behaviour. An abuser changes exit in seconds; the
//       legitimate user in Hong Kong does not move house.
//
//  WHAT IS USED INSTEAD. `request.cf.botManagement.verifiedBot` is a proof that
//  Cloudflare has already done for us (rDNS + ASN + signature), for free and with
//  no binding at all. A verified crawler is invited in; an anonymous client
//  hammering the API is not. Between the two there is a third case that this
//  file names explicitly instead of leaving it implicit: UNDEFINED — when
//  Cloudflare gives no signal (local environment, `wrangler dev`, a plan without
//  bot management). The answer there is TREAT AS HUMAN, never as an abuser: a
//  false positive here denies service to a paying user; a false negative merely
//  lets through a request that the downstream rate limit still sees.
//
//  FAIL-OPEN BY DESIGN, which is the difference from the rest of the protocol. In
//  the contracts, doubt closes (the floor reverts). Here doubt OPENS, because the
//  asymmetric cost is inverted: refusing a human loses a user, letting a bot
//  through loses a fraction of a cent of CPU.
// =============================================================================

/** What Cloudflare attaches to `request.cf`. Everything is optional: in
 *  `wrangler dev`, in tests and on plans without bot management, `cf` arrives
 *  `undefined`. */
export interface CfLike {
  botManagement?: {
    verifiedBot?: boolean;
    /** 1..99 — the LOWER, the more likely it is a bot. */
    score?: number;
  };
  asOrganization?: string;
  country?: string;
}

export type RequestClass =
  /** Crawler verified by Cloudflare (Googlebot, GPTBot, ClaudeBot…).
   *  It is the target audience of the GEO strategy: never limited, never
   *  challenged. */
  | 'verified-bot'
  /** No bot signal, or a human signal. The normal case. */
  | 'human'
  /** STRONG signal of unverified automation. Not a block — it is the only group
   *  a tighter limit applies to. */
  | 'suspect';

/** Below this, Cloudflare considers the signature strongly automated.
 *  30 and not 50: the 30-50 band catches too many people on VPNs, privacy
 *  extensions and hardened browsers — precisely the profile of someone using a
 *  DEX. We prefer to let automation through rather than annoy a cautious user. */
export const BOT_SCORE_SUSPECT_BELOW = 30;

/** Classifies a request. PURE: it takes only what already came with the request
 *  and reads no clock, network or state — so it is testable offline and its
 *  result is reproducible from the logs. */
export function classifyRequest(cf: CfLike | undefined): RequestClass {
  const bm = cf?.botManagement;
  // ORDER MATTERS: verification comes before the score. A verified crawler has a
  // low score by nature (it really is a bot) and would be classified suspect by
  // the next rule — exactly the false positive that would kill GEO.
  if (bm?.verifiedBot === true) return 'verified-bot';
  if (typeof bm?.score === 'number' && bm.score < BOT_SCORE_SUSPECT_BELOW) return 'suspect';
  // No signal at all (local dev, plan without bot management) → human. See the
  // fail-open note in the header.
  return 'human';
}

/** Only the `suspect` group pays a limit. A function of its own, rather than a
 *  `=== ` scattered across the call sites, so that the day the policy changes it
 *  is ONE edit and not a hunt. */
export function isRateLimited(c: RequestClass): boolean {
  return c === 'suspect';
}
