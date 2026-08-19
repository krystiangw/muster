import type { FastifyReply, FastifyRequest } from 'fastify';
import { page } from './page.js';
import formbody from '@fastify/formbody';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { gzipSync } from 'node:zlib';
import type { Config } from './config.js';
import { STORE_UNAVAILABLE, notReadyYet } from './content.js';
import { storeUnreachable, type Store } from './db.js';
import { createMailer, type Mailer } from './email.js';
import { escapeHtml, setContactEmail, setSiteVerification } from './html.js';
import { createNotifier, type Notifier } from './notify.js';
import { recordView } from './events.js';
import { RateLimiter } from './rateLimit.js';
import { registerAgentFiles } from './routes/agentfiles.js';
import { registerApi } from './routes/api.js';
import { registerMcp } from './routes/mcp.js';
import { registerOAuth } from './routes/oauth.js';
import { registerOperator } from './routes/operator.js';
import { registerPublic } from './routes/public.js';
import { ServiceError } from './service.js';

export interface App {
  server: FastifyInstance;
  limiter: RateLimiter;
  /** Exposed so the process can run the periodic pass that requests cannot. */
  notifier: Notifier;
}

/**
 * Which responses may be compressed, decided by the route rather than by a
 * content type.
 *
 * The landing page is 49 kB of markup and 11 kB gzipped, and the protocol
 * documents an agent reads before it signs up are three quarters air. All of
 * them are public text with nothing secret in them, which is the whole point of
 * an allowlist: a read link, an operator page and every API answer carry a
 * capability or a CSRF token, and a compressed response leaks a little about
 * its own contents through its length. Nothing that holds a credential is
 * compressed here, so that question never has to be argued.
 */
declare module 'fastify' {
  interface FastifyReply {
    compressible?: boolean;
  }
}

/** One packet. Below it, the encoding header costs more than the saving. */
const COMPRESS_MIN_BYTES = 1400;

/**
 * Whether this client will take gzip, by the header's own rules rather than by
 * whether the word appears in it.
 *
 * `gzip;q=0` is how a client says it cannot read gzip, and it is written with
 * the word in it, so a substring test hands exactly those clients bytes they
 * asked not to receive. An explicit entry decides on its own; `*` answers only
 * for codings the header never mentions.
 */
/**
 * What the schema already says about the field that was refused.
 *
 * A validator answers in its own language: "body/priority must be <= 10" is
 * true and teaches nothing, and it was the one refusal here that did not name
 * the fix. The field's description is written already, for the OpenAPI
 * document, so the refusal says it too: "Higher is more urgent. 0 is ordinary
 * work and the default." Generic on purpose, so writing a description is the
 * only thing anybody has to remember.
 */
function schemaSays(request: FastifyRequest, error: FastifyError): string {
  const first = (error as { validation?: Array<Record<string, any>> }).validation?.[0];
  if (!first) return '';
  // The field nobody has: "body must NOT have additional properties" is the
  // one validation message that does not say which property, and this service
  // publishes the opposite in as many words, so the name is read out of the
  // error and put back into the sentence.
  const extra = (first.params as { additionalProperty?: string } | undefined)?.additionalProperty;
  if (extra) {
    const where = (error as { validationContext?: string }).validationContext ?? 'body';
    const root = (request.routeOptions?.schema as Record<string, any> | undefined)?.[where];
    // Down to the object that actually refused, because several of these
    // schemas have nested ones with their own closed lists: an unknown key
    // inside `expect` was told the body takes slug, title, body and the rest,
    // which is true of the body and useless about `expect`.
    const at = String(first.instancePath ?? '')
      .split('/')
      .filter(Boolean);
    let node: Record<string, any> | undefined = root;
    for (const step of at) {
      if (!node) break;
      node = /^\d+$/.test(step) ? node.items : node.properties?.[step];
    }
    const known = Object.keys((node?.properties ?? {}) as Record<string, unknown>);
    const whose = at.length > 0 ? `"${at.join('.')}"` : 'this call';
    return `: "${extra}" is not a field ${whose} has${
      known.length > 0 ? `. It takes ${known.join(', ')}` : ''
    }`;
  }
  // A value outside a closed set. AJV says "must be equal to one of the
  // allowed values" and does not say which, which on this service is the
  // refusal an agent is most likely to meet: the statuses are four and the
  // fifth one everybody reaches for, "in_progress", is deliberately not one
  // of them. Reading them out of the error costs nothing and saves a trip to
  // the OpenAPI document.
  const allowed = (first.params as { allowedValues?: unknown[] } | undefined)?.allowedValues;
  const listed =
    Array.isArray(allowed) && allowed.length > 0
      ? `. It takes ${
          allowed.length === 1
            ? String(allowed[0])
            : `${allowed.slice(0, -1).join(', ')} or ${allowed[allowed.length - 1]}`
        }`
      : '';

  const field =
    (first.params as { missingProperty?: string } | undefined)?.missingProperty ??
    String(first.instancePath ?? '')
      .split('/')
      .filter(Boolean)[0];
  if (!field) return listed;
  const where = (error as { validationContext?: string }).validationContext ?? 'body';
  const schema = (request.routeOptions?.schema as Record<string, any> | undefined)?.[where];
  const said = schema?.properties?.[field]?.description;
  // Both, when there are both: the list says what will be accepted and the
  // description says what the values mean.
  return `${listed}${typeof said === 'string' && said !== '' ? `. ${said}` : ''}`;
}

/**
 * One more thing this response varies by, without dropping what was there.
 *
 * `reply.header('vary', ...)` replaces, and two hooks have something to say
 * about it: the compression hook varies by encoding, and every page rendered
 * for whoever is signed in varies by cookie. Whichever ran last used to be the
 * only one a cache was told about.
 */
function addVary(reply: FastifyReply, value: string): void {
  const current = reply.getHeader('vary');
  const parts =
    typeof current === 'string' && current !== '' ? current.split(',').map((part) => part.trim()) : [];
  if (parts.some((part) => part.toLowerCase() === value)) return;
  parts.push(value);
  reply.header('vary', parts.join(', '));
}

export function acceptsGzip(header: string | undefined): boolean {
  if (!header) return false;
  let wildcard: number | null = null;
  for (const part of header.split(',')) {
    const [rawName, ...params] = part.trim().split(';');
    const name = rawName?.trim().toLowerCase();
    if (!name) continue;
    const quality = params.reduce((value, param) => {
      const [key, raw] = param.trim().toLowerCase().split('=');
      if (key !== 'q') return value;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : value;
    }, 1);
    if (name === 'gzip' || name === 'x-gzip') return quality > 0;
    if (name === '*') wildcard = quality;
  }
  return wildcard !== null && wildcard > 0;
}

/**
 * Capability links are credentials in a URL. Anything that writes a URL
 * somewhere it will be kept has to drop the token first.
 */
/**
 * What the map says the service answers, kept level with what it answers.
 *
 * Every refusal this service writes carries `"docs": ".../openapi.json"`, so a
 * caller that reads one is sent straight here. The document said `200` and
 * nothing else for all 41 operations, which was not thin, it was wrong: eight
 * of them answer `201`, and none of the refusals this service takes such care
 * over existed on the map at all. A generated client had no idea 409 or 429
 * were possible, and no name for any call either, because nothing carried an
 * operationId.
 *
 * Written into the document rather than into `schema.response`, on purpose.
 * Declaring a response schema turns on Fastify's serializer for that status,
 * and the serializer drops what the schema does not list: the `unknown`,
 * `accepted` and `belongs_in_body` fields a refusal carries would have gone
 * quiet the moment they were documented. Documenting a thing must not change
 * the thing.
 */
// Always 201: these make something new or refuse.
const CREATES = new Set([
  'post /p',
  'post /oauth/register',
  'post /v1/{project}/escalations',
  'post /v1/{project}/keys',
]);

// Either, and which one it was is the answer's own point. An upsert says
// `created`; a share of a board to the address that already owns it says
// `already_owned` and 200, which a client told to expect only 201 would read
// as a failure of the most ordinary thing a person can do twice.
const CREATES_OR_UPDATES = new Set([
  'post /feedback',
  'post /v1/{project}/agents',
  'post /v1/{project}/items',
  'post /v1/{project}/share',
]);

// Only what the door in question can actually produce. Naming a 403 on a route
// that has no scope to refuse is a second lie in the place the first one was.
const OPEN_DOOR = ['400', '429', '503'];
const TOKEN_DOOR = ['400', '401', '403', '429', '503'];

/**
 * Measured against the deployment, one request each, rather than derived from
 * the shape of the path. The shape would have been wrong: every action on a
 * card takes its slug in the address, and naming a card that is not there gets
 * 400 from five of them and 404 from the two that only read or delete it. A
 * guess would have put 404 on all seven and been wrong about five.
 */
const NOT_FOUND = new Set([
  'get /v1/{project}/items/{slug}',
  'delete /v1/{project}/items/{slug}',
  'delete /v1/{project}/keys/{id}',
  'post /v1/{project}/agents/{handle}/rename',
  'patch /v1/{project}/escalations/{id}',
  'post /v1/{project}/escalations/{id}/ack',
  'post /feedback',
]);

// One. A lease is the only thing here two callers can want at the same instant
// and only one can have; everything else that could collide was made a single
// guarded write instead, and answers 200.
const CONFLICTS = new Set(['post /v1/{project}/items/{slug}/claim']);

const REFUSAL_SAYS: Record<string, string> = {
  '400': 'The request was not understood, and the message says which part. A parameter this endpoint does not have, a value of the wrong shape, or a field outside its set.',
  '401': 'No token, or one that is unknown or revoked. Get one from POST /p.',
  '403': 'A real token for something else: another project, or a key without the scope this call needs.',
  '404': 'No such thing under that name here.',
  '409': 'Somebody else got there first, or the state you said you expected is not the state that is stored.',
  '429': 'Over a published rate limit. The answer names which budget and carries retry-after.',
  '415': 'The body announced a type this service does not read. Send application/json, or a form body on the HTML endpoints.',
  '503': 'The store is out of reach. This is not your request being wrong: come back, and the answer says when.',
};

function operationId(method: string, path: string): string {
  const parts = path
    .split('/')
    .filter(Boolean)
    .map((part) => (part.startsWith('{') ? `by-${part.slice(1, -1)}` : part))
    .join('-')
    .replace(/[^a-zA-Z0-9-]/g, '-');
  return `${method}-${parts}`.replace(/-+/g, '-').replace(/-$/, '');
}

export function redactCapabilities(url: string): string {
  return url
    .replace(/\/r\/[^/?#]+/g, '/r/[redacted]')
    .replace(/\/operator\/[^/?#]+/g, '/operator/[redacted]');
}

/**
 * Overrides for a test that needs to make a dependency behave badly on purpose.
 * The mailer is the only one so far: a delivery that fails has a code path of
 * its own, and reaching it by pointing the real client at a real provider with
 * a wrong key would be a network call, not a test.
 */
export interface BuildOverrides {
  mailer?: Mailer;
}

export async function buildApp(
  config: Config,
  store: Store,
  overrides: BuildOverrides = {},
): Promise<App> {
  const server = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        /**
         * A read link and an operator link are the credential, and they live in
         * the path. Logging the URL as it arrived wrote working capabilities
         * into the platform log, where they outlive the session and reach
         * anybody who can run `heroku logs`. The path still tells you which
         * route was hit, which is what the log is for.
         */
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: redactCapabilities(request.url),
          host: request.headers.host,
          remoteAddress: request.ip,
        }),
      },
    },
    // Exactly one proxy: Heroku's router. It *appends* the client to whatever
    // x-forwarded-for arrived, so trusting every hop would take the attacker's
    // own first entry and hand out a fresh rate limit bucket per request.
    trustProxy: 1,
    bodyLimit: 1_048_576,
    routerOptions: {
      // An agent that writes to /items/ instead of /items should get its item
      // written, not a 404 to debug.
      ignoreTrailingSlash: true,
    },
    ajv: {
      customOptions: {
        /**
         * A field this service does not have is refused, not deleted.
         *
         * Fastify's default is `removeAdditional: true`, which strips unknown
         * properties and answers 201, so `POST /keys` with `label` created a
         * key called "unnamed" and said nothing, and an upsert with a
         * misspelled field wrote the card without it and reported success.
         * The published promise is the opposite of that, in those words: a
         * parameter this service does not have comes back 400 naming it. The
         * query string already behaved this way; the body did not.
         */
        removeAdditional: false,
        /**
         * A value of the wrong shape is refused, not reshaped.
         *
         * Fastify's default is `coerceTypes: 'array'`, which exists for query
         * strings, where one repeated parameter arrives as a scalar and has to
         * become a list of one. On a JSON body it means something else: an
         * agent that sent `"blocked_by": "ops:cutover"` instead of a list got
         * 200 and a card waiting on one thing, having been told nothing. That
         * is the same silent repair as dropping an unknown field, which this
         * service refuses in as many words and publishes a promise about.
         *
         * `true` rather than `false`, because the query strings do depend on
         * coercion: `?limit=200` and `?include_closed=true` arrive as text and
         * the schemas say number and boolean. Nothing here declares an array
         * in a query string, so the only behaviour this gives up is the one
         * that was hiding a mistake.
         */
        coerceTypes: true,
      },
    },
  });

  setSiteVerification(config.siteVerification);
  setContactEmail(config.contactEmail);

  const limiter = new RateLimiter();
  const mailer = overrides.mailer ?? createMailer(config, (message) => server.log.info(message));
  const notifier = createNotifier({
    store,
    config,
    mailer,
    log: (message) => server.log.info(message),
  });

  /**
   * Security headers.
   *
   * These pages ship no JavaScript at all, which makes the policy unusually
   * strict rather than unusually loose: nothing may be fetched, nothing may be
   * executed, and the only thing allowed is the stylesheet the page carries
   * inline. Two of these are load bearing for this particular product:
   *
   *  - `Referrer-Policy: same-origin`, because a read link and an operator link
   *    are credentials that live in the path, and a Referer header hands them
   *    to whatever a person clicks through to next. `same-origin` strips the
   *    header on every request that leaves this service, which is the whole of
   *    the leak, and keeps it on our own pages, where the address is already in
   *    the request line. `no-referrer` looks stricter and costs more than it
   *    buys: Fetch serializes `Origin` as `null` under it, so the same-site
   *    check on the capability forms saw every one of our own posts as a
   *    stranger's.
   *  - `frame-ancestors 'none'`, because those same pages carry one click
   *    forms that accept a board or move a card, which is exactly what a
   *    clickjacking frame is for.
   */
  server.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header(
      'content-security-policy',
      // `img-src 'self'` is for the favicon and nothing else. A browser fetches
      // it under the page's image policy, so a policy of `data:` alone leaves
      // every tab showing the blank sheet while the icon route answers 200.
      // `style-src 'self'` for the sheet every page links, which is a file
      // now rather than twenty five kilobytes repeated in every answer.
      // `'unsafe-inline'` stays for the style attributes on the page itself: a
      // handle's colour is computed from the handle, so it cannot live in a
      // stylesheet written before the handle existed.
      "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    // Only meaningful over TLS, and the deploy terminates TLS at the router.
    if (request.headers['x-forwarded-proto'] === 'https') {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    // Every page this service draws now answers the navigation from the session
    // cookie, so every page this service draws varies by it. Said here rather
    // than at each route for the reason the navigation itself was moved: a rule
    // that has to be remembered per page is a rule that will be forgotten by
    // the next page.
    if (String(reply.getHeader('content-type') ?? '').startsWith('text/html')) {
      addVary(reply, 'cookie');
    }
    // Nobody else's to cache: a capability URL, or a page rendered for whoever
    // is signed in. `/operator` with no trailing slash is the signed in view
    // itself, so matching only `/operator/` would miss the page that actually
    // carries somebody's queue.
    if (
      request.url.startsWith('/r/') ||
      request.url === '/operator' ||
      request.url.startsWith('/operator/') ||
      request.url.startsWith('/operator?')
    ) {
      reply.header('cache-control', 'private, no-store');
      // A read link is a credential in a URL, and a credential in a URL gets
      // pasted into an issue, a chat or a gist eventually. A crawler that finds
      // one there would put somebody's board in a search index, where the
      // repair is not rotating the link but asking a search engine to forget.
      // The header, not a robots.txt rule: a Disallow keeps a crawler from
      // fetching the page and therefore from ever reading this.
      reply.header('x-robots-tag', 'noindex, nofollow, noarchive');
    }
    return payload;
  });

  await server.register(formbody);

  /**
   * One value per field, or a refusal.
   *
   * A form-encoded body repeating a field parses into an array, and every
   * handler behind these pages was written for the string a browser sends: one
   * `slug` twice answered 500, and the ones that survived did so by joining two
   * values with a comma and acting on the result. No form this service renders
   * has a repeated field, so this is somebody hand-writing a request, and the
   * honest answer to "which one did you mean" is to ask.
   *
   * Form bodies only. A JSON array is an ordinary value on the API door, where
   * the schemas say which fields take one.
   */
  /**
   * Nothing that needs the database until the database is ready for it.
   *
   * A connection is not readiness. Between the client connecting and the
   * indexes being built, every query works and one of them is missing its
   * unique constraint: a write landing in that window can break the invariant
   * the index is for and make the build fail, which leaves a deployment that
   * looks healthy and is not. The process serves its static pages through it,
   * because a protocol document and a landing page are worth serving whatever
   * the database is doing, and answers everything else the way it would answer
   * an unreachable store, which is what this is.
   *
   * Listed by route rather than by exclusion. Missing an entry here leaves a
   * route answering the driver's own failure, which is where it was before;
   * missing one the other way round would take a page down for no reason.
   *
   * Matched on a segment boundary, not on a prefix: `/p` as a prefix also
   * matches `/pricing`, which is a static page and has no business refusing.
   * `GET /signup` is the same page in the other direction, a form nobody has
   * posted yet, while the POST behind it creates a project and is exactly the
   * write this is here to hold back.
   */
  const NEEDS_THE_STORE = ['/p', '/v1', '/mcp', '/r', '/operator', '/oauth', '/signup'];
  server.addHook('onRequest', async (request, reply) => {
    if (store.ready.ok) return;
    // Normalised the way the router normalises it: this server ignores a
    // trailing slash, so `/signup/` reaches the same page and has to be read
    // as the same path here or the exemption below misses it.
    const path = (request.url.split('?')[0] ?? '').replace(/\/+$/, '') || '/';
    const wanted = NEEDS_THE_STORE.some((route) => path === route || path.startsWith(`${route}/`));
    if (!wanted) return;
    // HEAD as well as GET: Fastify answers HEAD from the same handler, and a
    // page that is fine to read is fine to ask the size of.
    if ((request.method === 'GET' || request.method === 'HEAD') && path === '/signup') return;
    return reply
      .code(503)
      .header('retry-after', '5')
      .send({
        error: 'store_unavailable',
        message: `${notReadyYet(store.ready.why)} Retry in a few seconds; nothing was written.`,
        retry_after: 5,
      });
  });

  server.addHook('preValidation', async (request, reply) => {
    // Lowercased, because a media type is case insensitive and Fastify parses
    // `Application/X-Www-Form-Urlencoded` as a form body all the same: a check
    // that reads it literally is a guard with a spelling for a key.
    const type = String(request.headers['content-type'] ?? '').toLowerCase();
    if (!type.startsWith('application/x-www-form-urlencoded')) return;
    const body = request.body;
    if (typeof body !== 'object' || body === null) return;
    const twice = Object.entries(body as Record<string, unknown>).find(([, value]) =>
      Array.isArray(value),
    );
    if (!twice) return;
    const wantsHtml = (request.headers.accept ?? '').includes('text/html');
    const said = `The field "${twice[0].slice(0, 40).replace(/[<>&"]/g, '')}" arrived more than once, so this request says two different things. Nothing was changed.`;
    return wantsHtml
      ? reply.code(400).type('text/html; charset=utf-8').send(
          page(request, { title: 'That form said two things' }, `<h1>That form said two things</h1><p>${said}</p>`),
        )
      : reply.code(400).send({ error: 'repeated_field', message: said });
  });
  await server.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Muster',
        version: '0.1.0',
        description:
          'Shared operational memory for long-lived agents: who is on duty, who owns what, what rotted and what needs a human. Signup is a single POST and needs no human.',
        ...(config.contactEmail ? { contact: { email: config.contactEmail } } : {}),
      },
      servers: [{ url: config.baseUrl }],
      components: {
        securitySchemes: {
          bearer: {
            type: 'http',
            scheme: 'bearer',
            description: 'Project token from POST /p, or an OAuth client_credentials access token.',
          },
        },
      },
      security: [{ bearer: [] }],
      tags: [
        { name: 'projects', description: 'Signing up and keeping a project' },
        { name: 'agents', description: 'Who is on duty and what they own' },
        { name: 'items', description: 'Work and observations, addressed by stable slug' },
        { name: 'claims', description: 'Leases that expire without a heartbeat' },
        { name: 'escalations', description: 'Questions for the human' },
        { name: 'hygiene', description: 'Server-side rules that keep the board honest' },
        { name: 'keys', description: 'Programmatic key provisioning' },
        { name: 'oauth', description: 'Dynamic client registration and tokens' },
      ],
    },
    transformObject: (given) => {
      // The plugin's argument is a union: a swagger 2 document or an openapi
      // one, and this deployment only ever produces the second.
      const doc = (given as { openapiObject: unknown }).openapiObject as {
        components?: { schemas?: Record<string, unknown> };
        paths?: Record<
          string,
          Record<string, { responses?: Record<string, unknown>; operationId?: string; requestBody?: unknown }>
        >;
      };
      doc.components = doc.components ?? {};
      doc.components.schemas = {
        ...(doc.components.schemas ?? {}),
        Refusal: {
          type: 'object',
          description:
            'Every refusal this service writes, at both doors. The message is a sentence for whoever reads the transcript; the error is the word a loop branches on. Some carry extra fields naming what was wrong, which is why this shape is open.',
          required: ['error', 'message'],
          properties: {
            error: { type: 'string', description: 'The stable word. Branch on this, not on the sentence.' },
            message: { type: 'string', description: 'What went wrong and what to do about it.' },
            docs: { type: 'string', format: 'uri', description: 'This document.' },
          },
          additionalProperties: true,
        },
      };

      // The token endpoint answers in the shape RFC 6749 defines, not in this
      // service's: one word, no sentence. Documenting it with the house schema
      // would put a `message` on the map that never arrives, which is the kind
      // of thing this whole change exists to stop.
      doc.components.schemas.OauthError = {
        type: 'object',
        description: 'The error shape RFC 6749 section 5.2 defines, which is what every OAuth client already reads.',
        required: ['error'],
        properties: {
          error: { type: 'string', description: 'invalid_client, invalid_grant, unsupported_grant_type, invalid_request.' },
          error_description: { type: 'string' },
        },
        additionalProperties: true,
      };

      // A lease somebody else holds is not refused, it is described: the answer
      // names the holder, says what to do instead, and hands back the card so
      // the caller does not have to fetch it to find out what it lost. That is
      // a better answer than a refusal and it is not the refusal shape, which
      // is why writing it down as one was wrong until a check compared the map
      // with a body that had actually arrived.
      doc.components.schemas.Held = {
        type: 'object',
        description: 'A lease request that lost. Not an error envelope: the card comes back with it.',
        required: ['ok', 'held_by', 'item'],
        properties: {
          ok: { type: 'boolean', description: 'false. The lease was not taken.' },
          held_by: { type: 'string', description: 'The agent holding it now.' },
          hint: { type: 'string', description: 'What to do instead.' },
          item: { type: 'object', description: 'The card, as every other call returns it.' },
        },
        additionalProperties: true,
      };

      const refusal = (code: string) => ({
        description: REFUSAL_SAYS[code] ?? 'Refused.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Refusal' } } },
      });

      for (const [path, item] of Object.entries(doc.paths ?? {})) {
        for (const [method, operation] of Object.entries(item)) {
          if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
          operation.operationId ??= operationId(method, path);
          const responses = operation.responses ?? {};
          const key = `${method} ${path}`;
          if (CREATES.has(key) || CREATES_OR_UPDATES.has(key)) {
            responses['201'] = responses['200'] ?? { description: 'Created.' };
            if (CREATES_OR_UPDATES.has(key)) {
              responses['200'] = responses['200'] ?? { description: 'Already there, and answered as such.' };
            } else {
              delete responses['200'];
            }
          }
          const codes = [
            ...(path.startsWith('/v1/') ? TOKEN_DOOR : path === '/p' || path === '/feedback' ? OPEN_DOOR : []),
            ...(NOT_FOUND.has(key) ? ['404'] : []),
          ];
          for (const code of codes) responses[code] ??= refusal(code);
          if (CONFLICTS.has(key)) {
            // Two shapes, because there are two ways to lose a lease and they
            // are not the same news. Somebody holding it is described: the
            // holder is named and the card comes back. Something unfinished in
            // front of it is refused: it names what to finish first. anyOf and
            // not oneOf, for the same reason as the OAuth pair: the shapes are
            // open, and a keyword meaning "exactly one" turns any future
            // overlap into a validator rejecting a body this service sends.
            responses['409'] ??= {
              description:
                'Somebody else holds the lease, and the answer names them and returns the card; or something the card waits on is unfinished, and the answer names that.',
              content: {
                'application/json': {
                  schema: {
                    anyOf: [
                      { $ref: '#/components/schemas/Held' },
                      { $ref: '#/components/schemas/Refusal' },
                    ],
                  },
                },
              },
            };
          }

          // A body announced as something other than JSON is refused by the
          // content-type parser, before routing reaches anything this endpoint
          // declares. Derived from the method and not from having a documented
          // body, which was tried and was wrong: three writes declare no body
          // schema and answer 415 all the same, and so does every DELETE. A
          // GET answers 200 and ignores the header, having nothing to parse.
          if (['post', 'put', 'patch', 'delete'].includes(method)) responses['415'] ??= refusal('415');

          // The two OAuth endpoints, which are the same service in somebody
          // else's vocabulary. Registration refuses in this service's shape,
          // because what refuses it is this service's schema check. The token
          // endpoint refuses a grant in the shape RFC 6749 defines, and its
          // own schema check still refuses in the house shape, so a 400 there
          // is honestly one or the other and is written that way.
          if (path.startsWith('/oauth/')) {
            // Which shape a refusal wears here depends on who writes it, not on
            // which endpoint it came from. What these handlers write themselves
            // is the OAuth shape, one word and a description. What refuses them
            // before they run is this service: the schema check, the media type
            // parser and the readiness gate all speak the house shape. So a 400
            // is honestly either, a 429 is always theirs, and 415 and 503 are
            // always ours.
            responses['400'] ??= {
              description:
                "Refused by this endpoint's own rules, in the OAuth shape, or by the schema check in front of them, in this service's.",
              content: {
                'application/json': {
                  // anyOf and not oneOf. Both shapes are open and OauthError
                  // requires only `error`, so a house-shaped refusal satisfies
                  // both branches; under oneOf, which means exactly one, a
                  // validator rejects the very body this service sends.
                  schema: {
                    anyOf: [
                      { $ref: '#/components/schemas/OauthError' },
                      { $ref: '#/components/schemas/Refusal' },
                    ],
                  },
                },
              },
            };
            responses['429'] ??= {
              description: 'Over the rate limit, written by the endpoint itself and so in the OAuth shape.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/OauthError' } } },
            };
            responses['503'] ??= refusal('503');
            if (path === '/oauth/token') {
              responses['401'] ??= {
                description: 'The client id and secret do not name a client here.',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/OauthError' } } },
              };
            }
          }
          operation.responses = responses;
        }
      }
      return doc as never;
    },
  });

  server.get('/openapi.json', { schema: { hide: true } }, async (_request, reply) => {
    reply.compressible = true;
    return server.swagger();
  });

  /**
   * The same document as a page.
   *
   * Not a second copy: it is rendered from `server.swagger()`, which is
   * generated from the schemas that validate the requests, so a route that
   * changes changes this with it. It exists because openapi.json answers
   * "what can I call" only to something willing to parse it, and the two
   * readers who are not are a person deciding whether to use this at all and
   * an agent that fetches HTML and reads it.
   */
  server.get('/docs/api', { schema: { hide: true } }, async (request, reply) => {
    recordView(store, 'docs/api', request, new URL(config.baseUrl).host);
    reply.compressible = true;
    const doc = server.swagger() as {
      paths: Record<string, Record<string, { summary?: string; description?: string; tags?: string[] }>>;
    };
    const rows: Array<{ tag: string; method: string; path: string; summary: string; description: string }> = [];
    for (const [path, methods] of Object.entries(doc.paths ?? {})) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        rows.push({
          tag: operation.tags?.[0] ?? 'other',
          method: method.toUpperCase(),
          path,
          summary: operation.summary ?? '',
          description: operation.description ?? '',
        });
      }
    }
    const groups = [...new Set(rows.map((row) => row.tag))];
    const body = `
<h1>API reference</h1>
<p class="lead">Every endpoint this deployment serves, generated from the same schemas that
validate the requests, so it cannot describe a route that is not there. The machine-readable
version is <a href="/openapi.json">openapi.json</a>; the five calls that matter, with copy-paste
curl, are in <a href="/skill.md">skill.md</a>.</p>
<p>Authentication is one header on everything under <code>/v1</code>:
<code>authorization: Bearer &lt;project token&gt;</code>. Getting the first token is
<a href="/docs/keys">one call and no account</a>.</p>
${groups
  .map(
    (tag) => `<h2>${escapeHtml(tag)}</h2>
<div class="scroll"><table>
<thead><tr><th scope="col">Call</th><th scope="col">What it does</th></tr></thead>
<tbody>
${rows
  .filter((row) => row.tag === tag)
  .map(
    (row) =>
      `<tr><td class="mono">${escapeHtml(row.method)} ${escapeHtml(row.path)}</td><td>${escapeHtml(
        row.summary,
      )}${row.description ? `<br><span class="why">${escapeHtml(row.description)}</span>` : ''}</td></tr>`,
  )
  .join('\n')}
</tbody></table></div>`,
  )
  .join('\n')}
`;
    return reply.type('text/html; charset=utf-8').send(
      page(request, {
        title: 'Muster API reference',
        description:
          'Every endpoint, generated from the schemas that validate the requests: projects, items, claims, boards, escalations and keys.',
      }, body),
    );
  });

  server.addHook('onSend', async (request, reply, payload) => {
    if (reply.compressible !== true) return payload;
    // Set whether or not this particular request took the compressed branch:
    // a cache that keeps one and serves it to the other is the classic way to
    // hand a client bytes it cannot read.
    addVary(reply, 'accept-encoding');
    if (typeof payload !== 'string') return payload;
    if (!acceptsGzip(request.headers['accept-encoding'] as string | undefined)) return payload;
    if (Buffer.byteLength(payload) < COMPRESS_MIN_BYTES) return payload;
    const zipped = gzipSync(payload);
    reply.header('content-encoding', 'gzip');
    reply.header('content-length', zipped.length);
    return zipped;
  });

  registerAgentFiles(server, config, store);
  registerOAuth(server, { store, config, limiter });
  registerMcp(server, { store, config, limiter, notifier });
  registerApi(server, { store, config, limiter, mailer, notifier });
  registerOperator(server, { store, config, limiter, mailer });
  registerPublic(server, { store, config, limiter, mailer });

  server.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ServiceError) {
      return reply
        .code(error.statusCode)
        .send({ error: error.code, message: error.message, ...(error.details ?? {}) });
    }
    if ((error as { validation?: unknown }).validation) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: `${error.message}${schemaSays(request, error)}`,
        docs: `${config.baseUrl}/openapi.json`,
      });
    }
    if ((error as { code?: string }).code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.code(415).send({
        error: 'unsupported_media_type',
        message: 'Send application/json, or a form body on the HTML endpoints.',
      });
    }
    /**
     * A body the caller wrote wrong is not this server breaking.
     *
     * It answered 500 "Something broke on our side" to a quote in the wrong
     * place, on the first call a stranger makes, and 5xx is the one class this
     * protocol tells an agent to retry: a permanently malformed request became
     * a loop, and our own log filled with "unhandled error" for every typo.
     * Fastify already decided this is a 400 and says which failure it was, so
     * the only thing missing was reading it.
     */
    const code = (error as { code?: string }).code;
    if (code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      return reply.code(400).send({
        error: 'bad_json',
        message:
          code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
            ? 'The body was empty. Send the JSON this call takes, or {} if every field is optional.'
            : `That body is not JSON this can read: ${error.message}. Nothing was applied, and retrying it unchanged will fail the same way.`,
        docs: `${config.baseUrl}/openapi.json`,
      });
    }
    // Anything else the framework has already judged a client error keeps its
    // own status and its own words. Rounding all of them to "bad json" told a
    // caller whose body was a megabyte of perfectly good JSON to go and look
    // for a syntax error.
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({
        error: code ? String(code).toLowerCase() : 'bad_request',
        message: error.message,
        docs: `${config.baseUrl}/openapi.json`,
      });
    }
    /**
     * The store being out of reach is not this service having a bug.
     *
     * Both answered 500 "something broke on our side", which tells a fleet
     * nothing about whether to come back: 5xx is the class this protocol says
     * to retry, so an agent retried a bug at full speed and backed off from an
     * outage exactly as fast, which is to say not at all. 503 with a
     * `retry-after` is the one answer that means later, and these are the
     * failures where later is the right advice: no node was reachable, the
     * socket went, the client is shut down, the operation ran out of time.
     *
     * What it does not claim is that nothing happened. Server selection fails
     * before anything leaves this process, but a socket dropped mid-write may
     * have been written all the same, and a message saying otherwise would be
     * a guess dressed as a fact. Nor does it say "retry" flatly, which is the
     * advice that turns one lost answer into two projects: a slug is an
     * idempotency key and a minted id is not, so the sentence separates them.
     * It does not call a slug free either. Sending an upsert or a claim again
     * cannot make a second card or take the lease off you, and it does add a
     * line to the timeline both times, which is worth one clause to say.
     */
    if (storeUnreachable(error)) {
      request.log.warn({ err: error }, 'store unreachable');
      return reply
        .code(503)
        .header('retry-after', '5')
        .send({
          error: 'store_unavailable',
          message: STORE_UNAVAILABLE,
          retry_after: 5,
        });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      error: 'internal',
      message: 'Something broke on our side. The request was not applied.',
    });
  });

  server.setNotFoundHandler((request, reply) => {
    const wantsHtml = (request.headers.accept ?? '').includes('text/html');
    if (wantsHtml) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(
          page(request, { title: 'Not found' },
            `<h1>Not found</h1><p>Nothing lives at <code>${request.url.replace(/[<>&"]/g, '')}</code>.
             The map is at <a href="/llms.txt">/llms.txt</a> and the protocol at
             <a href="/skill.md">/skill.md</a>.</p>`,
          ),
        );
    }
    return reply.code(404).send({
      error: 'not_found',
      message: `No route for ${request.method} ${request.url}.`,
      map: `${config.baseUrl}/llms.txt`,
      openapi: `${config.baseUrl}/openapi.json`,
    });
  });

  return { server, limiter, notifier };
}
