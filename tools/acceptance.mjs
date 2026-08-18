#!/usr/bin/env node
/**
 * Every door, in one command, against a deployment.
 *
 * The three smoke checks each cover a way in that the others do not: the
 * published npm package, MCP, and the OAuth client that mints its own key. Run
 * separately they are three things to remember after a deploy, and a check that
 * has to be remembered is a check that stops being run.
 *
 *   node tools/acceptance.mjs
 *   node tools/acceptance.mjs --base http://127.0.0.1:4600
 *
 * Non-zero if any door fails, so it can be the last line of a deploy script or
 * a nightly cron entry. Each check keeps its own board or client and reuses it,
 * so running this daily does not fill the funnel with our own signups.
 */
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const at = argv.indexOf('--base');
const base = at === -1 ? 'https://musterboard.dev' : argv[at + 1];

const run = (tool) =>
  new Promise((resolve) => {
    const child = spawn('node', [tool, ...(at === -1 ? [] : ['--base', base])], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.on('exit', (code, signal) =>
      // A signal leaves no code, and reading that as zero would turn a killed
      // check into a deploy that passed.
      resolve({ tool, ok: !signal && code === 0, failed: (output.match(/^FAIL/gm) ?? []).length }),
    );
  });

const health = await fetch(`${base}/health`).then((response) => response.status).catch(() => 0);
console.log(`health ${health}\n`);

const results = [];
for (const tool of ['tools/smoke-sdk.mjs', 'tools/smoke-mcp.mjs', 'tools/smoke-oauth.mjs']) {
  console.log(`--- ${tool}`);
  results.push(await run(tool));
  console.log();
}

const broken = results.filter((result) => !result.ok);
console.log(
  results
    .map((result) => `${result.ok ? 'ok  ' : 'FAIL'} ${result.tool}${result.failed ? ` (${result.failed} steps)` : ''}`)
    .join('\n'),
);
if (health !== 200) console.log(`FAIL health answered ${health}`);
const ok = broken.length === 0 && health === 200;
console.log(ok ? '\nevery door answers' : `\n${broken.length + (health === 200 ? 0 : 1)} of ${results.length + 1} failed`);
process.exit(ok ? 0 : 1);
