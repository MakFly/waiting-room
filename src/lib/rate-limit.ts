import { cmd } from "./redis.ts"
import { keys } from "../queue/keys.ts"

/**
 * A per-key token bucket in Redis (one take per call), same shape as the
 * admission bucket: a full read-modify-write in a single Lua script so two
 * requests racing on the same key cannot both spend the last token.
 *
 * `now` is injectable so tests can drive the clock without sleeping.
 */
const TAKE = `
local capacity    = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local now         = tonumber(ARGV[3])
local ttlMs       = tonumber(ARGV[4])

local state     = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAt')
local tokens    = tonumber(state[1])
local updatedAt = tonumber(state[2])
if tokens == nil or updatedAt == nil then
  tokens = capacity
  updatedAt = now
end

local elapsed = now - updatedAt
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + elapsed * refillPerMs)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'updatedAt', now)
redis.call('PEXPIRE', KEYS[1], ttlMs)
return allowed
`

export type RateLimit = {
  /** Bucket size = max burst. */
  capacity: number
  /** Milliseconds to fully refill an empty bucket. */
  refillMs: number
}

/** Returns true if the request is allowed (a token was available). */
export async function takeToken(
  scope: string,
  key: string,
  limit: RateLimit,
  now: number = Date.now(),
): Promise<boolean> {
  const refillPerMs = limit.capacity / limit.refillMs
  const allowed = (await cmd.eval(
    TAKE,
    1,
    keys.ratelimit(scope, key),
    String(limit.capacity),
    String(refillPerMs),
    String(now),
    String(limit.refillMs),
  )) as number
  return allowed === 1
}
