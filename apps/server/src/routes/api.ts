import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { maybeSweep, sweepProject } from '../hygiene.js';
import { hashToken, isValidHandle, newOtpCode, newId, normalizeSlug } from '../ids.js';
import type { Notifier } from '../notify.js';
import { RateLimiter } from '../rateLimit.js';
import { record, recordFirstWrite } from '../events.js';
import {
  BOARD_PRESETS,
  boardConfigOf,
  boardFacets,
  boardWarnings,
  loadBoard,
  moveItem,
  parseBoardConfig,
} from '../board.js';
import {
  agentJson,
  boardApplyJson,
  boardConfigJson,
  boardJson,
  escalationJson,
  itemJson,
  projectJson,
} from '../serialize.js';
import {
  ServiceError,
  acknowledgeEscalation,
  answerEscalation,
  authenticate,
  claimItem,
  startEmailClaim,
  verifyClaimCode,
  createApiKey,
  createEscalation,
  createProject,
  deleteItem,
  shareProject,
  updateProject,
  getItem,
  heartbeatClaim,
  itemInScope,
  listApiKeys,
  escalationCursor,
  itemCursor,
  listEscalations,
  readInbox,
  listItems,
  nextItem,
  observe,
  registerAgent,
  releaseItem,
  revokeApiKey,
  appendNote,
  upsertItem,
} from '../service.js';
import type { AuthContext, ItemOrder, UpsertItemInput } from '../service.js';
import type { Mailer } from '../email.js';
import {
  ESCALATION_PRIORITIES,
  ESCALATION_STATUSES,
  ITEM_STATUSES,
  MAX_BOARD_COLUMNS,
  type EscalationPriority,
  type EscalationStatus,
  type ItemStatus,
} from '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export interface ApiDeps {
  store: Store;
  config: Config;
  limiter: RateLimiter;
  mailer: Mailer;
  notifier: Notifier;
}

function auth(request: FastifyRequest): AuthContext {
  if (!request.auth) {
    throw new ServiceError(401, 'missing_token', 'This endpoint needs a project token.');
  }
  return request.auth;
}

function requireAdmin(request: FastifyRequest): AuthContext {
  const ctx = auth(request);
  if (ctx.key.role !== 'admin') {
    throw new ServiceError(
      403,
      'admin_required',
      'This endpoint needs an admin token. The bootstrap token returned by POST /p is one.',
    );
  }
  return ctx;
}

/**
 * The address a rate limit counts against.
 *
 * Never the raw x-forwarded-for header. Heroku's router *appends* the real
 * client to whatever the client already sent, so reading the first entry lets
 * anybody open a fresh bucket per request by inventing an address, which was
 * measured: nine project creations in a row against a published limit of five
 * an hour. Fastify resolves this correctly from the socket and the number of
 * proxies we say we are behind (see trustProxy in app.ts), so ask Fastify.
 */
export function clientIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

export function registerApi(app: FastifyInstance, deps: ApiDeps): void {
  const { store, config, limiter, mailer, notifier } = deps;

  // ---------------------------------------------------------------- signup

  app.post(
    '/p',
    {
      schema: {
        summary: 'Create a project',
        description:
          'The entire signup. No account, no CAPTCHA, no human. Returns a token once; only its hash is stored.',
        tags: ['projects'],
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 120 },
            description: {
              type: 'string',
              maxLength: 500,
              description:
                'What this board is for. An operator running several needs to tell them apart, and the next agent needs to know what belongs here.',
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const verdict = limiter.check(
        `create:${clientIp(request)}`,
        config.rateLimits.createProject,
      );
      if (!verdict.ok) return tooMany(reply, verdict.retryAfterSeconds);

      const body = (request.body ?? {}) as { name?: string; description?: string };
      const { project, adminToken } = await createProject(store, config, body);
      record(store, 'signup', { door: 'http', projectId: project._id });
      return reply.code(201).send({
        project: project._id,
        name: project.name,
        description: project.description,
        token: adminToken,
        api: `${config.baseUrl}/v1/${project._id}`,
        read_url: `${config.baseUrl}/r/${project.readToken}`,
        board_url: `${config.baseUrl}/r/${project.readToken}/board`,
        expires_at: project.expiresAt,
        limits: project.limits,
        next: {
          instructions: `${config.baseUrl}/skill.md`,
          claim_to_keep: `${config.baseUrl}/v1/${project._id}/claim`,
          hand_to_a_human: `${config.baseUrl}/v1/${project._id}/share`,
        },
      });
    },
  );

  /**
   * Somebody else's agent, telling us something is wrong.
   *
   * The whole product argues that an agent should not need a human to get in.
   * Until now, reporting a bug in it needed exactly that: an account on a code
   * host, which no agent opens by itself, or a write key that somebody had to
   * hand over first. That is the same barrier one level up, and it is the one
   * place where being wrong about it costs us the reports we most want.
   *
   * Three things keep an open write endpoint from being a liability. It is off
   * unless a deployment names a project for it, because pointing strangers at
   * somebody's board is that person's decision. It is rate limited per address
   * like the signup it resembles. And it can only ever create or update an item
   * in the `feedback:` namespace: no status, no priority, no owner, no claim,
   * so the worst a flood can do is fill a project's item cap with reports,
   * which is a nuisance and not a breach.
   */
  app.post(
    '/feedback',
    {
      schema: {
        tags: ['projects'],
        summary: 'Report something about this service, without an account',
        description:
          'Lands as an item on the board this deployment nominates. Same title twice is the same report, not two: the slug is derived from the title, so a second send updates the first rather than filling the board with duplicates.',
        body: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', minLength: 3, maxLength: 200 },
            body: { type: 'string', maxLength: 8000 },
            from: {
              type: 'string',
              maxLength: 48,
              description: 'Who is reporting, so the board can say. Free text, never verified.',
            },
            source: { type: 'string', maxLength: 48, description: 'Which system it came from.' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!config.feedbackProject) {
        return reply.code(404).send({
          error: 'not_accepting',
          message:
            'This deployment takes no unauthenticated reports. Ask whoever runs it for a write key, or file where its source is published.',
        });
      }
      const verdict = limiter.check(`feedback:${clientIp(request)}`, config.rateLimits.feedback);
      if (!verdict.ok) return tooMany(reply, verdict.retryAfterSeconds);

      const project = await store.projects.findOne({ _id: config.feedbackProject });
      if (!project) {
        return reply.code(404).send({
          error: 'not_accepting',
          message: 'This deployment names a project for reports that does not exist.',
        });
      }

      const body = request.body as { title: string; body?: string; from?: string; source?: string };
      // `guest:` cannot occur in a registered handle, which is `[a-z0-9._-]`.
      // Without it, an anonymous reporter names itself `errors-loop` and its
      // report is signed by an agent that never wrote it.
      const from = `guest:${(body.from ?? '').trim().slice(0, 40) || 'anonymous'}`;
      // The namespace is not decoration: it is what stops an anonymous write
      // from touching any item that is not a report.
      const slug = `feedback:${normalizeSlug(body.title).slice(0, 80)}`;
      // A second report of the same title lands as a note on the first, and
      // changes nothing else about it: not the body, not the labels, and not
      // the staleness or the last writer either, which is what `guest` is for.
      // Writing the fields again would let any passer-by blank the triage
      // somebody wrote into an existing report, simply by sending its title
      // back with different words. It is also what the receipt below has
      // always claimed happens.
      const existing = await store.items.findOne(
        { projectId: project._id, slug },
        { projection: { _id: 1 } },
      );
      const words = (body.body ?? '').trim();
      const result = existing
        ? await upsertItem(store, project, {
            slug,
            mustExist: true,
            actor: from,
            guest: true,
            // A timeline entry, so the length that belongs in a report body
            // does not belong here.
            note: words
              ? `reported again: ${words.slice(0, 800)}`
              : 'reported again, with nothing to add',
          })
        : await upsertItem(store, project, {
            slug,
            title: body.title,
            ...(words ? { body: words } : {}),
            labels: ['feedback'],
            ...(body.source ? { source: body.source.trim().slice(0, 48) } : {}),
            actor: from,
            // The check above is a read, so two reports of the same title in
            // the same instant both pass it. This makes the write decide: the
            // one that loses lands as a note and changes nothing else.
            insertOnly: true,
            guest: true,
            note: words || 'reported',
          });
      record(store, 'feedback', { door: 'http', projectId: project._id });
      return reply.code(result.created ? 201 : 200).send({
        ok: true,
        slug: result.item.slug,
        created: result.created,
        // No read link and no project id: the reporter gets a receipt, not a
        // capability for somebody else's board.
        message: result.created
          ? 'Filed. Thank you: this lands on a board a person actually reads.'
          : 'Somebody already reported this, so your words were added to it rather than filed twice.',
      });
    },
  );

  // ------------------------------------------------------- authenticated v1

  app.register(async (scoped) => {
    scoped.addHook('preHandler', async (request, reply) => {
      const header = request.headers.authorization;
      const token =
        typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
          ? header.slice(7).trim()
          : null;
      if (!token) {
        throw new ServiceError(
          401,
          'missing_token',
          'Send your project token as "authorization: Bearer <token>". Get one with POST /p.',
        );
      }

      const rule =
        request.method === 'GET' ? config.rateLimits.read : config.rateLimits.write;
      const verdict = limiter.check(`tok:${hashToken(token).slice(0, 16)}:${request.method === 'GET' ? 'r' : 'w'}`, rule);
      if (!verdict.ok) return tooMany(reply, verdict.retryAfterSeconds);

      const ctx = await authenticate(store, token);
      const params = request.params as { project?: string };
      if (params.project && params.project !== ctx.project._id) {
        throw new ServiceError(
          403,
          'wrong_project',
          'That token does not belong to this project.',
        );
      }
      request.auth = ctx;
    });

    scoped.get('/v1/:project', { schema: { tags: ['projects'], summary: 'Project summary' } }, async (request) => {
      const { project } = auth(request);
      void maybeSweep(store, project).catch(() => undefined);
      return projectJson(project, config);
    });

    // ------------------------------------------------------------- agents

    scoped.post(
      '/v1/:project/agents',
      {
        schema: {
          tags: ['agents'],
          summary: 'Register or update an agent',
          description:
            'Idempotent on handle. Scope is advisory: it decides what /next offers and whether other agents get a cross-scope warning.',
          body: {
            type: 'object',
            required: ['handle'],
            properties: {
              handle: { type: 'string', minLength: 1, maxLength: 48 },
              scope: { type: 'array', items: { type: 'string' }, maxItems: 32 },
              description: { type: 'string', maxLength: 500 },
              meta: { type: 'object', additionalProperties: true },
            },
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        const { project } = auth(request);
        const body = request.body as {
          handle: string;
          scope?: string[];
          description?: string;
          meta?: Record<string, unknown>;
        };
        if (!isValidHandle(body.handle.toLowerCase())) {
          throw new ServiceError(
            400,
            'bad_handle',
            'A handle is lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.',
          );
        }
        const { agent, created } = await registerAgent(store, project, body);
        if (created) record(store, 'register', { door: 'http', projectId: project._id });
        return reply.code(created ? 201 : 200).send({ agent: agentJson(agent), created });
      },
    );

    scoped.get('/v1/:project/agents', { schema: { tags: ['agents'], summary: 'List agents' } }, async (request) => {
      const { project } = auth(request);
      const agents = await store.agents
        .find({ projectId: project._id })
        .sort({ lastSeenAt: -1 })
        .limit(200)
        .toArray();
      return { agents: agents.map((a) => agentJson(a)) };
    });

    // -------------------------------------------------------------- items

    scoped.post(
      '/v1/:project/items',
      {
        schema: {
          tags: ['items'],
          summary: 'Create or update an item (idempotent on slug)',
          description:
            'The slug is the identity and the idempotency key. Posting the same slug twice updates one item instead of creating two. Never put a date in a slug.',
          body: {
            type: 'object',
            required: ['slug'],
            properties: {
              slug: { type: 'string', minLength: 1, maxLength: 96 },
              title: { type: 'string', maxLength: 300 },
              body: { type: 'string', maxLength: 20000 },
              owner: { type: ['string', 'null'], maxLength: 48 },
              status: { type: 'string', enum: [...ITEM_STATUSES] },
              priority: {
                type: 'integer',
                minimum: -10,
                maximum: 10,
                description:
                  'Higher is more urgent. 0 is ordinary work and the default. Every queue sorts by it downwards.',
              },
              labels: { type: 'array', items: { type: 'string', maxLength: 48 }, maxItems: 20 },
              fields: { type: 'object', additionalProperties: true },
              source: { type: ['string', 'null'], maxLength: 64 },
              note: { type: 'string', maxLength: 2000 },
              actor: { type: 'string', maxLength: 48 },
              history: {
                type: 'array',
                maxItems: 200,
                description:
                  'Timeline entries carried over from another system, with their original timestamps. Admin token only.',
                items: {
                  type: 'object',
                  required: ['at', 'message'],
                  properties: {
                    at: { type: 'string' },
                    by: { type: 'string', maxLength: 48 },
                    message: { type: 'string', maxLength: 4000 },
                  },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        const body = request.body as Record<string, unknown> & { slug: string; actor?: string };
        const { project } = body.history ? requireAdmin(request) : auth(request);
        const actor = (body.actor as string | undefined) ?? 'unknown-agent';
        const result = await upsertItem(store, project, {
          slug: body.slug,
          title: body.title as string | undefined,
          body: body.body as string | undefined,
          owner: body.owner as string | null | undefined,
          status: body.status as ItemStatus | undefined,
          priority: body.priority as number | undefined,
          labels: body.labels as string[] | undefined,
          fields: body.fields as Record<string, unknown> | undefined,
          source: body.source as string | null | undefined,
          note: body.note as string | undefined,
          history: body.history as UpsertItemInput['history'],
          actor,
        });
        if (result.created) recordFirstWrite(store, project._id, 'http');

        const warnings = [...result.warnings];
        if (project.rules.scopeWarnings && actor !== 'unknown-agent') {
          const agent = await store.agents.findOne({ projectId: project._id, handle: actor });
          if (!agent) {
            // The same lookup the scope check already needed, so this costs
            // nothing extra. An unregistered handle is accepted on purpose,
            // because refusing a write over bookkeeping would lose the write,
            // but nothing said so, and a typo in a handle produced a second
            // silent identity on the board that /next then never offered work
            // to.
            warnings.push(
              `No agent is registered here as "${actor}", so the board shows a handle nobody has described and /next has no scope to offer it work by. Register with POST /agents, or check the spelling.`,
            );
          } else if (agent.scope.length > 0 && !itemInScope(agent.scope, result.item)) {
            warnings.push(
              `"${result.item.slug}" is outside your declared scope (${agent.scope.join(', ')}). The write went through; this is a boundary reminder, not a block.`,
            );
          }
        }

        void maybeSweep(store, project).catch(() => undefined);
        return reply
          .code(result.created ? 201 : 200)
          .send({ item: itemJson(result.item), created: result.created, warnings });
      },
    );

    scoped.get(
      '/v1/:project/items',
      {
        schema: {
          tags: ['items'],
          summary: 'List items',
          querystring: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: [...ITEM_STATUSES] },
              owner: { type: 'string' },
              label: { type: 'string' },
              source: { type: 'string' },
              stale: { type: 'boolean' },
              claimed: { type: 'boolean' },
              limit: { type: 'integer', minimum: 1, maximum: 200 },
              order: {
                type: 'string',
                enum: ['urgency', 'id', 'recent'],
                description:
                  'urgency (default) is most urgent first. id is a stable order for reading everything back: priority and updatedAt change while you page, and an item that moves behind the cursor is one your export never saw. recent is the change feed: whatever happened last, first, and it is what `since` is for.',
              },
              since: {
                type: 'string',
                format: 'date-time',
                description:
                  'Only what changed at or after this moment. Pass back the as_of from your previous read rather than your own clock, which is not the one that stamped these rows.',
              },
              cursor: {
                type: 'string',
                description:
                  'Paging cursor: pass the next_cursor from the previous page, with the same order. null next_cursor means that was the last page.',
              },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = auth(request);
        const query = request.query as Record<string, unknown>;
        const limit = Math.min(Math.max((query.limit as number | undefined) ?? 50, 1), 200);
        const order: ItemOrder =
          query.order === 'id' ? 'id' : query.order === 'recent' ? 'recent' : 'urgency';
        const since = query.since ? new Date(String(query.since)) : undefined;
        if (since && Number.isNaN(since.getTime())) {
          throw new ServiceError(400, 'bad_since', 'since must be an ISO timestamp.');
        }
        // Stamped before the read, never after: anything written while this
        // query ran must fall inside the next window rather than between them.
        const asOf = new Date();
        const items = await listItems(store, project._id, {
          status: query.status as ItemStatus | undefined,
          owner: query.owner as string | undefined,
          label: query.label as string | undefined,
          source: query.source as string | undefined,
          stale: query.stale as boolean | undefined,
          claimed: query.claimed as boolean | undefined,
          limit,
          order,
          cursor: query.cursor as string | undefined,
          ...(since ? { since } : {}),
        });
        return {
          items: items.map((item) => itemJson(item)),
          // Null on a short page, so the caller learns it is done without
          // spending one more request to find out.
          next_cursor:
            items.length === limit ? itemCursor(items[items.length - 1]!, order) : null,
          // Hand this back as `since` next time. A poller using its own clock
          // loses every row written in the gap between the two machines.
          as_of: asOf.toISOString(),
        };
      },
    );

    scoped.get(
      '/v1/:project/items/:slug',
      { schema: { tags: ['items'], summary: 'Read one item with its timeline' } },
      async (request) => {
        const { project } = auth(request);
        const { slug } = request.params as { slug: string };
        const item = await getItem(store, project._id, slug);
        return { item: itemJson(item, true) };
      },
    );

    scoped.delete(
      '/v1/:project/items/:slug',
      {
        schema: {
          tags: ['items'],
          summary: 'Delete an item outright',
          description:
            'Closing an item is the normal ending and keeps the audit trail. Deleting is for mistakes, bad imports and data that has to be gone, so it needs an admin token: an agent should never be able to erase another agent’s record of what happened.',
        },
      },
      async (request) => {
        const { project } = requireAdmin(request);
        const { slug } = request.params as { slug: string };
        await deleteItem(store, project, slug);
        return { ok: true };
      },
    );

    scoped.post(
      '/v1/:project/items/:slug/claim',
      {
        schema: {
          tags: ['claims'],
          summary: 'Claim an item for a bounded time',
          description:
            'A lease. ok:false means another agent holds it and the holder is named. Claims expire without a heartbeat, so a crashed session never blocks the board.',
          body: {
            type: 'object',
            required: ['agent'],
            properties: {
              agent: { type: 'string', maxLength: 48 },
              ttl_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        const { project } = auth(request);
        const { slug } = request.params as { slug: string };
        const body = request.body as { agent: string; ttl_minutes?: number };
        const result = await claimItem(store, project, slug, body.agent, body.ttl_minutes);
        if (!result.ok) {
          return reply.code(409).send({
            ok: false,
            held_by: result.heldBy,
            item: result.item ? itemJson(result.item) : null,
            hint: 'Somebody else is on this. Pick something else, or leave a timeline note if you have information they need.',
          });
        }
        return { ok: true, item: itemJson(result.item!), expires_at: result.expiresAt };
      },
    );

    scoped.post(
      '/v1/:project/items/:slug/heartbeat',
      {
        schema: {
          tags: ['claims'],
          summary: 'Extend a claim you hold',
          body: {
            type: 'object',
            required: ['agent'],
            properties: {
              agent: { type: 'string', maxLength: 48 },
              ttl_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = auth(request);
        const { slug } = request.params as { slug: string };
        const body = request.body as { agent: string; ttl_minutes?: number };
        const item = await heartbeatClaim(store, project, slug, body.agent, body.ttl_minutes);
        return { ok: true, item: itemJson(item) };
      },
    );

    scoped.post(
      '/v1/:project/items/:slug/release',
      {
        schema: {
          tags: ['claims'],
          summary: 'Release a claim you hold',
          body: {
            type: 'object',
            required: ['agent'],
            properties: {
              agent: { type: 'string', maxLength: 48 },
              note: { type: 'string', maxLength: 2000 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = auth(request);
        const { slug } = request.params as { slug: string };
        const body = request.body as { agent: string; note?: string };
        const item = await releaseItem(store, project, slug, body.agent, body.note);
        return { ok: true, item: itemJson(item) };
      },
    );

    scoped.post(
      '/v1/:project/items/:slug/timeline',
      {
        schema: {
          tags: ['items'],
          summary: 'Append a note to an item',
          description:
            'The next agent reads the timeline to decide whether to pick this up. One line beats nothing.',
          body: {
            type: 'object',
            required: ['message'],
            properties: {
              message: { type: 'string', minLength: 1, maxLength: 4000 },
              actor: { type: 'string', maxLength: 48 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = auth(request);
        const { slug } = request.params as { slug: string };
        const body = request.body as { message: string; actor?: string };
        const item = await appendNote(
          store,
          project,
          slug,
          body.actor ?? 'unknown-agent',
          body.message,
        );
        return { item: itemJson(item, true) };
      },
    );

    scoped.post(
      '/v1/:project/items/:slug/move',
      {
        schema: {
          tags: ['board'],
          summary: 'Move an item into a column',
          description:
            'Does what the column declares in its "apply", or a conservative reading of its own filter: the status it asks for, the labels it requires or excludes, and the claim it implies. It can only set what an item already has, so no move invents a status. The response says which column the item actually landed in, which is not always the one you sent it to.',
          body: {
            type: 'object',
            required: ['column'],
            properties: {
              column: { type: 'string', maxLength: 32, description: 'The column key.' },
              actor: { type: 'string', maxLength: 48 },
              note: { type: 'string', maxLength: 2000 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = auth(request);
        const { slug } = request.params as { slug: string };
        const body = request.body as { column: string; actor?: string; note?: string };
        const result = await moveItem(store, project, {
          slug,
          column: body.column,
          actor: body.actor ?? 'unknown-agent',
          ...(body.note === undefined ? {} : { note: body.note }),
        });
        return {
          ok: true,
          item: itemJson(result.item),
          applied: boardApplyJson(result.applied),
          landed_in: result.landedIn,
          ...(result.warning === undefined ? {} : { warning: result.warning }),
        };
      },
    );

    scoped.get(
      '/v1/:project/board',
      {
        schema: {
          tags: ['board'],
          summary: 'The board as its columns are configured',
          description:
            'Columns are a view, not a state: each one is a name and a filter over what an item already is. An item lands in the first column that matches, so the board is a partition.',
          querystring: {
            type: 'object',
            properties: {
              include_closed: { type: 'boolean' },
              items: { type: 'boolean', description: 'Set false for counts only.' },
              owner: { type: 'string', maxLength: 48, description: 'Only items assigned to this owner.' },
              agent: {
                type: 'string',
                maxLength: 48,
                description:
                  'Only items this agent is on: holding the claim, or the last to write to them.',
              },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = auth(request);
        const query = request.query as {
          include_closed?: boolean;
          items?: boolean;
          owner?: string;
          agent?: string;
        };
        void maybeSweep(store, project).catch(() => undefined);
        const view = await loadBoard(store, project, {
          ...(query.include_closed === undefined ? {} : { includeClosed: query.include_closed }),
          ...(query.owner ? { owner: query.owner } : {}),
          ...(query.agent ? { agent: query.agent } : {}),
        });
        return boardJson(view, query.items !== false);
      },
    );

    scoped.get(
      '/v1/:project/board/facets',
      {
        schema: {
          tags: ['board'],
          summary: 'The owners and agents this board can be narrowed to',
          description:
            'Every agent registered in the project, plus the names read off the items themselves. Pass one to GET /board as owner= or agent=. `agentsDescribed` says what each agent is for, in its own words.',
        },
      },
      async (request) => {
        const { project } = auth(request);
        const facets = await boardFacets(store, project);
        // The two lists stay plain strings: they are the values that go back in
        // as `agent=`, and an agent reading this should not have to reach into
        // an object to find one. What each name is for is a second field.
        return {
          owners: facets.owners,
          agents: facets.agents.map((agent) => agent.handle),
          agentsDescribed: facets.agents.filter((agent) => agent.description !== ''),
          omitted: facets.omitted,
        };
      },
    );

    scoped.put(
      '/v1/:project/board',
      {
        schema: {
          tags: ['board'],
          summary: 'Lay the board out for this project',
          description:
            'Columns are filters over status, labels, owner, claim state, staleness, source, priority and migrated fields. There is deliberately no way to invent a status here: a column called Investigating is a filter, so no agent has to learn a new value.',
          body: {
            type: 'object',
            required: ['columns'],
            properties: {
              rows: { type: 'string', enum: ['none', 'owner', 'label'] },
              columns: {
                type: 'array',
                minItems: 1,
                maxItems: MAX_BOARD_COLUMNS,
                items: { type: 'object', additionalProperties: true },
              },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = requireAdmin(request);
        const config = parseBoardConfig(request.body);
        await store.projects.updateOne({ _id: project._id }, { $set: { board: config } });
        const updated = await store.projects.findOne({ _id: project._id });
        // Saved, and then told what it will do. A layout is a filter, so a legal
        // one is never refused; the trap it can hide is worth one sentence.
        return {
          board: boardConfigJson(boardConfigOf(updated!)),
          warnings: boardWarnings(config),
        };
      },
    );

    scoped.get(
      '/v1/:project/board/presets',
      { schema: { tags: ['board'], summary: 'Layouts to start from' } },
      async (request) => {
        auth(request);
        return {
          presets: Object.entries(BOARD_PRESETS).map(([key, preset]) => ({
            key,
            title: preset.title,
            description: preset.description,
            board: boardConfigJson(preset.config),
          })),
        };
      },
    );

    scoped.get(
      '/v1/:project/next',
      {
        schema: {
          tags: ['items'],
          summary: 'What this agent should pick up next',
          querystring: {
            type: 'object',
            properties: { agent: { type: 'string', maxLength: 48 } },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = auth(request);
        const { agent } = request.query as { agent?: string };
        void maybeSweep(store, project).catch(() => undefined);
        const result = await nextItem(store, project, agent ?? '');
        return {
          item: result.item ? itemJson(result.item, true) : null,
          reason: result.reason,
        };
      },
    );

    scoped.post(
      '/v1/:project/observe',
      {
        schema: {
          tags: ['items'],
          summary: 'Report which mirrored items still exist',
          description:
            'Items of that source missing from the list start an absence streak. They close only after N consecutive absences AND M hours, so one failed poll cannot close live work.',
          body: {
            type: 'object',
            required: ['source', 'present'],
            properties: {
              source: { type: 'string', minLength: 1, maxLength: 64 },
              present: { type: 'array', items: { type: 'string', maxLength: 96 }, maxItems: 2000 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = auth(request);
        const body = request.body as { source: string; present: string[] };
        const result = await observe(store, project, body.source, body.present);
        return result;
      },
    );

    // -------------------------------------------------------- escalations

    scoped.post(
      '/v1/:project/escalations',
      {
        schema: {
          tags: ['escalations'],
          summary: 'Ask the human a question you cannot decide yourself',
          body: {
            type: 'object',
            required: ['question'],
            properties: {
              agent: { type: 'string', maxLength: 48 },
              question: { type: 'string', minLength: 1, maxLength: 2000 },
              context: { type: 'string', maxLength: 8000 },
              priority: { type: 'string', enum: [...ESCALATION_PRIORITIES] },
              item_slug: { type: ['string', 'null'], maxLength: 96 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        const { project } = auth(request);
        const body = request.body as {
          agent?: string;
          question: string;
          context?: string;
          priority?: EscalationPriority;
          item_slug?: string | null;
        };
        const doc = await createEscalation(store, project, {
          agent: body.agent ?? 'unknown-agent',
          question: body.question,
          context: body.context,
          priority: body.priority,
          itemSlug: body.item_slug ?? null,
        });
        // After the write, not before: a question the cap refused was never
        // filed, and a log that says otherwise is worse than no log.
        record(store, 'escalate', { door: 'http', projectId: project._id });
        // Awaited rather than fired off, so that a provider having a bad day
        // shows up here as a slow escalation instead of an unhandled rejection
        // in a log nobody reads. The notifier swallows its own failures: an
        // undelivered message must not turn a filed question into a 500.
        await notifier.escalationRaised(project, doc);
        return reply.code(201).send({
          escalation: escalationJson(doc),
          read_url: `${config.baseUrl}/r/${project.readToken}`,
          hint: 'Keep working on something else and read /inbox on your next iteration.',
        });
      },
    );

    scoped.get(
      '/v1/:project/escalations',
      {
        schema: {
          tags: ['escalations'],
          summary: 'List escalations',
          querystring: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: [...ESCALATION_STATUSES] },
              agent: { type: 'string' },
              acknowledged: {
                type: 'boolean',
                description:
                  'false is every answer nobody has acted on yet, whatever its status. That is the question a job asking "what is new for me" is actually asking.',
              },
              limit: { type: 'integer', minimum: 1, maximum: 200 },
              cursor: {
                type: 'string',
                description: 'Paging cursor: pass the next_cursor from the previous page.',
              },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = auth(request);
        const query = request.query as {
          status?: EscalationStatus;
          agent?: string;
          limit?: number;
          cursor?: string;
          acknowledged?: boolean;
        };
        const docs = await listEscalations(store, project._id, query);
        return {
          escalations: docs.map(escalationJson),
          next_cursor: docs.length > 0 ? escalationCursor(docs[docs.length - 1]!) : null,
        };
      },
    );

    scoped.patch(
      '/v1/:project/escalations/:id',
      {
        schema: {
          tags: ['escalations'],
          summary: 'Answer an escalation programmatically',
          description:
            'The same four answers the operator gives in the web view, for an operator who prefers a script, and for importing an existing inbox. Needs an admin token: answering on the human’s behalf is not something a worker key should be able to do.',
          body: {
            type: 'object',
            required: ['status'],
            properties: {
              status: { type: 'string', enum: [...ESCALATION_STATUSES] },
              answer: { type: 'string', maxLength: 8000 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = requireAdmin(request);
        const { id } = request.params as { id: string };
        const body = request.body as { status: EscalationStatus; answer?: string };
        const doc = await answerEscalation(store, project._id, id, body.status, body.answer ?? '');
        return { escalation: escalationJson(doc) };
      },
    );

    scoped.post(
      '/v1/:project/escalations/:id/ack',
      {
        schema: {
          tags: ['escalations'],
          summary: 'Say you have acted on an answer',
          description:
            'Separate from the four statuses, which carry the human decision. This says what happened next, so the next iteration can tell "answered, do it" from "answered, already done", and the person who answered can see that it landed.',
          body: {
            type: 'object',
            required: ['agent'],
            properties: {
              agent: { type: 'string', minLength: 1, maxLength: 48 },
              note: { type: 'string', maxLength: 2000 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = auth(request);
        const { id } = request.params as { id: string };
        const body = request.body as { agent: string; note?: string };
        const doc = await acknowledgeEscalation(store, project, id, body);
        return { escalation: escalationJson(doc) };
      },
    );

    scoped.get(
      '/v1/:project/inbox',
      {
        schema: {
          tags: ['escalations'],
          summary: 'Answers waiting for this agent',
          description:
            'Four statuses, four meanings: answered (act on it), resolved (already handled, stop), wont_do (dropped, do not ask again), in_progress (the human is on it, wait). `waiting` carries your own questions that nobody has answered yet, so an agent reading an empty inbox can tell "nothing came back" apart from "I never asked". `handover_requests` appears when a person holding the read link has asked to be made the owner: answer it by calling POST /share with that address, and never by sending them the project token.',
          querystring: {
            type: 'object',
            properties: {
              agent: { type: 'string', maxLength: 48 },
              include_acted: {
                type: 'boolean',
                description:
                  'Answers you have already acted on are left out by default, so an iteration that reads this does not do the same work twice.',
              },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = auth(request);
        const { agent, include_acted: includeActed } = request.query as {
          agent?: string;
          include_acted?: boolean;
        };
        // One function behind both doors. An agent that read an empty inbox
        // could not tell "the human has not answered yet" from "my question
        // was never filed", and somebody asking for the board is the other
        // thing it would otherwise never see.
        const { answers, waiting, handovers } = await readInbox(store, project, {
          ...(agent ? { agent } : {}),
          ...(includeActed ? { includeActed: true } : {}),
        });
        return {
          answers: answers.map((doc) => escalationJson(doc)),
          waiting: waiting.map((doc) => escalationJson(doc)),
          ...(handovers.length > 0
            ? {
                handover_requests: handovers.map((doc) => ({
                  email: doc.email,
                  note: doc.note,
                  asked_at: doc.createdAt,
                })),
                hint: `Somebody wants this board. Hand it over with POST ${config.baseUrl}/v1/${project._id}/share and their address, which puts the offer in their operator view. Never send them the project token.`,
              }
            : {}),
        };
      },
    );

    // ------------------------------------------------------------ hygiene

    scoped.post(
      '/v1/:project/sweep',
      {
        schema: {
          tags: ['hygiene'],
          summary: 'Run the hygiene rules now',
          description: 'The same pass that runs on a schedule. Useful right after a bulk import.',
        },
      },
      async (request) => {
        const { project } = auth(request);
        const outcomes = await sweepProject(store, project);
        return { swept: Object.fromEntries(outcomes.map((o) => [o.rule, o.affected])) };
      },
    );

    scoped.patch(
      '/v1/:project/rules',
      {
        schema: {
          tags: ['hygiene'],
          summary: 'Tune the hygiene rules',
          body: {
            type: 'object',
            properties: {
              stale_after_hours: { type: ['integer', 'null'], minimum: 1 },
              absence_resolve: {
                type: ['object', 'null'],
                properties: {
                  observations: { type: 'integer', minimum: 1, maximum: 100 },
                  min_hours: { type: 'integer', minimum: 1 },
                },
                required: ['observations', 'min_hours'],
                additionalProperties: false,
              },
              require_body_after_hours: { type: ['integer', 'null'], minimum: 1 },
              claim_ttl_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
              scope_warnings: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = requireAdmin(request);
        const body = request.body as Record<string, unknown>;
        const set: Record<string, unknown> = {};
        if ('stale_after_hours' in body) set['rules.staleAfterHours'] = body.stale_after_hours;
        if ('absence_resolve' in body) {
          const value = body.absence_resolve as
            | { observations: number; min_hours: number }
            | null;
          set['rules.absenceResolve'] = value
            ? { observations: value.observations, minHours: value.min_hours }
            : null;
        }
        if ('require_body_after_hours' in body) {
          set['rules.requireBodyAfterHours'] = body.require_body_after_hours;
        }
        if ('claim_ttl_minutes' in body) set['rules.claimTtlMinutes'] = body.claim_ttl_minutes;
        if ('scope_warnings' in body) set['rules.scopeWarnings'] = body.scope_warnings;

        const updated = await store.projects.findOneAndUpdate(
          { _id: project._id },
          { $set: set },
          { returnDocument: 'after' },
        );
        return projectJson(updated!, config);
      },
    );

    // --------------------------------------------------------------- keys

    scoped.post(
      '/v1/:project/keys',
      {
        schema: {
          tags: ['keys'],
          summary: 'Create an API key programmatically',
          description:
            'Part of the management API: an admin token can programmatically create further keys, so a second machine or a second agent never has to share one.',
          body: {
            type: 'object',
            properties: {
              name: { type: 'string', maxLength: 80 },
              role: { type: 'string', enum: ['write', 'admin'] },
            },
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        const { project } = requireAdmin(request);
        const body = (request.body ?? {}) as { name?: string; role?: 'write' | 'admin' };
        const { key, token } = await createApiKey(store, project, body);
        return reply.code(201).send({
          key: { id: key._id, name: key.name, role: key.role, created_at: key.createdAt },
          token,
          notice: 'This token is shown once. Only its hash is stored.',
        });
      },
    );

    scoped.get(
      '/v1/:project/keys',
      {
        schema: {
          tags: ['keys'],
          summary: 'List keys',
          description:
            'Never the tokens themselves, only what each one is and when it was last used. `expires_at` covers two different things: a key on an unclaimed project inherits the project’s own expiry and loses it when a person claims the board, while a key with a life of its own keeps one either way, which is what an access token from the OAuth endpoint has.',
        },
      },
      async (request) => {
        const { project } = requireAdmin(request);
        const keys = await listApiKeys(store, project._id);
        return {
          keys: keys.map((key) => ({
            id: key._id,
            name: key.name,
            role: key.role,
            created_at: key.createdAt,
            last_used_at: key.lastUsedAt,
            revoked_at: key.revokedAt,
            // The whole reason the OAuth endpoint was changed was that nobody
            // could tell sixty two live admin keys apart. A list that does not
            // say which of them dies in an hour has the same problem.
            expires_at: (key as { expiresAt?: Date | null }).expiresAt ?? null,
          })),
        };
      },
    );

    scoped.delete(
      '/v1/:project/keys/:id',
      { schema: { tags: ['keys'], summary: 'Revoke a key' } },
      async (request) => {
        const { project } = requireAdmin(request);
        const { id } = request.params as { id: string };
        await revokeApiKey(store, project._id, id);
        return { ok: true };
      },
    );

    // -------------------------------------------------------- human claim

    scoped.patch(
      '/v1/:project',
      {
        schema: {
          tags: ['projects'],
          summary: 'Rename this board or say what it is for',
          body: {
            type: 'object',
            properties: {
              name: { type: 'string', maxLength: 120 },
              description: { type: 'string', maxLength: 500 },
              visibility: {
                type: 'string',
                enum: ['link', 'owner'],
                description:
                  'Who may open the read link. "link" is the default and is what makes a handover possible. "owner" needs a project somebody owns, after which the link alone stops working and the reader has to be signed in as that person.',
              },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = requireAdmin(request);
        const body = request.body as {
          name?: string;
          description?: string;
          visibility?: 'link' | 'owner';
        };
        const updated = await updateProject(store, project._id, body);
        return projectJson(updated, config);
      },
    );

    scoped.post(
      '/v1/:project/read-link/rotate',
      {
        schema: {
          tags: ['projects'],
          summary: 'Replace the read link',
          description:
            'The read link is a capability: whoever holds it reads the board, lays it out, moves cards and answers questions. That is what makes it useful to hand to a person, and it is also why a leaked one has to be revocable. Rotating mints a new link and stops the old one dead.',
        },
      },
      async (request) => {
        const { project } = requireAdmin(request);
        const readToken = newId('r', 16);
        await store.projects.updateOne({ _id: project._id }, { $set: { readToken } });
        return {
          ok: true,
          read_url: `${config.baseUrl}/r/${readToken}`,
          board_url: `${config.baseUrl}/r/${readToken}/board`,
          note: 'The previous link stops working immediately. Anyone who had it needs the new one.',
        };
      },
    );

    scoped.post(
      '/v1/:project/share',
      {
        schema: {
          tags: ['projects'],
          summary: 'Offer this board to a human',
          description:
            'Puts an offer in that person’s operator view, where one click accepts it and makes them the owner. Nothing reaches their queue until they accept, so this cannot post a board into somebody’s inbox. If they have never used Muster, they get the read link and the ordinary email claim instead. Needs an admin token: offering the board to an address and accepting it is how a project changes hands, and ownership has no way back, so a worker key must not be able to start it.',
          body: {
            type: 'object',
            required: ['email'],
            properties: {
              email: { type: 'string', maxLength: 200 },
              note: { type: 'string', maxLength: 500 },
              agent: { type: 'string', maxLength: 48 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        // Admin, not write, for the same reason /claim is: this decides who
        // ends up owning the project, and ownership has no way back. A worker
        // key offering the board to an address it controls, then accepting the
        // offer, is the two step version of claiming it outright.
        const { project } = requireAdmin(request);
        const body = request.body as { email: string; note?: string; agent?: string };
        const verdict = limiter.check(`share:${project._id}`, config.rateLimits.claimEmail);
        if (!verdict.ok) return tooMany(reply, verdict.retryAfterSeconds);

        const { alreadyOwned } = await shareProject(store, project, {
          email: body.email,
          note: body.note,
          offeredBy: body.agent,
        });
        if (alreadyOwned) {
          return reply.send({
            ok: true,
            already_owned: true,
            operator_view: `${config.baseUrl}/operator`,
          });
        }

        return reply.code(201).send({
          ok: true,
          pending: true,
          // Deliberately the same answer for an address that owns projects and
          // one that has never been seen. The earlier version returned whether
          // the person already had an operator view, which was a useful hint
          // and also an oracle: a project token costs nothing, so anybody could
          // ask this service whether a given address is one of its users. The
          // agent's next move does not depend on the answer anyway. Send them
          // the link; if they already have an operator view, the offer is
          // waiting there too.
          tell_them: `${config.baseUrl}/r/${project.readToken}`,
          hint: 'Send them that link. If they already use Muster, the offer is also waiting in their operator view, where one click makes them the owner.',
        });
      },
    );

    scoped.post(
      '/v1/:project/claim',
      {
        schema: {
          tags: ['projects'],
          summary: 'Start the human claim: email a six digit code',
          description:
            'Claiming removes the expiry and raises the limits. It is the only step that needs a person, and it happens after the agent is already working. Needs an admin token: ownership decides who receives this board and has no way back, so a worker key handed to one agent cannot bind the project to an address of its choosing.',
          body: {
            type: 'object',
            required: ['email'],
            properties: { email: { type: 'string', maxLength: 200 } },
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        // Admin, not write. Ownership decides who receives the operator link
        // for this project, so a worker key handed to one agent must not be
        // able to bind the whole tenant to an address of its choosing.
        const { project } = requireAdmin(request);
        const { email } = request.body as { email: string };
        const verdict = limiter.check(`claim:${project._id}`, config.rateLimits.claimEmail);
        if (!verdict.ok) return tooMany(reply, verdict.retryAfterSeconds);

        const started = await startEmailClaim(store, project, email, config, mailer);
        if (started.alreadyClaimedBy) {
          return reply.send({ ok: true, already_claimed_by: started.alreadyClaimedBy });
        }
        return reply.send({
          ok: true,
          delivery: started.delivery,
          expires_in_seconds: started.expiresInSeconds,
          verify: `${config.baseUrl}/v1/${project._id}/claim/verify`,
        });
      },
    );

    scoped.post(
      '/v1/:project/claim/verify',
      {
        schema: {
          tags: ['projects'],
          summary: 'Finish the human claim with the emailed code',
          body: {
            type: 'object',
            required: ['email', 'code'],
            properties: {
              email: { type: 'string', maxLength: 200 },
              code: { type: 'string', minLength: 6, maxLength: 6 },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = requireAdmin(request);
        const { email, code } = request.body as { email: string; code: string };
        await verifyClaimCode(store, project, email, code, config);
        record(store, 'claim', { door: 'http', projectId: project._id });
        const updated = await store.projects.findOne({ _id: project._id });
        return { ok: true, project: projectJson(updated!, config) };
      },
    );
  });
}

function tooMany(reply: FastifyReply, retryAfter: number): FastifyReply {
  return reply
    .code(429)
    .header('retry-after', String(retryAfter))
    .send({
      error: 'rate_limited',
      message: `Too many requests. Retry in ${retryAfter}s. Published limits live at /.well-known/agent-access.json.`,
      retry_after: retryAfter,
    });
}

export { answerEscalation };
