import type { QueueProvider, QueueUpdate } from "./provider"

/**
 * Variant B: Cloudflare Waiting Room.
 *
 * Cloudflare gates at the edge and manages the `__cf_waitingroom` cookie itself,
 * so there is nothing to "enqueue" and no JWT pass. While a visitor is queued,
 * this app is served as the room's custom page; fetching the same URL with the
 * JSON query returns the room state:
 *
 *   { "cfWaitingRoom": { "inWaitingRoom": true, "waitTime": 10,
 *       "refreshIntervalSeconds": 20, "queueIsFull": false, ... } }
 *
 * Note: for FIFO/random, Cloudflare deliberately does NOT expose an exact queue
 * position — only an estimated wait time. So `position` stays 0 and the UI keys
 * off `eta` (waitTime). When `inWaitingRoom` flips to false, the cookie is set;
 * reloading lets Cloudflare serve the real origin.
 */
type CfRoom = {
  inWaitingRoom: boolean
  waitTime?: number // minutes
  queueIsFull?: boolean
  refreshIntervalSeconds?: number
}

export function createCloudflareProvider(): QueueProvider {
  const jsonUrl = () => {
    const u = new URL(window.location.href)
    u.searchParams.set("waitingroom_json", "1")
    return u.toString()
  }

  async function fetchRoom(): Promise<CfRoom | null> {
    const r = await fetch(jsonUrl(), { cache: "no-store" })
    // Once admitted, the edge serves the origin (HTML), not JSON.
    const ct = r.headers.get("content-type") ?? ""
    if (!ct.includes("application/json")) return null
    const body = await r.json()
    return (body.cfWaitingRoom ?? null) as CfRoom | null
  }

  return {
    mode: "cloudflare",
    supportsLive: false, // Cloudflare has no push channel — poll only.

    async join() {
      // Merely landing on the URL enrolls the visitor (edge sets the cookie).
      return { position: 0 }
    },

    subscribe() {
      return () => {}
    },

    async poll(): Promise<QueueUpdate> {
      const room = await fetchRoom()
      if (!room || room.inWaitingRoom === false) return { state: "admitted" }
      return { state: "waiting", position: 0, eta: Math.round((room.waitTime ?? 0) * 60) }
    },

    async enterSite() {
      // The CF cookie is set; reloading serves the real origin. In a demo without
      // Cloudflare in front, return a synthetic payload instead of reloading.
      const realUrl = import.meta.env.VITE_WR_REAL_URL as string | undefined
      if (realUrl) {
        window.location.assign(realUrl)
        return { redirected: true }
      }
      return { ok: true, provider: "cloudflare", message: "edge admitted — cookie set" }
    },
  }
}
