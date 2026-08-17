#!/usr/bin/env node
/**
 * Draws the Muster mark and writes it into `src/favicon.ts`.
 *
 * The mark is three columns hanging from the top of a tile, each holding a
 * different amount of work. That is what a Muster board looks like, and it is
 * one shape away from the bar chart every other product uses: chart bars grow
 * from the floor, board columns hang from the header.
 *
 * Everything is generated rather than committed as opaque bytes. An icon
 * nobody can regenerate is an icon nobody can change, and a binary blob in a
 * source tree is a place for a diff to hide. Run it after changing the
 * geometry or the palette:
 *
 *   node apps/server/tools/favicon.mjs
 *
 * No dependencies: the shapes are rounded rectangles, so a supersampled
 * rasteriser is a dozen lines, and PNG is deflate plus four chunks.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The tile, and the columns on it, in a unit square.
 *
 * The gaps are sized for the smallest frame rather than the largest. At 16
 * pixels a column is two and a bit wide, so a gap under a pixel and a half
 * closes up under antialiasing and the three columns read as one smudge. That
 * is the whole design constraint here: the mark has to survive a browser tab,
 * where it is smaller than a word.
 */
const TILE_RADIUS = 0.215;
const COLUMNS = [
  { x: 0.19, width: 0.143, top: 0.2, height: 0.6 },
  { x: 0.4285, width: 0.143, top: 0.2, height: 0.42 },
  { x: 0.667, width: 0.143, top: 0.2, height: 0.28 },
];

/** The two colours the rest of the site already uses for accent and page. */
const INK = [0x0e, 0x5f, 0x59];
const PAPER = [0xf5, 0xf7, 0xf5];

/** How many samples per pixel edge. 4 is 16 per pixel, which is plenty here. */
const SUPERSAMPLE = 4;

/** Signed distance to a rounded rectangle, negative inside. */
function roundedRect(x, y, box) {
  const halfWidth = box.width / 2;
  const halfHeight = box.height / 2;
  const radius = Math.min(box.radius, halfWidth, halfHeight);
  const dx = Math.abs(x - (box.x + halfWidth)) - (halfWidth - radius);
  const dy = Math.abs(y - (box.y + halfHeight)) - (halfHeight - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** The mark, as straight RGBA at any size. */
function draw(size) {
  const tile = { x: 0, y: 0, width: 1, height: 1, radius: TILE_RADIUS };
  const columns = COLUMNS.map((column) => ({
    x: column.x,
    y: column.top,
    width: column.width,
    height: column.height,
    radius: column.width / 2,
  }));

  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SUPERSAMPLE);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      let onTile = 0;
      let onColumn = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (col * SUPERSAMPLE + sx + 0.5) * step;
          const y = (row * SUPERSAMPLE + sy + 0.5) * step;
          if (roundedRect(x, y, tile) <= 0) onTile += 1;
          if (columns.some((column) => roundedRect(x, y, column) <= 0)) onColumn += 1;
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const coverage = onTile / samples;
      const paper = onColumn / samples;
      // The columns sit on the tile, so the tile's own colour is what shows
      // through wherever they do not.
      const mix = (channel) => Math.round(INK[channel] * (1 - paper) + PAPER[channel] * paper);
      const at = (row * size + col) * 4;
      pixels[at] = mix(0);
      pixels[at + 1] = mix(1);
      pixels[at + 2] = mix(2);
      pixels[at + 3] = Math.round(coverage * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const pixels = draw(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row += 1) {
    // Filter 0: none. The image is a handful of flat colours, so deflate has
    // nothing to gain from a cleverer filter.
    raw[row * (size * 4 + 1)] = 0;
    pixels.copy(raw, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An ICO carrying PNG frames, which every browser since 2007 understands. */
function ico(sizes) {
  const frames = sizes.map((size) => ({ size, data: png(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // an icon rather than a cursor
  header.writeUInt16LE(frames.length, 4);

  let offset = 6 + frames.length * 16;
  const directory = frames.map((frame) => {
    const entry = Buffer.alloc(16);
    entry[0] = frame.size === 256 ? 0 : frame.size;
    entry[1] = frame.size === 256 ? 0 : frame.size;
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(frame.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += frame.data.length;
    return entry;
  });

  return Buffer.concat([header, ...directory, ...frames.map((frame) => frame.data)]);
}

function svg() {
  const hex = (rgb) => `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  const columns = COLUMNS.map((column) => {
    const x = (column.x * 64).toFixed(1);
    const y = (column.top * 64).toFixed(1);
    const width = (column.width * 64).toFixed(1);
    const height = (column.height * 64).toFixed(1);
    const radius = ((column.width / 2) * 64).toFixed(1);
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${hex(PAPER)}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Muster"><rect width="64" height="64" rx="${(
    TILE_RADIUS * 64
  ).toFixed(1)}" fill="${hex(INK)}"/>${columns}</svg>`;
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'favicon.ts');
const file = `/**
 * The Muster mark: three columns hanging from the top of a tile, each holding a
 * different amount of work.
 *
 * Generated by \`node apps/server/tools/favicon.mjs\`, which is where the
 * geometry lives. Do not hand-edit the strings below; change the shapes there
 * and run it again.
 *
 * The rasters are inlined rather than read off disk because the rest of this
 * server serves its files the same way: one build artefact, no asset directory
 * to get out of step with the code that points at it.
 */

/** Same tile, drawn as shapes. Modern browsers prefer this one. */
export const FAVICON_SVG = ${JSON.stringify(svg())};

/** 16, 32 and 48 pixel frames, for the browsers and the bookmark bars that ask. */
export const FAVICON_ICO = Buffer.from(
  '${ico([16, 32, 48]).toString('base64')}',
  'base64',
);

/** What iOS uses when somebody keeps the board on a home screen. */
export const APPLE_TOUCH_PNG = Buffer.from(
  '${png(180).toString('base64')}',
  'base64',
);
`;
writeFileSync(out, file);
console.log(`wrote ${out}`);
