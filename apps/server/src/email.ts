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
  /**
   * What the agent wrote under the question.
   *
   * The protocol asks for it in those words: put enough in `question` and
   * `context` that a person reading it on a phone can decide without opening
   * anything else. The message that reaches the phone dropped it, so the one
   * field written for this reader was the one field they had to open a browser
   * to see.
   */
  context?: string;
  /** The card it is about, when the agent named one. */
  itemSlug?: string | null;
  /** How many questions on this project are open, this one included. */
  waiting: number;
  /** Where to answer it. The read link, or the sign in page for a private project. */
  readUrl: string;
  operatorUrl: string;
  /** Whether that link asks them to sign in first. */
  needsSignIn: boolean;
}

/** What a board an agent set up for somebody says to that somebody. */
export interface BoardOffer {
  projectName: string;
  /** The agent that named this address, as it named itself. */
  agent: string;
  /** Why, in the agent's words. Empty when it did not say. */
  note: string;
  /** The page the board lives on, where taking it is one click. */
  readUrl: string;
  /** How many days an unclaimed board has before it deletes itself. */
  expiresInDays: number;
}

export interface Mailer {
  sendClaimCode(to: string, code: string, projectName: string): Promise<Delivery>;
  sendOperatorCode(to: string, code: string): Promise<Delivery>;
  sendEscalation(to: string, notice: EscalationNotice): Promise<Delivery>;
  sendBoardOffer(to: string, offer: BoardOffer): Promise<Delivery>;
}

/**
 * The message that reaches a person an agent set a board up for.
 *
 * Until this existed, an agent could name its operator and the offer sat in a
 * view that person had never opened: the only way they heard about it was the
 * agent telling them itself, over some channel we cannot see. This is the one
 * message this service sends to an address that never asked for anything, so
 * it is written to be dismissible in one line and to say who is responsible
 * for it arriving.
 */
export function boardOfferMail(offer: BoardOffer): { subject: string; lines: string[] } {
  const note = offer.note.trim();
  return {
    subject: `An agent set up a Muster board for you: ${offer.projectName}`,
    lines: [
      `${offer.agent} created a board called "${offer.projectName}" and named this address as`,
      'the person it answers to.',
      ...(note === '' ? [] : ['', `It said: ${note}`]),
      '',
      'The board is here, and taking it is one click on that page:',
      offer.readUrl,
      '',
      'Taking it removes the expiry, raises the limits and gives you a view of every',
      'board you own, with the questions the agents are waiting on you for.',
      '',
      `Ignore this and nothing happens: an unclaimed board deletes itself, with all of`,
      `its data, ${offer.expiresInDays} days after it was created. You are not subscribed to anything,`,
      'and nothing was created in your name.',
    ],
  };
}

/**
 * How much of an agent's context a message carries.
 *
 * Whole, up to a point: the field takes eight thousand characters and a mail
 * client on a phone will happily render every one of them above the link that
 * answers the question. What is cut is said out loud rather than trailing off,
 * because a person deciding from a truncated paragraph should know it was one.
 */
const CONTEXT_IN_MAIL = 1200;

/**
 * The message an escalation sends, as text.
 *
 * Separated from the sending so it can be read in a test: this is the only
 * thing this service writes to somebody who is not looking at it, and until
 * this existed nothing checked what it said.
 */
export function escalationMail(notice: EscalationNotice): { subject: string; lines: string[] } {
  const others = notice.waiting - 1;
  const context = (notice.context ?? '').trim();
  const cut = context.length > CONTEXT_IN_MAIL;
  return {
    // The subject carries the project and the count, because this arrives on a
    // phone at three in the morning and the decision to open it now or at
    // breakfast is made from the subject line alone.
    subject:
      others > 0
        ? `${notice.projectName}: ${notice.waiting} questions waiting for you`
        : `${notice.projectName}: an agent is waiting on you`,
    lines: [
      `${notice.agent} stopped and asked:`,
      '',
      notice.question,
      ...(context === ''
        ? []
        : [
            '',
            cut ? `${context.slice(0, CONTEXT_IN_MAIL)}...` : context,
            ...(cut ? ['', '(the rest of the context is on the board)'] : []),
          ]),
      ...(notice.itemSlug ? ['', `It is about the card "${notice.itemSlug}".`] : []),
      '',
      `Answer it here: ${notice.readUrl}`,
      ...(others > 0
        ? [
            others === 1
              ? '1 other question on this project is open on the same page.'
              : `${others} other questions on this project are open on the same page.`,
          ]
        : []),
      '',
      ...(notice.needsSignIn
        ? [
            'You narrowed this project to its owner, so that page asks for your',
            'address and a six digit code first. No account, no password.',
          ]
        : [
            'The page needs no sign in, so anyone holding that link can answer your',
            'agents on your behalf and change the board. Treat it like a password.',
            '',
            `Every project you own: ${notice.operatorUrl}`,
          ]),
      '',
      'One message per project per hour, whatever they ask in between.',
    ],
  };
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
      // Node's fetch waits for ever by default, and this call is awaited on
      // the request path: an escalation is filed and then the agent sits there
      // while a provider having a bad minute holds the socket open. Eight
      // seconds, then the notifier treats it as a failure and gives the hour
      // back, which is the behaviour it already has for every other failure.
      signal: AbortSignal.timeout(8000),
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
      const { subject, lines } = escalationMail(notice);
      return send(to, subject, lines);
    },
    async sendBoardOffer(to, offer) {
      const { subject, lines } = boardOfferMail(offer);
      return send(to, subject, lines);
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
