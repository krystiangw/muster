import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { claimProjectWithEmail, upsertItem } from '../src/service.js';
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
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'one', title: 'one', actor: 'a' });

    // A process that died between closing an item and giving back its slot
    // leaves the counter too high, which would reject valid work forever.
    await harness.store.projects.updateOne({ _id: project.id }, { $set: { 'counts.items': 40 } });
    await post(project, '/sweep', {});
    assert.equal((await harness.store.projects.findOne({ _id: project.id }))!.counts.items, 1);

    // The other direction is left alone: correcting upwards is how a recount
    // double-counts a write that lands while it is counting.
    await harness.store.projects.updateOne({ _id: project.id }, { $set: { 'counts.items': 0 } });
    await post(project, '/sweep', {});
    assert.equal((await harness.store.projects.findOne({ _id: project.id }))!.counts.items, 0);
  });

  it('skips the overcount repair when a write lands while it is counting', async () => {
    const { correctOvercount } = await import('../src/hygiene.js');
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'one', title: 'one', actor: 'a' });

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
          { _id: project.id },
          { $inc: { 'counts.items': 5 } },
        );
      }
      return result;
    }) as typeof harness.store.items.countDocuments;

    try {
      const repaired = await correctOvercount(harness.store, project.id);
      assert.equal(repaired, false, 'a repair that raced a write must not apply');
      const counts = await harness.store.projects.findOne({ _id: project.id });
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
});
