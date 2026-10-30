import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // FH: a proxy to :3000 would avoid the CORS/cookie dance, claude suggested it
  server: {
    port: 5173,
    // Optional: run with VITE_API_BASE_URL= to stay same-origin through this proxy.
    // Otherwise the API's CORS allowlist (CORS_ALLOWED_ORIGINS) admits this port.
    proxy: { "/v1": "http://localhost:3000" },
  },
});
