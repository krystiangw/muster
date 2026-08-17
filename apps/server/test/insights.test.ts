import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { insights } from '../src/events.js';
import { authed, createProject, startHarness, type Harness, type Project } from './helper.js';

/**
 * The numbers that say whether the front door works. Everything else about
 * usage is already in the collections; what these cover is the part that would
 * otherwise leave no trace: reading the protocol and walking away, and which
 * door somebody came through.
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

describe('what the service knows about its own use', () => {
  it('counts the funnel from reading the protocol to writing something', async () => {
    await harness.server.inject({ method: 'GET', url: '/skill.md' });
    await harness.server.inject({ method: 'GET', url: '/.well-known/agent-access.json' });

    const project = await createProject(harness, 'measured');
    await post(project, '/agents', { handle: 'errors-loop', scope: [] });
    await post(project, '/items', { slug: 'first', title: 'first thing', actor: 'errors-loop' });
    // A second item is not a second activation.
    await post(project, '/items', { slug: 'second', title: 'second thing', actor: 'errors-loop' });

    const report = await insights(harness.store);
    assert.ok(report.funnel.discovered >= 2, 'reading the protocol is visible');
    assert.ok(report.funnel.signups >= 1);
    assert.ok(report.funnel.withAnAgent >= 1);
    assert.equal(report.funnel.withWork, 1, 'the first write is the activation, and only the first');
    assert.equal(report.doors.http >= 1, true);
  });

  it('tells the doors apart', async () => {
    const created = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_project', arguments: { name: 'over mcp' } },
      },
    });
    const token = created.json().result.structuredContent.token;
    const id = created.json().result.structuredContent.project;
    await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'upsert_item', arguments: { slug: 'over-mcp', title: 'x', actor: 'a' } },
      },
    });

    const report = await insights(harness.store);
    assert.ok(report.doors.mcp >= 1, 'an agent arriving over MCP is not the same as one over curl');

    const written = await harness.store.events.findOne({ kind: 'first_write', projectId: id });
    assert.equal(written?.door, 'mcp');
  });

  it('holds nothing about a person', async () => {
    await harness.server.inject({ method: 'GET', url: '/skill.md' });
    const events = await harness.store.events.find({}).limit(50).toArray();
    assert.ok(events.length > 0);

    for (const event of events) {
      // The whole point of keeping this small: it is a log of moments, not a
      // second copy of the service's data and not a record of anybody.
      assert.deepEqual(
        Object.keys(event).sort(),
        ['_id', 'at', 'detail', 'door', 'expiresAt', 'kind', 'projectId'],
      );
      assert.ok(
        event.detail === null || ['skill.md', 'agent-signup.md', 'llms.txt', 'agent-access.json', 'mcp.json'].includes(event.detail),
        'detail is one of our own file names, never anything a caller sent',
      );
      assert.ok(event.expiresAt > event.at, 'and it expires');
    }
  });

  it('never fails a request when it cannot record', async () => {
    const broken = { ...harness.store, events: { insertOne: () => Promise.reject(new Error('down')) } };
    // Recording is fire and forget on purpose: telemetry that can break the
    // thing it measures is worse than no telemetry.
    const { record } = await import('../src/events.js');
    assert.doesNotThrow(() => record(broken as never, 'discover', { door: 'http' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
