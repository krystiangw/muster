import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { record } from '../events.js';
import {
  agentAccessJson,
  agentSignupMd,
  llmsTxt,
  mcpJson,
  robotsTxt,
  skillMd,
} from '../content.js';
import { APPLE_TOUCH_PNG, FAVICON_ICO, FAVICON_SVG } from '../favicon.js';

/**
 * The agent-facing surface. Every file here is static text generated once at
 * boot: an agent probing them should never wait on a database.
 */
export function registerAgentFiles(app: FastifyInstance, config: Config, store: Store): void {
  // The top of the funnel. Reading the protocol and deciding not to sign up
  // leaves nothing behind otherwise, so the one number that says whether the
  // front door works at all would be unknowable.
  const seen = (detail: string) => record(store, 'discover', { door: 'http', detail });

  const skill = skillMd(config);
  const signup = agentSignupMd(config);
  const llms = llmsTxt(config);
  const robots = robotsTxt(config);
  const access = agentAccessJson(config);
  const mcpCard = mcpJson(config);

  const markdown = (body: string, detail: string) => (_request: unknown, reply: any) => {
    seen(detail);
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

  app.get('/llms.txt', { schema: { hide: true } }, (_request, reply) => {
    seen('llms.txt');
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
    const pages = ['/', '/docs', '/docs/keys', '/pricing', '/signup', '/operator'];
    const urls = pages
      .map((page) => `  <url><loc>${config.baseUrl}${page}</loc></url>`)
      .join('\n');
    reply
      .type('application/xml; charset=utf-8')
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });

  app.get('/.well-known/agent-access.json', { schema: { hide: true } }, async () => {
    seen('agent-access.json');
    return access;
  });
  app.get('/.well-known/mcp.json', { schema: { hide: true } }, async () => {
    seen('mcp.json');
    return mcpCard;
  });
  app.get('/.well-known/ai-plugin.json', { schema: { hide: true } }, async () => ({
    schema_version: 'v1',
    name_for_model: 'muster',
    name_for_human: 'Muster',
    description_for_model:
      'Shared operational memory for long-lived agents: items with stable slugs, claims with TTL, timelines and escalations to a human.',
    description_for_human: 'Shared operational memory for long-lived agents.',
    auth: { type: 'bearer' },
    api: { type: 'openapi', url: `${config.baseUrl}/openapi.json` },
    ...(config.contactEmail ? { contact_email: config.contactEmail } : {}),
    legal_info_url: `${config.baseUrl}/docs`,
  }));
}
