import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // backend API (server/): `cd server && npm run dev`
    proxy: {
      "/api": "http://127.0.0.1:8787"
    }
  },
  build: {
    rollupOptions: {
      input: "frontend.html"
    }
  }
});
