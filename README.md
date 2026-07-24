# Waiting Room — file d'attente virtuelle pour drops à forte demande

> Salle d'attente virtuelle (virtual waiting room) qui empêche un site de tomber
> pendant un drop : la foule est mise en file et admise à un **débit contrôlé**,
> calibré sur la capacité réelle du site — comme le font Cloudflare Waiting Room
> ou Queue-it, mais que tu héberges toi-même.

`Bun` · `Hono` · `Redis` · `React` · `Vite` · `Tailwind` · `shadcn/ui` · `jose (JWT)` · `Terraform` · `Cloudflare` · `k6`

File d'attente qui protège un site à forte demande (drop de stock limité) en
n'admettant les visiteurs qu'à un **débit contrôlé** calibré sur la capacité
réelle du site. Deux variantes **interchangeables** derrière **la même UI** :

- **Variante A** — self-hosted **Bun + Hono + Redis** (on maîtrise tout).
- **Variante B** — managée **Cloudflare Waiting Room** (file au edge).

On bascule de l'une à l'autre via une seule variable (`VITE_WR_MODE`), sans
toucher au code. Spec complète : voir [`PRD.md`](./PRD.md).

```
                       ┌───────────────── UI (React + Vite + Tailwind + shadcn) ──────────────┐
                       │  useQueue(dropId) → QueueProvider (agnostique)                        │
                       │        ├── selfProvider        (VITE_WR_MODE=self)        ── Variante A│
                       │        └── cloudflareProvider  (VITE_WR_MODE=cloudflare)  ── Variante B│
                       └──────────────────────────────────────────────────────────────────────┘
  Variante A: Bun gate (:8787) + admit worker + Redis (infra-redis, prefix wr:)
  Variante B: Cloudflare edge (Terraform) devant l'origine
```

## Prérequis
- Bun ≥ 1.3
- Variante A : `infra-redis` joignable sur `localhost:6379` (aucune nouvelle infra Docker)
- Variante B : un compte Cloudflare (zone active, plan Business+), Terraform

---

## Variante A — Bun + Hono + Redis

### Setup
```bash
cp .env.example .env       # ajuster WR_JWT_SECRET / WR_ADMIN_TOKEN en prod
bun install
```

### Lancer (2 process)
```bash
WR_DROP_ID=sneaker-drop bun run gate    # gatekeeper HTTP  :8787
WR_DROP_ID=sneaker-drop bun run admit   # worker d'admission (débit, singleton via lock Redis)
```

### Flux (curl)
```bash
B=http://localhost:8787 D=sneaker-drop
curl -s -c c.txt -X POST $B/api/$D/enqueue                  # → { position, ticket }  (cookie wr_ticket)
curl -s -b c.txt $B/api/$D/status                           # → waiting | { admitted, pass }
curl -s -H "Authorization: Bearer <pass>" $B/api/$D/site    # route "site réel" protégée
```

### Modèle
- **Occupation = taille du set `admitted`** (porteurs d'un pass vivant). Admission
  bornée par `capacity`, jamais dépassée (garanti par un unique script Lua).
- **Débit** : token bucket Lua à `ratePerMin` (burst = 1 min).
- **Expiration** : `ZREMRANGEBYSCORE` auto-répare la capacité ; `release` libère tôt.
- **Anti-triche** : ticket + pass signés (`jose`, HS256). `require-pass` vérifie
  le JWT **et** l'appartenance à `admitted` (révocation immédiate au release).
- **Équité** : `method=lottery` mélange les arrivées d'une **fenêtre temporelle**
  (aucun avantage à être quelques ms plus tôt ; anti-spam refresh).
- **Anti-bot** : **rate-limit par IP** sur `/enqueue` (token bucket Lua) qui plafonne
  le nombre de tickets qu'un client peut créer → pas de farming de tickets lottery.
- **Isolation Redis** : toutes les clés sous le préfixe `wr:` (jamais `pulseops:*`).

### Réglage à chaud (ops)
```bash
curl -s -H "Authorization: Bearer $WR_ADMIN_TOKEN" $B/api/$D/admin/state
curl -s -X PUT -H "Authorization: Bearer $WR_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"capacity":1000,"ratePerMin":300}' $B/api/$D/admin/config
```

---

## Variante B — Cloudflare Waiting Room

La file est appliquée **au edge**, devant l'origine. L'origine (le « site réel »,
qui peut rester le service Bun/Hono) n'a **aucune logique de file** à gérer.

```bash
cd infra/cloudflare
cp terraform.tfvars.example terraform.tfvars   # renseigner token / zone / host
terraform init
terraform apply
```

Les deux boutons (`total_active_users` = C, `new_users_per_minute` = λ) et la page
d'attente (`waiting.html`, même esthétique, poll du JSON) sont dans `infra/cloudflare/`.
Réglage à chaud : `terraform apply` avec de nouvelles valeurs, ou l'API Cloudflare.

---

## Basculer A ↔ B (UI)

L'UI est identique dans les deux modes ; seul le provider change.

```bash
cd web
cp .env.example .env
# VITE_WR_MODE=self        → Variante A (SSE + REST, position exacte)
# VITE_WR_MODE=cloudflare  → Variante B (poll JSON edge, temps d'attente estimé)
bun install
bun run dev                # http://localhost:5173  (proxy /api → :8787 en mode self)
```

En mode `self`, le front parle au gate Bun via le proxy Vite (cookies + SSE
same-origin). En mode `cloudflare`, il poll l'endpoint `?waitingroom_json=1` servi
par l'edge (Cloudflare ne divulgue pas la position exacte, seulement un ETA — l'UI
s'adapte et affiche le temps d'attente).

---

## Calibrer la capacité `C` — test de charge k6

Le débit n'est pas un chiffre magique : `C` se **mesure** sur le vrai point de
rupture du site réel, et `ratePerMin ≈ C / durée_de_session` (loi de Little).

**1) Trouver C** — on rampe la charge sur le **site réel** (pas la file) et on
regarde où p99 / taux d'erreur décrochent. Le genou moins ~30-40 % de marge = C.
```bash
TARGET=https://shop.exemple.com/checkout k6 run load/k6-capacity.js
# le plus haut palier VU où http_req_duration p99 < budget et http_req_failed ≈ 0 → C
```

**2) Vérifier que la file tient** — on simule une foule (2000 visiteurs) sur le
gate (variante A) : chacun enqueue puis poll jusqu'à admission.
```bash
BASE=http://localhost:8787 DROP=sneaker-drop k6 run load/k6-flashcrowd.js
# pendant le run, l'occupation ne doit jamais dépasser capacity :
curl -H "Authorization: Bearer $WR_ADMIN_TOKEN" \
  http://localhost:8787/api/sneaker-drop/admin/state
```

> Le goulot réel est souvent le **pool de connexions Postgres** ou le **rate-limit
> du prestataire de paiement**, pas le CPU. Calibre `C` sur ce goulot.

---

## Tests
```bash
bun test    # tokens, idempotence enqueue, "jamais > capacity", release, status
```

## Structure
```
src/            # Variante A (backend) : gate.ts, admit.ts, queue/, lib/, middleware/
web/            # UI React/Vite/Tailwind/shadcn + queue/ providers (self | cloudflare)
infra/cloudflare/  # Variante B : Terraform + waiting.html
load/           # k6 : k6-capacity.js (calibrer C) · k6-flashcrowd.js (charge file)
PRD.md          # spec produit complète (A et B)
```

---

## Mots-clés / topics (SEO)

Virtual waiting room · file d'attente virtuelle · queue system · traffic surge ·
flash sale · product drop · sneaker drop · ticketing queue · rate limiting ·
token bucket · admission control · backpressure · Little's Law · Redis queue ·
Bun · Hono · Server-Sent Events (SSE) · Cloudflare Waiting Room · Terraform ·
React · Tailwind · shadcn/ui · load testing · k6 · DDoS-resilient · self-hosted.

**Repo description (une ligne)** :
> Self-hosted virtual waiting room for high-demand drops — Bun + Hono + Redis with
> a Cloudflare Waiting Room alternative behind the same React UI. Rate-controlled
> admission, JWT passes, SSE, load-tested with k6.

**Topics GitHub suggérés** : `waiting-room` `queue` `rate-limiting` `bun` `hono`
`redis` `sse` `cloudflare` `terraform` `react` `tailwindcss` `shadcn-ui` `k6`
`load-testing` `admission-control` `token-bucket` `flash-sale` `self-hosted`.

