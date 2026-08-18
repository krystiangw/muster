import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SEARCH_MAX_CHARS, claimProjectWithEmail, upsertItem } from '../src/service.js';
import { flushEvents } from '../src/events.js';
import {
  authed,
  createProject,
  signIn,
  startHarness,
  type Harness,
  type Project,
} from './helper.js';

/**
 * Regressions for the findings of the independent review of the first commit.
 * Each one is a hole that was open and is now closed; they belong in the suite
 * so that the second reviewer does not have to find them again.
 */

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

describe('the MCP surface obeys the same rules as HTTP', () => {
  it('applies the published project creation limit to the create_project tool', async () => {
    const isolated = await startHarness({ LIMIT_CREATE_PROJECTS_PER_HOUR: '2' });
    try {
      const call = () =>
        isolated.server.inject({
          method: 'POST',
          url: '/mcp',
          payload: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'create_project', arguments: { name: 'spam' } },
          },
        });

      assert.ok((await call()).json().result.structuredContent.token);
      assert.ok((await call()).json().result.structuredContent.token);

      const third = await call();
      assert.equal(third.json().result.isError, true);
      assert.match(third.json().result.content[0].text, /429/);

      // And the HTTP door is closed too, not just the tool.
      const overHttp = await isolated.server.inject({ method: 'POST', url: '/p', payload: {} });
      assert.equal(overHttp.statusCode, 429);
    } finally {
      await isolated.stop();
    }
  });

  it('refuses a status the domain does not have, however it arrives', async () => {
    const project = await createProject(harness);

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
          arguments: { slug: 'bad-status', title: 'x', status: 'in_progress', actor: 'a' },
        },
      },
    });
    assert.equal(overMcp.json().result.isError, true);
    assert.match(overMcp.json().result.content[0].text, /Status must be one of/);

    const stored = await harness.store.items.findOne({ projectId: project.id, slug: 'bad-status' });
    assert.equal(stored, null, 'nothing invalid may reach the collection');

    const overHttp = await post(project, '/items', {
      slug: 'bad-status',
      title: 'x',
      status: 'in_progress',
      actor: 'a',
    });
    assert.equal(overHttp.statusCode, 400);
  });

  it('refuses a handle or a priority the domain does not have', async () => {
    const project = await createProject(harness);

    const badHandle = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: authed(project),
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'register_agent', arguments: { handle: '!!!' } },
      },
    });
    assert.equal(badHandle.json().result.isError, true);

    const badPriority = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: authed(project),
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'escalate', arguments: { question: 'ok?', priority: 'catastrophic' } },
      },
    });
    assert.equal(badPriority.json().result.isError, true);
  });
});

describe('one read, two doors', () => {
  it('pages and filters over MCP exactly as it does over HTTP', async () => {
    // The tool description promised a claim filter the schema never had, and
    // there was no cursor at all, so everything past the limit was invisible
    // to an agent on this door. Both doors call one function now.
    const project = await createProject(harness);
    for (const slug of ['one', 'two', 'three']) {
      await post(project, '/items', { slug, title: slug, actor: 'a' });
    }
    await post(project, '/items/two/claim', { agent: 'holder' });

    const call = async (args: Record<string, unknown>) => {
      const response = await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        headers: authed(project),
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_items', arguments: args },
        },
      });
      return response.json().result.structuredContent as {
        items: { slug: string }[];
        next_cursor: string | null;
        as_of: string;
      };
    };

    const first = await call({ limit: 2, order: 'id' });
    assert.equal(first.items.length, 2);
    assert.ok(first.next_cursor, 'a full page says how to ask for the next one');
    const second = await call({ limit: 2, order: 'id', cursor: first.next_cursor });
    assert.equal(second.items.length, 1, 'the third item is reachable at all');
    assert.equal(second.next_cursor, null, 'and a short page says it was the last');
    const seen = [...first.items, ...second.items].map((item) => item.slug).sort();
    assert.deepEqual(seen, ['one', 'three', 'two'], 'every item, each once');

    const held = await call({ claimed: true });
    assert.deepEqual(
      held.items.map((item) => item.slug),
      ['two'],
      'the filter the description was promising',
    );
    const free = await call({ claimed: false });
    assert.deepEqual(free.items.map((item) => item.slug).sort(), ['one', 'three']);

    // The same page over HTTP, to make the parity a fact rather than a claim.
    const overHttp = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?order=id&limit=2`,
      headers: authed(project),
    });
    assert.deepEqual(
      overHttp.json().items.map((item: { slug: string }) => item.slug),
      first.items.map((item) => item.slug),
    );
    // The keyset halves match; the checkpoints do not, because these are two
    // reads taken a moment apart and each carries its own.
    const keyset = (cursor: string) => cursor.slice(0, cursor.lastIndexOf('~'));
    assert.equal(keyset(overHttp.json().next_cursor), keyset(first.next_cursor!));

    // as_of is what a poller hands back as `since`, so it has to be a date the
    // next read accepts rather than a decorative string.
    const nothingNew = await call({ since: second.as_of });
    assert.equal(nothingNew.items.length, 0, 'nothing changed after the read that reported it');

    // And it has to be the same checkpoint on every page. A write that lands
    // while somebody is on page two sorts above their cursor, so it appears on
    // no later page; keeping the first page's moment is what makes the next
    // poll pick it up instead of stepping over it.
    assert.equal(second.as_of, first.as_of, 'paging does not move the checkpoint');

    // A cursor that carries a checkpoint nobody can read is damaged, not old.
    // Paging on from it would stamp a fresh one mid-walk, which is the loss
    // the checkpoint exists to prevent, so it is refused instead.
    const damaged = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?order=id&cursor=${encodeURIComponent('i_abc~nonsense')}`,
      headers: authed(project),
    });
    assert.equal(damaged.statusCode, 400);
    assert.equal(damaged.json().error, 'bad_cursor');

    // One from before checkpoints existed has no tilde at all, and still works.
    const legacy = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?order=id&limit=2&cursor=${encodeURIComponent(keyset(first.next_cursor!))}`,
      headers: authed(project),
    });
    assert.equal(legacy.statusCode, 200);
    assert.deepEqual(
      legacy.json().items.map((item: { slug: string }) => item.slug),
      second.items.map((item) => item.slug),
    );
  });

  it('windows by since in every order, not only in the change feed', async () => {
    // Reported by an agent on another board: "since is silently inert outside
    // order=recent". It was not. The cutoff used was older than every item on
    // the board, so every order returned the same page with it and without it,
    // which is the filter working. Pinned here because the next person to read
    // "recent is what since is for" can reach the same conclusion, and the fix
    // for that reading is a test, not a sentence.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'old', title: 'written before', actor: 'a' });
    const cut = new Date();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await post(project, '/items', { slug: 'new', title: 'written after', actor: 'a', priority: -3 });

    for (const order of ['urgency', 'recent', 'id']) {
      const windowed = await harness.server.inject({
        method: 'GET',
        url: `${project.api}/items?order=${order}&since=${encodeURIComponent(cut.toISOString())}`,
        headers: authed(project),
      });
      assert.deepEqual(
        windowed.json().items.map((item: { slug: string }) => item.slug),
        ['new'],
        `since holds in order=${order}`,
      );

      // And a cutoff older than the board is not a filter being ignored.
      const wide = await harness.server.inject({
        method: 'GET',
        url: `${project.api}/items?order=${order}&since=2020-01-01T00:00:00.000Z`,
        headers: authed(project),
      });
      assert.equal(wide.json().items.length, 2, `everything is after 2020 in order=${order}`);
    }

    // The default order is one of the three, and carries the window too: it is
    // the call anybody writes first.
    const plain = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?since=${encodeURIComponent(cut.toISOString())}`,
      headers: authed(project),
    });
    assert.deepEqual(
      plain.json().items.map((item: { slug: string }) => item.slug),
      ['new'],
    );
  });

  it('stops a search that reads too long, and says so rather than answering nothing', async () => {
    // A search that matches nothing reads every item in the project, 1016 ms at
    // two hundred thousand of them, and the page that carries the search box
    // has no rate limiter in front of it. The clock bounds that. What it must
    // never do is answer with an empty page: "nothing found" and "we stopped
    // looking" are different sentences, and only one of them is true here.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'ops:backups', title: 'nightly backups', actor: 'a' });

    // Only the reads that put themselves on a clock fail, which is exactly the
    // reads that carry a search. Anything else proves the clock reached further
    // than it was meant to.
    const realFind = harness.store.items.find.bind(harness.store.items);
    (harness.store.items as { find: typeof realFind }).find = ((
      filter: Parameters<typeof realFind>[0],
      options: Parameters<typeof realFind>[1],
    ) => {
      const cursor = realFind(filter, options);
      const realMaxTimeMS = cursor.maxTimeMS.bind(cursor);
      cursor.maxTimeMS = (ms: number) => {
        realMaxTimeMS(ms);
        cursor.toArray = async () => {
          throw Object.assign(new Error('operation exceeded time limit'), {
            code: 50,
            codeName: 'MaxTimeMSExpired',
          });
        };
        return cursor;
      };
      return cursor;
    }) as typeof realFind;

    try {
      const refused = await harness.server.inject({
        method: 'GET',
        url: `${project.api}/items?q=nothingmatchesthis`,
        headers: authed(project),
      });
      assert.equal(refused.statusCode, 503);
      assert.equal(refused.json().error, 'search_too_slow');
      assert.match(refused.json().message, /narrow it/i);

      const unsearched = await harness.server.inject({
        method: 'GET',
        url: `${project.api}/items?limit=5`,
        headers: authed(project),
      });
      assert.equal(unsearched.statusCode, 200, 'a read with no search is not on a clock at all');
      assert.equal(unsearched.json().items.length, 1);

      // The person gets the board back, not an error page, and a line saying
      // which of the two things happened.
      const readToken = project.readUrl.split('/r/')[1]!;
      const page = await harness.server.inject({
        method: 'GET',
        url: `/r/${readToken}/board?q=nothingmatchesthis`,
      });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /was reading for longer than this board allows/);
      assert.match(page.body, /ops:backups/, 'and the board underneath it is the whole board');

      // Counted, because otherwise the only evidence that a board has outgrown
      // its search is somebody mentioning that the box stopped working.
      await flushEvents();
      assert.ok(
        (await harness.store.events.countDocuments({
          kind: 'refused',
          detail: 'search_too_slow',
        })) >= 2,
        'both doors record the stop',
      );
    } finally {
      (harness.store.items as { find: typeof realFind }).find = realFind;
    }
  });

  it('finds an item by its words, through either door and the way the board does', async () => {
    // The board has had a search box since it had columns, and the API it is
    // built on could not do it: an agent with two hundred items had filters and
    // no way to ask for "the withdrawal one".
    const project = await createProject(harness);
    await post(project, '/items', {
      slug: 'errors:venue-withdraw-stuck',
      title: 'withdrawal stuck at the venue',
      actor: 'a',
    });
    await post(project, '/items', { slug: 'ops:backups', title: 'nightly backups', actor: 'a' });

    const overHttp = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?q=withdraw`,
      headers: authed(project),
    });
    assert.deepEqual(
      overHttp.json().items.map((item: { slug: string }) => item.slug),
      ['errors:venue-withdraw-stuck'],
      'the slug matches',
    );

    const byTitle = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?q=NIGHTLY`,
      headers: authed(project),
    });
    assert.deepEqual(
      byTitle.json().items.map((item: { slug: string }) => item.slug),
      ['ops:backups'],
      'and so does the title, whatever case it was typed in',
    );

    const overMcp = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: authed(project),
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_items', arguments: { q: 'withdraw' } },
      },
    });
    assert.deepEqual(
      overMcp.json().result.structuredContent.items.map((item: { slug: string }) => item.slug),
      ['errors:venue-withdraw-stuck'],
      'the other door answers the same',
    );

    // Every word, in either field, in any order. Two words that sit at
    // opposite ends of a title are the ordinary case, and a search that only
    // matches the whole string as one phrase answers nothing and reads as
    // broken.
    const twoWords = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?q=${encodeURIComponent('venue withdrawal')}`,
      headers: authed(project),
    });
    assert.deepEqual(
      twoWords.json().items.map((item: { slug: string }) => item.slug),
      ['errors:venue-withdraw-stuck'],
      'one word from the slug and one from the title, in neither order',
    );

    // Somebody's words, not a pattern. A stray bracket finds nothing rather
    // than throwing, and a dot is a dot.
    const bracket = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?q=${encodeURIComponent('with[drawal')}`,
      headers: authed(project),
    });
    assert.equal(bracket.statusCode, 200);
    assert.deepEqual(bracket.json().items, []);

    // A long query is cut at the same place by every door rather than refused
    // by one and truncated differently by another, which was three behaviours
    // for one contract.
    const long = `venue ${'x'.repeat(200)}`;
    const longOverHttp = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?q=${encodeURIComponent(long)}`,
      headers: authed(project),
    });
    assert.equal(longOverHttp.statusCode, 200, 'not refused');
    const longOverMcp = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: authed(project),
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_items', arguments: { q: long } },
      },
    });
    assert.deepEqual(
      longOverMcp.json().result.structuredContent.items.map((item: { slug: string }) => item.slug),
      longOverHttp.json().items.map((item: { slug: string }) => item.slug),
      'and both doors cut it identically',
    );

    // Leading space, then a word, past the cut: the board used to slice the raw
    // string and search for nothing, while the API trimmed first and found the
    // item. One normalization now, so all three agree.
    const padded = `${' '.repeat(SEARCH_MAX_CHARS)}venue`;
    const paddedOverHttp = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?q=${encodeURIComponent(padded)}`,
      headers: authed(project),
    });
    assert.deepEqual(
      paddedOverHttp.json().items.map((item: { slug: string }) => item.slug),
      ['errors:venue-withdraw-stuck'],
    );

    // And the board's own search box asks the same question, because it is the
    // same function now.
    const readToken = project.readUrl.split('/r/')[1]!;
    const board = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?q=${encodeURIComponent('venue withdrawal')}`,
    });
    assert.equal(board.statusCode, 200);
    assert.ok(board.body.includes('errors:venue-withdraw-stuck'));
    assert.ok(!board.body.includes('ops:backups'));

    const paddedBoard = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?q=${encodeURIComponent(padded)}`,
    });
    assert.ok(paddedBoard.body.includes('errors:venue-withdraw-stuck'));
    assert.ok(!paddedBoard.body.includes('ops:backups'), 'the board cuts where the API cuts');
  });

  it('reads a lapsed lease as free work, the way the board does', async () => {
    // The board has always taken an expired claim as no claim: hygiene clearing
    // the field is a tidy-up, not the moment the work became free. The list
    // filter compared the field to null, so between the lease running out and
    // the next sweep, `claimed=true` handed back an item whose holder had gone
    // and `claimed=false` hid the one thing an idle agent could pick up.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'lapsed', title: 'lapsed', actor: 'a' });
    await post(project, '/items/lapsed/claim', { agent: 'gone' });
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'lapsed' },
      { $set: { 'claim.expiresAt': new Date(Date.now() - 60_000) } },
    );

    const held = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?claimed=true`,
      headers: authed(project),
    });
    assert.deepEqual(held.json().items, [], 'nobody is on it');

    const free = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?claimed=false`,
      headers: authed(project),
    });
    assert.deepEqual(
      free.json().items.map((item: { slug: string }) => item.slug),
      ['lapsed'],
      'and it is there to be picked up',
    );
  });

  it('carries migrated fields through the MCP door, so its columns are reachable', async () => {
    // A column can filter on `fields`, and this door could not write one, so a
    // board laid out around another tracker's states had columns an MCP agent
    // could see and never reach.
    const project = await createProject(harness);
    await harness.server.inject({
      method: 'PUT',
      url: `${project.api}/board`,
      headers: authed(project),
      payload: {
        rows: 'none',
        columns: [
          {
            key: 'investigating',
            title: 'Investigating',
            match: { fields: { legacy_status: ['investigating'] } },
          },
          { key: 'rest', title: 'Rest', match: {} },
        ],
      },
    });

    const written = await harness.server.inject({
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
            slug: 'imported',
            title: 'imported',
            actor: 'migrator',
            fields: { legacy_status: 'investigating' },
          },
        },
      },
    });
    assert.equal(written.json().result.isError, undefined);

    const board = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/board`,
      headers: authed(project),
    });
    const column = board
      .json()
      .rows[0].columns.find((entry: { key: string }) => entry.key === 'investigating');
    assert.deepEqual(
      column.items.map((item: { slug: string }) => item.slug),
      ['imported'],
      'the card reaches the column its fields describe',
    );
  });

  it('shows closed work on the board over MCP, the way the API does', async () => {
    const project = await createProject(harness);
    // A layout with no column for finished work, which is what makes closed
    // items off the board by default and include_closed worth having.
    await harness.server.inject({
      method: 'PUT',
      url: `${project.api}/board`,
      headers: authed(project),
      payload: { rows: 'none', columns: [{ key: 'open', title: 'Open', match: { status: ['open'] } }] },
    });
    await post(project, '/items', { slug: 'shipped', title: 'shipped', actor: 'a', status: 'done' });

    const board = async (args: Record<string, unknown>) => {
      const response = await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        headers: authed(project),
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'board', arguments: args },
        },
      });
      return response.json().result.structuredContent as { unplaced: number };
    };

    // A layout that names only open work leaves the finished card off the
    // board entirely, and asking for the closed ones puts it where the board
    // admits to it: in the count of what matched no column.
    assert.equal((await board({})).unplaced, 0, 'closed work is off the board by default');
    assert.equal(
      (await board({ include_closed: true })).unplaced,
      1,
      'and this door can ask for the rest, which it could not before',
    );

    const overHttp = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/board?include_closed=true`,
      headers: authed(project),
    });
    assert.equal(overHttp.json().unplaced, 1, 'the same answer through the other door');
  });
});

describe('claims cannot be revived after they lapse', () => {
  it('rejects a heartbeat from the old holder once the lease has expired', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });
    await post(project, '/items/work/claim', { agent: 'slow-agent', ttl_minutes: 5 });

    // The lease lapses; hygiene has not run yet, which is exactly the window
    // where the old holder used to be able to extend it.
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'work' },
      { $set: { 'claim.expiresAt': new Date(Date.now() - 60_000) } },
    );

    const beat = await post(project, '/items/work/heartbeat', { agent: 'slow-agent' });
    assert.equal(beat.statusCode, 409);

    const takenOver = await post(project, '/items/work/claim', { agent: 'fresh-agent' });
    assert.equal(takenOver.json().ok, true);
  });
});

describe('the open item cap', () => {
  it('holds against sequential creates, and overshoots a burst rather than bricking', async () => {
    const project = await createProject(harness);
    await harness.store.projects.updateOne({ _id: project.id }, { $set: { 'limits.items': 5 } });

    // One at a time, the cap is exact.
    for (let i = 0; i < 5; i += 1) {
      const response = await post(project, '/items', { slug: `seq-${i}`, title: 'x', actor: 'a' });
      assert.equal(response.statusCode, 201, `create ${i}`);
    }
    const overCap = await post(project, '/items', { slug: 'seq-5', title: 'x', actor: 'a' });
    assert.equal(overCap.statusCode, 409, 'the sixth is refused');

    // A simultaneous burst can slip a few past, because the counter is moved
    // after the write rather than reserved before it. That is the deliberate
    // trade: overshooting by a burst is harmless, while a reservation lost to a
    // crashed process would withhold capacity forever.
    await harness.store.projects.updateOne({ _id: project.id }, { $set: { 'limits.items': 10 } });
    const burst = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post(project, '/items', { slug: `burst-${i}`, title: 'x', actor: 'a' }),
      ),
    );
    const accepted = burst.filter((r) => r.statusCode === 201).length;
    assert.ok(accepted >= 5, `expected the burst to make progress, accepted ${accepted}`);

    const stored = await harness.store.items.countDocuments({ projectId: project.id });
    const counted = (await harness.store.projects.findOne({ _id: project.id }))!.counts.items;
    assert.equal(counted, stored, 'whatever got in, the counter agrees with the collection');

    // And the project is still usable afterwards: not stuck below its own cap.
    await harness.store.projects.updateOne(
      { _id: project.id },
      { $set: { 'limits.items': stored + 1 } },
    );
    const after = await post(project, '/items', { slug: 'after-burst', title: 'x', actor: 'a' });
    assert.equal(after.statusCode, 201);
  });

  it('counts open work, so closing an item frees its slot', async () => {
    const project = await createProject(harness);
    await harness.store.projects.updateOne({ _id: project.id }, { $set: { 'limits.items': 2 } });

    await post(project, '/items', { slug: 'one', title: 'one', actor: 'a' });
    await post(project, '/items', { slug: 'two', title: 'two', actor: 'a' });
    const full = await post(project, '/items', { slug: 'three', title: 'three', actor: 'a' });
    assert.equal(full.statusCode, 409);
    assert.match(full.json().message, /open items/);

    await post(project, '/items', { slug: 'one', status: 'done', actor: 'a' });
    const afterClosing = await post(project, '/items', { slug: 'three', title: 'three', actor: 'a' });
    assert.equal(afterClosing.statusCode, 201, 'a finished project must not be a full one');

    // Reopening the closed one takes a slot back.
    const counts = await harness.store.projects.findOne({ _id: project.id });
    assert.equal(counts!.counts.items, 2);
  });

  it('caps the question queue, not the answered history', async () => {
    const project = await createProject(harness);
    await harness.store.projects.updateOne(
      { _id: project.id },
      { $set: { 'limits.escalations': 2 } },
    );

    const first = await post(project, '/escalations', { agent: 'a', question: 'one?' });
    await post(project, '/escalations', { agent: 'a', question: 'two?' });
    const third = await post(project, '/escalations', { agent: 'a', question: 'three?' });
    assert.equal(third.statusCode, 409);

    const answered = await harness.server.inject({
      method: 'PATCH',
      url: `${project.api}/escalations/${first.json().escalation.id}`,
      headers: authed(project),
      payload: { status: 'answered', answer: 'yes' },
    });
    assert.equal(answered.statusCode, 200);

    const afterAnswering = await post(project, '/escalations', { agent: 'a', question: 'three?' });
    assert.equal(
      afterAnswering.statusCode,
      201,
      'answering a question has to make room for the next one',
    );
  });

  it('frees a slot when an item is deleted outright', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'mistake', title: 'bad import', actor: 'a' });

    const deleted = await harness.server.inject({
      method: 'DELETE',
      url: `${project.api}/items/mistake`,
      headers: authed(project),
    });
    assert.equal(deleted.statusCode, 200);

    const project_ = await harness.store.projects.findOne({ _id: project.id });
    assert.equal(project_!.counts.items, 0);
    assert.equal(await harness.store.items.countDocuments({ projectId: project.id }), 0);
  });

  it('charges a slot for reopening a closed item', async () => {
    const project = await createProject(harness);
    await harness.store.projects.updateOne({ _id: project.id }, { $set: { 'limits.items': 1 } });

    await post(project, '/items', { slug: 'closed', title: 'closed', actor: 'a' });
    await post(project, '/items', { slug: 'closed', status: 'done', actor: 'a' });
    await post(project, '/items', { slug: 'live', title: 'live', actor: 'a' });

    // The one slot is taken by "live", so reviving "closed" has to be refused
    // rather than quietly putting two open items in a one item project.
    const reopened = await post(project, '/items', { slug: 'closed', status: 'open', actor: 'a' });
    assert.equal(reopened.statusCode, 409);

    const stillClosed = await harness.store.items.findOne({ projectId: project.id, slug: 'closed' });
    assert.equal(stillClosed!.status, 'done');
  });

  it('counts one closure when two agents close the same item at once', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'one', title: 'one', actor: 'a' });
    await post(project, '/items', { slug: 'two', title: 'two', actor: 'a' });

    await Promise.all([
      post(project, '/items', { slug: 'one', status: 'done', actor: 'a' }),
      post(project, '/items', { slug: 'one', status: 'done', actor: 'b' }),
      post(project, '/items', { slug: 'one', status: 'done', actor: 'c' }),
    ]);

    const doc = await harness.store.projects.findOne({ _id: project.id });
    assert.equal(doc!.counts.items, 1, 'three writers, one closure, one slot freed');
  });

  it('frees slots as soon as an observation closes mirrored items', async () => {
    const project = await createProject(harness);
    await harness.store.projects.updateOne({ _id: project.id }, { $set: { 'limits.items': 2 } });
    for (const slug of ['signal-a', 'signal-b']) {
      await post(project, '/items', { slug, title: slug, body: 'mirrored', source: 'scan', actor: 'a' });
    }

    await post(project, '/observe', { source: 'scan', present: [] });
    await harness.store.items.updateMany(
      { projectId: project.id },
      { $set: { 'absence.since': new Date(Date.now() - 48 * 3_600_000) } },
    );
    const observed = await post(project, '/observe', { source: 'scan', present: [] });
    assert.equal(observed.json().resolved, 2);

    // No sweep in between: the capacity has to be back immediately, or an agent
    // that just cleared its own backlog is told the project is full.
    const next = await post(project, '/items', { slug: 'fresh', title: 'fresh', actor: 'a' });
    assert.equal(next.statusCode, 201);
  });

  it('does not let a slow writer undo a newer status', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'contested', title: 'contested', actor: 'a' });

    // A closes it, B reopens it. Whatever the interleaving, the item and the
    // counter have to agree at the end: the old code let A's second write close
    // the item again while the counter still reflected B's reopening.
    await Promise.all([
      post(project, '/items', { slug: 'contested', status: 'done', body: 'closed by a', actor: 'a' }),
      post(project, '/items', { slug: 'contested', status: 'open', body: 'reopened by b', actor: 'b' }),
    ]);

    const item = await harness.store.items.findOne({ projectId: project.id, slug: 'contested' });
    const doc = await harness.store.projects.findOne({ _id: project.id });
    const openInReality = item!.status === 'open' || item!.status === 'blocked' ? 1 : 0;
    assert.equal(doc!.counts.items, openInReality, `item is ${item!.status}, counter says ${doc!.counts.items}`);
  });

  it('counts one answer when two operators answer the same question at once', async () => {
    const project = await createProject(harness);
    const created = await post(project, '/escalations', { agent: 'a', question: 'ship it?' });
    const id = created.json().escalation.id;

    const answer = () =>
      harness.server.inject({
        method: 'PATCH',
        url: `${project.api}/escalations/${id}`,
        headers: authed(project),
        payload: { status: 'answered', answer: 'yes' },
      });
    await Promise.all([answer(), answer(), answer()]);

    const doc = await harness.store.projects.findOne({ _id: project.id });
    assert.equal(doc!.counts.escalations, 0, 'one question answered, one slot freed');
  });

  it('charges a slot for reopening an answered question', async () => {
    const project = await createProject(harness);
    await harness.store.projects.updateOne(
      { _id: project.id },
      { $set: { 'limits.escalations': 1 } },
    );
    const first = await post(project, '/escalations', { agent: 'a', question: 'one?' });
    const id = first.json().escalation.id;

    await harness.server.inject({
      method: 'PATCH',
      url: `${project.api}/escalations/${id}`,
      headers: authed(project),
      payload: { status: 'answered', answer: 'yes' },
    });
    await post(project, '/escalations', { agent: 'a', question: 'two?' });

    const reopened = await harness.server.inject({
      method: 'PATCH',
      url: `${project.api}/escalations/${id}`,
      headers: authed(project),
      payload: { status: 'open', answer: '' },
    });
    assert.equal(reopened.statusCode, 409, 'the queue is full, so it cannot take one back');
  });

  it('gives older questions a priority rank at boot', async () => {
    const project = await createProject(harness);
    const created = await post(project, '/escalations', {
      agent: 'a',
      question: 'urgent one',
      priority: 'urgent',
    });
    // A document written before the field existed looks like this.
    await harness.store.escalations.updateOne(
      { _id: created.json().escalation.id },
      { $unset: { priorityRank: '' } },
    );

    const { runMigrations } = await import('../src/db.js');
    await runMigrations(harness.store);

    const migrated = await harness.store.escalations.findOne({
      _id: created.json().escalation.id,
    });
    assert.equal(migrated!.priorityRank, 3);
  });

  it('pages through escalations so an importer can see all of them', async () => {
    const project = await createProject(harness);
    for (let i = 0; i < 5; i += 1) {
      await post(project, '/escalations', { agent: 'a', question: `question ${i}` });
    }

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const response = await harness.server.inject({
        method: 'GET',
        url: `${project.api}/escalations?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        headers: authed(project),
      });
      const body = response.json();
      for (const doc of body.escalations) seen.add(doc.question);
      if (body.escalations.length < 2 || !body.next_cursor) break;
      cursor = body.next_cursor;
    }
    assert.equal(seen.size, 5, 'paging must reach every question, not just the newest page');
  });

  it('says how much carried history it kept instead of quietly dropping it', async () => {
    const project = await createProject(harness);
    const history = Array.from({ length: 120 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(),
      by: 'old-system',
      message: `entry ${i}`,
    }));

    const response = await post(project, '/items', {
      slug: 'long-history',
      title: 'a long history',
      actor: 'migration',
      history,
    });
    assert.equal(response.statusCode, 201);
    const warnings = response.json().warnings as string[];
    assert.ok(
      warnings.some((warning) => /Kept the \d+ most recent of 120/.test(warning)),
      `expected a truncation warning, got ${JSON.stringify(warnings)}`,
    );

    const item = await harness.store.items.findOne({ projectId: project.id, slug: 'long-history' });
    assert.ok(item!.timeline.length <= 50);
    // The most recent entries are the ones worth keeping.
    assert.equal(item!.timeline.at(-2)!.message, 'entry 119');
  });

  it('validates carried history before it changes anything', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'guarded', title: 'x', actor: 'a' });

    const rejected = await post(project, '/items', {
      slug: 'guarded',
      status: 'done',
      actor: 'a',
      history: [{ at: 'nonsense', message: 'x' }],
    });
    assert.equal(rejected.statusCode, 400);

    const item = await harness.store.items.findOne({ projectId: project.id, slug: 'guarded' });
    const doc = await harness.store.projects.findOne({ _id: project.id });
    assert.equal(item!.status, 'open', 'a rejected request must not have changed the status');
    assert.equal(doc!.counts.items, 1, 'nor the quota');
  });

  it('repairs an overcounted project, and never inflates one', async () => {
    const { correctOvercount } = await import('../src/hygiene.js');
    const { createProject: createDirect, upsertItem } = await import('../src/service.js');
    // Built and swept through the service rather than over HTTP. Every request
    // fires a throttled sweep of its own, and one of those landing between the
    // two passes below writes a fresh observation over the backdated one, which
    // is a race this test kept losing on a slower machine.
    const { project } = await createDirect(harness.store, harness.config, { name: 'overcounted' });
    await upsertItem(harness.store, project, { slug: 'one', title: 'one', actor: 'a' });

    // Two passes, because a repair applies only to a discrepancy that sat
    // still: the first records what it saw, the second acts on it. Production
    // spaces them a minute apart on its own; here the observation is moved
    // back instead of waiting for one.
    const settle = async () => {
      await correctOvercount(harness.store, project._id);
      await harness.store.projects.updateOne(
        { _id: project._id },
        { $set: { 'countsCheck.items.at': new Date(Date.now() - 60_000) } },
      );
      await correctOvercount(harness.store, project._id);
    };
    const counter = async () =>
      (await harness.store.projects.findOne({ _id: project._id }))!.counts.items;

    // A process that died between closing an item and giving back its slot
    // leaves the counter too high, which would reject valid work forever.
    await harness.store.projects.updateOne({ _id: project._id }, { $set: { 'counts.items': 40 } });
    await settle();
    assert.equal(await counter(), 1);

    // The other direction is left alone: correcting upwards is how a recount
    // double-counts a write that lands while it is counting.
    await harness.store.projects.updateOne({ _id: project._id }, { $set: { 'counts.items': 0 } });
    await settle();
    assert.equal(await counter(), 0);
  });

  it('skips the overcount repair when a write lands while it is counting', async () => {
    const { correctOvercount } = await import('../src/hygiene.js');
    const { createProject: createDirect, upsertItem } = await import('../src/service.js');
    // Built through the service rather than over HTTP, and this is the whole
    // reason: every request fires a throttled sweep in the background, that
    // sweep runs this same repair, and the patched counter below would be
    // consumed by it. On a slow runner the test then measured the race instead
    // of the guard, and failed in CI while passing on the machine that wrote it.
    const { project } = await createDirect(harness.store, harness.config, { name: 'overcount' });
    await upsertItem(harness.store, project, { slug: 'one', title: 'one', actor: 'a' });

    // Simulate the race directly: the repair reads the counter, and a create
    // increments it before the write-back. The guard has to make the repair
    // stand down, because lowering it here would undercount forever.
    const original = harness.store.items.countDocuments.bind(harness.store.items);
    let raced = false;
    harness.store.items.countDocuments = (async (...callArgs: unknown[]) => {
      const result = await (original as (...a: unknown[]) => Promise<number>)(...callArgs);
      if (!raced) {
        raced = true;
        await harness.store.projects.updateOne(
          { _id: project._id },
          { $inc: { 'counts.items': 5 } },
        );
      }
      return result;
    }) as typeof harness.store.items.countDocuments;

    try {
      const repaired = await correctOvercount(harness.store, project._id);
      assert.equal(repaired, false, 'a repair that raced a write must not apply');
      const counts = await harness.store.projects.findOne({ _id: project._id });
      assert.equal(counts!.counts.items, 6, 'the concurrent increment survives');
    } finally {
      harness.store.items.countDocuments = original;
    }
  });

  it('orders the operator queue by urgency, not by alphabet', async () => {
    const project = await createProject(harness);
    for (const [priority, question] of [
      ['low', 'a low one'],
      ['high', 'a high one'],
      ['normal', 'a normal one'],
      ['urgent', 'an urgent one'],
    ] as Array<[string, string]>) {
      await post(project, '/escalations', { agent: 'a', question, priority });
    }

    const queue = await harness.store.escalations
      .find({ projectId: project.id, status: 'open' })
      .sort({ priorityRank: -1, createdAt: 1 })
      .toArray();
    assert.deepEqual(
      queue.map((doc) => doc.priority),
      ['urgent', 'high', 'normal', 'low'],
    );
  });

  it('leaves a discrepancy alone while the board is still moving', async () => {
    const { correctOvercount } = await import('../src/hygiene.js');
    const { createProject: createDirect, upsertItem } = await import('../src/service.js');
    // One item closes while another reopens: the counter can come back to the
    // number the repair read while the count it took is already stale, which is
    // how a repair lowers a counter that was right. Seeing the same thing twice
    // is what tells the two apart.
    const { project } = await createDirect(harness.store, harness.config, { name: 'churn' });
    await upsertItem(harness.store, project, { slug: 'one', title: 'one', actor: 'a' });
    await upsertItem(harness.store, project, { slug: 'two', title: 'two', actor: 'a' });
    await harness.store.projects.updateOne({ _id: project._id }, { $set: { 'counts.items': 2 } });

    // First look: two open, counter two, nothing to do but remember it.
    assert.equal(await correctOvercount(harness.store, project._id), false);

    // The board moves between the looks, exactly as it does under real work.
    await harness.store.items.updateOne(
      { projectId: project._id, slug: 'one' },
      { $set: { status: 'done', updatedAt: new Date() } },
    );
    await harness.store.projects.updateOne(
      { _id: project._id },
      { $set: { 'countsCheck.items.at': new Date(Date.now() - 60_000) } },
    );
    assert.equal(
      await correctOvercount(harness.store, project._id),
      false,
      'what it sees now is not what it saw, so it waits again',
    );
    assert.equal(
      (await harness.store.projects.findOne({ _id: project._id }))!.counts.items,
      2,
      'and the counter is left for the close to correct',
    );
  });

  it('repairs a project that predates the version field', async () => {
    const { correctOvercount } = await import('../src/hygiene.js');
    const { createProject: createDirect, upsertItem } = await import('../src/service.js');
    // Every project that existed before the version was written has no such
    // field, and Mongo does not match a missing field against 0. Those are
    // exactly the projects whose counters have been stuck long enough to need
    // this, so the guard has to accept both.
    const { project } = await createDirect(harness.store, harness.config, { name: 'legacy' });
    await upsertItem(harness.store, project, { slug: 'one', title: 'one', actor: 'a' });
    await harness.store.projects.updateOne(
      { _id: project._id },
      { $set: { 'counts.items': 40 }, $unset: { countsVersion: '' } },
    );

    assert.equal(await correctOvercount(harness.store, project._id), false, 'first look records it');
    await harness.store.projects.updateOne(
      { _id: project._id },
      { $set: { 'countsCheck.items.at': new Date(Date.now() - 60_000) } },
    );
    assert.equal(await correctOvercount(harness.store, project._id), true, 'and the second repairs');
    assert.equal((await harness.store.projects.findOne({ _id: project._id }))!.counts.items, 1);
  });

  it('does not mistake one halfway close for another one settling', async () => {
    const { correctOvercount } = await import('../src/hygiene.js');
    const { createProject: createDirect, upsertItem } = await import('../src/service.js');
    // Two closes caught between their item write and their slot write read
    // identically: counter N, N-1 open. Half a minute apart, a check on the
    // numbers alone calls the second one a settled leak and repairs a counter
    // that the first close is about to lower itself. The version every counter
    // write bumps is what tells the two events apart.
    const { project } = await createDirect(harness.store, harness.config, { name: 'aba' });
    await upsertItem(harness.store, project, { slug: 'one', title: 'one', actor: 'a' });
    await upsertItem(harness.store, project, { slug: 'two', title: 'two', actor: 'a' });
    const counters = async () =>
      (await harness.store.projects.findOne({ _id: project._id }))!;

    // A close, halfway: the item is done, the slot not yet given back.
    await harness.store.items.updateOne(
      { projectId: project._id, slug: 'one' },
      { $set: { status: 'done', updatedAt: new Date() } },
    );
    assert.equal(await correctOvercount(harness.store, project._id), false, 'first look records it');

    // The close finishes, and another item opens: the counter is back to 2 and
    // the work is back to 2, so the numbers alone say nothing happened.
    await harness.store.projects.updateOne(
      { _id: project._id },
      { $inc: { 'counts.items': -1, 'countsVersion.items': 1 } },
    );
    await upsertItem(harness.store, (await counters()), { slug: 'three', title: 'three', actor: 'a' });
    await harness.store.items.updateOne(
      { projectId: project._id, slug: 'two' },
      { $set: { status: 'done', updatedAt: new Date() } },
    );
    await harness.store.projects.updateOne(
      { _id: project._id },
      { $set: { 'countsCheck.items.at': new Date(Date.now() - 60_000) } },
    );

    assert.equal(
      await correctOvercount(harness.store, project._id),
      false,
      'the version moved, so this is a different halfway point and not a settled leak',
    );
  });

  it('never takes a counter below zero, whatever raced what', async () => {
    const { correctOvercount } = await import('../src/hygiene.js');
    const { createProject: createDirect, upsertItem, deleteItem } = await import('../src/service.js');
    // Closing an item is two writes, the status and then the slot, and the
    // repair reads the world in between: it sees one item fewer than the
    // counter, lowers the counter to what it counted, and the decrement lands
    // on top. CI found a counter at -1 that way. The repair still races, and
    // the race now costs a slot rather than the whole cap.
    const { project } = await createDirect(harness.store, harness.config, { name: 'racing close' });
    await upsertItem(harness.store, project, { slug: 'one', title: 'one', actor: 'a' });

    // The repair, having counted before the close and written after it.
    await harness.store.items.updateOne(
      { projectId: project._id, slug: 'one' },
      { $set: { status: 'done', closedAt: new Date(), updatedAt: new Date() } },
    );
    await correctOvercount(harness.store, project._id);
    await harness.store.projects.updateOne(
      { _id: project._id },
      { $set: { 'countsCheck.items.at': new Date(Date.now() - 60_000) } },
    );
    await correctOvercount(harness.store, project._id);
    assert.equal(
      (await harness.store.projects.findOne({ _id: project._id }))!.counts.items,
      0,
      'the repair lowered it to what it counted, once it had sat still',
    );

    // And now the close's own decrement, arriving late.
    await upsertItem(harness.store, { ...project, counts: { ...project.counts, items: 0 } }, {
      slug: 'one',
      status: 'open',
      actor: 'a',
    });
    await deleteItem(harness.store, { ...project, counts: { ...project.counts, items: 0 } }, 'one');
    const counts = (await harness.store.projects.findOne({ _id: project._id }))!.counts;
    assert.ok(counts.items >= 0, `a counter may be one low, never negative: ${counts.items}`);
  });

  it('keeps the counter honest through exact deltas on every path', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'real', title: 'real', actor: 'a' });
    assert.equal((await harness.store.projects.findOne({ _id: project.id }))!.counts.items, 1);

    await post(project, '/items', { slug: 'real', status: 'done', actor: 'a' });
    assert.equal((await harness.store.projects.findOne({ _id: project.id }))!.counts.items, 0);

    await post(project, '/items', { slug: 'real', status: 'open', actor: 'a' });
    assert.equal((await harness.store.projects.findOne({ _id: project.id }))!.counts.items, 1);
  });
});

/**
 * The audits of 2026-08-17, which read the running deployment rather than the
 * diff. Same principle as above: each one is a hole that was open.
 */
describe('what the audits of the live service found', () => {
  it('drops the claim when the item it covers is finished', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });
    await post(project, '/items/work/claim', { agent: 'a' });
    assert.ok((await harness.store.items.findOne({ projectId: project.id, slug: 'work' }))!.claim);

    // Closing it by hand from another agent still frees it: the work is over,
    // and a board whose "in progress" column asks `claimed: true` would
    // otherwise keep showing a finished card there until the lease ran out.
    await post(project, '/items', { slug: 'work', status: 'done', actor: 'b' });
    const closed = await harness.store.items.findOne({ projectId: project.id, slug: 'work' });
    assert.equal(closed!.claim, null);
    assert.ok(
      closed!.timeline.some((entry) => entry.kind === 'released' && entry.message.includes("a's claim")),
      'and the record says whose claim it was',
    );
  });

  it('tells an agent its own question is still waiting', async () => {
    // An empty inbox used to mean two different things: nobody has answered
    // yet, and the question was never filed. An agent cannot tell those apart,
    // and the second is a bug it should not paper over by asking again.
    const project = await createProject(harness);
    await post(project, '/escalations', { agent: 'errors-loop', question: 'which route?' });

    const inbox = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/inbox?agent=errors-loop`,
      headers: authed(project),
    });
    assert.deepEqual(inbox.json().answers, []);
    assert.equal(inbox.json().waiting.length, 1);
    assert.equal(inbox.json().waiting[0].question, 'which route?');
  });

  it('hands out an access token that expires, not a permanent admin key', async () => {
    // The token endpoint minted a key that lived as long as the project, on
    // every call. A client refreshing on a timer, which is ordinary, left one
    // live admin credential per refresh and no way to tell them apart.
    const registered = await harness.server.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'a client that refreshes' },
    });
    const { client_id: clientId, client_secret: clientSecret } = registered.json();

    const issued = await harness.server.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret },
    });
    const granted = issued.json();
    assert.ok(granted.expires_in > 0 && granted.expires_in <= 3600);

    const project = { id: granted.project, token: granted.access_token, readUrl: '', api: granted.api };
    assert.equal((await post(project, '/agents', { handle: 'a', scope: ['x'] })).statusCode, 201);

    // And when it is over it is over, whether or not the TTL index has caught
    // up with the document.
    await harness.store.keys.updateMany(
      { projectId: granted.project },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    assert.equal((await post(project, '/agents', { handle: 'b', scope: ['x'] })).statusCode, 401);
  });

  it('does not turn that token permanent when the project is claimed', async () => {
    // Claiming clears the expiry off everything that was only expiring because
    // the project was. An hour long access token is not one of those, and
    // sweeping it up here would promote it to a permanent admin credential on
    // the very projects that matter, the claimed ones.
    const registered = await harness.server.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'a client on a project somebody claims' },
    });
    const { client_id: clientId, client_secret: clientSecret } = registered.json();
    const granted = (
      await harness.server.inject({
        method: 'POST',
        url: '/oauth/token',
        payload: {
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        },
      })
    ).json();

    const doc = (await harness.store.projects.findOne({ _id: granted.project }))!;
    await claimProjectWithEmail(harness.store, doc, 'owner@example.com', harness.config);

    const oauthKey = await harness.store.keys.findOne({
      projectId: granted.project,
      ownExpiry: true,
    });
    assert.ok(oauthKey?.expiresAt, 'the access token still expires');
    // While the project token, which expired only because the project did,
    // correctly stops expiring.
    const projectKey = await harness.store.keys.findOne({
      projectId: granted.project,
      ownExpiry: { $ne: true },
    });
    assert.equal(projectKey?.expiresAt ?? null, null);
  });
});

/**
 * The verification pass over the audit fixes themselves, 2026-08-18. Every one
 * of these is a place where a fix landed on one path and not on its twin.
 */
describe('what the verification pass found in the fixes', () => {
  it('releases the claim when hygiene closes an item too, not only when an agent does', async () => {
    const project = await createProject(harness);
    await post(project, '/items', {
      slug: 'mirror:one',
      title: 'mirrored from a scanner',
      source: 'scanner',
      actor: 'loop',
    });
    await post(project, '/items/mirror:one/claim', { agent: 'loop' });
    await harness.store.projects.updateOne(
      { _id: project.id },
      { $set: { 'rules.absenceResolve': { observations: 1, minHours: 0 } } },
    );

    // The source stops reporting it, twice, which is what the rule counts.
    await post(project, '/observe', { source: 'scanner', present: [] });
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'mirror:one' },
      { $set: { 'absence.since': new Date(Date.now() - 86_400_000) } },
    );
    await post(project, '/observe', { source: 'scanner', present: [] });

    const closed = await harness.store.items.findOne({ projectId: project.id, slug: 'mirror:one' });
    assert.equal(closed!.status, 'done');
    assert.equal(closed!.claim, null, 'an item closed by hygiene is not work in progress either');
  });

  it('gives the same inbox through both doors', async () => {
    // The MCP case used to page one list of escalations and split it in
    // memory, so an open question fell off the end once a project had fifty
    // answered ones, and an answer already acted on came back for ever.
    const project = await createProject(harness);
    await post(project, '/escalations', { agent: 'a', question: 'the oldest one' });
    const oldest = (
      await harness.store.escalations.findOne({ projectId: project.id, status: 'open' })
    )!;
    for (let n = 0; n < 55; n += 1) {
      const filed = await post(project, '/escalations', { agent: 'a', question: `q${n}` });
      await harness.server.inject({
        method: 'PATCH',
        url: `${project.api}/escalations/${filed.json().escalation.id}`,
        headers: authed(project),
        payload: { status: 'answered', answer: 'yes' },
      });
    }

    const overHttp = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/inbox?agent=a`,
        headers: authed(project),
      })
    ).json();
    const overMcp = (
      await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        headers: authed(project),
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'inbox', arguments: { agent: 'a' } },
        },
      })
    ).json().result.structuredContent;

    assert.equal(overHttp.waiting.length, 1);
    assert.equal(overMcp.waiting.length, 1, 'the open one is not paged out over MCP either');
    assert.equal(overMcp.waiting[0].id, oldest._id);

    // And an answer already acted on leaves both inboxes.
    const acted = overHttp.answers[0].id;
    await post(project, `/escalations/${acted}/ack`, { agent: 'a', note: 'did it' });
    const mcpAfter = (
      await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        headers: authed(project),
        payload: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'inbox', arguments: { agent: 'a' } },
        },
      })
    ).json().result.structuredContent;
    assert.ok(
      !mcpAfter.answers.some((doc: { id: string }) => doc.id === acted),
      'an acknowledged answer does not come back over MCP',
    );
  });

  it('keeps the OAuth client alive when the project is claimed', async () => {
    // Everything else that expires because the project expires gets cleared on
    // a claim. The client registration was the one child left behind, so an
    // agent that came in through RFC 7591 lost its client_id a week after
    // somebody made the project permanent.
    const registered = await harness.server.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'a client whose project gets claimed' },
    });
    const projectId = registered.json().project;
    const doc = (await harness.store.projects.findOne({ _id: projectId }))!;
    await claimProjectWithEmail(harness.store, doc, 'owner@example.com', harness.config);

    const client = await harness.store.oauthClients.findOne({ projectId });
    assert.equal(client?.expiresAt ?? null, null, 'the client outlives the demo window');
  });

  it('shows a person the boards they asked for, not only the ones offered to them', async () => {
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    const session = await signIn(harness, 'asker@example.com');
    await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/handover`,
      payload: session.form({ note: 'this fleet is mine' }),
      headers: session.headers,
    });

    const page = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    assert.match(page.body, /Boards you asked for/);
    assert.match(page.body, /this fleet is mine/);
  });

  it('writes the fields only on the insert when a caller says insertOnly', async () => {
    // The atomic half of the anonymous report path, exercised directly because
    // the race that needs it cannot be produced through the rate limited
    // route. A caller that loses the race must change nothing but the
    // timeline.
    const project = await createProject(harness);
    const doc = (await harness.store.projects.findOne({ _id: project.id }))!;
    await upsertItem(harness.store, doc, {
      slug: 'feedback:one',
      title: 'first',
      body: 'what the first reporter wrote',
      labels: ['feedback'],
      actor: 'guest:one',
      insertOnly: true,
      guest: true,
      note: 'first',
    });

    const loser = await upsertItem(harness.store, doc, {
      slug: 'feedback:one',
      title: 'second',
      body: 'OWNED',
      labels: ['spam'],
      actor: 'guest:two',
      insertOnly: true,
      guest: true,
      note: 'second',
    });
    assert.equal(loser.created, false);
    assert.equal(loser.item.title, 'first');
    assert.equal(loser.item.body, 'what the first reporter wrote');
    assert.deepEqual(loser.item.labels, ['feedback']);
    assert.ok(loser.item.timeline.some((entry) => entry.message === 'second'));
  });

  it('does not let a passer-by keep a report looking fresh', async () => {
    const seeded = await startHarness();
    const host = await createProject(seeded, 'reports');
    await seeded.stop();
    const open = await startHarness({
      MONGODB_DB: seeded.config.mongoDb,
      FEEDBACK_PROJECT: host.id,
    });
    try {
      const filed = await open.server.inject({
        method: 'POST',
        url: '/feedback',
        payload: { title: 'Something rotted', body: 'first' },
      });
      const slug = filed.json().slug;
      const stamp = new Date(Date.now() - 5 * 86_400_000);
      await open.store.items.updateOne(
        { projectId: host.id, slug },
        { $set: { stale: true, staleSince: stamp, touchedAt: stamp } },
      );

      await open.server.inject({
        method: 'POST',
        url: '/feedback',
        payload: { title: 'Something rotted', body: 'still here', from: 'nobody' },
      });

      const item = (await open.store.items.findOne({ projectId: host.id, slug }))!;
      assert.equal(item.stale, true, 'a stranger repeating themselves is not proof of life');
      assert.equal(item.touchedAt.getTime(), stamp.getTime());
      // And the first report was born with those fields, rather than without
      // them: an item created with no touchedAt is one hygiene can never call
      // stale, which would make every report immortal by omission.
      const fresh = await open.server.inject({
        method: 'POST',
        url: '/feedback',
        payload: { title: 'A second thing rotted', body: 'first' },
      });
      const born = (await open.store.items.findOne({
        projectId: host.id,
        slug: fresh.json().slug,
      }))!;
      assert.ok(born.touchedAt instanceof Date);
      assert.equal(born.stale, false);
      assert.equal(born.staleSince, null);
      assert.ok(
        item.timeline.some((entry) => entry.message.includes('still here')),
        'and the words still land on the timeline',
      );
    } finally {
      await open.stop();
    }
  });

  /**
   * Found by the soak rather than by reading: four hundred rounds of concurrent
   * work left the open counter one below the collection, permanently, because
   * nothing repairs a counter that is too low.
   *
   * The interleaving is not exotic. Two agents write the same new slug, one
   * with a status; the second one looks, sees nothing, and by the time its
   * write lands the first has created the item. Applying the status then moves
   * a document nobody read: no guard, so nobody owns the transition, and no
   * accounting, because the counter is moved either by the guarded branch or by
   * the creation, and that write is neither.
   *
   * Simulated exactly rather than hammered, so this fails for the reason it
   * names instead of when the machine is busy.
   */
  it('does not move a status it never read, and does not lose the slot', async () => {
    const { createProject: createDirect, upsertItem } = await import('../src/service.js');
    const { project } = await createDirect(harness.store, harness.config, { name: 'raced' }, 'http');

    const asItWas = harness.store.items.findOne.bind(harness.store.items);
    let raced = false;
    // The item appears between the look and the write, which is the whole of
    // the race. One call only: the create below goes through this same path.
    (harness.store.items as { findOne: typeof asItWas }).findOne = (async (...args: unknown[]) => {
      const found = await (asItWas as (...rest: unknown[]) => Promise<unknown>)(...args);
      if (!raced && found === null) {
        raced = true;
        await upsertItem(harness.store, project, { slug: 'contested', title: 'first', actor: 'a' });
      }
      return found;
    }) as typeof asItWas;

    try {
      const late = await upsertItem(harness.store, project, {
        slug: 'contested',
        title: 'second',
        status: 'done',
        actor: 'b',
      });
      assert.equal(raced, true, 'the race this test is about did not happen');
      assert.equal(late.created, false, 'the other writer created it');
      assert.equal(late.item.status, 'open', 'and their status stands, unmoved by a write that never saw it');
    } finally {
      (harness.store.items as { findOne: typeof asItWas }).findOne = asItWas;
    }

    const doc = await harness.store.projects.findOne({ _id: project._id });
    const open = await harness.store.items.countDocuments({
      projectId: project._id,
      status: { $nin: ['done', 'dropped'] },
    });
    assert.equal(open, 1);
    assert.equal(doc!.counts.items, open, 'the counter says what the collection says');
  });
});
