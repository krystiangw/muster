import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
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
  it('warns on a cross-scope write without blocking it', async () => {
    const project = await createProject(harness);
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

    // Claimed, and the hint is the ordinary one again.
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
  });
});

describe('a refusal that clears by waiting', () => {
  it('says which of the limits it was, since six of them answer the same way', async () => {
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
      assert.equal(refused.json().limit, 'new projects from this address');
      assert.match(refused.json().message, /new projects from this address/);
      assert.ok(Number(refused.headers['retry-after']) > 0);
    } finally {
      await isolated.stop();
    }
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
