import { z } from "zod"

/**
 * Process-level env. Per-drop knobs (capacity, rate…) start from these defaults
 * but live in a Redis hash so ops can retune a running drop without a redeploy
 * (see queue/config.ts).
 */
const EnvSchema = z.object({
  REDIS_URL: z.string().default("redis://localhost:6379"),
  WR_JWT_SECRET: z.string().min(16),
  WR_GATE_PORT: z.coerce.number().int().positive().default(8787),
  WR_DEFAULT_CAPACITY: z.coerce.number().int().positive().default(500),
  WR_DEFAULT_RATE_PER_MIN: z.coerce.number().int().positive().default(200),
  WR_SESSION_TTL_SEC: z.coerce.number().int().positive().default(900),
  WR_QUEUE_METHOD: z.enum(["fifo", "lottery"]).default("fifo"),
  WR_ADMIN_TOKEN: z.string().min(1),
  // Per-IP rate limit on /enqueue: burst size + full-refill window.
  WR_ENQUEUE_RL_CAPACITY: z.coerce.number().int().positive().default(10),
  WR_ENQUEUE_RL_REFILL_MS: z.coerce.number().int().positive().default(60_000),
  // Lottery time window (ms): arrivals in the same window are shuffled together.
  WR_LOTTERY_WINDOW_MS: z.coerce.number().int().positive().default(2_000),
})

export type Env = z.infer<typeof EnvSchema>

export const env: Env = EnvSchema.parse(Bun.env)

/** Defaults handed to a drop the first time it is seen. */
export const defaultDropConfig = {
  capacity: env.WR_DEFAULT_CAPACITY,
  ratePerMin: env.WR_DEFAULT_RATE_PER_MIN,
  sessionTtlSec: env.WR_SESSION_TTL_SEC,
  method: env.WR_QUEUE_METHOD,
} as const

export type DropConfig = {
  capacity: number
  ratePerMin: number
  sessionTtlSec: number
  method: "fifo" | "lottery"
}
