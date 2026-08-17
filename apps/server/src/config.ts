import type { ProjectLimits, ProjectTier } from './types.js';

export interface RateLimitRule {
  requests: number;
  windowSeconds: number;
}

export interface Config {
  port: number;
  host: string;
  mongoUri: string;
  mongoDb: string;
  /** Public origin, used in every generated URL and in the agent-facing files. */
  baseUrl: string;
  /** How long an unclaimed demo project survives. */
  demoTtlDays: number;
  tiers: Record<ProjectTier, ProjectLimits>;
  rateLimits: {
    createProject: RateLimitRule;
    write: RateLimitRule;
    read: RateLimitRule;
    claimEmail: RateLimitRule;
  };
  resendApiKey: string | null;
  /**
   * Whether an email that cannot be sent may be written to the log in full.
   * True off production, where the log is a terminal somebody is watching and
   * the fallback is what makes a self-host with no mail provider usable.
   */
  logUnsentEmails: boolean;
  emailFrom: string;
  /** Support address published in the agent files. */
  contactEmail: string;
  logLevel: string;
}

function int(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = int(env.PORT, 4600);
  const baseUrl = (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');

  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    mongoUri: env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017',
    mongoDb: env.MONGODB_DB ?? 'muster',
    baseUrl,
    demoTtlDays: int(env.DEMO_TTL_DAYS, 7),
    tiers: {
      demo: { items: 50, agents: 5, escalations: 20 },
      free: { items: 500, agents: 20, escalations: 200 },
      pro: { items: 20_000, agents: 200, escalations: 5_000 },
    },
    // Overridable because a self-hosted Muster behind a VPN has no reason to
    // throttle its own fleet, and the published numbers in agent-access.json
    // are generated from whatever these end up being.
    rateLimits: {
      createProject: {
        requests: int(env.LIMIT_CREATE_PROJECTS_PER_HOUR, 5),
        windowSeconds: 3600,
      },
      write: { requests: int(env.LIMIT_WRITES_PER_MINUTE, 120), windowSeconds: 60 },
      read: { requests: int(env.LIMIT_READS_PER_MINUTE, 600), windowSeconds: 60 },
      claimEmail: { requests: int(env.LIMIT_CLAIM_EMAILS_PER_HOUR, 5), windowSeconds: 3600 },
    },
    resendApiKey: env.RESEND_API_KEY ?? null,
    logUnsentEmails: env.NODE_ENV !== 'production',
    emailFrom: env.EMAIL_FROM ?? 'Muster <hello@muster.dev>',
    contactEmail: env.CONTACT_EMAIL ?? 'hello@muster.dev',
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
