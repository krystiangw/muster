import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { createMailer } from '../src/email.js';

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
