import { Loader2, CheckCircle2, Users, Clock, Wifi, WifiOff, PartyPopper, ShieldCheck } from "lucide-react"
import { useQueue } from "@/hooks/useQueue"
import { Turnstile } from "@/components/Turnstile"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

const DROP_ID = "sneaker-drop"

function fmtEta(sec: number): string {
  if (sec <= 0) return "quelques instants"
  if (sec < 60) return `~${sec}s`
  const m = Math.floor(sec / 60)
  return `~${m} min`
}

export default function WaitingRoom() {
  const q = useQueue(DROP_ID)

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Salle d'attente</CardTitle>
            {(q.phase === "joining" || q.phase === "waiting") && (
              <Badge variant={q.live ? "default" : "muted"} className="gap-1">
                {q.live ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                {q.live ? "temps réel" : "sondage"}
              </Badge>
            )}
          </div>
          <CardDescription>Drop très demandé — accès régulé pour éviter la saturation.</CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {q.phase === "challenge" && q.sitekey && (
            <div className="space-y-4" aria-live="polite">
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <ShieldCheck className="h-4 w-4" /> Vérification anti-bot avant l'entrée en file
              </div>
              <Turnstile sitekey={q.sitekey} onVerify={q.solve} />
            </div>
          )}

          {q.phase === "joining" && (
            <div className="flex items-center gap-2 text-muted-foreground" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin" /> Entrée en file…
            </div>
          )}

          {q.phase === "waiting" && (
            <div className="space-y-5" aria-live="polite">
              {/* Cloudflare (variant B) does not expose an exact position, only
                  an estimated wait — so we headline the ETA in that mode. */}
              {q.mode === "cloudflare" || q.position <= 0 ? (
                <div className="text-center">
                  <div className="text-sm text-muted-foreground">Temps d'attente estimé</div>
                  <div className="text-5xl font-bold tracking-tight">{fmtEta(q.eta)}</div>
                </div>
              ) : (
                <div className="text-center">
                  <div className="text-sm text-muted-foreground">Votre position</div>
                  <div className="text-5xl font-bold tabular-nums tracking-tight">
                    {q.position.toLocaleString("fr-FR")}
                  </div>
                </div>
              )}
              <Progress value={q.progress} />
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Users className="h-4 w-4" /> {q.progress}% parcouru
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="h-4 w-4" /> {fmtEta(q.eta)}
                </span>
              </div>
              <p className="text-xs text-center text-muted-foreground">
                Gardez cette page ouverte : vous serez admis automatiquement.
              </p>
            </div>
          )}

          {q.phase === "admitted" && (
            <div className="flex items-center gap-2 text-foreground" aria-live="polite">
              <CheckCircle2 className="h-5 w-5" /> C'est votre tour ! Ouverture de l'accès…
            </div>
          )}

          {q.phase === "entered" && (
            <div className="space-y-3 text-center" aria-live="polite">
              <PartyPopper className="h-10 w-10 mx-auto" />
              <div className="text-lg font-semibold">Accès accordé</div>
              <p className="text-sm text-muted-foreground">
                Vous êtes sur le site réel. Réponse de la route protégée :
              </p>
              <pre className="text-left text-xs bg-muted rounded-md p-3 overflow-x-auto">
                {JSON.stringify(q.site, null, 2)}
              </pre>
            </div>
          )}

          {q.phase === "error" && (
            <div className="space-y-3 text-center">
              <p className="text-sm text-muted-foreground">{q.error}</p>
              <Button onClick={q.retry}>Réessayer</Button>
            </div>
          )}
        </CardContent>

        <CardFooter className="justify-center">
          <span className="text-xs text-muted-foreground">
            {q.mode === "cloudflare"
              ? "Powered by Waiting Room · Cloudflare edge (B)"
              : "Powered by Waiting Room · Bun + Redis (A)"}
          </span>
        </CardFooter>
      </Card>
    </div>
  )
}
