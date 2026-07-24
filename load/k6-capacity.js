import http from "k6/http"
import { check } from "k6"

// Calibrate C — ramp load against the REAL SITE (not the queue) and watch where
// p99 latency / error rate decrings past your SLO. That knee, minus ~30-40%
// margin, is your `capacity`. Point TARGET at the real origin, NOT the gate.
//
//   TARGET=https://shop.exemple.com/checkout k6 run load/k6-capacity.js
//
// Read the summary: the highest VU stage where http_req_duration p99 stays
// under your budget and http_req_failed stays ~0 is your safe C.

const TARGET = __ENV.TARGET || "http://localhost:8787/health"

export const options = {
  stages: [
    { duration: "30s", target: 100 },
    { duration: "30s", target: 250 },
    { duration: "30s", target: 500 },
    { duration: "30s", target: 750 },
    { duration: "30s", target: 1000 },
    { duration: "20s", target: 0 },
  ],
  thresholds: {
    // Your SLO — the run "passes" only while the origin stays healthy.
    http_req_duration: ["p(99)<800"],
    http_req_failed: ["rate<0.01"],
  },
}

export default function () {
  const res = http.get(TARGET)
  check(res, { "status 2xx": (r) => r.status >= 200 && r.status < 300 })
}
