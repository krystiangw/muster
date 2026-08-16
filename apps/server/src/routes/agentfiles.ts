import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import {
  agentAccessJson,
  agentSignupMd,
  llmsTxt,
  mcpJson,
  robotsTxt,
  skillMd,
} from '../content.js';

/**
 * The agent-facing surface. Every file here is static text generated once at
 * boot: an agent probing them should never wait on a database.
 */
export function registerAgentFiles(app: FastifyInstance, config: Config): void {
  const skill = skillMd(config);
  const signup = agentSignupMd(config);
  const llms = llmsTxt(config);
  const robots = robotsTxt(config);
  const access = agentAccessJson(config);
  const mcpCard = mcpJson(config);

  const markdown = (body: string) => (_request: unknown, reply: any) =>
    reply.type('text/markdown; charset=utf-8').header('cache-control', 'public, max-age=300').send(body);

  // Agents probe several conventional names. Serving the same file under each
  // costs nothing and saves a round trip of guessing.
  for (const path of ['/skill.md', '/agents.md', '/agent.md', '/AGENTS.md']) {
    app.get(path, { schema: { hide: true } }, markdown(skill));
  }
  app.get('/agent-signup.md', { schema: { hide: true } }, markdown(signup));

  app.get('/llms.txt', { schema: { hide: true } }, (_request, reply) =>
    reply.type('text/plain; charset=utf-8').header('cache-control', 'public, max-age=300').send(llms),
  );

  app.get('/robots.txt', { schema: { hide: true } }, (_request, reply) =>
    reply.type('text/plain; charset=utf-8').send(robots),
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

  app.get('/.well-known/agent-access.json', { schema: { hide: true } }, async () => access);
  app.get('/.well-known/mcp.json', { schema: { hide: true } }, async () => mcpCard);
  app.get('/.well-known/ai-plugin.json', { schema: { hide: true } }, async () => ({
    schema_version: 'v1',
    name_for_model: 'muster',
    name_for_human: 'Muster',
    description_for_model:
      'Shared operational memory for long-lived agents: items with stable slugs, claims with TTL, timelines and escalations to a human.',
    description_for_human: 'Shared operational memory for long-lived agents.',
    auth: { type: 'bearer' },
    api: { type: 'openapi', url: `${config.baseUrl}/openapi.json` },
    contact_email: config.contactEmail,
    legal_info_url: `${config.baseUrl}/docs`,
  }));
}
