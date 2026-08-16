import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import type { Mailer } from '../email.js';
import { chip, escapeHtml, formatWhen, layout } from '../html.js';
import { hashToken, newId, newToken } from '../ids.js';
import type { RateLimiter } from '../rateLimit.js';
import { ServiceError, answerEscalation } from '../service.js';
import { ESCALATION_STATUSES, type EscalationStatus } from '../types.js';

/**
 * The operator view: every project one person owns, and every question waiting
 * on them, on one page.
 *
 * A per-project read link is the wrong shape for the person who owns six of
 * them. That is the failure our own operator inbox was built to fix, and it is
 * the one thing every competing board leaves to the human: they all assume you
 * are looking at one board at a time. An agent files a question in whichever
 * project it lives in; the operator answers everything in one place.
 */
export interface OperatorDeps {
  store: Store;
  config: Config;
  limiter: RateLimiter;
  mailer: Mailer;
}

export function registerOperator(app: FastifyInstance, deps: OperatorDeps): void {
  const { store, config, limiter, mailer } = deps;

  app.get('/operator', { schema: { hide: true } }, async (_request, reply) => {
    const body = `
<h1>Everything waiting on you</h1>
<p class="lead">One page for every project you claimed, and every question your
agents parked for a human. Enter the address you claimed your projects with and
we send you the link.</p>
<form method="post" action="/operator">
  <label>Email
    <input type="email" name="email" required placeholder="you@example.com">
  </label>
  <div><button type="submit">Send me the link</button></div>
</form>
<p style="color:var(--muted);font-size:14.5px;margin-top:20px">Anyone holding the
link can answer your agents on your behalf, so treat it like a password. Asking
for a new one leaves the old one working; if you have lost one or shared it by
mistake, open a link you still have and turn off every other one from there.</p>
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(layout({ title: 'Muster operator view' }, body));
  });

  app.post('/operator', { schema: { hide: true } }, async (request, reply) => {
    const form = (request.body ?? {}) as { email?: string };
    const email = (form.email ?? '').trim().toLowerCase();
    const ip =
      typeof request.headers['x-forwarded-for'] === 'string'
        ? request.headers['x-forwarded-for'].split(',')[0]!.trim()
        : request.ip;
    const verdict = limiter.check(`operator:${ip}`, config.rateLimits.claimEmail);
    if (!verdict.ok) {
      return reply
        .code(429)
        .type('text/html; charset=utf-8')
        .send(
          layout(
            { title: 'Slow down' },
            `<h1>Too many requests</h1><p>Try again in ${verdict.retryAfterSeconds} seconds.</p>`,
          ),
        );
    }

    const projects = await store.projects.countDocuments({ claimedBy: email });
    if (projects > 0) {
      const token = newToken();
      // Asking for a link deliberately does not revoke the previous one. This
      // endpoint takes an email address and nothing else, so revoking here
      // would let anyone who knows the address knock the owner's link out from
      // under them, over and over. Revocation lives inside the view instead,
      // where holding a working link is the proof that you may end the others.
      await store.operatorTokens.insertOne({
        _id: newId('o'),
        email,
        hash: hashToken(token),
        createdAt: new Date(),
        lastUsedAt: null,
      });
      try {
        await mailer.sendOperatorLink(email, `${config.baseUrl}/operator/${token}`, projects);
      } catch (error) {
        // A bounced or failed send must not answer differently from an address
        // that owns nothing, or the failure itself becomes the account probe.
        request.log.error({ err: error }, 'operator link delivery failed');
      }
    }

    // The same answer either way: whether an address owns projects here is not
    // something a stranger gets to probe.
    return reply.type('text/html; charset=utf-8').send(
      layout(
        { title: 'Check your email' },
        `<h1>Check your email</h1>
         <p>If ${escapeHtml(email)} has claimed any project on Muster, the link is on its way.</p>
         <p><a href="/">Back</a></p>`,
      ),
    );
  });

  app.get('/operator/:token', { schema: { hide: true } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const record = await store.operatorTokens.findOne({ hash: hashToken(token) });
    if (!record) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(
          layout(
            { title: 'No such link' },
            '<h1>No such link</h1><p>That link is wrong or was replaced. <a href="/operator">Ask for a new one</a>.</p>',
          ),
        );
    }
    void store.operatorTokens.updateOne({ _id: record._id }, { $set: { lastUsedAt: new Date() } });

    const projects = await store.projects.find({ claimedBy: record.email }).toArray();
    const ids = projects.map((project) => project._id);
    const names = new Map(projects.map((project) => [project._id, project.name]));

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
  <form method="post" action="/operator/${escapeHtml(token)}/escalations/${escapeHtml(id)}">
    <label>Your answer<textarea name="answer" placeholder="The decision, in your words."></textarea></label>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
      <button type="submit" name="status" value="answered">Answer</button>
      <button class="ghost" type="submit" name="status" value="resolved">Already handled</button>
      <button class="ghost" type="submit" name="status" value="wont_do">Won't do</button>
      <button class="ghost" type="submit" name="status" value="in_progress">I'm on it</button>
    </div>
  </form>
</div>`;

    const body = `
<h1>${waiting.length === 0 ? 'Nothing is waiting on you' : `${waiting.length} question${waiting.length === 1 ? '' : 's'} for you`}</h1>
<p class="lead">Across ${projects.length} project${projects.length === 1 ? '' : 's'} claimed by
${escapeHtml(record.email)}.</p>

${waiting
  .map((doc) =>
    question(doc._id, doc.projectId, doc.question, doc.context, doc.agent, doc.priority, doc.createdAt),
  )
  .join('')}

<h2>Projects</h2>
<div class="scroll"><table>
<thead><tr><th>Project</th><th class="mono">items</th><th class="mono">agents</th><th>Open</th><th></th></tr></thead>
<tbody>
${projects
  .map(
    (project) =>
      `<tr><td>${escapeHtml(project.name)}<br><span class="mono" style="color:var(--muted)">${escapeHtml(project._id)}</span></td>
       <td class="mono">${project.counts.items}</td><td class="mono">${project.counts.agents}</td>
       <td class="mono">${waiting.filter((doc) => doc.projectId === project._id).length}</td>
       <td><a href="/r/${escapeHtml(project.readToken)}">open</a></td></tr>`,
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

<h2>This link</h2>
<p style="color:var(--ink-2);font-size:15px">Anyone holding it can answer your agents. If one has
gone somewhere it should not have, end every link except this one.</p>
<form method="post" action="/operator/${escapeHtml(token)}/revoke-others">
  <div><button class="ghost" type="submit">Turn off every other link</button></div>
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
    return reply
      .type('text/html; charset=utf-8')
      .send(layout({ title: 'Muster operator view' }, body));
  });

  app.post('/operator/:token/revoke-others', { schema: { hide: true } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const record = await store.operatorTokens.findOne({ hash: hashToken(token) });
    if (!record) throw new ServiceError(404, 'not_found', 'No such link.');

    const removed = await store.operatorTokens.deleteMany({
      email: record.email,
      _id: { $ne: record._id },
    });
    return reply.type('text/html; charset=utf-8').send(
      layout(
        { title: 'Other links turned off' },
        `<h1>Done</h1>
         <p>${removed.deletedCount} other link${removed.deletedCount === 1 ? '' : 's'} stopped working.
         This one still does.</p>
         <p><a href="/operator/${escapeHtml(token)}">Back to your projects</a></p>`,
      ),
    );
  });

  app.post(
    '/operator/:token/escalations/:id',
    { schema: { hide: true } },
    async (request, reply) => {
      const { token, id } = request.params as { token: string; id: string };
      const form = (request.body ?? {}) as { status?: string; answer?: string };
      const record = await store.operatorTokens.findOne({ hash: hashToken(token) });
      if (!record) throw new ServiceError(404, 'not_found', 'No such link.');

      const escalation = await store.escalations.findOne({ _id: id });
      if (!escalation) throw new ServiceError(404, 'not_found', 'No such question.');
      const project = await store.projects.findOne({
        _id: escalation.projectId,
        claimedBy: record.email,
      });
      if (!project) {
        throw new ServiceError(403, 'not_yours', 'That question belongs to somebody else’s project.');
      }

      const status = (form.status ?? 'answered') as EscalationStatus;
      if (!ESCALATION_STATUSES.includes(status)) {
        throw new ServiceError(400, 'bad_status', 'Unknown answer type.');
      }
      await answerEscalation(store, project._id, id, status, (form.answer ?? '').slice(0, 8000));
      return reply.redirect(`/operator/${token}`, 303);
    },
  );
}
