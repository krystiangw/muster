import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EscalationNotice } from '../src/email.js';
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
        sendOperatorLink: async () => 'sent',
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
});
