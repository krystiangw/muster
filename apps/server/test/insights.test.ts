import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { runMigrations } from '../src/db.js';
import { flushEvents, insights } from '../src/events.js';
import { authed, createProject, signIn, startHarness, type Harness, type Project } from './helper.js';

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

    await flushEvents();

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

    await flushEvents();

    const report = await insights(harness.store);
    assert.ok(report.doors.mcp >= 1, 'an agent arriving over MCP is not the same as one over curl');

    await flushEvents();

    const written = await harness.store.events.findOne({ kind: 'first_write', projectId: id });
    assert.equal(written?.door, 'mcp');
  });

  it('counts activation once, whatever shape the first item has', async () => {
    const project = await createProject(harness, 'closed on arrival');
    // A first item created as done leaves the open counter at zero, which is
    // what made every later write look like a first.
    await post(project, '/items', { slug: 'a', title: 'a', status: 'done', actor: 'x' });
    await post(project, '/items', { slug: 'b', title: 'b', actor: 'x' });
    await post(project, '/items', { slug: 'c', title: 'c', actor: 'x' });

    await flushEvents();

    const written = await harness.store.events.countDocuments({
      kind: 'first_write',
      projectId: project.id,
    });
    assert.equal(written, 1);

    // And two arriving together still count once.
    const racing = await createProject(harness, 'racing');
    await Promise.all([
      post(racing, '/items', { slug: 'one', title: 'one', actor: 'x' }),
      post(racing, '/items', { slug: 'two', title: 'two', actor: 'x' }),
    ]);
    await flushEvents();
    assert.equal(
      await harness.store.events.countDocuments({ kind: 'first_write', projectId: racing.id }),
      1,
    );
  });

  it('counts projects that got an agent, not agents that got registered', async () => {
    const project = await createProject(harness, 'many loops');
    for (const handle of ['errors-loop', 'trades-loop', 'pm-loop']) {
      await post(project, '/agents', { handle, scope: [] });
    }

    await flushEvents();

    const report = await insights(harness.store);
    await flushEvents();
    const registrations = await harness.store.events.countDocuments({
      kind: 'register',
      projectId: project.id,
    });
    assert.equal(registrations, 3, 'every registration is logged');
    // But a funnel stage counts projects, or it climbs above the stage above it.
    assert.ok(report.funnel.withAnAgent <= report.funnel.signups);
  });

  it('does not log a question the cap refused', async () => {
    const project = await createProject(harness, 'full');
    await harness.store.projects.updateOne(
      { _id: project.id },
      { $set: { 'limits.escalations': 1 } },
    );
    await post(project, '/escalations', { agent: 'a', question: 'first' });
    const refused = await post(project, '/escalations', { agent: 'a', question: 'second' });
    assert.ok(refused.statusCode >= 400);

    await flushEvents();

    assert.equal(
      await harness.store.events.countDocuments({ kind: 'escalate', projectId: project.id }),
      1,
      'a question that was never filed is not a question',
    );
  });

  it('says how many answers its median is taken over', async () => {
    await flushEvents();
    const report = await insights(harness.store);
    assert.equal(typeof report.behaviour.answersSampled, 'number');
    if (report.behaviour.medianAnswerHours !== null) {
      assert.ok(report.behaviour.answersSampled > 0);
    }
  });

  it('does not count a project that predates the marker as newly activated', async () => {
    const project = await createProject(harness, 'from before');
    await post(project, '/items', { slug: 'old', title: 'written long ago', actor: 'x' });
    // The seed's own activation is still in flight, and erasing the state it is
    // about to write is how a regression test starts passing by accident.
    await flushEvents();

    // The state a project deployed before this field was in: it has work, and
    // no marker. Without a backfill its next item records a second activation.
    await harness.store.projects.updateOne({ _id: project.id }, { $unset: { firstWriteAt: '' } });
    await harness.store.events.deleteMany({ kind: 'first_write', projectId: project.id });

    await runMigrations(harness.store);
    await post(project, '/items', { slug: 'new', title: 'written today', actor: 'x' });

    await flushEvents();

    assert.equal(
      await harness.store.events.countDocuments({ kind: 'first_write', projectId: project.id }),
      0,
      'a project activated before the marker existed is not activated again',
    );
    const doc = await harness.store.projects.findOne({ _id: project.id });
    assert.ok(doc?.firstWriteAt, 'and it carries the marker afterwards');
  });

  it('backfills past projects that have no work at all', async () => {
    // The page that never advances: projects with no items never get a marker,
    // so a loop that re-reads the same filter sees them again every pass and
    // never reaches the ones behind them.
    const empty = [];
    for (let index = 0; index < 3; index += 1) {
      empty.push(await createProject(harness, `empty ${index}`));
    }
    const withWork = await createProject(harness, 'has work');
    await post(withWork, '/items', { slug: 'something', title: 'something', actor: 'x' });
    await flushEvents();

    await harness.store.projects.updateMany({}, { $unset: { firstWriteAt: '' } });
    await runMigrations(harness.store);

    const marked = await harness.store.projects.findOne({ _id: withWork.id });
    assert.ok(marked?.firstWriteAt, 'a project with work is marked');
    for (const project of empty) {
      const doc = await harness.store.projects.findOne({ _id: project.id });
      assert.equal(doc?.firstWriteAt, undefined, 'and one without work is left alone');
    }
  });

  it('holds nothing about a person', async () => {
    await harness.server.inject({ method: 'GET', url: '/skill.md' });
    await flushEvents();
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

describe('who owns what', () => {
  it('counts a project accepted from an agent as claimed, like one claimed with a code', async () => {
    const project = await createProject(harness, 'handed over');
    const before = (await insights(harness.store)).funnel.claimed;

    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/share`,
      headers: authed(project),
      payload: { email: 'owner@example.com', agent: 'a' },
    });
    const share = await harness.store.shares.findOne({ projectId: project.id });
    const session = await signIn(harness, 'owner@example.com');
    await harness.server.inject({
      method: 'POST',
      url: `/operator/shares/${share!._id}`,
      payload: session.form({ action: 'accept' }),
      headers: session.headers,
    });
    await flushEvents();

    // The handover is the path our own documentation recommends, so a funnel
    // that counted only the code path understated the thing it measures.
    assert.equal((await insights(harness.store)).funnel.claimed, before + 1);
  });
});

describe('counting the people, not the agents', () => {
  it('records a page view per page, and never the token in the URL', async () => {
    const project = await createProject(harness, 'watched');
    const readToken = project.readUrl.split('/r/')[1]!;

    for (const url of ['/', '/docs', '/pricing', '/', `/r/${readToken}`, `/r/${readToken}/board`]) {
      await harness.server.inject({ method: 'GET', url });
    }
    await flushEvents();

    const numbers = await insights(harness.store);
    assert.equal(numbers.pages.landing, 2, 'two visits to the same page are two views');
    assert.equal(numbers.pages.docs, 1);
    assert.equal(numbers.pages.pricing, 1);
    assert.equal(numbers.pages.project, 1, 'a capability page counts by kind');
    assert.equal(numbers.pages.board, 1);
    assert.ok(numbers.pagesLastWeek >= 6);

    // The reason the page set is closed rather than the request path: a read
    // link is a credential that lives in the path, and this collection is
    // built to hold no secrets at all.
    const recorded = await harness.store.events.find({ kind: 'view' }).toArray();
    for (const event of recorded) {
      assert.doesNotMatch(String(event.detail), /r_/, 'no token reaches the log');
      assert.equal(event.projectId, null, 'and no page view is attributed to a project');
    }
  });

  it('counts a page only when somebody was shown one', async () => {
    const project = await createProject(harness, 'guarded');
    const readToken = project.readUrl.split('/r/')[1]!;
    const before = await insights(harness.store);

    // A stale bookmark and a token probe both end in a 404. Nobody read a page.
    await harness.server.inject({ method: 'GET', url: '/r/r_does_not_exist' });
    await harness.server.inject({ method: 'GET', url: '/r/r_does_not_exist/board' });
    // Fastify answers HEAD from the same handler, and a HEAD carries no body.
    await harness.server.inject({ method: 'HEAD', url: '/' });
    await harness.server.inject({ method: 'HEAD', url: `/r/${readToken}` });
    await flushEvents();

    const quiet = await insights(harness.store);
    assert.equal(quiet.pages.project ?? 0, before.pages.project ?? 0, 'a 404 is not a view');
    assert.equal(quiet.pages.board ?? 0, before.pages.board ?? 0);
    assert.equal(quiet.pages.landing ?? 0, before.pages.landing ?? 0, 'and neither is a HEAD');

    await harness.server.inject({ method: 'GET', url: `/r/${readToken}` });
    await flushEvents();
    assert.equal((await insights(harness.store)).pages.project ?? 0, (before.pages.project ?? 0) + 1);
  });

  it('does not count a crawler as a person', async () => {
    const before = (await insights(harness.store)).pages.signup ?? 0;
    for (const ua of ['Googlebot/2.1 (+http://www.google.com/bot.html)', 'curl/8.4.0', 'Bingbot']) {
      await harness.server.inject({ method: 'GET', url: '/signup', headers: { 'user-agent': ua } });
    }
    await flushEvents();
    assert.equal((await insights(harness.store)).pages.signup ?? 0, before, 'still nobody');

    await harness.server.inject({
      method: 'GET',
      url: '/signup',
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15' },
    });
    await flushEvents();
    assert.equal((await insights(harness.store)).pages.signup ?? 0, before + 1);
  });
});
