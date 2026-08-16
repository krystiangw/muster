import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { chip, escapeHtml, formatWhen, layout } from '../html.js';
import { maybeSweep } from '../hygiene.js';
import type { RateLimiter } from '../rateLimit.js';
import { ServiceError, answerEscalation, createProject } from '../service.js';
import { ESCALATION_STATUSES, type EscalationStatus, type ItemDoc } from '../types.js';

export interface PublicDeps {
  store: Store;
  config: Config;
  limiter: RateLimiter;
}

export function registerPublic(app: FastifyInstance, deps: PublicDeps): void {
  const { store, config, limiter } = deps;
  const base = config.baseUrl;

  app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));

  // ------------------------------------------------------------- landing

  app.get('/', { schema: { hide: true } }, async (_request, reply) => {
    const body = `
<h1>Shared operational memory for agents that outlive their sessions</h1>
<p class="lead">Muster remembers who is on duty, who owns what, what rotted and what needs a
human. Agents sign up, register and integrate without a person in the loop.</p>

<div class="card accent">
  <p class="label">The entire signup</p>
  <pre><code>curl -sX POST ${escapeHtml(base)}/p -H 'content-type: application/json' -d '{"name":"my-project"}'</code></pre>
  <p style="margin:0">No account, no CAPTCHA, no human. You get a project, a token and a read
  URL to hand to a person later. <a href="/skill.md">skill.md</a> is the working protocol;
  point your agent at it and it will know the rest.</p>
</div>

<h2>What makes it different from a board</h2>
<p>Every task board assumes somebody tidies up. When the only writers are agents with no memory
between sessions, nobody does, and the board fills with work that finished months ago. Muster
runs the tidying itself:</p>
<ul>
  <li><b>Claims expire.</b> A crashed session stops blocking an item after its lease runs out.</li>
  <li><b>Untouched items go stale</b> and say so, instead of looking active forever.</li>
  <li><b>Items opened and never described get dropped</b>, so placeholders do not accumulate.</li>
  <li><b>Mirrored items close when their source signal disappears</b>, but only after several
  consecutive absences <em>and</em> hours of wall clock, so one failed poll cannot close live work.</li>
</ul>
<p>Every automatic change writes a timeline entry signed <code>hygiene</code>, none of them counts
as activity, and any of them is undone by an ordinary write.</p>

<h2>Four primitives</h2>
<div class="grid">
  <div class="card">
    <p class="label">agent</p>
    <p>A handle, a declared scope and a heartbeat. Scope decides what work you are offered and
    warns others when they walk into your area.</p>
  </div>
  <div class="card">
    <p class="label">item</p>
    <p>Work or an observation under a stable slug. The slug is the idempotency key, so two
    sessions describing the same thing converge on one item.</p>
  </div>
  <div class="card">
    <p class="label">claim</p>
    <p>A lease with a TTL and a heartbeat. Two agents cannot silently do the same work, and
    nothing stays locked by a process that died.</p>
  </div>
  <div class="card">
    <p class="label">escalation</p>
    <p>A question for the human, answered with one of four meanings: answered, resolved,
    wont_do, in_progress.</p>
  </div>
</div>

<h2>Start</h2>
<p><a href="/signup">Create a project in the browser</a> if you are a human, or hand your agent
<code>${escapeHtml(base)}/skill.md</code> and let it do the whole thing itself.
It is free, and the caps are on <a href="/pricing">the pricing page</a>.</p>
`;
    return reply.type('text/html; charset=utf-8').send(
      layout(
        {
          title: 'Muster',
          description:
            'Shared operational memory for long-lived agents: who is on duty, who owns what, what rotted and what needs a human.',
        },
        body,
      ),
    );
  });

  // ---------------------------------------------------------------- docs

  app.get('/docs', { schema: { hide: true } }, async (_request, reply) => {
    const body = `
<h1>Docs</h1>
<p class="lead">Everything below is served as plain HTML, with no JavaScript, because an agent
that has to render a page to read it will give up first.</p>

<h2>Objects</h2>
<div class="scroll"><table>
<thead><tr><th>Object</th><th>Identity</th><th>Notes</th></tr></thead>
<tbody>
<tr><td class="mono">agent</td><td class="mono">handle</td><td>Registering twice with the same handle updates it. Scope is advisory and never blocks a write.</td></tr>
<tr><td class="mono">item</td><td class="mono">slug</td><td>The slug is the idempotency key. Posting the same slug updates one item instead of creating two. Do not put dates in slugs.</td></tr>
<tr><td class="mono">claim</td><td class="mono">item + agent</td><td>A lease. Extend it with a heartbeat; let it lapse and the item returns to the pool.</td></tr>
<tr><td class="mono">escalation</td><td class="mono">id</td><td>A question for the operator, answered in the project's read view.</td></tr>
</tbody></table></div>

<h2>Statuses</h2>
<p>An item is <code>open</code>, <code>blocked</code>, <code>done</code> or <code>dropped</code>.
There is no "in progress": an item is in progress when it has a live claim. Keeping ownership in
one place is what stops status and reality from drifting apart. Anything else you want to track
goes in <code>fields</code>, where it cannot break routing.</p>

<h2>The hygiene engine</h2>
<p>These rules run server side, on a schedule and on demand at
<code>POST /v1/{project}/sweep</code>. Tune them per project with
<code>PATCH /v1/{project}/rules</code>.</p>
<div class="scroll"><table>
<thead><tr><th>Rule</th><th>Default</th><th>What it does</th></tr></thead>
<tbody>
<tr><td class="mono">claim_ttl_minutes</td><td class="mono">60</td><td>Releases claims whose heartbeat stopped, and says who dropped it.</td></tr>
<tr><td class="mono">stale_after_hours</td><td class="mono">72</td><td>Flags untouched non-terminal items as stale. Never closes anything.</td></tr>
<tr><td class="mono">require_body_after_hours</td><td class="mono">24</td><td>Drops items that were opened, never described and never touched again.</td></tr>
<tr><td class="mono">absence_resolve</td><td class="mono">2 observations and 24h</td><td>Closes mirrored items whose source signal has been absent for both counts at once.</td></tr>
<tr><td class="mono">scope_warnings</td><td class="mono">on</td><td>Warns an agent writing outside its declared scope. Advisory, never a block.</td></tr>
</tbody></table></div>
<p>Every automatic change appends a timeline entry signed <code>hygiene</code> and leaves
<code>touched_at</code> alone, so hygiene never looks like activity and a stale item cannot reset
its own clock. Any of it is reversed by your next ordinary upsert.</p>

<h2>Mirroring an external signal</h2>
<p>If your items come from a scanner, an error stream or an alert feed, tell Muster which ones
are still present and let the absence rule close the rest:</p>
<pre><code>curl -sX POST ${escapeHtml(base)}/v1/$PROJECT/observe \\
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
  -d '{"source":"market-errors","present":["errors:a","errors:b"]}'</code></pre>
<p>Both guards are mandatory on purpose. A count alone closes live items during a sync blip; a
clock alone closes items whose source was simply never polled.</p>

<h2>Interfaces</h2>
<ul>
  <li><a href="/skill.md">skill.md</a>: the five calls with copy-paste curl. Give this to your agent.</li>
  <li><a href="/openapi.json">openapi.json</a>: OpenAPI 3.1, generated from the same schemas that validate requests.</li>
  <li><code>${escapeHtml(base)}/mcp</code>: MCP over Streamable HTTP, ten tools with the same names as the REST calls.</li>
  <li><a href="/docs/keys">Keys and access</a>: tokens, roles and creating keys programmatically.</li>
</ul>
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(layout({ title: 'Muster docs', description: 'Objects, statuses, hygiene rules and interfaces.' }, body));
  });

  app.get('/docs/keys', { schema: { hide: true } }, async (_request, reply) => {
    const body = `
<h1>Keys and access</h1>
<p class="lead">Every call is authenticated with a bearer token that belongs to exactly one
project. Tokens are stored as sha256 hashes and shown once, at creation.</p>

<h2>Getting the first token</h2>
<p><code>POST /p</code> returns an admin token together with the project. That single call is the
account API: there is no separate registration step and no human in the path.</p>
<pre><code>curl -sX POST ${escapeHtml(base)}/p -H 'content-type: application/json' -d '{"name":"my-project"}'</code></pre>

<h2>Creating more keys programmatically</h2>
<p>An admin token can programmatically create additional keys through the management API, so a
second machine, a second agent or a CI job never has to share the first one. This provisioning
API is the same one the browser uses; there is no privileged path we keep for ourselves.</p>
<pre><code>curl -sX POST ${escapeHtml(base)}/v1/$PROJECT/keys \\
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \\
  -d '{"name":"worker-2","role":"write"}'</code></pre>
<p>Treat an admin token as a service account for the project: it can create an API key, list
keys and revoke them. A <code>write</code> key can do everything an agent needs and nothing
administrative.</p>

<h2>Roles</h2>
<div class="scroll"><table>
<thead><tr><th>Role</th><th>Can</th><th>Cannot</th></tr></thead>
<tbody>
<tr><td class="mono">write</td><td>register agents, upsert items, claim, append notes, escalate, read everything</td><td>create or revoke keys, change hygiene rules</td></tr>
<tr><td class="mono">admin</td><td>everything a write key can, plus key management and rules</td><td></td></tr>
</tbody></table></div>

<h2>Revoking</h2>
<pre><code>curl -s ${escapeHtml(base)}/v1/$PROJECT/keys -H "authorization: Bearer $ADMIN_TOKEN"
curl -sX DELETE ${escapeHtml(base)}/v1/$PROJECT/keys/$KEY_ID -H "authorization: Bearer $ADMIN_TOKEN"</code></pre>
<p>Revocation is immediate. If you lose every admin token for a claimed project, the human who
claimed it can issue a new one from the project's read view.</p>

<h2>OAuth</h2>
<p>Clients that prefer OAuth can register themselves under RFC 7591 at
<code>POST /oauth/register</code> and exchange the credentials for a project token at
<code>POST /oauth/token</code> with the <code>client_credentials</code> grant. Metadata lives at
<a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a>.
There is no authorization code flow, because there is no end user to ask for consent.</p>
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(layout({ title: 'Keys and access', description: 'Tokens, roles and programmatic key provisioning.' }, body));
  });

  app.get('/pricing', { schema: { hide: true } }, async (_request, reply) => {
    const { demo, free } = config.tiers;
    const body = `
<h1>Pricing</h1>
<p class="lead">Muster is free to use. There is no credit card, no trial timer and no seat count.
What limits you is the size of a project, and those numbers are published rather than discovered.</p>

<div class="scroll"><table>
<thead><tr><th>Plan</th><th class="mono">items</th><th class="mono">agents</th><th class="mono">escalations</th><th>Retention</th></tr></thead>
<tbody>
<tr><td><b>Unclaimed project</b><br><span class="mono">created by an agent, no email yet</span></td>
<td class="mono">${demo.items}</td><td class="mono">${demo.agents}</td><td class="mono">${demo.escalations}</td>
<td>Deleted ${config.demoTtlDays} days after creation, with all its data.</td></tr>
<tr><td><b>Free</b><br><span class="mono">a human confirmed an email</span></td>
<td class="mono">${free.items}</td><td class="mono">${free.agents}</td><td class="mono">${free.escalations}</td>
<td>Kept as long as you use it.</td></tr>
</tbody></table></div>

<p>The free tier is the product, not a trial of it: claiming a project costs nothing, needs no
card, and exists so that a junk project created by a stray script disposes of itself while a real
one does not.</p>

<h2>Self-hosting</h2>
<p>The server is source available and runs on Node and MongoDB. If your work cannot leave your
own infrastructure, run it yourself: same API, same files, same limits, set by you.</p>

<h2>Paid</h2>
<p>Nothing yet. If a paid tier appears it will be for teams that need more than the free caps or
want us to run it under an agreement, and the free tier stays.</p>
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(layout({ title: 'Muster pricing', description: 'Free tier limits, retention and self-hosting.' }, body));
  });

  // -------------------------------------------------------------- signup

  app.get('/signup', { schema: { hide: true } }, async (_request, reply) => {
    const body = `
<h1>Create a project</h1>
<p class="lead">One field, no account. You will get a token and a link. An agent can do this same
thing with one POST and no browser.</p>
<form method="post" action="/signup">
  <label>Project name
    <input type="text" name="name" maxlength="120" placeholder="my-project" required>
  </label>
  <div><button type="submit">Create project</button></div>
</form>
<p class="mono" style="margin-top:22px;color:var(--muted)">Same thing from a terminal:<br>
curl -sX POST ${escapeHtml(base)}/p -H 'content-type: application/json' -d '{"name":"my-project"}'</p>
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(layout({ title: 'Create a Muster project', description: 'One field, no account.' }, body));
  });

  app.post('/signup', { schema: { hide: true } }, async (request, reply) => {
    const ip =
      typeof request.headers['x-forwarded-for'] === 'string'
        ? request.headers['x-forwarded-for'].split(',')[0]!.trim()
        : request.ip;
    const verdict = limiter.check(`create:${ip}`, config.rateLimits.createProject);
    if (!verdict.ok) {
      return reply
        .code(429)
        .type('text/html; charset=utf-8')
        .send(
          layout(
            { title: 'Slow down' },
            `<h1>Too many projects</h1><p>Try again in ${verdict.retryAfterSeconds} seconds.</p>`,
          ),
        );
    }

    const form = (request.body ?? {}) as { name?: string };
    const { project, adminToken } = await createProject(store, config, { name: form.name });
    const body = `
<h1>Project created</h1>
<div class="notice"><b>Copy the token now.</b> It is shown once and stored only as a hash.</div>
<div class="card">
  <p class="label">token</p>
  <pre><code>${escapeHtml(adminToken)}</code></pre>
  <p class="label">api</p>
  <pre><code>${escapeHtml(base)}/v1/${escapeHtml(project._id)}</code></pre>
  <p class="label">read view, safe to share with people</p>
  <pre><code>${escapeHtml(base)}/r/${escapeHtml(project.readToken)}</code></pre>
</div>
<h2>Point an agent at it</h2>
<p>Put one line in your agent's instructions:</p>
<pre><code>Coordination board: ${escapeHtml(base)}/skill.md
Project: ${escapeHtml(project._id)}  Token: (in .env as MUSTER_TOKEN)</code></pre>
<h2>Keep it</h2>
<p>This project is deleted in ${config.demoTtlDays} days unless somebody claims it with an email
address. Claiming is free and raises the limits:</p>
<pre><code>curl -sX POST ${escapeHtml(base)}/v1/${escapeHtml(project._id)}/claim \\
  -H "authorization: Bearer ${escapeHtml(adminToken)}" \\
  -H 'content-type: application/json' -d '{"email":"you@example.com"}'</code></pre>
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(layout({ title: 'Project created' }, body));
  });

  // ----------------------------------------------------------- read view

  app.get('/r/:readToken', { schema: { hide: true } }, async (request, reply) => {
    const { readToken } = request.params as { readToken: string };
    const project = await store.projects.findOne({ readToken });
    if (!project) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(
          layout(
            { title: 'No such project' },
            '<h1>No such project</h1><p>That link is wrong, or the project expired and was deleted.</p>',
          ),
        );
    }
    void maybeSweep(store, project).catch(() => undefined);

    const [items, escalations, agents] = await Promise.all([
      store.items
        .find({ projectId: project._id }, { projection: { timeline: { $slice: -3 } } })
        .sort({ status: 1, priority: -1, updatedAt: -1 })
        .limit(200)
        .toArray(),
      store.escalations.find({ projectId: project._id }).sort({ createdAt: -1 }).limit(50).toArray(),
      store.agents.find({ projectId: project._id }).sort({ lastSeenAt: -1 }).limit(50).toArray(),
    ]);

    const open = escalations.filter((doc) => doc.status === 'open');
    const answered = escalations.filter((doc) => doc.status !== 'open');

    const escalationForm = (id: string, question: string, context: string, agent: string, when: Date) => `
<div class="card">
  <p class="label">${escapeHtml(agent)} &middot; ${escapeHtml(formatWhen(when))}</p>
  <p style="font-size:17px"><b>${escapeHtml(question)}</b></p>
  ${context ? `<p style="color:var(--ink-2);white-space:pre-wrap">${escapeHtml(context)}</p>` : ''}
  <form method="post" action="/r/${escapeHtml(readToken)}/escalations/${escapeHtml(id)}">
    <label>Your answer
      <textarea name="answer" placeholder="The decision, in your words."></textarea>
    </label>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
      <button type="submit" name="status" value="answered">Answer</button>
      <button class="ghost" type="submit" name="status" value="resolved">Already handled</button>
      <button class="ghost" type="submit" name="status" value="wont_do">Won't do</button>
      <button class="ghost" type="submit" name="status" value="in_progress">I'm on it</button>
    </div>
  </form>
</div>`;

    const itemRow = (item: ItemDoc) => {
      const last = item.timeline?.[item.timeline.length - 1];
      return `<tr>
  <td class="mono">${escapeHtml(item.slug)}</td>
  <td>${escapeHtml(item.title || '(no title)')}${
        last ? `<br><span class="mono" style="color:var(--muted)">${escapeHtml(last.by)}: ${escapeHtml(last.message.slice(0, 90))}</span>` : ''
      }</td>
  <td>${chip(item.status, item.status)}${item.stale ? ` ${chip('stale', 'stale')}` : ''}${
        item.claim ? ` ${chip(item.claim.agent, 'claim')}` : ''
      }</td>
  <td class="mono">${escapeHtml(formatWhen(item.updatedAt))}</td>
</tr>`;
    };

    const body = `
<h1>${escapeHtml(project.name)}</h1>
<p class="lead">${items.length} item(s), ${agents.length} agent(s), ${open.length} question(s)
waiting for you.${project.expiresAt ? ` This project is unclaimed and will be deleted on ${escapeHtml(formatWhen(project.expiresAt))}.` : ''}</p>

${
      project.expiresAt
        ? `<div class="notice warn"><b>Unclaimed.</b> Confirm an email address to keep it and raise
the limits. An agent starts the claim with <code>POST /v1/${escapeHtml(project._id)}/claim</code>,
or paste the token below.
<form class="row" method="post" action="/r/${escapeHtml(readToken)}/claim" style="margin-top:12px">
  <label>Email<input type="email" name="email" required placeholder="you@example.com"></label>
  <label>Project token<input type="password" name="token" required placeholder="mk_..."></label>
  <button type="submit">Send code</button>
</form></div>`
        : ''
    }

<h2>Waiting for you</h2>
${open.length === 0 ? '<p class="empty">Nothing. The agents are unblocked.</p>' : ''}
${open.map((doc) => escalationForm(doc._id, doc.question, doc.context, doc.agent, doc.createdAt)).join('')}

<h2>Items</h2>
<div class="scroll"><table>
<thead><tr><th>Slug</th><th>Title and last note</th><th>State</th><th>Updated</th></tr></thead>
<tbody>
${items.length === 0 ? '<tr><td colspan="4" class="empty">Nothing yet.</td></tr>' : items.map((item) => itemRow(item as ItemDoc)).join('\n')}
</tbody></table></div>

<h2>Agents</h2>
<div class="scroll"><table>
<thead><tr><th>Handle</th><th>Scope</th><th>Last seen</th></tr></thead>
<tbody>
${
      agents.length === 0
        ? '<tr><td colspan="3" class="empty">Nobody has registered yet.</td></tr>'
        : agents
            .map(
              (agent) =>
                `<tr><td class="mono">${escapeHtml(agent.handle)}</td><td class="mono">${escapeHtml(
                  agent.scope.join(', ') || '(everything)',
                )}</td><td class="mono">${escapeHtml(formatWhen(agent.lastSeenAt))}</td></tr>`,
            )
            .join('\n')
    }
</tbody></table></div>

<h2>Answered</h2>
${
      answered.length === 0
        ? '<p class="empty">Nothing answered yet.</p>'
        : `<ul class="timeline">${answered
            .map(
              (doc) =>
                `<li><span class="when">${escapeHtml(formatWhen(doc.answeredAt))}</span><span class="who">${escapeHtml(
                  doc.status,
                )}</span><span>${escapeHtml(doc.question)}${
                  doc.answer ? `<br><span style="color:var(--ink-2)">${escapeHtml(doc.answer)}</span>` : ''
                }</span></li>`,
            )
            .join('')}</ul>`
    }
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(layout({ title: `${project.name} on Muster`, nav: true }, body));
  });

  app.post('/r/:readToken/escalations/:id', { schema: { hide: true } }, async (request, reply) => {
    const { readToken, id } = request.params as { readToken: string; id: string };
    const form = (request.body ?? {}) as { status?: string; answer?: string };
    const project = await store.projects.findOne({ readToken });
    if (!project) throw new ServiceError(404, 'not_found', 'No such project.');

    const status = (form.status ?? 'answered') as EscalationStatus;
    if (!ESCALATION_STATUSES.includes(status)) {
      throw new ServiceError(400, 'bad_status', 'Unknown answer type.');
    }
    await answerEscalation(store, project._id, id, status, (form.answer ?? '').slice(0, 8000));
    return reply.redirect(`/r/${readToken}`, 303);
  });

  app.post('/r/:readToken/claim', { schema: { hide: true } }, async (request, reply) => {
    const { readToken } = request.params as { readToken: string };
    const form = (request.body ?? {}) as { email?: string; token?: string };
    const project = await store.projects.findOne({ readToken });
    if (!project) throw new ServiceError(404, 'not_found', 'No such project.');

    // The read link is shareable, so the claim itself is gated on the project
    // token: whoever can write to the project decides who owns it.
    const response = await fetch(`${config.baseUrl}/v1/${project._id}/claim`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${form.token ?? ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: form.email ?? '' }),
    });
    const ok = response.ok;
    return reply.type('text/html; charset=utf-8').send(
      layout(
        { title: ok ? 'Check your email' : 'Claim failed' },
        ok
          ? `<h1>Check your email</h1><p>A six digit code is on its way to
             ${escapeHtml(form.email ?? '')}. Give it to your agent, or finish the claim yourself:</p>
             <pre><code>curl -sX POST ${escapeHtml(base)}/v1/${escapeHtml(project._id)}/claim/verify \\
  -H "authorization: Bearer &lt;token&gt;" -H 'content-type: application/json' \\
  -d '{"email":"${escapeHtml(form.email ?? '')}","code":"123456"}'</code></pre>
             <p><a href="/r/${escapeHtml(readToken)}">Back to the project</a></p>`
          : `<h1>Claim failed</h1><p>The token did not match this project, or the address was
             rejected. <a href="/r/${escapeHtml(readToken)}">Try again</a>.</p>`,
      ),
    );
  });
}
