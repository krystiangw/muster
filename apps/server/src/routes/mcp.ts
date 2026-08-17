import { hashToken } from '../ids.js';
import { record, recordFirstWrite } from '../events.js';
import { clientIp } from './api.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { maybeSweep } from '../hygiene.js';
import type { Notifier } from '../notify.js';
import type { RateLimiter } from '../rateLimit.js';
import { loadBoard, moveItem } from '../board.js';
import { boardApplyJson, boardJson, escalationJson, itemJson } from '../serialize.js';
import {
  ServiceError,
  authenticate,
  claimItem,
  createEscalation,
  createProject,
  appendNote,
  listEscalations,
  listHandoverRequests,
  listItems,
  nextItem,
  observe,
  registerAgent,
  shareProject,
  upsertItem,
} from '../service.js';
import {
  ESCALATION_PRIORITIES,
  ITEM_STATUSES,
  type EscalationPriority,
  type ItemStatus,
} from '../types.js';

/**
 * MCP over Streamable HTTP.
 *
 * Deliberately small. The market audit found a hosted competitor advertising
 * 125 MCP tools, which is a way of saying the model has to read a 125 item menu
 * before it can do anything. Muster exposes the same calls its curl surface
 * has, named the same way, so an agent that read skill.md already knows this
 * API.
 */

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/** How many JSON-RPC requests one batch may carry. */
const MAX_BATCH = 25;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpDeps {
  store: Store;
  config: Config;
  limiter: RateLimiter;
  notifier: Notifier;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiresProject: boolean;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'create_project',
    title: 'Create a project',
    description:
      'Create a Muster project and receive a token. This is the whole signup: no account, no human. Only needed once per repository or product.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human readable project name' },
        description: {
          type: 'string',
          description: 'What this board is for, so an operator running several can tell them apart',
        },
      },
    },
    requiresProject: false,
  },
  {
    name: 'register_agent',
    title: 'Register an agent',
    description:
      'Declare who you are and what you own. Scope is advisory: it decides what next_item offers you and warns others when they write into your area.',
    inputSchema: {
      type: 'object',
      required: ['handle'],
      properties: {
        handle: { type: 'string', description: 'Stable handle, e.g. errors-loop' },
        scope: { type: 'array', items: { type: 'string' }, description: 'Slug prefixes, labels or owner names you claim' },
        description: { type: 'string' },
      },
    },
    requiresProject: true,
  },
  {
    name: 'upsert_item',
    title: 'Create or update an item',
    description:
      'Idempotent on slug: the same slug always addresses the same item, so two sessions converge instead of duplicating. Never put a date in a slug.',
    inputSchema: {
      type: 'object',
      required: ['slug'],
      properties: {
        slug: { type: 'string', description: 'Stable key, e.g. errors:withdraw-stuck' },
        title: { type: 'string' },
        body: { type: 'string' },
        status: { type: 'string', enum: [...ITEM_STATUSES] },
        owner: { type: 'string' },
        priority: { type: 'integer', minimum: -10, maximum: 10 },
        labels: { type: 'array', items: { type: 'string' } },
        source: { type: 'string', description: 'Set when the item mirrors an external signal' },
        note: { type: 'string', description: 'Timeline entry describing this change' },
        actor: { type: 'string', description: 'Your agent handle' },
      },
    },
    requiresProject: true,
  },
  {
    name: 'claim_item',
    title: 'Claim an item',
    description:
      'Take a lease before working. A refusal names the current holder. Claims expire without a heartbeat, so a crashed session never blocks the board.',
    inputSchema: {
      type: 'object',
      required: ['slug', 'agent'],
      properties: {
        slug: { type: 'string' },
        agent: { type: 'string' },
        ttl_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
      },
    },
    requiresProject: true,
  },
  {
    name: 'append_note',
    title: 'Append a timeline note',
    description:
      'Record what you learned. The next agent reads the timeline to decide whether to pick this up.',
    inputSchema: {
      type: 'object',
      required: ['slug', 'message'],
      properties: {
        slug: { type: 'string' },
        message: { type: 'string' },
        actor: { type: 'string' },
      },
    },
    requiresProject: true,
  },
  {
    name: 'next_item',
    title: 'What to pick up next',
    description:
      'The oldest unclaimed open item inside your declared scope. If there is none you are told so, rather than handed somebody else’s work.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string' } },
    },
    requiresProject: true,
  },
  {
    name: 'list_items',
    title: 'List items',
    description: 'Filter by status, owner, label, source, staleness or claim state.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...ITEM_STATUSES] },
        owner: { type: 'string' },
        label: { type: 'string' },
        source: { type: 'string' },
        stale: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    requiresProject: true,
  },
  {
    name: 'observe',
    title: 'Report which mirrored items still exist',
    description:
      'Items of that source missing from the list start an absence streak and close only after N consecutive absences and M hours, so one failed poll cannot close live work.',
    inputSchema: {
      type: 'object',
      required: ['source', 'present'],
      properties: {
        source: { type: 'string' },
        present: { type: 'array', items: { type: 'string' } },
      },
    },
    requiresProject: true,
  },
  {
    name: 'escalate',
    title: 'Ask the human',
    description:
      'File a question only the operator can answer, then keep working on something else and read answers with the inbox tool.',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string' },
        context: { type: 'string' },
        priority: { type: 'string', enum: [...ESCALATION_PRIORITIES] },
        item_slug: { type: 'string' },
        agent: { type: 'string' },
      },
    },
    requiresProject: true,
  },
  {
    name: 'board',
    title: 'See the board',
    description:
      'The project’s columns as its operator laid them out, with the items in each. Columns are a view over status, labels, owner and claim state, so reading the board tells you how this project wants work described.',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'boolean', description: 'false for counts only' },
        owner: { type: 'string', description: 'Only items assigned to this owner' },
        agent: {
          type: 'string',
          description: 'Only items this agent is on: holding the claim, or the last to write',
        },
      },
    },
    requiresProject: true,
  },
  {
    name: 'move',
    title: 'Move an item into a column',
    description:
      'Puts an item in a column of this board, doing whatever that column says belongs there: a status, a label, an owner, a claim. Read the board first to see the column keys. The answer says which column it actually landed in, which is not always the one you asked for.',
    inputSchema: {
      type: 'object',
      required: ['slug', 'column'],
      properties: {
        slug: { type: 'string' },
        column: { type: 'string', description: 'The column key, from the board tool' },
        note: { type: 'string' },
        agent: { type: 'string' },
      },
    },
    requiresProject: true,
  },
  {
    name: 'share_project',
    title: 'Hand this board to a human',
    description:
      'Offers the project to an operator by email. It appears in their view where one click makes them the owner, which also lifts the limits and stops the project expiring.',
    inputSchema: {
      type: 'object',
      required: ['email'],
      properties: {
        email: { type: 'string' },
        note: { type: 'string', description: 'Why you are handing it over' },
        agent: { type: 'string' },
      },
    },
    requiresProject: true,
  },
  {
    name: 'inbox',
    title: 'Read the operator’s answers',
    description:
      'Four statuses, four meanings: answered (act on it), resolved (already handled, stop), wont_do (dropped, do not ask again), in_progress (wait, do not duplicate).',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string' } },
    },
    requiresProject: true,
  },
];

export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  const { store, config, limiter, notifier } = deps;

  app.get('/mcp', { schema: { hide: true } }, async (_request, reply) =>
    // A plain GET is not an MCP handshake. Say what this endpoint is instead of
    // returning a protocol error to a human who pasted the URL in a browser.
    reply.type('application/json').send({
      name: 'muster',
      version: '0.1.0',
      transport: 'streamable-http',
      usage: 'POST JSON-RPC 2.0 here: initialize, tools/list, tools/call.',
      authentication: 'authorization: Bearer <project token>',
      card: `${config.baseUrl}/.well-known/mcp.json`,
      instructions: `${config.baseUrl}/skill.md`,
      tools: TOOLS.map((tool) => tool.name),
    }),
  );

  app.post('/mcp', { schema: { hide: true } }, async (request, reply) => {
    const body = request.body as JsonRpcRequest | JsonRpcRequest[] | undefined;
    if (Array.isArray(body)) {
      // A JSON-RPC batch is one HTTP request and as many pieces of work as it
      // has members. Left uncapped, a megabyte of body is several thousand
      // tool calls that the per-request limiter counts once, so one client
      // turns a rate limit into a suggestion. Real clients batch a handful.
      if (body.length > MAX_BATCH) {
        return reply.code(400).send({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32600,
            message: `A batch holds at most ${MAX_BATCH} requests; this one had ${body.length}. Send them in smaller batches.`,
          },
        });
      }
      const results = [];
      for (const entry of body) {
        const result = await handle(entry, request, reply);
        if (result !== undefined) results.push(result);
      }
      return results.length > 0 ? reply.send(results) : reply.code(202).send();
    }
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return reply.code(400).send({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message:
            'Not a JSON-RPC 2.0 request. This is an MCP Streamable HTTP endpoint; see /.well-known/mcp.json.',
        },
      });
    }
    const result = await handle(body, request, reply);
    if (result === undefined) return reply.code(202).send();
    return reply.send(result);
  });

  async function handle(
    message: JsonRpcRequest,
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<unknown> {
    const id = message.id ?? null;
    const params = message.params ?? {};

    try {
      switch (message.method) {
        case 'initialize': {
          const requested = str((params as { protocolVersion?: unknown }).protocolVersion);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: requested || DEFAULT_PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'muster', version: '0.1.0' },
              instructions:
                'Shared operational memory for long-lived agents. Read ' +
                `${config.baseUrl}/skill.md once; the tools here mirror it exactly.`,
            },
          };
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return undefined;
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              tools: TOOLS.map((tool) => ({
                name: tool.name,
                title: tool.title,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            },
          };
        case 'tools/call': {
          const name = str((params as { name?: unknown }).name);
          const args = ((params as { arguments?: unknown }).arguments ?? {}) as Record<
            string,
            unknown
          >;
          const tool = TOOLS.find((candidate) => candidate.name === name);
          if (!tool) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: `Unknown tool "${name}".` },
            };
          }
          const output = await callTool(tool, args, request);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
              structuredContent: output,
            },
          };
        }
        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Unsupported method "${message.method}".` },
          };
      }
    } catch (error) {
      const status = error instanceof ServiceError ? error.statusCode : 500;
      const text = error instanceof Error ? error.message : 'Unexpected error';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `${status}: ${text}` }],
          structuredContent: { error: text, status },
          isError: true,
        },
      };
    }
  }

  async function callTool(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    request: FastifyRequest,
  ): Promise<Record<string, unknown>> {
    if (!tool.requiresProject) {
      // The same published limit as POST /p. A tool call is a cheaper way to
      // ask for a project, not a way around the cap.
      const ip = clientIp(request);
      const verdict = limiter.check(`create:${ip}`, config.rateLimits.createProject);
      if (!verdict.ok) {
        throw new ServiceError(
          429,
          'rate_limited',
          `Too many new projects from this address. Retry in ${verdict.retryAfterSeconds}s. If you already have a project, use its token instead of making another.`,
        );
      }
      const { project, adminToken } = await createProject(store, config, {
        name: str(args.name, 'Untitled project'),
        description: str(args.description),
      });
      record(store, 'signup', { door: 'mcp', projectId: project._id });
      return {
        project: project._id,
        name: project.name,
        description: project.description,
        token: adminToken,
        api: `${config.baseUrl}/v1/${project._id}`,
        read_url: `${config.baseUrl}/r/${project.readToken}`,
        expires_at: project.expiresAt,
        notice:
          'Store this token. It is shown once. Have a human claim the project by email to remove the expiry.',
      };
    }

    const header = request.headers.authorization;
    const token =
      typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
        ? header.slice(7).trim()
        : null;
    if (!token) {
      throw new ServiceError(
        401,
        'missing_token',
        'Send your project token as "authorization: Bearer <token>". Call create_project first if you do not have one.',
      );
    }

    // Charged per tool call, on the same buckets the REST surface uses. The
    // REST side limits in a preHandler, which counts one HTTP request; a batch
    // is many calls inside one request, so the count has to happen here or the
    // two doors publish the same limit and enforce different things. Charged
    // before the lookup, so an invalid token cannot spend a database query per
    // batch member either.
    const writes = new Set([
      'register_agent',
      'upsert_item',
      'claim_item',
      'append_note',
      'observe',
      'escalate',
      'move',
      'share_project',
    ]);
    const kind = writes.has(tool.name) ? 'w' : 'r';
    const verdict = limiter.check(
      `tok:${hashToken(token).slice(0, 16)}:${kind}`,
      kind === 'w' ? config.rateLimits.write : config.rateLimits.read,
    );
    if (!verdict.ok) {
      throw new ServiceError(
        429,
        'rate_limited',
        `Too many calls. Retry in ${verdict.retryAfterSeconds}s. Published limits live at ${config.baseUrl}/.well-known/agent-access.json.`,
      );
    }

    const { project, key } = await authenticate(store, token);
    const actor = str(args.actor) || str(args.agent) || 'unknown-agent';

    // Offering the project to a person decides who ends up owning it, and
    // ownership has no way back. The HTTP route asks for an admin key; a tool
    // call is the same act through a different door.
    if (tool.name === 'share_project' && key.role !== 'admin') {
      throw new ServiceError(
        403,
        'admin_required',
        'Offering this project to a person needs an admin token. The bootstrap token returned by create_project is one.',
      );
    }

    switch (tool.name) {
      case 'register_agent': {
        const { agent, created } = await registerAgent(store, project, {
          handle: str(args.handle),
          scope: Array.isArray(args.scope) ? (args.scope as string[]) : undefined,
          description: str(args.description),
        });
        if (created) record(store, 'register', { door: 'mcp', projectId: project._id });
        return { handle: agent.handle, scope: agent.scope, created };
      }
      case 'upsert_item': {
        const result = await upsertItem(store, project, {
          slug: str(args.slug),
          title: args.title === undefined ? undefined : str(args.title),
          body: args.body === undefined ? undefined : str(args.body),
          status: args.status as ItemStatus | undefined,
          owner: args.owner === undefined ? undefined : str(args.owner),
          priority: typeof args.priority === 'number' ? args.priority : undefined,
          labels: Array.isArray(args.labels) ? (args.labels as string[]) : undefined,
          source: args.source === undefined ? undefined : str(args.source),
          note: args.note === undefined ? undefined : str(args.note),
          actor,
        });
        if (result.created) recordFirstWrite(store, project._id, 'mcp');
        void maybeSweep(store, project).catch(() => undefined);
        return {
          item: itemJson(result.item),
          created: result.created,
          warnings: result.warnings,
        };
      }
      case 'claim_item': {
        const result = await claimItem(
          store,
          project,
          str(args.slug),
          str(args.agent) || actor,
          typeof args.ttl_minutes === 'number' ? args.ttl_minutes : undefined,
        );
        return result.ok
          ? { ok: true, item: itemJson(result.item!), expires_at: result.expiresAt }
          : {
              ok: false,
              held_by: result.heldBy,
              hint: 'Somebody else is on this. Pick something else.',
            };
      }
      case 'append_note': {
        const item = await appendNote(store, project, str(args.slug), actor, str(args.message));
        return { item: itemJson(item) };
      }
      case 'next_item': {
        void maybeSweep(store, project).catch(() => undefined);
        const result = await nextItem(store, project, str(args.agent));
        return {
          item: result.item ? itemJson(result.item, true) : null,
          reason: result.reason,
        };
      }
      case 'list_items': {
        const items = await listItems(store, project._id, {
          status: args.status as ItemStatus | undefined,
          owner: args.owner === undefined ? undefined : str(args.owner),
          label: args.label === undefined ? undefined : str(args.label),
          source: args.source === undefined ? undefined : str(args.source),
          stale: typeof args.stale === 'boolean' ? args.stale : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
        return { items: items.map((item) => itemJson(item)) };
      }
      case 'observe': {
        const present = Array.isArray(args.present) ? (args.present as string[]) : [];
        return { ...(await observe(store, project, str(args.source), present)) };
      }
      case 'escalate': {
        const doc = await createEscalation(store, project, {
          agent: actor,
          question: str(args.question),
          context: str(args.context),
          priority: args.priority as EscalationPriority | undefined,
          itemSlug: args.item_slug === undefined ? null : str(args.item_slug),
        });
        await notifier.escalationRaised(project, doc);
        return {
          escalation: escalationJson(doc),
          read_url: `${config.baseUrl}/r/${project.readToken}`,
        };
      }
      case 'board': {
        void maybeSweep(store, project).catch(() => undefined);
        const view = await loadBoard(store, project, {
          ...(str(args.owner) ? { owner: str(args.owner) } : {}),
          ...(str(args.agent) ? { agent: str(args.agent) } : {}),
        });
        return boardJson(view, args.items !== false);
      }
      case 'move': {
        const result = await moveItem(store, project, {
          slug: str(args.slug),
          column: str(args.column),
          actor,
          ...(args.note === undefined ? {} : { note: str(args.note) }),
        });
        return {
          ok: true,
          item: itemJson(result.item),
          applied: boardApplyJson(result.applied),
          landed_in: result.landedIn,
          ...(result.warning === undefined ? {} : { warning: result.warning }),
        };
      }
      case 'share_project': {
        const email = str(args.email);
        const { alreadyOwned } = await shareProject(store, project, {
          email,
          note: str(args.note),
          offeredBy: actor,
        });
        if (alreadyOwned) return { ok: true, already_owned: true };

        // The same answer for every address, for the reason the HTTP endpoint
        // gives: whether somebody is already a user is not this caller's
        // business, and a project token costs nothing to obtain.
        return {
          ok: true,
          pending: true,
          tell_them: `${config.baseUrl}/r/${project.readToken}`,
          hint: 'Send them that link. If they already use Muster, the offer is also waiting in their operator view, where one click makes them the owner.',
        };
      }
      case 'inbox': {
        const docs = await listEscalations(store, project._id, {
          agent: str(args.agent) || undefined,
        });
        // Somebody standing at the read link asking to be made the owner is
        // the other thing an agent has to notice here, and an interface that
        // hides it is an interface through which the handover cannot be
        // completed at all.
        const handovers = project.claimedBy
          ? []
          : await listHandoverRequests(store, project._id);
        return {
          answers: docs.filter((doc) => doc.status !== 'open').map(escalationJson),
          waiting: docs.filter((doc) => doc.status === 'open').map(escalationJson),
          ...(handovers.length > 0
            ? {
                handover_requests: handovers.map((doc) => ({
                  email: doc.email,
                  note: doc.note,
                  asked_at: doc.createdAt,
                })),
                hint: `Somebody wants this board. Hand it over with the share_project tool and their address. Never send them the project token.`,
              }
            : {}),
        };
      }
      default:
        throw new ServiceError(400, 'unknown_tool', `Tool "${tool.name}" has no implementation.`);
    }
  }
}
