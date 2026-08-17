import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
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
});
