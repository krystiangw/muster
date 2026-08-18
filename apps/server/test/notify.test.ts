import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  boardOfferMail,
  escalationMail,
  type BoardOffer,
  type EscalationNotice,
  type QuietBoard,
} from '../src/email.js';
import { runMigrations } from '../src/db.js';
import { authed, createProject, startHarness, type Harness, type Project } from './helper.js';

/**
 * The one thing in this server that pushes.
 *
 * Everything else waits to be read, which is right for a record and wrong for a
 * stop: an agent that asked a question at three in the morning is not working
 * until somebody answers, and the whole point of the escalation is that nobody
 * has to notice on their own. So these tests are about the two ways that can go
 * wrong: the message that never leaves, and the sixty that do.
 */

interface Sent {
  to: string;
  notice: EscalationNotice;
}

async function claimedProject(
  harness: Harness,
  email: string,
): Promise<Project> {
  const project = await createProject(harness, 'a board with an owner');
  await harness.store.projects.updateOne(
    { _id: project.id },
    { $set: { claimedBy: email, claimedAt: new Date(), expiresAt: null } },
  );
  return project;
}

async function withMailer(
  run: (harness: Harness, sent: Sent[]) => Promise<void>,
  outcome: 'sent' | 'throws' | 'discarded' = 'sent',
): Promise<void> {
  const sent: Sent[] = [];
  const harness = await startHarness(
    {},
    {
      mailer: {
        sendClaimCode: async () => 'sent',
        sendOperatorCode: async () => 'sent',
        sendBoardOffer: async () => 'sent',
        sendQuietBoard: async () => 'sent',
        sendEscalation: async (to, notice) => {
          if (outcome === 'throws') throw new Error('the provider said no');
          sent.push({ to, notice });
          return outcome === 'discarded' ? 'discarded' : 'sent';
        },
      },
    },
  );
  try {
    await run(harness, sent);
  } finally {
    await harness.stop();
  }
}

function ask(harness: Harness, project: Project, question: string, agent = 'errors-loop') {
  return harness.server.inject({
    method: 'POST',
    url: `${project.api}/escalations`,
    headers: authed(project),
    payload: { agent, question },
  });
}

describe('the mail an escalation sends', () => {
  it('reaches the person who owns the board, with the question and a way in', async () => {
    await withMailer(async (harness, sent) => {
      const project = await claimedProject(harness, 'owner@example.com');
      const filed = await ask(harness, project, 'Bridge it, or wait for the direct route?');
      assert.equal(filed.statusCode, 201);

      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.to, 'owner@example.com');
      assert.equal(sent[0]!.notice.question, 'Bridge it, or wait for the direct route?');
      assert.equal(sent[0]!.notice.agent, 'errors-loop');
      assert.equal(sent[0]!.notice.waiting, 1);
      assert.match(sent[0]!.notice.readUrl, /\/r\//);
    });
  });

  it('carries what the agent wrote for the person, not only the question', async () => {
    // The protocol asks an agent, in these words, to put enough in `question`
    // and `context` that a person reading it on a phone can decide without
    // opening anything else. The message that reaches the phone dropped the
    // context, so the one field written for this reader was the one field they
    // had to open a browser to see.
    await withMailer(async (harness, sent) => {
      const project = await claimedProject(harness, 'owner@example.com');
      await harness.server.inject({
        method: 'POST',
        url: `${project.api}/items`,
        headers: authed(project),
        payload: { slug: 'ops:bridge', title: 'the bridge', actor: 'errors-loop' },
      });
      await harness.server.inject({
        method: 'POST',
        url: `${project.api}/escalations`,
        headers: authed(project),
        payload: {
          agent: 'errors-loop',
          question: 'Bridge it, or wait for the direct route?',
          context: 'Pool depth on the bridge route is too thin, and waiting costs two days.',
          item_slug: 'ops:bridge',
        },
      });

      const notice = sent[0]!.notice;
      assert.match(notice.context ?? '', /Pool depth on the bridge route/);
      assert.equal(notice.itemSlug, 'ops:bridge');

      const { lines } = escalationMail(notice);
      const body = lines.join('\n');
      assert.match(body, /Pool depth on the bridge route is too thin/, 'the context is in the mail');
      assert.match(body, /the card "ops:bridge"/, 'and so is the card it is about');
    });
  });

  it('cuts a very long context, and says that it cut it', async () => {
    // The field takes eight thousand characters and a phone will render every
    // one of them above the link that answers the question. Deciding from a
    // paragraph that stopped mid sentence is worse than knowing it stopped.
    const { lines } = escalationMail({
      projectName: 'venue-ops',
      agent: 'errors-loop',
      question: 'Bridge it?',
      context: 'x'.repeat(5000),
      waiting: 1,
      readUrl: 'http://muster.test/r/r_x',
      operatorUrl: 'http://muster.test/operator',
      needsSignIn: false,
    });
    const body = lines.join('\n');
    assert.ok(body.length < 3000, `the whole message stays readable: ${body.length}`);
    assert.match(body, /the rest of the context is on the board/);
  });

  it('goes out for a question filed over MCP too', async () => {
    // The twin path. An interface that files the question and quietly skips
    // the one thing that reaches a human is the same class of fault the
    // verification pass found in the MCP inbox, and it would be invisible:
    // the escalation is there, the board shows it, nobody is told.
    await withMailer(async (harness, sent) => {
      const project = await claimedProject(harness, 'owner@example.com');
      const called = await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        headers: authed(project),
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'escalate',
            arguments: { question: 'bridge it or wait?', agent: 'errors-loop' },
          },
        },
      });
      assert.ok(called.json().result.structuredContent.escalation.id);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.to, 'owner@example.com');
      assert.equal(sent[0]!.notice.question, 'bridge it or wait?');
    });
  });

  it('says nothing to a project nobody has claimed', async () => {
    // There is no address to write to, and inventing one out of whoever created
    // the project would mean mailing a stranger because an agent said so.
    await withMailer(async (harness, sent) => {
      const project = await createProject(harness, 'unclaimed');
      assert.equal((await ask(harness, project, 'anybody there?')).statusCode, 201);
      assert.equal(sent.length, 0);
    });
  });

  it('sends once an hour however many questions arrive', async () => {
    await withMailer(async (harness, sent) => {
      const project = await claimedProject(harness, 'owner@example.com');
      await ask(harness, project, 'first');
      await ask(harness, project, 'second');
      await ask(harness, project, 'third');
      assert.equal(sent.length, 1, 'an agent in a loop must not be able to mail somebody sixty times');

      // An hour later the next one goes out, and it counts everything that
      // piled up in between rather than reporting only itself.
      await harness.store.projects.updateOne(
        { _id: project.id },
        { $set: { escalationNotifiedAt: new Date(Date.now() - 61 * 60_000) } },
      );
      await ask(harness, project, 'fourth');
      assert.equal(sent.length, 2);
      assert.equal(sent[1]!.notice.waiting, 4);
    });
  });

  it('comes back for the question the hour swallowed', async () => {
    // The throttle is right for a burst and wrong for the question that lands
    // inside another question's hour: nothing is sent, and the only record of
    // it is a page nobody has open. Two of the three questions on this
    // project's own board were in exactly that state this morning.
    await withMailer(async (harness, sent) => {
      const project = await claimedProject(harness, 'owner@example.com');
      await ask(harness, project, 'first, which sends');
      await ask(harness, project, 'second, which the hour swallows');
      await ask(harness, project, 'third, same');
      assert.equal(sent.length, 1, 'one message for the burst');

      // The hour passes, and the swallowed questions are old enough to count
      // as missed rather than as a notice still on its way.
      await harness.store.projects.updateOne(
        { _id: project.id },
        { $set: { escalationNotifiedAt: new Date(Date.now() - 2 * 3_600_000) } },
      );
      await harness.store.escalations.updateMany(
        { projectId: project.id, notifiedAt: null },
        { $set: { createdAt: new Date(Date.now() - 30 * 60_000) } },
      );

      assert.equal(await harness.notifier.sweepMissed(), 1, 'one project heard from');
      assert.equal(sent.length, 2);
      assert.match(sent[1]!.notice.question, /second/, 'the oldest one nobody had been told about');

      // And it does not turn into a nag: the hour it just claimed still holds.
      assert.equal(await harness.notifier.sweepMissed(), 0);
      assert.equal(sent.length, 2);

      // The third one is still owed a mention, and gets it an hour later.
      await harness.store.projects.updateOne(
        { _id: project.id },
        { $set: { escalationNotifiedAt: new Date(Date.now() - 2 * 3_600_000) } },
      );
      assert.equal(await harness.notifier.sweepMissed(), 1);
      assert.match(sent[2]!.notice.question, /third/);

      // Nothing is left owed, so a later pass is silent.
      await harness.store.projects.updateOne(
        { _id: project.id },
        { $set: { escalationNotifiedAt: new Date(Date.now() - 2 * 3_600_000) } },
      );
      assert.equal(await harness.notifier.sweepMissed(), 0);
      assert.equal(sent.length, 3);
    });
  });

  it('spends its batch on projects that can actually be told', async () => {
    // A slot spent on a board nobody owns is a slot a claimed board does not
    // get, and since neither entry goes away, the same unclaimed ones could
    // crowd out the same somebody for ever. Eligibility is decided before the
    // batch is cut.
    await withMailer(async (harness, sent) => {
      const orphans = [];
      for (let n = 0; n < 3; n += 1) {
        const orphan = await createProject(harness, `nobody owns this ${n}`);
        await ask(harness, orphan, `unanswerable ${n}`);
        orphans.push(orphan);
      }
      const owned = await claimedProject(harness, 'owner@example.com');
      await ask(harness, owned, 'this one has somebody to ask');
      // The owned project's question is the youngest of the four, so a pass
      // that cut its batch before checking ownership would sort it last.
      await harness.store.escalations.updateMany(
        {},
        { $set: { notifiedAt: null, createdAt: new Date(Date.now() - 30 * 60_000) } },
      );
      await harness.store.escalations.updateMany(
        { projectId: { $in: orphans.map((p) => p.id) } },
        { $set: { createdAt: new Date(Date.now() - 90 * 60_000) } },
      );
      // The owned board's own question already sent a notice, which claimed
      // its hour; the hour has to have passed for the sweep to have anything
      // to do at all.
      await harness.store.projects.updateOne(
        { _id: owned.id },
        { $set: { escalationNotifiedAt: new Date(Date.now() - 2 * 3_600_000) } },
      );
      sent.length = 0;

      assert.equal(await harness.notifier.sweepMissed(), 1);
      assert.equal(sent.length, 1);
      assert.match(sent[0]!.notice.question, /somebody to ask/);
    });
  });

  it('says nothing about a question that was answered before anybody was told', async () => {
    await withMailer(async (harness, sent) => {
      const project = await claimedProject(harness, 'owner@example.com');
      await ask(harness, project, 'first, which sends');
      const swallowed = await ask(harness, project, 'second, which the hour swallows');
      const id = swallowed.json().escalation.id;
      await harness.store.escalations.updateOne(
        { _id: id },
        { $set: { status: 'resolved', answeredAt: new Date(), createdAt: new Date(Date.now() - 30 * 60_000) } },
      );
      await harness.store.projects.updateOne(
        { _id: project.id },
        { $set: { escalationNotifiedAt: new Date(Date.now() - 2 * 3_600_000) } },
      );

      assert.equal(await harness.notifier.sweepMissed(), 0, 'a settled question needs no message');
      assert.equal(sent.length, 1);
    });
  });

  it('gives the hour back when the message did not leave', async () => {
    // A provider having a bad day would otherwise buy an hour of silence on the
    // strength of a message nobody received.
    await withMailer(async (harness, _sent) => {
      const project = await claimedProject(harness, 'owner@example.com');
      assert.equal((await ask(harness, project, 'first')).statusCode, 201);
      const after = await harness.store.projects.findOne({ _id: project.id });
      assert.equal(after?.escalationNotifiedAt ?? null, null);
    }, 'throws');
  });

  it('gives the hour back when there is no provider to send through', async () => {
    // A deployment with no mail key discards the message rather than throwing,
    // because it carries a link. Treating that as a delivery would silence
    // every question filed in the next hour, including the ones after somebody
    // fixes the configuration.
    await withMailer(async (harness, sent) => {
      const project = await claimedProject(harness, 'owner@example.com');
      await ask(harness, project, 'first');
      assert.equal(sent.length, 1, 'the notifier still tried');
      const after = await harness.store.projects.findOne({ _id: project.id });
      assert.equal(after?.escalationNotifiedAt ?? null, null);
    }, 'discarded');
  });

  it('files the question even when the mail fails', async () => {
    await withMailer(async (harness, _sent) => {
      const project = await claimedProject(harness, 'owner@example.com');
      const filed = await ask(harness, project, 'still filed?');
      assert.equal(filed.statusCode, 201);
      assert.equal(await harness.store.escalations.countDocuments({ projectId: project.id }), 1);
    }, 'throws');
  });

  /**
   * What somebody watching from outside can see. A queue waiting its turn and a
   * mail path refusing every send look identical on a board, and identical in a
   * log nobody reads, so the summary carries the two dates that tell them apart.
   */
  it('shows a question nobody was told about, and when a notice last went out', async () => {
    await withMailer(async (harness, sent) => {
      const project = await claimedProject(harness, 'owner@example.com');
      const summary = async () => {
        const read = await harness.server.inject({
          method: 'GET',
          url: project.api,
          headers: authed(project),
        });
        return read.json();
      };

      const quiet = await summary();
      assert.equal(quiet.oldest_unannounced_at, null, 'nothing has been asked yet');
      assert.equal(quiet.notice_sent_at, null);

      assert.equal((await ask(harness, project, 'the first one?')).statusCode, 201);
      assert.equal(sent.length, 1);
      const told = await summary();
      assert.equal(told.oldest_unannounced_at, null, 'the one that was mailed is not waiting');
      assert.ok(told.notice_sent_at, 'and the send is stamped on the project');

      // The second question inside the same hour is throttled, which is the
      // healthy silence: it waits to be named, and the stamp above stays put.
      assert.equal((await ask(harness, project, 'and the second?')).statusCode, 201);
      assert.equal(sent.length, 1, 'one message per project per hour');
      const waiting = await summary();
      assert.ok(waiting.oldest_unannounced_at, 'the throttled one is visible as unannounced');
      assert.equal(waiting.notice_sent_at, told.notice_sent_at);

      // And it stops being visible the moment somebody deals with it, so the
      // number cannot latch on a question that is no longer waiting.
      const second = await harness.store.escalations.findOne({
        projectId: project.id,
        notifiedAt: null,
      });
      await harness.server.inject({
        method: 'PATCH',
        url: `${project.api}/escalations/${second!._id}`,
        headers: authed(project),
        payload: { status: 'answered', answer: 'done' },
      });
      assert.equal((await summary()).oldest_unannounced_at, null);
    });
  });

  it('starts a board that was already mailing with the date it last did', async () => {
    // The field arrived after the mail did. Read off the questions themselves,
    // where the same success path stamps the same instant, so a board that has
    // been mailing for weeks does not read as one that never has.
    await withMailer(async (harness, sent) => {
      const project = await claimedProject(harness, 'owner@example.com');
      assert.equal((await ask(harness, project, 'mailed before the field?')).statusCode, 201);
      assert.equal(sent.length, 1);

      await harness.store.projects.updateOne(
        { _id: project.id },
        { $unset: { escalationNoticeSentAt: '' } },
      );
      await runMigrations(harness.store);

      const read = await harness.server.inject({
        method: 'GET',
        url: project.api,
        headers: authed(project),
      });
      const stamped = read.json().notice_sent_at;
      assert.ok(stamped, 'the board was mailing, and now says so');
      const escalation = await harness.store.escalations.findOne({ projectId: project.id });
      assert.equal(new Date(stamped).getTime(), escalation!.notifiedAt!.getTime());
    });
  });

  it('does not call the throttle claim a delivery', async () => {
    // The claim is taken before the provider is asked, atomically, so that two
    // agents filing at once cannot both mail. A send that throws rolls it back,
    // but a process that dies in between does not, and anything watching this
    // service would read the leftover claim as a message that went out.
    await withMailer(async (harness, _sent) => {
      const project = await claimedProject(harness, 'owner@example.com');
      assert.equal((await ask(harness, project, 'did anything leave?')).statusCode, 201);

      // The claim, left behind as a process that died between taking it and
      // rolling it back would leave it. Written by hand because that is the
      // only way to have it: every path through the code either sends or rolls
      // it back, which is exactly why the leftover is invisible when it happens.
      await harness.store.projects.updateOne(
        { _id: project.id },
        { $set: { escalationNotifiedAt: new Date() } },
      );

      const read = await harness.server.inject({
        method: 'GET',
        url: project.api,
        headers: authed(project),
      });
      assert.equal(read.json().notice_sent_at, null, 'the provider refused, so nothing left');
      assert.ok(read.json().oldest_unannounced_at, 'and the question is still waiting');
    }, 'throws');
  });
});

describe('the board an agent set up for somebody', () => {
  it('writes to them once, with the link and what taking it does', async () => {
    // Before this, an agent could name its operator and the offer sat in a
    // view that person had never opened: the only thing that reached them was
    // the agent telling them over some channel we cannot see.
    const offers: Array<{ to: string; offer: BoardOffer }> = [];
    const harness = await startHarness(
      {},
      {
        mailer: {
          sendClaimCode: async () => 'sent',
          sendOperatorCode: async () => 'sent',
          sendEscalation: async () => 'sent',
          sendQuietBoard: async () => 'sent',
          sendBoardOffer: async (to, offer) => {
            offers.push({ to, offer });
            return 'sent';
          },
        },
      },
    );
    try {
      const created = await harness.server.inject({
        method: 'POST',
        url: '/p',
        payload: {
          name: 'arbitrage fleet',
          owner_email: 'human@example.com',
          owner_note: 'board for the arbitrage loops',
          agent: 'errors-loop',
        },
      });
      assert.equal(created.statusCode, 201);
      assert.equal(offers.length, 1, 'one message, and only one');

      const { to, offer } = offers[0]!;
      assert.equal(to, 'human@example.com');
      assert.equal(offer.agent, 'errors-loop');
      assert.match(offer.readUrl, /\/r\/r_/);
      const { subject, lines } = boardOfferMail(offer);
      const text = lines.join('\n');
      assert.match(subject, /arbitrage fleet/);
      assert.match(text, /board for the arbitrage loops/, 'why, in the agent’s words');
      assert.match(text, /Ignore this and nothing happens/, 'and how to do nothing about it');
      assert.doesNotMatch(text, /mk_/, 'never the token');

      // The offer is recorded as well, so the one click is waiting for them
      // whichever way they arrive.
      const project = (await harness.store.projects.findOne({ name: 'arbitrage fleet' }))!;
      const share = await harness.store.shares.findOne({ projectId: project._id });
      assert.equal(share?.email, 'human@example.com');
      assert.equal(project.claimedBy, null, 'naming somebody is not deciding for them');
    } finally {
      await harness.stop();
    }
  });

  it('says nothing to anybody when the agent named no one', async () => {
    await withMailer(async (harness, _sent) => {
      const created = await harness.server.inject({
        method: 'POST',
        url: '/p',
        payload: { name: 'quiet' },
      });
      assert.equal(created.statusCode, 201);
      const project = (await harness.store.projects.findOne({ name: 'quiet' }))!;
      assert.equal(await harness.store.shares.countDocuments({ projectId: project._id }), 0);
    });
  });
});

describe('a board that stopped moving', () => {
  /** Everything about this pass is a clock, so the clock is the fixture. */
  async function quietHarness(): Promise<{ harness: Harness; sent: QuietBoard[] }> {
    const sent: QuietBoard[] = [];
    const harness = await startHarness(
      {},
      {
        mailer: {
          sendClaimCode: async () => 'sent',
          sendOperatorCode: async () => 'sent',
          sendEscalation: async () => 'sent',
          sendBoardOffer: async () => 'sent',
          sendQuietBoard: async (_to, notice) => {
            sent.push(notice);
            return 'sent';
          },
        },
      },
    );
    return { harness, sent };
  }

  async function goQuiet(harness: Harness, project: Project, hours: number): Promise<void> {
    const when = new Date(Date.now() - hours * 3_600_000);
    await harness.store.items.updateMany(
      { projectId: project.id },
      { $set: { touchedAt: when, updatedAt: when, stale: true, staleSince: when } },
    );
  }

  it('tells the operator once, and only when hygiene agrees the work is rotting', async () => {
    const { harness, sent } = await quietHarness();
    try {
      const project = await createProject(harness);
      await harness.server.inject({
        method: 'POST',
        url: `${project.api}/items`,
        headers: authed(project),
        payload: { slug: 'work', title: 'something', body: 'that nobody finished', actor: 'a' },
      });
      await harness.store.projects.updateOne(
        { _id: project.id },
        { $set: { claimedBy: 'owner@example.com', claimedAt: new Date(), expiresAt: null } },
      );

      // Busy: nothing to say.
      assert.equal(await harness.notifier.sweepQuiet(), 0);

      await goQuiet(harness, project, 30);
      assert.equal(await harness.notifier.sweepQuiet(), 1);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.open, 1);
      assert.equal(sent[0]!.stale, 1);
      assert.ok(sent[0]!.quietFor >= 29);

      // One per quiet spell: the board is still quiet, and saying it again
      // adds nothing that was not true the first time.
      assert.equal(await harness.notifier.sweepQuiet(), 0);
      assert.equal(sent.length, 1);

      // A write puts it back to work, and a board being worked on is not quiet.
      await harness.server.inject({
        method: 'POST',
        url: `${project.api}/items/work/timeline`,
        headers: authed(project),
        payload: { message: 'back on it', actor: 'a' },
      });
      assert.equal(await harness.notifier.sweepQuiet(), 0, 'a board being worked on is not quiet');

      // Then it stops again, which is a different silence and worth one more
      // message. Written as the relation that decides it rather than by
      // waiting a day: the last write is after the last notice.
      await goQuiet(harness, project, 30);
      await harness.store.projects.updateOne(
        { _id: project.id },
        { $set: { quietNotifiedAt: new Date(Date.now() - 40 * 3_600_000) } },
      );
      assert.equal(await harness.notifier.sweepQuiet(), 1);
      assert.equal(sent.length, 2);
    } finally {
      await harness.stop();
    }
  });

  it('keeps its stamp only when the message actually left', async () => {
    // A deployment with no mail provider answers `discarded`: nothing left the
    // building, and nothing was written to a log either. Keeping the stamp
    // there means the board is never told, including after somebody
    // configures the provider.
    const sent: QuietBoard[] = [];
    const harness = await startHarness(
      {},
      {
        mailer: {
          sendClaimCode: async () => 'sent',
          sendOperatorCode: async () => 'sent',
          sendEscalation: async () => 'sent',
          sendBoardOffer: async () => 'sent',
          sendQuietBoard: async (_to, notice) => {
            sent.push(notice);
            return sent.length === 1 ? 'discarded' : 'sent';
          },
        },
      },
    );
    try {
      const project = await createProject(harness);
      await harness.server.inject({
        method: 'POST',
        url: `${project.api}/items`,
        headers: authed(project),
        payload: { slug: 'work', title: 't', body: 'b', actor: 'a' },
      });
      await harness.store.projects.updateOne(
        { _id: project.id },
        { $set: { claimedBy: 'owner@example.com', claimedAt: new Date(), expiresAt: null } },
      );
      const when = new Date(Date.now() - 30 * 3_600_000);
      await harness.store.items.updateMany(
        { projectId: project.id },
        { $set: { touchedAt: when, updatedAt: when, stale: true, staleSince: when } },
      );

      assert.equal(await harness.notifier.sweepQuiet(), 0, 'nothing left, so nothing counted');
      const after = (await harness.store.projects.findOne({ _id: project.id }))!;
      assert.ok(!after.quietNotifiedAt, 'and the board is not marked as told');

      // Configured, and the same board is told on the next pass.
      assert.equal(await harness.notifier.sweepQuiet(), 1);
      assert.equal(sent.length, 2);
    } finally {
      await harness.stop();
    }
  });

  it('says nothing about a board nobody owns, or one with nothing rotting', async () => {
    const { harness, sent } = await quietHarness();
    try {
      const orphan = await createProject(harness);
      await harness.server.inject({
        method: 'POST',
        url: `${orphan.api}/items`,
        headers: authed(orphan),
        payload: { slug: 'work', title: 't', body: 'b', actor: 'a' },
      });
      await goQuiet(harness, orphan, 40);
      assert.equal(await harness.notifier.sweepQuiet(), 0, 'nobody to tell');

      const parked = await createProject(harness);
      await harness.server.inject({
        method: 'POST',
        url: `${parked.api}/items`,
        headers: authed(parked),
        payload: { slug: 'work', title: 't', body: 'b', actor: 'a' },
      });
      await harness.store.projects.updateOne(
        { _id: parked.id },
        { $set: { claimedBy: 'owner@example.com', claimedAt: new Date(), expiresAt: null } },
      );
      const when = new Date(Date.now() - 40 * 3_600_000);
      await harness.store.items.updateMany(
        { projectId: parked.id },
        { $set: { touchedAt: when, updatedAt: when, stale: false, staleSince: null } },
      );
      // Quiet, but hygiene has not called anything rotten: that is work
      // somebody parked, and this notice is not a reminder service.
      assert.equal(await harness.notifier.sweepQuiet(), 0);
      assert.equal(sent.length, 0);
    } finally {
      await harness.stop();
    }
  });
});
