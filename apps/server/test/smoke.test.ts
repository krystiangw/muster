import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { flushEvents } from '../src/events.js';
import { startHarness, type Harness } from './helper.js';

/**
 * The scripts we point at production, pointed at a server we control.
 *
 * `tools/smoke-mcp.mjs` had been failing every write step since the day the
 * three doors learned to refuse an argument they do not have: it sent
 * `project` to tools that are already scoped by the token that reached them.
 * Ten calls, ten correct refusals, and nobody knew, because that script runs
 * when somebody remembers and the walkthrough that runs every morning
 * exercises the same door through different tools.
 *
 * A check that reports only when somebody thinks to ask is a check that
 * reports on the day it is already too late. These run here instead, against a
 * harness on a port, so the drift is caught by the suite that runs on every
 * change rather than by a person wondering why a number looks wrong.
 *
 * Not `smoke-sdk.mjs`: that one installs `musterboard` from the registry on
 * purpose, because its whole question is whether the *published* client still
 * works, and a suite that reached for the network on every run would be a
 * worse trade than the drift it catches.
 */
/** The repository root, where `tools/` lives, two levels above this file. */
const HERE = fileURLToPath(new URL('../../..', import.meta.url));
const run = promisify(execFile);

describe('the scripts that check production, run against a harness', () => {
  let harness: Harness;
  let base: string;
  let home: string;

  /** A port nobody is on, asked for and handed back. */
  const freePort = async (): Promise<number> => {
    const held = createServer();
    await new Promise<void>((resolve) => held.listen(0, '127.0.0.1', resolve));
    const address = held.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    await new Promise<void>((resolve) => held.close(() => resolve()));
    return port;
  };

  before(async () => {
    // The port is chosen before the server is built rather than after, because
    // one of these scripts checks that the authorization server metadata
    // points at the deployment it is talking to, and refuses when it does not.
    // That is the check working: an agent must not follow a registration
    // endpoint on another host. So the harness is told its own address.
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    harness = await startHarness({ BASE_URL: base });
    // Injected everywhere else in this suite; these are real programs and need
    // a real socket, which a Fastify instance is perfectly willing to open.
    await harness.server.listen({ port, host: '127.0.0.1' });
    home = mkdtempSync(join(tmpdir(), 'muster-smoke-'));
  });

  after(async () => {
    await harness.stop();
    rmSync(home, { recursive: true, force: true });
  });

  /** One script, run the way an operator runs it, minus the operator's home. */
  const smoke = async (script: string) =>
    (
      await run(process.execPath, [`tools/${script}`, '--base', base], {
        cwd: HERE,
        encoding: 'utf8',
        env: { ...process.env, MUSTER_HOME: home },
      })
    ).stdout;

  it('signs up and drives every tool the MCP door has', async () => {
    const out = await smoke('smoke-mcp.mjs');
    assert.match(out, /all good/, out);
    // Named rather than counted, because the failure this exists for was one
    // step going quiet while the rest stayed green.
    for (const step of ['register_agent', 'upsert_item', 'next_item', 'escalate', 'inbox', 'board', 'move']) {
      assert.match(out, new RegExp(`ok +${step}`), `${step} passed: ${out}`);
    }
  });

  it('registers a client and writes with the token it was given', async () => {
    const out = await smoke('smoke-oauth.mjs');
    assert.match(out, /all good/, out);
    assert.match(out, /ok +the token writes/);
    assert.match(out, /ok +a wrong secret is refused/);
  });

  it('prints the report an operator reads, on a database with something in it', async () => {
    // The report runs in its own process and reads the database directly, and
    // telemetry is buffered on a timer in this one, so without this it would
    // be handed a database where nothing has happened yet and would pass by
    // agreeing with itself about zero.
    await flushEvents();
    const out = (
      await run(process.execPath, ['--import', 'tsx', 'tools/insights.mts'], {
        cwd: join(HERE, 'apps/server'),
        encoding: 'utf8',
        env: { ...process.env, MONGODB_URI: harness.config.mongoUri, MONGODB_DB: harness.config.mongoDb },
      })
    ).stdout;
    assert.match(out, /The funnel, since events were first recorded/);
    assert.match(out, /strangers\s+ours/);
    assert.match(out, /marked as ours since \d{4}-\d{2}-\d{2}/, out);
    assert.match(out, /created a project/);
  });

  it('says nothing has been marked rather than claiming a date it does not have', async () => {
    // The branch nobody had run: a deployment where no check has identified
    // itself yet has no date to print, and printing one would be a claim. It
    // was written blind this afternoon, because production had marked events
    // within a minute of the change landing.
    const fresh = await startHarness();
    try {
      const out = (
        await run(process.execPath, ['--import', 'tsx', 'tools/insights.mts'], {
          cwd: join(HERE, 'apps/server'),
          encoding: 'utf8',
          env: { ...process.env, MONGODB_URI: fresh.config.mongoUri, MONGODB_DB: fresh.config.mongoDb },
        })
      ).stdout;
      assert.match(out, /nothing has been marked as ours yet/);
      assert.doesNotMatch(out, /marked as ours since/);
    } finally {
      await fresh.stop();
    }
  });

  it('walks the whole journey an agent takes, end to end', async () => {
    // The daily check, run here as well. It signs up, registers, writes,
    // claims, lets a lease lapse, escalates, answers from the board the way a
    // browser posts it, and does the same board again over MCP: forty odd
    // steps of real product behaviour that nothing else in this suite strings
    // together in one go. It runs against production every morning through
    // launchd, which means a change that breaks it is found tomorrow at seven
    // by a log nobody is reading, or now.
    const out = (
      await run(process.execPath, ['tools/walkthrough.mjs', '--url', base], {
        cwd: join(HERE, 'apps/server'),
        encoding: 'utf8',
        env: { ...process.env, MUSTER_HOME: home },
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
    assert.match(out, /all clear/, out);
    assert.doesNotMatch(out, /^ *FAIL/m, out);
    // Counted as well as read, because "all clear" is also what a walkthrough
    // that stopped after four steps would say if the four passed. Forty five
    // is what it does today; the assertion is a floor, so adding steps is not
    // a failing test and quietly losing half of them is.
    const passed = (out.match(/^ {2}ok/gm) ?? []).length;
    assert.ok(passed >= 40, `it walked the whole way, not part of it: ${passed} steps`);
    for (const section of ['what an agent finds before it signs up', 'the same board over MCP']) {
      assert.match(out, new RegExp(section), `it reached "${section}"`);
    }
  });

  it('reuses what it kept, rather than signing up twice', async () => {
    // The reason these scripts remember anything: a tool that signs up on
    // every run writes a signup event on every run, and that number is the
    // denominator of every rate in the report.
    //
    // Asserted on what is stored rather than on what is printed. The first
    // version of this looked for the absence of a word the script never says,
    // so it passed whatever happened, which is worse than not testing it.
    const boardsBefore = await harness.store.projects.countDocuments({});
    const kept = JSON.parse(readFileSync(join(home, 'smoke.json'), 'utf8'));

    const again = await smoke('smoke-mcp.mjs');
    assert.match(again, /all good/, again);

    const after = JSON.parse(readFileSync(join(home, 'smoke.json'), 'utf8'));
    assert.deepEqual(after, kept, 'it went back to the board it had');
    assert.equal(
      await harness.store.projects.countDocuments({}),
      boardsBefore,
      'and made no new one',
    );
  });
});
