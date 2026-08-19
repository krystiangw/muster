import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { RATE_LIMIT_SCOPES } from '../src/config.js';
import { agentAccessJson } from '../src/content.js';
import { authed, createProject, startHarness, type Harness, type Project } from './helper.js';

let harness: Harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness.stop();
});

async function post(project: Project, path: string, payload: unknown) {
  return harness.server.inject({
    method: 'POST',
    url: `${project.api}${path}`,
    headers: authed(project),
    payload: payload as Record<string, unknown>,
  });
}

async function get(project: Project, path: string) {
  return harness.server.inject({
    method: 'GET',
    url: `${project.api}${path}`,
    headers: authed(project),
  });
}

describe('signup', () => {
  it('creates a project, a token and a read url in one unauthenticated call', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: '/p',
      payload: { name: 'fleet' },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.match(body.project, /^p_/);
    assert.match(body.token, /^mk_/);
    assert.match(body.read_url, /\/r\/r_/);
    assert.ok(body.expires_at, 'an unclaimed project must carry an expiry');
  });

  it('rejects an unknown token', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/v1/p_nope/agents',
      headers: { authorization: 'Bearer mk_wrong' },
    });
    assert.equal(response.statusCode, 401);
  });

  it('rejects a token from another project', async () => {
    const a = await createProject(harness, 'a');
    const b = await createProject(harness, 'b');
    const response = await harness.server.inject({
      method: 'GET',
      url: `${b.api}/agents`,
      headers: authed(a),
    });
    assert.equal(response.statusCode, 403);
  });
});

describe('items', () => {
  // The cheap way to read one area of a large board, and the reason it is cheap
  // is that it is anchored: `q=` is a substring and scans, this walks the unique
  // index on the slug. A filter that also matched the middle of a slug would be
  // the expensive one wearing the cheap one's name.
  it('narrows to one namespace, by the start of the slug and not the middle of it', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'ops:sweep', title: 'sweep', actor: 'a' });
    await post(project, '/items', { slug: 'ops:cutover', title: 'cutover', actor: 'a' });
    // Carries the prefix, does not start with it. This is the fixture the whole
    // test turns on: an unanchored filter finds it, an anchored one does not.
    await post(project, '/items', { slug: 'docs:ops:runbook', title: 'runbook', actor: 'a' });

    const page = (await get(project, '/items?prefix=ops:')).json();
    assert.deepEqual(
      page.items.map((item: { slug: string }) => item.slug).sort(),
      ['ops:cutover', 'ops:sweep'],
    );

    // The same words through the search box, which is the filter this one is
    // not: three cards mention ops, and that is the answer q= is for.
    const searched = (await get(project, '/items?q=ops:')).json();
    assert.equal(searched.items.length, 3);

    // A pattern is not a prefix. A caller sending one gets the cards whose
    // slug starts with those characters, which is none, rather than a regex
    // this door then runs.
    const literal = (await get(project, '/items?prefix=.*')).json();
    assert.deepEqual(literal.items, []);

    const refused = await get(project, '/items?prefix[$ne]=x');
    assert.ok(refused.statusCode >= 400, 'a query in a field that takes a word is refused');
  });

  it('is idempotent on slug: two writes converge on one item', async () => {
    const project = await createProject(harness);
    const first = await post(project, '/items', {
      slug: 'errors:withdraw-stuck',
      title: 'Withdraw stuck',
      body: 'first pass',
      actor: 'errors-loop',
    });
    assert.equal(first.statusCode, 201);
    assert.equal(first.json().created, true);

    const second = await post(project, '/items', {
      slug: 'errors:withdraw-stuck',
      body: 'second pass',
      note: 'found the cause',
      actor: 'other-loop',
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().created, false);

    const list = await get(project, '/items');
    assert.equal(list.json().items.length, 1);

    const item = await get(project, '/items/errors:withdraw-stuck');
    const timeline = item.json().item.timeline;
    assert.equal(item.json().item.body, 'second pass');
    assert.equal(timeline.length, 2);
    assert.equal(timeline[1].message, 'found the cause');
  });

  it('normalises a slug rather than inventing a second identity', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'Errors: Withdraw Stuck', title: 'x', actor: 'a' });
    const again = await post(project, '/items', { slug: 'errors:-withdraw-stuck', title: 'x', actor: 'a' });
    assert.equal(again.json().created, false);
  });

  it('warns when an open item already carries the same title', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'a-one', title: 'Venue A withdraw stuck', actor: 'a' });
    const twin = await post(project, '/items', {
      slug: 'b-two',
      title: 'venue-a withdraw stuck',
      actor: 'b',
    });
    // Two warnings now: the twin, and the fact that "b" never registered.
    const warnings = twin.json().warnings as string[];
    assert.equal(warnings.filter((line) => line.includes('a-one')).length, 1);
  });

  it('says so when the writer is a handle nobody registered', async () => {
    // Accepted on purpose, because refusing a write over bookkeeping loses the
    // write. Silent was the problem: one typo in a handle put a second
    // identity on the board that /next then never offered work to.
    const project = await createProject(harness);
    const stranger = await post(project, '/items', {
      slug: 'ops:thing',
      title: 'a thing',
      actor: 'errrors-loop',
    });
    assert.match((stranger.json().warnings as string[]).join(' '), /No agent is registered/);

    await post(project, '/agents', { handle: 'errors-loop', scope: [] });
    const known = await post(project, '/items', {
      slug: 'ops:thing',
      title: 'a thing',
      actor: 'errors-loop',
    });
    assert.deepEqual(known.json().warnings, []);
  });

  it('says which end of the priority scale is urgent, everywhere it is offered', async () => {
    // The author of this system used the scale backwards for four hours,
    // because nothing said which way it ran and getting it wrong is silent:
    // /next keeps answering, it just answers with the wrong work.
    const protocol = await harness.server.inject({ method: 'GET', url: '/skill.md' });
    assert.match(protocol.body, /higher means more urgent/i);

    const openapi = await harness.server.inject({ method: 'GET', url: '/openapi.json' });
    const schema = JSON.stringify(openapi.json());
    assert.match(schema, /Higher is more urgent/);

    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    const board = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(board.body, /Higher is more urgent/);

    // And the behaviour the sentence promises.
    await post(project, '/items', { slug: 'small', title: 'small', priority: 1, actor: 'a' });
    await post(project, '/items', { slug: 'urgent', title: 'urgent', priority: 9, actor: 'a' });
    await post(project, '/agents', { handle: 'a', scope: [] });
    const next = await get(project, '/next?agent=a');
    assert.equal(next.json().item.slug, 'urgent', 'the larger number goes first');
  });

  it('pages through everything, so an import can be checked against its source', async () => {
    // Reported from another project mid-migration: 781 rows to move and no way
    // to read back past the two hundredth, which makes the import unverifiable.
    const project = await createProject(harness, 'migrated');
    for (let n = 0; n < 25; n += 1) {
      await post(project, '/items', {
        slug: `row-${String(n).padStart(3, '0')}`,
        title: `row ${n}`,
        priority: n % 3,
        actor: 'importer',
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { items: Array<{ slug: string }>; next_cursor: string | null } = (
        await get(project, `/items?limit=10&order=id${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      ).json();
      seen.push(...page.items.map((item) => item.slug));
      cursor = page.next_cursor;
      pages += 1;
      assert.ok(pages < 10, 'the cursor has to end, not loop');
    } while (cursor);

    assert.equal(seen.length, 25, 'every row came back exactly once');
    assert.equal(new Set(seen).size, 25);
    assert.equal(pages, 3, 'and the short last page said so rather than making us ask again');
  });

  it('pages in urgency order without losing the rows that tie', async () => {
    const project = await createProject(harness, 'tied');
    // Every row has the same priority, and several land in the same
    // millisecond: a cursor on one field alone drops all but the first.
    await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        post(project, '/items', { slug: `tie-${n}`, title: `tie ${n}`, priority: 4, actor: 'a' }),
      ),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: Array<{ slug: string }>; next_cursor: string | null } = (
        await get(project, `/items?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      ).json();
      seen.push(...page.items.map((item) => item.slug));
      cursor = page.next_cursor;
    } while (cursor);

    assert.equal(new Set(seen).size, 12, 'all twelve, none twice');
  });

  it('refuses a cursor from the other order instead of quietly restarting', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'one', title: 'one', actor: 'a' });
    const refused = await get(project, '/items?limit=1&order=id&cursor=3|not-a-date|x');
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().error, 'bad_cursor');
  });

  it('records a status transition in the timeline', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'x', title: 'x', actor: 'a' });
    await post(project, '/items', { slug: 'x', status: 'done', note: 'shipped', actor: 'a' });
    const item = (await get(project, '/items/x')).json().item;
    assert.equal(item.status, 'done');
    assert.ok(item.closed_at);
    assert.equal(item.timeline.at(-1).kind, 'status');
    assert.match(item.timeline.at(-1).message, /open -> done: shipped/);
  });

  it('converges when ten agents file the same new slug at once', async () => {
    const project = await createProject(harness);
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        post(project, '/items', {
          slug: 'errors:same-problem',
          title: 'the same problem',
          actor: `agent-${i}`,
          note: `from agent ${i}`,
        }),
      ),
    );

    assert.equal(responses.filter((r) => r.statusCode >= 400).length, 0, 'nobody gets an error');
    assert.equal(
      responses.filter((r) => r.json().created === true).length,
      1,
      'exactly one writer is told it created the item',
    );

    const list = await get(project, '/items');
    assert.equal(list.json().items.length, 1, 'one slug, one item');

    const item = await get(project, '/items/errors:same-problem');
    assert.equal(item.json().item.timeline.length, 10, 'every writer is in the timeline');
  });

  it('carries history over from another system with its own timestamps, for admins only', async () => {
    const project = await createProject(harness);
    const response = await post(project, '/items', {
      slug: 'migrated',
      title: 'came from the old board',
      actor: 'migration',
      history: [
        { at: '2026-04-16T20:16:55.485Z', by: 'audit-sync', message: 'first sighting' },
        { at: '2026-05-02T09:00:00.000Z', by: 'errors-loop', message: 'root cause found' },
      ],
      note: 'imported',
    });
    assert.equal(response.statusCode, 201);

    const item = (await get(project, '/items/migrated')).json().item;
    assert.equal(item.timeline.length, 3, 'two carried entries plus the import note');
    assert.equal(item.timeline[0].by, 'audit-sync');
    assert.equal(item.timeline[0].at.slice(0, 10), '2026-04-16');
    assert.equal(item.timeline[1].by, 'errors-loop');

    // A worker key must not be able to backdate somebody else's words.
    const minted = await post(project, '/keys', { name: 'worker', role: 'write' });
    const asWorker = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: { authorization: `Bearer ${minted.json().token}` },
      payload: {
        slug: 'forged',
        title: 'x',
        actor: 'worker',
        history: [{ at: '2020-01-01T00:00:00.000Z', by: 'somebody-else', message: 'I said this' }],
      },
    });
    assert.equal(asWorker.statusCode, 403);

    const rejected = await post(project, '/items', {
      slug: 'bad-history',
      title: 'x',
      actor: 'migration',
      history: [{ at: 'not a date', message: 'nope' }],
    });
    assert.equal(rejected.statusCode, 400);

    // Re-running a migration after a failure must not append the history twice.
    await post(project, '/items', {
      slug: 'migrated',
      title: 'came from the old board',
      actor: 'migration',
      history: [
        { at: '2026-04-16T20:16:55.485Z', by: 'audit-sync', message: 'first sighting' },
        { at: '2026-05-02T09:00:00.000Z', by: 'errors-loop', message: 'root cause found' },
      ],
    });
    const rerun = (await get(project, '/items/migrated')).json().item;
    assert.equal(rerun.timeline.filter((e: { message: string }) => e.message === 'first sighting').length, 1);
  });

  it('puts carried history in chronological order whatever order it arrives in', async () => {
    const project = await createProject(harness);
    await post(project, '/items', {
      slug: 'unsorted',
      title: 'x',
      actor: 'migration',
      history: [
        { at: '2026-05-02T09:00:00.000Z', by: 'b', message: 'second' },
        { at: '2026-04-16T20:16:55.485Z', by: 'a', message: 'first' },
      ],
    });
    const item = (await get(project, '/items/unsorted')).json().item;
    assert.equal(item.timeline[0].message, 'first');
    assert.equal(item.timeline[1].message, 'second');
  });

  it('refuses a write over a change it did not see', async () => {
    // The browser's edit form has written guarded since it existed and the
    // door this product is for could not: the mechanism sat in the domain,
    // reachable from one side only. Two loops correcting the same card is
    // ordinary, and the second one to write used to win silently.
    const project = await createProject(harness);
    await post(project, '/items', {
      slug: 'errors:withdraw',
      title: 'Withdraws stuck',
      body: 'Parked behind a bridge.',
      actor: 'errors-loop',
    });
    // Somebody else got there in between.
    await post(project, '/items', { slug: 'errors:withdraw', body: 'The signer, not the venue.', actor: 'ops-loop' });

    const stale = await post(project, '/items', {
      slug: 'errors:withdraw',
      body: 'Corrected from what I read.',
      expect: { body: 'Parked behind a bridge.' },
      must_exist: true,
      actor: 'errors-loop',
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, 'changed_underneath');
    assert.equal(
      (await harness.store.items.findOne({ projectId: project.id, slug: 'errors:withdraw' }))?.body,
      'The signer, not the venue.',
      'and nothing was written',
    );

    const fresh = await post(project, '/items', {
      slug: 'errors:withdraw',
      body: 'Corrected: the signer.',
      expect: { body: 'The signer, not the venue.' },
      must_exist: true,
      actor: 'errors-loop',
    });
    assert.equal(fresh.statusCode, 200, fresh.body);

    // A card that is not there is not created by a guarded write.
    const absent = await post(project, '/items', {
      slug: 'errors:never-filed',
      title: 'x',
      must_exist: true,
      actor: 'errors-loop',
    });
    assert.equal(absent.statusCode, 404);

    // And the same guard over the other door, because two doors mean one
    // behaviour or they mean nothing.
    const overMcp = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: authed(project),
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'upsert_item',
          arguments: {
            slug: 'errors:withdraw',
            body: 'Written blind.',
            expect: { body: 'Parked behind a bridge.' },
            actor: 'errors-loop',
          },
        },
      },
    });
    assert.match(JSON.stringify(overMcp.json()), /changed_underneath/);

    // And a guard that is a query rather than a memory is refused. MCP
    // arguments are whatever a model produced, and this one is spread into the
    // filter of the write right after the project and the slug: a crafted
    // `expect` would otherwise overwrite the scoping and reach another
    // project's card.
    const other = await createProject(harness, 'somebody else');
    await post(other, '/items', { slug: 'victim', title: 'theirs', body: 'theirs', actor: 'their-loop' });
    const crafted = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: authed(project),
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'upsert_item',
          arguments: {
            slug: 'victim',
            title: 'taken',
            expect: { projectId: { $ne: null }, slug: 'victim' },
            actor: 'errors-loop',
          },
        },
      },
    });
    assert.match(JSON.stringify(crafted.json()), /bad_expect/);
    assert.equal(
      (await harness.store.items.findOne({ projectId: other.id, slug: 'victim' }))?.title,
      'theirs',
      'and the other project keeps its card',
    );

    // A guard that says nothing is not a guard, and quietly writing without
    // one is the failure this whole mechanism exists to prevent. (A number
    // where a string belongs is coerced by the HTTP schema into the string it
    // reads as, which is a guard that simply does not match: 409, not 400.)
    for (const bad of [null, [], {}]) {
      const answer = await post(project, '/items', {
        slug: 'errors:withdraw',
        body: 'written unguarded',
        expect: bad,
        actor: 'errors-loop',
      });
      assert.equal(answer.statusCode, 400, JSON.stringify(bad));
    }

    // Over MCP nothing coerces, because nothing validates: the arguments are
    // whatever a model produced, and the service is the only thing between
    // them and the filter.
    const wrongType = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: authed(project),
      payload: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'upsert_item',
          arguments: { slug: 'errors:withdraw', body: 'blind', expect: { title: 7 }, actor: 'errors-loop' },
        },
      },
    });
    assert.match(JSON.stringify(wrongType.json()), /bad_expect/);
  });

  it('refuses a query where a name belongs, at whichever door it arrives', async () => {
    // MCP arguments are whatever a model produced and nothing validates them
    // on the way in, so every one that lands in a filter is checked where the
    // doors meet. Found by firing crafted arguments at a local copy: an
    // `agent` of {"$ne": null} read every agent's inbox, a `status` of
    // {"$ne": "nope"} listed everything, and one object inside `present` came
    // back as a 500 rather than a refusal.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });

    const crafted = async (name: string, args: Record<string, unknown>) => {
      const answer = await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        headers: authed(project),
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      });
      const result = answer.json().result;
      assert.equal(result.isError, true, `${name} took it: ${JSON.stringify(result).slice(0, 160)}`);
      assert.equal(result.structuredContent.status, 400, JSON.stringify(result.structuredContent));
      return result.structuredContent.code as string;
    };

    await crafted('list_items', { status: { $ne: 'nope' } });
    await crafted('list_items', { owner: { $ne: null } });
    await crafted('inbox', { agent: { $ne: null } });
    await crafted('next_item', { agent: { $gt: '' } });
    await crafted('claim_item', { slug: 'work', agent: { $ne: null } });
    await crafted('observe', { source: 'venue', present: [{ $ne: null }] });
    await crafted('board', { agent: { $ne: null } });
    // `null` is a value somebody sent, not an argument they left out: reading
    // the two the same way is how a filter quietly widens to everything.
    await crafted('inbox', { agent: null });
    await crafted('list_items', { status: null });

    // And the ordinary calls still go through, which is the half of this that
    // a refusal is easy to break.
    const fine = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: authed(project),
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_items', arguments: { status: 'open', limit: 5 } },
      },
    });
    assert.equal(fine.json().result.structuredContent.items.length, 1);
  });

  it('hands a fleet distinct work when it asks for the claim in the same call', async () => {
    // `/next` deliberately does not claim, and the cost of that shows up on a
    // fleet: ten loops asking at once are all offered the same item, one wins
    // the claim that follows and nine spend a round trip losing. Measured
    // against a local copy before this existed: ten asks, one item, nine 409s.
    const project = await createProject(harness);
    for (let n = 0; n < 10; n += 1) {
      await post(project, '/items', { slug: `work-${n}`, title: `work ${n}`, actor: 'filer' });
    }

    const asked = await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        harness.server.inject({
          method: 'POST',
          url: `${project.api}/next`,
          headers: authed(project),
          payload: { agent: `loop-${n}` },
        }),
      ),
    );
    const handed = asked.map((answer) => answer.json()).filter((body) => body.item);
    const slugs = handed.map((body) => body.item.slug);
    assert.equal(new Set(slugs).size, slugs.length, `two loops got the same item: ${slugs.join()}`);
    // All ten, not most of them: selecting and claiming are one update now, so
    // there is no gap for two loops to read the same item out of. An earlier
    // version offered and then claimed, and three of ten came back with
    // nothing after losing the race three times.
    assert.equal(slugs.length, 10, `only ${slugs.length} of ten were served: ${slugs.join()}`);
    for (const body of handed) {
      assert.equal(body.claimed, true);
      assert.ok(body.item.claim, 'and it comes back already held');
    }

    // The lease belongs to whoever asked, not to whoever asked first.
    for (const body of handed) {
      const item = await harness.store.items.findOne({ projectId: project.id, slug: body.item.slug });
      assert.equal(item?.claim?.agent, body.item.claim.agent);
    }

    // GET stays a look, which is what makes it safe to poll and safe for a
    // proxy or a client to retry. A GET that claims is a GET that takes a
    // second item on a retry nobody wrote.
    const looked = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/next?agent=looker`,
      headers: authed(project),
    });
    assert.equal(looked.json().claimed, undefined);
    assert.equal(looked.json().item, null, 'everything is held by the fleet above');
    const refusedFlag = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/next?agent=looker&claim=true`,
      headers: authed(project),
    });
    assert.equal(refusedFlag.statusCode, 400, 'and the flag is not a thing on this door');

    // And taking needs a name to take it for.
    const nameless = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/next`,
      headers: authed(project),
      payload: {},
    });
    assert.equal(nameless.statusCode, 400);
  });

  it('files what comes next when an item finishes, once', async () => {
    // A pipeline written on the work rather than in an orchestrator nobody
    // here runs. Idempotent because the successor is a slug like everything
    // else: finishing the same item twice files one card.
    const project = await createProject(harness);
    await post(project, '/items', {
      slug: 'errors:withdraw',
      title: 'Withdraws stuck',
      actor: 'errors-loop',
      then: { slug: 'ops:bridge', title: 'Bridge it, or wait?', priority: 5, owner: 'alex' },
    });

    // Nothing is filed while it is open.
    assert.equal(await harness.store.items.countDocuments({ projectId: project.id }), 1);

    const finished = await post(project, '/items', {
      slug: 'errors:withdraw',
      status: 'done',
      actor: 'errors-loop',
    });
    assert.equal(finished.statusCode, 200);
    assert.equal(finished.json().chained.slug, 'ops:bridge', finished.body);
    const next = await harness.store.items.findOne({ projectId: project.id, slug: 'ops:bridge' });
    assert.equal(next?.title, 'Bridge it, or wait?');
    assert.equal(next?.priority, 5);
    assert.equal(next?.owner, 'alex');
    assert.match(next!.timeline.at(-1)!.message, /filed by "errors:withdraw", which finished/);
    const done = await harness.store.items.findOne({ projectId: project.id, slug: 'errors:withdraw' });
    assert.match(done!.timeline.at(-1)!.message, /so "ops:bridge" is filed/);

    // Written to again while already done: the crossing happened once, so
    // nothing is filed again and nothing is reopened.
    const again = await post(project, '/items', {
      slug: 'errors:withdraw',
      status: 'done',
      body: 'and a closing remark',
      actor: 'errors-loop',
    });
    assert.equal(again.json().chained, undefined);
    assert.equal(await harness.store.items.countDocuments({ projectId: project.id }), 2);
    assert.equal(
      (await harness.store.items.findOne({ projectId: project.id, slug: 'ops:bridge' }))?.status,
      'open',
      'and the successor is left where it was',
    );

    // A card cannot name itself: that is a loop with one step in it.
    const selfish = await post(project, '/items', {
      slug: 'errors:loop',
      title: 'x',
      actor: 'a',
      then: { slug: 'errors:loop' },
    });
    assert.equal(selfish.statusCode, 400);
    assert.equal(selfish.json().error, 'bad_then');
  });

  it('chains through a board move as well, because a move is a write', async () => {
    // The move applies a status through the same write every other door uses,
    // which is the only reason this needs no second implementation.
    const project = await createProject(harness);
    await post(project, '/items', {
      slug: 'first',
      title: 'first',
      actor: 'a',
      then: { slug: 'second', title: 'second' },
    });
    const moved = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/first/move`,
      headers: authed(project),
      payload: { column: 'done', agent: 'a' },
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.ok(
      await harness.store.items.findOne({ projectId: project.id, slug: 'second' }),
      'the card it files next is on the board',
    );
    assert.equal(moved.json().chained.slug, 'second', 'and the move says what it set going');
  });

  it('files the successor into the slot the finish just freed', async () => {
    // At the cap, closing one card frees exactly one slot, which is the slot
    // the next card needs. The caller's copy of the counts still said full.
    const project = await createProject(harness);
    await harness.store.projects.updateOne({ _id: project.id }, { $set: { 'limits.items': 1 } });
    await post(project, '/items', {
      slug: 'only',
      title: 'the only open card',
      actor: 'a',
      then: { slug: 'after', title: 'what comes after' },
    });

    const finished = await post(project, '/items', { slug: 'only', status: 'done', actor: 'a' });
    assert.equal(finished.statusCode, 200, finished.body);
    assert.equal(finished.json().chained?.slug, 'after', JSON.stringify(finished.json().warnings));
    // The only remark is the usual one about an unregistered handle: nothing
    // said the successor could not be filed.
    assert.ok(
      !finished.json().warnings.some((line: string) => line.includes('was not created')),
      JSON.stringify(finished.json().warnings),
    );
  });

  it('enforces the project item cap', async () => {
    const project = await createProject(harness);
    await harness.store.projects.updateOne(
      { _id: project.id },
      { $set: { 'limits.items': 1 } },
    );
    await post(project, '/items', { slug: 'one', title: 'one', actor: 'a' });
    const second = await post(project, '/items', { slug: 'two', title: 'two', actor: 'a' });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error, 'limit_reached');

    // The same cap met by moving finished work back into an open column. It
    // used to answer 429, which this service publishes as "read retry-after
    // and come back": a cap that only clears when somebody finishes work sends
    // no retry-after and never clears on its own, so an agent handling 429 the
    // documented way would retry it until its loop gave up.
    await post(project, '/items', { slug: 'one', title: 'one', status: 'done', actor: 'a' });
    await post(project, '/items', { slug: 'filler', title: 'filler', actor: 'a' });
    const reopened = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/one/move`,
      headers: authed(project),
      payload: { column: 'todo', agent: 'a' },
    });
    assert.equal(reopened.statusCode, 409, reopened.body);
    assert.equal(reopened.json().error, 'limit_reached');
    assert.equal(reopened.headers['retry-after'], undefined, 'and it is not a wait');
  });
});

describe('claims', () => {
  it('gives the item to one agent and names the holder to the other', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });

    const first = await post(project, '/items/work/claim', { agent: 'agent-a', ttl_minutes: 30 });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().ok, true);

    const second = await post(project, '/items/work/claim', { agent: 'agent-b' });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().held_by, 'agent-a');
  });

  it('lets the holder extend and release, and the next agent take over', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });
    await post(project, '/items/work/claim', { agent: 'agent-a' });

    const beat = await post(project, '/items/work/heartbeat', { agent: 'agent-a', ttl_minutes: 90 });
    assert.equal(beat.statusCode, 200);

    const wrongHolder = await post(project, '/items/work/heartbeat', { agent: 'agent-b' });
    assert.equal(wrongHolder.statusCode, 409);

    await post(project, '/items/work/release', { agent: 'agent-a', note: 'handing over' });
    const taken = await post(project, '/items/work/claim', { agent: 'agent-b' });
    assert.equal(taken.json().ok, true);
  });

  it('takes a release of work nobody holds, and refuses one held by somebody else', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });
    await post(project, '/items/work/claim', { agent: 'agent-a' });

    // The ordinary end of a piece of work: closing releases the claim, so the
    // release an agent runs in its `finally` arrives second and finds nothing
    // to do. That is the sequence the protocol documents, and it used to end in
    // a 409.
    await post(project, '/items', { slug: 'work', status: 'done', actor: 'agent-a' });
    const after = await post(project, '/items/work/release', { agent: 'agent-a' });
    assert.equal(after.statusCode, 200);
    const timeline = after.json().item.timeline_count;

    // And again, to make the point that it is the state and not the sequence:
    // nothing more is written for a release with nothing to release.
    const again = await post(project, '/items/work/release', { agent: 'agent-a' });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().item.timeline_count, timeline, 'nothing to say twice');

    // Somebody else's claim is the case the refusal is for, and it still is.
    await post(project, '/items', { slug: 'held', title: 'held', actor: 'a' });
    await post(project, '/items/held/claim', { agent: 'agent-a' });
    const notYours = await post(project, '/items/held/release', { agent: 'agent-b' });
    assert.equal(notYours.statusCode, 409);
    assert.match(notYours.json().message, /agent-a/, 'and it names who does hold it');

    // A lease that has run out is free work everywhere else, so a release is
    // not the one place a dead claim still holds something. Otherwise the
    // answer would depend on whether hygiene had swept since it expired.
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'held' },
      { $set: { 'claim.expiresAt': new Date(Date.now() - 60_000) } },
    );
    const expired = await post(project, '/items/held/release', { agent: 'agent-b' });
    assert.equal(expired.statusCode, 200);

    // A slug that was never written is a different mistake and says so.
    const missing = await post(project, '/items/never-existed/release', { agent: 'agent-a' });
    assert.equal(missing.statusCode, 404);
  });
});

describe('next', () => {
  it('offers work inside the declared scope and refuses to hand over somebody else’s', async () => {
    const project = await createProject(harness);
    await post(project, '/agents', { handle: 'errors-loop', scope: ['errors:'] });
    await post(project, '/agents', { handle: 'trades-loop', scope: ['trades:'] });
    await post(project, '/items', { slug: 'errors:one', title: 'an error', actor: 'errors-loop' });
    await post(project, '/items', { slug: 'trades:one', title: 'a trade', actor: 'trades-loop' });

    const mine = await get(project, '/next?agent=errors-loop');
    assert.equal(mine.json().item.slug, 'errors:one');

    await post(project, '/items', { slug: 'errors:one', status: 'done', actor: 'errors-loop' });
    const empty = await get(project, '/next?agent=errors-loop');
    assert.equal(empty.json().item, null);
    // Singular or plural, because one item is one item.
    assert.match(empty.json().reason, /1 open item belongs to other scopes/);
  });

  it('hands a restarted agent back its own claim before anything else', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'mine', title: 'mine', priority: 0, actor: 'a' });
    await post(project, '/items', { slug: 'shinier', title: 'shinier', priority: 5, actor: 'a' });
    await post(project, '/items/mine/claim', { agent: 'agent-a', ttl_minutes: 60 });

    const next = await get(project, '/next?agent=agent-a');
    assert.equal(next.json().item.slug, 'mine');
    assert.match(next.json().reason, /you already hold this claim/);
  });

  it('skips items another agent already holds', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'one', title: 'one', actor: 'a' });
    await post(project, '/items', { slug: 'two', title: 'two', actor: 'a' });
    await post(project, '/items/one/claim', { agent: 'agent-a' });
    const next = await get(project, '/next?agent=agent-b');
    assert.equal(next.json().item.slug, 'two');
  });
});

describe('scope warnings', () => {
  // The warning goes to the agent that wrote, and to nobody else. The fixture
  // registers a real owner for `errors:` so this pins which of the two agents
  // hears about the crossing, rather than leaving the area unclaimed and the
  // question unasked.
  it('warns the writer that the write left its own scope, and tells the owner nothing', async () => {
    const project = await createProject(harness);
    await post(project, '/agents', { handle: 'errors-loop', scope: ['errors:'] });
    await post(project, '/agents', { handle: 'dashboard-loop', scope: ['dashboard:'] });
    const response = await post(project, '/items', {
      slug: 'errors:not-mine',
      title: 'someone else’s problem',
      actor: 'dashboard-loop',
    });
    assert.equal(response.statusCode, 201);
    const warnings = response.json().warnings as string[];
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /outside your declared scope/);
    assert.doesNotMatch(warnings[0]!, /errors-loop/);

    // Nothing reached the owner by any route this product has: no timeline
    // entry on the item, and nothing waiting in the owner's inbox.
    const item = (await get(project, '/items/errors:not-mine')).json().item;
    assert.deepEqual(
      item.timeline.map((entry: { kind: string }) => entry.kind),
      ['created'],
    );
    const inbox = (await get(project, '/inbox?agent=errors-loop')).json();
    assert.equal(inbox.answers.length, 0);
    assert.equal(inbox.waiting.length, 0);
  });

  // The agent most likely to walk into someone else's area is the one that
  // declared no area of its own, and it is exactly the one this cannot see.
  // Pinned so the next rewrite of the promise has to face it.
  it('says nothing when the writer declared no scope at all', async () => {
    const project = await createProject(harness);
    await post(project, '/agents', { handle: 'errors-loop', scope: ['errors:'] });
    await post(project, '/agents', { handle: 'drifter', scope: [] });
    const response = await post(project, '/items', {
      slug: 'errors:also-not-mine',
      title: 'written from nowhere in particular',
      actor: 'drifter',
    });
    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.json().warnings, []);
  });
});

describe('escalations', () => {
  it('carries a question to the operator and the answer back to the agent', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'bridge', title: 'bridge or wait', actor: 'errors-loop' });
    const created = await post(project, '/escalations', {
      agent: 'errors-loop',
      question: 'Bridge via the third venue or wait?',
      context: 'Pool depth too thin.',
      priority: 'high',
      item_slug: 'bridge',
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().escalation.id;

    const item = (await get(project, '/items/bridge')).json().item;
    assert.equal(item.timeline.at(-1).kind, 'escalated');

    const emptyInbox = await get(project, '/inbox?agent=errors-loop');
    assert.equal(emptyInbox.json().answers.length, 0);
    // Promised by name in skill.md, so an agent can tell a person who has not
    // decided from a person who has not been told. Null here because nobody
    // owns this board, which is the honest answer rather than a missing field.
    assert.equal(emptyInbox.json().waiting[0].notified_at, null);

    const readToken = (await harness.store.projects.findOne({ _id: project.id }))!.readToken;
    const answer = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/escalations/${id}`,
      payload: 'status=answered&answer=Bridge+it',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(answer.statusCode, 303);

    const inbox = await get(project, '/inbox?agent=errors-loop');
    const answers = inbox.json().answers;
    assert.equal(answers.length, 1);
    assert.equal(answers[0].status, 'answered');
    assert.equal(answers[0].answer, 'Bridge it');
  });
});

describe('taking a question back', () => {
  // The incident this came from: a monitor pointed at the wrong deployment
  // filed three urgent questions and had no way to take any of them back, so
  // the only routes out were leaving a false alarm in a person's queue or
  // reaching for the admin door the product says a worker key should not have.
  it('lets the key a fleet is handed close its own unanswered question', async () => {
    const project = await createProject(harness);
    const worker = (await post(project, '/keys', { name: 'fleet', role: 'write' })).json().token;
    const asWorker = { authorization: `Bearer ${worker}`, 'content-type': 'application/json' };
    await post(project, '/items', { slug: 'ops:cutover', title: 'cutover', actor: 'ops-loop' });
    const raised = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/escalations`,
      headers: asWorker,
      payload: { agent: 'ops-loop', question: 'Bridge or wait?', context: 'thin pool', item_slug: 'ops:cutover' },
    });
    const id = raised.json().escalation.id;
    const before = (await get(project, '')).json().counts.escalations;

    const gone = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/escalations/${id}/withdraw`,
      headers: asWorker,
      payload: { agent: 'ops-loop', reason: 'I was pointing at the wrong deployment' },
    });
    assert.equal(gone.statusCode, 200, gone.body);
    const doc = gone.json().escalation;
    // wont_do stays true for anyone reading it later, and the three fields
    // beside it are what stop it reading as a person having dropped the
    // question, in every inbox on this board and on the operator's own page.
    assert.equal(doc.status, 'wont_do');
    assert.equal(doc.withdrawn_by, 'ops-loop');
    assert.match(doc.withdrawn_reason, /wrong deployment/);
    assert.equal(doc.answer, null, 'nobody answered, so there is no answer to show');

    // The slot comes back, the same as an answer: nobody is waiting on it.
    assert.equal((await get(project, '')).json().counts.escalations, before - 1);

    // The card keeps the status the agent gave it. Nothing here reaches into a
    // status somebody else set, and the note is how they find out why.
    const item = (await get(project, '/items/ops:cutover')).json().item;
    assert.match(item.timeline.at(-1).message, /took back the question/);
  });

  it('refuses once somebody has answered, and says which verb is left', async () => {
    const project = await createProject(harness);
    const raised = await post(project, '/escalations', { agent: 'ops-loop', question: 'Bridge?', context: 'x' });
    const id = raised.json().escalation.id;
    await harness.server.inject({
      method: 'PATCH',
      url: `${project.api}/escalations/${id}`,
      headers: { ...authed(project), 'content-type': 'application/json' },
      payload: { status: 'answered', answer: 'bridge it' },
    });

    const late = await post(project, `/escalations/${id}/withdraw`, {
      agent: 'ops-loop',
      reason: 'changed my mind',
    });
    assert.equal(late.statusCode, 409);
    assert.equal(late.json().error, 'already_answered');
    assert.match(late.json().message, /Acknowledge it instead/);
  });

  it('refuses a second withdrawal, and a reason that says nothing', async () => {
    const project = await createProject(harness);
    const id = (await post(project, '/escalations', { agent: 'ops-loop', question: 'Bridge?', context: 'x' })).json()
      .escalation.id;

    const blank = await post(project, `/escalations/${id}/withdraw`, { agent: 'ops-loop', reason: '   ' });
    assert.equal(blank.statusCode, 400);
    assert.equal(blank.json().error, 'reason_required');

    assert.equal(
      (await post(project, `/escalations/${id}/withdraw`, { agent: 'ops-loop', reason: 'my mistake' })).statusCode,
      200,
    );
    const again = await post(project, `/escalations/${id}/withdraw`, { agent: 'ops-loop', reason: 'again' });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error, 'already_withdrawn');
  });
});

describe('what taking a question back must not do', () => {
  const raise = async (project: Project, agent: string, question: string) =>
    (await post(project, '/escalations', { agent, question, context: 'x' })).json().escalation.id;

  it('closes only your own, since a fleet shares one key', async () => {
    const project = await createProject(harness);
    const theirs = await raise(project, 'errors-loop', 'Bridge or wait?');
    const refused = await post(project, `/escalations/${theirs}/withdraw`, {
      agent: 'trades-loop',
      reason: 'not mine to close',
    });
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json().error, 'not_your_question');
    assert.match(refused.json().message, /errors-loop asked this one/);
    // Untouched: the agent that asked is still waiting on an answer.
    assert.equal((await get(project, `/escalations`)).json().escalations[0].status, 'open');
  });

  it('leaves it where the readers of closed questions look', async () => {
    // Both operator histories and the inbox order closed questions by
    // answeredAt and then take the first page. A withdrawal that left it null
    // would sort behind every answer ever given on the board and vanish from
    // the pages that exist to show it.
    const project = await createProject(harness);
    const older = await raise(project, 'errors-loop', 'answered a while ago');
    await harness.server.inject({
      method: 'PATCH',
      url: `${project.api}/escalations/${older}`,
      headers: { ...authed(project), 'content-type': 'application/json' },
      payload: { status: 'answered', answer: 'do it' },
    });
    const mine = await raise(project, 'errors-loop', 'the one taken back');
    await post(project, `/escalations/${mine}/withdraw`, { agent: 'errors-loop', reason: 'my mistake' });

    const answers = (await get(project, '/inbox?agent=errors-loop')).json().answers;
    assert.equal(answers[0].id, mine, 'the newest closed question is the withdrawn one');
    assert.ok(answers[0].answered_at, 'stamped when it stopped being open, so it sorts');
    assert.equal(answers[0].answer, null, 'and no answer, because nobody gave one');
  });

  it('can be taken back under the handle it was asked with, whatever the door did to it', async () => {
    // The two doors used to store the handle differently: the HTTP schema caps
    // it at 48, MCP arguments are whatever a model produced. A question asked
    // over MCP under a longer handle was stored in a shape no withdrawal could
    // ever match, so it could not be taken back at all.
    const project = await createProject(harness);
    const created = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...authed(project), 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'escalate',
          arguments: { agent: '  errors-loop  ', question: 'asked over MCP', context: 'x' },
        },
      },
    });
    const id = created.json().result.structuredContent.escalation.id;
    assert.equal(created.json().result.structuredContent.escalation.agent, 'errors-loop');

    const taken = await post(project, `/escalations/${id}/withdraw`, {
      agent: '  errors-loop  ',
      reason: 'my mistake',
    });
    assert.equal(taken.statusCode, 200, taken.body);
    assert.equal(taken.json().escalation.withdrawn_by, 'errors-loop');
  });

  it('does not make two agents one by shortening their names', async () => {
    // The handle is compared as an identity here. Cutting it to a length would
    // make every pair of agents whose names agree for that many characters the
    // same agent, and each could close the other's questions.
    // Over MCP on both sides, because the HTTP schema caps the handle at 48 and
    // a collision needs two that are longer.
    const project = await createProject(harness);
    const stem = 'a'.repeat(48);
    const mcp = async (name: string, args: Record<string, unknown>) =>
      harness.server.inject({
        method: 'POST',
        url: '/mcp',
        headers: { ...authed(project), 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      });
    // Refused at the door rather than shortened into somebody else. Over MCP,
    // because that is the door with no schema of its own to stop it, and the
    // one where reconciling two shapes downstream went wrong three times.
    const asked = await mcp('escalate', { agent: `${stem}-one`, question: 'mine', context: 'x' });
    assert.match(JSON.stringify(asked.json().result), /bad_agent/);
    assert.match(JSON.stringify(asked.json().result), /48 characters/);
    assert.equal((await get(project, '/escalations')).json().escalations.length, 0);

    // And the same rule when taking one back, so the two sides cannot disagree
    // about who anybody is.
    const short = await mcp('escalate', { agent: 'errors-loop', question: 'mine', context: 'x' });
    const id = short.json().result.structuredContent.escalation.id;
    const refused = await mcp('withdraw', { id, agent: `${stem}-two`, reason: 'not me' });
    assert.match(JSON.stringify(refused.json().result), /bad_agent/);
    assert.equal(
      (await get(project, '/escalations')).json().escalations[0].status,
      'open',
      'and the agent that asked is still waiting',
    );
  });

  it('finds what it asked, under the handle it asked with', async () => {
    // Every handle ingress normalises the same way, or a padded handle asks
    // successfully and then reads back an empty inbox, which looks exactly
    // like having asked nothing.
    const project = await createProject(harness);
    await raise(project, '  errors-loop  ', 'padded on the way in');
    const waiting = (await get(project, '/inbox?agent=%20%20errors-loop%20%20')).json().waiting;
    assert.equal(waiting.length, 1, 'the question it just asked');
    const listed = (await get(project, '/escalations?agent=%20errors-loop%20')).json().escalations;
    assert.equal(listed.length, 1);
  });

  it('cannot then be acknowledged as though somebody had answered', async () => {
    const project = await createProject(harness);
    const id = await raise(project, 'errors-loop', 'Bridge?');
    await post(project, `/escalations/${id}/withdraw`, { agent: 'errors-loop', reason: 'my mistake' });
    const acted = await post(project, `/escalations/${id}/ack`, { agent: 'errors-loop', note: 'did it' });
    assert.equal(acted.statusCode, 409);
    assert.match(acted.json().message, /took this question back/);
  });

  it('stops being a withdrawal once somebody reopens and answers it', async () => {
    const project = await createProject(harness);
    const id = await raise(project, 'errors-loop', 'Bridge?');
    await post(project, `/escalations/${id}/withdraw`, { agent: 'errors-loop', reason: 'my mistake' });
    const answer = async (status: string, text: string) =>
      harness.server.inject({
        method: 'PATCH',
        url: `${project.api}/escalations/${id}`,
        headers: { ...authed(project), 'content-type': 'application/json' },
        payload: { status, answer: text },
      });
    await answer('open', '');
    await answer('answered', 'bridge it, the pool is fine');

    const doc = (await get(project, `/escalations`)).json().escalations[0];
    assert.equal(doc.status, 'answered');
    assert.equal(doc.answer, 'bridge it, the pool is fine');
    // Both pages a person reads branch on this, so a stale marker would show a
    // real answer as a withdrawal and hide the words somebody wrote.
    assert.equal(doc.withdrawn_at, null);
    assert.equal(doc.withdrawn_by, null);
  });
});

describe('keys', () => {
  it('lets an admin token mint and revoke a write key, and stops a write key from doing it', async () => {
    const project = await createProject(harness);
    const minted = await post(project, '/keys', { name: 'worker-2', role: 'write' });
    assert.equal(minted.statusCode, 201);
    const writeToken = minted.json().token;
    const keyId = minted.json().key.id;

    const asWriter = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: { authorization: `Bearer ${writeToken}` },
      payload: { slug: 'from-worker', title: 'written by the second key', actor: 'worker-2' },
    });
    assert.equal(asWriter.statusCode, 201);

    const escalated = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/keys`,
      headers: { authorization: `Bearer ${writeToken}` },
      payload: { name: 'nope' },
    });
    assert.equal(escalated.statusCode, 403);

    const revoked = await harness.server.inject({
      method: 'DELETE',
      url: `${project.api}/keys/${keyId}`,
      headers: authed(project),
    });
    assert.equal(revoked.statusCode, 200);

    const afterRevoke = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items`,
      headers: { authorization: `Bearer ${writeToken}` },
    });
    assert.equal(afterRevoke.statusCode, 401);
  });
});

describe('claiming a project', () => {
  it('removes the expiry, raises the limits and clears the child TTLs', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'kept', title: 'kept', actor: 'a' });

    const start = await post(project, '/claim', { email: 'human@example.com' });
    assert.equal(start.statusCode, 200);
    assert.equal(start.json().delivery, 'logged');

    const pending = await harness.store.claimCodes.findOne({ projectId: project.id });
    assert.ok(pending);

    const wrong = await post(project, '/claim/verify', {
      email: 'human@example.com',
      code: '000000',
    });
    assert.equal(wrong.statusCode, 400);

    // The real code only exists in the email and the log, so the test plants a
    // known one rather than guessing.
    const { hashToken } = await import('../src/ids.js');
    await harness.store.claimCodes.updateOne(
      { _id: pending!._id },
      { $set: { codeHash: hashToken('123456') } },
    );

    const verified = await post(project, '/claim/verify', {
      email: 'human@example.com',
      code: '123456',
    });
    assert.equal(verified.statusCode, 200);
    const claimed = verified.json().project;
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.expires_at, null);
    assert.equal(claimed.tier, 'free');

    const item = await harness.store.items.findOne({ projectId: project.id, slug: 'kept' });
    assert.equal(item!.expiresAt, null);
  });
});

describe('rate limits', () => {
  it('answers 429 with retry-after once the project creation window is spent', async () => {
    const isolated = await startHarness({ LIMIT_CREATE_PROJECTS_PER_HOUR: '5' });
    try {
      for (let i = 0; i < 5; i += 1) {
        const ok = await isolated.server.inject({ method: 'POST', url: '/p', payload: {} });
        assert.equal(ok.statusCode, 201);
      }
      const limited = await isolated.server.inject({ method: 'POST', url: '/p', payload: {} });
      assert.equal(limited.statusCode, 429);
      assert.ok(Number(limited.headers['retry-after']) > 0);
    } finally {
      await isolated.stop();
    }
  });
});

describe('saying an answer was acted on', () => {
  let project: Project;
  let id: string;

  before(async () => {
    project = await createProject(harness, 'answered');
    await post(project, '/items', { slug: 'stuck', title: 'stuck', actor: 'a' });
    id = (
      await post(project, '/escalations', {
        agent: 'a',
        question: 'Bridge or wait?',
        item_slug: 'stuck',
      })
    ).json().escalation.id;
  });

  it('refuses to acknowledge a question nobody answered', async () => {
    const early = await post(project, `/escalations/${id}/ack`, { agent: 'a', note: 'did it' });
    assert.equal(early.statusCode, 409);
    assert.equal(early.json().error, 'not_answered');
  });

  it('records who acted and what they did, once', async () => {
    const readToken = project.readUrl.split('/r/')[1]!;
    await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/escalations/${id}`,
      payload: new URLSearchParams({ status: 'answered', answer: 'Bridge it.' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    const acted = await post(project, `/escalations/${id}/ack`, {
      agent: 'a',
      note: 'bridged and verified',
    });
    assert.equal(acted.statusCode, 200);
    assert.equal(acted.json().escalation.acted_by, 'a');
    assert.match(acted.json().escalation.acted_note, /bridged/);

    // The item carries it too, because the work is where somebody looks.
    const item = (await get(project, '/items/stuck')).json().item;
    assert.match(item.timeline.at(-1).message, /acted on the operator's answer: bridged/);

    // Twice is a different outcome from once: the second session has to learn
    // that the first already did it, rather than silently repeating the work.
    const again = await post(project, `/escalations/${id}/ack`, { agent: 'b' });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error, 'already_acknowledged');
  });

  it('drops it from the inbox once it has been acted on', async () => {
    const inbox = (await get(project, '/inbox?agent=a')).json().answers;
    assert.ok(!inbox.some((a: { id: string }) => a.id === id), 'not offered a second time');

    const everything = (await get(project, '/inbox?agent=a&include_acted=true')).json().answers;
    assert.ok(everything.some((a: { id: string }) => a.id === id), 'still readable on purpose');
  });

  it('shows the human that their answer landed', async () => {
    const readToken = project.readUrl.split('/r/')[1]!;
    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}` });
    assert.match(page.body, /acted/);
    assert.match(page.body, /bridged and verified/);
  });

  it('lets a reopened question be answered and acted on again', async () => {
    // A new answer is a new decision. Leaving the old acknowledgement in place
    // would keep the question out of the agent's inbox and refuse the second
    // acknowledgement, so the second decision would reach nobody.
    const readToken = project.readUrl.split('/r/')[1]!;
    const answer = async (status: string, text: string) =>
      harness.server.inject({
        method: 'POST',
        url: `/r/${readToken}/escalations/${id}`,
        payload: new URLSearchParams({ status, answer: text }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

    await answer('open', '');
    await answer('answered', 'Actually, wait for the direct withdraw.');

    const waiting = (await get(project, '/inbox?agent=a')).json().answers;
    assert.ok(waiting.some((a: { id: string }) => a.id === id), 'the new decision is offered again');

    const acted = await post(project, `/escalations/${id}/ack`, { agent: 'a', note: 'waited' });
    assert.equal(acted.statusCode, 200);
    assert.match(acted.json().escalation.acted_note, /waited/);
  });
});

describe('answering the same thing twice', () => {
  it('does not put finished work back in the queue', async () => {
    const project = await createProject(harness, 'retried');
    const readToken = project.readUrl.split('/r/')[1]!;
    const id = (
      await post(project, '/escalations', { agent: 'a', question: 'Ship it?' })
    ).json().escalation.id;
    const answer = async (text: string) =>
      harness.server.inject({
        method: 'POST',
        url: `/r/${readToken}/escalations/${id}`,
        payload: new URLSearchParams({ status: 'answered', answer: text }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

    await answer('Ship it.');
    await post(project, `/escalations/${id}/ack`, { agent: 'a', note: 'shipped' });

    // A client that timed out and retried sends the same decision again. That
    // is not a new decision, and treating it as one hands the same work back.
    await answer('Ship it.');
    const inbox = (await get(project, '/inbox?agent=a')).json().answers;
    assert.ok(!inbox.some((e: { id: string }) => e.id === id), 'still done');

    // A different decision is a different matter.
    await answer('Actually, hold.');
    const reopened = (await get(project, '/inbox?agent=a')).json().answers;
    assert.ok(reopened.some((e: { id: string }) => e.id === id), 'the new one is offered');
  });
});

describe('a report from somebody with no account', () => {
  it('is refused by a deployment that never opted in', async () => {
    const closed = await harness.server.inject({
      method: 'POST',
      url: '/feedback',
      payload: { title: 'something is wrong' },
    });
    assert.equal(closed.statusCode, 404);
    assert.equal(closed.json().error, 'not_accepting');
  });

  it('lands on the nominated board, and the same report twice is one item', async () => {
    // The project has to exist in the deployment that names it, so it is made
    // in the same database the second harness will read.
    const open = await startHarness();
    const host = await createProject(open, 'inbox for reports');
    await open.stop();
    const nominated = await startHarness({
      MONGODB_DB: open.config.mongoDb,
      FEEDBACK_PROJECT: host.id,
    });
    try {
      const first = await nominated.server.inject({
        method: 'POST',
        url: '/feedback',
        payload: {
          title: 'Claims do not expire when the process dies',
          body: 'Seen twice on our fleet.',
          from: 'kanga-arbitrage',
          source: 'arbitrage-fleet',
        },
      });
      assert.equal(first.statusCode, 201);
      assert.equal(first.json().created, true);
      assert.match(first.json().slug, /^feedback:/);
      // A receipt, not a capability: nothing here opens somebody's board.
      assert.ok(!JSON.stringify(first.json()).includes(host.id));
      assert.ok(!JSON.stringify(first.json()).includes('/r/'));

      const again = await nominated.server.inject({
        method: 'POST',
        url: '/feedback',
        payload: { title: 'Claims do not expire when the process dies', body: 'Third time.' },
      });
      assert.equal(again.statusCode, 200);
      assert.equal(again.json().created, false);

      const item = (
        await nominated.server.inject({
          method: 'GET',
          url: `${host.api}/items/${encodeURIComponent(first.json().slug)}`,
          headers: authed(host),
        })
      ).json().item;
      assert.deepEqual(item.labels, ['feedback']);
      assert.equal(item.source, 'arbitrage-fleet');
      assert.equal(item.status, 'open');
      // The last writer is still the reporter who filed it. A stranger saying
      // the same thing a second time is not somebody working on this board,
      // and letting it move `last_actor` let anybody keep a report signed by
      // themselves for ever by resending its title.
      assert.equal(item.last_actor, 'guest:kanga-arbitrage');
      // And a name given by a stranger can never be an agent handle, which is
      // `[a-z0-9._-]`. Otherwise anybody could sign a report `errors-loop`.
      assert.ok(
        item.timeline.some((entry: { by: string }) => entry.by === 'guest:kanga-arbitrage'),
        'and the first reporter is still in the record',
      );
      // The second report is a note on the first, not a rewrite of it: what
      // the first reporter wrote survives, which is what the receipt promises.
      assert.equal(item.body, 'Seen twice on our fleet.');
      assert.ok(
        item.timeline.some((entry: { message: string }) =>
          entry.message.includes('reported again: Third time.'),
        ),
        'and the second report is on the record too',
      );
    } finally {
      await nominated.stop();
    }
  });

  it('cannot touch anything outside the feedback namespace', async () => {
    const seeded = await startHarness();
    const host = await createProject(seeded, 'guarded inbox');
    await seeded.stop();
    const open = await startHarness({
      MONGODB_DB: seeded.config.mongoDb,
      FEEDBACK_PROJECT: host.id,
    });
    try {
      await open.server.inject({
        method: 'POST',
        url: `${host.api}/items`,
        headers: authed(host),
        payload: { slug: 'ops:production', title: 'real work', actor: 'a' },
      });
      // A title that would normalise onto an existing slug still cannot reach
      // it: every report is created inside its own namespace.
      const attempt = await open.server.inject({
        method: 'POST',
        url: '/feedback',
        payload: { title: 'ops production', body: 'take this over' },
      });
      assert.equal(attempt.statusCode, 201);
      assert.match(attempt.json().slug, /^feedback:/);

      const untouched = (
        await open.server.inject({
          method: 'GET',
          url: `${host.api}/items/ops:production`,
          headers: authed(host),
        })
      ).json().item;
      assert.equal(untouched.title, 'real work');
      assert.deepEqual(untouched.labels, []);
    } finally {
      await open.stop();
    }
  });

  it('cannot blank the triage somebody wrote onto a report', async () => {
    // Inside the namespace, a second send used to rewrite the item: same title,
    // new body, labels reset to ['feedback']. So anybody who could read a
    // report could delete whatever the operator had recorded about it, by
    // sending its title back with different words.
    const seeded = await startHarness();
    const host = await createProject(seeded, 'triaged inbox');
    await seeded.stop();
    const open = await startHarness({
      MONGODB_DB: seeded.config.mongoDb,
      FEEDBACK_PROJECT: host.id,
    });
    try {
      const filed = await open.server.inject({
        method: 'POST',
        url: '/feedback',
        payload: { title: 'Claims outlive the process', body: 'what the reporter wrote' },
      });
      const slug = filed.json().slug;

      // The operator triages it the way they would triage anything.
      await open.server.inject({
        method: 'POST',
        url: `${host.api}/items`,
        headers: authed(host),
        payload: {
          slug,
          body: 'confirmed, and here is what we know',
          labels: ['feedback', 'confirmed'],
          owner: 'alex',
          actor: 'operator',
        },
      });

      await open.server.inject({
        method: 'POST',
        url: '/feedback',
        payload: { title: 'Claims outlive the process', body: 'OWNED', from: 'errors-loop' },
      });

      const item = (
        await open.server.inject({
          method: 'GET',
          url: `${host.api}/items/${encodeURIComponent(slug)}`,
          headers: authed(host),
        })
      ).json().item;
      assert.equal(item.body, 'confirmed, and here is what we know');
      assert.deepEqual(item.labels, ['feedback', 'confirmed']);
      assert.equal(item.owner, 'alex');
      // The new words are not lost, they are just not in charge of the item.
      assert.ok(
        item.timeline.some((entry: { message: string }) => entry.message.includes('OWNED')),
      );
      // And the last writer is the operator who triaged it, not the stranger
      // who sent the title back. A repeat report is a note, and a note by
      // somebody outside the project is not proof that the item is alive.
      assert.equal(item.last_actor, 'operator');
    } finally {
      await open.stop();
    }
  });
});

describe('asking what changed', () => {
  it('gives a window, an as_of to hand back, and does not lose the ties', async () => {
    const project = await createProject(harness, 'changing');
    await post(project, '/items', { slug: 'old', title: 'written before', actor: 'a' });

    const first = (await get(project, '/items?order=recent&limit=50')).json();
    assert.ok(first.as_of, 'the server stamps the window, not the caller');
    const mark = first.as_of;

    // Several writes in the same millisecond: a cursor on the timestamp alone
    // would drop all but one, and in a change feed that is work never seen.
    await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        post(project, '/items', { slug: `after-${n}`, title: `after ${n}`, actor: 'a' }),
      ),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: Array<{ slug: string }>; next_cursor: string | null } = (
        await get(
          project,
          `/items?order=recent&limit=3&since=${encodeURIComponent(mark)}${
            cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
          }`,
        )
      ).json();
      seen.push(...page.items.map((item) => item.slug));
      cursor = page.next_cursor;
    } while (cursor);

    assert.equal(new Set(seen).size, 8, 'every change in the window, once');
    assert.ok(!seen.includes('old'), 'and nothing from before it');
  });

  it('refuses a since it cannot read rather than answering with everything', async () => {
    const project = await createProject(harness);
    // Whichever guard catches it, the answer is a refusal and not the whole
    // board: a poller that gets everything back thinks everything changed.
    for (const bad of ['yesterday', '2026-13-45T99:99:99Z', '']) {
      const answer = await get(project, `/items?order=recent&since=${encodeURIComponent(bad)}`);
      assert.equal(answer.statusCode, 400, `since=${bad}`);
    }
  });

  it('lists the answers nobody has acted on, whatever the operator decided', async () => {
    const project = await createProject(harness, 'acted or not');
    const readToken = project.readUrl.split('/r/')[1]!;
    const ids: string[] = [];
    for (const question of ['one', 'two']) {
      ids.push(
        (await post(project, '/escalations', { agent: 'a', question })).json().escalation.id,
      );
    }
    for (const id of ids) {
      await harness.server.inject({
        method: 'POST',
        url: `/r/${readToken}/escalations/${id}`,
        payload: new URLSearchParams({ status: 'answered', answer: 'go' }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
    }
    await post(project, `/escalations/${ids[0]}/ack`, { agent: 'a' });

    const waiting = (await get(project, '/escalations?acknowledged=false')).json().escalations;
    assert.deepEqual(
      waiting.map((e: { id: string }) => e.id),
      [ids[1]],
      'only the one nobody has acted on',
    );
  });
});

describe('a lease that has run out', () => {
  it('is not described as held, on any door, before a sweep runs', async () => {
    // The board asks `expiresAt > now` and so does the query behind `claimed`,
    // so everything that decides has always treated a lapsed lease as free.
    // The serializer did not, so one answer could filter a card out as free and
    // describe it as held in the same breath, and reading that card on its own
    // said held until hygiene happened to run. Sweeping before the read does
    // not fix that: the sweep is fire and forget and throttled.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'lapsing', title: 'a card with a short lease' });
    await post(project, '/items/lapsing/claim', { agent: 'gone-away', ttl_minutes: 1 });

    // Push the lease into the past without touching anything else, which is
    // what a crashed agent leaves behind.
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'lapsing' },
      { $set: { 'claim.expiresAt': new Date(Date.now() - 60_000) } },
    );

    const read = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items/lapsing`,
      headers: authed(project),
    });
    assert.equal(read.json().item.claim, null, 'reading the card on its own');

    const listed = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items`,
      headers: authed(project),
    });
    const inList = (listed.json().items as { slug: string; claim: unknown }[]).find(
      (item) => item.slug === 'lapsing',
    );
    assert.equal(inList?.claim, null, 'and in the list beside it');

    // And the same card over MCP, which is where this started.
    const overMcp = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${project.token}` },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read_item', arguments: { slug: 'lapsing' } },
      },
    });
    assert.equal(overMcp.json().result.structuredContent.item.claim, null);

    // A lease that has not run out is still a lease.
    await post(project, '/items/lapsing/claim', { agent: 'still-here', ttl_minutes: 60 });
    const held = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items/lapsing`,
      headers: authed(project),
    });
    assert.equal(held.json().item.claim?.agent, 'still-here');
  });
});

describe('the map every refusal points at', () => {
  /**
   * Each refusal carries `"docs": ".../openapi.json"`, so a caller that reads
   * one is sent straight to that document. It said `200` and nothing else for
   * all 41 operations: not thin, wrong, because eight of them answer `201`,
   * and none of the refusals this service takes such care over were on the map
   * at all. A generated client had no name for any call either.
   *
   * The codes are written down in one place and this drives real requests to
   * hold that place to what the service does. Written down rather than
   * derived, because deriving them from the shape of the path was tried and
   * was wrong about five routes out of seven.
   */
  const spec = async (): Promise<Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>> =>
    ((await harness.server.inject({ method: 'GET', url: '/openapi.json' })).json() as {
      paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
    }).paths;

  const documents = (paths: Awaited<ReturnType<typeof spec>>, method: string, path: string, code: number): boolean =>
    Object.keys(paths[path]?.[method]?.responses ?? {}).includes(String(code));

  it('names every call, once', async () => {
    const paths = await spec();
    const ids: string[] = [];
    for (const [path, item] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
        assert.ok(operation.operationId, `${method.toUpperCase()} ${path} has no operationId to generate a client from`);
        ids.push(operation.operationId!);
      }
    }
    assert.ok(ids.length >= 40, `only ${ids.length} operations`);
    assert.equal(new Set(ids).size, ids.length, 'and no two calls share a name');
  });

  it('answers the codes it documents, and documents the ones it answers', async () => {
    const paths = await spec();
    const project = await createProject(harness);
    // Two header sets, because saying "application/json" and then sending
    // nothing is its own refusal here, and rightly: a DELETE that announces a
    // body and has none is a caller that lost one.
    const reading = { authorization: `Bearer ${project.token}` };
    const admin = { ...reading, 'content-type': 'application/json' };

    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: admin,
      payload: { slug: 'held', title: 'a card somebody holds' },
    });
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/held/claim`,
      headers: admin,
      payload: { agent: 'first' },
    });
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: admin,
      payload: { slug: 'blocker', title: 'what has to happen first' },
    });
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: admin,
      payload: { slug: 'blocked', title: 'a card that waits', blocked_by: ['blocker'] },
    });

    // Each row is one request and the code it is expected to come back with.
    // The document has to name that code for that operation.
    const cases: { method: string; url: string; path: string; payload?: unknown; headers?: Record<string, string>; code: number }[] = [
      { method: 'POST', url: '/p', path: '/p', payload: { name: 'created' }, headers: { 'content-type': 'application/json' }, code: 201 },
      { method: 'POST', url: `${project.api}/items`, path: '/v1/{project}/items', payload: { slug: 'fresh', title: 'new' }, headers: admin, code: 201 },
      { method: 'POST', url: `${project.api}/items`, path: '/v1/{project}/items', payload: { slug: 'fresh', title: 'again' }, headers: admin, code: 200 },
      { method: 'POST', url: `${project.api}/agents`, path: '/v1/{project}/agents', payload: { handle: 'brand-new' }, headers: admin, code: 201 },
      { method: 'POST', url: `${project.api}/escalations`, path: '/v1/{project}/escalations', payload: { question: 'well?' }, headers: admin, code: 201 },
      { method: 'POST', url: `${project.api}/keys`, path: '/v1/{project}/keys', payload: { name: 'a key' }, headers: admin, code: 201 },
      { method: 'POST', url: `${project.api}/items/held/claim`, path: '/v1/{project}/items/{slug}/claim', payload: { agent: 'second' }, headers: admin, code: 409 },
      // The same code from the same endpoint in the other shape. Losing a
      // lease to a holder and losing it to something unfinished are not the
      // same news, and they do not arrive in the same envelope.
      { method: 'POST', url: `${project.api}/items/blocked/claim`, path: '/v1/{project}/items/{slug}/claim', payload: { agent: 'third' }, headers: admin, code: 409 },
      { method: 'GET', url: `${project.api}/items/not-here`, path: '/v1/{project}/items/{slug}', headers: reading, code: 404 },
      { method: 'DELETE', url: `${project.api}/items/not-here`, path: '/v1/{project}/items/{slug}', headers: reading, code: 404 },
      { method: 'DELETE', url: `${project.api}/keys/k_not_here`, path: '/v1/{project}/keys/{id}', headers: reading, code: 404 },
      { method: 'PATCH', url: `${project.api}/escalations/e_not_here`, path: '/v1/{project}/escalations/{id}', payload: { status: 'answered' }, headers: admin, code: 404 },
      { method: 'POST', url: `${project.api}/agents/not-here/rename`, path: '/v1/{project}/agents/{handle}/rename', payload: { to: 'other' }, headers: admin, code: 404 },
      { method: 'GET', url: `${project.api}/items`, path: '/v1/{project}/items', headers: { authorization: 'Bearer nope' }, code: 401 },
      { method: 'GET', url: `${project.api}/items?offset=1`, path: '/v1/{project}/items', headers: reading, code: 400 },
      // In the shape RFC 6749 gives it, which is not this service's shape, so
      // it is on the map under its own schema rather than the house one.
      {
        method: 'POST',
        url: '/oauth/token',
        path: '/oauth/token',
        payload: { grant_type: 'client_credentials', client_id: 'nobody', client_secret: 'nothing' },
        headers: { 'content-type': 'application/json' },
        code: 401,
      },
      { method: 'POST', url: '/oauth/token', path: '/oauth/token', payload: {}, headers: { 'content-type': 'application/json' }, code: 400 },
      { method: 'POST', url: '/oauth/register', path: '/oauth/register', payload: { redirect_uris: 'not-an-array' }, headers: { 'content-type': 'application/json' }, code: 400 },
      // The same code from the same endpoint, in the other shape: this one is
      // written by the handler rather than by the schema check in front of it.
      { method: 'POST', url: '/oauth/register', path: '/oauth/register', payload: { grant_types: ['authorization_code'] }, headers: { 'content-type': 'application/json' }, code: 400 },
      // A body announced as something this service does not read, refused
      // before any of the endpoint's own rules run. Every operation that takes
      // a body can answer this, which is why the map derives it from having
      // one rather than from a list somebody keeps.
      {
        method: 'POST',
        url: `${project.api}/items`,
        path: '/v1/{project}/items',
        payload: '<item/>',
        headers: { ...reading, 'content-type': 'application/xml' },
        code: 415,
      },
      { method: 'POST', url: '/p', path: '/p', payload: '<p/>', headers: { 'content-type': 'application/xml' }, code: 415 },
      // A write that declares no body schema of its own, and a DELETE. Both
      // answer 415 all the same, which is why the map derives it from the
      // method rather than from whether a body is documented.
      {
        method: 'POST',
        url: `${project.api}/sweep`,
        path: '/v1/{project}/sweep',
        payload: '<x/>',
        headers: { ...reading, 'content-type': 'application/xml' },
        code: 415,
      },
      {
        method: 'DELETE',
        url: `${project.api}/items/not-here`,
        path: '/v1/{project}/items/{slug}',
        payload: '<x/>',
        headers: { ...reading, 'content-type': 'application/xml' },
        code: 415,
      },
    ];

    // Enough of a validator for two flat schemas and the two keywords that
    // join them, which is all this document uses. Written here rather than
    // pulled in, because a fifth dependency to check a map is a worse trade
    // than twenty lines that only have to understand what the map contains.
    const doc = (await harness.server.inject({ method: 'GET', url: '/openapi.json' })).json() as {
      components: { schemas: Record<string, { required?: string[]; properties?: Record<string, { type?: string }> }> };
    };
    const branches = (schema: Record<string, unknown>): Record<string, unknown>[] => {
      if (typeof schema.$ref === 'string') return [doc.components.schemas[schema.$ref.split('/').pop()!]!];
      const union = (schema.anyOf ?? schema.oneOf) as { $ref?: string }[] | undefined;
      if (union) return union.flatMap((one) => branches(one as Record<string, unknown>));
      return [schema];
    };
    const fits = (schema: { required?: string[]; properties?: Record<string, { type?: string }> }, body: Record<string, unknown>): boolean => {
      for (const name of schema.required ?? []) if (!(name in body)) return false;
      for (const [name, rule] of Object.entries(schema.properties ?? {})) {
        if (!(name in body) || !rule.type) continue;
        const seen = Array.isArray(body[name]) ? 'array' : typeof body[name];
        if (rule.type === 'integer' ? seen !== 'number' : rule.type !== seen) return false;
      }
      return true;
    };

    for (const one of cases) {
      const answer = await harness.server.inject({
        method: one.method as 'GET',
        url: one.url,
        ...(one.headers ? { headers: one.headers } : {}),
        ...(one.payload ? { payload: one.payload } : {}),
      });
      assert.equal(answer.statusCode, one.code, `${one.method} ${one.url} answered ${answer.statusCode}`);
      assert.ok(
        documents(paths, one.method.toLowerCase(), one.path, one.code),
        `${one.method} ${one.path} answers ${one.code} and the map does not say so`,
      );

      // And the shape it promises is the shape that arrived. A union that says
      // oneOf where the branches overlap fails this: both schemas here are
      // open and one of them requires only `error`, so a house-shaped refusal
      // satisfies both, and "exactly one" then rejects the body the service
      // really sends.
      const written = (
        paths[one.path]?.[one.method.toLowerCase()]?.responses?.[String(one.code)] as
          | { content?: Record<string, { schema?: Record<string, unknown> }> }
          | undefined
      )?.content?.['application/json']?.schema;
      if (!written || one.code < 400) continue;
      const body = answer.json() as Record<string, unknown>;
      const union = written.oneOf ? 'oneOf' : written.anyOf ? 'anyOf' : 'one';
      const matched = branches(written).filter((schema) => fits(schema, body)).length;
      if (union === 'oneOf') {
        assert.equal(matched, 1, `${one.method} ${one.path} ${one.code}: oneOf, and ${matched} branches fit what arrived`);
      } else {
        assert.ok(matched >= 1, `${one.method} ${one.path} ${one.code}: nothing the map documents fits ${JSON.stringify(body).slice(0, 90)}`);
      }
    }
  });

  it('keeps the refusals it documents in one shape, and does not narrow them', async () => {
    const paths = await spec();
    const refusal = paths['/v1/{project}/items']?.get?.responses?.['401'] as {
      content?: Record<string, { schema?: { $ref?: string } }>;
    };
    assert.equal(refusal?.content?.['application/json']?.schema?.$ref, '#/components/schemas/Refusal');

    // A share to the address that already owns the board answers 200 with
    // `already_owned`, which is the most ordinary thing a person can do twice.
    // An earlier version of this transform deleted that 200 and would have had
    // a generated client read it as a failure.
    assert.ok(
      Object.keys(paths['/v1/{project}/share']?.post?.responses ?? {}).includes('200'),
      'share still documents the answer it gives an address that already owns the board',
    );

    // Which shape a refusal wears at the OAuth endpoints depends on who writes
    // it. The handlers write the OAuth shape; the schema check, the media type
    // parser and the readiness gate in front of them write this service's. A
    // 400 is honestly either, a 429 is always theirs, 415 and 503 always ours.
    const schemaOf = (path: string, code: string): { $ref?: string; anyOf?: { $ref: string }[] } =>
      (paths[path]?.post?.responses?.[code] as { content?: Record<string, { schema?: never }> })?.content?.[
        'application/json'
      ]?.schema ?? {};

    for (const path of ['/oauth/register', '/oauth/token']) {
      assert.deepEqual(
        schemaOf(path, '400').anyOf?.map((one) => one.$ref).sort(),
        ['#/components/schemas/OauthError', '#/components/schemas/Refusal'],
        `${path} says a 400 can be either shape`,
      );
      assert.equal(schemaOf(path, '429').$ref, '#/components/schemas/OauthError', `${path} 429`);
      assert.equal(schemaOf(path, '503').$ref, '#/components/schemas/Refusal', `${path} 503`);
      assert.equal(schemaOf(path, '415').$ref, '#/components/schemas/Refusal', `${path} 415`);
    }
    assert.equal(schemaOf('/oauth/token', '401').$ref, '#/components/schemas/OauthError');

    // Documenting a response must not start serializing it. A refusal carries
    // fields naming what was wrong, and those are exactly what a serializer
    // built from a schema would drop.
    const project = await createProject(harness);
    const narrowed = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?offset=1`,
      headers: authed(project),
    });
    assert.equal(narrowed.statusCode, 400);
    assert.deepEqual(narrowed.json().unknown, ['offset'], 'the extra fields still arrive');
    assert.ok(Array.isArray(narrowed.json().accepted));
  });
});

describe('a parameter this door does not have', () => {
  it('refuses it by name, and says what was meant', async () => {
    // Reported twice by agents, and the second one had lost hours to the same
    // silence elsewhere: ?offset= came back 200 with the first page and no
    // offset, while a broken ?cursor= came back 400 saying exactly what was
    // wrong. The invented parameter was treated better than the mistyped one.
    const project = await createProject(harness);

    const guessed = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?limit=2&offset=999`,
      headers: authed(project),
    });
    assert.equal(guessed.statusCode, 400);
    assert.equal(guessed.json().error, 'unknown_parameter');
    assert.match(guessed.json().message, /"offset"/);
    assert.match(guessed.json().message, /next_cursor/, 'and says what to use instead');
    assert.match(guessed.json().message, /limit, order/, 'and what this endpoint does take');

    const invented = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?limit=2&zupelnie_wymyslony=tak`,
      headers: authed(project),
    });
    assert.equal(invented.statusCode, 400);
    assert.deepEqual(invented.json().unknown, ['zupelnie_wymyslony']);

    // What the endpoint does take still works, and so does taking nothing.
    for (const url of [`${project.api}/items?limit=2&order=recent`, `${project.api}/items`]) {
      const fine = await harness.server.inject({ method: 'GET', url, headers: authed(project) });
      assert.equal(fine.statusCode, 200, url);
    }

    // A route that declares no querystring accepts none. It was the one door
    // left where a parameter still disappeared quietly.
    const queryless = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/agents?offset=999`,
      headers: authed(project),
    });
    assert.equal(queryless.statusCode, 400);
    assert.match(queryless.json().message, /takes none at all/);
    assert.ok(
      !queryless.json().message.includes('next_cursor'),
      'and does not point at a parameter it does not have either',
    );

    // The hint is only offered where following it would work.
    const elsewhere = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/next?agent=x&sort=recent`,
      headers: authed(project),
    });
    assert.equal(elsewhere.statusCode, 400);
    assert.ok(!elsewhere.json().message.includes('The ordering is order'));
  });

  it('says where the name belongs when it is the body it belongs in', async () => {
    // Found by using the thing: `POST /next?agent=claude-code` was answered
    // "this endpoint has no agent parameter (...) this one takes none at all",
    // and `agent` is the single field its body requires. GET on that same URL
    // takes it in the query string exactly as sent, so the two verbs disagree
    // about where the word lives and only one of them was saying so.
    const project = await createProject(harness);

    const misplaced = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/next?agent=claude-code`,
      headers: authed(project),
      payload: { agent: 'claude-code' },
    });
    assert.equal(misplaced.statusCode, 400);
    assert.equal(misplaced.json().error, 'unknown_parameter');
    assert.match(misplaced.json().message, /"agent" is a field of this endpoint's JSON body/);
    assert.match(misplaced.json().message, /send it in the body/);
    assert.deepEqual(misplaced.json().belongs_in_body, ['agent']);
    assert.deepEqual(misplaced.json().accepted_in_body, ['agent', 'ttl_minutes']);
    assert.ok(
      !misplaced.json().message.includes('takes none at all'),
      'and no longer says the endpoint takes nothing, while requiring exactly this',
    );

    // Following the sentence works, which is the whole point of printing it.
    const followed = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/next`,
      headers: authed(project),
      payload: { agent: 'claude-code' },
    });
    assert.equal(followed.statusCode, 200);

    // A name that is in neither place is still nowhere, and is told so.
    const nowhere = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/next?zupelnie_wymyslony=tak`,
      headers: authed(project),
      payload: { agent: 'claude-code' },
    });
    assert.equal(nowhere.statusCode, 400);
    assert.equal(nowhere.json().belongs_in_body, undefined);
    assert.match(
      nowhere.json().message,
      /reads no query string at all; what it takes goes in the body: agent, ttl_minutes/,
    );
  });

  it('guards the signup door too, where the silence cost most', async () => {
    // `POST /p?owner_email=me@example.com` answered 200 and dropped the field
    // on the floor: a project nobody owns, no mail on its escalations, and no
    // way for a person to claim it. Signup is the first door an agent touches
    // and it was the last one outside the guard.
    const before = await harness.store.projects.countDocuments({});

    const dropped = await harness.server.inject({
      method: 'POST',
      url: '/p?owner_email=nobody@example.com',
      payload: { name: 'a project with an owner it would never have had' },
    });
    assert.equal(dropped.statusCode, 400);
    assert.equal(dropped.json().error, 'unknown_parameter');
    assert.match(dropped.json().message, /"owner_email" is a field of this endpoint's JSON body/);
    assert.equal(
      await harness.store.projects.countDocuments({}),
      before,
      'and nothing was created while the caller thought it had been',
    );

    // The same door, used correctly, is untouched.
    const proper = await harness.server.inject({
      method: 'POST',
      url: '/p',
      payload: { name: 'a project with an owner', owner_email: 'somebody@example.com' },
    });
    assert.equal(proper.statusCode, 201);
  });

  it('leaves the pages a browser reads alone', async () => {
    // A board link somebody pasted with a tracking parameter on the end is not
    // a request to explain ourselves.
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    const page = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?utm_source=slack&whatever=1`,
    });
    assert.equal(page.statusCode, 200);
  });
});

describe('who is writing, and by what name', () => {
  it('names a near miss of a handle that is registered', async () => {
    // A handle is free text on purpose: an agent writes before it registers.
    // The cost is a board where trades-loop and trades_loop are two agents,
    // /next offers neither of them work by scope, and a person filtering by one
    // sees half the work.
    const project = await createProject(harness);
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/agents`,
      headers: authed(project),
      payload: { handle: 'trades-loop', scope: ['trades:'] },
    });

    const typo = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'trades:one', title: 'one', actor: 'trades_loop' },
    });
    assert.equal(typo.statusCode, 201);
    assert.match(typo.json().warnings.join(' '), /"trades_loop".*"trades-loop" is/);

    // A name nothing resembles gets the plain version, which is a different
    // sentence: there is nothing to suggest.
    const stranger = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'trades:two', title: 'two', actor: 'somebody-else' },
    });
    assert.match(stranger.json().warnings.join(' '), /No agent is registered here as "somebody-else"/);
    assert.ok(!stranger.json().warnings.join(' ').includes('If that is you'));

    // Registered writes say nothing at all.
    const fine = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'trades:three', title: 'three', actor: 'trades-loop' },
    });
    assert.deepEqual(fine.json().warnings ?? [], []);
  });

  it('lists the names on the work beside the names that declared themselves', async () => {
    // The browser has shown this since the filter existed. An agent auditing
    // its own board over the API could see only the half that registered,
    // which is the half that was never the problem.
    const project = await createProject(harness);
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/agents`,
      headers: authed(project),
      payload: { handle: 'errors-loop', scope: [] },
    });
    for (const [slug, actor] of [
      ['one', 'errors-loop'],
      ['two', 'errors_loop'],
      ['three', 'passer-by'],
    ] as const) {
      await harness.server.inject({
        method: 'POST',
        url: `${project.api}/items`,
        headers: authed(project),
        payload: { slug, title: slug, actor },
      });
    }

    const listed = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/agents`,
        headers: authed(project),
      })
    ).json();
    assert.deepEqual(
      listed.agents.map((agent: { handle: string }) => agent.handle),
      ['errors-loop'],
    );
    assert.deepEqual(listed.seen, ['errors_loop', 'passer-by']);

    // And after consolidating, the list says so without being asked twice.
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/agents/errors_loop/rename`,
      headers: authed(project),
      payload: { to: 'errors-loop' },
    });
    const after = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/agents`,
        headers: authed(project),
      })
    ).json();
    assert.deepEqual(after.seen, ['passer-by']);

    // The door a person writes through is not a name somebody forgot to
    // register, so it is not offered as one to consolidate.
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'four', title: 'four', actor: 'operator' },
    });
    const withPerson = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/agents`,
        headers: authed(project),
      })
    ).json();
    assert.ok(!withPerson.seen.includes('operator'), 'the operator is a door, not a loop');

    // And it is reserved rather than merely hidden: nothing can register it,
    // nothing can consolidate it either way, and an agent writing under it is
    // told what it is signing as.
    const claimed = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/agents`,
      headers: authed(project),
      payload: { handle: 'operator', scope: [] },
    });
    assert.equal(claimed.statusCode, 400);
    assert.equal(claimed.json().error, 'reserved_handle');

    for (const payload of [{ to: 'operator' }, { to: 'errors-loop' }]) {
      const merge = await harness.server.inject({
        method: 'POST',
        url: `${project.api}/agents/${payload.to === 'operator' ? 'passer-by' : 'operator'}/rename`,
        headers: authed(project),
        payload,
      });
      assert.equal(merge.statusCode, 400, JSON.stringify(payload));
      assert.equal(merge.json().error, 'reserved_handle');
    }

    const signed = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'five', title: 'five', actor: 'operator' },
    });
    assert.match(signed.json().warnings.join(' '), /signs a person's own writes with/);

    // The actor on a write is free text, so the reservation has to hold for
    // every spelling of it: a warning that only fires on the lowercase one
    // leaves `Operator` signing as the person and hearing nothing.
    const shouted = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'six', title: 'six', actor: 'Operator' },
    });
    assert.match(shouted.json().warnings.join(' '), /signs a person's own writes with/);
    const shoutedSeen = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/agents`,
        headers: authed(project),
      })
    ).json();
    assert.ok(
      !shoutedSeen.seen.some((handle: string) => handle.toLowerCase() === 'operator'),
      'the door is the door however it was typed',
    );
  });

  it('answers a refused field with what the schema says about it', async () => {
    // The validator answers in its own language: "body/priority must be <= 10"
    // is true and teaches nothing, and it was the one refusal here that did not
    // name the fix. The description is written already, for the OpenAPI
    // document; the refusal says it too.
    const project = await createProject(harness);
    const refused = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'too-urgent', title: 'x', actor: 'a', priority: 99 },
    });
    assert.equal(refused.statusCode, 400);
    assert.match(refused.json().message, /must be <= 10/, 'what the validator found');
    assert.match(refused.json().message, /Higher is more urgent/, 'and what it means');

    // A field with nothing written about it is answered as before rather than
    // with an empty sentence after a full stop.
    const short = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { title: 'no slug at all', actor: 'a' },
    });
    assert.equal(short.statusCode, 400);
    assert.ok(!short.json().message.endsWith('. '), short.json().message);
  });

  it('consolidates a handle that was already written two ways', async () => {
    // The warnings catch a typo the first time it is used, which does nothing
    // for a board that collected work under both spellings before anybody read
    // one of them.
    const project = await createProject(harness);
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/agents`,
      headers: authed(project),
      payload: { handle: 'trades-loop', scope: ['trades:'], description: 'watches the venues' },
    });
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/agents`,
      headers: authed(project),
      payload: { handle: 'trades_loop', scope: [] },
    });
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'trades:one', title: 'one', actor: 'trades_loop' },
    });
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/trades:one/claim`,
      headers: authed(project),
      payload: { agent: 'trades_loop' },
    });

    const moved = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/agents/trades_loop/rename`,
      headers: authed(project),
      payload: { to: 'trades-loop' },
    });
    assert.equal(moved.statusCode, 200);
    assert.deepEqual(moved.json(), {
      from: 'trades_loop',
      to: 'trades-loop',
      items: 1,
      claims: 1,
      merged: true,
    });

    // The work moved, claim included.
    const item = await harness.store.items.findOne({ projectId: project.id, slug: 'trades:one' });
    assert.equal(item?.lastActor, 'trades-loop');
    assert.equal(item?.claim?.agent, 'trades-loop');

    // The history did not: an agent calling itself that is what happened.
    assert.ok(
      item!.timeline.some((entry) => entry.by === 'trades_loop'),
      'the record still says who wrote it',
    );

    // One registration, carrying the old name so an old entry can be read.
    const agents = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/agents`,
        headers: authed(project),
      })
    ).json().agents;
    assert.deepEqual(
      agents.map((agent: { handle: string }) => agent.handle),
      ['trades-loop'],
    );
    assert.deepEqual(agents[0].aliases, ['trades_loop']);
    assert.equal(agents[0].description, 'watches the venues', 'the described one survived');

    // And the filter offers one name instead of two.
    const facets = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/board/facets`,
        headers: authed(project),
      })
    ).json();
    assert.deepEqual(facets.agents, ['trades-loop']);
  });

  it('moves work written under a name nobody ever registered', async () => {
    const project = await createProject(harness);
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'one', title: 'one', actor: 'ghost-loop' },
    });
    const moved = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/agents/ghost-loop/rename`,
      headers: authed(project),
      payload: { to: 'errors-loop' },
    });
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().items, 1);
    assert.equal(moved.json().merged, false);

    // A name nothing was ever written under is not there to rename.
    const nothing = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/agents/nobody/rename`,
      headers: authed(project),
      payload: { to: 'errors-loop' },
    });
    assert.equal(nothing.statusCode, 404);
  });

  it('says it at the doors an agent reaches for first, not only at the item door', async () => {
    const project = await createProject(harness);
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/agents`,
      headers: authed(project),
      payload: { handle: 'errors-loop', scope: [] },
    });
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'card', title: 'card', actor: 'errors-loop' },
    });

    // Asking for work under a name nobody registered is the earliest moment a
    // typo can be caught: there is no scope to narrow by, so the agent is
    // offered everything and never finds out why.
    const asked = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/next?agent=errors_loop`,
      headers: authed(project),
    });
    assert.match(asked.json().warnings.join(' '), /"errors-loop" is/);

    const noted = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/card/timeline`,
      headers: authed(project),
      payload: { message: 'looked at it', actor: 'errors_loop' },
    });
    assert.match(noted.json().warnings.join(' '), /"errors-loop" is/);

    // An actor sent as an empty string is the same event as no actor at all:
    // nobody said who was writing, and the board will show "unknown-agent".
    const blank = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/card/timeline`,
      headers: authed(project),
      payload: { message: 'empty on purpose', actor: '' },
    });
    assert.match(blank.json().warnings.join(' '), /Nothing named itself/);
    assert.equal(
      blank.json().item.last_actor,
      'unknown-agent',
      'and the board carries the sentinel rather than a third spelling of nobody',
    );
    assert.equal(blank.json().item.timeline.at(-1).by, 'unknown-agent');

    // Punctuation is not a near miss of anybody: every string starts with
    // nothing, so without a guard this suggested whoever registered first.
    const punctuation = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/card/timeline`,
      headers: authed(project),
      payload: { message: 'nonsense name', actor: '---' },
    });
    assert.match(punctuation.json().warnings.join(' '), /No agent is registered here as "---"/);
    assert.ok(!punctuation.json().warnings.join(' ').includes('If that is you'));

    // And a write that named nobody says the loudest thing of all, because
    // "unknown-agent" is what the board will show for ever otherwise.
    const anonymous = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/card/timeline`,
      headers: authed(project),
      payload: { message: 'no name on this one' },
    });
    assert.match(anonymous.json().warnings.join(' '), /Nothing named itself/);
  });
});

describe('taking what is next, over MCP', () => {
  it('claims in the same call and is charged as a write', async () => {
    // The tool takes a lease and writes a timeline entry, so counting it
    // against the read budget published five times the writes an agent is
    // allowed to make.
    // One bucket per token for writes, whichever door they come through, so the
    // filing below spends part of the same budget the claims are measured
    // against. Five: two to file, three to take.
    const isolated = await startHarness({ LIMIT_WRITES_PER_MINUTE: '5' });
    try {
      const project = await createProject(isolated, 'held over mcp');
      for (let n = 0; n < 2; n += 1) {
        await isolated.server.inject({
          method: 'POST',
          url: `${project.api}/items`,
          headers: authed(project),
          payload: { slug: `w-${n}`, title: `w ${n}`, actor: 'filer' },
        });
      }
      const claim = (n: number) =>
        isolated.server.inject({
          method: 'POST',
          url: '/mcp',
          headers: authed(project),
          payload: {
            jsonrpc: '2.0',
            id: n,
            method: 'tools/call',
            params: { name: 'next_item', arguments: { agent: `loop-${n}`, claim: true } },
          },
        });

      const first = await claim(1);
      const held = first.json().result.structuredContent;
      assert.equal(held.claimed, true, first.body);
      assert.ok(held.item.claim, 'and it comes back already held');

      // Two filings and this claim make three of five; two more take it to the
      // ceiling and the next one is refused as the write it is.
      await claim(2);
      await claim(3);
      const spent = await claim(4);
      assert.match(JSON.stringify(spent.json()), /rate_limited/);

      // A plain look is a read, and reads have their own budget.
      const looked = await isolated.server.inject({
        method: 'POST',
        url: '/mcp',
        headers: authed(project),
        payload: {
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: { name: 'next_item', arguments: { agent: 'looker' } },
        },
      });
      assert.notEqual(looked.json().result.isError, true, looked.body);
      // And it is a look in the other sense too: nothing was taken. The
      // default was only ever asserted here as "not charged as a write",
      // which is a fact about the budget rather than about the lease, so
      // turning the default around would not have failed anything.
      const offered = JSON.parse(looked.json().result.content[0].text);
      assert.equal(offered.claimed, undefined, 'a look does not report a claim');
      assert.equal(offered.item?.claim ?? null, null, 'and leaves the item free');
    } finally {
      await isolated.stop();
    }
  });
});

describe('a question filed on a board nobody owns', () => {
  it('says nobody was told, instead of telling the agent to wait', async () => {
    // The promise of an escalation is that somebody hears it. On an unclaimed
    // board the notice has no address to go to, and the answer used to say
    // "keep working and read the inbox", so an agent doing exactly what the
    // protocol asks waited for an answer that had no way of arriving.
    const project = await createProject(harness);
    const asked = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/escalations`,
      headers: authed(project),
      payload: { agent: 'a', question: 'Bridge it or wait?' },
    });
    assert.equal(asked.statusCode, 201);
    assert.match(asked.json().hint, /Nobody has claimed this board/);
    assert.match(asked.json().hint, /share/);

    // And again on the call a later run actually makes. Filing said it once,
    // to whoever was running then; the inbox is what the next iteration reads,
    // and a question waiting there with nothing coming looks exactly like a
    // question somebody is thinking about.
    const inbox = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/inbox?agent=a`,
      headers: authed(project),
    });
    assert.equal(inbox.json().waiting.length, 1);
    assert.match(inbox.json().hint, /nobody was told and nobody is coming/);
    assert.match(inbox.json().hint, /share/);

    // Offered and not accepted yet, which is the case where telling an agent
    // to share again is actively wrong: the board stays unclaimed until
    // somebody clicks, and every repeat is another mail to a person who
    // already has one unread.
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/share`,
      headers: authed(project),
      payload: { email: 'human@example.com' },
    });
    const inboxNow = async (): Promise<string> =>
      (
        await harness.server.inject({
          method: 'GET',
          url: `${project.api}/inbox?agent=a`,
          headers: authed(project),
        })
      ).json().hint;

    // Stored but never delivered, which is what this harness produces because
    // it has no mailer: an agent told to stop offering would leave the person
    // it was meant for waiting on a message that does not exist.
    assert.match(await inboxNow(), /nobody is coming/);

    // Delivered, and only now is offering it again the wrong thing to do.
    await harness.store.shares.updateMany(
      { projectId: project.id },
      { $set: { notifiedAt: new Date() } },
    );
    const offered = await inboxNow();
    assert.match(offered, /not accepted yet/);
    assert.match(offered, /another copy of what they already have/);
    assert.doesNotMatch(offered, /nobody is coming/);

    // And an address that was told stays told. The stamp says this address
    // has heard about this board, not which attempt did the telling: a repeat
    // offer that the provider drops does not un-tell the person who already
    // has the mail, and reading it the other way put a race between two
    // overlapping sends in the middle of a sentence about somebody's inbox.
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/share`,
      headers: authed(project),
      payload: { email: 'human@example.com' },
    });
    assert.match(await inboxNow(), /not accepted yet/);

    // Claimed, and neither hint applies: somebody will be told.
    await harness.store.projects.updateOne(
      { _id: project.id },
      { $set: { claimedBy: 'owner@example.com', claimedAt: new Date(), expiresAt: null } },
    );
    const owned = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/escalations`,
      headers: authed(project),
      payload: { agent: 'a', question: 'And this one?' },
    });
    assert.doesNotMatch(owned.json().hint, /Nobody has claimed/);
    const heard = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/inbox?agent=a`,
      headers: authed(project),
    });
    assert.equal(heard.json().hint, undefined, 'a claimed board needs no warning about being unheard');
  });
});

describe('a refusal that clears by waiting', () => {
  it('says which of the limits it was, since seven of them answer the same way', async () => {
    // An agent told only "too many requests" cannot pace itself: the read and
    // write budgets are counted apart and published apart, and a developer on
    // a shared address whose signups are capped would otherwise conclude the
    // whole service is refusing them.
    const isolated = await startHarness({ LIMIT_CREATE_PROJECTS_PER_HOUR: '1' });
    try {
      await isolated.server.inject({ method: 'POST', url: '/p', payload: { name: 'first' } });
      const refused = await isolated.server.inject({
        method: 'POST',
        url: '/p',
        payload: { name: 'second' },
      });
      assert.equal(refused.statusCode, 429);
      assert.equal(refused.json().limit, RATE_LIMIT_SCOPES.createProject);
      assert.match(refused.json().message, new RegExp(RATE_LIMIT_SCOPES.createProject));
      assert.ok(Number(refused.headers['retry-after']) > 0);

      // The refusal names a bucket and sends the caller to a document for the
      // numbers, so the name has to be in that document. It was not: these
      // were two vocabularies, and a caller refused for "new projects from
      // this address" looked up a catalogue that only knew "project creation,
      // per source address" and found neither the name nor a number.
      const catalogue = agentAccessJson(isolated.config).rate_limits as Array<{ scope: string }>;
      const scopes = catalogue.map((row) => row.scope);
      assert.match(refused.json().message, /agent-access\.json/);
      for (const scope of Object.values(RATE_LIMIT_SCOPES)) {
        assert.ok(scopes.includes(scope), `${scope} is refused with but never published`);
      }
    } finally {
      await isolated.stop();
    }
  });
});

describe('a database that was never there', () => {
  it('serves anyway, and says which of the two it is', async () => {
    // Connecting before listening meant a blip during a deploy exited the
    // process, and Heroku backs a crashing dyno off for minutes: a database
    // that came back in twenty seconds still left the site down long after.
    // Every route already answers an unreachable store with 503, so the
    // honest thing is to serve that rather than not to serve at all.
    const { openStore } = await import('../src/db.js');
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig({
      // Port one, which nothing is listening on.
      MONGODB_URI: 'mongodb://127.0.0.1:1/muster',
      MONGODB_DB: 'never_there',
      BASE_URL: 'http://muster.test',
      LOG_LEVEL: 'silent',
    });
    const store = openStore(config.mongoUri, config.mongoDb, { serverSelectionTimeoutMS: 300 });
    const { server, limiter } = await buildApp(config, store);
    await server.ready();
    try {
      // The pages a person lands on are static and still render.
      const landing = await server.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
      assert.equal(landing.statusCode, 200);
      const protocol = await server.inject({ method: 'GET', url: '/skill.md' });
      assert.equal(protocol.statusCode, 200);

      // The health check says what is actually wrong.
      const health = await server.inject({ method: 'GET', url: '/health' });
      assert.equal(health.statusCode, 503, health.body);
      assert.equal(health.json().error, 'store_unavailable');

      // And so does everything that needs the database, on both doors, before
      // a query is ever attempted: a connection is not readiness, and the gap
      // between connecting and having the indexes is where a write can break
      // the invariant an index is for and make the build fail with it.
      for (const call of [
        { method: 'POST' as const, url: '/p', payload: { name: 'nope' } },
        { method: 'GET' as const, url: '/v1/p_whatever/items' },
        { method: 'POST' as const, url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } },
        { method: 'GET' as const, url: '/r/r_whatever/board' },
        { method: 'GET' as const, url: '/operator' },
        // The browser's way to the same write as POST /p, which a list of
        // prefixes aimed at the API door walked straight past.
        {
          method: 'POST' as const,
          url: '/signup',
          payload: 'name=nope',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        },
      ]) {
        const answer = await server.inject(call);
        assert.equal(answer.statusCode, 503, `${call.method} ${call.url}: ${answer.body.slice(0, 120)}`);
        assert.equal(answer.json().error, 'store_unavailable');
        assert.equal(answer.headers['retry-after'], '5');
      }

      // Static pages keep serving, including the two a prefix match would
      // have taken down with the door beside them: /pricing starts with /p,
      // and the signup form is a page until somebody posts it.
      for (const url of ['/pricing', '/signup', '/signup/', '/docs', '/llms.txt']) {
        const page = await server.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
        assert.equal(page.statusCode, 200, `${url} answered ${page.statusCode}`);
      }
      // The same page asked for its size. This server ignores a trailing
      // slash and answers HEAD from the GET handler, so both reach the page
      // and both have to be read as the page here.
      const head = await server.inject({ method: 'HEAD', url: '/signup' });
      assert.equal(head.statusCode, 200, `HEAD /signup answered ${head.statusCode}`);

      // And the reason is the same sentence whatever the driver said, because
      // a duplicate key error quotes the value it tripped on, which here can
      // be a read link or somebody's address, and this endpoint needs no token.
      assert.doesNotMatch(health.json().message, /E11000|dup key|@/);
    } finally {
      limiter.stop();
      await server.close();
      await store.close();
    }
  });
});

describe('a database that does not answer', () => {
  it('makes the health check say so, instead of reporting the process', async () => {
    // A health endpoint that cannot fail is decoration: it would have stayed
    // green through the one outage worth having an endpoint for, because the
    // dyno answers and every page renders its shell while every call behind
    // them is a 503.
    const before = await harness.server.inject({ method: 'GET', url: '/health' });
    assert.equal(before.statusCode, 200);
    assert.equal(before.json().store, 'ok');

    const real = harness.store.db.command.bind(harness.store.db);
    harness.store.db.command = (() =>
      Promise.reject(new Error('no primary reachable'))) as typeof harness.store.db.command;
    try {
      // Cached first, which is the reason the endpoint is safe to poll: the
      // store is already broken here and the answer is a second old.
      const cached = await harness.server.inject({ method: 'GET', url: '/health' });
      assert.equal(cached.statusCode, 200, 'a fresh answer is reused rather than pinged again');

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const answer = await harness.server.inject({ method: 'GET', url: '/health' });
      assert.equal(answer.statusCode, 503, answer.body);
      assert.equal(answer.json().error, 'store_unavailable');
      assert.equal(answer.headers['retry-after'], '5');
    } finally {
      harness.store.db.command = real;
    }
  });

  it('answers a burst with one ping, not one each', async () => {
    // The cache held the answer, which only exists once the ping comes back,
    // so everything arriving in between started a ping of its own. On an
    // endpoint anybody can call, that turns a burst into as many database
    // commands as there are callers, against the pool the boards need.
    const real = harness.store.db.command.bind(harness.store.db);
    let pings = 0;
    harness.store.db.command = ((...args: Parameters<typeof real>) => {
      pings += 1;
      return real(...args);
    }) as typeof harness.store.db.command;
    try {
      // Past the cached second first, so the burst is what refreshes it.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const answers = await Promise.all(
        Array.from({ length: 20 }, () =>
          harness.server.inject({ method: 'GET', url: '/health' }),
        ),
      );
      assert.ok(
        answers.every((answer) => answer.statusCode === 200),
        'every caller in the burst still gets an answer',
      );
      assert.equal(pings, 1, `twenty callers asked the database ${pings} times`);
    } finally {
      harness.store.db.command = real;
    }
  });

  it('waits for a slow ping rather than starting a second one', async () => {
    // The case this matters in is the outage itself. Server selection is
    // allowed five seconds and the answer is kept for one, so a probe that has
    // not come back yet looks expired to anybody measuring its age, and every
    // caller after the first second started another: several commands at once,
    // aimed at the pool this cache exists to spare.
    const real = harness.store.db.command.bind(harness.store.db);
    let pings = 0;
    harness.store.db.command = (() => {
      pings += 1;
      return new Promise((resolve) => setTimeout(() => resolve({ ok: 1 }), 1_500));
    }) as typeof harness.store.db.command;
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const first = harness.server.inject({ method: 'GET', url: '/health' });
      // Well past the cached second, and the first ping is still out.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const second = harness.server.inject({ method: 'GET', url: '/health' });
      const answers = await Promise.all([first, second]);
      assert.ok(answers.every((answer) => answer.statusCode === 200));
      assert.equal(pings, 1, `a ping in flight was joined, not repeated: ${pings} sent`);
    } finally {
      harness.store.db.command = real;
    }
  });

  it('says later rather than "something broke", and says it is not your request', async () => {
    // 5xx is the class this protocol tells an agent to retry, so a bug and an
    // outage answered the same way meant a fleet retried the bug at full speed
    // and backed off from the outage exactly as fast, which is not at all.
    const project = await createProject(harness);
    const { MongoServerSelectionError } = await import('mongodb');
    const real = harness.store.items.find.bind(harness.store.items);
    harness.store.items.find = (() => {
      throw new MongoServerSelectionError('no primary reachable', new Map() as never);
    }) as typeof harness.store.items.find;
    try {
      const answer = await harness.server.inject({
        method: 'GET',
        url: `${project.api}/items`,
        headers: authed(project),
      });
      assert.equal(answer.statusCode, 503, answer.body);
      assert.equal(answer.json().error, 'store_unavailable');
      assert.equal(answer.headers['retry-after'], '5');
      // Not "nothing was written": a socket dropped mid-write may have been.
      // And not "retry", flatly, which is the advice that turns one lost
      // answer into two projects. A slug is an idempotency key; a minted id
      // is not, and the message has to say which is which.
      // One sentence, in one place, said by both doors: it names what is safe
      // to send again and what is not, which is the difference between a lost
      // answer and two projects, and two copies of it would drift.
      const { STORE_UNAVAILABLE } = await import('../src/content.js');
      assert.equal(answer.json().message, STORE_UNAVAILABLE);
      assert.match(STORE_UNAVAILABLE, /slug/);
      assert.match(STORE_UNAVAILABLE, /mints an id/);
      assert.match(STORE_UNAVAILABLE, /timeline/);
    } finally {
      harness.store.items.find = real;
    }
  });

  it('reads a failover as the store, not as a query it got wrong', async () => {
    // A failover does not always arrive as a network error: the client reaches
    // a node and the node answers that it is no longer the primary. That is a
    // MongoServerError, class for class the same as a bad query, and only the
    // number tells them apart.
    const project = await createProject(harness);
    const { MongoServerError } = await import('mongodb');
    const real = harness.store.items.find.bind(harness.store.items);
    harness.store.items.find = (() => {
      throw new MongoServerError({ message: 'interrupted at shutdown', code: 11600 });
    }) as typeof harness.store.items.find;
    try {
      const answer = await harness.server.inject({
        method: 'GET',
        url: `${project.api}/items`,
        headers: authed(project),
      });
      assert.equal(answer.statusCode, 503, answer.body);
      assert.equal(answer.json().error, 'store_unavailable');
    } finally {
      harness.store.items.find = real;
    }
  });

  it('reads the other half of a failover, the one no write label covers', async () => {
    // Coming back up rather than going down: the new primary is elected and
    // has not committed a majority yet, so a read asking for one is refused
    // until it has. It is a read, so the driver's retryable-write label is
    // never on it, and only the number says what it is.
    const project = await createProject(harness);
    const { MongoServerError } = await import('mongodb');
    const real = harness.store.items.find.bind(harness.store.items);
    harness.store.items.find = (() => {
      throw new MongoServerError({ message: 'majority not available yet', code: 134 });
    }) as typeof harness.store.items.find;
    try {
      const answer = await harness.server.inject({
        method: 'GET',
        url: `${project.api}/items`,
        headers: authed(project),
      });
      assert.equal(answer.statusCode, 503, answer.body);
      assert.equal(answer.json().error, 'store_unavailable');
    } finally {
      harness.store.items.find = real;
    }
  });

  it('keeps a query this service got wrong out of that answer', async () => {
    // MongoServerError is the store answering, and answering that the query
    // was bad. Reading it as an outage would tell a fleet to come back later
    // for a bug that will still be there.
    const project = await createProject(harness);
    const { MongoServerError } = await import('mongodb');
    const real = harness.store.items.find.bind(harness.store.items);
    harness.store.items.find = (() => {
      throw new MongoServerError({ message: 'unknown operator: $nope' });
    }) as typeof harness.store.items.find;
    try {
      const answer = await harness.server.inject({
        method: 'GET',
        url: `${project.api}/items`,
        headers: authed(project),
      });
      assert.equal(answer.statusCode, 500, answer.body);
      assert.equal(answer.json().error, 'internal');
    } finally {
      harness.store.items.find = real;
    }
  });
});

describe('a value of the wrong shape', () => {
  it('is refused rather than reshaped into the right one', async () => {
    // Fastify coerces a scalar into a list by default, which is right for a
    // query string and wrong for a body: an agent that sent one slug instead
    // of a list of them got 200 and a card waiting on one thing, having been
    // told nothing. This service refuses an unknown field in as many words;
    // quietly repairing a wrong type is the same surprise wearing a hat.
    const project = await createProject(harness);
    const refused = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'ops:cutover', blocked_by: 'ops:bridge-or-wait' },
    });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.equal(refused.json().error, 'invalid_request');
    assert.match(refused.json().message as string, /blocked_by must be array/);

    // A list of one is what it wanted, and that still works.
    const listed = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'ops:cutover', blocked_by: ['ops:bridge-or-wait'] },
    });
    assert.equal(listed.statusCode, 201, listed.body);
  });

  it('still reads a number and a flag out of a query string', async () => {
    // The coercion that was turned off is the array one. Everything a query
    // string depends on arrives as text and has to become what the schema
    // says, and every documented read uses it.
    const project = await createProject(harness);
    const listed = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?limit=5&stale=false&order=id`,
      headers: authed(project),
    });
    assert.equal(listed.statusCode, 200, listed.body);
    const board = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/board?items=false&include_closed=true`,
      headers: authed(project),
    });
    assert.equal(board.statusCode, 200, board.body);
  });
});

describe('a value outside a closed set', () => {
  it('names the values it does take, and the one nobody has', async () => {
    // "must be equal to one of the allowed values" is the refusal that does
    // not say which, and on this service it is the one an agent is most
    // likely to meet: the statuses are four, and the fifth everybody reaches
    // for is deliberately not one of them.
    const project = await createProject(harness);
    const refused = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'ops:cutover', status: 'in_progress' },
    });
    assert.equal(refused.statusCode, 400);
    const message = refused.json().message as string;
    assert.match(message, /open, blocked, done or dropped/);
    assert.match(message, /in progress/);

    // The same reading applied to every other closed set, without anybody
    // writing a sentence per field.
    const priority = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/escalations`,
      headers: authed(project),
      payload: { question: 'Bridge it?', priority: 'catastrophic' },
    });
    assert.equal(priority.statusCode, 400);
    assert.match(priority.json().message as string, /It takes .* or /);
  });
});

describe('a field this service does not have', () => {
  it('is refused rather than deleted, on the body as well as the query', async () => {
    // The promise is published in those words, and the query string kept it
    // while the body did not: the framework's default is to strip unknown
    // properties, so `POST /keys` with `label` made a key called "unnamed" and
    // answered 201, and an upsert with a misspelled field wrote the card
    // without it and reported success.
    const project = await createProject(harness);
    const key = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/keys`,
      headers: authed(project),
      payload: { label: 'not a field here', role: 'write' },
    });
    assert.equal(key.statusCode, 400);
    // Named, because the promise is that a parameter this service does not
    // have comes back 400 naming it, and "must NOT have additional
    // properties" is the one message that says everything except which.
    assert.match(key.json().message, /"label" is not a field this call has/);
    assert.match(key.json().message, /It takes name, role/);

    // And the object that refused, not the one at the top: several of these
    // schemas have nested closed lists, and naming the body's fields when
    // `expect` is what refused is true and useless.
    const nested = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'guarded', title: 't', expect: { titel: 'typo' } },
    });
    assert.equal(nested.statusCode, 400);
    assert.match(nested.json().message, /"titel" is not a field "expect" has/);
    assert.match(nested.json().message, /It takes title, body/);

    const item = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'typo', title: 't', blockedBy: ['something'] },
    });
    assert.equal(item.statusCode, 400, 'blockedBy is not the published spelling');
    assert.equal(
      await harness.store.items.countDocuments({ projectId: project.id, slug: 'typo' }),
      0,
      'and nothing was written',
    );

    // The move keeps taking `agent`, which is what the MCP tool for the same
    // move takes and what everything holding a lease here takes.
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'real', title: 't', body: 'b', actor: 'a' },
    });
    const moved = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/real/move`,
      headers: authed(project),
      payload: { column: 'done', agent: 'mover' },
    });
    assert.equal(moved.statusCode, 200);
    assert.equal((await harness.store.items.findOne({ projectId: project.id, slug: 'real' }))!.lastActor, 'mover');
  });
});
