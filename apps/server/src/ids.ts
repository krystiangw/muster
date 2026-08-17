import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Crockford base32 without I, L, O and U: every id is safe to read aloud, to
 * paste into a URL and to retype from a terminal without ambiguity. Ids end up
 * in curl commands written by models, so ambiguous glyphs are a real cost.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function randomString(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export function newId(prefix: string, length = 10): string {
  return `${prefix}_${randomString(length)}`;
}

/** Write tokens are shown once, at creation, and only their hash is stored. */
export function newToken(): string {
  return `mk_${randomString(32)}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Six digits, zero padded, for the human claim step. */
export function newOtpCode(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

const SLUG_MAX = 96;

/**
 * Slugs are the idempotency key, so the normalisation has to be boring and
 * stable: two agents describing the same thing must land on the same slug.
 * Date stamps in slugs were the single most common mistake on the board this
 * one replaces, so callers are told to avoid them in the docs, but we do not
 * strip them here:
 * silently rewriting a caller's key would break their own lookups.
 */
export function normalizeSlug(input: string): string {
  const slug = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9:._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, SLUG_MAX);
  return slug;
}

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= SLUG_MAX && /^[a-z0-9][a-z0-9:._-]*$/.test(slug);
}

const HANDLE_MAX = 48;

export function normalizeHandle(input: string): string {
  return input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, HANDLE_MAX);
}

export function isValidHandle(handle: string): boolean {
  return handle.length > 0 && handle.length <= HANDLE_MAX && /^[a-z0-9][a-z0-9._-]*$/.test(handle);
}
