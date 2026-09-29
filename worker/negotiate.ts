// =============================================================================
//  Agent-native content negotiation (the Cloudflare-docs pattern): a GET for a
//  /learn article that sends `Accept: text/markdown` is answered with the
//  pre-built /md/<slug>.md mirror — same knowledge, ~80% fewer tokens, no
//  redirect hop. Browsers never send that Accept value, so humans always get
//  the HTML; agents opt in explicitly. Pure mapping, testable offline.
// =============================================================================

const LEARN_RE = /^\/learn\/([a-z0-9-]+)\/?$/;

/** Returns the /md mirror path when this request should be answered with
 *  markdown, or null to fall through to the normal HTML asset. */
export function markdownMirrorPath(pathname: string, accept: string | null): string | null {
  if (!accept || !accept.includes('text/markdown')) return null;
  const m = LEARN_RE.exec(pathname);
  return m ? `/md/${m[1]}.md` : null;
}
