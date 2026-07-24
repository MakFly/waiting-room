import { cmd } from "../lib/redis.ts"
import { keys } from "./keys.ts"

/** True while the ticket still holds a live pass (present in `admitted`). */
export async function isAdmitted(dropId: string, ticketId: string): Promise<boolean> {
  return (await cmd.zscore(keys.admitted(dropId), ticketId)) !== null
}

/**
 * Keep a browsing user counted as occupying a slot. `XX` refreshes only an
 * existing member, so a heartbeat can never silently re-admit an evicted one.
 */
export async function heartbeat(dropId: string, ticketId: string): Promise<boolean> {
  const res = await cmd.zadd(keys.admitted(dropId), "XX", "GT", Date.now(), ticketId)
  return res !== null
}

/** Free a slot the instant a user leaves, instead of waiting for TTL. */
export async function release(dropId: string, ticketId: string): Promise<void> {
  await cmd.zrem(keys.admitted(dropId), ticketId)
}
