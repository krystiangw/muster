import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { after, before, describe, it } from 'node:test';
import { authed, createProject, startHarness, type Harness, type Project } from './helper.js';

/**
 * The deployment whose database went away.
 *
 * The service is built to keep answering when the store does not: the landing
 * page still loads for whoever arrives, the protocol still reads, and anything
 * that would touch a board says 503 with a number of seconds on it rather than
 * hanging or answering 500. That promise is the reason the watchdog exists,
 * the reason `/health` deliberately reports readiness before reachability, and
 * the reason `/signup` is exempt in one direction and not the other.
 *
 * None of it had a test. On the free tier this is not a hypothetical: the
 * database can be unreachable for a minute at a time, and the first crowd this
 * service ever sees is the one that arrives on the day it is announced. A path
 * that only runs during an outage is a path nobody has watched run.
 */
describe('when the store is not there', () => {
  let harness: Harness;
  let project: Project;

  before(async () => {
    harness = await startHarness();
    project = await createProject(harness, 'a board that existed before the outage');
  });

  after(async () => {
    await harness.stop();
  });

  /** The outage, and the recovery, around one question. */
  const during = async <T>(ask: () => Promise<T>): Promise<T> => {
    harness.store.ready = { ok: false, why: 'the store is still starting' };
    try {
      return await ask();
    } finally {
      harness.store.ready = { ok: true, why: null };
    }
  };

  it('keeps serving the pages that need nothing', async () => {
    await during(async () => {
      for (const url of ['/', '/pricing', '/docs', '/skill.md', '/llms.txt', '/.well-known/agent-access.json']) {
        const page = await harness.server.inject({ method: 'GET', url });
        assert.equal(page.statusCode, 200, `${url} still answers: ${page.statusCode}`);
      }
    });
  });

  it('reads the signup page and refuses the signup', async () => {
    await during(async () => {
      // The same address in two directions. A form nobody has posted is a page
      // like any other; the post behind it is the write this holds back, and
      // the prefix that matches them both would have taken /pricing with it.
      const form = await harness.server.inject({ method: 'GET', url: '/signup' });
      assert.equal(form.statusCode, 200);

      const posted = await harness.server.inject({
        method: 'POST',
        url: '/p',
        payload: { name: 'somebody arriving mid-outage' },
      });
      assert.equal(posted.statusCode, 503);
      assert.equal(posted.json().error, 'store_unavailable');
      assert.equal(posted.headers['retry-after'], '5');
      assert.equal(posted.json().retry_after, 5);
      // Both halves said out loud: come back, and nothing happened.
      assert.match(posted.json().message, /not ready to serve a board yet/);
      assert.match(posted.json().message, /nothing was written/);
    });
  });

  it('refuses every door a board is behind, and says how long to wait', async () => {
    await during(async () => {
      const doors = [
        { method: 'GET' as const, url: `${project.api}/board` },
        { method: 'POST' as const, url: `${project.api}/items`, payload: { slug: 'x', title: 'x' } },
        { method: 'POST' as const, url: `${project.api}/next`, payload: { agent: 'someone' } },
        { method: 'GET' as const, url: `${project.readUrl.replace('http://muster.test', '')}` },
        { method: 'POST' as const, url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } },
        { method: 'POST' as const, url: '/oauth/register', payload: { client_name: 'x', grant_types: ['client_credentials'] } },
        { method: 'GET' as const, url: '/operator' },
      ];
      for (const door of doors) {
        const answer = await harness.server.inject({
          ...door,
          headers: { ...authed(project), 'content-type': 'application/json' },
        });
        assert.equal(answer.statusCode, 503, `${door.method} ${door.url} said ${answer.statusCode}`);
        assert.equal(answer.headers['retry-after'], '5', `${door.url} says how long`);
      }
    });
  });

  it('says it is not ready on the check a platform reads', async () => {
    await during(async () => {
      const health = await harness.server.inject({ method: 'GET', url: '/health' });
      assert.equal(health.statusCode, 503);
      assert.equal(health.json().ok, false);
      assert.equal(health.json().error, 'store_unavailable');
      assert.equal(health.headers['retry-after'], '5');
    });
  });

  // Bounded, because the request under test is one that must answer and the
  // failure being guarded against is one that does not.
  it('answers a database that went away after it was working, not only one that never came', { timeout: 60_000 }, async () => {
    // The other outage, and the one the free tier actually produces. The gate
    // above is the deployment that has not connected yet; this is the one that
    // had, and lost it. `ready` stays true, the request reaches the driver,
    // and the answer depends entirely on the error handler recognising what
    // came back. The first version of this file tested only the gate, so it
    // would have passed while this hung or answered 500. Codex found that.
    // A database of its own, stopped underneath a server that was using it
    // happily a moment ago. Not the client closed from inside: that raises one
    // error class, and the outage a hosted database produces raises the others,
    // server selection and network, which are a different branch of the same
    // matcher and the ones with a timeout attached.
    const its_own = await MongoMemoryServer.create();
    const lost = await startHarness({ MONGODB_URI: its_own.getUri(), MONGODB_DB: 'gone' });
    try {
      const board = await createProject(lost, 'a board whose database left');
      await its_own.stop();

      for (const door of [
        { method: 'GET' as const, url: `${board.api}/board` },
        { method: 'POST' as const, url: `${board.api}/items`, payload: { slug: 'x', title: 'x' } },
        { method: 'POST' as const, url: '/p', payload: { name: 'arriving mid-outage' } },
      ]) {
        const answer = await lost.server.inject({
          ...door,
          headers: { ...authed(board), 'content-type': 'application/json' },
        });
        assert.equal(answer.statusCode, 503, `${door.method} ${door.url} said ${answer.statusCode}`);
        assert.equal(answer.json().error, 'store_unavailable');
        assert.equal(answer.headers['retry-after'], '5');
        // 5xx is the class this protocol tells a fleet to retry, so the one
        // thing this answer must not do is look like a bug in the service.
        assert.notEqual(answer.json().message, 'Something broke on our side. The request was not applied.');
      }

      // And the pages that need nothing still need nothing.
      const landing = await lost.server.inject({ method: 'GET', url: '/' });
      assert.equal(landing.statusCode, 200);
    } finally {
      // Whatever happened above. A harness left running holds a count on the
      // shared mongod that the outer teardown then waits on, so a failing
      // assertion here used to stop the suite instead of failing it, which is
      // how two deliberate breakages earlier today looked like hangs.
      await lost.stop().catch(() => undefined);
      await its_own.stop().catch(() => undefined);
    }
  });

  it('writes nothing while it refuses, and works the moment the store is back', async () => {
    const before = await harness.store.projects.countDocuments({});
    await during(async () => {
      await harness.server.inject({ method: 'POST', url: '/p', payload: { name: 'refused' } });
      await harness.server.inject({
        method: 'POST',
        url: `${project.api}/items`,
        headers: { ...authed(project), 'content-type': 'application/json' },
        payload: { slug: 'written-during-an-outage', title: 'no' },
      });
    });
    assert.equal(await harness.store.projects.countDocuments({}), before, 'no board was made');
    // By the two fields that name an item, not by a guess at its _id: the
    // first draft of this looked for `${project.id}:written-during-an-outage`,
    // and ids here are `i_` and a random tail, so it passed by asking for
    // something that could never exist whatever the service had done.
    assert.equal(
      await harness.store.items.countDocuments({
        projectId: project.id,
        slug: 'written-during-an-outage',
      }),
      0,
      'and no item',
    );

    // And back, without a restart: the flag is the whole of it.
    const after = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/board`,
      headers: authed(project),
    });
    assert.equal(after.statusCode, 200);
  });
});
