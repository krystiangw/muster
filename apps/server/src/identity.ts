/**
 * Giving everybody on the board a face.
 *
 * A board six agents write to is a wall of small grey text, and the question a
 * person actually asks it is "whose is this". Reading that off a handle costs a
 * second per card; reading it off a colour costs nothing, which is the whole
 * difference between scanning a board and studying one.
 *
 * Everything here is derived from the handle itself. No avatar is stored, none
 * is uploaded, and nothing is fetched: an image from a third party would put a
 * request to somebody else's host on every card, and the same page promises
 * that it makes none. The same handle always gets the same face, on every
 * board, in every deployment, which is what makes it recognisable at all.
 */

/** FNV-1a. Small, stable, and not a security decision. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Twelve hues, spaced far enough apart to be told apart at chip size, and
 * keeping clear of the ones this palette already spends on meaning: the red of
 * a blocked item (hue 30), the amber of a stale one (81), the green of a
 * finished one (156) and the teal of the accent (187). A name that borrowed one
 * of those would read as a status, which is exactly what happened to a handle
 * that landed on 30 and sat next to a red BLOCKED chip.
 */
const HUES = [4, 55, 100, 120, 138, 210, 232, 254, 276, 298, 320, 342];

/** How much colour a face carries. Constant, so only the hue identifies. */
const CHROMA = 0.13;

export interface Face {
  /**
   * The hue and chroma, as custom properties for the page to build a colour
   * from. Lightness deliberately is not here: it belongs to the theme.
   *
   * The face used to carry a finished `oklch()` with a lightness baked into the
   * hash, which meant one number had to be readable on white and on near black
   * at once. It was not: measured against the dark surface, the darkest of the
   * three variants came out at 2.99:1, under the 4.5 a small chip needs.
   */
  vars: string;
  /** The disc colour, which stays put: white initials sit on it in both themes. */
  disc: string;
  /** One or two letters, for when there is no room for a picture. */
  initials: string;
}

export function faceOf(handle: string): Face {
  const h = hash(handle);
  const hue = HUES[h % HUES.length]!;
  return {
    vars: `--who-h:${hue};--who-c:${CHROMA}`,
    disc: `oklch(0.55 ${CHROMA} ${hue})`,
    initials: initialsOf(handle),
  };
}

function initialsOf(handle: string): string {
  const words = handle.split(/[^a-z0-9]+/i).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The mark for one handle: a coloured disc with its initials.
 *
 * Inline SVG rather than an image, because the content security policy on these
 * pages allows no outside request at all and an inline element costs no round
 * trip. `aria-hidden` because the handle is written next to it in words; a
 * screen reader announcing the same name twice is worse than one that says it
 * once.
 */
export function avatar(handle: string, size = 16): string {
  const face = faceOf(handle);
  const half = size / 2;
  return `<svg class="face" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false"><circle cx="${half}" cy="${half}" r="${half}" fill="${face.disc}"/><text x="${half}" y="${half + size * 0.045}" text-anchor="middle" dominant-baseline="central" font-family="ui-monospace,monospace" font-size="${(size * 0.5).toFixed(1)}" font-weight="600" fill="#fff">${escape(face.initials)}</text></svg>`;
}

/** A name with its face, which is how every actor should appear on a page. */
export function who(handle: string, options: { title?: string; prefix?: string } = {}): string {
  const face = faceOf(handle);
  const title = options.title ? ` title="${escape(options.title)}"` : '';
  return `<span class="who-chip"${title} style="${face.vars}">${avatar(handle)}<span>${
    options.prefix ? `${escape(options.prefix)} ` : ''
  }${escape(handle)}</span></span>`;
}
