import type { FastifyRequest } from 'fastify';
import { layout, type LayoutOptions } from './html.js';
import { hasSessionCookie } from './session.js';

/**
 * A page, rendered for whoever asked for it.
 *
 * `layout` takes `signedIn` as one more option, which means the navigation is
 * right on the pages that remembered to pass it and wrong on the rest: a signed
 * in reader was told to sign in by the read link, by every rate limit notice
 * and by the 404, and one of those was reported from a browser. Forgetting is
 * the default failure of an option, so this is not one: the request is the
 * argument, and the answer comes off it every time.
 */
export function page(
  request: FastifyRequest,
  options: Omit<LayoutOptions, 'signedIn'>,
  body: string,
): string {
  return layout({ ...options, signedIn: hasSessionCookie(request) }, body);
}
