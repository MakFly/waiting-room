/**
 * Queue provider abstraction — lets the same UI run behind either gatekeeper:
 *   - "self"       : variant A (Bun + Hono + Redis), SSE + REST.
 *   - "cloudflare" : variant B (Cloudflare Waiting Room), JSON polling at the edge.
 *
 * The mode is picked at build time via VITE_WR_MODE, so switching A↔B is a config
 * change, not a code change. `useQueue` only ever talks to this interface.
 */
export type QueueUpdate =
  | { state: "waiting"; position: number; eta: number }
  | { state: "admitted"; pass?: string }
  | { state: "unknown" }

export interface QueueProvider {
  readonly mode: "self" | "cloudflare"
  /** True when the provider can push updates; false ⇒ the hook polls instead. */
  readonly supportsLive: boolean
  /** Enter the queue. Returns the initial position (0 when unknown, e.g. CF). */
  join(): Promise<{ position: number }>
  /** Live channel. No-op (returns a no-op unsub) when !supportsLive. */
  subscribe(onUpdate: (u: QueueUpdate) => void, onError: () => void): () => void
  /** One-shot status read, used for the polling fallback and for CF. */
  poll(): Promise<QueueUpdate>
  /** Redeem admission on the real site. `pass` is only present in self mode. */
  enterSite(pass?: string): Promise<unknown>
}

export type QueueMode = "self" | "cloudflare"

export function currentMode(): QueueMode {
  return (import.meta.env.VITE_WR_MODE as QueueMode) === "cloudflare" ? "cloudflare" : "self"
}
