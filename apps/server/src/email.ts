import type { Config } from './config.js';

/**
 * Resend over plain fetch. The SDK would add a dependency to send one message
 * type, and the one message type is six digits long.
 */
export interface Mailer {
  sendClaimCode(to: string, code: string, projectName: string): Promise<'sent' | 'logged'>;
  sendOperatorLink(to: string, url: string, projectCount: number): Promise<'sent' | 'logged'>;
}

export function createMailer(config: Config, log: (msg: string) => void): Mailer {
  async function send(to: string, subject: string, lines: string[]): Promise<'sent' | 'logged'> {
    if (!config.resendApiKey) {
      log(`email to ${to} [${subject}]: ${lines.join(' | ')}`);
      return 'logged';
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
