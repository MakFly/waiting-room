import type { QueueProvider, QueueUpdate } from "./provider"

/** Variant A: our Bun + Hono + Redis gate. SSE for live updates, JWT pass. */
export function createSelfProvider(dropId: string): QueueProvider {
  let es: EventSource | null = null

  return {
    mode: "self",
    supportsLive: true,

    async join(turnstileToken?: string) {
      const r = await fetch(`/api/${dropId}/enqueue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(turnstileToken ? { turnstileToken } : {}),
      })
      if (!r.ok) throw new Error(`enqueue failed: ${r.status}`)
      const s = await r.json()
      return { position: s.position ?? 0 }
    },

    subscribe(onUpdate, onError) {
      es = new EventSource(`/api/${dropId}/stream`)
      es.addEventListener("waiting", (e) => {
        const s = JSON.parse((e as MessageEvent).data)
        onUpdate({ state: "waiting", position: s.position, eta: s.eta })
      })
      es.addEventListener("admitted", (e) => {
        const s = JSON.parse((e as MessageEvent).data)
        onUpdate({ state: "admitted", pass: s.pass })
      })
      es.onerror = () => {
        es?.close()
        onError()
      }
      return () => es?.close()
    },

    async poll(): Promise<QueueUpdate> {
      const r = await fetch(`/api/${dropId}/status`)
      const s = await r.json()
      if (s.state === "admitted") return { state: "admitted", pass: s.pass }
      if (s.state === "waiting") return { state: "waiting", position: s.position, eta: s.eta }
      return { state: "unknown" }
    },

    async enterSite(pass?: string) {
      const r = await fetch(`/api/${dropId}/site`, {
        headers: { Authorization: `Bearer ${pass}` },
      })
      return r.json()
    },
  }
}
