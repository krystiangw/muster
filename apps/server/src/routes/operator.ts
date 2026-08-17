import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import type { Mailer } from '../email.js';
import { chip, escapeHtml, formatWhen, layout } from '../html.js';
import { hashToken, newId, newOtpCode } from '../ids.js';
import type { RateLimiter } from '../rateLimit.js';
import {
  ServiceError,
  acceptShare,
  answerEscalation,
  createApiKey,
  updateProject,
} from '../service.js';
import {
  checkCsrf,
  csrfField,
  endSession,
  readSession,
  startSession,
  type OperatorSession,
} from '../session.js';
import { ESCALATION_STATUSES, type EscalationStatus } from '../types.js';
import { clientIp } from './api.js';

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
const MAX_CODE_ATTEMPTS = 5;

export function registerOperator(app: FastifyInstance, deps: OperatorDeps): void {
  const { store, config, limiter, mailer } = deps;

  const html = (reply: FastifyReply, title: string, body: string, code = 200) =>
    reply.code(code).type('text/html; charset=utf-8').send(layout({ title }, body));

  /** Every action below belongs to whoever is signed in, and to nobody else. */
  async function requireSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<OperatorSession | null> {
    const session = await readSession(store, request);
    if (session) return session;
    void html(
      reply,
      'Sign in',
      `<h1>Sign in first</h1>
       <p>That session has ended or was never started here.</p>
       <p><a href="/operator">Sign in with your email</a></p>`,
      401,
    );
    return null;
  }

  function signInForm(message?: string): string {
    return `
<h1>Everything waiting on you</h1>
<p class="lead">One page for every project you claimed, and every question your
agents parked for a human. No account: your address is the identity, and a code
proves it for this browser.</p>
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

  // ------------------------------------------------------------- signing in

  app.get('/operator', { schema: { hide: true } }, async (request, reply) => {
    const session = await readSession(store, request);
    if (!session) return html(reply, 'Muster operator view', signInForm());
    return html(reply, 'Muster operator view', await renderView(session));
  });

  app.post('/operator', { schema: { hide: true } }, async (request, reply) => {
    const form = (request.body ?? {}) as { email?: string };
    const email = (form.email ?? '').trim().toLowerCase();
    const verdict = limiter.check(`operator-send:${clientIp(request)}`, config.rateLimits.claimEmail);
    if (!verdict.ok) {
      return html(
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
      const replaceCode = () =>
        store.operatorCodes.updateOne(
          { email },
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
      try {
        await replaceCode();
      } catch (error) {
        // Two requests for the same address in the same instant: the index did
        // its job and refused the second insert. The document exists now, so
        // the retry takes the update path and the code in the email we are
        // about to send is the one that will work.
        if ((error as { code?: number }).code !== 11000) throw error;
        await replaceCode();
      }
      try {
        await mailer.sendOperatorCode(email, code);
      } catch (error) {
        // A bounced send must not answer differently from an address nobody
        // has ever used, or the failure itself becomes the account probe.
        request.log.error({ err: error }, 'operator code delivery failed');
      }
    }

    // The same page whether the address owns nine projects, owns none, or is
    // not an address at all. Whether somebody uses this service is not
    // something a stranger gets to establish by typing a guess into a form.
    return html(
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
      `operator-verify:${clientIp(request)}`,
      config.rateLimits.verifyCode,
    );
    if (!verdict.ok) {
      return html(
        reply,
        'Slow down',
        `<h1>Too many attempts</h1><p>Try again in ${verdict.retryAfterSeconds} seconds.</p>`,
        429,
      );
    }

    const wrong = () =>
      html(
        reply,
        'That code did not work',
        `<h1>That code did not work</h1>
         <p>It may have expired, been used already, or belong to a different address.</p>
         <p><a href="/operator">Start again</a></p>`,
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
  const noSuchLink = (reply: FastifyReply) =>
    html(
      reply,
      'No such link',
      `<h1>No such link</h1>
       <p>That link is wrong, or it has already been exchanged for a session. Links are good for
       one sign in now.</p>
       <p><a href="/operator">Sign in with your email</a></p>`,
      404,
    );

  app.get('/operator/:token', { schema: { hide: true } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const record = await store.operatorTokens.findOne({ hash: hashToken(token) });
    if (!record) return noSuchLink(reply);

    // Deliberately not spent by this GET. Mail security scanners and link
    // preview crawlers fetch every URL in a message before the person does, and
    // a one use link that a scanner can burn is a link that never works. The
    // exchange happens on the button below, which a crawler will not press.
    return html(
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
    if (!record) return noSuchLink(reply);
    await startSession(store, config, reply, record.email);
    return reply.redirect('/operator', 303);
  });

  app.post('/operator/logout', { schema: { hide: true } }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return reply;
    checkCsrf(session, request.body);
    const form = (request.body ?? {}) as { scope?: string };
    await endSession(store, config, request, reply, form.scope === 'everywhere');
    return html(
      reply,
      'Signed out',
      `<h1>Signed out</h1>
       <p>${form.scope === 'everywhere' ? 'Every browser signed in with that address has been signed out, and every old style link has been turned off.' : 'This browser is signed out. Others are not.'}</p>
       <p><a href="/operator">Sign in again</a></p>`,
    );
  });

  // --------------------------------------------------------------- the view

  async function renderView(session: OperatorSession): Promise<string> {
    const projects = await store.projects.find({ claimedBy: session.email }).toArray();
    const ids = projects.map((project) => project._id);
    const names = new Map(projects.map((project) => [project._id, project.name]));

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

    const [waiting, recent, staleItems] = await Promise.all([
      store.escalations
        .find({ projectId: { $in: ids }, status: 'open' })
        // By urgency, then by age. Sorting on the word itself would put "high"
        // below "low", which is alphabetical and useless.
        .sort({ priorityRank: -1, createdAt: 1 })
        .limit(100)
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

    const question = (
      id: string,
      projectId: string,
      text: string,
      context: string,
      agent: string,
      priority: string,
      when: Date,
    ) => `
<div class="card">
  <p class="label">${escapeHtml(names.get(projectId) ?? projectId)} &middot; ${escapeHtml(agent)}
     &middot; ${escapeHtml(formatWhen(when))} ${priority === 'urgent' || priority === 'high' ? chip(priority, 'blocked') : ''}</p>
  <p style="font-size:17px"><b>${escapeHtml(text)}</b></p>
  ${context ? `<p style="color:var(--ink-2);white-space:pre-wrap">${escapeHtml(context)}</p>` : ''}
  <form method="post" action="/operator/escalations/${escapeHtml(id)}">
    ${csrfField(session)}
    <label>Your answer<textarea name="answer" placeholder="The decision, in your words."></textarea></label>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
      <button type="submit" name="status" value="answered">Answer</button>
      <button class="ghost" type="submit" name="status" value="resolved">Already handled</button>
      <button class="ghost" type="submit" name="status" value="wont_do">Won't do</button>
      <button class="ghost" type="submit" name="status" value="in_progress">I'm on it</button>
    </div>
  </form>
</div>`;

    return `
<h1>${waiting.length === 0 ? 'Nothing is waiting on you' : `${waiting.length} question${waiting.length === 1 ? '' : 's'} for you`}</h1>
<p class="lead">Across ${projects.length} project${projects.length === 1 ? '' : 's'} claimed by
${escapeHtml(session.email)}.</p>

${waiting
  .map((doc) =>
    question(doc._id, doc.projectId, doc.question, doc.context, doc.agent, doc.priority, doc.createdAt),
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
  <p class="label">${escapeHtml(offer.offeredBy)} &middot; ${escapeHtml(formatWhen(offer.createdAt))}</p>
  <p style="font-size:17px;margin:0 0 4px"><b>${escapeHtml(project.name)}</b></p>
  ${project.description ? `<p style="color:var(--ink-2);margin:0 0 8px">${escapeHtml(project.description)}</p>` : ''}
  ${offer.note ? `<p style="color:var(--ink-2);margin:0 0 8px">${escapeHtml(offer.note)}</p>` : ''}
  <p class="mono" style="color:var(--muted);margin:0 0 10px">${project.counts.items} open item(s),
     ${project.counts.escalations} question(s) &middot;
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

<h2>Projects</h2>
<div class="scroll"><table>
<thead><tr><th>Project</th><th class="mono">open</th><th class="mono">agents</th><th>Waiting</th><th></th></tr></thead>
<tbody>
${projects
  .map(
    (project) =>
      `<tr><td>${escapeHtml(project.name)}${
        project.description
          ? `<br><span style="color:var(--ink-2);font-size:13.5px">${escapeHtml(project.description)}</span>`
          : ''
      }<br><span class="mono" style="color:var(--muted)">${escapeHtml(project._id)}</span></td>
       <td class="mono">${project.counts.items}</td><td class="mono">${project.counts.agents}</td>
       <td class="mono">${waiting.filter((doc) => doc.projectId === project._id).length}</td>
       <td><a href="/r/${escapeHtml(project.readToken)}/board">board</a><br>
           <a href="/r/${escapeHtml(project.readToken)}">questions</a>
           <form method="post" action="/operator/projects/${escapeHtml(project._id)}/keys"
                 style="margin-top:6px">
             ${csrfField(session)}
             <button class="ghost" type="submit"
                     title="For an agent that lost its token">new token</button>
           </form>
           <form method="post" action="/operator/projects/${escapeHtml(project._id)}/visibility"
                 style="margin-top:6px">
             ${csrfField(session)}
             <input type="hidden" name="visibility"
                    value="${(project.visibility ?? 'link') === 'owner' ? 'link' : 'owner'}">
             <button class="ghost" type="submit"
                     title="${
                       (project.visibility ?? 'link') === 'owner'
                         ? 'Anybody holding the read link can open this board again'
                         : 'The read link stops working for everybody but you'
                     }">${(project.visibility ?? 'link') === 'owner' ? 'private' : 'open by link'}</button>
           </form></td></tr>`,
  )
  .join('\n')}
</tbody></table></div>

${
      staleItems.length > 0
        ? `<h2>Going stale</h2>
<p style="color:var(--ink-2)">Nobody has touched these, and no agent has claimed them. Hygiene
flagged them rather than closing them, because deciding they are dead is your call.</p>
<div class="scroll"><table>
<thead><tr><th>Project</th><th>Item</th><th>Stale since</th></tr></thead>
<tbody>
${staleItems
  .map(
    (item) =>
      `<tr><td>${escapeHtml(names.get(item.projectId) ?? item.projectId)}</td>
       <td class="mono">${escapeHtml(item.slug)}</td>
       <td class="mono">${escapeHtml(formatWhen(item.staleSince))}</td></tr>`,
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
                `<li><span class="when">${escapeHtml(formatWhen(doc.answeredAt))}</span>
                 <span class="who">${escapeHtml(doc.status)}</span>
                 <span>${escapeHtml(doc.question)}${
                   doc.answer ? `<br><span style="color:var(--ink-2)">${escapeHtml(doc.answer)}</span>` : ''
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
    checkCsrf(session, request.body);

    const { id } = request.params as { id: string };
    const form = (request.body ?? {}) as { decision?: string };
    if (form.decision === 'ignore') {
      await store.shares.deleteOne({ _id: id, email: session.email });
      return reply.redirect('/operator', 303);
    }
    await acceptShare(store, config, session.email, id);
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
    checkCsrf(session, request.body);

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
    checkCsrf(session, request.body);

    const { id } = request.params as { id: string };
    const form = (request.body ?? {}) as { visibility?: string };
    const project = await store.projects.findOne({ _id: id, claimedBy: session.email });
    if (!project) throw new ServiceError(404, 'not_found', 'No project of yours with that id.');

    await updateProject(store, project._id, {
      visibility: form.visibility === 'owner' ? 'owner' : 'link',
    });
    return reply.redirect('/operator', 303);
  });

  app.post('/operator/escalations/:id', { schema: { hide: true } }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return reply;
    checkCsrf(session, request.body);

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
    await answerEscalation(store, project._id, id, status, (form.answer ?? '').slice(0, 8000));
    return reply.redirect('/operator', 303);
  });
}
