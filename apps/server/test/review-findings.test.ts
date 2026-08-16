import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authed, createProject, startHarness, type Harness, type Project } from './helper.js';

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
  it('holds when twenty agents create different slugs at once', async () => {
    const project = await createProject(harness);
    await harness.store.projects.updateOne({ _id: project.id }, { $set: { 'limits.items': 5 } });

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post(project, '/items', { slug: `race-${i}`, title: `race ${i}`, actor: 'a' }),
      ),
    );
    const accepted = responses.filter((r) => r.statusCode === 201).length;
    const refused = responses.filter((r) => r.statusCode === 409).length;

    assert.equal(accepted, 5, 'the cap is a cap, not a suggestion');
    assert.equal(refused, 15);

    const stored = await harness.store.items.countDocuments({ projectId: project.id });
    assert.equal(stored, 5);
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

  it('repairs a drifted count on the next sweep', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'real', title: 'real', actor: 'a' });
    await harness.store.projects.updateOne({ _id: project.id }, { $set: { 'counts.items': 999 } });

    await post(project, '/sweep', {});

    const repaired = await harness.store.projects.findOne({ _id: project.id });
    assert.equal(repaired!.counts.items, 1);
  });
});
