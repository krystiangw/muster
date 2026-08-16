import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hashToken } from '../src/ids.js';
import { authed, createProject, startHarness, type Harness, type Project } from './helper.js';

/**
 * The cross-project operator view. This is the piece our own station needed and
 * no board on the market has: the person who owns six projects should see one
 * queue, not six links.
 */

let harness: Harness;

before(async () => {
  harness = await startHarness();
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

async function operatorLink(email: string): Promise<string> {
  await harness.server.inject({
    method: 'POST',
    url: '/operator',
    payload: `email=${encodeURIComponent(email)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const record = await harness.store.operatorTokens.findOne(
    { email },
    { sort: { createdAt: -1 } },
  );
  assert.ok(record, 'a token must have been minted');
  // Only the hash is stored, so the test rebuilds the link the way the mail
  // does: by planting a token it knows. One per address, because the hash is
  // unique across the collection.
  const planted = `mk_test_${email.replace(/[^a-z0-9]/g, '')}`;
  await harness.store.operatorTokens.updateOne(
    { _id: record._id },
    { $set: { hash: hashToken(planted) } },
  );
  return `/operator/${planted}`;
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

    const link = await operatorLink('operator@example.com');
    const view = await harness.server.inject({ method: 'GET', url: link });
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

    const link = await operatorLink('boss@example.com');
    const answered = await harness.server.inject({
      method: 'POST',
      url: `${link}/escalations/${id}`,
      payload: 'status=wont_do&answer=Not+this+week',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
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

    const link = await operatorLink('me@example.com');
    const attempt = await harness.server.inject({
      method: 'POST',
      url: `${link}/escalations/${id}`,
      payload: 'status=answered&answer=hijack',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(attempt.statusCode, 403);
  });

  it('does not reveal whether an address owns anything', async () => {
    const unknown = await harness.server.inject({
      method: 'POST',
      url: '/operator',
      payload: 'email=stranger@example.com',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(unknown.statusCode, 200);
    assert.match(unknown.body, /If stranger@example.com has claimed any project/);
    assert.equal(await harness.store.operatorTokens.countDocuments({ email: 'stranger@example.com' }), 0);
  });
});
