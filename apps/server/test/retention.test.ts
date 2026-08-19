import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authed, createProject, signIn, startHarness, type Harness, type Project } from './helper.js';
import { flushEvents } from '../src/events.js';

/**
 * The promises that only an index keeps.
 *
 * Everything this service says about how long it holds anything is enforced by
 * one thing: a TTL index on `expiresAt`. Twelve of them, and nothing checked
 * that they exist. A dropped or renamed index does not fail anything: the
 * documents keep their date, the code keeps writing it, and the data simply
 * stays for ever while every page still says ninety days.
 *
 * That was worth a test before yesterday and is worth more now, because the
 * privacy material drafted for the operator states those numbers as facts:
 * fifteen minutes for a sign-in code, thirty days for an offer and a session,
 * seven days for a board nobody claimed, ninety days for a telemetry row.
 *
 * Two halves. The first names the collections whose retention we promise, so
 * removing one is a decision somebody has to make on purpose. The second is
 * the half that survives the next collection somebody adds: whatever is in the
 * database, if a document carries an expiry then something has to act on it.
 */
describe('what the service promises to forget', () => {
  let harness: Harness;
  let project: Project;

  before(async () => {
    harness = await startHarness();
    project = await createProject(harness, 'a board with something in every corner');

    const write = (path: string, payload: Record<string, unknown>) =>
      harness.server.inject({
        method: 'POST',
        url: `${project.api}${path}`,
        headers: authed(project),
        payload,
      });
    await write('/agents', { handle: 'someone' });
    await write('/items', { slug: 'a-card', title: 'work', actor: 'someone' });
    await write('/escalations', { agent: 'someone', question: 'a question' });
    await write('/keys', { role: 'write', name: 'a second door' });
    await write('/claim', { email: 'nobody@example.com' });
    await write('/share', { email: 'somebody@example.com', agent: 'someone' });
    await harness.server.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'a client', grant_types: ['client_credentials'] },
    });
    await signIn(harness, 'a-person@example.com');
    await flushEvents();
  });

  after(async () => {
    await harness.stop();
  });

  /** The names of the indexes on one collection, and what each is on. */
  const indexesOf = async (name: string): Promise<Array<Record<string, unknown>>> =>
    (await harness.store.db.collection(name).indexes()) as Array<Record<string, unknown>>;

  const expiresByItself = async (name: string): Promise<boolean> =>
    (await indexesOf(name)).some(
      (index) =>
        index.expireAfterSeconds !== undefined &&
        Object.keys((index.key ?? {}) as Record<string, unknown>).includes('expiresAt'),
    );

  it('has an index doing the forgetting for everything it promises to forget', async () => {
    // Named one by one, with what each is a promise about, so dropping one is
    // a sentence somebody has to write rather than a line somebody deletes.
    const promised: Array<[string, string]> = [
      ['projects', 'a board nobody claims goes after seven days'],
      ['items', 'and everything on it goes with it'],
      ['agents', 'and the handles that were registered on it'],
      ['escalations', 'and the questions it was asked'],
      ['apiKeys', 'and the keys that opened it, which are credentials'],
      ['claimCodes', 'a six digit code is good for fifteen minutes'],
      ['shares', 'an offer nobody accepted goes after thirty days'],
      ['handoverRequests', 'and so does a request to be handed a board'],
      ['oauthClients', 'a client credential dies with the project it was made for'],
      ['events', 'a telemetry row is kept for ninety days and no longer'],
      ['operatorSessions', 'a signed in session is good for thirty days'],
      ['operatorCodes', 'and the code that started it for fifteen minutes'],
    ];
    const forgotten: string[] = [];
    for (const [name, promise] of promised) {
      if (!(await expiresByItself(name))) forgotten.push(`${name}: ${promise}`);
    }
    assert.deepEqual(forgotten, [], `nothing is removing these:\n${forgotten.join('\n')}`);
  });

  it('leaves nothing carrying an expiry that nobody acts on', async () => {
    // The half that survives the next collection somebody adds. It reads the
    // database rather than a list: if a document says when it should go, the
    // collection holding it needs something that will take it.
    const collections = await harness.store.db.listCollections().toArray();
    assert.ok(collections.length >= 10, `the fixture filled the database: ${collections.length}`);

    const orphans: string[] = [];
    for (const { name } of collections) {
      const dated = await harness.store.db
        .collection(name)
        .countDocuments({ expiresAt: { $type: 'date' } });
      if (dated === 0) continue;
      if (!(await expiresByItself(name))) orphans.push(`${name} holds ${dated} with an expiry and no index`);
    }
    assert.deepEqual(orphans, [], orphans.join('\n'));
  });

  it('stops a board expiring the moment somebody claims it', async () => {
    // The other half of the same promise, and the one that would lose
    // somebody's work rather than keep it too long: claiming a board clears
    // the date on it and on everything under it, so the index leaves it alone.
    const before = await harness.store.projects.findOne({ _id: project.id });
    assert.ok(before?.expiresAt instanceof Date, 'an unclaimed board has a date on it');

    const pending = await harness.store.claimCodes.findOne({ projectId: project.id });
    assert.ok(pending, 'a code was minted');
    await harness.store.claimCodes.updateOne(
      { _id: pending!._id },
      { $set: { codeHash: (await import('../src/ids.js')).hashToken('123456') } },
    );
    const verified = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/claim/verify`,
      headers: { ...authed(project), 'content-type': 'application/json' },
      payload: { email: 'nobody@example.com', code: '123456' },
    });
    assert.equal(verified.statusCode, 200, verified.body);

    const after = await harness.store.projects.findOne({ _id: project.id });
    assert.equal(after?.expiresAt ?? null, null, 'the board is not going anywhere now');
    for (const name of ['items', 'agents', 'escalations', 'apiKeys'] as const) {
      const stillDated = await harness.store.db
        .collection(name)
        .countDocuments({ projectId: project.id, expiresAt: { $type: 'date' } });
      assert.equal(stillDated, 0, `${name} under a claimed board carries no expiry`);
    }
  });
});
