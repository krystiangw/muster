import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { hashToken, newId, newToken } from '../ids.js';
import type { RateLimiter } from '../rateLimit.js';
import { createApiKey, createProject } from '../service.js';
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

/** How long an access token from the token endpoint lives. */
const TOKEN_TTL_MS = 60 * 60 * 1000;

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

      const body = (request.body ?? {}) as { client_name?: string; grant_types?: string[] };
      // RFC 7591 says to refuse metadata the server cannot honour rather than
      // register something else and let the client find out at the token
      // endpoint. There is no end-user here to send through an authorization
      // code flow, so a client that asks only for one is asking for something
      // this deployment will never do.
      const asked = Array.isArray(body.grant_types) ? body.grant_types : [];
      if (asked.length > 0 && !asked.includes('client_credentials')) {
        return reply.code(400).send({
          error: 'invalid_client_metadata',
          error_description:
            'This server issues tokens with client_credentials only: a project belongs to whoever created it, and the one human moment is claiming it by email afterwards. See /agent-signup.md.',
        });
      }
      const { project } = await createProject(store, config, { name: body.client_name }, 'oauth');
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
        // 0, and it means what RFC 7591 says: this secret has no expiry of its
        // own. It dies with the project it addresses, and that date can move:
        // a human claiming the project by email removes it entirely. Reporting
        // the current deadline here was worse than saying nothing, because a
        // client that honours the field would stop using a credential whose
        // project had since become permanent, and its only recovery, another
        // registration, would hand it a different board. The date the project
        // is scheduled to go is below, where it cannot be mistaken for a
        // property of the secret.
        client_secret_expires_at: 0,
        project_expires_at: project.expiresAt,
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

      // Per source rather than per client: an unknown client_id costs a lookup
      // and a hash whether or not it exists, so the bucket has to be something
      // the caller cannot mint a fresh one of for every attempt.
      const tokenVerdict = limiter.check(`oauth-token:${clientIp(request)}`, config.rateLimits.write);
      if (!tokenVerdict.ok) {
        return reply
          .code(429)
          .header('retry-after', String(tokenVerdict.retryAfterSeconds))
          .send({ error: 'slow_down', error_description: 'Too many token requests.' });
      }

      const client = await store.oauthClients.findOne({ _id: clientId });
      if (!client || client.secretHash !== hashToken(clientSecret)) {
        return reply.code(401).send({ error: 'invalid_client' });
      }
      // The project decides, not the copy of its deadline on the client
      // document: claiming clears the project's expiry and the children are
      // updated separately, so a child whose update lagged would otherwise
      // lock out a client whose board has become permanent.
      //
      // Checked here rather than left to the TTL index, which deletes on its
      // own schedule about a minute behind. The clock is read now rather than
      // before the lookup, because the lookup is where the time went.
      const project = await store.projects.findOne({ _id: client.projectId });
      const gone = { error: 'invalid_client', error_description: 'The project behind this client is gone.' };
      if (!project || (project.expiresAt && project.expiresAt <= new Date())) {
        return reply.code(400).send(gone);
      }

      // An hour, and the key document dies with it.
      //
      // This used to hand out a project token that lived as long as the
      // project. Every refresh a normal OAuth client makes is another one of
      // those, none of them revocable in practice because nothing distinguishes
      // them, and an audit found sixty two live admin keys on one project from
      // sixty two routine refreshes. A token from a token endpoint is supposed
      // to be short lived; the long lived credential for this project is the
      // one POST /p handed out, and it is still there.
      const { token, expiresAt } = await createApiKey(store, project, {
        name: `oauth:${client.name}`.slice(0, 80),
        role: 'admin',
        ttlMs: TOKEN_TTL_MS,
      });
      // A key is capped at the project's own deadline, so a request that
      // arrived a second before it produces a token that authentication
      // rejects on sight. Better to say the project is gone than to answer 200
      // with something already dead.
      //
      // In milliseconds, and floored on the way out. Rounding seconds called
      // 600 ms a whole one and handed back a token that could expire before
      // the client had finished reading the reply.
      const msLeft = expiresAt ? expiresAt.getTime() - Date.now() : TOKEN_TTL_MS;
      if (msLeft < 1000) return reply.code(400).send(gone);
      const secondsLeft = Math.floor(msLeft / 1000);

      return reply.send({
        access_token: token,
        token_type: 'Bearer',
        expires_in: secondsLeft,
        scope: `project:${project._id}`,
        project: project._id,
        api: `${config.baseUrl}/v1/${project._id}`,
      });
    },
  );
}
