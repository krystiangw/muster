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

/** What one notification says about the project it came from. */
export interface EscalationNotice {
  projectName: string;
  agent: string;
  question: string;
  /** How many questions on this project are open, this one included. */
  waiting: number;
  /** Where to answer it. The read link, or the sign in page for a private project. */
  readUrl: string;
  operatorUrl: string;
  /** Whether that link asks them to sign in first. */
  needsSignIn: boolean;
}

export interface Mailer {
  sendClaimCode(to: string, code: string, projectName: string): Promise<Delivery>;
  sendOperatorCode(to: string, code: string): Promise<Delivery>;
  sendOperatorLink(to: string, url: string, projectCount: number): Promise<Delivery>;
  sendEscalation(to: string, notice: EscalationNotice): Promise<Delivery>;
}

/** Enough of an address to match it to a report, not enough to be a mailing list. */
export function redactAddress(address: string): string {
  const [name = '', domain = ''] = address.split('@');
  return `${name.slice(0, 2)}***@${domain}`;
}

/** The shared sender Resend hands out before a domain is verified. */
const SHARED_SENDER = 'resend.dev';

export function createMailer(config: Config, log: (msg: string) => void): Mailer {
  // Resend accepts this sender from anybody and delivers it to one mailbox:
  // the one that owns the key. A deployment serving other people cannot sign
  // any of them in, and the failure looks like "the code never arrived", which
  // is the hardest kind to attribute. Say it at boot instead.
  if (config.resendApiKey && config.emailFrom.includes(SHARED_SENDER)) {
    log(
      `EMAIL_FROM uses ${SHARED_SENDER}, which Resend delivers only to the address that owns the API key. Codes for everybody else will be accepted and never arrive. Set EMAIL_FROM to an address on a verified domain.`,
    );
  }

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
      body: JSON.stringify({
        from: config.emailFrom,
        to: [to],
        subject,
        text: lines.join('\n'),
        // The sender can be a domain that only sends: a deployment sends from
        // wherever its provider is verified, which is not always where anybody
        // reads. Somebody replying to a sign in code is a person asking a
        // question, and their reply should reach the address this deployment
        // publishes rather than a mailbox nobody opens.
        ...(config.contactEmail ? { reply_to: config.contactEmail } : {}),
      }),
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
    async sendOperatorCode(to, code) {
      // A code rather than a link, on purpose. A link in a mail ends up in the
      // browser history, in the Referer of whatever the person clicks next, and
      // in whatever forwards the message; six digits typed into a form end up
      // nowhere. It is also the same gesture as claiming a project, so there is
      // one thing for a person to learn instead of two.
      return send(to, `Your Muster code: ${code}`, [
        `${code} signs you in to your Muster projects.`,
        '',
        'The code is valid for 15 minutes and can be used once. Signing in gives',
        'this browser access for 30 days; you can end it from the view itself.',
        '',
        'If you did not ask for this, ignore the message. Nothing changed, and',
        'nobody learned anything about this address.',
      ]);
    },
    async sendEscalation(to, notice) {
      // The subject carries the project and the count, because this arrives on
      // a phone at three in the morning and the decision to open it now or at
      // breakfast is made from the subject line alone.
      const others = notice.waiting - 1;
      return send(
        to,
        others > 0
          ? `${notice.projectName}: ${notice.waiting} questions waiting for you`
          : `${notice.projectName}: an agent is waiting on you`,
        [
          `${notice.agent} stopped and asked:`,
          '',
          notice.question,
          '',
          `Answer it here: ${notice.readUrl}`,
          ...(others > 0
            ? [`${others} other question(s) on this project are open on the same page.`]
            : []),
          '',
          ...(notice.needsSignIn
            ? [
                'You narrowed this project to its owner, so that page asks for your',
                'address and a six digit code first. No account, no password.',
              ]
            : [
                'The page needs no sign in, so anyone holding that link can answer your',
                'agents on your behalf. Treat it like a password.',
                '',
                `Every project you own: ${notice.operatorUrl}`,
              ]),
          '',
          'One message per project per hour, whatever they ask in between.',
        ],
      );
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
