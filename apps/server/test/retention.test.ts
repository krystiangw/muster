import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authed, createProject, signIn, startHarness, type Harness, type Project } from './helper.js';
import { flushEvents } from '../src/events.js';
import { searchTooSlow } from '../src/service.js';
import { SEARCH_NARROWERS, SEARCH_NARROWING, SEARCH_NARROWING_MD } from '../src/types.js';

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

    // Every answer checked. Both tests below are written so that a collection
    // with nothing in it is quietly skipped, which is the right behaviour for
    // a database that has not been used and the wrong one for a fixture that
    // silently stopped writing: it would pass by protecting nothing.
    const write = async (path: string, payload: Record<string, unknown>, want = 201) => {
      const answer = await harness.server.inject({
        method: 'POST',
        url: `${project.api}${path}`,
        headers: authed(project),
        payload,
      });
      assert.equal(answer.statusCode, want, `POST ${path} said ${answer.statusCode}: ${answer.body}`);
    };
    await write('/agents', { handle: 'someone' });
    await write('/items', { slug: 'a-card', title: 'work', actor: 'someone' });
    await write('/escalations', { agent: 'someone', question: 'a question' });
    await write('/keys', { role: 'write', name: 'a second door' });
    await write('/claim', { email: 'nobody@example.com' }, 200);
    await write('/share', { email: 'somebody@example.com', agent: 'someone' });
    const client = await harness.server.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'a client', grant_types: ['client_credentials'] },
    });
    assert.equal(client.statusCode, 201, client.body);
    await signIn(harness, 'a-person@example.com');
    await flushEvents();
  });

  after(async () => {
    await harness.stop();
  });

  /** The names of the indexes on one collection, and what each is on. */
  const indexesOf = async (name: string): Promise<Array<Record<string, unknown>>> =>
    (await harness.store.db.collection(name).indexes()) as Array<Record<string, unknown>>;

  /**
   * Zero, not merely present.
   *
   * The date in `expiresAt` is the moment the document should go, so the index
   * is told to wait no time at all beyond it. An index that still names the
   * field but waits an hour, or a day, keeps everything past the point the
   * page promises and looks identical to a working one from a distance.
   */
  const expiresByItself = async (name: string): Promise<boolean> =>
    (await indexesOf(name)).some(
      (index) =>
        index.expireAfterSeconds === 0 &&
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

  it('has an index making unique the things that have to be', async () => {
    // The sibling of the promise above, and the same kind of mechanism: an
    // index nobody sees, holding a property everything else assumes. Losing
    // one of these fails nothing either. It lets a second row exist, and the
    // code carries on reading the first.
    //
    // The read token is the one that belongs with the isolation work: it is a
    // URL somebody pastes into a chat, and two boards sharing one would mean a
    // link opening the wrong board. Random ids make a collision unlikely and
    // this index is what makes it impossible, which is a different thing.
    const oneOf: Array<[string, string[], string]> = [
      ['projects', ['readToken'], 'one link opens one board and no other'],
      ['items', ['projectId', 'slug'], 'a slug is the idempotency key the protocol promises'],
      ['agents', ['projectId', 'handle'], 'a handle names one agent on one board'],
      ['apiKeys', ['hash'], 'two keys cannot hash to one row'],
      ['shares', ['projectId', 'email'], 'offering a board twice refreshes the offer, it does not stack'],
      ['handoverRequests', ['projectId', 'email'], 'and asking for one twice does not either'],
      ['operatorAliases', ['email'], 'an address is one person here'],
      // The three on the person's side of the door, which is where a second
      // row is worst: every one of these is read as "the credential", singular,
      // by the code that authenticates with it.
      ['operatorTokens', ['hash'], 'a sign-in link is one link, not a family of them'],
      ['operatorSessions', ['hash'], 'and a session cookie opens one session'],
      ['operatorCodes', ['email'], 'one code in flight per address, so a second ask replaces it'],
    ];
    const missing: string[] = [];
    for (const [name, fields, why] of oneOf) {
      const found = (await indexesOf(name)).some(
        (index) =>
          index.unique === true &&
          JSON.stringify(Object.keys((index.key ?? {}) as Record<string, unknown>)) ===
            JSON.stringify(fields),
      );
      if (!found) missing.push(`${name} on ${fields.join(' + ')}: ${why}`);
    }
    assert.deepEqual(missing, [], `nothing is keeping these unique:\n${missing.join('\n')}`);
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
      // There was something to clear, and then there was nothing dated. Only
      // the second half was asserted at first, which an empty collection
      // satisfies without anything having happened.
      const held = await harness.store.db.collection(name).countDocuments({ projectId: project.id });
      assert.ok(held > 0, `${name} had something under this board`);
      const stillDated = await harness.store.db
        .collection(name)
        .countDocuments({ projectId: project.id, expiresAt: { $type: 'date' } });
      assert.equal(stillDated, 0, `${name} under a claimed board carries no expiry`);
    }
  });
});

/**
 * The other promise only an index keeps.
 *
 * When a search runs out of its budget the refusal tells the caller which
 * filters to put beside it. That sentence was measured wrong once: it named
 * `label=`, and a board following it walks into the same refusal, because
 * labels carry no index on purpose and the predicate runs on documents already
 * fetched. Measured on twenty thousand cards, `label=` beside a search fetches
 * every one of them, exactly as many as the bare search.
 *
 * So the advice is not prose. It is a claim about which fields an index can act
 * on before a document is read, and it goes stale the moment somebody adds or
 * drops one. This is the test that notices, in both directions.
 */
describe('starting against a database that has run another version', () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness?.stop();
  });

  it('replaces an index that is there under a different name', async () => {
    // The failure this cannot have: MongoDB refuses to create an index whose
    // key already exists under another name, and the recovery used to drop the
    // name being asked for, which is not the name it is under. The drop found
    // nothing, the retry met the same refusal, and the process never finished
    // booting, which is the exact thing the recovery exists to prevent.
    const { createStore } = await import('../src/db.js');
    const items = harness.store.items;
    const unique = (await items.indexes()).find(
      (one) => (one as { unique?: boolean }).unique && JSON.stringify(one.key) === '{"projectId":1,"slug":1}',
    ) as { name: string } | undefined;
    assert.ok(unique, 'the fixture: the slug index is unique');

    await items.dropIndex(unique.name);
    await items.createIndex({ projectId: 1, slug: 1 }, { name: 'renamed_by_hand', unique: true });

    // A boot against that database. Before the fix this threw and nothing
    // started.
    const second = await createStore(harness.config.mongoUri, harness.config.mongoDb);
    assert.ok(second, 'it starts');
    // Closed here, or the runner waits on a client nothing owns and the whole
    // file stops finishing rather than failing.
    await second.client.close();

    const after = await items.indexes();
    const byKey = after.filter((one) => JSON.stringify(one.key) === '{"projectId":1,"slug":1}');
    assert.equal(byKey.length, 1, 'one index on that key, not two');
    assert.equal((byKey[0] as { unique?: boolean }).unique, true, 'and it is still the unique one');
  });

  it('leaves alone an index somebody built by hand that the database is happy to keep', async () => {
    // Two indexes on one key coexist when their options differ, so a partial
    // one built for a slow query is not in anybody's way. The recovery drops
    // what blocks it, and helping itself to the rest on the way past would be
    // this function quietly undoing somebody's work in production.
    const { createStore } = await import('../src/db.js');
    const items = harness.store.items;
    const declared = (await items.indexes()).find(
      (one) => JSON.stringify(one.key) === '{"projectId":1,"slug":1}',
    ) as { name: string };

    await items.createIndex(
      { projectId: 1, slug: 1 },
      { name: 'by_hand_for_a_slow_query', partialFilterExpression: { status: 'open' } },
    );
    // And a rename, so the recovery path actually runs.
    await items.dropIndex(declared.name);
    await items.createIndex({ projectId: 1, slug: 1 }, { name: 'renamed', unique: true });

    const second = await createStore(harness.config.mongoUri, harness.config.mongoDb);
    await second.client.close();

    const after = await items.indexes();
    assert.ok(
      after.some((one) => one.name === 'by_hand_for_a_slow_query'),
      'the hand-built one is still there',
    );
    assert.ok(
      after.some((one) => one.name === declared.name && (one as { unique?: boolean }).unique),
      'and the declared one is back under its own name',
    );
    await items.dropIndex('by_hand_for_a_slow_query');
  });

  it('leaves a hand-built index alone even when its lifetime differs', async () => {
    // The narrower half of the same measurement: two lifetimes on one key are
    // fine as long as anything else about the two indexes differs. Only the
    // pair that is the same index apart from how long it keeps a row is
    // refused, so this one is nobody's obstacle either.
    const { createStore } = await import('../src/db.js');
    const items = harness.store.items;
    const ttl = (await items.indexes()).find(
      (one) => (one as { expireAfterSeconds?: number }).expireAfterSeconds !== undefined,
    ) as { name: string };

    await items.createIndex(
      { expiresAt: 1 },
      { name: 'held_longer_for_open_work', expireAfterSeconds: 3600, partialFilterExpression: { status: 'open' } },
    );
    await items.dropIndex(ttl.name);
    await items.createIndex({ expiresAt: 1 }, { name: 'renamed_expiry', expireAfterSeconds: 0 });

    const second = await createStore(harness.config.mongoUri, harness.config.mongoDb);
    await second.client.close();

    const after = await items.indexes();
    assert.ok(
      after.some((one) => one.name === 'held_longer_for_open_work'),
      'the hand-built lifetime is still there',
    );
    assert.ok(
      after.some((one) => one.name === ttl.name && (one as { expireAfterSeconds?: number }).expireAfterSeconds === 0),
      'and the declared one is back under its own name',
    );
    await items.dropIndex('held_longer_for_open_work');
  });

  it('starts when a stale lifetime sits on the key it needs', async () => {
    // Measured of MongoDB rather than assumed: on one key it holds a plain
    // index beside a unique one, a sparse one and a partial one, and refuses
    // exactly one thing, a second lifetime. So an expiry left under another
    // name is in the way however different it looks, and leaving it there is a
    // database the next start cannot come up against.
    const { createStore } = await import('../src/db.js');
    const items = harness.store.items;
    const ttl = (await items.indexes()).find(
      (one) => (one as { expireAfterSeconds?: number }).expireAfterSeconds !== undefined,
    ) as { name: string };

    await items.dropIndex(ttl.name);
    // The same key, a different lifetime, another name. Nothing about its
    // shape matches what the code declares.
    await items.createIndex({ expiresAt: 1 }, { name: 'left_by_an_older_version', expireAfterSeconds: 3600 });

    const second = await createStore(harness.config.mongoUri, harness.config.mongoDb);
    assert.ok(second, 'it starts');
    await second.client.close();

    const after = await items.indexes();
    const lifetimes = after.filter(
      (one) => (one as { expireAfterSeconds?: number }).expireAfterSeconds !== undefined,
    );
    assert.equal(lifetimes.length, 1, 'one lifetime on this collection');
    assert.equal((lifetimes[0] as { expireAfterSeconds?: number }).expireAfterSeconds, 0, 'the declared one');
  });

  it('starts when the name and the key are blocked by different indexes at once', async () => {
    // The harder half. Something else holds the name being asked for, and the
    // key being asked for sits under another name. Resolving only one of them
    // leaves the other, and the retry meets the same refusal having already
    // thrown away a live index.
    const { createStore } = await import('../src/db.js');
    const items = harness.store.items;
    const declared = (await items.indexes()).find(
      (one) => JSON.stringify(one.key) === '{"projectId":1,"slug":1}',
    ) as { name: string };

    await items.dropIndex(declared.name);
    // The declared key, under somebody else's name.
    await items.createIndex({ projectId: 1, slug: 1 }, { name: 'wearing_another_name', unique: true });
    // And the declared name, over a key that has nothing to do with it.
    await items.createIndex({ title: 1 }, { name: declared.name });

    const second = await createStore(harness.config.mongoUri, harness.config.mongoDb);
    assert.ok(second, 'it starts');
    await second.client.close();

    const after = await items.indexes();
    const byKey = after.filter((one) => JSON.stringify(one.key) === '{"projectId":1,"slug":1}');
    assert.equal(byKey.length, 1, 'one index on that key');
    assert.equal((byKey[0] as { name?: string }).name, declared.name, 'under the declared name');
    assert.equal((byKey[0] as { unique?: boolean }).unique, true, 'and unique, as declared');
  });
});

describe('the filters a slow search is told to use', () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness?.stop();
  });

  it('offers only filters that really cut what a search reads, and keeps label as the one that does not', async () => {
    const refusal = searchTooSlow(harness.store, { code: 50 });
    assert.ok(refusal, 'a MaxTimeMSExpired is what this turns into a refusal');

    // Every filter the sentence offers comes from one list, so a fifth one
    // cannot be added in prose without joining it and being measured here.
    for (const name of SEARCH_NARROWERS) {
      assert.ok(refusal.message.includes(`${name}=`), `the refusal offers ${name}=`);
    }

    // Measured, not inferred from the index definitions. A field can sit in an
    // index and still not bound the scan, and it can fail to bound the scan and
    // still cut the read, because the predicate runs against index keys before
    // anything is fetched. Documents fetched is the number a caller feels, so
    // that is the number this asserts.
    const project = 'p_narrowing';
    const areas = ['errors', 'trades', 'ops', 'docs'];
    await harness.store.items.insertMany(
      Array.from({ length: 400 }, (_, i) => ({
        _id: `i_narrow_${i}`,
        projectId: project,
        slug: `${areas[i % areas.length]}:card-${i}`,
        title: `withdraw stuck ${i}`,
        status: i % 4 === 0 ? 'open' : 'done',
        labels: [areas[i % areas.length]!],
        owner: i % 8 === 0 ? 'alex' : null,
        source: i % 10 === 0 ? 'makler' : null,
        priority: 0,
        touchedAt: new Date(),
      })) as never,
    );

    const fetched = async (extra: Record<string, unknown>): Promise<number> => {
      const search = {
        $and: [
          {
            $or: [
              { slug: { $regex: 'card', $options: 'i' } },
              { title: { $regex: 'card', $options: 'i' } },
            ],
          },
        ],
      };
      const plan = await harness.store.items
        .find({ projectId: project, ...extra, ...search })
        .explain('executionStats');
      return (plan as { executionStats: { totalDocsExamined: number } }).executionStats
        .totalDocsExamined;
    };

    const bare = await fetched({});
    assert.ok(bare > 0, 'the fixture is there to be read');

    const asked: Record<(typeof SEARCH_NARROWERS)[number], Record<string, unknown>> = {
      status: { status: 'open' },
      owner: { owner: 'alex' },
      source: { source: 'makler' },
      prefix: { slug: { $regex: '^errors:' } },
    };
    for (const name of SEARCH_NARROWERS) {
      const narrowed = await fetched(asked[name]!);
      assert.ok(
        narrowed < bare,
        `${name}= is offered as a way to read less, and it read ${narrowed} of ${bare}`,
      );
    }

    // The counterexample, measured the same way. If a labels index ever appears
    // that a bare label= can use, this fails, and the sentence is what to change.
    assert.equal(
      await fetched({ labels: 'errors' }),
      bare,
      'label= reads exactly as much as no filter at all, which is why it is not offered',
    );
    assert.match(refusal.message, /neither does label=/);

    // Every door that gives this advice has to give the same one. Four of the
    // five used to spell the list out by hand, and every one of them was wrong
    // at the same time.
    // Read off the served surfaces, not the source, because what drifts is what
    // a stranger is handed.
    const asServed = async (url: string): Promise<string> =>
      (await harness.server.inject({ method: 'GET', url })).body;
    const listed = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    const tool = (listed.json().result.tools as Array<{ name: string }>).find(
      (one) => one.name === 'list_items',
    );
    const published: Array<[string, string]> = [
      ['the refusal', refusal.message],
      ['skill.md', await asServed('/skill.md')],
      ['the OpenAPI document', await asServed('/openapi.json')],
      ['the MCP tool', JSON.stringify(tool)],
      ['the catalogue', await asServed('/.well-known/agent-access.json')],
    ];
    for (const [where, text] of published) {
      for (const name of SEARCH_NARROWERS) {
        assert.ok(text.includes(`${name}=`), `${where} names ${name}=`);
      }
      // Not just the names somewhere in the document: the rendered list, whole
      // and in order. A hand-written second copy satisfies a search for the
      // names and contradicts the generated one, which is how the last of
      // these survived a review. Reading prose with a regex is what produced
      // the false alarm before that, so this compares against the rendering
      // instead of trying to find sentences.
      // Exactly one rendering per document, whole and in order. Not "somewhere
      // in the text": a second, hand-written copy satisfies a search for the
      // names while contradicting the generated one, which is how the last of
      // these survived a review. Counting instead of matching prose, because
      // reading these sentences with a regex is what produced a false alarm
      // one round earlier.
      const renderings =
        text.split(SEARCH_NARROWING).length - 1 + (text.split(SEARCH_NARROWING_MD).length - 1);
      assert.ok(
        renderings >= 1,
        `${where} carries the list as it is rendered, whole and in order, not a copy of it`,
      );
      // Twice in a schema is two parameter descriptions, which is fine. Twice
      // in the document an agent reads start to finish is the same advice
      // given twice, and that is the shape the duplicate took: a paragraph
      // about the namespace repeating the search section's list, free to go
      // stale beside it while every check still passed.
      if (where === 'skill.md') {
        assert.equal(renderings, 1, 'skill.md gives this advice in one place');
      }
    }
  });
});
