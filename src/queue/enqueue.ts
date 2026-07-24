import { cmd } from "../lib/redis.ts"
import { env } from "../lib/config.ts"
import { keys } from "./keys.ts"
import { getDropConfig } from "./config.ts"

export type EnqueueResult = {
  ticketId: string
  seq: number
  /** 1-based position among waiters at enqueue time. */
  position: number
}

/**
 * Places a ticket in the queue.
 *
 * For `lottery`, the ZSET score is a real-time window bucket + random jitter, so
 * everyone who arrives within the same window is shuffled together — being a few
 * milliseconds earlier buys no advantage, and per-IP rate limiting caps how many
 * lottery entries one client can farm. For `fifo`, the score is the sequence.
 *
 * The whole thing is one Lua script so the INCR and the ZADD cannot interleave
 * with a concurrent enqueue and hand out a duplicate position.
 */
const ENQUEUE = `
local seqKey     = KEYS[1]
local waitingKey = KEYS[2]
local ticketId   = ARGV[1]
local method     = ARGV[2]
local jitter     = tonumber(ARGV[3])
local windowBkt  = tonumber(ARGV[4])

-- Idempotency: an existing member keeps its score (its place).
local existing = redis.call('ZSCORE', waitingKey, ticketId)
if existing then
  local rank = redis.call('ZRANK', waitingKey, ticketId)
  return { -1, rank }             -- -1 seq sentinel = "already queued"
end

local seq = redis.call('INCR', seqKey)
local score
if method == 'lottery' then
  -- Time-window bucket keeps windows ordered; jitter shuffles within a window.
  score = windowBkt * 1000000 + jitter
else
  score = seq
end
redis.call('ZADD', waitingKey, score, ticketId)
local rank = redis.call('ZRANK', waitingKey, ticketId)
return { seq, rank }
`

export async function enqueue(
  dropId: string,
  ticketId: string,
  now: number = Date.now(),
): Promise<EnqueueResult> {
  const { method } = await getDropConfig(dropId)
  // Jitter is generated here (Lua has no RNG we want to rely on across nodes).
  const jitter = Math.floor(Math.random() * 1_000_000)
  const windowBucket = Math.floor(now / env.WR_LOTTERY_WINDOW_MS)
  const [seq, rank] = (await cmd.eval(
    ENQUEUE,
    2,
    keys.seq(dropId),
    keys.waiting(dropId),
    ticketId,
    method,
    String(jitter),
    String(windowBucket),
  )) as [number, number]

  return { ticketId, seq: seq < 0 ? 0 : seq, position: rank + 1 }
}
