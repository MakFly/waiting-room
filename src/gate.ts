import { Hono } from "hono"
import type { Context } from "hono"
import type { AppEnv } from "./types.ts"
import { getCookie, setCookie } from "hono/cookie"
import { streamSSE } from "hono/streaming"
import { randomUUID } from "node:crypto"

import { env } from "./lib/config.ts"
import { pingRedis } from "./lib/redis.ts"
import { subscribe } from "./lib/bus.ts"
import { signTicket, verifyTicket, signPass } from "./lib/token.ts"
import { keys } from "./queue/keys.ts"
import { enqueue } from "./queue/enqueue.ts"
import { getStatus } from "./queue/status.ts"
import { getDropConfig, setDropConfig } from "./queue/config.ts"
import { heartbeat, release } from "./queue/session.ts"
import { requirePass } from "./middleware/require-pass.ts"
import { ipRateLimit } from "./middleware/rate-limit-ip.ts"
import { verifyTurnstile, turnstileEnabled } from "./lib/turnstile.ts"
import { cmd } from "./lib/redis.ts"

const TICKET_COOKIE = "wr_ticket"

const app = new Hono<AppEnv>()

app.get("/health", async (c) =>
  c.json({ ok: await pingRedis(), service: "waiting-room" }),
)

/** Reads the ticket JWT from cookie or the `x-wr-ticket` header (API clients). */
async function readTicket(c: Context<AppEnv>, dropId: string) {
  const raw = getCookie(c, TICKET_COOKIE) ?? c.req.header("x-wr-ticket")
  if (!raw) return null
  try {
    const t = await verifyTicket(raw)
    return t.dropId === dropId ? t : null
  } catch {
    return null
  }
}

// --- Queue: enter ---------------------------------------------------------
const enqueueRateLimit = ipRateLimit("enqueue", {
  capacity: env.WR_ENQUEUE_RL_CAPACITY,
  refillMs: env.WR_ENQUEUE_RL_REFILL_MS,
})

app.post("/api/:dropId/enqueue", enqueueRateLimit, async (c) => {
  const dropId = c.req.param("dropId")!

  // Anti-bot: one Turnstile challenge per queue entry. This is what neutralizes
  // lottery farming — flooding entries now costs a human/proof challenge each.
  if (turnstileEnabled()) {
    const body = (await c.req.json().catch(() => ({}))) as { turnstileToken?: string }
    const token = body.turnstileToken ?? c.req.header("cf-turnstile-response") ?? ""
    if (!(await verifyTurnstile(token))) {
      return c.json({ error: "turnstile_failed", redirect: `/drop/${dropId}` }, 403)
    }
  }

  // Idempotent: a valid existing ticket keeps its place.
  const existing = await readTicket(c, dropId)
  const ticketId = existing?.ticketId ?? randomUUID()

  const res = await enqueue(dropId, ticketId)
  const token = await signTicket({ kind: "ticket", dropId, ticketId, seq: res.seq })

  setCookie(c, TICKET_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: false, // dev over http; flip to true behind TLS
    path: "/",
    maxAge: 60 * 60 * 6,
  })
  return c.json({ ticketId, position: res.position, ticket: token })
})

// --- Queue: poll ----------------------------------------------------------
app.get("/api/:dropId/status", async (c) => {
  const dropId = c.req.param("dropId")
  const ticket = await readTicket(c, dropId)
  if (!ticket) return c.json({ state: "unknown" }, 200)

  const status = await getStatus(dropId, ticket.ticketId)
  if (status.state === "admitted") {
    const { sessionTtlSec } = await getDropConfig(dropId)
    const pass = await signPass(
      { kind: "pass", dropId, ticketId: ticket.ticketId },
      sessionTtlSec,
    )
    return c.json({ state: "admitted", pass })
  }
  return c.json(status)
})

// --- Queue: real-time push (SSE) -----------------------------------------
app.get("/api/:dropId/stream", async (c) => {
  const dropId = c.req.param("dropId")
  const ticket = await readTicket(c, dropId)
  if (!ticket) return c.json({ error: "no_ticket" }, 401)

  return streamSSE(c, async (stream) => {
    const send = async () => {
      const status = await getStatus(dropId, ticket.ticketId)
      if (status.state === "admitted") {
        const { sessionTtlSec } = await getDropConfig(dropId)
        const pass = await signPass(
          { kind: "pass", dropId, ticketId: ticket.ticketId },
          sessionTtlSec,
        )
        await stream.writeSSE({ event: "admitted", data: JSON.stringify({ pass }) })
      } else if (status.state === "waiting") {
        await stream.writeSSE({ event: "waiting", data: JSON.stringify(status) })
      }
    }

    await send() // immediate snapshot
    // Push on admission events, and also refresh position periodically.
    const unsub = subscribe(keys.events(dropId), () => void send())
    const interval = setInterval(() => void send(), 5000)
    stream.onAbort(() => {
      clearInterval(interval)
      unsub()
    })
    // Keep the stream open until the client disconnects.
    while (!stream.closed) await stream.sleep(1000)
  })
})

// --- Real site: session upkeep (protected) -------------------------------
app.post("/api/:dropId/heartbeat", requirePass, async (c) => {
  const dropId = c.req.param("dropId")!
  await heartbeat(dropId, c.get("ticketId"))
  return c.body(null, 204)
})

app.post("/api/:dropId/release", requirePass, async (c) => {
  const dropId = c.req.param("dropId")!
  await release(dropId, c.get("ticketId"))
  return c.body(null, 204)
})

/** Demo "real site" route — proves the guard works end to end. */
app.get("/api/:dropId/site", requirePass, (c) =>
  c.json({ ok: true, ticketId: c.get("ticketId"), message: "welcome to the drop" }),
)

// --- Ops admin (bearer token) --------------------------------------------
const requireAdmin = (c: Context<AppEnv>) =>
  (c.req.header("Authorization") ?? "") === `Bearer ${env.WR_ADMIN_TOKEN}`

app.get("/api/:dropId/admin/state", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401)
  const dropId = c.req.param("dropId")
  const [waiting, admitted, config] = await Promise.all([
    cmd.zcard(keys.waiting(dropId)),
    cmd.zcard(keys.admitted(dropId)),
    getDropConfig(dropId),
  ])
  return c.json({ dropId, waiting, active: admitted, config })
})

app.put("/api/:dropId/admin/config", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "unauthorized" }, 401)
  const dropId = c.req.param("dropId")
  const patch = await c.req.json().catch(() => ({}))
  const config = await setDropConfig(dropId, patch)
  return c.json({ config })
})

console.log(`[gate] listening on :${env.WR_GATE_PORT}`)

export default {
  port: env.WR_GATE_PORT,
  fetch: app.fetch,
  idleTimeout: 60,
}
