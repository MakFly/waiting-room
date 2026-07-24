import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "node:path"

// Proxy /api to the gate so the browser stays same-origin: cookies (wr_ticket)
// and SSE both work without CORS.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
})
