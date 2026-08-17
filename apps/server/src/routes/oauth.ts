import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { hashToken, newId, newToken } from '../ids.js';
import type { RateLimiter } from '../rateLimit.js';
import { createApiKey, createProject } from '../service.js';
import { record } from '../events.js';
import { clientIp } from './api.js';

/**
 * OAuth 2.1 dynamic client registration, RFC 7591.
 *
 * There is no end-user consent step in Muster: a project belongs to whoever
 * created it, and the only human moment is claiming it by email afterwards.
 * That makes `client_credentials` the honest grant and leaves the authorization
 * code flow, PKCE and Client ID Metadata Documents out of scope rather than
 * stubbed. Registering a client creates a project, exactly like POST /p does,
 * so an agent that speaks OAuth and an agent that speaks curl end up in the
 * same place.
 */
export interface OAuthDeps {
  store: Store;
  config: Config;
  limiter: RateLimiter;
}

export function registerOAuth(app: FastifyInstance, deps: OAuthDeps): void {
  const { store, config, limiter } = deps;

  app.get(
    '/.well-known/oauth-authorization-server',
    { schema: { tags: ['oauth'], summary: 'Authorization server metadata' } },
    async () => ({
      issuer: config.baseUrl,
      registration_endpoint: `${config.baseUrl}/oauth/register`,
      token_endpoint: `${config.baseUrl}/oauth/token`,
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      grant_types_supported: ['client_credentials'],
      response_types_supported: [],
      scopes_supported: ['project'],
      service_documentation: `${config.baseUrl}/agent-signup.md`,
      registration_endpoint_auth_methods_supported: ['none'],
    }),
  );

  app.get(
    '/.well-known/oauth-protected-resource',
    { schema: { tags: ['oauth'], summary: 'Protected resource metadata' } },
    async () => ({
      resource: config.baseUrl,
      authorization_servers: [config.baseUrl],
      bearer_methods_supported: ['header'],
      resource_documentation: `${config.baseUrl}/skill.md`,
      scopes_supported: ['project'],
    }),
  );

  app.post(
    '/oauth/register',
    {
      schema: {
        tags: ['oauth'],
        summary: 'Dynamic client registration (RFC 7591)',
        description:
          'Registers a client and provisions the project it will write to. No human, no pre-shared credentials.',
        body: {
          type: 'object',
          properties: {
            client_name: { type: 'string', maxLength: 120 },
            redirect_uris: { type: 'array', items: { type: 'string' } },
            grant_types: { type: 'array', items: { type: 'string' } },
            token_endpoint_auth_method: { type: 'string' },
            scope: { type: 'string' },
          },
          additionalProperties: true,
        },
      },
    },
    async (request, reply) => {
      const ip = clientIp(request);
      const verdict = limiter.check(`create:${ip}`, config.rateLimits.createProject);
      if (!verdict.ok) {
        return reply
          .code(429)
          .header('retry-after', String(verdict.retryAfterSeconds))
          .send({ error: 'slow_down', error_description: 'Too many registrations.' });
      }

      const body = (request.body ?? {}) as { client_name?: string };
      const { project } = await createProject(store, config, { name: body.client_name });
      record(store, 'signup', { door: 'oauth', projectId: project._id });
      const clientId = newId('client');
      const clientSecret = newToken();
      await store.oauthClients.insertOne({
        _id: clientId,
        projectId: project._id,
        secretHash: hashToken(clientSecret),
        name: (body.client_name ?? 'unnamed client').slice(0, 120),
        createdAt: new Date(),
        expiresAt: project.expiresAt,
      });

      return reply.code(201).send({
        client_id: clientId,
        client_secret: clientSecret,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
        client_name: body.client_name ?? 'unnamed client',
        grant_types: ['client_credentials'],
        token_endpoint_auth_method: 'client_secret_post',
        // Not part of RFC 7591; the caller needs to know which project it just
        // got, and hiding it behind a second round trip helps nobody.
        project: project._id,
        api: `${config.baseUrl}/v1/${project._id}`,
        read_url: `${config.baseUrl}/r/${project.readToken}`,
        instructions: `${config.baseUrl}/skill.md`,
      });
    },
  );

  app.post(
    '/oauth/token',
    {
      schema: {
        tags: ['oauth'],
        summary: 'Token endpoint, client_credentials grant',
      },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, string>;
      let clientId = body.client_id;
      let clientSecret = body.client_secret;

      const authHeader = request.headers.authorization;
      if (!clientId && typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('basic ')) {
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        if (separator > 0) {
          clientId = decodeURIComponent(decoded.slice(0, separator));
          clientSecret = decodeURIComponent(decoded.slice(separator + 1));
        }
      }

      if (body.grant_type !== 'client_credentials') {
        return reply.code(400).send({
          error: 'unsupported_grant_type',
          error_description: 'Only client_credentials is supported. See /agent-signup.md.',
        });
      }
      if (!clientId || !clientSecret) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', error_description: 'client_id and client_secret are required.' });
      }

      const client = await store.oauthClients.findOne({ _id: clientId });
      if (!client || client.secretHash !== hashToken(clientSecret)) {
        return reply.code(401).send({ error: 'invalid_client' });
      }
      const project = await store.projects.findOne({ _id: client.projectId });
      if (!project) {
        return reply
          .code(400)
          .send({ error: 'invalid_client', error_description: 'The project behind this client is gone.' });
      }

      const { token } = await createApiKey(store, project, {
        name: `oauth:${client.name}`.slice(0, 80),
        role: 'admin',
      });
      return reply.send({
        access_token: token,
        token_type: 'Bearer',
        scope: `project:${project._id}`,
        // Deliberately no expires_in: project tokens are long lived and are
        // revoked explicitly through DELETE /v1/{project}/keys/{id}.
        project: project._id,
        api: `${config.baseUrl}/v1/${project._id}`,
      });
    },
  );
}
