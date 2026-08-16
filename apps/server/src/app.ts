import formbody from '@fastify/formbody';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { createMailer } from './email.js';
import { layout } from './html.js';
import { RateLimiter } from './rateLimit.js';
import { registerAgentFiles } from './routes/agentfiles.js';
import { registerApi } from './routes/api.js';
import { registerMcp } from './routes/mcp.js';
import { registerOAuth } from './routes/oauth.js';
import { registerPublic } from './routes/public.js';
import { ServiceError } from './service.js';

export interface App {
  server: FastifyInstance;
  limiter: RateLimiter;
}

export async function buildApp(config: Config, store: Store): Promise<App> {
  const server = Fastify({
    logger: { level: config.logLevel },
    // Heroku terminates TLS at the router, so the client address arrives in
    // x-forwarded-for. Rate limits key on it.
    trustProxy: true,
    bodyLimit: 1_048_576,
    routerOptions: {
      // An agent that writes to /items/ instead of /items should get its item
      // written, not a 404 to debug.
      ignoreTrailingSlash: true,
    },
  });

  const limiter = new RateLimiter();
  const mailer = createMailer(config, (message) => server.log.info(message));

  await server.register(formbody);
  await server.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Muster',
        version: '0.1.0',
        description:
          'Shared operational memory for long-lived agents: who is on duty, who owns what, what rotted and what needs a human. Signup is a single POST and needs no human.',
        contact: { email: config.contactEmail },
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

  server.get('/openapi.json', { schema: { hide: true } }, async () => server.swagger());

  registerAgentFiles(server, config);
  registerOAuth(server, { store, config, limiter });
  registerMcp(server, { store, config });
  registerApi(server, { store, config, limiter, mailer });
  registerPublic(server, { store, config, limiter });

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
          layout(
            { title: 'Not found' },
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

  return { server, limiter };
}
