import type { Config } from './config.js';

/**
 * Resend over plain fetch. The SDK would add a dependency to send one message
 * type, and the one message type is six digits long.
 */
/**
 * What happened to a message. `logged` is the development fallback, where the
 * content went to the terminal on purpose. `discarded` is a deployment with no
 * mail provider configured: the message carried a credential, so it went
 * nowhere, and the caller has to say so rather than report success.
 */
export type Delivery = 'sent' | 'logged' | 'discarded';

export interface Mailer {
  sendClaimCode(to: string, code: string, projectName: string): Promise<Delivery>;
  sendOperatorLink(to: string, url: string, projectCount: number): Promise<Delivery>;
}

/** Enough of an address to match it to a report, not enough to be a mailing list. */
function redactAddress(address: string): string {
  const [name = '', domain = ''] = address.split('@');
  return `${name.slice(0, 2)}***@${domain}`;
}

export function createMailer(config: Config, log: (msg: string) => void): Mailer {
  async function send(to: string, subject: string, lines: string[]): Promise<Delivery> {
    if (!config.resendApiKey) {
      // The fallback exists so a local run and a self-host with no outbound
      // mail can still finish a claim. What it prints is a live credential
      // though: a six digit code, or an operator link that anybody holding can
      // answer somebody's agents with. On production that goes nowhere near the
      // log, and the missing key is reported as the operational fault it is.
      if (config.logUnsentEmails) {
        log(`email to ${to} [${subject}]: ${lines.join(' | ')}`);
        return 'logged';
      }
      log(
        `email to ${redactAddress(to)} was not sent: RESEND_API_KEY is not configured. The message is discarded rather than logged, because it carries a credential.`,
      );
      return 'discarded';
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.resendApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: config.emailFrom, to: [to], subject, text: lines.join('\n') }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`resend failed: ${response.status} ${body.slice(0, 200)}`);
    }
    return 'sent';
  }

  return {
    async sendOperatorLink(to, url, projectCount) {
      return send(to, 'Your Muster projects', [
        `You asked for the link to everything you own on Muster: ${projectCount} project(s).`,
        '',
        url,
        '',
        'It stays valid, so keep it or bookmark it. Anyone holding it can answer',
        'your agents on your behalf, so treat it like a password.',
        '',
        'If you did not ask for this, ignore the message. Nothing changed.',
      ]);
    },
    async sendClaimCode(to, code, projectName) {
      // Without an API key the code goes to the log rather than nowhere, so a
      // local operator and a self-host with no outbound mail can still finish
      // the claim.
      return send(to, `Your Muster code: ${code}`, [
        `${code} is your code to claim the Muster project "${projectName}".`,
        '',
        'Claiming it removes the expiry, raises the limits and gives you the operator view.',
        'The code is valid for 15 minutes.',
        '',
        'If an agent you do not recognise asked for this, ignore this message.',
        'The project it belongs to expires on its own.',
      ]);
    },
  };
}
