import { cmd } from "../lib/redis.ts"
import { defaultDropConfig, type DropConfig } from "../lib/config.ts"
import { keys } from "./keys.ts"

/**
 * Per-drop config lives in a Redis hash so ops can retune a live drop. The
 * first read seeds it from process defaults; later writes (admin route) win.
 */
export async function getDropConfig(dropId: string): Promise<DropConfig> {
  const h = await cmd.hgetall(keys.config(dropId))
  if (!h || Object.keys(h).length === 0) {
    await seedDropConfig(dropId)
    return { ...defaultDropConfig }
  }
  return {
    capacity: num(h.capacity, defaultDropConfig.capacity),
    ratePerMin: num(h.ratePerMin, defaultDropConfig.ratePerMin),
    sessionTtlSec: num(h.sessionTtlSec, defaultDropConfig.sessionTtlSec),
    method: h.method === "lottery" ? "lottery" : "fifo",
  }
}

async function seedDropConfig(dropId: string): Promise<void> {
  // NX-style seed: only set fields that are missing, never clobber ops edits.
  await cmd.hsetnx(keys.config(dropId), "capacity", defaultDropConfig.capacity)
  await cmd.hsetnx(keys.config(dropId), "ratePerMin", defaultDropConfig.ratePerMin)
  await cmd.hsetnx(keys.config(dropId), "sessionTtlSec", defaultDropConfig.sessionTtlSec)
  await cmd.hsetnx(keys.config(dropId), "method", defaultDropConfig.method)
}

export async function setDropConfig(
  dropId: string,
  patch: Partial<DropConfig>,
): Promise<DropConfig> {
  const fields: Record<string, string | number> = {}
  if (patch.capacity !== undefined) fields.capacity = patch.capacity
  if (patch.ratePerMin !== undefined) fields.ratePerMin = patch.ratePerMin
  if (patch.sessionTtlSec !== undefined) fields.sessionTtlSec = patch.sessionTtlSec
  if (patch.method !== undefined) fields.method = patch.method
  if (Object.keys(fields).length > 0) await cmd.hset(keys.config(dropId), fields)
  return getDropConfig(dropId)
}

function num(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number(v)
  return Number.isFinite(n) ? n : fallback
}
