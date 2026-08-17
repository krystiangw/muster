import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { maybeSweep, sweepProject } from '../hygiene.js';
import { hashToken, isValidHandle, newOtpCode, newId } from '../ids.js';
import { RateLimiter } from '../rateLimit.js';
import { BOARD_PRESETS, boardConfigOf, loadBoard, parseBoardConfig } from '../board.js';
import {
  agentJson,
  boardConfigJson,
  boardJson,
  escalationJson,
  itemJson,
  projectJson,
} from '../serialize.js';
import {
  ServiceError,
  answerEscalation,
  authenticate,
  claimItem,
  claimProjectWithEmail,
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
  listEscalations,
  listItems,
  nextItem,
  observe,
  registerAgent,
  releaseItem,
  revokeApiKey,
  appendNote,
  upsertItem,
} from '../service.js';
import type { AuthContext, UpsertItemInput } from '../service.js';
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
}

const CLAIM_CODE_TTL_MS = 15 * 60_000;
const MAX_CLAIM_ATTEMPTS = 5;

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

function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return request.ip;
}

export function registerApi(app: FastifyInstance, deps: ApiDeps): void {
  const { store, config, limiter, mailer } = deps;

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
              priority: { type: 'integer', minimum: -10, maximum: 10 },
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

        const warnings = [...result.warnings];
        if (project.rules.scopeWarnings && actor !== 'unknown-agent') {
          const agent = await store.agents.findOne({ projectId: project._id, handle: actor });
          if (agent && agent.scope.length > 0 && !itemInScope(agent.scope, result.item)) {
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
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = auth(request);
        const query = request.query as Record<string, unknown>;
        const items = await listItems(store, project._id, {
          status: query.status as ItemStatus | undefined,
          owner: query.owner as string | undefined,
          label: query.label as string | undefined,
          source: query.source as string | undefined,
          stale: query.stale as boolean | undefined,
          claimed: query.claimed as boolean | undefined,
          limit: query.limit as number | undefined,
        });
        return { items: items.map((item) => itemJson(item)) };
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
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = auth(request);
        const query = request.query as { include_closed?: boolean; items?: boolean };
        void maybeSweep(store, project).catch(() => undefined);
        const view = await loadBoard(
          store,
          project,
          query.include_closed === undefined ? {} : { includeClosed: query.include_closed },
        );
        return boardJson(view, query.items !== false);
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
        return { board: boardConfigJson(boardConfigOf(updated!)) };
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

    scoped.get(
      '/v1/:project/inbox',
      {
        schema: {
          tags: ['escalations'],
          summary: 'Answers waiting for this agent',
          description:
            'Four statuses, four meanings: answered (act on it), resolved (already handled, stop), wont_do (dropped, do not ask again), in_progress (the human is on it, wait).',
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
        const filter: Record<string, unknown> = {
          projectId: project._id,
          status: { $ne: 'open' },
        };
        if (agent) filter.agent = agent;
        const docs = await store.escalations
          .find(filter)
          .sort({ answeredAt: -1 })
          .limit(50)
          .toArray();
        return { answers: docs.map((doc) => escalationJson(doc)) };
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

    scoped.get('/v1/:project/keys', { schema: { tags: ['keys'], summary: 'List keys' } }, async (request) => {
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
        })),
      };
    });

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
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = requireAdmin(request);
        const body = request.body as { name?: string; description?: string };
        const updated = await updateProject(store, project._id, body);
        return projectJson(updated, config);
      },
    );

    scoped.post(
      '/v1/:project/share',
      {
        schema: {
          tags: ['projects'],
          summary: 'Offer this board to a human',
          description:
            'Puts an offer in that person’s operator view, where one click accepts it and makes them the owner. Nothing reaches their queue until they accept, so this cannot post a board into somebody’s inbox. If they have never used Muster, they get the read link and the ordinary email claim instead.',
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
        const { project } = auth(request);
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

        const known = await store.projects.countDocuments({
          claimedBy: body.email.trim().toLowerCase(),
        });
        return reply.code(201).send({
          ok: true,
          pending: true,
          // Somebody who has never claimed a project has no operator view to
          // see the offer in, so tell the agent to hand over the link instead
          // of leaving the offer sitting where nobody will look.
          operator_has_an_inbox: known > 0,
          tell_them: known > 0 ? `${config.baseUrl}/operator` : `${config.baseUrl}/r/${project.readToken}`,
          hint:
            known > 0
              ? 'It is waiting in their operator view; they accept it with one click.'
              : 'They have no operator view yet. Send them the read link, or use /claim to have them confirm an email.',
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
            'Claiming removes the expiry and raises the limits. It is the only step that needs a person, and it happens after the agent is already working.',
          body: {
            type: 'object',
            required: ['email'],
            properties: { email: { type: 'string', maxLength: 200 } },
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        const { project } = auth(request);
        const { email } = request.body as { email: string };
        if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
          throw new ServiceError(400, 'bad_email', 'That does not look like an email address.');
        }
        if (project.claimedBy) {
          return reply.send({ ok: true, already_claimed_by: project.claimedBy });
        }
        const verdict = limiter.check(`claim:${project._id}`, config.rateLimits.claimEmail);
        if (!verdict.ok) return tooMany(reply, verdict.retryAfterSeconds);

        const code = newOtpCode();
        const now = new Date();
        await store.claimCodes.deleteMany({ projectId: project._id });
        await store.claimCodes.insertOne({
          _id: newId('c'),
          projectId: project._id,
          email: email.toLowerCase(),
          codeHash: hashToken(code),
          attempts: 0,
          createdAt: now,
          expiresAt: new Date(now.getTime() + CLAIM_CODE_TTL_MS),
        });
        const delivery = await mailer.sendClaimCode(email, code, project.name);
        return reply.send({
          ok: true,
          delivery,
          expires_in_seconds: CLAIM_CODE_TTL_MS / 1000,
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
        const { project } = auth(request);
        const { email, code } = request.body as { email: string; code: string };
        const pending = await store.claimCodes.findOne({
          projectId: project._id,
          email: email.toLowerCase(),
        });
        if (!pending) {
          throw new ServiceError(404, 'no_pending_claim', 'No claim is pending for that address.');
        }
        if (pending.attempts >= MAX_CLAIM_ATTEMPTS) {
          throw new ServiceError(
            429,
            'too_many_attempts',
            'Too many wrong codes. Start the claim again.',
          );
        }
        if (pending.codeHash !== hashToken(code)) {
          await store.claimCodes.updateOne({ _id: pending._id }, { $inc: { attempts: 1 } });
          throw new ServiceError(400, 'bad_code', 'That code does not match.');
        }
        await claimProjectWithEmail(store, project, email.toLowerCase(), config);
        await store.claimCodes.deleteMany({ projectId: project._id });
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
