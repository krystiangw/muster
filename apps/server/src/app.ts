import type { FastifyReply, FastifyRequest } from 'fastify';
import { page } from './page.js';
import formbody from '@fastify/formbody';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { gzipSync } from 'node:zlib';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { createMailer, type Mailer } from './email.js';
import { setSiteVerification } from './html.js';
import { createNotifier, type Notifier } from './notify.js';
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
  });

  setSiteVerification(config.siteVerification);

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
  });

  server.get('/openapi.json', { schema: { hide: true } }, async (_request, reply) => {
    reply.compressible = true;
    return server.swagger();
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
        message: error.message,
        docs: `${config.baseUrl}/openapi.json`,
      });
    }
    if ((error as { code?: string }).code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.code(415).send({
        error: 'unsupported_media_type',
        message: 'Send application/json, or a form body on the HTML endpoints.',
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
