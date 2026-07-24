# PRD — Virtual Waiting Room (file d'attente pour drops à forte demande)

> **Statut** : Draft v1 · **Auteur** : (à compléter) · **Date** : 2026-07-24
> **Périmètre** : projet **Bun standalone** dans `sandbox/waiting-room/`, réutilisant l'instance Redis partagée (`infra-redis`) déjà provisionnée par `pulseops`.
> **Deux variantes, spécifiées au même niveau** :
> - **Partie 1 — Variante A** : file self-hosted **Bun + Hono + Redis** (on maîtrise tout).
> - **Partie 2 — Variante B** : file managée **Cloudflare Waiting Room** (déléguée au edge).

---

## 0. TL;DR

Lors d'un « drop » (stock limité, forte demande simultanée), on protège le site réel (panier, paiement, base de données) en **découplant** la foule du service en aval via une **salle d'attente virtuelle**. Un composant léger et scalable encaisse tout le monde, attribue un **ticket signé**, garde l'**ordre**, et n'**admet** les visiteurs qu'à un **débit contrôlé** calibré sur la capacité réelle du site. À l'admission, on remet un **laissez-passer signé (JWT)** que le site réel vérifie à chaque requête.

---

## 1. Contexte & problème

- Le site protégé a une **capacité finie** : `C` utilisateurs actifs simultanés (limité par la base, le paiement, le stock…).
- Un drop provoque un **pic** : `P` visiteurs (`P >> C`) en quelques secondes.
- Sans régulation : saturation base/paiement, timeouts, survente, expérience dégradée pour tous.

**Contraintes de l'environnement (existant réutilisé)**
- **Redis partagé** : conteneur `infra-redis`, `REDIS_URL=redis://infra-redis:6379`, réseau Docker `dev-shared-net`. **Pas de nouvelle infra Docker.**
- **Runtime : Bun** (package manager + runtime + TS natif) pour ce nouveau service standalone.
- Patterns déjà éprouvés dans `pulseops` qu'on **réutilise conceptuellement** :
  - `apps/api/src/rate-limit.ts` → `RedisTokenBucket` (token bucket atomique via **script Lua**). Namespace `pulseops:rl:*`.
  - `apps/api/src/bus.ts` → `EventBus` (**pub/sub Redis** pour fanout SSE temps réel).
  - `jose` déjà utilisé pour la signature JWT.
- **Isolation des clés** : le service utilise son **propre préfixe** `wr:` pour ne jamais entrer en collision avec `pulseops:*`.

---

## 2. Objectifs & non-objectifs

### 2.1 Objectifs (Goals)
- **G1** — Empêcher toute saturation du site réel : jamais plus de `C` utilisateurs actifs admis.
- **G2** — File **équitable** et **résistante aux bots** (pas d'avantage au spam de refresh).
- **G3** — **Anti-triche** : impossible de sauter la file ou de forger un ticket/laissez-passer.
- **G4** — UX claire : position, ETA, progression, reconnexion transparente.
- **G5** — Scalabilité horizontale de la file elle-même sans double admission.
- **G6** — Réutiliser l'**infra Redis existante** ; runtime **Bun** ; **zéro nouveau conteneur**.

### 2.2 Non-objectifs (Non-goals)
- Pas de gestion du **catalogue / paiement / stock** (c'est le site réel, hors scope).
- Pas d'authentification métier (la file est **anonyme** ; le compte se fait après admission).
- Pas de multi-région active/active pour la variante A (edge = variante B).
- Pas de file par SKU multiple en v1 (une file logique par « événement de drop », extensible).

---

## 3. Métriques de succès

| Métrique | Cible v1 |
|---|---|
| Utilisateurs actifs simultanés sur le site réel | ≤ `C` (jamais dépassé) |
| p99 latence `POST /enqueue` | < 50 ms |
| p99 latence `GET /status` (poll) | < 30 ms |
| Débit d'admission respecté | ± 5 % de `new_users_per_minute` |
| Tickets/laissez-passer forgés acceptés | 0 |
| Perte de position après reconnexion | 0 (ticket persistant) |
| Capacité d'encaissement de la file | ≥ 50 000 visiteurs en attente |

---

## 4. Personas & user stories

- **Acheteur pressé** : « Je veux savoir ma position et le temps d'attente estimé, et être admis automatiquement sans rafraîchir. »
- **Bot / scalper** : « Je spamme l'entrée pour rafler les premières places. » → doit être **neutralisé** (lottery + rate-limit).
- **Ops** : « Je veux régler la capacité et le débit à chaud, et voir l'état de la file en temps réel. »
- **Dev site réel** : « Je veux juste vérifier un laissez-passer signé, sans gérer la foule. »

**Stories clés**
1. En tant que visiteur, quand j'arrive sur `/drop`, je reçois un **ticket** et je vois **ma position**.
2. En tant que visiteur, quand c'est mon tour, je suis **admis automatiquement** (poll/SSE) et redirigé.
3. En tant que visiteur, si je recharge la page, je **garde ma position** (ticket en cookie signé).
4. En tant qu'ops, je **change la capacité/débit** sans redéploiement.
5. En tant que dev, une route protégée **rejette** toute requête sans laissez-passer valide.

---

## 5. Architecture générale (commune aux 2 variantes)

Le principe est identique ; seule l'**implémentation du gatekeeper** change.

```
   Foule (P visiteurs)                     Débit contrôlé (≤ C actifs)
        │                                          │
        ▼                                          ▼
 ┌───────────────┐   ticket signé   ┌──────────────────────────┐
 │  GATEKEEPER   │◀───────────────▶ │      SITE RÉEL           │
 │ (léger,       │   laissez-passer │  panier / paiement /     │
 │  scalable)    │─────────────────▶│  base (capacité finie)   │
 │  - ordre      │                  │  vérifie le laissez-passer│
 │  - débit      │                  └──────────────────────────┘
 └───────────────┘
   A = Bun+Redis        B = Cloudflare edge
```

**Cycle de vie d'un visiteur (état)** :

```
     enqueue                 admission (débit)            pass émis
 ─────────────▶ [WAITING] ───────────────────▶ [ADMITTED] ──────────▶ [ACTIVE]
                    │                               │                     │
                    │ poll/SSE: position, eta       │ /status renvoie pass│ pass expiré
                    ▼                               ▼                     ▼
              (garde le ticket)               (JWT 15 min)           [EXPIRED] → renvoi file
```

---

# PARTIE 1 — VARIANTE A : Bun + Hono + Redis (self-hosted)

## A.1 Vue d'ensemble

```
sandbox/waiting-room/
├── package.json            # Bun; scripts: bun run gate | admit | dev
├── bunfig.toml
├── tsconfig.json
├── .env                    # REDIS_URL (→ infra-redis), secrets JWT
├── src/
│   ├── gate.ts             # Hono app servi par Bun.serve (enqueue + status + pass verify)
│   ├── admit.ts            # worker d'admission (débit contrôlé) — process séparé, singleton
│   ├── queue/
│   │   ├── keys.ts         # conventions de clés Redis (prefix wr:)
│   │   ├── enqueue.ts      # INCR seq + ZADD waiting (idempotent par ticket)
│   │   ├── status.ts       # position / eta / admitted?
│   │   └── lottery.ts      # option: fenêtre aléatoire anti-bot
│   ├── lib/
│   │   ├── redis.ts        # client ioredis (marche sous Bun) — 1 pub, 1 sub, 1 cmd
│   │   ├── token.ts        # jose: signTicket/verifyTicket + signPass/verifyPass
│   │   └── config.ts       # zod: env + capacité/débit (surchageable à chaud via Redis)
│   └── middleware/
│       └── require-pass.ts # protège les routes "site réel"
└── web/                    # React + Vite + Tailwind + shadcn (UI d'attente)
    └── src/
        ├── pages/WaitingRoom.tsx
        └── hooks/useQueue.ts   # SSE en priorité, fallback polling
```

**Choix runtime / libs**
- **Runtime** : Bun (`bun run`, TS natif, `bun --watch`). Serveur HTTP via `Bun.serve` + `app.fetch` de **Hono** (`export default { port, fetch: app.fetch }`).
- **Redis** : **ioredis** (fonctionne sous Bun) — on garde ioredis plutôt que `Bun.redis` natif car on a besoin de **`EVAL`/scripts Lua** (admission atomique) et **pub/sub** (fanout SSE), déjà maîtrisés dans `pulseops`.
- **Signature** : **jose** (JWT `EdDSA`/`HS256`) — cohérent avec l'existant.
- **Validation** : **zod**.

## A.2 Modèle de données Redis (prefix `wr:`)

Une file logique par événement de drop, identifiée par `dropId`.

| Clé | Type | Rôle |
|---|---|---|
| `wr:{dropId}:seq` | String (INCR) | Compteur atomique → numéro d'arrivée (FIFO). |
| `wr:{dropId}:waiting` | ZSET | Membres = `ticketId`, score = position d'arrivée. **L'ordre.** |
| `wr:{dropId}:admitted` | ZSET | Tickets admis, score = `admittedAt` (ms). Sert au TTL/expiration. |
| `wr:{dropId}:cursor` | String | Nb total admis (borne haute de la fenêtre d'admission). |
| `wr:{dropId}:active` | String | Compteur d'actifs sur le site réel (heartbeat, TTL). |
| `wr:{dropId}:config` | Hash | `capacity`, `ratePerMin`, `sessionTtlSec`, `method` (fifo/lottery). Réglable à chaud. |
| `wr:{dropId}:dedup:{ticketId}` | String (TTL) | Idempotence de `/enqueue`. |

> **Note d'implémentation** : `active` est incrémenté à l'entrée sur le site réel et décrémenté à la sortie / expiration du pass. `admit.ts` n'admet un nouveau lot **que si** `active < capacity` **et** que le token bucket de débit l'autorise. Double garde = jamais > `C`.

## A.3 Algorithme d'admission (le cœur)

Deux régulateurs combinés :

1. **Débit** (vitesse d'entrée) : token bucket `wr:{dropId}:rate` → `ratePerMin` tickets/min. **Réutilise le pattern Lua atomique** de `pulseops/apps/api/src/rate-limit.ts` (`RedisTokenBucket`), transposé sous prefix `wr:`.
2. **Capacité** (plafond d'actifs) : n'admettre que `min(bucketAllowance, capacity - active)`.

```
admit.ts (process singleton, tick toutes les TICK_MS = 2000ms):

  loop every TICK_MS:
    active   = GET wr:{drop}:active
    room     = capacity - active                # places libres sur le site réel
    allowed  = tokenBucket.take(room)           # borné aussi par le débit/min
    if allowed <= 0: continue
    # ZPOPMIN retire atomiquement les N plus petits scores = premiers arrivés
    popped   = ZPOPMIN wr:{drop}:waiting allowed
    for t in popped:
       ZADD wr:{drop}:admitted now t            # marque admis (score=now → TTL)
       INCRBY wr:{drop}:cursor 1
       PUBLISH wr:{drop}:events {type:"admitted", ticketId:t}   # fanout SSE
```

**Singleton obligatoire** : un seul `admit.ts` doit tourner (sinon double admission). Garde-fou : **lock Redis** (`SET wr:{drop}:admit:lock <instanceId> NX PX 5000`, renouvelé) → seul le détenteur admet. Si le service scale, les autres instances ne font que `gate.ts`.

**Expiration des laissez-passer** : un balayage périodique retire de `admitted` les tickets dont `score + sessionTtlSec < now` et décrémente `active` (défense en profondeur ; le pass JWT expire de toute façon côté vérification).

## A.4 Sécurité & équité

- **Ticket** (`jose`) : JWT signé `{ dropId, ticketId, seq, iat }`, posé en cookie `wr_ticket` **HttpOnly + Secure + SameSite=Lax**. Non modifiable côté client.
- **Laissez-passer** (`jose`) : JWT court `{ dropId, ticketId, exp: now+sessionTtl }`. Le **site réel** le vérifie via `require-pass.ts`. Pas de pass valide → 403 + redirect `/drop`.
- **Idempotence** : `/enqueue` avec un `wr_ticket` déjà valide → renvoie le **même** ticket (pas de nouvelle place). Clé `wr:{drop}:dedup:{ticketId}`.
- **Anti-bot / fairness** (`lottery.ts`, optionnel mais recommandé pour un vrai drop) :
  - Fenêtre d'admission aléatoire : au lieu d'un FIFO strict qui récompense le refresh rapide, on regroupe les arrivées d'une **fenêtre** (ex. 2 s) et on **mélange** via un score dérivé de `hash(ip + fenêtre + secret)`. Un bot qui spamme n'obtient pas d'avantage.
  - **Rate-limit par IP** sur `/enqueue` (token bucket, réutilise le pattern existant) pour couper le spam.
- **Pas de secrets côté client** : positions/ETA sont dérivées serveur ; le client ne voit qu'un JWT opaque.

## A.5 Contrat d'API (Hono / `gate.ts`)

| Méthode | Route | Description | Réponse |
|---|---|---|---|
| `POST` | `/api/:dropId/enqueue` | Entre en file (idempotent). Pose cookie `wr_ticket`. | `{ ticketId, position }` |
| `GET` | `/api/:dropId/status` | Poll : état courant. | `waiting` → `{ state, position, eta }` · `admitted` → `{ state, pass }` |
| `GET` | `/api/:dropId/stream` | SSE : push `position`/`admitted` (via `EventBus` pub/sub). | `text/event-stream` |
| `POST` | `/api/:dropId/heartbeat` | (site réel) maintient `active` vivant. | `204` |
| `POST` | `/api/:dropId/release` | (site réel) libère une place (fin de session). | `204` |
| `GET` | `/api/:dropId/admin/state` | (ops, protégé) état de la file. | `{ waiting, active, cursor, config }` |
| `PUT` | `/api/:dropId/admin/config` | (ops, protégé) change `capacity`/`ratePerMin` à chaud. | `{ config }` |

**Exemple `/status`** :
```jsonc
// waiting
{ "state": "waiting", "position": 45231, "eta": 742 }   // eta en secondes
// admitted
{ "state": "admitted", "pass": "eyJhbGciOiJFZERTQSJ9..." }
```

**Calcul ETA** : `eta ≈ position / (ratePerMin / 60)` (débit effectif), lissé et borné.

## A.6 Frontend (React + Vite + Tailwind + shadcn)

- **`useQueue.ts`** : ouvre **SSE** en priorité (`/stream`), fallback **polling** `/status` toutes les 5 s si SSE indisponible. Sur `admitted` → stocke le `pass`, redirige vers le site réel avec `Authorization: Bearer <pass>`.
- **`WaitingRoom.tsx`** : composants shadcn — `Card`, `Progress` (position/total), badge de position, ETA formatée, état de connexion, animation d'attente. Accessibilité (aria-live sur la position).
- **Vérif navigateur** (CLAUDE.md) : après build UI, valider le flux principal via Chrome DevTools MCP (`navigate_page`, `take_snapshot`, `list_console_messages`) et capture d'écran de preuve.

## A.7 Configuration / env

```dotenv
# .env (waiting-room) — réutilise l'infra existante
REDIS_URL=redis://infra-redis:6379      # même instance que pulseops, prefix wr: pour isoler
WR_JWT_SECRET=<gen>                       # HS256, ou paire Ed25519 pour EdDSA
WR_GATE_PORT=8787
WR_DEFAULT_CAPACITY=500                   # C — utilisateurs actifs max
WR_DEFAULT_RATE_PER_MIN=200               # débit d'admission
WR_SESSION_TTL_SEC=900                    # 15 min de validité du pass
WR_QUEUE_METHOD=lottery                   # fifo | lottery
```

> Le service tourne **hors Docker** (Bun local) mais se connecte au conteneur `infra-redis`. Si Bun tourne sur l'hôte, utiliser `redis://localhost:6379` (port publié) ; s'il tourne dans le réseau `dev-shared-net`, `redis://infra-redis:6379`. **Point de vérif au démarrage** (voir Open Questions Q1).

## A.8 Observabilité & modes de défaillance

| Panne | Effet | Mitigation |
|---|---|---|
| Redis down | File indisponible | `infra-redis` avec persistance (AOF) ; page « réessayez » ; le site réel reste protégé (fail-closed). |
| `admit.ts` crashe | Plus d'admission | Lock à TTL → une autre instance reprend ; alerte. |
| Double `admit` | Sur-admission | Lock Redis `NX PX` (singleton strict). |
| Client déconnecté | Perte SSE | Fallback polling + ticket persistant (reprise sans perte de place). |
| Horloges désynchro | ETA fausse | ETA serveur uniquement ; token bucket clampe `elapsed >= 0` (comme l'existant). |

Métriques exposées (log/pino) : taille `waiting`, `active`, débit réel admis/min, taux d'erreur `/enqueue`, latences p50/p99.

## A.9 Tests (Bun test)

- **Unitaires** : token/`jose` (sign/verify, rejet forgé, expiration), calcul position/ETA, idempotence enqueue.
- **Admission (intégration Redis)** : jamais > `capacity` actifs ; débit ≈ `ratePerMin` ; ZPOPMIN respecte l'ordre ; lottery redistribue.
- **Concurrence** : N clients enqueue en parallèle → positions uniques et contiguës ; deux `admit` concurrents avec lock → un seul admet.
- **E2E** : enqueue → poll → admitted → accès route protégée OK ; sans pass → 403.

## A.10 Jalons (Milestones A)

1. **M1 — Squelette** : projet Bun, `redis.ts`, `keys.ts`, `config` (zod), health check Redis.
2. **M2 — File** : `enqueue` + `status` (position/ETA), tickets `jose`, idempotence.
3. **M3 — Admission** : `admit.ts` (token bucket Lua + capacité + lock singleton), `admitted`.
4. **M4 — Pass & protection** : `signPass`/`require-pass`, heartbeat/release, expiration.
5. **M5 — Temps réel** : SSE via `EventBus` pub/sub, fallback polling.
6. **M6 — UI** : `WaitingRoom.tsx` shadcn + `useQueue`, vérif navigateur.
7. **M7 — Anti-bot** : lottery + rate-limit IP, admin config à chaud.
8. **M8 — Tests & charge** : jeu de tests + test de charge (k6/autocannon) validant les cibles §3.

---

# PARTIE 2 — VARIANTE B : Cloudflare Waiting Room (managed edge)

## B.1 Vue d'ensemble

Ici la logique de file est **interceptée au edge Cloudflare**, *avant* d'atteindre l'origine. On n'écrit quasiment **aucune logique de file** : on **configure** une règle et on **habille** la page d'attente.

```
                 ┌──────────────────────────────────────────┐
  Visiteurs ────▶│  Cloudflare Edge (300+ POPs)             │
                 │  Waiting Room rule on host+path /drop*    │
                 │  - total_active_users     = C             │──┐ sous le seuil
                 │  - new_users_per_minute   = ratePerMin    │  │ → passe direct
                 │  - queueing_method        = random|fifo   │  │
                 │  - cookie __cf_waitingroom (pass signé CF)│  │
                 └───────────────┬──────────────────────────┘  │
                     file pleine │                              ▼
                                 ▼                     ┌──────────────────┐
                    ┌─────────────────────────┐        │  ORIGINE          │
                    │ Custom Waiting Page (edge)│       │  site réel        │
                    │ + JSON endpoint:          │       │  (aucune logique  │
                    │   position, eta, refresh  │       │   de file à gérer)│
                    └─────────────────────────┘        └──────────────────┘
```

**Ce qui change vs A** : l'origine (qui peut rester un service Bun/Hono) **ne voit jamais la foule**. Pas de Redis, pas de worker d'admission, pas de tickets à gérer — Cloudflare signe et gère le cookie `__cf_waitingroom`.

## B.2 Pré-requis

- Domaine géré par **Cloudflare** (zone active), plan **Business ou Enterprise** (Waiting Room est un add-on payant).
- L'origine (le « site réel ») accessible derrière Cloudflare (proxied `orange-cloud`).
- **Tension avec l'infra actuelle** (self-hosted Redis + Caddy) : la variante B suppose que le trafic passe **par Cloudflare**. À traiter comme une **cible d'évolution edge**, activable indépendamment de A (voir Open Questions Q2).

## B.3 Configuration (Terraform — infra as code)

```hcl
resource "cloudflare_waiting_room" "drop" {
  zone_id               = var.zone_id
  name                  = "product-drop"
  host                  = "shop.exemple.com"
  path                  = "/drop"                 # URLs protégées
  total_active_users    = 500                     # = C
  new_users_per_minute  = 200                     # = débit d'admission
  queueing_method       = "random"                # random (anti-bot) | fifo | reject | passthrough
  session_duration      = 15                       # minutes (= validité du "pass")
  json_response_enabled = true                     # → on construit notre UI custom
  custom_page_html      = file("${path.module}/waiting.html")
  disable_session_renewal_on_reload = false
}
```

Réglages **à chaud** : modifier `total_active_users` / `new_users_per_minute` via Terraform apply ou l'API Cloudflare, sans toucher à l'origine.

## B.4 Le seul code à écrire : l'UI d'attente

Cloudflare expose un **endpoint JSON** sur la page d'attente. On sert une page statique (React/Vite/Tailwind/shadcn buildée, ou HTML simple) qui **poll** ce JSON et rend une belle UI cohérente avec A.

```html
<!-- waiting.html (servi par CF au edge) -->
<script>
async function poll() {
  const r = await fetch(location.pathname + "?waitingroom_json=1", { cache: "no-store" });
  const s = await r.json();               // { cfWaitingRoom: { inWaitingRoom, queueIsFull,
                                          //   estimatedQueuedSeconds, refreshIntervalSeconds, ... } }
  render(s.cfWaitingRoom);
  if (!s.cfWaitingRoom.inWaitingRoom) location.reload();   // ton tour → reload → passe à l'origine
  else setTimeout(poll, (s.cfWaitingRoom.refreshIntervalSeconds || 20) * 1000);
}
poll();
</script>
```

Le cookie `__cf_waitingroom` (laissez-passer signé par CF) est **géré automatiquement** par le edge. L'origine peut, si besoin, vérifier via l'API Cloudflare le statut de la room, mais **n'a rien à implémenter**.

## B.5 Où va le monorepo Bun dans la variante B

- **Origine (« site réel »)** : service **Bun + Hono** — **zéro logique de file**. Déployable tel quel derrière Cloudflare, ou sur **Cloudflare Workers**.
- **UI d'attente** : le même design system shadcn que A, buildé en statique, référencé par `custom_page_html` (ou hébergé sur **Cloudflare Pages** / Workers Assets).
- Réutilisation maximale : **une seule UI** d'attente, deux back-ends (A ou B).

## B.6 Sécurité / équité (fournies par CF)

- Signature du pass : **gérée par Cloudflare** (cookie signé, non forgeable).
- Équité anti-bot : `queueing_method = "random"` (recommandé pour drops).
- Bots/DDoS : bénéficie du **WAF + protection DDoS** Cloudflare en amont (avantage majeur vs A).

## B.7 Observabilité

- **Analytics Waiting Room** natifs (Cloudflare Dashboard/API) : nb en file, temps d'attente estimé, taux d'admission.
- Alerting via notifications Cloudflare.

## B.8 Jalons (Milestones B)

1. **M1** — Zone Cloudflare + origine proxied (site réel Bun/Hono derrière CF).
2. **M2** — Ressource `cloudflare_waiting_room` (Terraform), seuils `C`/débit.
3. **M3** — Page d'attente custom (UI shadcn partagée) + JSON polling.
4. **M4** — `queueing_method=random`, WAF/rate-limit devant `/drop`.
5. **M5** — Test de charge (trafic simulé) + validation analytics.

---

## 6. Comparatif A vs B (aide à la décision)

| Critère | **A — Bun + Redis** | **B — Cloudflare WR** |
|---|---|---|
| Contrôle | Total (lottery custom, VIP, règles métier) | Config only |
| Effort d'implémentation | Élevé (worker, lock, anti-bot, SSE) | Très faible |
| Scalabilité de la file | Limitée par Redis/infra | Illimitée (edge) |
| Origine voit la foule ? | **Oui** (encaisse le polling/SSE) | **Non** (protégée au edge) |
| Réutilise `infra-redis` | **Oui** | Non (edge) |
| Coût | Infra Redis existante | Add-on payant (Business+) |
| Protection DDoS/WAF | À ajouter | Incluse |
| Idéal pour | Maîtrise totale, apprentissage, on-prem | Drop massif en prod, zéro réinvention |

**Recommandation** : livrer **A** d'abord (maîtrise + réutilisation de l'existant), garder **B** comme option edge activable pour les drops à très fort volume, en **réutilisant la même UI shadcn** et la même origine Bun/Hono.

---

## 7. Questions ouvertes (à trancher avant implémentation)

- **Q1 — Réseau Redis** : Bun tourne-t-il sur l'hôte (→ `redis://localhost:6379`, port `infra-redis` publié ?) ou dans `dev-shared-net` (→ `redis://infra-redis:6379`) ? À confirmer au M1.
- **Q2 — Variante B & Caddy** : le trafic prod passe-t-il (ou passera-t-il) par Cloudflare, ou reste-t-on 100 % self-hosted (Caddy) ? B suppose Cloudflare en frontal.
- **Q3 — Multi-drop** : une seule file logique en v1, ou plusieurs `dropId` concurrents dès le départ ?
- **Q4 — Signature** : HS256 (secret partagé) suffisant, ou EdDSA (paire de clés) pour découpler la vérif côté site réel ?
- **Q5 — Définition d'« actif »** : basé sur heartbeat du site réel, ou simple TTL du pass ? (impacte la précision de `capacity`).
- **Q6 — Où vit le « site réel »** de démo pour tester A de bout en bout ? (route protégée factice dans `waiting-room/` ou dans `pulseops` ?)

---

## 8. Annexe — Primitives existantes réutilisées

- **Token bucket atomique** : `pulseops/apps/api/src/rate-limit.ts` (`RedisTokenBucket`, script Lua `EVAL`, clamp `elapsed >= 0`, namespace `pulseops:rl:*`). → transposé en `wr:{drop}:rate` pour le **débit d'admission**.
- **Pub/sub fanout** : `pulseops/apps/api/src/bus.ts` (`EventBus`, 1 conn pub + 1 conn sub, async iterable). → base du **SSE** `/stream` (`wr:{drop}:events`).
- **jose** : signature/vérification JWT déjà en place → tickets + laissez-passer.
- **Redis** : `infra-redis` (`redis://infra-redis:6379`, `dev-shared-net`), **prefix `wr:` dédié** pour isolation stricte de `pulseops:*`.
