import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(import.meta.dirname, "../.."), "");
  const apiTarget = `http://127.0.0.1:${env.KALKI_SERVER_PORT || "8788"}`;

  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        "/api": apiTarget,
        "/healthz": apiTarget,
      },
    },
  };
});
