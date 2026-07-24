import { sub } from "./redis.ts"

/**
 * Minimal Redis pub/sub fanout over the shared subscriber connection, modeled
 * on pulseops' EventBus: one Redis subscription per channel, ref-counted, with
 * an in-process Set of listeners so many SSE clients share a single channel.
 */
type Listener = (raw: string) => void
const listeners = new Map<string, Set<Listener>>()

sub.on("message", (channel, raw) => {
  const set = listeners.get(channel)
  if (set) for (const fn of set) fn(raw)
})

export function subscribe(channel: string, fn: Listener): () => void {
  let set = listeners.get(channel)
  if (!set) {
    set = new Set()
    listeners.set(channel, set)
    void sub.subscribe(channel)
  }
  set.add(fn)

  return () => {
    const s = listeners.get(channel)
    if (!s) return
    s.delete(fn)
    if (s.size === 0) {
      listeners.delete(channel)
      void sub.unsubscribe(channel)
    }
  }
}
