import { describe, expect, it, beforeAll, afterAll } from "bun:test"
import { cmd, closeRedis } from "../src/lib/redis.ts"
import { keys } from "../src/queue/keys.ts"
import { enqueue } from "../src/queue/enqueue.ts"
import { getStatus } from "../src/queue/status.ts"
import { setDropConfig } from "../src/queue/config.ts"
import { isAdmitted, release } from "../src/queue/session.ts"
import { signTicket, verifyTicket, signPass, verifyPass } from "../src/lib/token.ts"
import { takeToken } from "../src/lib/rate-limit.ts"
import { tick } from "../src/admit.ts"
import { randomUUID } from "node:crypto"

// A dedicated drop id keeps the test isolated from any real `wr:` data.
const DROP = `test-${randomUUID().slice(0, 8)}`

async function flush() {
  const ks = await cmd.keys(`wr:${DROP}:*`)
  if (ks.length) await cmd.del(...ks)
}

beforeAll(async () => {
  await flush()
})

afterAll(async () => {
  await flush()
  await closeRedis()
})

describe("tokens", () => {
  it("round-trips a ticket and rejects a forged one", async () => {
    const t = await signTicket({ kind: "ticket", dropId: DROP, ticketId: "x", seq: 1 })
    expect((await verifyTicket(t)).ticketId).toBe("x")
    await expect(verifyTicket(t + "tampered")).rejects.toThrow()
  })

  it("rejects an expired pass", async () => {
    const p = await signPass({ kind: "pass", dropId: DROP, ticketId: "x" }, 0)
    await Bun.sleep(1100)
    await expect(verifyPass(p)).rejects.toThrow()
  })
})

describe("enqueue", () => {
  it("assigns contiguous positions and is idempotent per ticket", async () => {
    const a = await enqueue(DROP, "a")
    const b = await enqueue(DROP, "b")
    expect(a.position).toBe(1)
    expect(b.position).toBe(2)
    // Re-enqueue keeps the place, does not append.
    const aAgain = await enqueue(DROP, "a")
    expect(aAgain.position).toBe(1)
  })
})

describe("admission never exceeds capacity", () => {
  it("admits only up to capacity and frees a slot on release", async () => {
    await flush()
    await setDropConfig(DROP, { capacity: 2, ratePerMin: 600, sessionTtlSec: 900 })
    for (const id of ["v1", "v2", "v3", "v4", "v5"]) await enqueue(DROP, id)

    await tick(DROP) // one admission pass

    const active = await cmd.zcard(keys.admitted(DROP))
    const waiting = await cmd.zcard(keys.waiting(DROP))
    expect(active).toBe(2) // capped at capacity
    expect(waiting).toBe(3)

    // Release one admitted slot → next tick admits exactly one more.
    const admittedIds = await cmd.zrange(keys.admitted(DROP), 0, -1)
    await release(DROP, admittedIds[0]!)
    await tick(DROP)

    expect(await cmd.zcard(keys.admitted(DROP))).toBe(2)
    expect(await cmd.zcard(keys.waiting(DROP))).toBe(2)
  })
})

describe("rate limit", () => {
  it("allows a burst up to capacity then blocks, and refills over time", async () => {
    const key = `ip-${randomUUID().slice(0, 8)}`
    const limit = { capacity: 3, refillMs: 3000 } // 1 token/sec
    const t0 = 1_000_000

    // Burst of 3 allowed, 4th blocked (clock frozen at t0).
    expect(await takeToken("test", key, limit, t0)).toBe(true)
    expect(await takeToken("test", key, limit, t0)).toBe(true)
    expect(await takeToken("test", key, limit, t0)).toBe(true)
    expect(await takeToken("test", key, limit, t0)).toBe(false)

    // One second later, exactly one token has refilled.
    expect(await takeToken("test", key, limit, t0 + 1000)).toBe(true)
    expect(await takeToken("test", key, limit, t0 + 1000)).toBe(false)
  })
})

describe("status", () => {
  it("reports admitted once a ticket holds a slot", async () => {
    await flush()
    await setDropConfig(DROP, { capacity: 10, ratePerMin: 600 })
    await enqueue(DROP, "s1")
    expect((await getStatus(DROP, "s1")).state).toBe("waiting")
    await tick(DROP)
    expect(await isAdmitted(DROP, "s1")).toBe(true)
    expect((await getStatus(DROP, "s1")).state).toBe("admitted")
  })
})
