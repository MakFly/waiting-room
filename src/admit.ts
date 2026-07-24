import { cmd, pub, closeRedis, pingRedis } from "./lib/redis.ts"
import { keys } from "./queue/keys.ts"
import { getDropConfig } from "./queue/config.ts"

/**
 * Admission worker — the throughput regulator.
 *
 * Occupancy is the size of the `admitted` set (tickets holding a live pass).
 * Each tick we (atomically, in Lua):
 *   1. expire stale passes (self-healing capacity),
 *   2. compute room = capacity - occupancy,
 *   3. refill a token bucket at ratePerMin, take min(tokens, room),
 *   4. ZPOPMIN that many from `waiting` (oldest scores = first served),
 *   5. move them to `admitted` and publish an event.
 *
 * A single Lua call means two ticks (or two workers) can never over-admit past
 * capacity. On top of that, a Redis lock keeps exactly one worker admitting.
 */

const DROP_ID = Bun.env.WR_DROP_ID ?? "default"
const TICK_MS = 2000
const INSTANCE_ID = `${process.pid}-${Bun.nanoseconds()}`
const LOCK_TTL_MS = 5000

// KEYS: waiting, admitted, rate(bucket hash), events channel
// ARGV: capacity, ratePerMin, now(ms), ttlSec
const ADMIT = `
local waitingKey  = KEYS[1]
local admittedKey = KEYS[2]
local rateKey     = KEYS[3]
local eventsChan  = KEYS[4]

local capacity   = tonumber(ARGV[1])
local ratePerMin = tonumber(ARGV[2])
local now        = tonumber(ARGV[3])
local ttlMs      = tonumber(ARGV[4]) * 1000

-- 1. Expire stale passes so freed slots come back.
redis.call('ZREMRANGEBYSCORE', admittedKey, '-inf', now - ttlMs)

-- 2. Room left.
local occ  = redis.call('ZCARD', admittedKey)
local room = capacity - occ

-- 3. Refill the bucket (burst = one minute of throughput).
local bcap        = ratePerMin
local refillPerMs = ratePerMin / 60000.0
local state       = redis.call('HMGET', rateKey, 'tokens', 'updatedAt')
local tokens      = tonumber(state[1])
local updatedAt   = tonumber(state[2])
if tokens == nil or updatedAt == nil then
  tokens = bcap
  updatedAt = now
end
local elapsed = now - updatedAt
if elapsed < 0 then elapsed = 0 end
tokens = math.min(bcap, tokens + elapsed * refillPerMs)

-- 4. Allowance is the tighter of throughput and free room.
local allowance = math.floor(math.min(tokens, room))
if allowance < 0 then allowance = 0 end

if allowance <= 0 then
  redis.call('HSET', rateKey, 'tokens', tokens, 'updatedAt', now)
  redis.call('PEXPIRE', rateKey, ttlMs)
  return {}
end

-- 5. Pop the oldest 'allowance' waiters and admit them.
local popped = redis.call('ZPOPMIN', waitingKey, allowance)
local admittedIds = {}
local i = 1
while i <= #popped do
  local ticketId = popped[i]           -- popped = {member, score, member, score, ...}
  redis.call('ZADD', admittedKey, now, ticketId)
  redis.call('PUBLISH', eventsChan, '{"type":"admitted","ticketId":"' .. ticketId .. '"}')
  table.insert(admittedIds, ticketId)
  i = i + 2
end

tokens = tokens - (#admittedIds)
redis.call('HSET', rateKey, 'tokens', tokens, 'updatedAt', now)
redis.call('PEXPIRE', rateKey, ttlMs)

return admittedIds
`

/** Acquire-or-renew the singleton admission lock. Returns true if we hold it. */
const LOCK = `
local key = KEYS[1]
local id  = ARGV[1]
local ttl = tonumber(ARGV[2])
local cur = redis.call('GET', key)
if cur == false or cur == id then
  redis.call('SET', key, id, 'PX', ttl)
  return 1
end
return 0
`

async function tick(dropId: string = DROP_ID): Promise<void> {
  const held = (await cmd.eval(
    LOCK,
    1,
    keys.admitLock(dropId),
    INSTANCE_ID,
    String(LOCK_TTL_MS),
  )) as number
  if (held !== 1) return // another worker is the admitter

  const cfg = await getDropConfig(dropId)
  const now = Date.now()
  const admitted = (await cmd.eval(
    ADMIT,
    4,
    keys.waiting(dropId),
    keys.admitted(dropId),
    keys.rate(dropId),
    keys.events(dropId),
    String(cfg.capacity),
    String(cfg.ratePerMin),
    String(now),
    String(cfg.sessionTtlSec),
  )) as string[]

  if (admitted.length > 0) {
    console.log(`[admit] drop=${dropId} admitted=${admitted.length}`)
  }
}

async function main(): Promise<void> {
  if (!(await pingRedis())) {
    console.error("[admit] Redis unreachable")
    process.exit(1)
  }
  console.log(`[admit] worker ${INSTANCE_ID} drop=${DROP_ID} tick=${TICK_MS}ms`)

  let running = true
  const stop = async () => {
    running = false
    await closeRedis()
    process.exit(0)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)

  while (running) {
    try {
      await tick(DROP_ID)
    } catch (e) {
      console.error("[admit] tick error", (e as Error).message)
    }
    await Bun.sleep(TICK_MS)
  }
}

// Only run the loop when executed directly (not when imported by tests).
if (import.meta.main) void main()

export { tick, ADMIT, LOCK }
export { pub }
