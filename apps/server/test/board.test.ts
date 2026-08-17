import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { moveItem } from '../src/board.js';
import { authed, createProject, startHarness, type Harness, type Project } from './helper.js';

/**
 * Columns are a view, not a state. These tests exist to keep it that way: a
 * project can lay its board out however it likes, and no layout can introduce a
 * fifth status for every agent to learn.
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

async function put(project: Project, path: string, payload: unknown) {
  return harness.server.inject({
    method: 'PUT',
    url: `${project.api}${path}`,
    headers: authed(project),
    payload: payload as Record<string, unknown>,
  });
}

async function board(project: Project, query = '') {
  const response = await harness.server.inject({
    method: 'GET',
    url: `${project.api}/board${query}`,
    headers: authed(project),
  });
  return response.json();
}

function cell(view: Record<string, any>, columnKey: string, rowKey = '') {
  const row = view.rows.find((candidate: { key: string }) => candidate.key === rowKey);
  return row?.columns.find((candidate: { key: string }) => candidate.key === columnKey);
}

describe('the default board', () => {
  it('separates untouched work from work somebody is holding', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'free', title: 'free', actor: 'a' });
    await post(project, '/items', { slug: 'held', title: 'held', actor: 'a' });
    await post(project, '/items', { slug: 'stuck', title: 'stuck', status: 'blocked', actor: 'a' });
    await post(project, '/items', { slug: 'shipped', title: 'shipped', status: 'done', actor: 'a' });
    await post(project, '/items/held/claim', { agent: 'worker', ttl_minutes: 30 });

    const view = await board(project);
    assert.equal(cell(view, 'todo').count, 1);
    assert.equal(cell(view, 'todo').items[0].slug, 'free');
    assert.equal(cell(view, 'doing').count, 1);
    assert.equal(cell(view, 'doing').items[0].slug, 'held');
    assert.equal(cell(view, 'blocked').count, 1);
    assert.equal(cell(view, 'done').count, 1);
    assert.equal(view.unplaced, 0);
  });

  it('treats an expired claim as free, like every other part of the system', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'lapsed', title: 'lapsed', actor: 'a' });
    await post(project, '/items/lapsed/claim', { agent: 'gone', ttl_minutes: 5 });
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'lapsed' },
      { $set: { 'claim.expiresAt': new Date(Date.now() - 60_000) } },
    );

    const view = await board(project);
    assert.equal(cell(view, 'doing').count, 0, 'a dead session is not somebody working');
    assert.equal(cell(view, 'todo').count, 1);
  });
});

describe('a project’s own layout', () => {
  it('puts items in columns defined by labels, without inventing a status', async () => {
    const project = await createProject(harness);
    const saved = await put(project, '/board', {
      rows: 'none',
      columns: [
        { title: 'Monitoring', match: { status: ['open'], labels: ['monitoring'] } },
        { title: 'Investigating', match: { status: ['open'], claimed: true } },
        { title: 'New', match: { status: ['open'] } },
        { title: 'Closed', match: { status: ['done', 'dropped'] } },
      ],
    });
    assert.equal(saved.statusCode, 200);

    await post(project, '/items', { slug: 'watch', title: 'watching', labels: ['monitoring'], actor: 'a' });
    await post(project, '/items', { slug: 'fresh', title: 'fresh', actor: 'a' });
    await post(project, '/items', { slug: 'busy', title: 'busy', actor: 'a' });
    await post(project, '/items/busy/claim', { agent: 'worker' });
    await post(project, '/items', { slug: 'old', title: 'old', status: 'dropped', actor: 'a' });

    const view = await board(project);
    assert.equal(cell(view, 'monitoring').items[0].slug, 'watch');
    assert.equal(cell(view, 'investigating').items[0].slug, 'busy');
    assert.equal(cell(view, 'new').items[0].slug, 'fresh');
    assert.equal(cell(view, 'closed').count, 1);

    // The statuses are still the four. The layout did not add a fifth.
    const stored = await harness.store.items.find({ projectId: project.id }).toArray();
    for (const item of stored) {
      assert.ok(['open', 'blocked', 'done', 'dropped'].includes(item.status), item.status);
    }
  });

  it('gives each item to the first matching column only', async () => {
    const project = await createProject(harness);
    await put(project, '/board', {
      columns: [
        { title: 'Urgent', match: { priority_min: 5 } },
        { title: 'Everything else', match: {} },
      ],
    });
    await post(project, '/items', { slug: 'hot', title: 'hot', priority: 7, actor: 'a' });

    const view = await board(project);
    assert.equal(cell(view, 'urgent').count, 1);
    assert.equal(cell(view, 'everything-else').count, 0, 'a card must not appear twice');
  });

  it('reports work that matches no column instead of hiding it', async () => {
    const project = await createProject(harness);
    await put(project, '/board', {
      columns: [{ title: 'Blocked only', match: { status: ['blocked'] } }],
    });
    await post(project, '/items', { slug: 'orphan', title: 'orphan', actor: 'a' });

    const view = await board(project);
    assert.equal(view.unplaced, 1);
  });

  it('lays out swimlanes by owner, with the unassigned lane last', async () => {
    const project = await createProject(harness);
    await put(project, '/board', {
      rows: 'owner',
      columns: [{ title: 'Open', match: { status: ['open'] } }],
    });
    await post(project, '/items', { slug: 'a1', title: 'a1', owner: 'errors-loop', actor: 'a' });
    await post(project, '/items', { slug: 'b1', title: 'b1', owner: 'trades-loop', actor: 'a' });
    await post(project, '/items', { slug: 'c1', title: 'c1', actor: 'a' });

    const view = await board(project);
    assert.deepEqual(
      view.rows.map((row: { key: string }) => row.key),
      ['errors-loop', 'trades-loop', ''],
    );
    assert.equal(cell(view, 'open', 'errors-loop').count, 1);
    assert.equal(cell(view, 'open', '').items[0].slug, 'c1');
  });

  it('filters on fields carried over from another system', async () => {
    const project = await createProject(harness);
    await put(project, '/board', {
      columns: [
        {
          title: 'Fix planned',
          match: { fields: { legacy_status: ['fix_planned', 'root_cause_found'] } },
        },
        { title: 'Rest', match: {} },
      ],
    });
    await post(project, '/items', {
      slug: 'migrated',
      title: 'migrated',
      fields: { legacy_status: 'fix_planned' },
      actor: 'a',
    });
    await post(project, '/items', { slug: 'plain', title: 'plain', actor: 'a' });

    const view = await board(project);
    assert.equal(cell(view, 'fix-planned').items[0].slug, 'migrated');
    assert.equal(cell(view, 'rest').items[0].slug, 'plain');
  });

  it('refuses a column that tries to invent a status', async () => {
    const project = await createProject(harness);
    const rejected = await put(project, '/board', {
      columns: [{ title: 'In progress', match: { status: ['in_progress'] } }],
    });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.json().message, /does not exist/);
  });

  it('refuses a board with no columns, duplicate keys or too many columns', async () => {
    const project = await createProject(harness);
    assert.equal((await put(project, '/board', { columns: [] })).statusCode, 400);
    assert.equal(
      (
        await put(project, '/board', {
          columns: [
            { key: 'x', title: 'One', match: {} },
            { key: 'x', title: 'Two', match: {} },
          ],
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await put(project, '/board', {
          columns: Array.from({ length: 13 }, (_, i) => ({ title: `Col ${i}`, match: {} })),
        })
      ).statusCode,
      400,
    );
  });

  it('refuses two columns whose keys collide only after truncation', async () => {
    const project = await createProject(harness);
    const rejected = await put(project, '/board', {
      columns: [
        { title: 'Waiting on the exchange to confirm the transfer', match: {} },
        { title: 'Waiting on the exchange to confirm the withdrawal', match: {} },
      ],
    });
    // Both titles derive a key longer than the 32 char cut and are identical up
    // to it, so the check has to run after truncation, not before.
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.json().message, /share the key/);
  });

  it('fills a catch-all column with closed work too', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'live', title: 'live', actor: 'a' });
    await post(project, '/items', { slug: 'shipped', title: 'shipped', status: 'done', actor: 'a' });
    await post(project, '/items', {
      slug: 'binned',
      title: 'binned',
      status: 'dropped',
      actor: 'a',
    });

    await put(project, '/board', {
      columns: [
        { key: 'open', title: 'Open', match: { status: ['open'] } },
        // No status filter at all: this column means "everything else", which
        // includes the two terminal statuses. Loading only open items would
        // silently render it empty.
        { key: 'rest', title: 'Everything else', match: {} },
      ],
    });

    const view = await board(project);
    assert.equal(cell(view, 'open').count, 1);
    assert.equal(cell(view, 'rest').count, 2, 'done and dropped are both in the catch-all');
    assert.deepEqual(
      cell(view, 'rest')
        .items.map((item: { slug: string }) => item.slug)
        .sort(),
      ['binned', 'shipped'],
    );
  });

  it('needs an admin token to change the layout', async () => {
    const project = await createProject(harness);
    const minted = await post(project, '/keys', { name: 'worker', role: 'write' });
    const asWorker = await harness.server.inject({
      method: 'PUT',
      url: `${project.api}/board`,
      headers: { authorization: `Bearer ${minted.json().token}` },
      payload: { columns: [{ title: 'Mine', match: {} }] },
    });
    assert.equal(asWorker.statusCode, 403);
  });

  it('offers layouts to start from', async () => {
    const project = await createProject(harness);
    const presets = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/board/presets`,
        headers: authed(project),
      })
    ).json();
    const keys = presets.presets.map((preset: { key: string }) => preset.key);
    assert.ok(keys.includes('loops'));
    const loops = presets.presets.find((preset: { key: string }) => preset.key === 'loops');
    assert.equal(loops.board.rows, 'owner');
  });
});

describe('the board in the browser', () => {
  it('renders columns, cards and the layout editor without JavaScript', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'visible', title: 'a visible card', actor: 'a' });
    const readToken = (await harness.store.projects.findOne({ _id: project.id }))!.readToken;

    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.equal(page.statusCode, 200);
    assert.doesNotMatch(page.body, /<script/i);
    assert.match(page.body, /a visible card/);
    assert.match(page.body, /To do/);
    assert.match(page.body, /<textarea name="board"/);
  });

  it('saves a layout from the form and from a preset', async () => {
    const project = await createProject(harness);
    const readToken = (await harness.store.projects.findOne({ _id: project.id }))!.readToken;

    const saved = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board`,
      payload: `board=${encodeURIComponent(
        JSON.stringify({ rows: 'none', columns: [{ title: 'Only', match: {} }] }),
      )}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(saved.statusCode, 303);
    assert.equal((await board(project)).board.columns.length, 1);

    const preset = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board`,
      payload: 'preset=loops',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(preset.statusCode, 303);
    const view = await board(project);
    assert.equal(view.board.rows, 'owner');
    assert.ok(view.board.columns.length > 1);
  });

  it('says what is wrong instead of saving broken JSON', async () => {
    const project = await createProject(harness);
    const readToken = (await harness.store.projects.findOne({ _id: project.id }))!.readToken;
    const rejected = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board`,
      payload: 'board=not json at all',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.json().message, /valid JSON/);
  });
});

describe('moving an item into a column', () => {
  async function move(project: Project, slug: string, column: string, actor = 'mover') {
    return harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/${slug}/move`,
      headers: authed(project),
      payload: { column, actor },
    });
  }

  it('reads the default board as claim, release and status', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });

    const started = await move(project, 'work', 'doing', 'worker');
    assert.equal(started.statusCode, 200);
    assert.equal(started.json().landed_in, 'doing');
    assert.equal(started.json().item.claim.agent, 'worker', 'in progress is a claim, not a status');
    assert.equal(started.json().item.status, 'open', 'and no fifth status was invented');

    const back = await move(project, 'work', 'todo');
    assert.equal(back.json().landed_in, 'todo');
    assert.equal(back.json().item.claim, null);

    const finished = await move(project, 'work', 'done');
    assert.equal(finished.json().landed_in, 'done');
    assert.equal(finished.json().item.status, 'done');
  });

  it('adds and removes the labels its column filters on', async () => {
    const project = await createProject(harness);
    await post(project, '/items', {
      slug: 'signal',
      title: 'signal',
      labels: ['triage'],
      actor: 'a',
    });
    await put(project, '/board', {
      columns: [
        { key: 'triage', title: 'Triage', match: { labels: ['triage'] } },
        {
          key: 'watching',
          title: 'Watching',
          match: { labels: ['monitoring'], not_labels: ['triage'] },
        },
        { key: 'rest', title: 'Rest', match: {} },
      ],
    });

    const moved = await move(project, 'signal', 'watching');
    assert.equal(moved.json().landed_in, 'watching');
    assert.deepEqual(moved.json().item.labels, ['monitoring']);
    assert.deepEqual(moved.json().applied, {
      add_labels: ['monitoring'],
      remove_labels: ['triage'],
    });
  });

  it('honours an apply the column spells out', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'escalated', title: 'escalated', actor: 'a' });
    await put(project, '/board', {
      columns: [
        {
          key: 'operator',
          title: 'Waiting on the operator',
          match: { status: ['blocked'], labels: ['operator'] },
          apply: { status: 'blocked', add_labels: ['operator'], owner: 'alex', priority: 3 },
        },
        { key: 'rest', title: 'Rest', match: {} },
      ],
    });

    const moved = await move(project, 'escalated', 'operator');
    assert.equal(moved.json().landed_in, 'operator');
    assert.equal(moved.json().item.owner, 'alex');
    assert.equal(moved.json().item.priority, 3);
    assert.equal(moved.json().item.status, 'blocked');
    assert.ok(moved.json().item.labels.includes('operator'));
  });

  it('says so when the item does not land where it was sent', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'partial', title: 'partial', actor: 'a' });
    await put(project, '/board', {
      // The column wants a label and a source; a move can set the label but
      // never invents where an item came from.
      columns: [
        {
          key: 'mirrored',
          title: 'Mirrored',
          match: { labels: ['mirror'], source: ['scanner'] },
        },
        { key: 'rest', title: 'Rest', match: {} },
      ],
    });

    const moved = await move(project, 'partial', 'mirrored');
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().landed_in, 'rest');
    assert.match(moved.json().warning, /not "mirrored"/);
  });

  it('refuses a column that has nothing to apply, and one that does not exist', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'thing', title: 'thing', actor: 'a' });
    await put(project, '/board', {
      columns: [
        { key: 'everything', title: 'Everything', match: {} },
        { key: 'done', title: 'Done', match: { status: ['done'] } },
      ],
    });

    const pointless = await move(project, 'thing', 'everything');
    assert.equal(pointless.statusCode, 400);
    assert.match(pointless.json().message, /nothing to apply/);

    const missing = await move(project, 'thing', 'nowhere');
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json().message, /everything, done/, 'it names the columns it does have');
  });

  it('refuses to take an item somebody else is holding', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'busy', title: 'busy', actor: 'a' });
    await post(project, '/items/busy/claim', { agent: 'first', ttl_minutes: 30 });

    const stolen = await move(project, 'busy', 'doing', 'second');
    assert.equal(stolen.statusCode, 409);
    assert.match(stolen.json().message, /held by first/);

    const item = await harness.store.items.findOne({ projectId: project.id, slug: 'busy' });
    assert.equal(item!.claim!.agent, 'first', 'and nothing was changed on the way');
  });

  it('keeps the layout’s move semantics when the layout is read back and saved', async () => {
    const project = await createProject(harness);
    await put(project, '/board', {
      columns: [
        {
          key: 'monitoring',
          title: 'Monitoring',
          match: { labels: ['monitoring'] },
          apply: { add_labels: ['monitoring'], release: true },
        },
      ],
    });

    const read = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/board`,
        headers: authed(project),
      })
    ).json().board;
    assert.deepEqual(read.columns[0].apply, { add_labels: ['monitoring'], release: true });

    // Read, then written back unchanged: the round trip must not erase it,
    // which is exactly what the settings form does every time it saves.
    const saved = await put(project, '/board', read);
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json().board.columns[0].apply, {
      add_labels: ['monitoring'],
      release: true,
    });
  });

  it('does not leave a lease behind on a move it refuses', async () => {
    const isolated = await startHarness();
    try {
      const project = await createProject(isolated, 'full');
      const write = (path: string, payload: unknown) =>
        isolated.server.inject({
          method: 'POST',
          url: `${project.api}${path}`,
          headers: authed(project),
          payload: payload as Record<string, unknown>,
        });

      // Fill the project to its cap, then close one item so there is something
      // to move back in without a slot to put it in.
      const limits = (await isolated.store.projects.findOne({ _id: project.id }))!.limits.items;
      for (let index = 0; index < limits; index += 1) {
        await write('/items', { slug: `fill-${index}`, title: 'fill', actor: 'a' });
      }
      await write('/items', { slug: 'fill-0', title: 'fill', status: 'done', actor: 'a' });
      for (let index = limits; index < limits + 1; index += 1) {
        await write('/items', { slug: `fill-${index}`, title: 'fill', actor: 'a' });
      }

      const refused = await write('/items/fill-0/move', { column: 'doing', actor: 'worker' });
      assert.equal(refused.statusCode, 429, 'reopening at the cap is refused');

      const item = await isolated.store.items.findOne({ projectId: project.id, slug: 'fill-0' });
      assert.equal(item!.claim, null, 'and the refused move holds nothing');
      assert.equal(item!.status, 'done', 'and changed nothing');
    } finally {
      await isolated.stop();
    }
  });

  it('keeps a label another writer added while the move was in flight', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'shared', title: 'shared', labels: ['triage'], actor: 'a' });
    await put(project, '/board', {
      columns: [
        {
          key: 'watching',
          title: 'Watching',
          match: { labels: ['monitoring'] },
          apply: { add_labels: ['monitoring'], remove_labels: ['triage'] },
        },
        { key: 'rest', title: 'Rest', match: {} },
      ],
    });

    // Somebody adds an unrelated label after the move read the item. Computing
    // the whole array from a snapshot would drop it.
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'shared' },
      { $push: { labels: 'urgent' } },
    );

    const moved = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/shared/move`,
      headers: authed(project),
      payload: { column: 'watching', actor: 'mover' },
    });
    const labels = moved.json().item.labels as string[];
    assert.ok(labels.includes('monitoring'), 'the move added its own label');
    assert.ok(!labels.includes('triage'), 'and removed its own');
    assert.ok(labels.includes('urgent'), 'and left the other writer’s alone');
  });

  it('reports an item deleted mid-move as gone instead of recreating it', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'vanishing', title: 'vanishing', actor: 'a' });
    await harness.store.items.deleteOne({ projectId: project.id, slug: 'vanishing' });

    const moved = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/vanishing/move`,
      headers: authed(project),
      payload: { column: 'done', actor: 'mover' },
    });
    assert.equal(moved.statusCode, 404);
    assert.equal(
      await harness.store.items.countDocuments({ projectId: project.id, slug: 'vanishing' }),
      0,
      'a blank item was not conjured in its place',
    );
  });

  it('does not revoke a claim taken after it read the item', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'contested', title: 'contested', actor: 'a' });
    await post(project, '/items/contested/claim', { agent: 'first', ttl_minutes: 30 });
    const doc = (await harness.store.projects.findOne({ _id: project.id }))!;

    // Somebody claims the item in the instant after the move has read it, which
    // is exactly what happens when the previous lease had expired and another
    // agent picked the work up. That interleaving is the whole point of the
    // guard and cannot be produced from outside the process, so the store hands
    // the move its snapshot and then lets the other agent in.
    let swapped = false;
    const items = new Proxy(harness.store.items, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'findOne') {
          return typeof value === 'function' ? (value as Function).bind(target) : value;
        }
        return async (...args: unknown[]) => {
          const found = await (value as Function).apply(target, args);
          if (!swapped) {
            swapped = true;
            await harness.store.items.updateOne(
              { projectId: project.id, slug: 'contested' },
              {
                $set: {
                  claim: {
                    agent: 'second',
                    claimedAt: new Date(),
                    heartbeatAt: new Date(),
                    expiresAt: new Date(Date.now() + 1_800_000),
                  },
                },
              },
            );
          }
          return found;
        };
      },
    });

    const result = await moveItem({ ...harness.store, items }, doc, {
      slug: 'contested',
      column: 'todo',
      actor: 'mover',
    });

    const item = await harness.store.items.findOne({ projectId: project.id, slug: 'contested' });
    assert.equal(item!.claim?.agent, 'second', 'the newer holder keeps the item');
    assert.equal(result.landedIn, 'doing', 'and the board says where it really is');
  });

  it('rate limits writes through a read link, which is a shareable capability', async () => {
    const isolated = await startHarness({ LIMIT_WRITES_PER_MINUTE: '2' });
    try {
      const project = await createProject(isolated, 'leaky');
      await isolated.server.inject({
        method: 'POST',
        url: `${project.api}/items`,
        headers: authed(project),
        payload: { slug: 'card', title: 'card', actor: 'a' },
      });
      const readToken = project.readUrl.split('/r/')[1]!;
      const move = () =>
        isolated.server.inject({
          method: 'POST',
          url: `/r/${readToken}/board/move`,
          payload: 'slug=card&column=doing',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });

      assert.equal((await move()).statusCode, 303);
      assert.equal((await move()).statusCode, 303);
      const third = await move();
      assert.equal(third.statusCode, 429);
      assert.ok(third.headers['retry-after'], 'and it says when to come back');
    } finally {
      await isolated.stop();
    }
  });

  it('moves a card from the board page without JavaScript', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'card', title: 'card', actor: 'a' });
    const readToken = project.readUrl.split('/r/')[1]!;

    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(page.body, /<form class="move" method="post"/);
    assert.match(page.body, /name="column"/);
    assert.ok(!/<script/i.test(page.body), 'still no JavaScript on the page');

    const moved = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/move`,
      payload: 'slug=card&column=done',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(moved.statusCode, 303);
    assert.match(moved.headers.location as string, /moved=card&landed=done/);

    const after = await harness.server.inject({
      method: 'GET',
      url: moved.headers.location as string,
    });
    assert.match(after.body, /is now in Done/);
  });
});

describe('the board over MCP', () => {
  it('is the same board an agent sees over HTTP', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'one', title: 'one', actor: 'a' });

    const response = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: authed(project),
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'board', arguments: {} },
      },
    });
    const view = response.json().result.structuredContent;
    assert.equal(view.totals.find((total: { key: string }) => total.key === 'todo').count, 1);
  });

  it('moves a card and reports where it landed', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'one', title: 'one', actor: 'a' });

    const response = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: authed(project),
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'move', arguments: { slug: 'one', column: 'doing', agent: 'worker' } },
      },
    });
    const result = response.json().result.structuredContent;
    assert.equal(result.landed_in, 'doing');
    assert.equal(result.item.claim.agent, 'worker');
    assert.deepEqual(result.applied, { status: 'open', claim: true });
  });
});
