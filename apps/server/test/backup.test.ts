import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { authed, createProject, startHarness, type Harness, type Project } from './helper.js';

/**
 * The way back, taken.
 *
 * The free Atlas tier makes no snapshots, so a nightly gzip written by
 * `tools/backup.mjs` is the only thing between a dropped collection and a
 * stranger losing the board they claimed. That script had no test: it was
 * exercised every night in the direction that is easy, and never once in the
 * direction that matters. A backup nobody has restored is a file, not a backup.
 *
 * So this restores one and then boots a server on it, because matching counts
 * are not the same as a working service: indexes are rebuilt on that boot, and
 * a document the archive carried in a shape the code no longer reads would
 * pass a count and fail a board.
 *
 * It also holds the two refusals in place. The realistic accident is not a
 * corrupt archive, it is restoring the right file into the wrong database.
 */
const HERE = fileURLToPath(new URL('..', import.meta.url));

let harness: Harness;
let project: Project;
let dir: string;

before(async () => {
  harness = await startHarness();
  project = await createProject(harness, 'backup');
  // Its own directory, always. The script rotates the oldest copies out of the
  // one it writes to, and the default is where the real backups live.
  dir = mkdtempSync(join(tmpdir(), 'muster-backup-'));
});

after(async () => {
  await harness.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** The script, run the way the schedule runs it. */
function backup(args: string[], db: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', ['tools/backup.mjs', ...args], {
      cwd: HERE,
      encoding: 'utf8',
      // Captured rather than inherited: the refusals below are meant to be
      // loud, and a passing test that prints them reads like a failing one.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MONGODB_URI: harness.config.mongoUri, MONGODB_DB: db },
    });
    return { code: 0, out };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failed.status ?? 1, out: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
}

describe('the nightly backup', () => {
  it('restores into a database a server can then serve', async () => {
    const headers = authed(project);
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/agents`,
      headers,
      payload: { handle: 'errors-loop', scope: ['errors:'] },
    });
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers,
      payload: { slug: 'errors:venue-withdraw-stuck', title: 'Withdraws stuck', actor: 'errors-loop' },
    });
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/escalations`,
      headers,
      payload: { question: 'Bridge it or wait?', item_slug: 'errors:venue-withdraw-stuck' },
    });

    const written = backup(['--dir', dir], harness.config.mongoDb);
    assert.equal(written.code, 0, written.out);
    const file = /-> (\S+\.json\.gz)/.exec(written.out)?.[1];
    assert.ok(file, `the script says where it wrote: ${written.out}`);

    const restored = `${harness.config.mongoDb}_restored`;
    const back = backup(['--restore', file!, '--yes'], restored);
    assert.equal(back.code, 0, back.out);
    assert.match(back.out, /projects: 1 restored/);

    // The part a count cannot answer: a server boots on it, rebuilds the
    // indexes, and answers with the same token the archive carried.
    const recovered = await startHarness({ MONGODB_DB: restored });
    try {
      const board = await recovered.server.inject({
        method: 'GET',
        url: `${project.api}/items`,
        headers,
      });
      assert.equal(board.statusCode, 200, board.body);
      const slugs = board.json().items.map((item: { slug: string }) => item.slug);
      assert.deepEqual(slugs, ['errors:venue-withdraw-stuck']);

      const asked = await recovered.server.inject({
        method: 'GET',
        url: `${project.api}/escalations`,
        headers,
      });
      assert.equal(asked.json().escalations.length, 1);

      // And it is a live database, not a read-only copy of one.
      const wrote = await recovered.server.inject({
        method: 'POST',
        url: `${project.api}/items/errors:venue-withdraw-stuck/timeline`,
        headers,
        payload: { message: 'read back after a restore', actor: 'errors-loop' },
      });
      assert.equal(wrote.statusCode, 200, wrote.body);
    } finally {
      await recovered.stop();
    }
  });

  it('refuses the two restores that are somebody having a bad day', async () => {
    const written = backup(['--dir', dir], harness.config.mongoDb);
    const file = /-> (\S+\.json\.gz)/.exec(written.out)?.[1];
    assert.ok(file);

    const unconfirmed = backup(['--restore', file!], `${harness.config.mongoDb}_scratch`);
    assert.equal(unconfirmed.code, 1);
    assert.match(unconfirmed.out, /Add --yes/);

    // Into the database it came from, which is the accident worth refusing:
    // the file is right and the target is not.
    const overLive = backup(['--restore', file!, '--yes'], harness.config.mongoDb);
    assert.equal(overLive.code, 1);
    assert.match(overLive.out, /already holds 1 project/);
    assert.match(overLive.out, /--force/);
  });
});
