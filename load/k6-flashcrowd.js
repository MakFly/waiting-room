import http from "k6/http"
import { check, sleep } from "k6"
import { Counter } from "k6/metrics"

// Simulate a flash crowd hitting the QUEUE (variant A). Each VU enqueues, then
// polls until admitted — exactly what real visitors do. Verifies the gate holds
// under a burst and that admission is paced (not everyone let in at once).
//
//   BASE=http://localhost:8787 DROP=sneaker-drop k6 run load/k6-flashcrowd.js
//
// Then check the gate never exceeds capacity:
//   curl -H "Authorization: Bearer $WR_ADMIN_TOKEN" $BASE/api/$DROP/admin/state

const BASE = __ENV.BASE || "http://localhost:8787"
const DROP = __ENV.DROP || "sneaker-drop"

const admitted = new Counter("admitted_visitors")

export const options = {
  scenarios: {
    crowd: { executor: "per-vu-iterations", vus: 2000, iterations: 1, maxDuration: "3m" },
  },
}

export default function () {
  // 1) Enter the queue — the gate hands back a ticket cookie via the jar.
  const jar = http.cookieJar()
  const enq = http.post(`${BASE}/api/${DROP}/enqueue`)
  check(enq, { enqueued: (r) => r.status === 200 })
  void jar

  // 2) Poll until admitted (or give up after a bounded number of tries).
  for (let i = 0; i < 60; i++) {
    const s = http.get(`${BASE}/api/${DROP}/status`)
    const body = s.json()
    if (body && body.state === "admitted") {
      admitted.add(1)
      // 3) Redeem the pass on the protected route.
      const site = http.get(`${BASE}/api/${DROP}/site`, {
        headers: { Authorization: `Bearer ${body.pass}` },
      })
      check(site, { "entered site": (r) => r.status === 200 })
      return
    }
    sleep(2)
  }
}
