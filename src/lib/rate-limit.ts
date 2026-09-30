// src/lib/rate-limit.ts
//
// Fixed-window counter backed by the RateLimitBucket table.
//
// The previous implementation lived in otp.ts and could not actually roll a
// window over: its upsert reset `windowStart` under a condition that was always
// false, so a bucket only reset once it had already exceeded its limit. That
// let a caller squeeze one free request through on every window boundary and
// made "3 per 10 minutes" mean something subtly different from what it says.
// Here the window is derived from `expiresAt`, so a bucket that has elapsed is
// simply replaced.
import { prisma } from './prisma';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** When the current window ends and the allowance frees up. */
  resetAt: Date;
}

export async function consumeRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const bucket = await prisma.rateLimitBucket.findUnique({ where: { key } });

  // No bucket yet, or the previous window has fully elapsed.
  if (!bucket || bucket.expiresAt.getTime() <= now) {
    const fresh = {
      count: 1,
      windowStart: new Date(now),
      expiresAt: new Date(now + windowSeconds * 1000),
    };
    await prisma.rateLimitBucket.upsert({
      where: { key },
      create: { key, ...fresh },
      update: fresh,
    });
    return { allowed: true, remaining: Math.max(0, limit - 1), resetAt: fresh.expiresAt };
  }

  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: bucket.expiresAt };
  }

  const updated = await prisma.rateLimitBucket.update({
    where: { key },
    data: { count: { increment: 1 } },
  });
  return { allowed: true, remaining: Math.max(0, limit - updated.count), resetAt: bucket.expiresAt };
}

/** Same as consumeRateLimit but throws RATE_LIMITED, for call sites that expect that. */
export async function assertWithinRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const result = await consumeRateLimit(key, limit, windowSeconds);
  if (!result.allowed) throw new Error('RATE_LIMITED');
  return result;
}
