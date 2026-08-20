import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { redactAddress, type Mailer } from '../email.js';
import { chip, count, escapeHtml, when } from '../html.js';
import { page } from '../page.js';
import { who } from '../identity.js';
import { fromOurPage, originOf } from '../origin.js';
import { hashToken, newId, newOtpCode } from '../ids.js';
import { codeAttemptKey, type RateLimiter } from '../rateLimit.js';
import {
  ServiceError,
  acceptShare,
  answerEscalation,
  createApiKey,
  looksLikeEmail,
  updateProject,
} from '../service.js';
import {
  checkCsrf,
  csrfField,
  endSession,
  forgetDeadSession,
  readSession,
  startSession,
  type OperatorSession,
} from '../session.js';
import { SHARED_WITH_MAX,
  type ProjectVisibility,
  ESCALATION_STATUSES,
  type EscalationDoc,
  type EscalationStatus,
  type ItemDoc,
} from '../types.js';
import { clientIp } from './api.js';
import { record, recordView } from '../events.js';

/**
 * The operator view: every project one person owns, and every question waiting
 * on them, on one page.
 *
 * A per-project read link is the wrong shape for the person who owns six of
 * them. That is the failure our own operator inbox was built to fix, and it is
 * the one thing every competing board leaves to the human: they all assume you
 * are looking at one board at a time. An agent files a question in whichever
 * project it lives in; the operator answers everything in one place.
 *
 * Getting in is an address and a six digit code, the same gesture as claiming a
 * project. There is no account: the address is the identity, the code proves it
 * for this browser, and the session it opens is a cookie rather than a URL.
 */
export interface OperatorDeps {
  store: Store;
  config: Config;
  limiter: RateLimiter;
  mailer: Mailer;
}

const CODE_TTL_MS = 15 * 60_000;
/** How long a freshly sent code is left alone before a new one replaces it. */
const CODE_REISSUE_MS = 60_000;
const MAX_CODE_ATTEMPTS = 5;

export function registerOperator(app: FastifyInstance, deps: OperatorDeps): void {
  const { store, config, limiter, mailer } = deps;
  const ourOrigin = originOf(config.baseUrl);
  const ourHost = new URL(config.baseUrl).host;

  /**
   * Two guards on every write here, never one.
   *
   * The token in the form proves the page it came from was rendered for this
   * session, which is the guard that matters and the one an attacker cannot
   * forge without reading a page they cannot read. The header check beside it
   * costs nothing and holds in the case the first one does not: a token that
   * reached a log, a screenshot or a paste is still a token, and a post
   * carrying it from somebody else's page is not this person acting.
   *
   * The capability pages have had this for a day; they have no token to check,
   * so it was all they had. These had the token and nothing else.
   */
  const ownWrite = (request: FastifyRequest, session: OperatorSession): void => {
    const verdict = fromOurPage(request, ourOrigin);
    if (!verdict.ok) {
      record(store, 'refused', { door: 'browser', detail: verdict.reason, route: request.routeOptions?.url ?? null });
      throw new ServiceError(
        403,
        'bad_origin',
        `That form arrived from ${verdict.came}, which is not this service. Nothing was changed. Open the page again and retry.`,
      );
    }
    checkCsrf(session, request.body);
  };

  // The nav label comes off the cookie, on every page here rather than on the
  // one that remembered to pass it. Half of these pages are only ever seen by
  // somebody signed in, and they were telling that person to sign in.
  const html = (
    request: FastifyRequest,
    reply: FastifyReply,
    title: string,
    body: string,
    code = 200,
  ) =>
    reply
      .code(code)
      .type('text/html; charset=utf-8')
      .send(page(request, { title }, body));

  /** Every action below belongs to whoever is signed in, and to nobody else. */
  async function requireSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<OperatorSession | null> {
    const session = await readSession(store, request);
    if (session) return session;
    // Same as the entry page, and for the same reason: an old tab posting an
    // action is the commonest way to meet a session that has ended, and
    // leaving the cookie there would keep every page calling this person by a
    // name none of them can honour.
    forgetDeadSession(config, request, reply);
    void html(
      request,
      reply,
      'Sign in',
      `<h1>Sign in first</h1>
       <p>That session has ended or was never started here.</p>
       <p><a class="btn" href="/operator">Sign in with your email</a></p>`,
      401,
    );
    return null;
  }

  function signInForm(message?: string): string {
    return `
<h1>Sign in</h1>
<p class="lead">One page for every project you claimed, and everything waiting on
you across all of them. There is no account and no password: your address is the
identity, and a code sent to it proves this browser is yours.</p>
${message ? `<p class="notice">${escapeHtml(message)}</p>` : ''}
<form method="post" action="/operator">
  <label>Email
    <input type="email" name="email" required placeholder="you@example.com">
  </label>
  <div><button type="submit">Send me a code</button></div>
</form>
<p style="color:var(--muted);font-size:14.5px;margin-top:20px">The code is good for
15 minutes and works once. Signing in keeps this browser signed in for 30 days,
and you can end that from the view itself.</p>
`;
  }

  /**
   * The names in an item's `owner` field that mean this person.
   *
   * The local part of the address is offered for free, because "alex@" writing
   * `owner: "alex"` is the overwhelmingly common case and asking somebody to
   * configure that would be asking them to state the obvious.
   */
  async function aliasesFor(email: string): Promise<string[]> {
    const doc = await store.operatorAliases.findOne({ email });
    const fromAddress = email.split('@')[0] ?? '';
    return [...new Set([email, fromAddress, ...(doc?.aliases ?? [])])].filter(Boolean);
  }

  // ------------------------------------------------------------- signing in

  app.get('/operator', { schema: { hide: true } }, async (request, reply) => {
    recordView(store, 'operator', request, ourHost);
    const session = await readSession(store, request);
    if (!session) {
      // A cookie that opens nothing is dropped here, so the navigation stops
      // calling this person by a name the next page cannot honour.
      forgetDeadSession(config, request, reply);
      return html(request, reply, 'Sign in to Muster', signInForm());
    }
    return html(request, reply, 'Your Muster projects', await renderView(session), 200);
  });

  app.post('/operator', { schema: { hide: true } }, async (request, reply) => {
    const form = (request.body ?? {}) as { email?: string };
    const email = (form.email ?? '').trim().toLowerCase();
    const verdict = limiter.check(`operator-send:${clientIp(request)}`, config.rateLimits.claimEmail);
    if (!verdict.ok) {
      return html(
        request,
        reply,
        'Slow down',
        `<h1>Too many requests</h1><p>Try again in ${verdict.retryAfterSeconds} seconds.</p>`,
        429,
      );
    }

    // A deployment with no mail provider cannot send anything to anybody, and
    // saying so is safe: it is a property of the deployment rather than of the
    // address, so it reads the same for everyone and stays no kind of probe.
    if (!config.resendApiKey && !config.logUnsentEmails) {
      return html(
        request,
        reply,
        'This Muster cannot send email',
        `<h1>This Muster cannot send email</h1>
         <p>No mail provider is configured here, so a code cannot reach you. Whoever runs this
         instance needs to set <code>RESEND_API_KEY</code>.</p>
         <p>If an agent created a project for you, it can hand it over directly instead: the read
         link it already has works without any email.</p>
         <p><a href="/">Back</a></p>`,
        503,
      );
    }

    if (/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      const code = newOtpCode();
      const now = new Date();
      // One live code per address, replaced in a single write. Deleting and
      // then inserting lets two overlapping requests both delete before either
      // inserts, which leaves two live codes and makes the newer email the one
      // that fails.
      // A code is only replaced once the previous one has had a moment to
      // arrive. Two requests in the same instant would otherwise both write,
      // and whichever email lands last would carry the code that no longer
      // works, which reads as the service being broken. Waiting also means a
      // second press of the button cannot send a second message.
      const settled = new Date(now.getTime() - CODE_REISSUE_MS);
      const replaceCode = () =>
        store.operatorCodes.updateOne(
          { email, $or: [{ createdAt: { $lte: settled } }, { expiresAt: { $lte: now } }] },
          {
            $set: {
              codeHash: hashToken(code),
              attempts: 0,
              createdAt: now,
              expiresAt: new Date(now.getTime() + CODE_TTL_MS),
            },
            $setOnInsert: { _id: newId('oc'), email },
          },
          { upsert: true },
        );

      let issued = false;
      try {
        const result = await replaceCode();
        issued = result.matchedCount > 0 || result.upsertedCount > 0;
      } catch (error) {
        // 11000: the unique index refused an insert because a live code exists.
        // 66: the upsert tried to write _id onto an existing document, which
        // means the same thing. Either way the previous code is the live one
        // and it is on its way, so this request sends nothing.
        const code = (error as { code?: number }).code;
        if (code !== 11000 && code !== 66) throw error;
        issued = false;
      }

      if (issued) {
        try {
          await mailer.sendOperatorCode(email, code);
        } catch (error) {
          // A bounced send must not answer differently from an address nobody
          // has ever used, or the failure itself becomes the account probe. It
          // must also not leave the code sitting there: the minute long
          // cooldown would then refuse the retry, and the retry after that,
          // until the hourly limit runs out, all without a single message
          // having been delivered. Guarded on the hash so a code somebody else
          // successfully issued in the meantime is left alone.
          request.log.error({ err: error }, 'operator code delivery failed');
          // Matched on this issuance, not just on its digits. A send that hangs
          // past the reissue window can outlive its own code, and six digits
          // collide once in a million, which is often enough to eventually
          // delete somebody's working code instead of this dead one.
          await store.operatorCodes
            .deleteOne({ email, codeHash: hashToken(code), createdAt: now })
            .catch(() => undefined);
        }
      }
    }

    // The same page whether the address owns nine projects, owns none, or is
    // not an address at all. Whether somebody uses this service is not
    // something a stranger gets to establish by typing a guess into a form.
    return html(
      request,
      reply,
      'Check your email',
      `<h1>Check your email</h1>
       <p>If ${escapeHtml(email || 'that address')} can sign in here, a six digit code is on its
       way. It is good for 15 minutes.</p>
       <form method="post" action="/operator/verify">
         <input type="hidden" name="email" value="${escapeHtml(email)}">
         <label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code"
           pattern="[0-9]{6}" maxlength="6" required placeholder="123456"></label>
         <div><button type="submit">Sign in</button></div>
       </form>
       <p style="color:var(--muted);font-size:14.5px"><a href="/operator">Ask for another code</a></p>`,
    );
  });

  app.post('/operator/verify', { schema: { hide: true } }, async (request, reply) => {
    const form = (request.body ?? {}) as { email?: string; code?: string };
    const email = (form.email ?? '').trim().toLowerCase();
    // A bucket of its own. Sharing the one that limits outbound email meant a
    // single sign in spent two of five slots an hour, so a household or an
    // office behind one address locked itself out by signing in twice.
    const verdict = limiter.check(
      codeAttemptKey(clientIp(request)),
      config.rateLimits.verifyCode,
    );
    if (!verdict.ok) {
      return html(
        request,
        reply,
        'Slow down',
        `<h1>Too many attempts</h1><p>Try again in ${verdict.retryAfterSeconds} seconds.</p>`,
        429,
      );
    }

    const wrong = () =>
      html(
        request,
        reply,
        'That code did not work',
        `<h1>That code did not work</h1>
         <p>It may have expired, been used already, or belong to a different address.</p>
         <p><a class="btn" href="/operator">Start again</a></p>`,
        400,
      );

    // The attempt is spent in the same write that reads the code, so several
    // guesses landing together cannot all see attempts=0 and slip past the
    // ceiling between them. Expiry is checked here rather than left to the TTL
    // sweeper, which runs on its own schedule.
    const pending = await store.operatorCodes.findOneAndUpdate(
      { email, expiresAt: { $gt: new Date() }, attempts: { $lt: MAX_CODE_ATTEMPTS } },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    if (!pending) return wrong();
    if (pending.codeHash !== hashToken(String(form.code ?? ''))) return wrong();

    // And the code is spent by the delete rather than by having been read: if
    // two correct submissions race, exactly one of them removes the document,
    // and only that one gets a session out of it.
    const spent = await store.operatorCodes.deleteOne({ _id: pending._id });
    if (spent.deletedCount !== 1) return wrong();

    await startSession(store, config, reply, email);
    return reply.redirect('/operator', 303);
  });

  /**
   * The links that were emailed before sessions existed. One visit exchanges
   * the link for a session and burns it, so a URL that reached a log, a history
   * or a Referer header before this change stops being a way in the moment its
   * owner uses it.
   */
  const noSuchLink = (request: FastifyRequest, reply: FastifyReply) =>
    html(
      request,
      reply,
      'No such link',
      `<h1>No such link</h1>
       <p>That link is wrong, or it has already been exchanged for a session. Links are good for
       one sign in now.</p>
       <p><a class="btn" href="/operator">Sign in with your email</a></p>`,
      404,
    );

  app.get('/operator/:token', { schema: { hide: true } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const record = await store.operatorTokens.findOne({ hash: hashToken(token) });
    if (!record) return noSuchLink(request, reply);

    // The same page under an older door, so it counts under the same name.
    recordView(store, 'operator', request, ourHost);

    // Deliberately not spent by this GET. Mail security scanners and link
    // preview crawlers fetch every URL in a message before the person does, and
    // a one use link that a scanner can burn is a link that never works. The
    // exchange happens on the button below, which a crawler will not press.
    return html(
      request,
      reply,
      'Sign in',
      `<h1>Sign in as ${escapeHtml(record.email)}</h1>
       <p>This link was emailed before sign in codes existed. Using it once signs this browser in
       for 30 days and then stops working.</p>
       <form method="post" action="/operator/${escapeHtml(token)}">
         <div><button type="submit">Sign in with this link</button></div>
       </form>
       <p style="color:var(--muted);font-size:14.5px">Or <a href="/operator">use a code</a>, which
       is how it works from now on.</p>`,
    );
  });

  app.post('/operator/:token', { schema: { hide: true } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const record = await store.operatorTokens.findOneAndDelete({ hash: hashToken(token) });
    if (!record) return noSuchLink(request, reply);
    await startSession(store, config, reply, record.email);
    return reply.redirect('/operator', 303);
  });

  app.post('/operator/logout', { schema: { hide: true } }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return reply;
    ownWrite(request, session);
    const form = (request.body ?? {}) as { scope?: string };
    await endSession(store, config, request, reply, form.scope === 'everywhere');
    return html(
      request,
      reply,
      'Signed out',
      `<h1>Signed out</h1>
       <p>${form.scope === 'everywhere' ? 'Every browser signed in with that address has been signed out, and every old style link has been turned off.' : 'This browser is signed out. Others are not.'}</p>
       <p><a class="btn" href="/operator">Sign in again</a></p>`,
    );
  });

/**
 * The names somebody answers to, as a sentence rather than a list.
 *
 * Joined with commas, the list ran into the clause after it: "Nothing
 * assigned to alex@example.com, alex, nothing blocked, nothing abandoned"
 * gives a reader no way to see where the names stop. And "or" is what the
 * page means, since work under any one of them is theirs.
 */
function either(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * Who else can read this board, folded away until somebody wants it.
 *
 * A `details` rather than a row of its own or a page of its own: the list is
 * empty on most boards and this page is a list of boards, so the control has
 * to cost one word of width until it is opened. Closed, it says how many
 * people can see the board, which is the thing worth noticing from across the
 * page; open, it is the addresses and one field.
 */
function sharing(
  project: { _id: string; sharedWith?: string[]; visibility?: ProjectVisibility },
  session: OperatorSession,
): string {
  const shared = project.sharedWith ?? [];
  const open = (project.visibility ?? 'link') === 'link';
  return `<details class="sharing"><summary title="${
    open
      ? 'Anybody with the read link can open this board, so sharing changes nothing until it is private.'
      : 'Only you and these addresses can open this board.'
  }">shared${shared.length > 0 ? ` (${shared.length})` : ''}</summary>
    <div class="shared-with">
      ${
        shared.length > 0
          ? shared
              .map(
                (email) =>
                  `<form method="post" action="/operator/projects/${escapeHtml(project._id)}/shared">
                     ${csrfField(session)}
                     <input type="hidden" name="remove" value="${escapeHtml(email)}">
                     <span class="mono">${escapeHtml(email)}</span>
                     <button class="ghost tight" type="submit" title="Stop this address reading the board">remove</button>
                   </form>`,
              )
              .join('\n')
          : '<p class="note">Nobody yet. Only you. An address added here does what the read link'
            + ' does: answers questions and writes on the board.</p>'
      }
      <form method="post" action="/operator/projects/${escapeHtml(project._id)}/shared">
        ${csrfField(session)}
        <input name="add" type="email" placeholder="colleague@example.com" required>
        <button class="ghost tight" type="submit">share</button>
      </form>
      ${
        open
          ? `<p class="note">This board is open by link, so these addresses are not what is letting
             anybody in. Press <em>make private</em> to narrow it to this list.</p>`
          : ''
      }
    </div></details>`;
}

  // --------------------------------------------------------------- the view

  async function renderView(session: OperatorSession): Promise<string> {
    const projects = await store.projects.find({ claimedBy: session.email }).toArray();
    /**
     * Boards somebody else owns and let this address read.
     *
     * Listed, and listed apart. Sharing a board is not handing over the work
     * on it: the questions on this page are the ones waiting on the person
     * reading it, and an escalation on a colleague's board is waiting on the
     * colleague. So these appear as a way in and nothing else, and everything
     * above them still counts only what this address owns.
     *
     * Without this the person a board was shared with has to keep the read
     * link somewhere, which is the thing the link being a password makes a bad
     * idea, and the whole reason for sharing by address.
     */
    const sharedWithMe = await store.projects
      .find({ sharedWith: session.email, claimedBy: { $ne: session.email } })
      .toArray();
    const ids = projects.map((project) => project._id);
    const names = new Map(projects.map((project) => [project._id, project.name]));
    // The board each item lives on, so a row on this page is a way in rather
    // than a sentence about work somebody then has to go and find.
    const links = new Map(projects.map((project) => [project._id, project.readToken]));

    // Boards an agent has offered this person. Nothing from them is in the
    // queue below until it is accepted.
    const offers = await store.shares
      .find({ email: session.email })
      .sort({ createdAt: -1 })
      .limit(25)
      .toArray();
    const offered = await store.projects
      .find({ _id: { $in: offers.map((offer) => offer.projectId) } })
      .toArray();
    const offeredById = new Map(offered.map((project) => [project._id, project]));

    // Boards this person has asked for and not yet been given. Without this
    // the ask lives only on the read link page, so somebody who asked and then
    // lost the link has no record of it anywhere, and no way back to the board
    // they were asking about.
    const asked = await store.handovers
      .find({ email: session.email })
      .sort({ createdAt: -1 })
      .limit(25)
      .toArray();
    const askedFor = await store.projects
      .find({ _id: { $in: asked.map((request) => request.projectId) } })
      .toArray();
    const askedById = new Map(askedFor.map((project) => [project._id, project]));

    const aliases = await aliasesFor(session.email);
    const WAITING_SHOWN = 100;
    const MINE_SHOWN = 40;
    /**
     * The list and its total from one read, per list.
     *
     * A `find` and a `countDocuments` fired side by side see two different
     * moments, so an answer landing between them prints "showing 100 of 99", or
     * a headline of nothing over a page with questions on it. `$facet` cuts the
     * page and counts the same matched set once.
     *
     * The per project column comes out of the same pass, which also settles a
     * second thing: it is a count of questions rather than a read of the
     * capacity counter beside them, and that counter is a second write whose
     * repair only ever lowers it.
     */
    const [waitingPass, minePass, recent, staleItems] = await Promise.all([
      store.escalations
        .aggregate<{
          page: EscalationDoc[];
          byProject: Array<{ _id: string; n: number }>;
        }>([
          { $match: { projectId: { $in: ids }, status: 'open' } },
          {
            $facet: {
              // By urgency, then by age. Sorting on the word itself would put
              // "high" below "low", which is alphabetical and useless.
              //
              // Cut to what this page draws, because a facet returns its page
              // inside one document and a document is capped at sixteen
              // megabytes. A cursor had no such ceiling; a hundred questions
              // carrying eight kilobytes of context each would find this one.
              page: [
                { $sort: { priorityRank: -1, createdAt: 1 } },
                { $limit: WAITING_SHOWN },
                {
                  $project: {
                    projectId: 1,
                    question: 1,
                    context: 1,
                    agent: 1,
                    priority: 1,
                    createdAt: 1,
                    // The card it is about. Left out of this list, so the page
                    // could not have named it however the card was rendered:
                    // one slug is not what this projection is guarding against.
                    itemSlug: 1,
                  },
                },
              ],
              byProject: [{ $group: { _id: '$projectId', n: { $sum: 1 } } }],
            },
          },
        ])
        .toArray(),
      store.items
        .aggregate<{ page: ItemDoc[]; total: Array<{ n: number }> }>([
          {
            // Work, as opposed to questions. Assigned to one of the names this
            // person answers to, or blocked and therefore somebody's to
            // unblock, across every project at once. Blocked items count
            // whoever owns them, because a board where nothing moves is the
            // operator's problem by definition.
            $match: {
              projectId: { $in: ids },
              status: { $nin: ['done', 'dropped'] },
              $or: [
                { owner: { $in: aliases } },
                { status: 'blocked' },
                // A lease that ran out is an agent that stopped. Hygiene will
                // clear the claim on its next pass, and until then the item is
                // nobody's, which is the operator's problem sooner than it is
                // anybody's.
                { 'claim.expiresAt': { $lte: new Date() } },
              ],
            },
          },
          {
            $facet: {
              // Same ceiling as the questions above, and closer to it: an item
              // carries its timeline, and forty of those in one document is the
              // shape that reaches sixteen megabytes first.
              page: [
                { $sort: { priority: -1, updatedAt: -1 } },
                { $limit: MINE_SHOWN },
                {
                  $project: {
                    projectId: 1,
                    slug: 1,
                    title: 1,
                    status: 1,
                    owner: 1,
                    stale: 1,
                    claim: 1,
                    updatedAt: 1,
                  },
                },
              ],
              total: [{ $count: 'n' }],
            },
          },
        ])
        .toArray(),
      store.escalations
        .find({ projectId: { $in: ids }, status: { $ne: 'open' } })
        .sort({ answeredAt: -1 })
        .limit(20)
        .toArray(),
      store.items
        .find({ projectId: { $in: ids }, stale: true, status: { $nin: ['done', 'dropped'] } })
        .sort({ staleSince: 1 })
        .limit(20)
        .toArray(),
    ]);

    const waiting = (waitingPass[0]?.page ?? []) as EscalationDoc[];
    const waitingByProject = new Map(
      (waitingPass[0]?.byProject ?? []).map((row) => [row._id, row.n]),
    );
    const waitingTotal = [...waitingByProject.values()].reduce((all, n) => all + n, 0);
    const mine = (minePass[0]?.page ?? []) as ItemDoc[];
    const mineTotal = minePass[0]?.total[0]?.n ?? 0;

    const question = (
      id: string,
      projectId: string,
      text: string,
      context: string,
      agent: string,
      priority: string,
      at: Date,
      itemSlug: string | null,
    ) => `
<div class="card">
  <p class="label">${escapeHtml(names.get(projectId) ?? projectId)} &middot; ${escapeHtml(agent)}
     &middot; ${when(at)} ${priority === 'urgent' || priority === 'high' ? chip(priority, 'blocked') : ''}</p>
  <p style="font-size:17px"><b>${escapeHtml(text)}</b></p>
  ${context ? `<p style="color:var(--ink-2);white-space:pre-wrap">${escapeHtml(context)}</p>` : ''}
  ${
    // The card it is about, open, one click away. The read view learned this
    // and this page did not, though this is the one an owner of several
    // boards reads: a question without its card is a decision made from one
    // sentence, with the timeline that explains it a search box away. The
    // mail about the same question names the card too.
    itemSlug && links.get(projectId)
      ? `<p class="mono" style="font-size:12.5px"><a href="/r/${escapeHtml(
          links.get(projectId)!,
        )}/board?card=${encodeURIComponent(itemSlug)}">${escapeHtml(itemSlug)}</a></p>`
      : ''
  }
  <form method="post" action="/operator/escalations/${escapeHtml(id)}">
    ${csrfField(session)}
    <label>Your answer<textarea name="answer" placeholder="The decision, in your words."></textarea></label>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:8px;align-items:start">
      <button type="submit" name="status" value="answered">Answer</button>
      <button class="ghost" type="submit" name="status" value="resolved">Already handled</button>
      <button class="ghost" type="submit" name="status" value="wont_do">Won't do</button>
      <button class="ghost" type="submit" name="status" value="in_progress">I'm on it</button>
    </div>
  </form>
</div>`;

    // Blocked work is waiting on a person exactly as a question is, and this
    // page used to count only the questions: two things needing a decision, a
    // headline claiming one, and an answer box under only that one.
    const blocked = mine.filter((item) => item.status === 'blocked').length;
    const heading =
      waitingTotal === 0 && blocked === 0
        ? 'Nothing is waiting on you'
        : [
            waitingTotal > 0 ? `${waitingTotal} question${waitingTotal === 1 ? '' : 's'}` : '',
            blocked > 0 ? `${blocked} blocked item${blocked === 1 ? '' : 's'}` : '',
          ]
            .filter(Boolean)
            .join(' and ') + ' for you';

    return `
<h1>${heading}</h1>
${
      blocked > 0
        ? `<p class="why">Blocked work has no answer box: it is waiting for somebody to unblock it,
which happens on its own card. Every row under "Your work" opens the card it names.</p>`
        : ''
    }
${
      waitingTotal > waiting.length
        ? `<p class="why">Showing the ${waiting.length} most urgent. Answering these frees the
agents behind them first.</p>`
        : ''
    }
<p class="lead">Across ${projects.length} project${projects.length === 1 ? '' : 's'} claimed by
${escapeHtml(session.email)}.</p>

${waiting
  .map((doc) =>
    question(
      doc._id,
      doc.projectId,
      doc.question,
      doc.context,
      doc.agent,
      doc.priority,
      doc.createdAt,
      doc.itemSlug ?? null,
    ),
  )
  .join('')}

${
      offers.length === 0
        ? ''
        : `<h2>Boards handed to you</h2>
<p style="color:var(--ink-2)">An agent created these and offered them. Nothing from them is in the queue
above until you accept.</p>
${offers
  .map((offer) => {
    const project = offeredById.get(offer.projectId);
    if (!project) return '';
    return `<div class="card">
  <p class="label">${escapeHtml(offer.offeredBy)} &middot; ${when(offer.createdAt)}</p>
  <p style="font-size:17px;margin:0 0 4px"><b>${escapeHtml(project.name)}</b></p>
  ${project.description ? `<p style="color:var(--ink-2);margin:0 0 8px">${escapeHtml(project.description)}</p>` : ''}
  ${offer.note ? `<p style="color:var(--ink-2);margin:0 0 8px">${escapeHtml(offer.note)}</p>` : ''}
  <p class="mono" style="color:var(--muted);margin:0 0 10px">${count(
    project.counts.items,
    'open item',
    'open items',
  )}, ${count(project.counts.escalations, 'question')} &middot;
     <a href="/r/${escapeHtml(project.readToken)}/board">look first</a></p>
  <form class="row" method="post" action="/operator/shares/${escapeHtml(offer._id)}">
    ${csrfField(session)}
    <button type="submit" name="decision" value="accept">Take ownership</button>
    <button class="ghost" type="submit" name="decision" value="ignore">Not mine</button>
  </form>
</div>`;
  })
  .join('')}`
    }

${
      asked.length === 0
        ? ''
        : `<h2>Boards you asked for</h2>
<p style="color:var(--ink-2)">You asked the agents on these to hand them over. They see the request
the next time they read their inbox, and answer it by offering the board, which then appears
above.</p>
${asked
  .map((request) => {
    const project = askedById.get(request.projectId);
    if (!project || project.claimedBy) return '';
    return `<div class="card">
  <p class="label">asked ${when(request.createdAt)}</p>
  <p style="font-size:17px;margin:0 0 4px"><b>${escapeHtml(project.name)}</b></p>
  ${request.note ? `<p style="color:var(--ink-2);margin:0 0 8px">${escapeHtml(request.note)}</p>` : ''}
  <p class="mono" style="color:var(--muted);margin:0">
     <a href="/r/${escapeHtml(project.readToken)}">back to the board</a></p>
</div>`;
  })
  .join('')}`
    }

<h2>Your work</h2>
${
      mine.length === 0
        ? `<p class="empty">Nothing assigned to ${escapeHtml(either(aliases))}, nothing blocked,
nothing abandoned. If work of yours is missing, it is filed under a name this page does not know
is you.</p>`
        : `
<p style="color:var(--ink-2)">Assigned to ${escapeHtml(either(aliases))}, or blocked and waiting
for somebody to unblock it. Across every project, because the work does not care which board it
lives on.${
          mineTotal > mine.length
            ? ` Showing ${mine.length} of ${mineTotal}, most urgent first.`
            : ''
        }</p>
<div class="scroll cards"><table class="cards">
<thead><tr><th scope="col">Project</th><th scope="col">Item</th><th scope="col">State</th><th scope="col">Last touched</th></tr></thead>
<tbody>
${mine
  .map((item) => {
    const held = item.claim && new Date(item.claim.expiresAt) > new Date();
    const token = links.get(item.projectId);
    // Straight to the card, open, on the board it lives on: `?card=` is what
    // opens a sheet now, and the fragment beside it is what scrolls to it. It
    // used to be a search plus a fragment, which since the sheets became
    // addresses landed on a board narrowed to one card with the card shut.
    const card = token
      ? `/r/${escapeHtml(token)}/board?card=${encodeURIComponent(item.slug)}#${escapeHtml(item._id)}`
      : null;
    const label = escapeHtml(item.title || item.slug);
    return `<tr><td data-label="Project">${escapeHtml(names.get(item.projectId) ?? item.projectId)}</td>
       <td data-label="Item">${card ? `<a href="${card}">${label}</a>` : label}<br>
           <span class="mono" style="color:var(--muted)">${escapeHtml(item.slug)}</span></td>
       <td data-label="State">${item.status === 'blocked' ? chip('blocked', 'blocked') : ''}
           ${held ? chip(item.claim!.agent, 'claim') : ''}
           ${item.stale ? chip('stale', 'stale') : ''}
           ${item.owner ? chip(item.owner, 'dropped') : ''}</td>
       <td class="mono" data-label="Last touched">${when(item.updatedAt)}</td></tr>`;
  })
  .join('\n')}
</tbody></table></div>
`
    }
<p style="color:var(--muted);font-size:14px">An item's owner is free text an agent wrote, so this
page assumes the front of your address means you. Anything else, say so.</p>
<form class="row" method="post" action="/operator/aliases">
  ${csrfField(session)}
  <label>Names you answer to<input name="aliases" value="${escapeHtml(aliases.join(', '))}"
    placeholder="alex, ak, alex.k"></label>
  <button class="ghost" type="submit">Save</button>
</form>

<h2>Projects</h2>
${
      projects.length > 0
        ? ''
        : `<p style="color:var(--ink-2)">None yet. A project is made by an agent, not here: point one
   at <a href="/skill.md">skill.md</a> and it signs up on its own, then hand you the read link it
   gets back. Opening that link and claiming it with this address is what puts a board on this
   page. Nothing is lost in the meantime: an unclaimed project keeps working, on smaller limits
   and a ${count(config.demoTtlDays, 'day')} timer.</p>`
    }
<div class="scroll cards"${projects.length === 0 ? ' hidden' : ''}><table class="cards">
<thead><tr><th scope="col">Project</th><th scope="col" class="mono">open</th><th scope="col" class="mono">agents</th><th scope="col">Waiting</th><th scope="col"></th></tr></thead>
<tbody>
${projects
  .map(
    (project) =>
      `<tr><td data-label="Project"><strong>${escapeHtml(project.name)}</strong>
       <span class="mono" style="color:var(--muted);font-size:13px">${escapeHtml(project._id)}</span>${
         project.description
           ? `<span class="one-line" title="${escapeHtml(project.description)}">${escapeHtml(project.description)}</span>`
           : ''
       }</td>
       <td class="mono" data-label="Open items">${project.counts.items}</td>
       <td class="mono" data-label="Agents">${project.counts.agents}</td>
       <td class="mono" data-label="Waiting">${waitingByProject.get(project._id) ?? 0}</td>
       <td data-label="Go to"><div class="doing">
           <a href="/r/${escapeHtml(project.readToken)}/board">board</a>
           <a href="/r/${escapeHtml(project.readToken)}">questions</a>
           <form method="post" action="/operator/projects/${escapeHtml(project._id)}/keys">
             ${csrfField(session)}
             <button class="ghost tight" type="submit"
                     title="For an agent that lost its token">new token</button>
           </form>
           <form method="post" action="/operator/projects/${escapeHtml(project._id)}/visibility">
             ${csrfField(session)}
             <input type="hidden" name="visibility"
                    value="${(project.visibility ?? 'link') === 'owner' ? 'link' : 'owner'}">
             <button class="ghost tight" type="submit"
                     title="${
                       (project.visibility ?? 'link') === 'owner'
                         ? 'Private now. Pressing this lets anybody holding the read link open it again.'
                         : 'Open by link now. Pressing this stops the link working for everybody but you.'
                     }">${(project.visibility ?? 'link') === 'owner' ? 'open it up' : 'make private'}</button>
           </form>
           ${sharing(project, session)}</div></td></tr>`,
  )
  .join('\n')}
</tbody></table></div>

${
      sharedWithMe.length === 0
        ? ''
        : `<h2>Shared with you</h2>
<p style="color:var(--ink-2)">Somebody else owns these and named this address as one that may open
them. That is not a read-only seat: on these boards you answer questions and write, the same as
anybody they had handed the link to. The questions above are the ones waiting on you, so nothing
from here is counted in them.</p>
<div class="scroll cards"><table class="cards">
<thead><tr><th scope="col">Project</th><th scope="col" class="mono">open</th><th scope="col">Owner</th><th scope="col"></th></tr></thead>
<tbody>
${sharedWithMe
  .map(
    (project) =>
      `<tr><td data-label="Project"><strong>${escapeHtml(project.name)}</strong>
       <span class="mono" style="color:var(--muted);font-size:13px">${escapeHtml(project._id)}</span>${
         project.description
           ? `<span class="one-line" title="${escapeHtml(project.description)}">${escapeHtml(project.description)}</span>`
           : ''
       }</td>
       <td class="mono" data-label="Open items">${project.counts.items}</td>
       <td data-label="Owner">${escapeHtml(redactAddress(project.claimedBy ?? ''))}</td>
       <td data-label="Go to"><div class="doing">
           <a href="/r/${escapeHtml(project.readToken)}/board">board</a>
           <a href="/r/${escapeHtml(project.readToken)}">questions</a>
       </div></td></tr>`,
  )
  .join('\n')}
</tbody></table></div>`
    }

${
      staleItems.length > 0
        ? `<h2>Going stale</h2>
<p style="color:var(--ink-2)">Nobody has touched these, and no agent has claimed them. Hygiene
flagged them rather than closing them, because deciding they are dead is your call.</p>
<div class="scroll cards"><table class="cards">
<thead><tr><th scope="col">Project</th><th scope="col">Item</th><th scope="col">Stale since</th></tr></thead>
<tbody>
${staleItems
  .map(
    (item) =>
      `<tr><td data-label="Project">${escapeHtml(names.get(item.projectId) ?? item.projectId)}</td>
       <td class="mono" data-label="Item">${escapeHtml(item.slug)}</td>
       <td class="mono" data-label="Stale since">${when(item.staleSince)}</td></tr>`,
  )
  .join('\n')}
</tbody></table></div>`
        : ''
    }

<h2>This browser</h2>
<p style="color:var(--ink-2);font-size:15px">Signed in as ${escapeHtml(session.email)} for 30 days.
Ending it everywhere also turns off every link emailed before sessions existed.</p>
<form class="row" method="post" action="/operator/logout">
  ${csrfField(session)}
  <button class="ghost" type="submit">Sign out here</button>
  <button class="ghost" type="submit" name="scope" value="everywhere">Sign out everywhere</button>
</form>

<h2>Recently answered</h2>
${
      recent.length === 0
        ? '<p class="empty">Nothing yet.</p>'
        : `<ul class="timeline">${recent
            .map(
              (doc) =>
                `<li><span class="when">${when(doc.withdrawnAt ?? doc.answeredAt)}</span>
                 <span class="who">${escapeHtml(doc.withdrawnAt ? 'withdrawn' : doc.status)}</span>
                 <span>${escapeHtml(doc.question)}${
                   // The same distinction the read link makes, on the page an
                   // operator with several boards actually lives on: a
                   // withdrawal is stored as `wont_do` and must not read here
                   // as a decision this person made.
                   doc.withdrawnAt
                     ? `<br><span style="color:var(--ink-2)">${who(doc.withdrawnBy ?? 'an agent')} took it back${doc.withdrawnReason ? `: ${escapeHtml(doc.withdrawnReason)}` : ''}</span>`
                     : doc.answer ? `<br><span style="color:var(--ink-2)">${escapeHtml(doc.answer)}</span>` : ''
                 }${
                   // Whether it landed. This is the page most answers are
                   // written on, so it is the page that owes the answer back.
                   doc.acknowledgedAt
                     ? `<br><span class="why">${who(doc.acknowledgedBy ?? 'an agent')} acted ${when(doc.acknowledgedAt)}${doc.acknowledgedNote ? `: ${escapeHtml(doc.acknowledgedNote)}` : ''}</span>`
                     : ''
                 }</span></li>`,
            )
            .join('')}</ul>`
    }
`;
  }

  // ------------------------------------------------------------- the actions

  app.post('/operator/shares/:id', { schema: { hide: true } }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return reply;
    ownWrite(request, session);

    const { id } = request.params as { id: string };
    const form = (request.body ?? {}) as { decision?: string };
    if (form.decision === 'ignore') {
      await store.shares.deleteOne({ _id: id, email: session.email });
      return reply.redirect('/operator', 303);
    }
    const accepted = await acceptShare(store, config, session.email, id);
    record(store, 'accept', { door: 'browser', projectId: accepted._id });
    return reply.redirect('/operator', 303);
  });

  /**
   * A new admin token for a project this person owns.
   *
   * Until now, losing the token was final: the agent that held it could no
   * longer write, and there was no path from owning a project back to a
   * credential for it. Ownership was already proved by email, so the only
   * missing piece was a button. Existing keys are left alone, because the usual
   * reason to be here is that one was lost rather than leaked; revoking the
   * others is a separate, deliberate act on the keys endpoint.
   */
  app.post('/operator/projects/:id/keys', { schema: { hide: true } }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return reply;
    ownWrite(request, session);

    const { id } = request.params as { id: string };
    const project = await store.projects.findOne({ _id: id, claimedBy: session.email });
    if (!project) {
      throw new ServiceError(404, 'not_found', 'No project of yours with that id.');
    }
    const { token } = await createApiKey(store, project, {
      name: `issued from the operator view on ${new Date().toISOString().slice(0, 10)}`,
      role: 'admin',
    });

    return html(
      request,
      reply,
      'A new token',
      `<h1>A new token for ${escapeHtml(project.name)}</h1>
       <div class="notice"><b>Copy it now.</b> It is shown once and stored only as a hash.</div>
       <div class="card"><p class="label">token</p><pre><code>${escapeHtml(token)}</code></pre></div>
       <p>Give it to the agent that lost the old one. Every key that already worked still works;
       if the old one leaked rather than got lost, revoke it explicitly:</p>
       <pre><code>curl -s ${escapeHtml(config.baseUrl)}/v1/${escapeHtml(project._id)}/keys \\
  -H "authorization: Bearer ${escapeHtml(token)}"
curl -sX DELETE ${escapeHtml(config.baseUrl)}/v1/${escapeHtml(project._id)}/keys/$KEY_ID \\
  -H "authorization: Bearer ${escapeHtml(token)}"</code></pre>
       <p><a href="/operator">Back to your projects</a></p>`,
    );
  });

  /**
   * Open by link, or only to me.
   *
   * A project starts open because it has to: an agent creates one before any
   * person is involved, and the handover is a URL that works. Owning it is what
   * earns the right to close it, and closing it makes the link alone worthless
   * to everybody else, including anybody who copied it while it was open.
   */
  app.post('/operator/projects/:id/visibility', { schema: { hide: true } }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return reply;
    ownWrite(request, session);

    const { id } = request.params as { id: string };
    const form = (request.body ?? {}) as { visibility?: string };
    const project = await store.projects.findOne({ _id: id, claimedBy: session.email });
    if (!project) throw new ServiceError(404, 'not_found', 'No project of yours with that id.');

    // The two states this control has, and nothing else. Reading "anything
    // that is not owner" as "open it by link" is a coin flip on a privacy
    // switch: a request that says `visibility=sideways` has not asked for the
    // board to be readable by whoever holds the link.
    if (form.visibility !== 'owner' && form.visibility !== 'link') {
      throw new ServiceError(
        400,
        'bad_visibility',
        'A project is "link", which anybody holding the read link can open, or "owner", which only you can.',
      );
    }
    await updateProject(store, project._id, { visibility: form.visibility });
    return reply.redirect('/operator', 303);
  });

  /**
   * Letting somebody else read a board without handing it over.
   *
   * The switch beside this has two positions and both of them were blunt: open
   * to anybody holding a link, or open to one person. Handing the board over
   * with `POST /share` is the other thing that exists and it moves ownership,
   * which is not what somebody wants when a colleague needs to see what the
   * agents are doing. This is the middle: named addresses, read the same board
   * the owner reads, nothing about who owns it changes.
   *
   * One address at a time, and removal by the same route: two forms on one row
   * of a list, rather than a page of its own for a list that is usually empty.
   */
  app.post('/operator/projects/:id/shared', { schema: { hide: true } }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return reply;
    ownWrite(request, session);

    const { id } = request.params as { id: string };
    const form = (request.body ?? {}) as { add?: string; remove?: string };
    const project = await store.projects.findOne({ _id: id, claimedBy: session.email });
    if (!project) throw new ServiceError(404, 'not_found', 'No project of yours with that id.');

    // One operator with two tabs is enough for this to matter, and what it
    // costs is the wrong direction: reading the list, changing it here and
    // writing the whole thing back lets an addition that started earlier land
    // after a removal and put back the address that was just revoked. So the
    // database does the arithmetic on the array it holds.
    if (form.remove !== undefined) {
      await store.projects.updateOne(
        { _id: project._id, claimedBy: session.email },
        { $pull: { sharedWith: form.remove.trim().toLowerCase() } },
      );
      return reply.redirect('/operator', 303);
    }

    const email = (form.add ?? '').trim().toLowerCase();
    if (!looksLikeEmail(email)) {
      throw new ServiceError(400, 'bad_email', 'That does not look like an email address.');
    }
    // The owner is already in, and listing them twice would offer a remove
    // button that takes nothing away.
    if (email === project.claimedBy) return reply.redirect('/operator', 303);

    // The cap is part of the same write, or it is a read of a number that
    // another tab is already changing. An address that is on the list passes
    // whatever the size is, because adding it again changes nothing.
    const grew = await store.projects.updateOne(
      {
        _id: project._id,
        claimedBy: session.email,
        $or: [
          { sharedWith: email },
          { $expr: { $lt: [{ $size: { $ifNull: ['$sharedWith', []] } }, SHARED_WITH_MAX] } },
        ],
      },
      { $addToSet: { sharedWith: email } },
    );
    if (grew.matchedCount === 0) {
      throw new ServiceError(
        400,
        'too_many_shares',
        `A board can be shared with ${SHARED_WITH_MAX} addresses. Hand it over with the API if it needs more than that.`,
      );
    }
    return reply.redirect('/operator', 303);
  });

  app.post('/operator/aliases', { schema: { hide: true } }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return reply;
    ownWrite(request, session);

    const form = (request.body ?? {}) as { aliases?: string };
    const aliases = [
      ...new Set(
        (form.aliases ?? '')
          .split(',')
          .map((alias) => alias.trim().slice(0, 48))
          .filter(Boolean),
      ),
    ].slice(0, 12);

    await store.operatorAliases.updateOne(
      { email: session.email },
      { $set: { aliases, updatedAt: new Date() }, $setOnInsert: { _id: newId('al'), email: session.email } },
      { upsert: true },
    );
    return reply.redirect('/operator', 303);
  });

  app.post('/operator/escalations/:id', { schema: { hide: true } }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return reply;
    ownWrite(request, session);

    const { id } = request.params as { id: string };
    const form = (request.body ?? {}) as { status?: string; answer?: string };
    const escalation = await store.escalations.findOne({ _id: id });
    if (!escalation) throw new ServiceError(404, 'not_found', 'No such question.');
    const project = await store.projects.findOne({
      _id: escalation.projectId,
      claimedBy: session.email,
    });
    if (!project) {
      throw new ServiceError(403, 'not_yours', 'That question belongs to somebody else’s project.');
    }

    const status = (form.status ?? 'answered') as EscalationStatus;
    if (!ESCALATION_STATUSES.includes(status)) {
      throw new ServiceError(400, 'bad_status', 'Unknown answer type.');
    }
    await answerEscalation(store, project._id, id, status, (form.answer ?? '').slice(0, 8000), 'browser');
    return reply.redirect('/operator', 303);
  });
}
