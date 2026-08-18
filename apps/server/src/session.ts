import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { constantTimeEquals, hashToken, newId } from './ids.js';
import { ServiceError } from './service.js';

/**
 * Operator sessions.
 *
 * The operator view used to be a link that never expired, with the credential
 * in the path. That is durable in the wrong direction: it survives being
 * pasted into a chat, a log or a Referer header, and it dies the moment
 * somebody loses the email. A session inverts both. Access is durable, because
 * anybody can get back in with their address and a code; the credential is
 * short lived, lives in a cookie the browser will not hand to another site,
 * and never appears in a URL.
 *
 * Cookies are parsed here rather than through a plugin: it is one header and
 * ten lines, and the rest of this service treats a dependency as something you
 * have to justify.
 */

export const SESSION_COOKIE = 'muster_session';
const SESSION_DAYS = 30;

export interface OperatorSession {
  id: string;
  email: string;
  /** Rendered into every form and checked on every POST. */
  csrf: string;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  if (!header) return jar;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      jar[name] = decodeURIComponent(value);
    } catch {
      jar[name] = value;
    }
  }
  return jar;
}

function cookieFlags(config: Config, maxAgeSeconds: number): string {
  // Secure would stop the cookie from ever being set on a local http run, and
  // a login that silently fails to stick is worse than one that says why.
  const secure = config.baseUrl.startsWith('https://') ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export async function startSession(
  store: Store,
  config: Config,
  reply: FastifyReply,
  email: string,
): Promise<OperatorSession> {
  const token = newId('ms', 32);
  const csrf = newId('c', 24);
  const now = new Date();
  const session = {
    _id: newId('sess'),
    email,
    hash: hashToken(token),
    csrf,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000),
  };
  await store.operatorSessions.insertOne(session);
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE}=${token}; ${cookieFlags(config, SESSION_DAYS * 86_400)}`,
  );
  return { id: session._id, email, csrf };
}

/**
 * Whether this browser is carrying a session, without asking the database.
 *
 * Only the chrome depends on this: the nav says "your projects" to somebody who
 * has signed in and "sign in" to everybody else, and getting that from the
 * cookie rather than from a lookup keeps every public page free of a read it
 * would otherwise do on every visit. A cookie whose session has since expired
 * says "your projects" and lands on the sign in form, which is the same place
 * the other label would have taken it.
 *
 * Never for anything that decides access. That is `readSession`, which checks
 * the token against the store, and the difference between the two is the whole
 * reason this one is safe to call anywhere.
 */
export function hasSessionCookie(request: FastifyRequest): boolean {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  return typeof token === 'string' && token !== '';
}

export async function readSession(
  store: Store,
  request: FastifyRequest,
): Promise<OperatorSession | null> {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const now = new Date();
  const doc = await store.operatorSessions.findOne({
    hash: hashToken(token),
    expiresAt: { $gt: now },
  });
  if (!doc) return null;
  // Best effort, and never awaited: when this browser was last seen is worth
  // knowing and worth nothing next to the request in hand. It swallows its own
  // failures because a floating rejection takes the process down.
  void store.operatorSessions
    .updateOne({ _id: doc._id }, { $set: { lastUsedAt: now } })
    .catch(() => undefined);
  return { id: doc._id, email: doc.email, csrf: doc.csrf };
}

/**
 * Forget a cookie that no longer opens anything.
 *
 * The navigation is drawn from the presence of this cookie and nothing else,
 * deliberately: no page should read the database to decide one word. The cost
 * is a session that expired, or a deployment whose sessions were wiped, still
 * saying "your projects" on the page that is asking the same person to sign in.
 * The page that discovers it is dead is the page that clears it, so the lie
 * lasts exactly one screen.
 */
export function forgetDeadSession(config: Config, request: FastifyRequest, reply: FastifyReply): void {
  if (!hasSessionCookie(request)) return;
  reply.header('set-cookie', `${SESSION_COOKIE}=; ${cookieFlags(config, 0)}`);
}

export async function endSession(
  store: Store,
  config: Config,
  request: FastifyRequest,
  reply: FastifyReply,
  everywhere = false,
): Promise<void> {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (token) {
    const doc = await store.operatorSessions.findOne({ hash: hashToken(token) });
    if (doc) {
      // "Everywhere" also drops the old style links, because a leaked one of
      // those is exactly what somebody ending every session is worried about.
      if (everywhere) {
        await Promise.all([
          store.operatorSessions.deleteMany({ email: doc.email }),
          store.operatorTokens.deleteMany({ email: doc.email }),
        ]);
      } else {
        await store.operatorSessions.deleteOne({ _id: doc._id });
      }
    }
  }
  reply.header('set-cookie', `${SESSION_COOKIE}=; ${cookieFlags(config, 0)}`);
}

/**
 * A cookie is ambient authority: the browser attaches it to a request the
 * user's page never meant to make. SameSite=Lax stops the cross site POST in
 * every browser we care about, and this stops the ones it does not, which is
 * the whole reason the service could previously say CSRF did not apply to it.
 */
export function csrfField(session: OperatorSession): string {
  return `<input type="hidden" name="csrf" value="${session.csrf}">`;
}

export function checkCsrf(session: OperatorSession, body: unknown): void {
  const sent = (body as { csrf?: unknown } | undefined)?.csrf;
  if (typeof sent !== 'string' || !constantTimeEquals(sent, session.csrf)) {
    throw new ServiceError(
      403,
      'bad_csrf',
      'That form did not come from this page, or the session behind it has ended. Reload the page you were on, sign in again if it asks, and retry.',
    );
  }
}
