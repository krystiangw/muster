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
    verifyCode: RateLimitRule;
    feedback: RateLimitRule;
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
  siteVerification: string;
  /**
   * The Ed25519 public key line the MCP registry reads to believe that
   * whoever publishes under this domain owns it. Empty on every deployment
   * that is not publishing, and the route 404s rather than serving a blank
   * file, because a well-known path that answers with nothing is worse than
   * one that answers not-found.
   */
  mcpRegistryAuth: string;
  feedbackProject: string;
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
      // Typing a code is not sending an email. Five an hour would leave four
      // guesses and two clean sign ins per address behind a shared address,
      // while the real ceiling on guessing is the five attempts a code allows.
      verifyCode: { requests: int(env.LIMIT_CODE_ATTEMPTS_PER_HOUR, 60), windowSeconds: 3600 },
      // Somebody reporting a problem is not somebody signing up, and ten an
      // hour is more than anyone with something real to say will need.
      feedback: { requests: int(env.LIMIT_FEEDBACK_PER_HOUR, 10), windowSeconds: 3600 },
    },
    resendApiKey: env.RESEND_API_KEY ?? null,
    logUnsentEmails: env.NODE_ENV !== 'production',
    // The shared Resend sender is a development convenience and nothing more:
    // it only delivers to the address that owns the API key, so a production
    // deployment that keeps it silently fails every sign in but the operator's
    // own. `createMailer` says so out loud at boot rather than at the first
    // person who cannot get in.
    emailFrom: env.EMAIL_FROM ?? 'Muster <onboarding@resend.dev>',
    // No default. An address on a domain this deployment does not own
    // sends every reply to a stranger, which is worse than offering
    // nobody to write to.
    contactEmail: env.CONTACT_EMAIL ?? '',
    // Proving to a search console that this deployment is ours. Empty on a
    // self-host, which then renders no tag at all rather than an empty one.
    siteVerification: env.SITE_VERIFICATION ?? '',
    mcpRegistryAuth: env.MCP_REGISTRY_AUTH ?? '',
    /**
     * Where an unauthenticated report lands, if this deployment accepts any.
     *
     * Empty by default, and that default is the honest one: an open write
     * endpoint is a decision about somebody's board, so it belongs to whoever
     * runs the deployment rather than to whoever wrote the code.
     */
    feedbackProject: env.FEEDBACK_PROJECT ?? '',
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
