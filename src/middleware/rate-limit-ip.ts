import type { Context, Next } from "hono"
import type { AppEnv } from "../types.ts"
import { takeToken, type RateLimit } from "../lib/rate-limit.ts"

/**
 * Resolve the client IP. Behind Caddy/Cloudflare the real address is in
 * `x-forwarded-for` (first hop); otherwise fall back to Bun's socket address.
 */
function clientIp(c: Context<AppEnv>): string {
  const xff = c.req.header("x-forwarded-for")
  if (xff) return xff.split(",")[0]!.trim()
  // Hono's Bun adapter passes the Bun server as `env`; it exposes requestIP().
  const server = c.env as unknown as { requestIP?: (r: Request) => { address: string } | null }
  return server?.requestIP?.(c.req.raw)?.address ?? "unknown"
}

/**
 * Per-IP token bucket. Caps how fast one client can hammer an endpoint — the
 * key defense that stops a bot from spamming enqueue to farm lottery entries.
 */
export function ipRateLimit(scope: string, limit: RateLimit) {
  return async (c: Context<AppEnv>, next: Next): Promise<Response | void> => {
    const ok = await takeToken(scope, clientIp(c), limit)
    if (!ok) return c.json({ error: "rate_limited", scope }, 429)
    await next()
  }
}
