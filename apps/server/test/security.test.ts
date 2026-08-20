import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { redactCapabilities } from '../src/app.js';
import { connectStore, ensureIndexes } from '../src/db.js';
import { ServiceError, revokeApiKey } from '../src/service.js';
import { hashToken } from '../src/ids.js';
import {
  authed,
  createProject,
  signIn,
  startHarness,
  type Harness,
  type Project,
} from './helper.js';

/**
 * Regressions for the security audit of 2026-08-17. Each one is a hole that was
 * open on the deployed instance, and every fix below was checked against the
 * request that exploited it.
 */

let harness: Harness;

before(async () => {
  // A replica set, because revoking an admin key is judged inside a
  // transaction and a standalone will not start one.
  harness = await startHarness({ LIMIT_CLAIM_EMAILS_PER_HOUR: '100' }, {}, { replicaSet: true });
});

after(async () => {
  await harness.stop();
});

async function post(project: Project, path: string, payload: unknown, token?: string) {
  return harness.server.inject({
    method: 'POST',
    url: `${project.api}${path}`,
    headers: token ? { authorization: `Bearer ${token}` } : authed(project),
    payload: payload as Record<string, unknown>,
  });
}

async function claimForEmail(project: Project, email: string): Promise<void> {
  await post(project, '/claim', { email });
  const pending = await harness.store.claimCodes.findOne({ projectId: project.id, email });
  await harness.store.claimCodes.updateOne(
    { _id: pending!._id },
    { $set: { codeHash: hashToken('123456') } },
  );
  await post(project, '/claim/verify', { email, code: '123456' });
}

describe('ownership is not something a worker key can take', () => {
  it('refuses the claim endpoints to a write key', async () => {
    const project = await createProject(harness);
    const worker = (await post(project, '/keys', { name: 'worker', role: 'write' })).json().token;

    const started = await post(project, '/claim', { email: 'attacker@example.com' }, worker);
    assert.equal(started.statusCode, 403, 'a delegated worker credential cannot bind the tenant');

    const verified = await post(
      project,
      '/claim/verify',
      { email: 'attacker@example.com', code: '123456' },
      worker,
    );
    assert.equal(verified.statusCode, 403);

    assert.equal(await harness.store.claimCodes.countDocuments({ projectId: project.id }), 0);
  });

  it('refuses a pending code that outlived somebody else taking the project', async () => {
    const project = await createProject(harness);
    const plant = async (email: string) => {
      await post(project, '/claim', { email });
      const pending = await harness.store.claimCodes.findOne({ projectId: project.id, email });
      await harness.store.claimCodes.updateOne(
        { _id: pending!._id },
        { $set: { codeHash: hashToken('123456') } },
      );
    };

    // Both claims start while the project is unowned, which is allowed: it has
    // no owner to protect yet.
    await plant('attacker@example.com');
    await plant('first@example.com');

    // Redeemed at the same instant, so both get past the "is it owned yet"
    // check and the ownership write itself is the only thing standing between
    // them. It used to be an unguarded $set, which meant the later one simply
    // took a project the earlier one had just been given.
    const [one, two] = await Promise.all([
      post(project, '/claim/verify', { email: 'first@example.com', code: '123456' }),
      post(project, '/claim/verify', { email: 'attacker@example.com', code: '123456' }),
    ]);

    const won = [one, two].filter((response) => response.statusCode === 200);
    assert.equal(won.length, 1, 'exactly one of them owns it');

    const doc = await harness.store.projects.findOne({ _id: project.id });
    assert.ok(['first@example.com', 'attacker@example.com'].includes(doc!.claimedBy!));
    // The response names the owner in the redacted form the API always uses:
    // an agent needs to know whether the board has one and whether that
    // changed, and has no business holding somebody's address.
    const said = (won[0]!.json() as { project: { claimed_by?: string } }).project.claimed_by;
    assert.equal(said, `${doc!.claimedBy!.slice(0, 2)}***@example.com`);
  });

  it('refuses to start a claim on a project that already has an owner', async () => {
    const project = await createProject(harness);
    await post(project, '/claim', { email: 'first@example.com' });
    const pending = await harness.store.claimCodes.findOne({ projectId: project.id });
    await harness.store.claimCodes.updateOne(
      { _id: pending!._id },
      { $set: { codeHash: hashToken('123456') } },
    );
    await post(project, '/claim/verify', { email: 'first@example.com', code: '123456' });

    const second = await post(project, '/claim', { email: 'attacker@example.com' });
    assert.equal(second.json().already_claimed_by, 'first@example.com');
    assert.equal(
      await harness.store.claimCodes.countDocuments({ projectId: project.id }),
      0,
      'and no code is sent that could be redeemed later',
    );
  });
});

describe('one request is one request', () => {
  it('refuses an MCP batch big enough to be an amplifier', async () => {
    const project = await createProject(harness);
    const batch = Array.from({ length: 200 }, (_, index) => ({
      jsonrpc: '2.0',
      id: index,
      method: 'tools/call',
      params: { name: 'list_items', arguments: {} },
    }));

    const response = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: authed(project),
      payload: batch,
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error.message, /at most 25/);
  });

  it('charges every tool call against the published limit, not every HTTP request', async () => {
    const isolated = await startHarness({ LIMIT_WRITES_PER_MINUTE: '3' });
    try {
      const project = await createProject(isolated);
      const call = (index: number) => ({
        jsonrpc: '2.0',
        id: index,
        method: 'tools/call',
        params: {
          name: 'upsert_item',
          arguments: { slug: `batched-${index}`, title: 'x', actor: 'a' },
        },
      });

      const response = await isolated.server.inject({
        method: 'POST',
        url: '/mcp',
        headers: authed(project),
        payload: [call(1), call(2), call(3), call(4), call(5)],
      });
      const results = response.json() as Array<{ result?: { isError?: boolean } }>;
      const refused = results.filter((entry) => entry.result?.isError).length;
      assert.ok(refused >= 2, `a batch past the limit is refused per call, refused=${refused}`);

      // And the writes that were refused did not land.
      assert.ok((await isolated.store.items.countDocuments({ projectId: project.id })) <= 3);
    } finally {
      await isolated.stop();
    }
  });
});

describe('what the service tells a stranger about its users', () => {
  it('does not confirm whether an address is one of them', async () => {
    const anchor = await createProject(harness, 'anchor');
    await post(anchor, '/claim', { email: 'real@example.com' });
    const pending = await harness.store.claimCodes.findOne({ projectId: anchor.id });
    await harness.store.claimCodes.updateOne(
      { _id: pending!._id },
      { $set: { codeHash: hashToken('123456') } },
    );
    await post(anchor, '/claim/verify', { email: 'real@example.com', code: '123456' });

    const known = await post(await createProject(harness, 'a'), '/share', {
      email: 'real@example.com',
      agent: 'probe',
    });
    const unknown = await post(await createProject(harness, 'b'), '/share', {
      email: 'never-seen@example.com',
      agent: 'probe',
    });

    assert.equal(known.statusCode, unknown.statusCode);
    assert.equal(known.json().hint, unknown.json().hint);
    assert.deepEqual(Object.keys(known.json()).sort(), Object.keys(unknown.json()).sort());
  });
});

describe('capability links', () => {
  it('never reach the log with their token intact', () => {
    assert.equal(
      redactCapabilities('/r/r_894fh39x02kvay11/board?agent=errors-loop'),
      '/r/[redacted]/board?agent=errors-loop',
    );
    assert.equal(
      redactCapabilities('/operator/mk_live_token/shares/s_1'),
      '/operator/[redacted]/shares/s_1',
    );
    assert.equal(redactCapabilities('/v1/p_public/items'), '/v1/p_public/items');
  });

  it('can be replaced when one leaks', async () => {
    const project = await createProject(harness);
    const before = project.readUrl.split('/r/')[1]!;

    const rotated = await post(project, '/read-link/rotate', {});
    assert.equal(rotated.statusCode, 200);
    const after = (rotated.json().read_url as string).split('/r/')[1]!;
    assert.notEqual(after, before);

    const old = await harness.server.inject({ method: 'GET', url: `/r/${before}/board` });
    assert.equal(old.statusCode, 404, 'the leaked link is dead');
    const fresh = await harness.server.inject({ method: 'GET', url: `/r/${after}/board` });
    assert.equal(fresh.statusCode, 200);
  });

  it('needs an admin key to rotate', async () => {
    const project = await createProject(harness);
    const worker = (await post(project, '/keys', { name: 'worker', role: 'write' })).json().token;
    const attempt = await post(project, '/read-link/rotate', {}, worker);
    assert.equal(attempt.statusCode, 403);
  });
});

describe('the response headers', () => {
  it('carry a policy that allows this service and nothing else to execute', async () => {
    const page = await harness.server.inject({ method: 'GET', url: '/docs' });
    const csp = page.headers['content-security-policy'] as string;
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/, 'those pages carry one click forms');
    // One source and no keywords. The board has a script now, for dragging a
    // card into a column, and it is a file this service serves under a name
    // that is the hash of what is in it. `'self'` is the narrowest thing that
    // can say so: no inline, no eval, no other origin, so a string that
    // reached a page could still not run.
    const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1]?.trim();
    assert.equal(scriptSrc, "'self'", 'one source, no keywords');
    // Styles have carried `unsafe-inline` since before this, which is a
    // different question and a much smaller one: a style cannot call anything.
    assert.match(csp, /style-src 'self' 'unsafe-inline'/);
    // Not `no-referrer`, on purpose and load bearing: under it a browser posts
    // our own forms with `Origin: null`, and the same-site check refused every
    // one of them. `same-origin` strips the header on everything that leaves
    // this service, which is the leak the policy is here for.
    assert.equal(page.headers['referrer-policy'], 'same-origin', 'the token lives in the path');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
  });

  it('keep a capability page out of shared caches, and out of the index', async () => {
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(page.headers['cache-control'] as string, /no-store/);
    // A read link ends up pasted somewhere public eventually, and a crawler
    // that finds one there would put the board in a search index, where the
    // repair is not rotating the link but asking a search engine to forget.
    assert.match(page.headers['x-robots-tag'] as string, /noindex/);

    // And the pages that are meant to be found still are.
    const landing = await harness.server.inject({ method: 'GET', url: '/' });
    assert.equal(landing.headers['x-robots-tag'], undefined);
  });
});

describe('an email that cannot be sent', () => {
  it('is discarded rather than written to the log in production', async () => {
    const lines: string[] = [];
    const isolated = await startHarness({ NODE_ENV: 'production', RESEND_API_KEY: '' });
    try {
      isolated.server.log.info = ((message: unknown) => {
        lines.push(typeof message === 'string' ? message : JSON.stringify(message));
      }) as typeof isolated.server.log.info;

      const project = await createProject(isolated);
      await isolated.server.inject({
        method: 'POST',
        url: `${project.api}/claim`,
        headers: authed(project),
        payload: { email: 'victim@example.com' },
      });

      const printed = lines.join('\n');
      assert.ok(!/\b\d{6}\b/.test(printed), 'the six digit code is not in the log');
      assert.ok(!printed.includes('victim@example.com'), 'nor the whole address');
    } finally {
      await isolated.stop();
    }
  });

  it('is reported as a fault rather than answered with a cheerful ok', async () => {
    const isolated = await startHarness({ NODE_ENV: 'production', RESEND_API_KEY: '' });
    try {
      const project = await createProject(isolated);
      const claimed = await isolated.server.inject({
        method: 'POST',
        url: `${project.api}/claim`,
        headers: authed(project),
        payload: { email: 'victim@example.com' },
      });

      // The code reached nobody. Answering ok would send an agent off to wait
      // for something that is never coming.
      assert.equal(claimed.statusCode, 503);
      assert.equal(claimed.json().error, 'mail_not_configured');
      assert.equal(
        await isolated.store.claimCodes.countDocuments({ projectId: project.id }),
        0,
        'and nothing is left pending',
      );

      // Same for the human door, and the answer does not depend on the address,
      // so it stays no kind of account probe.
      const asked = await isolated.server.inject({
        method: 'POST',
        url: '/operator',
        payload: 'email=someone%40example.com',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      assert.equal(asked.statusCode, 503);
      assert.match(asked.body, /cannot send email/i);
    } finally {
      await isolated.stop();
    }
  });
});

describe('what the link says about itself', () => {
  /**
   * The mail that sends somebody here calls the link a password. The page they
   * land on used to say nothing at all, and the first person to arrive on a
   * phone read "answer these questions, no sign in" as a hole rather than as
   * the feature it is. On that screen a share sheet is one tap away.
   */
  it('says in the docs what a read link is, and how to kill one', async () => {
    // The page says it to whoever is holding one. The docs have to say it to
    // whoever is about to hand one over, which is a different person and an
    // earlier moment.
    const docs = await harness.server.inject({ method: 'GET', url: '/docs' });
    assert.equal(docs.statusCode, 200);
    assert.match(docs.body, /the token is in it/);
    assert.match(docs.body, /password rather than a bookmark/);
    assert.match(docs.body, /read-link\/rotate/);
    // Every power it grants, not the three that came to mind: a warning that
    // undersells the authority is worse than none, because it is believed. The
    // list is one exported sentence for that reason, so the three documents
    // that carry it cannot drift apart again; this checks all three.
    for (const power of [
      /answers the questions/,
      /files work of their own/,
      /writes notes onto the timeline/,
      /corrects the words on a card/,
      /sets\s+urgency, owners and labels/,
      /moves cards/,
      /consolidates two spellings/,
      /replaces the\s+layout/,
    ]) {
      assert.match(docs.body, power, String(power));
    }

    for (const [url, what] of [
      ['/skill.md', 'the protocol an agent reads on the way in'],
      ['/openapi.json', 'the route that rotates the link'],
      ['/.well-known/agent-access.json', 'the card an agent discovers this by'],
    ] as const) {
      const published = await harness.server.inject({ method: 'GET', url });
      assert.match(published.body, /files work of their own/, what);
      assert.match(published.body, /consolidates two spellings/, what);
    }
    // And it is true only while the board is open by link, which is the state
    // the sentence is about.
    assert.match(docs.body, /Narrowing the project to its owner ends all of that/);
  });

  it('tells the reader what the address in their hand can do', async () => {
    const project = await createProject(harness, 'open by link');
    const readToken = project.readUrl.split('/r/')[1]!;
    await claimForEmail(project, 'owner@example.com');

    const open = await harness.server.inject({ method: 'GET', url: `/r/${readToken}` });
    assert.equal(open.statusCode, 200);
    assert.match(open.body, /Open by link/);
    assert.match(
      open.body,
      /anybody who has this address reads the board, answers the questions[\s\S]*consolidates two spellings/,
      'and what it can do is what it can do today, not what it could do the day it was written',
    );

    // And the opposite state says the opposite thing, because "private" is
    // worth reading too when the whole question is who can open this.
    await harness.server.inject({
      method: 'PATCH',
      url: project.api,
      headers: authed(project),
      payload: { visibility: 'owner' },
    });
    const session = await signIn(harness, 'owner@example.com');
    const closed = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}`,
      headers: { cookie: session.cookie },
    });
    assert.equal(closed.statusCode, 200);
    assert.match(closed.body, /Private: this page opens only for its owner/);
    assert.doesNotMatch(closed.body, /Open by link/);
  });
});

describe('a project narrowed to its owner', () => {
  it('stops opening for the link alone, and still opens for the owner', async () => {
    const project = await createProject(harness, 'private');
    const readToken = project.readUrl.split('/r/')[1]!;

    // Open by link is the default, and has to be: an agent creates a project
    // before any person is involved.
    assert.equal(
      (await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` })).statusCode,
      200,
    );

    await claimForEmail(project, 'owner@example.com');
    const closed = await harness.server.inject({
      method: 'PATCH',
      url: project.api,
      headers: authed(project),
      payload: { visibility: 'owner' },
    });
    assert.equal(closed.statusCode, 200);
    assert.equal(closed.json().visibility, 'owner');

    // A stranger holding the link, including one who copied it while the
    // project was open, gets the same page as somebody holding a wrong link.
    // Byte for byte: a longer body for the real token would answer, for anybody
    // willing to guess, the one question this feature exists to refuse.
    const stranger = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.equal(stranger.statusCode, 404);
    const wrongLink = await harness.server.inject({ method: 'GET', url: '/r/r_nosuchtoken/board' });
    assert.equal(stranger.statusCode, wrongLink.statusCode);
    assert.equal(stranger.body, wrongLink.body);

    // Writing through the link is what the link is for, so that closes too.
    const moved = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/move`,
      payload: 'slug=whatever&column=done',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(moved.statusCode, 404);

    const session = await signIn(harness, 'owner@example.com');
    const mine = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board`,
      headers: { cookie: session.cookie },
    });
    assert.equal(mine.statusCode, 200);

    // Somebody else's session is not a way in either.
    const other = await createProject(harness, 'anchor');
    await claimForEmail(other, 'other@example.com');
    const otherSession = await signIn(harness, 'other@example.com');
    const theirs = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board`,
      headers: { cookie: otherSession.cookie },
    });
    assert.equal(theirs.statusCode, 404);

    // And the agent that works the board never notices any of this.
    const agent = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/board`,
      headers: authed(project),
    });
    assert.equal(agent.statusCode, 200);
  });

  it('refuses to close a project that nobody owns', async () => {
    const project = await createProject(harness, 'ownerless');
    const attempt = await harness.server.inject({
      method: 'PATCH',
      url: project.api,
      headers: authed(project),
      payload: { visibility: 'owner' },
    });
    // Closing it to an owner it does not have would lock out everybody,
    // including the agent that just created it.
    assert.equal(attempt.statusCode, 400);
    assert.equal(attempt.json().error, 'not_claimed');
  });
});

describe('starting up against a database that has already run', () => {
  it('survives an index whose definition changed under it', async () => {
    // Mongo refuses to redefine an index that exists under the same name with
    // different options, and it refuses by throwing, which on the boot path is
    // an instance that never starts. A one word change (a plain index becoming
    // unique) would otherwise take down every deploy after it.
    await harness.store.operatorCodes.dropIndex('email').catch(() => undefined);
    await harness.store.operatorCodes.createIndexes([{ key: { email: 1 }, name: 'email' }]);

    await ensureIndexes(harness.store);

    const indexes = await harness.store.operatorCodes.indexes();
    const email = indexes.find((index) => index.name === 'email');
    assert.equal(email?.unique, true, 'and it ends up with the definition the code asked for');
  });

  it('calls a signed in reader by name on every page, not only the one that remembered', async () => {
    // Reported from a browser: signed in, click through to another page, and
    // the nav offers to sign you in. Only the operator page passed the flag, so
    // every other page told the same person they were a stranger.
    // The list is the reason it came back: passing the flag was one more thing
    // a page could forget, and the pages added after the first fix forgot it.
    // A read link told its signed in reader to sign in on the same screen that
    // addressed them by their email. Rendering goes through one helper that
    // takes the request now, so this list is a check rather than the fix.
    const session = await signIn(harness, 'nav@example.com');
    const project = await createProject(harness, 'nav project');
    const readToken = project.readUrl.split('/r/')[1]!;
    for (const url of [
      '/',
      '/docs',
      '/pricing',
      '/signup',
      '/docs/keys',
      `/r/${readToken}`,
      `/r/${readToken}/board`,
      '/nothing-lives-here',
    ]) {
      // As a browser asks, which is what decides that the 404 is a page at all.
      const anonymous = await harness.server.inject({
        method: 'GET',
        url,
        headers: { accept: 'text/html' },
      });
      assert.match(anonymous.body, /<a href="\/operator">sign in<\/a>/, `${url} for a stranger`);

      const known = await harness.server.inject({
        method: 'GET',
        url,
        headers: { accept: 'text/html', cookie: session.cookie },
      });
      assert.match(
        known.body,
        /<a href="\/operator">your projects<\/a>/,
        `${url} for somebody signed in`,
      );
    }
  });

  it('tells a cache that every page depends on the cookie, and on the encoding', async () => {
    // The navigation is drawn from the session now, which makes every page this
    // service renders a page a shared cache must not hand to the next reader.
    // Both hooks have something to say about `vary`, and setting it replaces:
    // whichever ran last used to be the only thing a cache was told.
    const plain = await harness.server.inject({
      method: 'GET',
      url: '/pricing',
      headers: { accept: 'text/html' },
    });
    assert.match(String(plain.headers.vary ?? ''), /cookie/i);

    const zipped = await harness.server.inject({
      method: 'GET',
      url: '/pricing',
      headers: { accept: 'text/html', 'accept-encoding': 'gzip' },
    });
    const vary = String(zipped.headers.vary ?? '');
    assert.match(vary, /cookie/i, 'the session it was drawn for');
    assert.match(vary, /accept-encoding/i, 'and the bytes it was drawn as');

    // A JSON answer is nobody's page and says nothing about cookies.
    const json = await harness.server.inject({ method: 'GET', url: '/openapi.json' });
    assert.ok(!/cookie/i.test(String(json.headers.vary ?? '')), 'not the API');
  });

  it('opens a connection for a report without building anything', async () => {
    // The report the operator runs against production says in its own header
    // that it never writes. It reached for the same constructor the server
    // uses, which builds every index and runs every migration on the way in:
    // a promise nobody could rely on, and a command that fails outright on a
    // connection that is only allowed to read.
    const store = await connectStore(harness.config.mongoUri, 'never-touched-by-a-report');
    try {
      const indexes = await store.items.indexes().catch(() => []);
      assert.deepEqual(indexes, [], 'a database nothing has written to stays that way');
      const collections = await store.db.listCollections().toArray();
      assert.deepEqual(collections, []);
    } finally {
      await store.close();
    }
  });

  it('replaces the index that changed and leaves the unique one alone', async () => {
    // The repair used to drop every index named in the same list before
    // rebuilding them, which takes the unique slug index with it. On a
    // deployment still serving requests, one upsert inside that window writes
    // the duplicate that makes the rebuild fail, and then the process never
    // finishes booting.
    const project = await createProject(harness, 'indexes');
    await harness.store.items.dropIndex('recent').catch(() => undefined);
    await harness.store.items.createIndexes([{ key: { projectId: 1, updatedAt: -1 }, name: 'recent' }]);

    const dropped: string[] = [];
    const realDrop = harness.store.items.dropIndex.bind(harness.store.items);
    (harness.store.items as { dropIndex: typeof realDrop }).dropIndex = (async (name: string) => {
      dropped.push(name);
      return realDrop(name);
    }) as typeof realDrop;
    try {
      await ensureIndexes(harness.store);
    } finally {
      (harness.store.items as { dropIndex: typeof realDrop }).dropIndex = realDrop;
    }

    assert.deepEqual(dropped, ['recent'], 'only the one whose definition changed');
    const indexes = await harness.store.items.indexes();
    assert.equal(indexes.find((index) => index.name === 'slug')?.unique, true);
    assert.deepEqual(indexes.find((index) => index.name === 'recent')?.key, {
      projectId: 1,
      updatedAt: -1,
      _id: -1,
    });

    // And the unique index still refuses what it is for.
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'one', title: 'one', actor: 'a' },
    });
    assert.equal(
      await harness.store.items.countDocuments({ projectId: project.id, slug: 'one' }),
      1,
    );
  });
});

/**
 * The decision audit of 2026-08-18, which asked whether the read link should be
 * enough to take a project and answered no. Ownership is a door that opens one
 * way: nothing in this service ever sets `claimedBy` back to null, and an owner
 * mints admin keys at will, so a forwarded link that could take a board would
 * turn a paste into a permanent loss. What the link gets instead is the ability
 * to ask.
 */
describe('a read link can ask for a project and never take one', () => {
  it('refuses to claim without the project token, whatever else it carries', async () => {
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;

    const ask = (payload: string) =>
      harness.server.inject({
        method: 'POST',
        url: `/r/${readToken}/claim`,
        payload,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

    // No token at all, a wrong one, and a real token for another project. The
    // page answers each of them identically, and none of them mints a code.
    const other = await createProject(harness, 'somebody else');
    for (const payload of [
      'email=passerby@example.com',
      'email=passerby@example.com&token=mk_not_a_real_token',
      `email=passerby@example.com&token=${other.token}`,
    ]) {
      const attempt = await ask(payload);
      assert.equal(attempt.statusCode, 200, payload);
      assert.match(attempt.body, /Claim failed/, payload);
      assert.equal(
        await harness.store.claimCodes.countDocuments({ projectId: project.id }),
        0,
        `no code was minted for: ${payload}`,
      );
    }

    // A worker key for this project is refused too: it can write to the board,
    // and ownership is not a write.
    const worker = (await post(project, '/keys', { name: 'worker', role: 'write' })).json().token;
    const withWorker = await ask(`email=passerby@example.com&token=${worker}`);
    assert.match(withWorker.body, /Claim failed/);
    assert.equal(await harness.store.claimCodes.countDocuments({ projectId: project.id }), 0);

    // And the admin token does work, so the test above is measuring the guard
    // rather than a route that is broken for everybody.
    const withAdmin = await ask(`email=passerby@example.com&token=${project.token}`);
    assert.match(withAdmin.body, /Check your email/);
    assert.equal(await harness.store.claimCodes.countDocuments({ projectId: project.id }), 1);

    const after = await harness.store.projects.findOne({ _id: project.id });
    assert.equal(after?.claimedBy ?? null, null, 'and a code is not ownership either');
  });

  it('records the ask, and only the ask, for somebody signed in', async () => {
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    const session = await signIn(harness, 'operator@example.com');

    const asked = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/handover`,
      payload: session.form({ note: 'I run this fleet' }),
      headers: session.headers,
    });
    assert.equal(asked.statusCode, 303);

    const requests = await harness.store.handovers.find({ projectId: project.id }).toArray();
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.email, 'operator@example.com');
    const after = await harness.store.projects.findOne({ _id: project.id });
    assert.equal(after?.claimedBy ?? null, null, 'asking is not taking');

    // Asking twice is the same ask.
    await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/handover`,
      payload: session.form({ note: 'still me' }),
      headers: session.headers,
    });
    assert.equal(await harness.store.handovers.countDocuments({ projectId: project.id }), 1);
  });

  it('refuses the ask without a session, and without a csrf token', async () => {
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;

    const anonymous = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/handover`,
      payload: 'note=hello',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(anonymous.statusCode, 200, 'it explains how to sign in');
    assert.equal(await harness.store.handovers.countDocuments({ projectId: project.id }), 0);

    // A cookie is ambient authority, so the form has to prove it came from us.
    const session = await signIn(harness, 'someone@example.com');
    const forged = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/handover`,
      payload: 'note=from+another+site',
      headers: session.headers,
    });
    assert.equal(forged.statusCode, 403);
    assert.equal(await harness.store.handovers.countDocuments({ projectId: project.id }), 0);
  });

  it('closes the loop: ask, the agent offers, one click owns it', async () => {
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    const session = await signIn(harness, 'owner@example.com');
    await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/handover`,
      payload: session.form({ note: 'mine please' }),
      headers: session.headers,
    });

    // The agent sees it where it looks for everything else, through both doors:
    // an interface that hides the request is one the handover cannot finish in.
    const inbox = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/inbox`,
      headers: authed(project),
    });
    assert.equal(inbox.json().handover_requests[0].email, 'owner@example.com');

    const overMcp = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: authed(project),
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'inbox', arguments: {} },
      },
    });
    assert.equal(
      overMcp.json().result.structuredContent.handover_requests[0].email,
      'owner@example.com',
    );

    // And answers with the offer, which is the only thing that moves ownership.
    const offered = await post(project, '/share', { email: 'owner@example.com' });
    assert.equal(offered.statusCode, 201);
    assert.equal(
      await harness.store.handovers.countDocuments({ projectId: project.id }),
      0,
      'answering the request closes it',
    );

    const share = await harness.store.shares.findOne({ projectId: project.id });
    const accepted = await harness.server.inject({
      method: 'POST',
      url: `/operator/shares/${share!._id}`,
      payload: session.form({}),
      headers: session.headers,
    });
    assert.ok([200, 303].includes(accepted.statusCode), `accept answered ${accepted.statusCode}`);
    const owned = await harness.store.projects.findOne({ _id: project.id });
    assert.equal(owned?.claimedBy, 'owner@example.com');
  });

  it('refuses to offer the project from a worker key, over HTTP and over MCP', async () => {
    // Offering it to an address the holder controls, then accepting, is
    // claiming the project in two steps. The claim endpoints have always
    // refused a write key; this one used to take any key at all.
    const project = await createProject(harness);
    const worker = (await post(project, '/keys', { name: 'worker', role: 'write' })).json().token;

    const overHttp = await post(project, '/share', { email: 'attacker@example.com' }, worker);
    assert.equal(overHttp.statusCode, 403);

    const overMcp = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${worker}` },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'share_project', arguments: { email: 'attacker@example.com' } },
      },
    });
    assert.equal(overMcp.json().result.isError, true);
    assert.equal(await harness.store.shares.countDocuments({ projectId: project.id }), 0);
  });

  it('refuses a write posted from another site, and lets curl through', async () => {
    // The routes under /r/ are authorised by the token in the path, so for an
    // ordinary project this adds nothing. For a project narrowed to its owner
    // the link alone no longer opens it and the session cookie does, which is
    // exactly when a cross site form post is worth something to an attacker.
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });

    const fromElsewhere = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/owner`,
      payload: 'slug=work&owner=attacker',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://not-us.example',
      },
    });
    assert.equal(fromElsewhere.statusCode, 403);
    const untouched = await harness.store.items.findOne({ projectId: project.id, slug: 'work' });
    assert.equal(untouched?.owner ?? null, null);

    // A spelling of our own origin that a browser would canonicalise is still
    // our own origin: comparing the strings would answer 403 to every form on
    // a deployment whose BASE_URL carries a default port or a capital letter.
    const canonical = new URL(harness.config.baseUrl);
    const shouted = `${canonical.protocol}//${canonical.host.toUpperCase()}${
      canonical.protocol === 'https:' ? ':443' : ':80'
    }`;
    const fromUsShouting = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/owner`,
      payload: 'slug=work&owner=alex',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: shouted,
      },
    });
    assert.equal(fromUsShouting.statusCode, 303, shouted);

    // Our own page still works, and so does a caller that sends no Origin at
    // all, which is every agent using curl.
    const fromUs = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/owner`,
      payload: 'slug=work&owner=alex',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: harness.config.baseUrl,
      },
    });
    assert.equal(fromUs.statusCode, 303);
    const assigned = await harness.store.items.findOne({ projectId: project.id, slug: 'work' });
    assert.equal(assigned?.owner, 'alex');
  });

  it('takes our own form when the referrer policy blanks out the Origin', async () => {
    // What a browser actually sent all night: our pages ship a referrer policy,
    // Fetch turns `Origin` into `null` under a strict one, and a check that
    // only reads `Origin` cannot tell our own page from a stranger's. It has to
    // read `Sec-Fetch-Site`, which no policy of ours can blank out.
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });

    const fromOurPage = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/owner`,
      payload: 'slug=work&owner=alex',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'null',
        'sec-fetch-site': 'same-origin',
      },
    });
    assert.equal(fromOurPage.statusCode, 303);
    const assigned = await harness.store.items.findOne({ projectId: project.id, slug: 'work' });
    assert.equal(assigned?.owner, 'alex');

    // And the same blanked out Origin from somewhere else is still refused, so
    // the repair did not buy the forms back by giving up the check.
    const fromElsewhere = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/owner`,
      payload: 'slug=work&owner=attacker',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'null',
        'sec-fetch-site': 'cross-site',
      },
    });
    assert.equal(fromElsewhere.statusCode, 403);
    const untouched = await harness.store.items.findOne({ projectId: project.id, slug: 'work' });
    assert.equal(untouched?.owner, 'alex');

    // A neighbouring host is not this page either: `board.example.com` reaching
    // `musterboard.dev` is a cross site post wearing a familiar domain.
    const fromNeighbour = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/owner`,
      payload: 'slug=work&owner=neighbour',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'null',
        'sec-fetch-site': 'same-site',
      },
    });
    assert.equal(fromNeighbour.statusCode, 403);
  });

  it('will not take an ask for a project that already has an owner', async () => {
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    await claimForEmail(project, 'first@example.com');

    const session = await signIn(harness, 'second@example.com');
    const asked = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/handover`,
      payload: session.form({}),
      headers: session.headers,
    });
    assert.equal(asked.statusCode, 409);
    assert.equal(await harness.store.handovers.countDocuments({ projectId: project.id }), 0);
  });
});

/**
 * The check that the case by case tests cannot make: not "does this refusal
 * refuse the right things", but "can a person submit the forms we serve".
 *
 * The 403 that started this was two correct headers cancelling out, and it was
 * invisible to a suite that posted the way curl does. So this one posts the way
 * a browser does, to every form the pages actually render, and it finds the next
 * such pair without anybody having to think of it.
 */
describe('a form that says two things', () => {
  it('is refused rather than half applied', async () => {
    // A form-encoded body repeating a field parses into an array, and every
    // handler behind these pages was written for the string a browser sends:
    // one `slug` twice answered 500, and the ones that survived did so by
    // joining two values with a comma and acting on the result. No form this
    // service renders repeats a field.
    const project = await createProject(harness, 'two things');
    const readToken = project.readUrl.split('/r/')[1]!;
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });

    for (const [where, payload] of [
      ['/board/note', 'slug=work&slug=other&message=hi'],
      ['/board/move', 'slug=work&column=doing&column=blocked'],
      ['/board/priority', 'slug=work&priority=5&priority=-3'],
    ] as const) {
      const refused = await harness.server.inject({
        method: 'POST',
        url: `/r/${readToken}${where}`,
        payload,
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      });
      assert.equal(refused.statusCode, 400, where);
      assert.match(refused.body, /said two things/, where);
    }

    // A media type is case insensitive, and Fastify parses this as a form body
    // just the same: a guard that reads the header literally has a spelling
    // for a key.
    const shouted = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/note`,
      payload: 'slug=work&slug=other&message=hi',
      headers: { 'content-type': 'Application/X-Www-Form-Urlencoded', accept: 'text/html' },
    });
    assert.equal(shouted.statusCode, 400);

    // Nothing was written by any of them, and the ordinary form still is.
    const untouched = await harness.store.items.findOne({ projectId: project.id, slug: 'work' });
    assert.equal(untouched?.timelineCount ?? 0, 1, 'the filing entry and nothing else');

    const fine = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/note`,
      payload: 'slug=work&message=a+real+note',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(fine.statusCode, 303);
  });
});

describe('the shape a screen reader is handed', () => {
  /**
   * The report ends its accessibility section with ten items it says a machine
   * cannot check, and nobody checked them. Three of them turned out to be
   * checkable after all, and two of the three were wrong on the page a person
   * actually uses. This walks the rendered HTML rather than the stylesheet: the
   * outline, the header cells, and the one control that is deliberately
   * invisible until it is not.
   */
  const headingsIn = (html: string): { level: number; text: string }[] =>
    [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({
      level: Number(m[1]),
      text: m[2]!.replace(/<[^>]+>/g, '').trim().slice(0, 40),
    }));

  it('gives every page one h1 and no gap in the levels under it', async () => {
    // The board went h1 straight to h3: every column title, the add form and
    // the four help sections. A reader moving by heading level was told this
    // page has no second tier, when the columns are exactly that.
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    const pages = ['/', '/docs', '/docs/api', '/docs/keys', '/pricing', '/signup', `/r/${readToken}`, `/r/${readToken}/board`];

    for (const page of pages) {
      const rendered = await harness.server.inject({ method: 'GET', url: page, headers: { accept: 'text/html' } });
      assert.equal(rendered.statusCode, 200, page);
      const headings = headingsIn(rendered.body);
      assert.equal(headings.filter((h) => h.level === 1).length, 1, `${page} has exactly one h1`);
      let previous = 0;
      for (const heading of headings) {
        assert.ok(
          previous === 0 || heading.level <= previous + 1,
          `${page} jumps h${previous} to h${heading.level} at "${heading.text}"`,
        );
        previous = heading.level;
      }
    }
  });

  it('says which way every header cell points', async () => {
    // 32 of them across the site and not one carried scope, so a reader landing
    // in the middle of a row was told the value and not what it is a value of.
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    for (const page of ['/docs', '/docs/api', '/docs/keys', '/pricing', `/r/${readToken}/board`]) {
      const rendered = await harness.server.inject({ method: 'GET', url: page, headers: { accept: 'text/html' } });
      const cells = [...rendered.body.matchAll(/<th\b[^>]*>/g)].map((m) => m[0]);
      for (const cell of cells) {
        assert.match(cell, /scope="(col|row)"/, `${page} has a header cell with no scope: ${cell}`);
      }
    }
  });

  it('leaves nothing off the page that a keyboard can still land on', async () => {
    // The filter form's submit is off the page on purpose: the operator asked
    // for no button to press, and every browser needs one to exist for Enter
    // to mean apply. It was still taking focus, and the clip that hides it was
    // hiding the focus ring with it, so there was one stop where the keyboard
    // went quiet and nothing said where you were.
    //
    // Revealing it on focus was tried twice and broke something else both
    // times, so it is out of the tab order instead. Every filter is a text
    // input and Enter submits from all of them, which is what this button is
    // for; a stop that shows nothing and does nothing a keyboard cannot
    // already do is worse than no stop. The invariant is the assertion: if it
    // wears sr-only and it can be focused, it has to be visible.
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    // An empty board renders no filter form, so a bare project would have made
    // this pass by finding nothing to check. One card is enough to draw it.
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'probe:one-card', title: 'so the filter bar exists', owner: 'somebody' },
    });
    const focusable = /^(a|button|input|select|textarea|summary)$/;
    let checked = 0;

    for (const page of ['/', '/docs', '/pricing', '/signup', `/r/${readToken}/board`]) {
      const rendered = await harness.server.inject({ method: 'GET', url: page, headers: { accept: 'text/html' } });
      for (const [tag, attrs] of [...rendered.body.matchAll(/<([a-z]+)\b([^>]*\bclass="[^"]*\bsr-only\b[^"]*"[^>]*)>/g)].map(
        (m) => [m[1]!, m[2]!] as const,
      )) {
        if (!focusable.test(tag)) continue;
        checked += 1;
        assert.match(
          attrs,
          /tabindex="-1"/,
          `${page} hides a ${tag} that a keyboard would still land on: ${attrs.trim().slice(0, 80)}`,
        );
      }
    }
    assert.ok(checked > 0, 'and it found something to check, rather than passing on an empty board');
  });
});

describe('the colours these pages are read in', () => {
  /**
   * A page-speed report found one chip below the line at 4.32:1 where its two
   * neighbours sat at 5.50 and 5.18. The neighbours were not right on purpose,
   * they were right by luck, and luck does not survive the next colour anybody
   * picks. This reads the stylesheet the pages actually link and does the
   * arithmetic, in both themes, so the next one is caught before a report is.
   */
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  // Three digits and six are the same colour, and the stylesheet writes both.
  const full = (hex: string): string => {
    const h = hex.replace('#', '');
    return h.length === 3 ? `#${[...h].map((d) => d + d).join('')}` : `#${h}`;
  };
  const luminance = (raw: string): number => {
    const h = full(raw).replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  // What the browser composites: a translucent tint over whatever is behind it.
  const over = (tint: string, behind: string, share: number): string => {
    const [t, b] = [full(tint).replace('#', ''), full(behind).replace('#', '')];
    return `#${[0, 2, 4]
      .map((i) =>
        Math.round(parseInt(t.slice(i, i + 2), 16) * share + parseInt(b.slice(i, i + 2), 16) * (1 - share))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`;
  };

  // The light block is written first and the dark one inside the media query,
  // so the first value of a name is light and the second is dark.
  const themesIn = (sheet: string): Map<string, string>[] =>
    [0, 1].map((which) => {
      const found = new Map<string, string>();
      const seen = new Map<string, number>();
      for (const [, name, value] of sheet.matchAll(
        /--([a-z0-9-]+):(#[0-9a-f]{6}\b|#[0-9a-f]{3}\b)/g,
      )) {
        const count = (seen.get(name!) ?? 0) + 1;
        seen.set(name!, count);
        if (count === which + 1) found.set(name!, value!);
      }
      return found;
    });

  it('gives every text colour enough contrast on every surface it sits on', async () => {
    // The chip test below came from a report and only covered chips. The
    // colour that actually failed next was --muted, at 4.48:1 against
    // --surface-2, which is where the smallest text on a board sits: the
    // column counts, the hint under a column title, the "and 124 more". Two
    // hundredths under the line, on the type least able to afford it, and
    // nothing was looking. The palette is nine colours; every text one has to
    // read on every surface one, and asserting that is cheaper than finding
    // out which pairs happen to occur today.
    const page = await harness.server.inject({ method: 'GET', url: '/' });
    const href = /<link rel="stylesheet" href="([^"]+)"/.exec(page.body)?.[1];
    assert.ok(href, 'the page links a stylesheet');
    const sheet = (await harness.server.inject({ method: 'GET', url: href })).body;

    for (const [which, vars] of themesIn(sheet).entries()) {
      const theme = which === 0 ? 'light' : 'dark';
      for (const ink of ['ink', 'ink-2', 'muted']) {
        for (const surface of ['surface', 'surface-2', 'bg']) {
          const text = vars.get(ink);
          const behind = vars.get(surface);
          assert.ok(text && behind, `${theme} names --${ink} and --${surface}`);
          const ratio = contrast(text, behind);
          assert.ok(
            ratio >= 4.5,
            `--${ink} on --${surface} reads at ${ratio.toFixed(2)}:1 in the ${theme} theme, under 4.5:1`,
          );
        }
      }
    }
  });

  it('gives every chip enough contrast to read, in both themes', async () => {
    const page = await harness.server.inject({ method: 'GET', url: '/' });
    const href = /<link rel="stylesheet" href="([^"]+)"/.exec(page.body)?.[1];
    assert.ok(href, 'the page links a stylesheet');
    const sheet = (await harness.server.inject({ method: 'GET', url: href })).body;

    const themes = themesIn(sheet);

    // Every one of them, in whichever of the three ways it is written. The
    // first version of this read only the chips tinted with `color-mix` and
    // silently skipped four written with a plain background and, later, the
    // highlighted row in the list a field opens. They were all fine, which is
    // luck rather than a rule: a check that covers the easy spellings is a
    // check somebody can walk past without noticing.
    const coloured: { what: string; ink: string; behind: string; share: number }[] = [];
    // The whole block, then the two declarations out of it: which order they
    // are written in is the author's business and not something a check should
    // quietly depend on.
    for (const [, what, block] of sheet.matchAll(
      /(\.chip\.[a-z]+|\.field \.choices li\[aria-selected='true'\]) \{([^}]*)\}/g,
    )) {
      const ink = /(?:^|[;{ ])color:var\(--([a-z0-9-]+)\)/.exec(block!)?.[1];
      const background = /background:([^;}]+)/.exec(block!)?.[1]?.trim();
      if (!ink || !background) continue;
      const mixed = /color-mix\(in srgb,var\(--([a-z0-9-]+)\) (\d+)%/.exec(background);
      const plain = /^var\(--([a-z0-9-]+)\)$/.exec(background);
      // `transparent` means whatever the card is, which is the surface.
      if (mixed) coloured.push({ what: what!, ink, behind: mixed[1]!, share: Number(mixed[2]) / 100 });
      else if (plain) coloured.push({ what: what!, ink, behind: plain[1]!, share: 1 });
      else if (background === 'transparent') coloured.push({ what: what!, ink, behind: 'surface', share: 1 });
      else assert.fail(`${what} paints its background a way this check cannot read: ${background}`);
    }
    assert.ok(coloured.length >= 7, `found ${coloured.length} coloured things to check`);
    assert.ok(
      coloured.some((one) => one.what.includes('choices')),
      'including the row a field highlights, which is the newest of them',
    );

    for (const [which, vars] of themes.entries()) {
      const surface = vars.get('surface');
      assert.ok(surface, 'the theme names a surface');
      for (const { what, ink, behind, share } of coloured) {
        const text = vars.get(ink);
        const under = vars.get(behind);
        assert.ok(text && under, `${what} names colours this theme has`);
        const ratio = contrast(text, share === 1 ? under! : over(under!, surface, share));
        assert.ok(
          ratio >= 4.5,
          `${what} reads at ${ratio.toFixed(2)}:1 in the ${which === 0 ? 'light' : 'dark'} theme, under 4.5:1`,
        );
      }
    }
  });
});

describe('every link these pages render', () => {
  /**
   * A link that goes nowhere is invisible to a test that only asserts it is
   * there, which is how the operator's "Your work" link spent an afternoon
   * pointing at a board with the card shut: the assertion said the href
   * existed. This follows every internal one and refuses a 404.
   */
  const linksOn = (html: string): string[] => {
    const found = new Set<string>();
    for (const link of html.matchAll(/href="(\/[^"]*)"/g)) {
      const href = link[1]!
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .split('#')[0]!;
      if (href !== '') found.add(href);
    }
    return [...found];
  };

  it('goes somewhere, on every page a person is handed', async () => {
    const project = await createProject(harness, 'linked');
    const readToken = project.readUrl.split('/r/')[1]!;
    await post(project, '/items', {
      slug: 'ops:bridge',
      title: 'the bridge',
      owner: 'owner@example.com',
      status: 'blocked',
      actor: 'errors-loop',
    });
    await post(project, '/escalations', {
      question: 'Bridge it?',
      agent: 'errors-loop',
      item_slug: 'ops:bridge',
    });
    await claimForEmail(project, 'owner@example.com');
    const session = await signIn(harness, 'owner@example.com');

    const pages = ['/', '/docs', '/pricing', '/signup', `/r/${readToken}`, `/r/${readToken}/board`, '/operator'];
    const checked = new Set<string>();
    for (const page of pages) {
      const rendered = await harness.server.inject({
        method: 'GET',
        url: page,
        headers: { accept: 'text/html', cookie: session.cookie },
      });
      assert.equal(rendered.statusCode, 200, page);

      // One main landmark on every page, so a screen reader can skip the
      // header and the nav rather than walking them again on each one.
      assert.equal(
        (rendered.body.match(/<main>/g) ?? []).length,
        1,
        `${page} renders exactly one main landmark`,
      );

      // A link whose text says nothing is a link read out of context, which is
      // how both a screen reader and a crawler read it. "start" was the one
      // that said nothing: start what.
      for (const [, text] of rendered.body.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)) {
        const words = (text ?? '').trim().toLowerCase();
        assert.ok(
          !['start', 'here', 'click here', 'read more', 'learn more', 'more', 'link'].includes(
            words,
          ),
          `${page} has a link that says only "${words}"`,
        );
      }

      for (const href of linksOn(rendered.body)) {
        if (checked.has(href)) continue;
        checked.add(href);
        // Chased, because a browser chases: a link answering 303 to a page
        // that answers 404 is a broken link, and stopping at the redirect is
        // the check agreeing with itself instead of with the reader.
        let at = href;
        let followed = await harness.server.inject({
          method: 'GET',
          url: at,
          headers: { accept: 'text/html', cookie: session.cookie },
        });
        for (let hop = 0; hop < 5 && followed.statusCode >= 300 && followed.statusCode < 400; hop += 1) {
          const next = String(followed.headers.location ?? '');
          assert.ok(next.startsWith('/'), `${at} redirects off this service, to ${next}`);
          at = next;
          followed = await harness.server.inject({
            method: 'GET',
            url: at,
            headers: { accept: 'text/html', cookie: session.cookie },
          });
        }
        // Under 300, which is a page rather than a promise of one. Still 3xx
        // here means the five hops ran out: a loop or a maze, and reading
        // "< 400" off that last redirect would pass both.
        assert.ok(
          followed.statusCode < 300,
          `${page} links to ${href}, which ends at ${at} answering ${followed.statusCode}`,
        );
      }
    }
    assert.ok(checked.size > 12, `only ${checked.size} links were followed`);
  });
});

describe('every form these pages render', () => {
  interface Rendered {
    page: string;
    action: string;
    hidden: Record<string, string>;
  }

  // The pages escape what they interpolate, so an action or a token has to come
  // back through the same door it went out of.
  const plain = (value: string): string =>
    value
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

  const formsOn = (page: string, html: string): Rendered[] => {
    const found: Rendered[] = [];
    for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
      const attributes = form[1]!;
      const method = /method="([^"]*)"/.exec(attributes)?.[1]?.toLowerCase() ?? 'get';
      if (method !== 'post') continue;
      const action = /action="([^"]*)"/.exec(attributes)?.[1];
      assert.ok(action, `a form on ${page} posts nowhere`);
      const hidden: Record<string, string> = {};
      for (const field of form[2]!.matchAll(/<input\b[^>]*type="hidden"[^>]*>/g)) {
        const name = /name="([^"]*)"/.exec(field[0])?.[1];
        const value = /value="([^"]*)"/.exec(field[0])?.[1] ?? '';
        if (name) hidden[plain(name)] = plain(value);
      }
      found.push({ page, action: plain(action), hidden });
    }
    return found;
  };

  it('goes through when a browser posts it back', async () => {
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'agent' });
    await post(project, '/escalations', { question: 'Ship it?', agent: 'agent', item_slug: 'work' });

    const session = await signIn(harness, 'owner@example.com');

    // Three states, in the order that produces them. An unclaimed board offers
    // a stranger the token form and its signed in reader the handover; a
    // claimed one offers neither, and is what the operator's own page is about.
    // Written as a sequence because claiming is one way: the forms have to be
    // read off the earlier state before the later one exists.
    const forms: Rendered[] = [];
    const collect = async (url: string, headers: Record<string, string> = {}) => {
      const page = await harness.server.inject({ method: 'GET', url, headers });
      assert.equal(page.statusCode, 200, url);
      forms.push(...formsOn(url, page.body));
    };

    await collect(`/r/${readToken}`);
    await collect(`/r/${readToken}`, { cookie: session.cookie });
    await collect(`/r/${readToken}/board`);

    await claimForEmail(project, 'owner@example.com');
    await collect('/operator', { cookie: session.cookie });

    // Counted by where they post, not by how many were rendered: the same page
    // read twice would otherwise double the total and prove half as much. And
    // the handover is named, because it is the one form that only the signed in
    // state renders, and a project claimed a line too early would drop it
    // silently.
    const actions = new Set(forms.map((form) => form.action));
    // Sixteen today. The floor is under that rather than at it, so adding a
    // form does not fail the suite and a page that quietly stopped rendering
    // its own still does.
    assert.ok(actions.size >= 14, `only ${actions.size} distinct forms, so this proves little`);
    assert.ok(
      [...actions].some((action) => action.endsWith('/handover')),
      'the signed in reader of an unclaimed board was never rendered',
    );

    // The other half of the same question, and the half that is a security
    // property rather than a usability one: every one of these forms has to
    // refuse the same post arriving from somebody else's page. Written as a
    // sweep over what the pages actually render, so a form added next month is
    // covered on both sides without anybody remembering to add it here.
    //
    // Before the same-origin sweep below, which ends by logging out.
    for (const form of forms) {
      const elsewhere = await harness.server.inject({
        method: 'POST',
        url: form.action,
        payload: new URLSearchParams(form.hidden).toString(),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: session.cookie,
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
        },
      });
      assert.equal(
        elsewhere.statusCode,
        403,
        `${form.action} answered ${elsewhere.statusCode} to a post from another site`,
      );
    }

    // Logging out is the one form that takes the session every other operator
    // form needs, so it goes last rather than being skipped.
    const ordered = [...forms].sort(
      (left, right) =>
        Number(left.action.endsWith('/logout')) - Number(right.action.endsWith('/logout')),
    );

    for (const form of ordered) {
      const answer = await harness.server.inject({
        method: 'POST',
        url: form.action,
        payload: new URLSearchParams(form.hidden).toString(),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: session.cookie,
          // Exactly what Chrome sent the night this broke: the referrer policy
          // blanks the Origin, and Sec-Fetch-Site is the proof that is left.
          origin: 'null',
          'sec-fetch-site': 'same-origin',
        },
      });
      // Missing fields are the form's business and answer 400; being refused as
      // somebody else's page is this service's business, and is the bug.
      assert.notEqual(
        answer.statusCode,
        403,
        `${form.action} was refused, and it is rendered on ${form.page}`,
      );
    }
  });
});

describe('a shape where a name belongs, at every door the document names', () => {
  /**
   * Derived from the published document rather than from a list somebody keeps,
   * because the list is what failed. Refusing a query where a name belongs was
   * done once, at the doors where MCP arguments land in a filter, and the OAuth
   * token endpoint was added without it: `client_secret` as an object reached
   * the hash and answered 500, which is the one class this protocol tells an
   * agent to retry.
   *
   * The assertion is deliberately weak. Whether a crafted value is refused with
   * 400, ignored, or lands somewhere harmless is each door's own business; what
   * none of them may do is break. A door added tomorrow appears in the document
   * and is walked here without anybody remembering to add it.
   */
  it('never breaks on one, whatever it decides to do with it', async () => {
    const harness = await startHarness({
      LIMIT_WRITES_PER_MINUTE: '100000',
      LIMIT_READS_PER_MINUTE: '100000',
      LIMIT_CREATE_PROJECTS_PER_HOUR: '10000',
      LIMIT_CLAIM_EMAILS_PER_HOUR: '10000',
    });
    try {
      const project = await createProject(harness, 'crafted');
      await harness.server.inject({
        method: 'POST',
        url: `${project.api}/items`,
        headers: { ...authed(project), 'content-type': 'application/json' },
        payload: { slug: 'a-card', title: 'a card', actor: 'somebody' },
      });

      // A registered client, so the token endpoint has something to look up.
      // Without one it refuses at the lookup and never reaches the hash, which
      // is where it broke: the walk went past the door rather than through it,
      // and reverting the fix left this test green.
      const registered = (
        await harness.server.inject({
          method: 'POST',
          url: '/oauth/register',
          headers: { 'content-type': 'application/json' },
          payload: { client_name: 'crafted', redirect_uris: [] },
        })
      ).json() as { client_id: string };

      const doc = (await harness.server.inject({ method: 'GET', url: '/openapi.json' })).json() as {
        paths: Record<
          string,
          Record<
            string,
            { requestBody?: { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> } }
          >
        >;
      };

      const crafted = { $ne: null };

      /**
       * A value this schema would accept, so the request is refused for the
       * field being tested and not for a companion that was never sent.
       */
      type Schema = {
        type?: string | string[];
        enum?: unknown[];
        properties?: Record<string, Schema>;
        required?: string[];
        items?: Schema;
        minimum?: number;
        maxLength?: number;
      };
      const plausible = (schema: Schema): unknown => {
        if (schema.enum?.length) return schema.enum[0];
        const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
        if (type === 'integer' || type === 'number') return schema.minimum ?? 1;
        if (type === 'boolean') return true;
        if (type === 'array') return schema.items ? [plausible(schema.items)] : [];
        if (type === 'object') return Object.fromEntries(
          (schema.required ?? []).map((name) => [name, plausible(schema.properties?.[name] ?? {})]),
        );
        return 'x';
      };

      /** Every place a value sits, including the ones inside other values. */
      const places = (schema: Schema, trail: string[] = []): string[][] =>
        Object.entries(schema.properties ?? {}).flatMap(([name, child]) => {
          const here = [...trail, name];
          const type = Array.isArray(child.type) ? child.type[0] : child.type;
          if (type === 'object' && child.properties) return [here, ...places(child, here)];
          if (type === 'array' && child.items?.properties) return [here, ...places(child.items, [...here, '0'])];
          return [here];
        });

      const put = (into: Record<string, unknown>, trail: string[], value: unknown): void => {
        let at: Record<string, unknown> | unknown[] = into;
        for (let i = 0; i < trail.length - 1; i += 1) {
          const key = trail[i]!;
          const next = trail[i + 1]!;
          const holder = at as Record<string, unknown>;
          if (holder[key] === undefined || typeof holder[key] !== 'object') {
            holder[key] = /^\d+$/.test(next) ? [] : {};
          }
          at = holder[key] as Record<string, unknown>;
        }
        (at as Record<string, unknown>)[trail[trail.length - 1]!] = value;
      };

      const broke: string[] = [];
      let walked = 0;
      for (const [path, operations] of Object.entries(doc.paths)) {
        for (const [method, operation] of Object.entries(operations)) {
          if (!['post', 'put', 'patch', 'delete'].includes(method)) continue;
          const url = path
            .replace('{project}', project.id)
            .replace('{slug}', 'a-card')
            .replace('{id}', 'nothing-by-that-name')
            .replace('{handle}', 'nobody');
          const schema = (operation.requestBody?.content?.['application/json']?.schema ?? {}) as Schema;
          const trails = places(schema);
          // A door the document gives no fields is either one that reads no
          // body at all or one whose body it does not describe, and the second
          // is exactly where this went wrong. Both get a body anyway.
          const bodies: Record<string, unknown>[] =
            trails.length > 0
              ? trails.map((trail) => {
                  const body = plausible(schema) as Record<string, unknown>;
                  put(body, trail, crafted);
                  return body;
                })
              : [
                  { client_id: registered.client_id, client_secret: crafted, grant_type: 'client_credentials' },
                  { client_id: crafted, client_secret: 'whatever', grant_type: 'client_credentials' },
                ];
          for (const [n, payload] of bodies.entries()) {
            const answer = await harness.server.inject({
              method: method.toUpperCase() as 'POST',
              url,
              headers: { ...authed(project), 'content-type': 'application/json' },
              payload,
            });
            walked += 1;
            if (answer.statusCode >= 500) {
              broke.push(`${method.toUpperCase()} ${path} on ${(trails[n] ?? ['body']).join('.')}: ${answer.statusCode}`);
            }
          }
        }
      }

      assert.deepEqual(broke.sort(), [], 'a crafted value is refused or ignored, never answered with a 5xx');
      // A floor, because the failure this guards against is the walk quietly
      // shrinking: a schema read that returns nothing leaves every assertion
      // above it true. Sixty is well under what it visits today.
      assert.ok(walked >= 60, `it visited the doors rather than counting them: ${walked}`);
    } finally {
      await harness.stop();
    }
  });
});

describe('a project cannot revoke its own way in', () => {
  /**
   * Measured before it was guarded: the call answered `{"ok":true}` and shut
   * every API door on the project, because minting a key needs an admin key.
   * The sequence that gets there is the one a leak calls for, run in the wrong
   * order, and an unclaimed board is what an agent signs up.
   */
  const del = (project: Project, id: string, token?: string) =>
    harness.server.inject({
      method: 'DELETE',
      url: `${project.api}/keys/${id}`,
      headers: token ? { authorization: `Bearer ${token}` } : authed(project),
    });

  const keysOf = async (project: Project, token?: string) =>
    (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/keys`,
        headers: token ? { authorization: `Bearer ${token}` } : authed(project),
      })
    ).json().keys as Array<{ id: string; role: string; revoked_at: string | null }>;

  it('refuses the last admin key, and leaves it working', async () => {
    const project = await createProject(harness);
    const only = (await keysOf(project))[0]!;

    const refused = await del(project, only.id);
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, 'last_admin_key');

    // Nothing was changed by the refusal: the door the caller came through is
    // still open, which is the whole point of refusing rather than obeying.
    const after = await keysOf(project);
    assert.equal(after[0]!.revoked_at, null);
    assert.equal(after.length, 1);
  });

  it('allows it the moment there is another way in', async () => {
    const project = await createProject(harness);
    const spare = (
      await post(project, '/keys', { name: 'spare', role: 'admin' })
    ).json().token as string;
    const first = (await keysOf(project))[0]!;

    const gone = await del(project, first.id, spare);
    assert.equal(gone.statusCode, 200);
    assert.equal((await keysOf(project, spare)).find((k) => k.id === first.id)!.revoked_at !== null, true);
  });

  it('does not count a key that has run out as the way in', async () => {
    const project = await createProject(harness);
    const admin = (await keysOf(project))[0]!;
    const expired = (await post(project, '/keys', { name: 'expired', role: 'admin' })).json().key.id;
    await harness.store.keys.updateOne(
      { _id: expired },
      { $set: { expiresAt: new Date(Date.now() - 60_000) } },
    );

    const refused = await del(project, admin.id);
    assert.equal(refused.statusCode, 409, 'an expired admin key is not a way back in');
    assert.equal((await keysOf(project))[0]!.revoked_at, null);
  });

  it('never leaves nothing behind when two revocations race', async () => {
    // A fleet shares one key, so two loops reacting to the same leak fire two
    // revocations at once. Forced rather than hoped for: both are held at their
    // first read until the other has reached its own, so the two transactions
    // are open over each other. Run as two ordinary concurrent calls the pair
    // serialises and passes under every broken order, measured eight times out
    // of eight.
    const project = await createProject(harness);
    await post(project, '/keys', { name: 'second', role: 'admin' });
    const both = await keysOf(project);

    let waiting: (() => void) | null = null;
    let met = 0;
    const real = harness.store.keys.findOne.bind(harness.store.keys);
    harness.store.keys.findOne = (async (...args: Parameters<typeof real>) => {
      if (met < 2) {
        met += 1;
        await new Promise<void>((go) => {
          if (waiting) {
            waiting();
            waiting = null;
            go();
          } else {
            waiting = go;
          }
        });
      }
      return real(...args);
    }) as typeof real;

    let outcomes: Array<string> = [];
    try {
      outcomes = await Promise.all(
        both.map((key) =>
          revokeApiKey(harness.store, project.id, key.id).then(
            () => 'revoked',
            (error: ServiceError) => error.code ?? 'threw',
          ),
        ),
      );
    } finally {
      harness.store.keys.findOne = real;
    }

    const live = await harness.store.keys.countDocuments({
      projectId: project.id,
      role: 'admin',
      revokedAt: null,
    });
    assert.equal(live, 1, `something can still open this project: ${outcomes.join(', ')}`);
    assert.equal(outcomes.filter((o) => o === 'revoked').length, 1, outcomes.join(', '));
    assert.equal(outcomes.filter((o) => o === 'last_admin_key').length, 1, outcomes.join(', '));
  });

  it('lets one revocation follow another', async () => {
    // Cleaning up after a leak is a run of these, so nothing may be left
    // behind by one that makes the next one wait or fail.
    const project = await createProject(harness);
    await post(project, '/keys', { name: 'second', role: 'admin' });
    await post(project, '/keys', { name: 'third', role: 'admin' });
    const all = await keysOf(project);

    assert.equal((await del(project, all[1]!.id)).statusCode, 200);
    assert.equal((await del(project, all[2]!.id)).statusCode, 200, 'the second one goes too');
  });

  it('leaves the key alive when the database goes away mid-call', async () => {
    // The failure the first version of this guard had: it revoked, counted,
    // and put the key back when the count came up empty. A store that goes
    // away between the write and the compensating write never puts it back,
    // and the retry then answers 404 because the key is already revoked, which
    // is exactly the lockout being prevented, reached by a different door.
    const project = await createProject(harness);
    await post(project, '/keys', { name: 'second', role: 'admin' });
    const [first] = await keysOf(project);

    const real = harness.store.projects.updateOne.bind(harness.store.projects);
    harness.store.projects.updateOne = (async () => {
      throw new Error('primary stepped down');
    }) as typeof real;
    try {
      await assert.rejects(() => revokeApiKey(harness.store, project.id, first!.id));
    } finally {
      harness.store.projects.updateOne = real;
    }

    const after = await keysOf(project);
    assert.equal(after.find((k) => k.id === first!.id)!.revoked_at, null, 'the key still opens the door');
  });

  it('lets a worker key go even when it is the only one', async () => {
    const project = await createProject(harness);
    const worker = (await post(project, '/keys', { name: 'worker', role: 'write' })).json().key.id;
    assert.equal((await del(project, worker)).statusCode, 200);
  });
});
