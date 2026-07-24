import { useEffect, useRef } from "react"

// Minimal typings for the Turnstile global we load at runtime.
type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: { sitekey: string; action?: string; callback: (token: string) => void; "error-callback"?: () => void },
  ) => string
  remove: (id: string) => void
}
declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let scriptPromise: Promise<void> | null = null
function loadTurnstileScript(): Promise<void> {
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise((resolve) => {
    const s = document.createElement("script")
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    document.head.appendChild(s)
  })
  return scriptPromise
}

/** Renders a Cloudflare Turnstile widget and hands the token back on success. */
export function Turnstile({ sitekey, onVerify }: { sitekey: string; onVerify: (token: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const widgetId = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadTurnstileScript().then(() => {
      if (cancelled || !ref.current || !window.turnstile) return
      widgetId.current = window.turnstile.render(ref.current, {
        sitekey,
        action: "turnstile-spin-v1", // Spin telemetry marker
        callback: (token) => onVerify(token),
      })
    })
    return () => {
      cancelled = true
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current)
      widgetId.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sitekey])

  return <div ref={ref} className="flex justify-center" />
}
