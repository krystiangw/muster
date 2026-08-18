import type { FastifyRequest } from 'fastify';

/**
 * Whether a write arrived from a page this service served.
 *
 * The decision only, without the answer: the capability pages render a whole
 * HTML refusal, the operator's pages raise the same error every other guard
 * there raises, and both need the same reading of the same two headers.
 *
 * `Sec-Fetch-Site` first, because it is the one a browser sends whatever the
 * page's referrer policy says. `Referrer-Policy: no-referrer` blanks the Origin
 * on a form post, which for twenty one hours refused every move on our own
 * board: two correct headers cancelling each other out. Origin is the fallback
 * for anything that does not send the first.
 *
 * `none` is a typed address or a bookmark, which no form post is; it is allowed
 * anyway because it is nobody else's page either. Neither header at all is curl
 * and the agents, and refusing those would break the doors this product is for.
 */
export type OriginReason = 'cross-site' | 'same-site' | 'origin';

export type OriginVerdict = { ok: true } | { ok: false; reason: OriginReason; came: string };

const OK: OriginVerdict = { ok: true };

/** The origin of a base URL, parsed rather than compared as a string. */
export function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

export function fromOurPage(request: FastifyRequest, ourOrigin: string): OriginVerdict {
  const site = request.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== '') {
    if (site === 'same-origin' || site === 'none') return OK;
    return site === 'same-site'
      ? { ok: false, reason: 'same-site', came: 'another host on this domain' }
      : { ok: false, reason: 'cross-site', came: 'another site' };
  }

  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin === '') return OK;
  let sent = origin;
  try {
    sent = new URL(origin).origin;
  } catch {
    // Not a URL at all. Nothing a browser sends, so it is refused below.
  }
  return sent === ourOrigin ? OK : { ok: false, reason: 'origin', came: sent };
}
