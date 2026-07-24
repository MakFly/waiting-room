# Waiting Room — virtual queue for high-demand drops

> A virtual waiting room that keeps a site from falling over during a drop: the
> crowd is queued and admitted at a **rate-controlled** pace, calibrated to the
> site's real capacity — like Cloudflare Waiting Room or Queue-it, but self-hosted.

`Bun` · `Hono` · `Redis` · `React` · `Vite` · `Tailwind` · `shadcn/ui` · `jose (JWT)` · `Terraform` · `Cloudflare` · `k6`

A queue that protects a high-demand site (limited-stock drop) by admitting visitors
only at a **controlled throughput** calibrated to the site's real capacity. Two
**interchangeable** variants behind **the same UI**:

- **Variant A** — self-hosted **Bun + Hono + Redis** (full control).
- **Variant B** — managed **Cloudflare Waiting Room** (queue at the edge).

Switch between them with a single variable (`VITE_WR_MODE`), no code change. Full
spec: see [`PRD.md`](./PRD.md).

```
                       ┌───────────────── UI (React + Vite + Tailwind + shadcn) ──────────────┐
                       │  useQueue(dropId) → QueueProvider (agnostic)                          │
                       │        ├── selfProvider        (VITE_WR_MODE=self)        ── Variant A │
                       │        └── cloudflareProvider  (VITE_WR_MODE=cloudflare)  ── Variant B │
                       └──────────────────────────────────────────────────────────────────────┘
  Variant A: Bun gate (:8787) + admit worker + Redis (infra-redis, prefix wr:)
  Variant B: Cloudflare edge (Terraform) in front of the origin
```

## Requirements
- Bun ≥ 1.3
- Variant A: `infra-redis` reachable on `localhost:6379` (no new Docker infra)
- Variant B: a Cloudflare account (active zone, Business+ plan), Terraform

---

## Variant A — Bun + Hono + Redis

### Setup
```bash
cp .env.example .env       # set WR_JWT_SECRET / WR_ADMIN_TOKEN in production
bun install
```

### Run (2 processes)
```bash
WR_DROP_ID=sneaker-drop bun run gate    # HTTP gatekeeper  :8787
WR_DROP_ID=sneaker-drop bun run admit   # admission worker (throughput, singleton via Redis lock)
```

### Flow (curl)
```bash
B=http://localhost:8787 D=sneaker-drop
curl -s -c c.txt -X POST $B/api/$D/enqueue                  # → { position, ticket }  (wr_ticket cookie)
curl -s -b c.txt $B/api/$D/status                           # → waiting | { admitted, pass }
curl -s -H "Authorization: Bearer <pass>" $B/api/$D/site    # protected "real site" route
```

### Model
- **Occupancy = size of the `admitted` set** (holders of a live pass). Admission is
  bounded by `capacity` and never exceeds it (guaranteed by a single Lua script).
- **Throughput**: Lua token bucket at `ratePerMin` (burst = 1 minute).
- **Expiry**: `ZREMRANGEBYSCORE` self-heals capacity; `release` frees a slot early.
- **Anti-tamper**: signed ticket + pass (`jose`, HS256). `require-pass` checks the
  JWT **and** membership in `admitted` (immediate revocation on release).
- **Fairness**: `method=lottery` shuffles arrivals within a **time window** (being a
  few ms earlier gives no edge; anti refresh-spam).
- **Anti-bot**: **per-IP rate limit** on `/enqueue` (Lua token bucket) + optional
  **Cloudflare Turnstile** challenge per queue entry (server-side siteverify). A
  lottery is only fair if each entry is costly — Turnstile is what stops a bot from
  flooding N entries to farm a top position.
- **Redis isolation**: all keys under the `wr:` prefix (never `pulseops:*`).

### Anti-bot: Turnstile (optional)
Set `WR_TURNSTILE_SECRET` on the gate and `VITE_WR_TURNSTILE_SITEKEY` on the web
app to require a Turnstile challenge before every enqueue (self mode; in variant B
Cloudflare handles bots at the edge). The gate verifies the token server-side
against Cloudflare siteverify — the browser never calls siteverify. Cloudflare
test keys let you wire and validate it without a real widget:

| | sitekey (web) | secret (gate) |
|---|---|---|
| always pass | `1x00000000000000000000AA` | `1x0000000000000000000000000000000AA` |
| always block | `2x00000000000000000000AB` | `2x0000000000000000000000000000000AA` |
| force interactive | `3x00000000000000000000FF` | — |

### Hot config (ops)
```bash
curl -s -H "Authorization: Bearer $WR_ADMIN_TOKEN" $B/api/$D/admin/state
curl -s -X PUT -H "Authorization: Bearer $WR_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"capacity":1000,"ratePerMin":300}' $B/api/$D/admin/config
```

---

## Variant B — Cloudflare Waiting Room

The queue is enforced **at the edge**, in front of the origin. The origin (the
"real site", which can stay the Bun/Hono service) has **no queue logic** to run.

```bash
cd infra/cloudflare
cp terraform.tfvars.example terraform.tfvars   # fill in token / zone / host
terraform init
terraform apply
```

The two knobs (`total_active_users` = C, `new_users_per_minute` = λ) and the
waiting page (`waiting.html`, same look, JSON polling) live in `infra/cloudflare/`.
Retune live with a new `terraform apply` or the Cloudflare API.

---

## Switching A ↔ B (UI)

The UI is identical in both modes; only the provider changes.

```bash
cd web
cp .env.example .env
# VITE_WR_MODE=self        → Variant A (SSE + REST, exact position)
# VITE_WR_MODE=cloudflare  → Variant B (edge JSON polling, estimated wait time)
bun install
bun run dev                # http://localhost:5173  (proxies /api → :8787 in self mode)
```

In `self` mode the frontend talks to the Bun gate through the Vite proxy (cookies +
SSE same-origin). In `cloudflare` mode it polls the `?waitingroom_json=1` endpoint
served by the edge (Cloudflare does not expose an exact position, only an ETA — the
UI adapts and shows the wait time).

---

## Calibrating capacity `C` — k6 load test

Throughput is not a magic number: `C` is **measured** at the real site's breaking
point, and `ratePerMin ≈ C / session_duration` (Little's Law).

**1) Find C** — ramp load against the **real site** (not the queue) and watch where
p99 / error rate break past your SLO. The knee minus ~30-40% margin = C.
```bash
TARGET=https://shop.example.com/checkout k6 run load/k6-capacity.js
# highest VU stage where http_req_duration p99 < budget and http_req_failed ≈ 0 → C
```

**2) Verify the queue holds** — simulate a crowd (2000 visitors) against the gate
(variant A): each one enqueues then polls until admitted.
```bash
BASE=http://localhost:8787 DROP=sneaker-drop k6 run load/k6-flashcrowd.js
# during the run, occupancy must never exceed capacity:
curl -H "Authorization: Bearer $WR_ADMIN_TOKEN" \
  http://localhost:8787/api/sneaker-drop/admin/state
```

> The real bottleneck is often the **Postgres connection pool** or the **payment
> provider's rate limit**, not CPU. Calibrate `C` against that bottleneck.

---

## Tests
```bash
bun test    # tokens, enqueue idempotency, never-exceed-capacity, release, status, rate limit
```

## Structure
```
src/            # Variant A (backend): gate.ts, admit.ts, queue/, lib/, middleware/
web/            # React/Vite/Tailwind/shadcn UI + queue/ providers (self | cloudflare)
infra/cloudflare/  # Variant B: Terraform + waiting.html
load/           # k6: k6-capacity.js (calibrate C) · k6-flashcrowd.js (crowd the gate)
PRD.md          # full product spec (A and B)
```

---

## Keywords / topics (SEO)

Virtual waiting room · queue system · traffic surge · flash sale · product drop ·
sneaker drop · ticketing queue · rate limiting · token bucket · admission control ·
backpressure · Little's Law · Redis queue · Bun · Hono · Server-Sent Events (SSE) ·
Cloudflare Waiting Room · Terraform · React · Tailwind · shadcn/ui · load testing ·
k6 · DDoS-resilient · self-hosted.

**Repo description (one-liner)**:
> Self-hosted virtual waiting room for high-demand drops — Bun + Hono + Redis with
> a Cloudflare Waiting Room alternative behind the same React UI. Rate-controlled
> admission, JWT passes, SSE, load-tested with k6.

**Suggested GitHub topics**: `waiting-room` `queue` `rate-limiting` `bun` `hono`
`redis` `sse` `cloudflare` `terraform` `react` `tailwindcss` `shadcn-ui` `k6`
`load-testing` `admission-control` `token-bucket` `flash-sale` `self-hosted`.
