/**
 * Every key lives under `wr:` so this standalone service never collides with
 * pulseops' own `pulseops:*` namespace on the shared `infra-redis` instance.
 */
const ns = (dropId: string) => `wr:${dropId}`

export const keys = {
  /** INCR counter → monotonic arrival number (FIFO ordering source). */
  seq: (d: string) => `${ns(d)}:seq`,
  /** ZSET: member=ticketId, score=arrival position. The queue order. */
  waiting: (d: string) => `${ns(d)}:waiting`,
  /** ZSET: member=ticketId, score=admittedAt(ms). Drives session expiry. */
  admitted: (d: string) => `${ns(d)}:admitted`,
  /** Count of active users on the real site (heartbeat-maintained). */
  active: (d: string) => `${ns(d)}:active`,
  /** Token-bucket state for admission throughput (rate limiter). */
  rate: (d: string) => `${ns(d)}:rate`,
  /** Hash: capacity, ratePerMin, sessionTtlSec, method. Hot-tunable. */
  config: (d: string) => `${ns(d)}:config`,
  /** Singleton lock for the admission worker. */
  admitLock: (d: string) => `${ns(d)}:admit:lock`,
  /** Idempotency marker for enqueue, per ticket. */
  dedup: (d: string, ticketId: string) => `${ns(d)}:dedup:${ticketId}`,
  /** Pub/sub channel for real-time fanout (admitted / position updates). */
  events: (d: string) => `${ns(d)}:events`,
  /** Per-IP rate-limit bucket for a given scope (e.g. enqueue). */
  ratelimit: (scope: string, key: string) => `wr:rl:${scope}:${key}`,
} as const
