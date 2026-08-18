import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { isCrawler, record } from '../events.js';
import {
  agentAccessJson,
  agentSignupMd,
  aiCatalogJson,
  llmsTxt,
  mcpJson,
  robotsTxt,
  skillMd,
} from '../content.js';
import { APPLE_TOUCH_PNG, FAVICON_ICO, FAVICON_SVG } from '../favicon.js';
import { STYLE_CSS, STYLE_PATH } from '../html.js';

/**
 * The agent-facing surface. Every file here is static text generated once at
 * boot: an agent probing them should never wait on a database.
 */
export function registerAgentFiles(app: FastifyInstance, config: Config, store: Store): void {
  // The top of the funnel. Reading the protocol and deciding not to sign up
  // leaves nothing behind otherwise, so the one number that says whether the
  // front door works at all would be unknowable.
  //
  // Which of them said it was a crawler is kept beside the read rather than
  // instead of it. Both numbers are worth having and they answer different
  // questions: how often these files are indexed, and how many agents read them
  // and walked away. Counted together, the second question gets the first
  // question's answer, and "two hundred reads per signup" stops meaning
  // anything. Nothing about the reader is stored beyond the one bit.
  const seen = (detail: string, request: { headers: { 'user-agent'?: string | undefined } }) =>
    record(store, 'discover', {
      door: 'http',
      detail,
      crawler: isCrawler(request.headers['user-agent']),
    });

  const skill = skillMd(config);
  const signup = agentSignupMd(config);
  const llms = llmsTxt(config);
  const robots = robotsTxt(config);
  const access = agentAccessJson(config);
  const mcpCard = mcpJson(config);
  const catalog = aiCatalogJson(config);

  // Public text with nothing secret in it, which is what makes it safe to
  // compress. See the allowlist in app.ts.
  const markdown =
    (body: string, detail: string) =>
    (request: { headers: { 'user-agent'?: string | undefined } }, reply: any) => {
      seen(detail, request);
      reply.compressible = true;
      return reply
        .type('text/markdown; charset=utf-8')
        .header('cache-control', 'public, max-age=300')
        .send(body);
    };

  // Agents probe several conventional names. Serving the same file under each
  // costs nothing and saves a round trip of guessing.
  for (const path of ['/skill.md', '/agents.md', '/agent.md', '/AGENTS.md']) {
    app.get(path, { schema: { hide: true } }, markdown(skill, 'skill.md'));
  }
  app.get('/agent-signup.md', { schema: { hide: true } }, markdown(signup, 'agent-signup.md'));

  app.get('/llms.txt', { schema: { hide: true } }, (request, reply) => {
    seen('llms.txt', request);
    reply.compressible = true;
    return reply
      .type('text/plain; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .send(llms);
  });

  app.get('/robots.txt', { schema: { hide: true } }, (_request, reply) =>
    reply.type('text/plain; charset=utf-8').send(robots),
  );

  // The mark. A year is the conventional cache for something whose bytes never
  // change, and these do not: regenerating the icon changes the deploy, and a
  // tab that keeps the old one for a while is nobody's incident.
  const icon = (type: string, body: string | Buffer) => (_request: unknown, reply: any) =>
    reply
      .type(type)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(body);

  // The stylesheet every page links, under a name that carries the hash of its
  // own bytes. Public, identical for everybody and holding nothing anybody
  // could want: that is what makes it safe to compress, which the pages that
  // carry a capability are not.
  app.get(STYLE_PATH, { schema: { hide: true } }, (_request, reply) => {
    reply.compressible = true;
    return reply
      .type('text/css; charset=utf-8')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(STYLE_CSS);
  });

  app.get('/favicon.svg', { schema: { hide: true } }, icon('image/svg+xml', FAVICON_SVG));
  app.get('/favicon.ico', { schema: { hide: true } }, icon('image/x-icon', FAVICON_ICO));
  app.get('/apple-touch-icon.png', { schema: { hide: true } }, icon('image/png', APPLE_TOUCH_PNG));
  // iOS asks for this one by name on some versions, and a 404 there means the
  // home screen gets a screenshot of the page instead of the mark.
  app.get(
    '/apple-touch-icon-precomposed.png',
    { schema: { hide: true } },
    icon('image/png', APPLE_TOUCH_PNG),
  );

  app.get('/sitemap.xml', { schema: { hide: true } }, (_request, reply) => {
    const pages = ['/', '/docs', '/docs/keys', '/docs/api', '/pricing', '/signup', '/operator'];
    const urls = pages
      .map((page) => `  <url><loc>${config.baseUrl}${page}</loc></url>`)
      .join('\n');
    reply
      .type('application/xml; charset=utf-8')
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });

  app.get('/.well-known/agent-access.json', { schema: { hide: true } }, async (request, reply) => {
    seen('agent-access.json', request);
    reply.compressible = true;
    return access;
  });
  app.get('/.well-known/mcp.json', { schema: { hide: true } }, async (request) => {
    seen('mcp.json', request);
    return mcpCard;
  });
  // Proof that whoever publishes `dev.musterboard/muster` to the MCP registry
  // owns this domain. One line of text, the whole record and not just the key:
  // `v=MCPv1; k=ed25519; p=<base64>`. Unset on a deployment that publishes
  // nothing, and then this answers 404 rather than serving an empty file that
  // reads as a broken claim.
  app.get('/.well-known/mcp-registry-auth', { schema: { hide: true } }, (_request, reply) => {
    if (!config.mcpRegistryAuth) {
      return reply.code(404).send({
        error: 'not_configured',
        message: 'This deployment publishes no MCP registry key.',
      });
    }
    return reply
      .type('text/plain; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .send(`${config.mcpRegistryAuth}\n`);
  });

  app.get('/.well-known/ai-catalog.json', { schema: { hide: true } }, async (request, reply) => {
    seen('ai-catalog.json', request);
    reply.compressible = true;
    return catalog;
  });
  // The legacy plugin manifest, kept for clients that still look for it. Its
  // schema requires a contact address and a logo, and a manifest missing a
  // required field is one a strict client throws away: publishing an invalid
  // one is worse than publishing none, so a deployment with nobody to write to
  // does not publish it at all.
  app.get('/.well-known/ai-plugin.json', { schema: { hide: true } }, async (request, reply) => {
    if (!config.contactEmail) {
      return reply.code(404).send({
        error: 'not_configured',
        message: 'This deployment publishes no plugin manifest: it has no contact address set.',
      });
    }
    seen('ai-plugin.json', request);
    return {
      schema_version: 'v1',
      name_for_model: 'muster',
      name_for_human: 'Muster',
      description_for_model:
        'Shared operational memory for long-lived agents: items with stable slugs, claims with TTL, timelines and escalations to a human.',
      description_for_human: 'Shared operational memory for long-lived agents.',
      auth: { type: 'bearer' },
      api: { type: 'openapi', url: `${config.baseUrl}/openapi.json` },
      logo_url: `${config.baseUrl}/apple-touch-icon.png`,
      contact_email: config.contactEmail,
      legal_info_url: `${config.baseUrl}/docs`,
    };
  });
}
