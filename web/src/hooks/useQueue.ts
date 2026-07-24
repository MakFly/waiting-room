import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createProvider, currentMode, type QueueMode, type QueueUpdate } from "@/queue"

export type QueuePhase = "challenge" | "joining" | "waiting" | "admitted" | "entered" | "error"

export type QueueState = {
  phase: QueuePhase
  mode: QueueMode // "self" | "cloudflare" — lets the UI adapt (CF has no exact position)
  position: number
  eta: number
  /** 0..100 progress toward the front, estimated from the worst position seen. */
  progress: number
  live: boolean // true while a push channel is connected (self mode only)
  site?: unknown // payload returned by the protected route once entered
  error?: string
}

// Turnstile gates enqueue in self mode when a sitekey is configured.
const SITEKEY = import.meta.env.VITE_WR_TURNSTILE_SITEKEY as string | undefined
const NEEDS_TURNSTILE = currentMode() === "self" && !!SITEKEY

export type UseQueue = QueueState & {
  retry: () => void
  /** Present when a Turnstile challenge must be solved before joining. */
  sitekey?: string
  /** Called by the UI with the Turnstile token to proceed with enqueue. */
  solve: (token: string) => void
}

/**
 * Drives one visitor through the queue for `dropId`, against whichever provider
 * VITE_WR_MODE selects (variant A self-hosted, or variant B Cloudflare):
 *   [challenge] → join → live updates (or polling) → redeem on the real site.
 */
export function useQueue(dropId: string): UseQueue {
  const provider = useMemo(() => createProvider(dropId), [dropId])
  const initialState: QueueState = useMemo(
    () => ({
      phase: NEEDS_TURNSTILE ? "challenge" : "joining",
      mode: currentMode(),
      position: 0,
      eta: 0,
      progress: 0,
      live: false,
    }),
    [],
  )

  const [state, setState] = useState<QueueState>(initialState)
  const initialPos = useRef<number>(0)
  const unsubRef = useRef<() => void>(() => {})
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Once admitted we stop all polling/streaming; closing a stream fires onError,
  // so this guards against that resurrecting a background poll loop.
  const settled = useRef(false)

  const patch = useCallback((p: Partial<QueueState>) => setState((s) => ({ ...s, ...p })), [])

  const computeProgress = useCallback((pos: number) => {
    initialPos.current = Math.max(initialPos.current, pos)
    const start = initialPos.current
    if (start <= 1) return 100
    return Math.max(0, Math.min(100, Math.round(((start - pos) / (start - 1)) * 100)))
  }, [])

  const stopChannels = useCallback(() => {
    unsubRef.current()
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const enterSite = useCallback(
    async (pass?: string) => {
      try {
        const site = await provider.enterSite(pass)
        patch({ phase: "entered", progress: 100, site })
      } catch {
        patch({ phase: "error", error: "Impossible d'accéder au site après admission." })
      }
    },
    [patch, provider],
  )

  const onAdmitted = useCallback(
    (pass?: string) => {
      settled.current = true
      stopChannels()
      patch({ phase: "admitted", live: false })
      void enterSite(pass)
    },
    [enterSite, patch, stopChannels],
  )

  const apply = useCallback(
    (u: QueueUpdate) => {
      if (u.state === "admitted") onAdmitted(u.pass)
      else if (u.state === "waiting")
        patch({ phase: "waiting", position: u.position, eta: u.eta, progress: computeProgress(u.position) })
    },
    [computeProgress, onAdmitted, patch],
  )

  const startPolling = useCallback(() => {
    if (pollRef.current || settled.current) return
    patch({ live: false })
    pollRef.current = setInterval(async () => {
      try {
        apply(await provider.poll())
      } catch {
        /* transient; keep polling */
      }
    }, 5000)
  }, [apply, patch, provider])

  // Enter the queue. In self+Turnstile mode a token is required.
  const join = useCallback(
    async (turnstileToken?: string) => {
      initialPos.current = 0
      settled.current = false
      patch({ phase: "joining" })
      try {
        const { position } = await provider.join(turnstileToken)
        patch({ phase: "waiting", position, progress: computeProgress(position) })
        if (provider.supportsLive) {
          patch({ live: true })
          unsubRef.current = provider.subscribe(apply, startPolling)
        } else {
          startPolling()
          void provider.poll().then(apply).catch(() => {})
        }
      } catch {
        patch({ phase: "error", error: "Échec de l'entrée en file." })
      }
    },
    [apply, computeProgress, patch, provider, startPolling],
  )

  // Reset to the starting phase: a challenge to solve, or straight to join.
  const start = useCallback(() => {
    stopChannels()
    setState(initialState)
    initialPos.current = 0
    settled.current = false
    if (!NEEDS_TURNSTILE) void join()
  }, [initialState, join, stopChannels])

  useEffect(() => {
    start()
    return stopChannels
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropId])

  return {
    ...state,
    retry: start,
    sitekey: NEEDS_TURNSTILE ? SITEKEY : undefined,
    solve: (token: string) => void join(token),
  }
}
