import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev proxy mirrors nginx in the Docker stack: it injects the operator credential
// server-side (so the browser bundle never holds a token) and does not forward the
// role-agent interfaces at all.
const operatorToken = process.env.BAYORA_TOKEN_OPERATOR ?? "dev-operator-token";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: process.env.BAYORA_DEV_API ?? "http://127.0.0.1:8000", // override to point at another local API
        headers: { Authorization: `Bearer ${operatorToken}` },
        bypass: (req) => (/^\/api\/(red|blue|target)\//.test(req.url ?? "") ? false : undefined),
      },
    },
  },
  // three.js lives in the lazily loaded LatticeCanvas chunk (~250 kB gzip), off the critical path.
  build: { chunkSizeWarningLimit: 1000 },
});
