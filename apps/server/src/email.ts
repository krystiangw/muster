import type { Config } from './config.js';

/**
 * Resend over plain fetch. The SDK would add a dependency to send one message
 * type, and the one message type is six digits long.
 */
export interface Mailer {
  sendClaimCode(to: string, code: string, projectName: string): Promise<'sent' | 'logged'>;
}

export function createMailer(config: Config, log: (msg: string) => void): Mailer {
  return {
    async sendClaimCode(to, code, projectName) {
      if (!config.resendApiKey) {
        // Development and self-host without email configured: the code goes to
        // the log rather than nowhere, so a local operator can still finish the
        // claim.
        log(`claim code for ${to} (${projectName}): ${code}`);
        return 'logged';
      }
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.resendApiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: config.emailFrom,
          to: [to],
          subject: `Your Muster code: ${code}`,
          text: [
            `${code} is your code to claim the Muster project "${projectName}".`,
            '',
            'Claiming it removes the expiry, raises the limits and gives you the operator view.',
            'The code is valid for 15 minutes.',
            '',
            'If an agent you do not recognise asked for this, ignore this message.',
            'The project it belongs to expires on its own.',
          ].join('\n'),
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`resend failed: ${response.status} ${body.slice(0, 200)}`);
      }
      return 'sent';
    },
  };
}
