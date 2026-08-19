import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, beforeEach, describe, it } from 'node:test';

/**
 * The monitor, watched failing.
 *
 * Everything this repo ships is exercised in the direction that matters except
 * the one script whose entire job is to notice when the rest stopped working.
 * It had run every quarter of an hour for two days and printed "ok" every time,
 * which says the happy path works and says nothing at all about the path it
 * exists for. A watchdog nobody has seen bark is a cron entry.
 *
 * So production is replaced by a server this test controls, and the failures
 * are dealt one at a time: a page that lost its script, a page pointing at the
 * previous build's script, a script that 404s, and a service that stopped
 * answering entirely. The last one also holds the promise the comments in that
 * file make twice, that one failed request is weather and the second one is an
 * outage.
 *
 * No mail leaves: without a key the sender says so and the round carries on,
 * which is also what happens on the operator's machine if the key is ever
 * missing, and is worth knowing stays harmless.
 */
const HERE = fileURLToPath(new URL('..', import.meta.url));

describe('the watchdog, watched', () => {
  let server: Server;
  let base: string;
  let home: string;

  /** What the impersonated service answers this round. */
  const state = {
    landing: 200,
    summary: 200 as number,
    /** What the summary says the board is open to. */
    visibility: 'link' as string,
    /** Whether a stranger can read the board page at all. */
    private: false,
    swept: () => new Date().toISOString(),
    /** The script tag the board page carries, or none. */
    names: null as string | null,
    /** What the server serves under that name, or nothing. */
    serves: null as string | null,
  };

  const script = "(() => { /* the one script this service serves */ })();\n";
  const hashOf = (body: string) => createHash('sha256').update(body).digest('hex').slice(0, 12);

  before(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://x');
      const send = (code: number, body: string, type = 'text/plain') => {
        response.writeHead(code, { 'content-type': type });
        response.end(body);
      };
      if (url.pathname === '/') return send(state.landing, 'landing');
      if (url.pathname.startsWith('/v1/') && url.pathname.endsWith('/escalations')) {
        return send(201, '{}', 'application/json');
      }
      if (url.pathname.startsWith('/v1/')) {
        if (state.summary !== 200) return send(state.summary, '{}', 'application/json');
        return send(
          200,
          JSON.stringify({
            project: 'p_test',
            read_url: `${base}/r/r_test`,
            visibility: state.visibility,
            swept_at: state.swept(),
          }),
          'application/json',
        );
      }
      // The refusal a browser gets for an unknown status word, which is the
      // whole point of that probe: the path in front of the write is open.
      if (url.pathname.startsWith('/r/') && url.pathname.includes('/escalations/')) {
        return send(400, '{"error":"unknown_status"}', 'application/json');
      }
      if (url.pathname === '/r/r_test/board') {
        // What a board narrowed to its owner says to anybody without the
        // owner's cookie: not that it is private, which would be a way to
        // enumerate them, but that there is nothing here.
        if (state.private) return send(404, 'not here');
        const tag = state.names === null ? '' : `<script src="/board-${state.names}.js" defer></script>`;
        return send(200, `<!doctype html><html><head>${tag}</head><body>a board</body></html>`, 'text/html');
      }
      if (url.pathname.startsWith('/board-')) {
        if (state.serves === null) return send(404, 'not here');
        return send(200, state.serves, 'text/javascript');
      }
      return send(404, 'not here');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    // A fresh home every round, so a counter left by the previous case cannot
    // decide the next one. That coupling is exactly what the two-guard case
    // below is measuring, and it has to be the only thing carrying state.
    if (home) rmSync(home, { recursive: true, force: true });
    home = mkdtempSync(join(tmpdir(), 'muster-watchdog-'));
    writeFileSync(
      join(home, 'tokens.json'),
      JSON.stringify({ p_test: { name: 'test', base, token: 'mk_test' } }),
    );
    state.landing = 200;
    state.summary = 200;
    state.swept = () => new Date().toISOString();
    state.names = hashOf(script);
    state.serves = script;
    state.visibility = 'link';
    state.private = false;
    // An archive from an hour ago, because the ordinary case is that last
    // night's cron ran. The cases below move it or take it away.
    mkdirSync(join(home, 'backups'), { recursive: true });
    backupWritten(Date.now() - 3_600_000);
  });

  /** Puts one archive in place, stamped whenever the case needs it to be. */
  const backupWritten = (at: number): void => {
    const file = join(home, 'backups', 'muster-test.json.gz');
    writeFileSync(file, 'not really gzip, and nothing here reads it');
    utimesSync(file, new Date(at), new Date(at));
  };

  /**
   * One round, and what it printed.
   *
   * Spawned rather than run to completion in place: the service it talks to is
   * this process, and a synchronous child holds the event loop, so every
   * request would time out against a server that never got the chance to
   * answer. The first version of this test proved that by failing six ways.
   */
  const run = promisify(execFile);
  const round = async () =>
    (
      await run(process.execPath, ['tools/watchdog.mjs'], {
        cwd: HERE,
        encoding: 'utf8',
        env: { ...process.env, MUSTER_HOME: home, MUSTER_RESEND_KEY: '', MUSTER_ALERT_TO: 'nobody@example.com' },
      })
    ).stdout;

  const saved = () => JSON.parse(readFileSync(join(home, 'watchdog.state.json'), 'utf8'));

  it('says what it checked when everything answers', async () => {
    // The first round has something else to say, and it is true: there is no
    // alerting key on this machine. It notices that on a quiet day and files
    // it, rather than finding out during the outage it was meant to report,
    // and having filed it, it says it once.
    assert.match(await round(), /the alerting key is not on disk \| board filed/);

    const out = await round();
    assert.match(out, /landing 200/);
    assert.match(out, /api read 200/);
    assert.match(out, /browser form 400/);
    assert.match(out, new RegExp(`board script ${hashOf(script)}`));
    assert.equal(saved().failures, 0);
  });

  it('notices that nothing has written a backup for two nights', async () => {
    // The failure that leaves every other check green, because the cron for it
    // runs on the operator's machine and not on the dyno. Two rounds, like an
    // outage: one missed run is a laptop that was closed.
    backupWritten(Date.now() - 50 * 3_600_000);
    assert.match(await round(), /backup miss 1: newest 50h ago/);
    assert.match(await round(), /backups stale: newest 50h ago/);
    assert.equal(saved().backupAlerted, true);
  });

  // The whole reason this check is answered on its own counter. A stale archive
  // on this laptop holding the outage latch would silence the mail this script
  // exists to send, on the night it was needed.
  it('lets production still page while the archives are stale', async () => {
    backupWritten(Date.now() - 50 * 3_600_000);
    await round();
    await round();
    assert.equal(saved().backupAlerted, true, 'the backup alert has latched');
    assert.equal(saved().alerted, false, 'and it is not the outage latch');

    state.landing = 500;
    await round();
    const out = await round();
    assert.match(out, /^down:/m, 'the outage still reports');
    assert.equal(saved().alerted, true);
  });

  it('takes one missed night for a laptop that was closed', async () => {
    backupWritten(Date.now() - 30 * 3_600_000);
    // The first round in a fresh home is spent saying the alerting key is not
    // here, the same as everywhere else in this file.
    await round();
    const out = await round();
    assert.match(out, /^ok /, 'a night without a run is not an outage');
    assert.match(out, /backups newest is 30h old/);
    assert.equal(saved().failures, 0);
  });

  // Rounding before the comparison moves the boundary half an hour early, and
  // with a backup at 03:17 and this running every quarter of an hour, the round
  // just before 03:17 on the second night would page about a run that had not
  // had its turn yet. Forty seven and a half hours rounds to forty eight and
  // has to still be fine.
  it('waits the full two nights, not the rounded ones', async () => {
    backupWritten(Date.now() - 47.6 * 3_600_000);
    await round();
    const out = await round();
    assert.match(out, /^ok /, 'not yet two nights');
    assert.equal(saved().backupMisses, 0);
  });

  it('says so when there is no archive at all', async () => {
    rmSync(join(home, 'backups'), { recursive: true, force: true });
    assert.match(await round(), /backup miss 1: newest never, or not where this looks/);
  });

  it('notices a board page that lost its script', async () => {
    state.names = null;
    assert.match(await round(), /board script: the board page names no script/);
    assert.equal(saved().failures, 1);
  });

  it('notices a page pointing at another build than the one being served', async () => {
    // The half-finished deploy: the HTML is new, the file behind it is not.
    // Nothing else in this round can see it, because the page renders, the
    // script is served, and both answer 200.
    const older = '(() => { /* last week */ })();\n';
    state.serves = older;
    const out = await round();
    assert.match(out, new RegExp(`page wants ${hashOf(script)}, server serves ${hashOf(older)}`));
    assert.equal(saved().failures, 1);
  });

  it('notices a script the server no longer has', async () => {
    state.serves = null;
    assert.match(await round(), /board script: script 404/);
  });

  it('does not page about a board that is private on purpose', async () => {
    // The board the operator narrowed to themselves answers 404 to a stranger,
    // and this check holds no session cookie. There is no page to read, so
    // there is no script tag to miss, and demanding one would turn a setting
    // into an outage every quarter of an hour.
    state.visibility = 'owner';
    state.private = true;
    await round();
    const out = await round();
    assert.match(out, /board script not open by link/);
    assert.equal(saved().failures, 0);
  });

  it('treats one failure as weather and the second as an outage', async () => {
    state.landing = 503;
    const first = await round();
    assert.match(first, /^miss 1: landing: 503/m, 'the first one is quiet about being an outage');
    assert.equal(saved().alerted, false, 'and nobody has been told');

    const second = await round();
    assert.match(second, /^down: landing: 503/m);
    // No key in this environment, so the sender says so rather than sending.
    assert.match(second, /email no key/);
    assert.equal(saved().alerted, true);

    // And it stays quiet from there rather than mailing every quarter hour.
    assert.match(await round(), /^miss 3: landing: 503/m);

    state.landing = 200;
    assert.match(await round(), /recovered, told you/);
    assert.equal(saved().alerted, false);
  });

  it('says hygiene has stopped when the service answers but nothing is swept', async () => {
    const old = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    state.swept = () => old;
    assert.match(await round(), /hygiene/i);
  });
});
