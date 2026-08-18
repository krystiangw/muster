#!/usr/bin/env node
/**
 * Takes the picture of the board that the README shows.
 *
 * The picture is not staged. It is the demo board off the landing page, which
 * is itself drawn by the same `buildBoard`/`renderBoard` the real boards go
 * through, so a screenshot that goes stale is a screenshot of a page that went
 * stale, and both are fixed in one place. That is also why this fetches a URL
 * instead of importing the render functions: what ends up in the README is what
 * a visitor sees, not what a test double produces.
 *
 *   node apps/server/tools/screenshot.mjs                     # the live site
 *   node apps/server/tools/screenshot.mjs --url http://localhost:3000
 *
 * Chrome is the only dependency, and only for the raster. Everything else is
 * string slicing: the page has one `<style>` and one `<div class="demo">`, and
 * lifting both out of it gives a standalone file with no network access, which
 * is what keeps the shot free of a loading race.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

const url = flag('url', 'https://musterboard.dev/');
const width = Number(flag('width', 1180));
const height = Number(flag('height', 470));
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = flag('out', join(repo, 'docs', 'board.png'));

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((path) => existsSync(path));
if (!CHROME) {
  console.error('no Chrome found; pass one on PATH or install Google Chrome');
  process.exit(1);
}

/**
 * The subtree opened by `open`, closed by counting `<div`/`</div>`.
 *
 * A parser would be the correct tool if this HTML came from anywhere; it comes
 * from one template in this repository, which never nests a `<div` inside an
 * attribute value and never leaves one unclosed.
 */
function subtree(html, open) {
  const start = html.indexOf(open);
  if (start === -1) throw new Error(`no ${open} in ${url}`);
  let depth = 0;
  const tag = /<\/?div\b/g;
  tag.lastIndex = start;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    depth += match[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, html.indexOf('>', match.index) + 1);
  }
  throw new Error(`${open} is never closed in ${url}`);
}

const page = await fetch(url).then((response) => {
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
});

// The stylesheet is a file with its own name now, so this fetches it and puts
// it back inline: the shot has to be one self contained document, or Chrome
// renders it before the sheet lands and the picture is of unstyled text.
const sheetHref = page.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1];
if (!sheetHref) throw new Error(`no stylesheet linked from ${url}`);
const sheet = await fetch(new URL(sheetHref, url)).then((answer) => {
  if (!answer.ok) throw new Error(`stylesheet ${sheetHref} answered ${answer.status}`);
  return answer.text();
});
const style = `<style>${sheet}</style>`;
const board = subtree(page, '<div class="demo">');

// `.wrap` carries the page's own measure and padding, so the shot is framed the
// way the section is framed on the page rather than by a number chosen here.
const file = join(tmpdir(), 'muster-board-shot.html');
writeFileSync(
  file,
  `<!doctype html><html lang="en"><head><meta charset="utf-8">${style}
<style>body { margin: 0 } .wrap { padding: 26px 22px }</style>
</head><body><div class="wrap">${board}</div></body></html>`,
);

mkdirSync(dirname(out), { recursive: true });
execFileSync(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    // Two device pixels per CSS pixel: the README is read on laptops, and a
    // board is mostly small type, which is exactly what a 1x shot ruins.
    '--force-device-scale-factor=2',
    `--window-size=${width},${height}`,
    `--screenshot=${out}`,
    `file://${file}`,
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
console.log(`wrote ${out} (${width * 2}x${height * 2})`);
