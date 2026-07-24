import { cmd } from "../lib/redis.ts"
import { keys } from "./keys.ts"
import { getDropConfig } from "./config.ts"

export type QueueStatus =
  | { state: "waiting"; position: number; eta: number }
  | { state: "admitted" }
  | { state: "unknown" }

/**
 * Reads a ticket's current standing. Admission is decided by the worker moving
 * tickets from `waiting` to `admitted`; here we only observe the result, so a
 * poll and the worker never race over who admits.
 */
export async function getStatus(dropId: string, ticketId: string): Promise<QueueStatus> {
  const admittedScore = await cmd.zscore(keys.admitted(dropId), ticketId)
  if (admittedScore !== null) return { state: "admitted" }

  const rank = await cmd.zrank(keys.waiting(dropId), ticketId)
  if (rank === null) return { state: "unknown" } // never queued or dropped

  const { ratePerMin } = await getDropConfig(dropId)
  const perSec = Math.max(ratePerMin / 60, 0.001)
  const position = rank + 1
  const eta = Math.ceil(position / perSec) // seconds, coarse estimate

  return { state: "waiting", position, eta }
}
