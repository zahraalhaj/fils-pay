import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // apps/web already owns 5173.
    // 5174 clashes with storybook on my machine — am
    port: 5174,
    // Optional: run with VITE_ADMIN_API_BASE_URL= to stay same-origin through this proxy.
    // Otherwise the API's CORS allowlist (CORS_ALLOWED_ORIGINS) admits this port.
    proxy: { "/v1": "http://localhost:3000" },
  },
});
