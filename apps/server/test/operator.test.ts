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

  it('tells somebody with no projects yet how a board gets here', async () => {
    // The first screen after signing in, for somebody who has just been handed
    // a read link and does not know what to do with it. It was a table with a
    // header row, no rows, and nothing said.
    const session = await signIn(harness, 'nobody@example.com');
    const view = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    assert.match(view.body, /None yet/);
    assert.match(view.body, /skill\.md/, 'and where the agent that makes one reads its protocol');
    assert.ok(
      !/<th>Project<\/th>/.test(view.body.split('Going stale')[0] ?? '') ||
        view.body.includes('hidden'),
      'and no empty table above it',
    );
  });

  it('refuses a visibility it does not have, rather than picking one', async () => {
    // Reading "anything that is not owner" as "open it by link" is a coin flip
    // on a privacy switch, and the wrong side of it publishes a board.
    const project = await createProject(harness, 'privacy');
    await claimFor(project, 'me@example.com');
    const session = await signIn(harness, 'me@example.com');
    await harness.server.inject({
      method: 'POST',
      url: `/operator/projects/${project.id}/visibility`,
      payload: session.form({ visibility: 'owner' }),
      headers: session.headers,
    });

    const nonsense = await harness.server.inject({
      method: 'POST',
      url: `/operator/projects/${project.id}/visibility`,
      payload: session.form({ visibility: 'sideways' }),
      headers: session.headers,
    });
    assert.equal(nonsense.statusCode, 400);
    assert.equal(
      (await harness.store.projects.findOne({ _id: project.id }))?.visibility,
      'owner',
      'and the board it was protecting stays protected',
    );
  });

  it('forgets a cookie that opens nothing, so the navigation stops lying', async () => {
    // The navigation is drawn from the cookie's presence and nothing else, on
    // purpose: no page reads the database to decide one word. The cost is a
    // session that ended still saying "your projects" on the page asking the
    // same person to sign in, so the page that finds it dead drops it.
    const session = await signIn(harness, 'gone@example.com');
    await harness.store.operatorSessions.deleteMany({ email: 'gone@example.com' });

    const asked = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    assert.match(asked.body, /<h1>Sign in<\/h1>/);
    const dropped = String(asked.headers['set-cookie'] ?? '');
    assert.match(dropped, /muster_session=;/, 'and the cookie goes with it');

    // Somebody who was never signed in is answered without a header nobody
    // needs.
    const stranger = await harness.server.inject({ method: 'GET', url: '/operator' });
    assert.equal(stranger.headers['set-cookie'], undefined);

    // And an old tab posting an action, which is the commonest way to meet a
    // session that ended, is answered the same way.
    const posted = await harness.server.inject({
      method: 'POST',
      url: '/operator/aliases',
      payload: session.form({ names: 'somebody' }),
      headers: session.headers,
    });
    assert.equal(posted.statusCode, 401);
    assert.match(String(posted.headers['set-cookie'] ?? ''), /muster_session=;/);
  });

  it('links a person straight at the card, open on the board it lives on', async () => {
    // The link on this page and the sheet on the board are one feature: when
    // the sheets became addresses, a link built out of a search and a fragment
    // started landing on a board narrowed to one card, with the card shut.
    const project = await createProject(harness, 'my work');
    await claimFor(project, 'me@example.com');
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: {
        slug: 'ops:bridge-or-wait',
        title: 'Bridge it, or wait?',
        status: 'blocked',
        owner: 'me@example.com',
        actor: 'ops-loop',
      },
    });
    const readToken = project.readUrl.split('/r/')[1]!;

    const session = await signIn(harness, 'me@example.com');
    const view = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    const href = view.body.match(
      new RegExp(`/r/${readToken}/board\\?card=[^"]*ops%3Abridge-or-wait[^"]*`),
    )?.[0];
    assert.ok(href, view.body.slice(view.body.indexOf('Your work'), 2000));

    const board = await harness.server.inject({ method: 'GET', url: href.split('#')[0]! });
    assert.match(board.body, /class="peeked open"/, 'and the card is open when they arrive');
    assert.match(board.body, /Bridge it, or wait\?/);
  });

  it('names the card a question is about, the way the read view does', async () => {
    // Two things on this page need a decision, and only one of them said what
    // it was about. Blocked work linked its card; a question, which is the
    // other half of the same page and the half that arrives by mail, gave the
    // sentence and nothing else. The mail about that question names the card,
    // and so does the read view, so this was the one surface where answering
    // meant retyping a slug into a search box to see what the agent saw.
    const project = await createProject(harness, 'arbitrage fleet');
    await claimFor(project, 'me@example.com');
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'errors:venue-withdraw-stuck', title: 'Withdraws stuck', actor: 'errors-loop' },
    });
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/escalations`,
      headers: authed(project),
      payload: {
        agent: 'errors-loop',
        question: 'Bridge it or wait for a direct withdraw?',
        item_slug: 'errors:venue-withdraw-stuck',
      },
    });
    const readToken = project.readUrl.split('/r/')[1]!;

    const session = await signIn(harness, 'me@example.com');
    const view = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    const href = view.body.match(
      new RegExp(`/r/${readToken}/board\\?card=[^"]*errors%3Avenue-withdraw-stuck[^"]*`),
    )?.[0];
    assert.ok(href, view.body.slice(view.body.indexOf('Bridge it'), 1200));

    const board = await harness.server.inject({ method: 'GET', url: href });
    assert.match(board.body, /class="peeked open"/, 'and the card is open when they arrive');
    assert.match(board.body, /Withdraws stuck/);
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

    // A mail scanner fetching the URL must not spend it: it opens a page with a
    // button, and a crawler does not press buttons.
    const looked = await harness.server.inject({ method: 'GET', url: `/operator/${planted}` });
    assert.equal(looked.statusCode, 200);
    assert.ok(!String(looked.headers['set-cookie'] ?? '').includes('muster_session='));
    assert.equal(
      await harness.store.operatorTokens.countDocuments({ _id: 'o_legacy' }),
      1,
      'looking at it does not burn it',
    );

    const used = await harness.server.inject({ method: 'POST', url: `/operator/${planted}` });
    assert.equal(used.statusCode, 303);
    assert.equal(used.headers.location, '/operator');
    assert.ok(String(used.headers['set-cookie']).startsWith('muster_session='));

    // Burned. A URL that reached a log or a history before today stops being a
    // way in the moment its owner uses it.
    const again = await harness.server.inject({ method: 'POST', url: `/operator/${planted}` });
    assert.equal(again.statusCode, 404);
  });

  it('does not let the legacy route shadow the routes named after it', async () => {
    // /operator/verify and /operator/logout are static segments and must win
    // over /operator/:token, or signing in would look like redeeming a link.
    const project = await createProject(harness, 'routing');
    await claimFor(project, 'router@example.com');
    const session = await signIn(harness, 'router@example.com');
    assert.ok(session.cookie.startsWith('muster_session='));

    const out = await harness.server.inject({
      method: 'POST',
      url: '/operator/logout',
      payload: session.form({}),
      headers: session.headers,
    });
    assert.equal(out.statusCode, 200);
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

  it('issues a new token to the owner when an agent loses one', async () => {
    const project = await createProject(harness, 'lost the token');
    await claimFor(project, 'owner@example.com');
    const session = await signIn(harness, 'owner@example.com');

    const issued = await harness.server.inject({
      method: 'POST',
      url: `/operator/projects/${project.id}/keys`,
      payload: session.form({}),
      headers: session.headers,
    });
    assert.equal(issued.statusCode, 200);
    const token = issued.body.match(/<code>(mk_[a-z0-9]+)<\/code>/)?.[1];
    assert.ok(token, 'the token is shown once, here');

    // It works, and it is an admin key: the point is to be able to run the
    // project again, not to get a second worker credential.
    const used = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/keys`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(used.statusCode, 200);

    // The one that was merely lost still works. Somebody here because a key
    // leaked revokes it explicitly instead.
    const old = await harness.server.inject({
      method: 'GET',
      url: project.api,
      headers: authed(project),
    });
    assert.equal(old.statusCode, 200);
  });

  it('will not issue a token for somebody else’s project', async () => {
    const mine = await createProject(harness, 'mine');
    const theirs = await createProject(harness, 'theirs');
    await claimFor(mine, 'me@example.com');
    await claimFor(theirs, 'them@example.com');
    const session = await signIn(harness, 'me@example.com');

    const attempt = await harness.server.inject({
      method: 'POST',
      url: `/operator/projects/${theirs.id}/keys`,
      payload: session.form({}),
      headers: session.headers,
    });
    assert.equal(attempt.statusCode, 404, 'and it does not say whether that project exists');

    const unclaimed = await createProject(harness, 'nobody owns this');
    const orphan = await harness.server.inject({
      method: 'POST',
      url: `/operator/projects/${unclaimed.id}/keys`,
      payload: session.form({}),
      headers: session.headers,
    });
    assert.equal(orphan.statusCode, 404, 'owning nothing is not owning everything');

    // And a signed out browser gets nowhere near it.
    const anonymous = await harness.server.inject({
      method: 'POST',
      url: `/operator/projects/${mine.id}/keys`,
      payload: 'csrf=whatever',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(anonymous.statusCode, 401);
  });

  it('gathers the work assigned to you from every project at once', async () => {
    const fleet = await createProject(harness, 'fleet');
    const sygnal = await createProject(harness, 'sygnal');
    const theirs = await createProject(harness, 'theirs');
    await claimFor(fleet, 'alex@example.com');
    await claimFor(sygnal, 'alex@example.com');
    await claimFor(theirs, 'kasia@example.com');

    const item = (project: Project, payload: Record<string, unknown>) =>
      harness.server.inject({
        method: 'POST',
        url: `${project.api}/items`,
        headers: authed(project),
        payload,
      });

    await item(fleet, { slug: 'mine-here', title: 'stuck withdraw', owner: 'alex', actor: 'a' });
    await item(sygnal, { slug: 'mine-there', title: 'forecast drift', owner: 'alex', actor: 'a' });
    await item(fleet, { slug: 'somebody-elses', title: 'not mine', owner: 'kasia', actor: 'a' });
    await item(fleet, { slug: 'jammed', title: 'nobody can move this', status: 'blocked', actor: 'a' });
    await item(theirs, { slug: 'other-project', title: 'in another board', owner: 'alex', actor: 'a' });

    const session = await signIn(harness, 'alex@example.com');
    const view = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });

    assert.match(view.body, /Your work/);
    assert.match(view.body, /stuck withdraw/, 'from one project');
    assert.match(view.body, /forecast drift/, 'and from another');
    assert.match(view.body, /nobody can move this/, 'blocked work is somebody’s to unblock');
    assert.doesNotMatch(view.body, /not mine/, 'somebody else’s assignment is not mine');
    assert.doesNotMatch(
      view.body,
      /in another board/,
      'and a project I do not own is none of my business, whoever it names as owner',
    );
  });

  it('lets somebody say which names are theirs', async () => {
    const project = await createProject(harness, 'aliases');
    await claimFor(project, 'k.nowak@example.com');
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'by-nickname', title: 'filed under a nickname', owner: 'kn', actor: 'a' },
    });

    const session = await signIn(harness, 'k.nowak@example.com');
    const before = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    assert.doesNotMatch(before.body, /filed under a nickname/, 'nothing connects the two yet');

    const saved = await harness.server.inject({
      method: 'POST',
      url: '/operator/aliases',
      payload: session.form({ aliases: 'kn, kg' }),
      headers: session.headers,
    });
    assert.equal(saved.statusCode, 303);

    const after = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    assert.match(after.body, /filed under a nickname/);
  });

  it('offers the alias form even when there is nothing to show', async () => {
    const project = await createProject(harness, 'nothing of mine');
    await claimFor(project, 'empty@example.com');
    const session = await signIn(harness, 'empty@example.com');

    const view = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    // An empty list is exactly when somebody needs to say which names are
    // theirs, so hiding the form behind a non-empty list hides it when it
    // matters.
    assert.match(view.body, /Your work/);
    assert.match(view.body, /Names you answer to/);
  });

  it('counts an abandoned item as work waiting on somebody', async () => {
    const project = await createProject(harness, 'abandoned');
    await claimFor(project, 'owner@example.com');
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'dropped-by-a-crash', title: 'left half done', actor: 'a' },
    });
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/dropped-by-a-crash/claim`,
      headers: authed(project),
      payload: { agent: 'crashed-loop', ttl_minutes: 30 },
    });

    const session = await signIn(harness, 'owner@example.com');
    const held = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    assert.doesNotMatch(held.body, /left half done/, 'somebody is on it');

    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'dropped-by-a-crash' },
      { $set: { 'claim.expiresAt': new Date(Date.now() - 60_000) } },
    );
    const lapsed = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    assert.match(lapsed.body, /left half done/, 'and now nobody is');
  });

  it('does not send a second code on top of one that just went out', async () => {
    const project = await createProject(harness, 'impatient');
    await claimFor(project, 'twice@example.com');

    const ask = () =>
      harness.server.inject({
        method: 'POST',
        url: '/operator',
        payload: 'email=twice@example.com',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
    assert.equal((await ask()).statusCode, 200);
    const first = await harness.store.operatorCodes.findOne({ email: 'twice@example.com' });

    // The second press must leave the first code alone: whichever email lands
    // last would otherwise carry a code that no longer works.
    assert.equal((await ask()).statusCode, 200);
    const after = await harness.store.operatorCodes.findOne({ email: 'twice@example.com' });
    assert.equal(after!.codeHash, first!.codeHash, 'the code in the inbox is still the live one');
    assert.equal(await harness.store.operatorCodes.countDocuments({ email: 'twice@example.com' }), 1);
  });

  it('does not hold a cooldown for a code it failed to send', async () => {
    // Resend rejecting the message is the ordinary failure here. Leaving the
    // code stored would make the minute long cooldown refuse the retry, and the
    // one after that, until the hourly limit ran out, without a single message
    // having been delivered.
    let deliver: () => Promise<'sent'> = async () => {
      throw new Error('resend said no');
    };
    const isolated = await startHarness(
      { LIMIT_CLAIM_EMAILS_PER_HOUR: '100' },
      {
        mailer: {
          sendOperatorCode: () => deliver(),
          sendClaimCode: async () => 'sent',
          sendBoardOffer: async () => 'sent',
          sendQuietBoard: async () => 'sent',
            sendEscalation: async () => 'sent',
        },
      },
    );
    try {
      const ask = () =>
        isolated.server.inject({
          method: 'POST',
          url: '/operator',
          payload: 'email=bounces@example.com',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });

      const failed = await ask();
      // The person is told the same thing either way: a delivery failure that
      // reads differently from an unknown address is an account probe.
      assert.equal(failed.statusCode, 200);
      assert.equal(
        await isolated.store.operatorCodes.countDocuments({ email: 'bounces@example.com' }),
        0,
        'a code nobody received is not a code',
      );

      // So the retry, inside the cooldown, still sends.
      deliver = async () => 'sent';
      await ask();
      assert.equal(
        await isolated.store.operatorCodes.countDocuments({ email: 'bounces@example.com' }),
        1,
      );
    } finally {
      await isolated.stop();
    }
  });

  it('is findable by somebody looking for a way in', async () => {
    // The door was called "operator", which is our word for the person rather
    // than the word anybody scans a page for.
    const landing = await harness.server.inject({ method: 'GET', url: '/' });
    assert.match(landing.body, /Sign in/);
    assert.match(landing.body, /href="\/operator"/);
    assert.match(landing.body, />sign in</, 'and the nav says it too');

    const page = await harness.server.inject({ method: 'GET', url: '/operator' });
    assert.match(page.body, /<h1>Sign in<\/h1>/);
    assert.match(page.body, /<title>Sign in to Muster<\/title>/);

    // Once somebody is in, the same link is about their projects rather than
    // about getting in.
    const project = await createProject(harness, 'findable');
    await claimFor(project, 'finder@example.com');
    const session = await signIn(harness, 'finder@example.com');
    const inside = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    assert.match(inside.body, />your projects</);
    assert.doesNotMatch(inside.body, />sign in</);
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

  it('counts every question waiting, not the ones that fit on the page', async () => {
    // The page's whole promise is "everything waiting on you". A headline that
    // is really the size of its own first page breaks that quietly, and the
    // number a person reads decides whether they open it at all.
    const { createEscalation } = await import('../src/service.js');
    const busy = await createProject(harness, 'a hundred and five questions');
    await claimFor(busy, 'crowded@example.com');
    const doc = (await harness.store.projects.findOne({ _id: busy.id }))!;
    for (let index = 0; index < 105; index += 1) {
      await createEscalation(harness.store, doc, { agent: 'a', question: `q${index}` }, 'http');
    }

    const session = await signIn(harness, 'crowded@example.com');
    const page = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /105 questions for you/, 'the headline counts them all');
    assert.match(page.body, /Showing the 100 most urgent/, 'and says the list is a slice');
    // The per project column counts the project rather than the slice, which is
    // the same mistake one table along.
    assert.match(page.body, />105</);
  });
});

describe('a project made by somebody who is signed in', () => {
  it('belongs to them already, with no code to type', async () => {
    // The form used to hand a signed-in operator a board that expires in a
    // week and ask them to prove, with a code sent to their address, that they
    // are the person the browser was already holding a session for.
    const session = await signIn(harness, 'owner@example.com');
    const created = await harness.server.inject({
      method: 'POST',
      url: '/signup',
      payload: 'name=made-while-signed-in',
      headers: session.headers,
    });
    assert.equal(created.statusCode, 200);
    assert.match(created.body, /It is yours/);
    assert.doesNotMatch(created.body, /deleted in \d+ days/, 'it is nobody’s expiry now');

    const project = (await harness.store.projects.findOne({ name: 'made-while-signed-in' }))!;
    assert.equal(project.claimedBy, 'owner@example.com');
    assert.equal(project.expiresAt, null);
    assert.equal(project.tier, 'free');

    // And it is where they will look for it.
    const view = await harness.server.inject({
      method: 'GET',
      url: '/operator',
      headers: { cookie: session.cookie },
    });
    assert.match(view.body, /made-while-signed-in/);
  });

  it('is nobody’s when the form was posted from another site', async () => {
    // Ownership is the one thing a signed-in browser holds that a stranger's
    // form must not be able to spend. The project is still created, because
    // anybody may create one; it just is not theirs.
    const session = await signIn(harness, 'target@example.com');
    const created = await harness.server.inject({
      method: 'POST',
      url: '/signup',
      payload: 'name=planted',
      headers: { ...session.headers, 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(created.statusCode, 200);

    const project = (await harness.store.projects.findOne({ name: 'planted' }))!;
    assert.equal(project.claimedBy, null);
  });

  it('is nobody’s when nobody is signed in', async () => {
    const created = await harness.server.inject({
      method: 'POST',
      url: '/signup',
      payload: 'name=anonymous',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(created.statusCode, 200);
    assert.match(created.body, /deleted in \d+ days/);
    const project = (await harness.store.projects.findOne({ name: 'anonymous' }))!;
    assert.equal(project.claimedBy, null);
  });
});
