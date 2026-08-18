import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { READ_LINK_GRANTS } from '../content.js';
import type { Store } from '../db.js';
import { maybeExpireClaims, maybeSweep, sweepProject } from '../hygiene.js';
import {
  hashToken,
  isValidHandle,
  newOtpCode,
  newId,
  normalizeHandle,
  normalizeSlug,
} from '../ids.js';
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
  looksLikeEmail,
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
  renameAgent,
  writeWarnings,
  listApiKeys,
  escalationCursor,
  listEscalations,
  readInbox,
  readItems,
  nextItem,
  nextItemHeld,
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
  OPERATOR_ACTOR,
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

/**
 * The name somebody reached for, and the one this service uses.
 *
 * Every entry here was guessed by a real caller, or is the obvious neighbour of
 * one that was. A list of accepted parameters answers "what is allowed"; this
 * answers "what did you mean", which is the question somebody actually has.
 */
const INSTEAD: Record<string, { use: string; say: string }> = {
  offset: { use: 'cursor', say: 'Pages here are cursors: read next_cursor from the answer and pass it back as cursor.' },
  skip: { use: 'cursor', say: 'Pages here are cursors: read next_cursor from the answer and pass it back as cursor.' },
  page: { use: 'cursor', say: 'Pages here are cursors: read next_cursor from the answer and pass it back as cursor.' },
  per_page: { use: 'limit', say: 'The page size is limit.' },
  page_size: { use: 'limit', say: 'The page size is limit.' },
  count: { use: 'limit', say: 'The page size is limit.' },
  size: { use: 'limit', say: 'The page size is limit.' },
  sort: { use: 'order', say: 'The ordering is order, and it takes urgency, recent or id.' },
  sort_by: { use: 'order', say: 'The ordering is order, and it takes urgency, recent or id.' },
  order_by: { use: 'order', say: 'The ordering is order, and it takes urgency, recent or id.' },
  search: { use: 'q', say: 'The search is q, over the slug and the title.' },
  query: { use: 'q', say: 'The search is q, over the slug and the title.' },
  text: { use: 'q', say: 'The search is q, over the slug and the title.' },
  from: { use: 'since', say: 'The change window is since, and it takes the as_of from your previous read.' },
  after: { use: 'since', say: 'The change window is since, and it takes the as_of from your previous read.' },
  updated_since: { use: 'since', say: 'The change window is since, and it takes the as_of from your previous read.' },
};

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
            owner_email: {
              type: 'string',
              maxLength: 200,
              description:
                'The person this board answers to. They are written to once, with the link and what taking it does, and nothing after that. Use it when you are setting a board up for somebody rather than for yourself: an unclaimed board expires, and a person who is never told about theirs is a person who finds out when it is gone.',
            },
            owner_note: {
              type: 'string',
              maxLength: 500,
              description: 'Why you set it up, in your words. It goes in that message.',
            },
            agent: {
              type: 'string',
              maxLength: 48,
              description: 'Your handle, so the message says who set it up.',
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

      const body = (request.body ?? {}) as {
        name?: string;
        description?: string;
        owner_email?: string;
        owner_note?: string;
        agent?: string;
      };

      // Both questions about the address are asked before anything is written.
      // Asked afterwards, a refusal cost the caller the project it had just
      // made and the token it was shown once: it cannot use what it created
      // and its retry makes another one.
      const offered = body.owner_email?.trim();
      if (offered && !looksLikeEmail(offered)) {
        return reply
          .code(400)
          .send({ error: 'bad_email', message: 'That does not look like an email address.' });
      }
      // Exhausted differs from malformed on purpose. A malformed address is the
      // caller's mistake and nothing should exist because of it; a full bucket
      // is somebody else's mail volume, and refusing the project over it would
      // punish the wrong call. The board is created and the message is not
      // sent, which the answer says.
      const mayWrite =
        offered === undefined || offered === ''
          ? null
          : limiter.check(`offer:${offered.toLowerCase()}`, config.rateLimits.claimEmail);
      const { project, adminToken } = await createProject(store, config, body, 'http');
      // Named before the token is even used once. The offer is recorded the
      // same way the share endpoint records one, so the person has the same
      // one click waiting for them however they arrive, and the message is
      // what gets them there at all.
      //
      // Rate limited on the address rather than on the caller: the caller is
      // already capped at five projects an hour, and the thing worth protecting
      // is a stranger's inbox, not our own throughput.
      if (offered && mayWrite?.ok) {
        await shareProject(store, project, {
          email: offered,
          note: body.owner_note,
          offeredBy: body.agent,
        });
        await notifier.boardOffered(project, {
          email: offered,
          note: body.owner_note,
          offeredBy: body.agent,
        });
      }
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
        ...(offered
          ? mayWrite?.ok
            ? { owner_notified: offered }
            : {
                owner_notified: false,
                owner_notice: `That address has been written to enough for now, so nothing was sent. The board exists: hand them ${config.baseUrl}/r/${project.readToken} yourself, or offer it again in ${mayWrite?.retryAfterSeconds ?? 0}s.`,
              }
          : {}),
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
    /**
     * A parameter this door does not have is a question, not a comment.
     *
     * The framework drops what a route did not declare, so `?offset=999` came
     * back 200 with the first page and no offset, while `?cursor=nonsense` came
     * back 400 saying exactly what was wrong. A broken known parameter was
     * treated better than an invented one, and the invented one people reach
     * for first is `offset`: two agents have now guessed it, and one of them
     * had lost hours to the same silence on another service.
     *
     * Only routes that declare their querystring are checked, which is every
     * route here that takes one and nothing on the pages a browser reads: a
     * board link somebody pasted with a tracking parameter on the end is not a
     * request to explain ourselves.
     */
    scoped.addHook('preValidation', async (request) => {
      const declared = (
        request.routeOptions as {
          schema?: { querystring?: { properties?: Record<string, unknown> } };
        }
      ).schema?.querystring?.properties;
      // A route that declares no querystring accepts none, and says so, rather
      // than being the one door left where a parameter disappears quietly.
      const known = declared ? Object.keys(declared) : [];
      const unknown = Object.keys((request.query ?? {}) as Record<string, unknown>).filter(
        (name) => !known.includes(name),
      );
      if (unknown.length === 0) return;
      // Only what this endpoint could actually take. Telling somebody to use
      // `order` on a door that has no `order` is a second 400 dressed up as
      // help.
      const hints = [
        ...new Set(
          unknown
            .map((name) => INSTEAD[name])
            .filter((hint): hint is { use: string; say: string } => !!hint && known.includes(hint.use))
            .map((hint) => hint.say),
        ),
      ];
      throw new ServiceError(
        400,
        'unknown_parameter',
        `This endpoint has no ${unknown.map((name) => `"${name}"`).join(', ')}${
          unknown.length === 1 ? ' parameter' : ' parameters'
        }, and ignoring what you sent would answer 200 to a question nobody asked.${
          hints.length > 0 ? ` ${hints.join(' ')}` : ''
        } ${known.length > 0 ? `What this one takes: ${known.join(', ')}.` : 'This one takes none at all.'}`,
        { unknown, accepted: known },
      );
    });

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
      void maybeExpireClaims(store, project).catch(() => undefined);
      // The oldest question nobody has been told about, asked of the questions
      // themselves rather than of the counter beside them. The counter is
      // maintained by a second write, and the repair that keeps it honest only
      // brings overcounts down: a question whose insert landed and whose charge
      // did not leaves a board reading zero for ever. That is the exact shape
      // this field exists to catch, so it must not be the thing that hides it.
      //
      // Beside `notice_sent_at` this separates the two silences that look the
      // same from outside. A queue waiting its turn has an old question here
      // and a recent stamp there, because the hourly message keeps moving. A
      // mail path that is refusing every send has both of them old.
      //
      // No index of its own. The `inbox` index seeks straight to this project's
      // open questions, and how many of those there can be is the cap, so what
      // is left to look at is a handful of documents rather than a collection.
      const unannounced = await store.escalations.findOne(
        { projectId: project._id, status: 'open', notifiedAt: null },
        { projection: { createdAt: 1 }, sort: { createdAt: 1 } },
      );
      return {
        ...projectJson(project, config),
        oldest_unannounced_at: unannounced?.createdAt ?? null,
      };
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

    scoped.post(
      '/v1/:project/agents/:handle/rename',
      {
        schema: {
          tags: ['agents'],
          summary: 'Consolidate a handle that got written two ways',
          description:
            'Moves the work: every item whose last writer was this handle, and any live claim it holds, now name the new one. The timelines keep what they said, because an agent calling itself that is what happened, and the old name is kept on the agent as an alias so a reader who meets it in an old entry can find out who it became. If the new handle is already registered, the two registrations become one.',
          body: {
            type: 'object',
            required: ['to'],
            properties: { to: { type: 'string', maxLength: 48 } },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const { project } = auth(request);
        const { handle } = request.params as { handle: string };
        const { to } = request.body as { to: string };
        const moved = await renameAgent(store, project, handle, to);
        return {
          from: moved.from,
          to: moved.to,
          items: moved.items,
          claims: moved.claims,
          merged: moved.merged,
        };
      },
    );

    scoped.get(
      '/v1/:project/agents',
      {
        schema: {
          tags: ['agents'],
          summary: 'List agents',
          description:
            'Everything registered here, and beside it every handle that has written to this board without registering. The second list is where a typo shows up: two spellings of one loop, or a name nobody described. POST /agents/{handle}/rename moves the work onto one of them.',
        },
      },
      async (request) => {
        const { project } = auth(request);
        const agents = await store.agents
          .find({ projectId: project._id })
          .sort({ lastSeenAt: -1 })
          .limit(200)
          .toArray();
        // The names on the work, minus the names that declared themselves. The
        // browser has shown this since the filter existed; an agent auditing
        // its own board over the API could see only the half that registered,
        // which is the half that was never the problem.
        const registered = new Set(agents.map((agent) => agent.handle));
        const written = await store.items.distinct('lastActor', { projectId: project._id });
        const seen = written
          .filter(
            (handle): handle is string =>
              typeof handle === 'string' &&
              handle !== '' &&
              // Not an agent that forgot to register: it is the door a person
              // writes through, and listing it here as a name to consolidate is
              // an invitation to merge the operator into a loop.
              normalizeHandle(handle) !== OPERATOR_ACTOR &&
              !registered.has(handle),
          )
          .sort()
          .slice(0, 200);
        return { agents: agents.map((a) => agentJson(a)), seen };
      },
    );

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
              expect: {
                type: 'object',
                description:
                  'Write only if the item still says this. For a read, a decision and a write: between reading a card and writing it there is room for exactly the change this is trying not to lose. A mismatch answers 409 changed_underneath and writes nothing. Cannot be combined with status, which has its own guard.',
                properties: {
                  title: { type: 'string', maxLength: 300 },
                  body: { type: 'string', maxLength: 20000 },
                },
                additionalProperties: false,
              },
              then: {
                type: 'object',
                description:
                  'The card to file when this one is finished, addressed by slug like everything else here, so finishing twice files one card. A pipeline written on the work: one write says what to do and what to do next, and no orchestrator has to exist.',
                required: ['slug'],
                properties: {
                  slug: { type: 'string', minLength: 1, maxLength: 96 },
                  title: { type: 'string', maxLength: 300 },
                  body: { type: 'string', maxLength: 20000 },
                  priority: { type: 'integer', minimum: -10, maximum: 10 },
                  labels: { type: 'array', items: { type: 'string', maxLength: 48 }, maxItems: 20 },
                  owner: { type: ['string', 'null'], maxLength: 48 },
                },
                additionalProperties: false,
              },
              blocked_by: {
                type: 'array',
                maxItems: 20,
                items: { type: 'string', minLength: 1, maxLength: 96 },
                description: 'The cards this one is waiting on, by slug. Data and not a status: nothing on the server moves an item because of it, and `blocked` still means waiting on a person. What it does is keep this card out of what /next offers and refuse a claim on it, naming what is unfinished, so a fleet stops picking up work whose prerequisite is not done. An empty array clears it. A slug nobody has filed counts as unfinished and the refusal says so.',
              },
              must_exist: {
                type: 'boolean',
                description:
                  'Refuse to create. This call is an upsert, which is what makes it safe to retry; send this when you mean to change something that is already there and a new card would be wrong.',
              },
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
          // The browser's edit form has written guarded since it existed, and
          // the door this product is for could not: the mechanism was in the
          // domain and reachable from one side only.
          expect: body.expect as UpsertItemInput['expect'],
          then: body.then as UpsertItemInput['then'],
          blockedBy: body.blocked_by as string[] | undefined,
          mustExist: body.must_exist as boolean | undefined,
          actor,
        });
        if (result.created) recordFirstWrite(store, project._id, 'http');

        // An unregistered handle is accepted on purpose, because refusing a
        // write over bookkeeping would lose the write, but nothing said so, and
        // a typo in a handle produced a second silent identity on the board
        // that `/next` then never offered work to. Composed in the service, so
        // the other door says the same thing.
        const warnings = [
          ...result.warnings,
          ...(await writeWarnings(store, project, actor, result.item)),
        ];

        void maybeSweep(store, project).catch(() => undefined);
        return reply
          .code(result.created ? 201 : 200)
          .send({
            item: itemJson(result.item),
            created: result.created,
            // Reported in the same answer that finished the item: an agent
            // that had to read the board back to learn what its own write set
            // in motion is an agent doing a round trip for a fact we hold.
            ...(result.chained ? { chained: itemJson(result.chained) } : {}),
            warnings,
          });
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
              claimed: {
                type: 'boolean',
                description:
                  'true for items somebody holds right now, false for free ones. A lease that has expired counts as free, the same way the board reads it, whether or not hygiene has cleared it yet.',
              },
              q: {
                type: 'string',
                description:
                  'Words to look for in the slug or the title, case insensitive: every word has to appear, in either field, in any order. The same search the board offers a person, so both doors answer alike. Anything past 120 characters or six words is cut rather than refused, for the same reason. A search that reads for longer than it is allowed is refused with 503 search_too_slow, never answered with an empty page: narrow it with another word, or with status, owner or label beside it.',
              },
              limit: { type: 'integer', minimum: 1, maximum: 200 },
              order: {
                type: 'string',
                enum: ['urgency', 'id', 'recent'],
                description:
                  'urgency (default) is most urgent first. id is a stable order for reading everything back: priority and updatedAt change while you page, and an item that moves behind the cursor is one your export never saw. recent is whatever happened last, first, which is the order to poll a change feed in. `since` filters in every order, this one included; what recent changes is where the changed rows sit, not whether they are there.',
              },
              since: {
                type: 'string',
                format: 'date-time',
                description:
                  'Only what changed at or after this moment, in every order and not only in recent. Pass back the as_of from your previous read rather than your own clock, which is not the one that stamped these rows. A `since` older than everything on the board matches everything on the board: the same page you would get without it is the correct answer, not a filter being ignored.',
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
        // Paging, ordering, the `since` window and the throttled sweep that
        // makes a lapsed lease visible all live in the service, because the MCP
        // tool is the same read through another door and the two had already
        // drifted apart twice.
        const { items, nextCursor, asOf } = await readItems(store, project, {
          status: query.status as ItemStatus | undefined,
          owner: query.owner as string | undefined,
          label: query.label as string | undefined,
          source: query.source as string | undefined,
          stale: query.stale as boolean | undefined,
          claimed: query.claimed as boolean | undefined,
          q: query.q as string | undefined,
          limit: query.limit as number | undefined,
          order: query.order as string | undefined,
          cursor: query.cursor as string | undefined,
          since: query.since as string | undefined,
        });
        return {
          items: items.map((item) => itemJson(item)),
          next_cursor: nextCursor,
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
        const actor = body.actor ?? 'unknown-agent';
        const item = await appendNote(store, project, slug, actor, body.message);
        // The same sentence the item door says, because a handle first appears
        // on whichever door the agent happened to use, and one door saying it
        // is one door away from every other door not saying it.
        const named = await writeWarnings(store, project, actor);
        return { item: itemJson(item, true), ...(named.length > 0 ? { warnings: named } : {}) };
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
          ...(result.chained ? { chained: itemJson(result.chained) } : {}),
          ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
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
        void maybeExpireClaims(store, project).catch(() => undefined);
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
        void maybeExpireClaims(store, project).catch(() => undefined);
        const result = await nextItem(store, project, agent ?? '');
        // The earliest moment a mistyped handle can be caught: an agent asking
        // for work under a name nobody registered is offered everything, since
        // there is no scope to narrow by, and it never finds out why.
        const named = agent ? await writeWarnings(store, project, agent) : [];
        return {
          item: result.item ? itemJson(result.item, true) : null,
          reason: result.reason,
          ...(named.length > 0 ? { warnings: named } : {}),
        };
      },
    );

    scoped.post(
      '/v1/:project/next',
      {
        schema: {
          tags: ['items'],
          summary: 'Take what this agent should pick up next',
          description:
            'The same choice GET /next makes, taken in the same breath. A POST because it writes: a GET that claims is a GET a proxy, a prefetch or a client retry can take a second item with. The selection and the lease are one update, so a fleet asking at once gets different items instead of nine of them losing the claim that follows an offer.',
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
        const body = (request.body ?? {}) as { agent?: string; ttl_minutes?: number };
        void maybeSweep(store, project).catch(() => undefined);
        const result = await nextItemHeld(store, project, body.agent ?? '', body.ttl_minutes);
        const named = body.agent ? await writeWarnings(store, project, body.agent) : [];
        return {
          item: result.item ? itemJson(result.item, true) : null,
          reason: result.reason,
          claimed: result.claimed === true,
          ...(named.length > 0 ? { warnings: named } : {}),
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
        const doc = await createEscalation(
          store,
          project,
          {
            agent: body.agent ?? 'unknown-agent',
            question: body.question,
            context: body.context,
            priority: body.priority,
            itemSlug: body.item_slug ?? null,
          },
          'http',
        );
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
        const doc = await answerEscalation(
          store,
          project._id,
          id,
          body.status,
          body.answer ?? '',
          'http',
        );
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
        return {
          swept: Object.fromEntries(outcomes.map((o) => [o.rule, o.affected])),
          // Only when a rule took a flag off something, which is rare enough
          // that reporting it as a zero on every sweep would be noise.
          ...(outcomes.some((o) => o.unmarked)
            ? {
                unmarked: Object.fromEntries(
                  outcomes.filter((o) => o.unmarked).map((o) => [o.rule, o.unmarked]),
                ),
              }
            : {}),
        };
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
            `The read link is a capability: whoever holds it ${READ_LINK_GRANTS}, with no sign in at all. That is what makes it useful to hand to a person, and it is also why a leaked one has to be revocable. Rotating mints a new link and stops the old one dead.`,
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
        // Two buckets, because they protect different people. The project's
        // caps how often one board may be offered; this one caps how much mail
        // one address receives, and a project token costs nothing, so without
        // it a fleet of fresh projects is a fleet of fresh senders.
        const toThem = limiter.check(
          `offer:${body.email.trim().toLowerCase()}`,
          config.rateLimits.claimEmail,
        );
        if (!toThem.ok) return tooMany(reply, toThem.retryAfterSeconds);

        const { alreadyOwned } = await shareProject(store, project, {
          email: body.email,
          note: body.note,
          offeredBy: body.agent,
        });
        if (!alreadyOwned) {
          // The half that was missing. Recording the offer put it in a view
          // this person may never have opened, and the endpoint answered "send
          // them that link", which left the one step that reaches a human to
          // a channel this service cannot see.
          await notifier.boardOffered(project, {
            email: body.email,
            note: body.note,
            offeredBy: body.agent,
          });
        }
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
