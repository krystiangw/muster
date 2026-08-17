import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hashToken } from '../src/ids.js';
import { authed, createProject, signIn, startHarness, type Harness, type Project } from './helper.js';

/**
 * The cross-project operator view. This is the piece our own station needed and
 * no board on the market has: the person who owns six projects should see one
 * queue, not six links.
 */

let harness: Harness;

before(async () => {
  // Every test here asks for a link, and they all share one source address, so
  // the production limit of five an hour would throttle the suite. That limit
  // is also what bounds the nuisance of a stranger requesting links for an
  // address they do not own.
  harness = await startHarness({ LIMIT_CLAIM_EMAILS_PER_HOUR: '100' });
});

after(async () => {
  await harness.stop();
});

async function claimFor(project: Project, email: string): Promise<void> {
  await harness.server.inject({
    method: 'POST',
    url: `${project.api}/claim`,
    headers: authed(project),
    payload: { email },
  });
  const pending = await harness.store.claimCodes.findOne({ projectId: project.id });
  await harness.store.claimCodes.updateOne(
    { _id: pending!._id },
    { $set: { codeHash: hashToken('123456') } },
  );
  await harness.server.inject({
    method: 'POST',
    url: `${project.api}/claim/verify`,
    headers: authed(project),
    payload: { email, code: '123456' },
  });
}

describe('the operator view', () => {
  it('gathers every question from every project the same person claimed', async () => {
    const fleet = await createProject(harness, 'fleet');
    const sygnal = await createProject(harness, 'sygnal');
    const somebodyElse = await createProject(harness, 'not mine');

    await claimFor(fleet, 'operator@example.com');
    await claimFor(sygnal, 'operator@example.com');
    await claimFor(somebodyElse, 'other@example.com');

    for (const [project, question] of [
      [fleet, 'Bridge the stuck withdraw or wait?'],
      [sygnal, 'Ship the forecast change on Friday?'],
      [somebodyElse, 'A question that is none of your business'],
    ] as Array<[Project, string]>) {
      await harness.server.inject({
        method: 'POST',
        url: `${project.api}/escalations`,
        headers: authed(project),
        payload: { agent: 'a-loop', question, priority: 'high' },
      });
    }

    const session = await signIn(harness, 'operator@example.com');
    const view = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    assert.equal(view.statusCode, 200);
    assert.doesNotMatch(view.body, /<script/i);
    assert.match(view.body, /Bridge the stuck withdraw/);
    assert.match(view.body, /Ship the forecast change/);
    assert.doesNotMatch(
      view.body,
      /none of your business/,
      'another operator’s question must never appear here',
    );
    assert.match(view.body, /2 questions for you/);
  });

  it('answers from the shared view and the agent reads it in its own project', async () => {
    const project = await createProject(harness, 'answerable');
    await claimFor(project, 'boss@example.com');
    const created = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/escalations`,
      headers: authed(project),
      payload: { agent: 'errors-loop', question: 'Deploy now?' },
    });
    const id = created.json().escalation.id;

    const session = await signIn(harness, 'boss@example.com');
    const answered = await harness.server.inject({
      method: 'POST',
      url: `/operator/escalations/${id}`,
      payload: session.form({ status: 'wont_do', answer: 'Not this week' }),
      headers: session.headers,
    });
    assert.equal(answered.statusCode, 303);

    const inbox = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/inbox?agent=errors-loop`,
      headers: authed(project),
    });
    const answer = inbox.json().answers[0];
    assert.equal(answer.status, 'wont_do');
    assert.equal(answer.answer, 'Not this week');
  });

  it('refuses to answer a question in somebody else’s project', async () => {
    const mine = await createProject(harness, 'mine');
    const theirs = await createProject(harness, 'theirs');
    await claimFor(mine, 'me@example.com');
    await claimFor(theirs, 'them@example.com');

    const theirQuestion = await harness.server.inject({
      method: 'POST',
      url: `${theirs.api}/escalations`,
      headers: authed(theirs),
      payload: { agent: 'x', question: 'theirs' },
    });
    const id = theirQuestion.json().escalation.id;

    const session = await signIn(harness, 'me@example.com');
    const attempt = await harness.server.inject({
      method: 'POST',
      url: `/operator/escalations/${id}`,
      payload: session.form({ status: 'answered', answer: 'hijack' }),
      headers: session.headers,
    });
    assert.equal(attempt.statusCode, 403);
  });

  it('signs somebody in with a code, and out again', async () => {
    const project = await createProject(harness, 'sessions');
    await claimFor(project, 'owner@example.com');

    const session = await signIn(harness, 'owner@example.com');
    const view = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    assert.equal(view.statusCode, 200);
    assert.match(view.body, /sessions/);
    assert.doesNotMatch(view.body, /muster_session=/, 'the credential is never rendered');

    // Asking for another code must not disturb a browser that is already in:
    // anybody can type an address into that form.
    await harness.server.inject({
      method: 'POST',
      url: '/operator',
      payload: 'email=owner@example.com',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(
      (
        await harness.server.inject({
          method: 'GET',
          url: '/operator',
          headers: { cookie: session.cookie },
        })
      ).statusCode,
      200,
    );

    const out = await harness.server.inject({
      method: 'POST',
      url: '/operator/logout',
      payload: session.form({}),
      headers: session.headers,
    });
    assert.equal(out.statusCode, 200);
    const after = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    assert.match(after.body, /Send me a code/, 'the session is over');
  });

  it('refuses a form that did not come from the view', async () => {
    const project = await createProject(harness, 'csrf');
    await claimFor(project, 'owner@example.com');
    const created = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/escalations`,
      headers: authed(project),
      payload: { agent: 'a', question: 'anything?' },
    });
    const id = created.json().escalation.id;
    const session = await signIn(harness, 'owner@example.com');

    // A cookie is ambient authority, so the cookie alone must not be enough.
    const forged = await harness.server.inject({
      method: 'POST',
      url: `/operator/escalations/${id}`,
      payload: 'status=answered&answer=from+another+site',
      headers: session.headers,
    });
    assert.equal(forged.statusCode, 403);
    assert.equal(forged.json().error, 'bad_csrf');

    const wrongToken = await harness.server.inject({
      method: 'POST',
      url: `/operator/escalations/${id}`,
      payload: 'csrf=c_notthetoken&status=answered&answer=nope',
      headers: session.headers,
    });
    assert.equal(wrongToken.statusCode, 403);
  });

  it('exchanges a link emailed before sessions existed, once', async () => {
    const project = await createProject(harness, 'legacy');
    await claimFor(project, 'old@example.com');

    // Planted the way the old mail built it: only the hash was ever stored.
    const planted = 'mk_test_legacy_link';
    await harness.store.operatorTokens.insertOne({
      _id: 'o_legacy',
      email: 'old@example.com',
      hash: hashToken(planted),
      createdAt: new Date(),
      lastUsedAt: null,
    });

    const first = await harness.server.inject({ method: 'GET', url: `/operator/${planted}` });
    assert.equal(first.statusCode, 303);
    assert.equal(first.headers.location, '/operator');
    assert.ok(String(first.headers['set-cookie']).startsWith('muster_session='));

    // Burned. A URL that reached a log or a history before today stops being a
    // way in the moment its owner uses it.
    const second = await harness.server.inject({ method: 'GET', url: `/operator/${planted}` });
    assert.equal(second.statusCode, 404);
  });

  it('lets a session lapse, and a code with it', async () => {
    const project = await createProject(harness, 'expiry');
    await claimFor(project, 'lapsing@example.com');
    const session = await signIn(harness, 'lapsing@example.com');

    await harness.store.operatorSessions.updateMany(
      { email: 'lapsing@example.com' },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const after = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    assert.match(after.body, /Send me a code/, 'an expired session is not a session');

    // A code that sat in a mailbox too long is no better.
    await harness.server.inject({
      method: 'POST',
      url: '/operator',
      payload: 'email=lapsing@example.com',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const pending = await harness.store.operatorCodes.findOne({ email: 'lapsing@example.com' });
    await harness.store.operatorCodes.updateOne(
      { _id: pending!._id },
      { $set: { codeHash: hashToken('123456'), expiresAt: new Date(Date.now() - 1000) } },
    );
    // The TTL index sweeps on its own schedule, so the read has to be guarded
    // too rather than trusting the sweep to have run.
    const stale = await harness.server.inject({
      method: 'POST',
      url: '/operator/verify',
      payload: 'email=lapsing@example.com&code=123456',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(stale.statusCode, 400);
    assert.ok(!String(stale.headers['set-cookie'] ?? '').includes('muster_session='));
  });

  it('gives up on a code after five wrong guesses', async () => {
    const project = await createProject(harness, 'guessing');
    await claimFor(project, 'guessed@example.com');
    await harness.server.inject({
      method: 'POST',
      url: '/operator',
      payload: 'email=guessed@example.com',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const pending = await harness.store.operatorCodes.findOne({ email: 'guessed@example.com' });
    await harness.store.operatorCodes.updateOne(
      { _id: pending!._id },
      { $set: { codeHash: hashToken('123456') } },
    );

    const guess = (code: string) =>
      harness.server.inject({
        method: 'POST',
        url: '/operator/verify',
        payload: `email=guessed@example.com&code=${code}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await guess('000000')).statusCode, 400);
    }
    // Six digits is a million, five guesses is nothing, and the ceiling is what
    // keeps it that way.
    assert.equal((await guess('123456')).statusCode, 400, 'the right code no longer helps');
  });

  it('does not reveal whether an address owns anything', async () => {
    const unknown = await harness.server.inject({
      method: 'POST',
      url: '/operator',
      payload: 'email=stranger@example.com',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(unknown.statusCode, 200);
    assert.match(unknown.body, /If stranger@example.com can sign in here/);

    const known = await harness.server.inject({
      method: 'POST',
      url: '/operator',
      payload: 'email=owner@example.com',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    // Byte for byte the same page apart from the address that was typed.
    assert.equal(
      unknown.body.replace(/stranger@example\.com/g, 'X'),
      known.body.replace(/owner@example\.com/g, 'X'),
    );
  });
});
