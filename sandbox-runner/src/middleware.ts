import { timingSafeEqual, createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { Redis } from "ioredis";
import pino from "pino";
import { config } from "./config.js";

export const logger = pino({ level: config.LOG_LEVEL });

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

// ---------------------------------------------------------------------------
// Authentication — Bearer SANDBOX_RUNNER_TOKEN, constant-time comparison.
// Hashes both sides first so length differences don't leak timing either.
// ---------------------------------------------------------------------------
const tokenDigest = createHash("sha256").update(config.SANDBOX_RUNNER_TOKEN).digest();

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const presentedDigest = createHash("sha256").update(presented).digest();
  if (!presented || !timingSafeEqual(tokenDigest, presentedDigest)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Rate limiting — Redis sliding window per client IP (the caller is always
// our edge functions, but this caps damage from a leaked token or a bug loop).
// ---------------------------------------------------------------------------
export async function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const key = `rl:${ip}`;
    const now = Date.now();
    const windowMs = 60_000;

    const pipeline = redis.multi();
    pipeline.zremrangebyscore(key, 0, now - windowMs);
    pipeline.zadd(key, now, `${now}:${Math.random()}`);
    pipeline.zcard(key);
    pipeline.pexpire(key, windowMs);
    const results = await pipeline.exec();
    const count = Number(results?.[2]?.[1] ?? 0);

    res.setHeader("X-RateLimit-Limit", String(config.RATE_LIMIT_PER_MINUTE));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, config.RATE_LIMIT_PER_MINUTE - count)));

    if (count > config.RATE_LIMIT_PER_MINUTE) {
      res.status(429).json({ error: "Rate limit exceeded" });
      return;
    }
    next();
  } catch (e) {
    // Fail open on Redis hiccups — auth still gates everything.
    logger.warn({ err: e }, "rate limiter degraded");
    next();
  }
}

// Redact anything that looks like a token before it can reach logs or clients.
export function redactSecrets(text: string): string {
  return text
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "gh*_[REDACTED]")
    .replace(/AUTHORIZATION:\s*\S+\s+\S+/gi, "AUTHORIZATION: [REDACTED]")
    .replace(/x-access-token:[^@\s]+/gi, "x-access-token:[REDACTED]");
}
