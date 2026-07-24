import type { Context, Next } from "hono"
import type { AppEnv } from "../types.ts"
import { verifyPass } from "../lib/token.ts"
import { isAdmitted } from "../queue/session.ts"

/**
 * Guards the "real site" routes. A request needs a pass that (a) is a valid,
 * unexpired JWT and (b) still corresponds to a live slot — so a released or
 * evicted ticket is rejected even if its JWT has not expired yet.
 */
export async function requirePass(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const dropId = c.req.param("dropId")
  const header = c.req.header("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7) : ""

  if (!token) {
    return c.json({ error: "no_pass", redirect: `/drop/${dropId}` }, 401)
  }
  try {
    const pass = await verifyPass(token)
    if (pass.dropId !== dropId || !(await isAdmitted(dropId, pass.ticketId))) {
      return c.json({ error: "pass_revoked", redirect: `/drop/${dropId}` }, 403)
    }
    c.set("ticketId", pass.ticketId)
    await next()
  } catch {
    return c.json({ error: "invalid_pass", redirect: `/drop/${dropId}` }, 403)
  }
}
