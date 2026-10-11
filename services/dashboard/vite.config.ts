import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` proxies the API to a gateway reachable at GATEWAY (default: the local cluster).
const target = process.env.GATEWAY ?? "http://gateway.localtest.me";
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target, changeOrigin: true }, "/mcp": { target, changeOrigin: true } } },
});
