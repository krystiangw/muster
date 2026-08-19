import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { MongoClient } from 'mongodb';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { flushEvents } from '../src/events.js';
import { authed, createProject, startHarness, type Harness, type Project } from './helper.js';

/**
 * The delete, watched.
 *
 * This is the only script in the repo that removes somebody's data, it runs
 * against production by design, and it had no test. The backup got one on the
 * argument that a backup nobody has restored is a file rather than a backup;
 * the same argument is stronger here, because the way this fails is not that
 * it does nothing.
 *
 * Two failures are worth the trouble of a test, and neither is visible by
 * reading the script:
 *
 *  - **A collection the list forgets.** The script names the collections that
 *    carry a `projectId`, and that list is a copy of the schema kept by hand.
 *    The day somebody adds a collection is the day a purge starts leaving
 *    orphans behind, and one of them, `apiKeys`, is a live credential for a
 *    project that no longer exists. So this asserts against the database
 *    rather than against the list: after a purge, no document in any
 *    collection carries the id. That assertion still holds for a collection
 *    invented next year, which is the point of writing it that way.
 *  - **Taking the neighbour with it.** Everything is deleted by a filter, and
 *    a filter is one typo away from matching more than it was asked for.
 *
 * The project is exercised first, because deleting an empty project proves
 * nothing: it gets an agent, a key, an item with a claim and a note, a
 * question, and the events all of that writes.
 */
const HERE = fileURLToPath(new URL('..', import.meta.url));

let harness: Harness;
let doomed: Project;
let neighbour: Project;

/** The script, run the way an operator runs it. */
function purge(args: string[]): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync('node', ['tools/purge-projects.mjs', ...args], {
        cwd: HERE,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          MONGODB_URI: harness.config.mongoUri,
          MONGODB_DB: harness.config.mongoDb,
        },
      }),
    };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failed.status ?? 1, out: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
}

/** Everywhere in the database, not only where the script thought to look. */
async function traces(id: string): Promise<string[]> {
  const client = new MongoClient(harness.config.mongoUri);
  try {
    await client.connect();
    const db = client.db(harness.config.mongoDb);
    const found: string[] = [];
    for (const { name } of await db.listCollections().toArray()) {
      // The project names itself by _id and everything else names it by
      // projectId, which is the one shape difference this sweep has to know.
      const mine: Record<string, string> = name === 'projects' ? { _id: id } : { projectId: id };
      const left = await db.collection(name).countDocuments(mine);
      if (left > 0) found.push(`${name}=${left}`);
    }
    return found.sort();
  } finally {
    await client.close();
  }
}

/** A project with something in every corner of it. */
async function fill(project: Project): Promise<void> {
  const headers = authed(project);
  const post = (path: string, payload: Record<string, unknown>) =>
    harness.server.inject({ method: 'POST', url: `${project.api}${path}`, headers, payload });
  await post('/agents', { handle: 'nightly', description: 'the one that sweeps' });
  await post('/keys', { role: 'agent', label: 'a second door' });
  await post('/items', { slug: 'one', title: 'a card', owner: 'alex', labels: ['ops'] });
  await post('/items/one/claim', { agent: 'nightly' });
  await post('/items/one/timeline', { agent: 'nightly', message: 'started' });
  await post('/escalations', { agent: 'nightly', question: 'is this the one?', priority: 'normal' });
  // Telemetry is buffered and written on a timer, so without this the purge
  // would run before the funnel rows exist and this test would be quietly
  // checking a collection that happened to be empty.
  await flushEvents();
}

before(async () => {
  harness = await startHarness();
  doomed = await createProject(harness, 'the smoke test that outstayed its welcome');
  neighbour = await createProject(harness, 'somebody real');
  await fill(doomed);
  await fill(neighbour);
});

after(async () => {
  await harness.stop();
});

describe('purging a project', () => {
  it('says what would go, and goes nowhere, without --yes', async () => {
    const before = await traces(doomed.id);
    // Named rather than counted: a fill that silently stopped writing halfway
    // would still satisfy "more than three", and the assertion this whole file
    // rests on is only ever as strong as what was there to delete. The names
    // are the subject, not how many telemetry rows a round happens to write.
    assert.deepEqual(
      before.map((one) => one.split('=')[0]),
      ['agents', 'apiKeys', 'escalations', 'events', 'items', 'projects'],
    );

    const run = purge(['--ids', doomed.id]);
    assert.equal(run.code, 0);
    assert.match(run.out, /Would delete/);
    assert.match(run.out, /Dry run/);
    assert.match(run.out, /items=1/);
    assert.deepEqual(await traces(doomed.id), before, 'a dry run wrote nothing');
  });

  it('names what it cannot find rather than passing over it', () => {
    const run = purge(['--ids', 'p_never_existed']);
    assert.match(run.out, /p_never_existed {2}not here already/);
    assert.match(run.out, /Dry run/);
  });

  it('lists the projects when told to delete none', () => {
    const run = purge([]);
    assert.match(run.out, new RegExp(doomed.id));
    assert.match(run.out, /Pass --ids to name the ones to delete/);
  });

  it('leaves nothing of the project anywhere, and the neighbour untouched', async () => {
    const neighbourBefore = await traces(neighbour.id);

    const run = purge(['--ids', doomed.id, '--yes']);
    assert.equal(run.code, 0);
    assert.match(run.out, /projects: 1 deleted/);

    // Not "every collection the script names is empty", which would only ever
    // re-state the list it was given. Every collection there is.
    assert.deepEqual(await traces(doomed.id), [], run.out);
    assert.deepEqual(await traces(neighbour.id), neighbourBefore, 'the board next door is somebody’s');
  });

  it('leaves the board next door answering, which is the thing that matters', async () => {
    const page = await harness.server.inject({ method: 'GET', url: `${neighbour.api}/board`, headers: authed(neighbour) });
    assert.equal(page.statusCode, 200);
    const gone = await harness.server.inject({ method: 'GET', url: `${doomed.api}/board`, headers: authed(doomed) });
    assert.equal(gone.statusCode, 401, 'and the token for a project that is gone opens nothing');
  });
});
