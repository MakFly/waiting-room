import type { QueueProvider } from "./provider"
import { currentMode } from "./provider"
import { createSelfProvider } from "./selfProvider"
import { createCloudflareProvider } from "./cloudflareProvider"

export type { QueueProvider, QueueUpdate, QueueMode } from "./provider"
export { currentMode } from "./provider"

/** Picks the gatekeeper implementation from VITE_WR_MODE (default: self / variant A). */
export function createProvider(dropId: string): QueueProvider {
  return currentMode() === "cloudflare" ? createCloudflareProvider() : createSelfProvider(dropId)
}
