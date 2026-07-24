import { Redis } from "ioredis"
import { env } from "./config.ts"

/**
 * Three connections, mirroring the pulseops EventBus split: a subscriber
 * connection cannot issue normal commands, so pub/sub gets its own pair and
 * everything else shares `cmd`.
 */
export const cmd = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
export const pub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
export const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })

export async function pingRedis(): Promise<boolean> {
  try {
    return (await cmd.ping()) === "PONG"
  } catch {
    return false
  }
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([cmd.quit(), pub.quit(), sub.quit()])
}
