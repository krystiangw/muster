import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { boardOfferMail, createMailer, escalationMail } from '../src/email.js';

/**
 * What actually goes over the wire to the mail provider.
 *
 * The rest of the suite exercises the mailer through a stub, which proves the
 * routes handle a delivery and a failure but never looks at the message. These
 * two assertions are about the envelope.
 */
async function captured(env: Record<string, string>): Promise<Record<string, unknown>> {
  const sent: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body?: string } = {}) => {
    sent.push(JSON.parse(init.body ?? '{}'));
    return { ok: true, status: 200, text: async () => '' } as Response;
  }) as typeof fetch;
  try {
    const config = loadConfig({ RESEND_API_KEY: 'test-key', NODE_ENV: 'production', ...env });
    const mailer = createMailer(config, () => undefined);
    const delivery = await mailer.sendOperatorCode('someone@example.com', '123456');
    assert.equal(delivery, 'sent');
  } finally {
    globalThis.fetch = original;
  }
  return sent[0]!;
}

describe('the message that leaves', () => {
  it('sends replies to the address this deployment publishes', async () => {
    // A deployment sends from wherever its provider is verified, which is not
    // always where anybody reads. Somebody replying to a sign in code is a
    // person asking a question.
    const body = await captured({
      EMAIL_FROM: 'Muster <muster@sends-only.example>',
      CONTACT_EMAIL: 'hello@example.com',
    });
    assert.equal(body.from, 'Muster <muster@sends-only.example>');
    assert.deepEqual(body.to, ['someone@example.com']);
    assert.equal(body.reply_to, 'hello@example.com');
    assert.match(String(body.subject), /123456/);
    assert.match(String(body.text), /15 minutes/);
  });

  it('leaves the reply address out when there is nobody to write to', async () => {
    const body = await captured({ EMAIL_FROM: 'Muster <muster@sends-only.example>' });
    assert.ok(!('reply_to' in body), 'an empty reply-to is worse than none');
  });
});

describe('the message a person reads on a phone', () => {
  // Every line written here is hard wrapped at 78. The two fields an agent
  // supplies went out exactly as sent, so a question and a context written as
  // one paragraph arrived as one line of several hundred characters in the
  // middle of a message shaped for a narrow screen. The context is the field
  // the protocol asks for in those words: enough that somebody can decide
  // without opening anything else.
  const long = (words: number): string =>
    Array.from({ length: words }, (_, at) => `word${at}`).join(' ');

  const tooWide = (lines: string[]): string[] =>
    lines
      .join('\n')
      .split('\n')
      // A bare URL is one word and cannot be broken; everything else can.
      .filter((line) => line.length > 78 && line.includes(' '));

  it('wraps what the agent wrote, in the question and in the context', () => {
    const mail = escalationMail({
      projectName: 'arbitrage-fleet',
      agent: 'errors-loop',
      question: long(40),
      context: `${long(120)}\n\n${long(40)}`,
      itemSlug: 'errors:venue-withdraw-stuck',
      waiting: 3,
      readUrl: 'https://musterboard.dev/r/r_zevvf43z288j5mbv',
      operatorUrl: 'https://musterboard.dev/operator',
      needsSignIn: false,
    });
    assert.deepEqual(tooWide(mail.lines), []);
    // And a paragraph the writer put in survives being wrapped.
    assert.match(mail.lines.join('\n'), /\n\n/);
  });

  it('keeps the shape of a context somebody wrote as a list', () => {
    // Indentation is content once the text came from somebody else. An agent
    // writing its context as nested bullets means what the leading spaces say,
    // and splitting on spaces dropped them: "  - child" arrived as "- child",
    // one level up from where it was written.
    const mail = escalationMail({
      projectName: 'arbitrage-fleet',
      agent: 'errors-loop',
      question: 'Bridge it or wait?',
      context: `Two ways out:\n- bridge, ${long(30)}\n  - costs 0.4 percent\n- wait, ${long(30)}`,
      waiting: 1,
      readUrl: 'https://musterboard.dev/r/r_zevvf43z288j5mbv',
      operatorUrl: 'https://musterboard.dev/operator',
      needsSignIn: false,
    });
    const body = mail.lines.join('\n');
    assert.deepEqual(tooWide(mail.lines), []);
    assert.match(body, /\n- bridge,/);
    assert.match(body, /\n {2}- costs 0\.4 percent/);
    // And the line that wrapped kept its own indentation on the way over.
    for (const line of body.split('\n')) {
      if (line.startsWith('  ') && line.trim() !== '') assert.ok(line.startsWith('  '));
    }
  });

  it('wraps the note on an offer, which is five hundred characters of somebody else', () => {
    const mail = boardOfferMail({
      projectName: 'arbitrage-fleet',
      agent: 'errors-loop',
      note: long(90),
      readUrl: 'https://musterboard.dev/r/r_zevvf43z288j5mbv',
      expiresInDays: 7,
    });
    assert.deepEqual(tooWide(mail.lines), []);
  });
});
