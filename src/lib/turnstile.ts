import { env } from "./config.ts"

// Server-side verification only — the browser must NEVER call siteverify.
// Flow: browser widget → our gate → this → Cloudflare siteverify.
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

/** Turnstile is active only when a secret is configured. */
export function turnstileEnabled(): boolean {
  return !!env.WR_TURNSTILE_SECRET
}

type SiteverifyResponse = { success: boolean; "error-codes"?: string[] }

/**
 * Validates a Turnstile token with Cloudflare. Returns true when the challenge
 * passed. When Turnstile is disabled (no secret), everything is allowed so local
 * dev and load tests keep working.
 */
export async function verifyTurnstile(token: string, remoteip?: string): Promise<boolean> {
  const secret = env.WR_TURNSTILE_SECRET
  if (!secret) return true
  if (!token) return false

  const form = new URLSearchParams({ secret, response: token })
  if (remoteip) form.set("remoteip", remoteip)

  try {
    const r = await fetch(SITEVERIFY, { method: "POST", body: form })
    const data = (await r.json()) as SiteverifyResponse
    return data.success === true
  } catch {
    return false // fail closed: a siteverify outage should not open the gate
  }
}
