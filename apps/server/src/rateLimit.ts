import type { RateLimitRule } from './config.js';

export interface RateLimitVerdict {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed window counter, in process.
 *
 * Fixed window rather than sliding because the limit has to be explainable in
 * one sentence in /agent-signup.md, and an agent planning its own pacing needs
 * a number it can predict, not a decaying curve. One dyno means one process, so
 * a shared store buys nothing yet; when a second dyno appears this moves to
 * Mongo or Redis behind the same interface.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly timer: NodeJS.Timeout;

  constructor(sweepIntervalMs = 60_000) {
    this.timer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.timer.unref();
  }

  check(key: string, rule: RateLimitRule, now = Date.now()): RateLimitVerdict {
    const windowMs = rule.windowSeconds * 1000;
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      const resetAt = now + windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      return { ok: true, remaining: rule.requests - 1, retryAfterSeconds: 0, resetAt };
    }

    if (bucket.count >= rule.requests) {
      return {
        ok: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
        resetAt: bucket.resetAt,
      };
    }

    bucket.count += 1;
    return {
      ok: true,
      remaining: rule.requests - bucket.count,
      retryAfterSeconds: 0,
      resetAt: bucket.resetAt,
    };
  }

  private sweep(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

/**
 * The bucket a six digit code is typed into, whichever form it is.
 *
 * There are two of those forms now, one on the operator sign in and one on the
 * read link after a claim, and they were counting separately: a caller got the
 * configured allowance twice over, which is exactly the thing a shared comment
 * in both files claimed was not happening.
 */
export function codeAttemptKey(ip: string): string {
  return `code-attempt:${ip}`;
}
