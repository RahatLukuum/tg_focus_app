import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
// removed lovable-tagger to avoid esbuild issues in some environments

// https://vitejs.dev/config/
// - Tauri: относительные пути ./ (иначе пустой экран в оболочке)
// - nginx в корне домена/IP: base "/" (дефолт)
// - раздача с бэкенда FastAPI на пути /app: задать VITE_BASE=/app/ при сборке
// loadEnv: переменные из .env.production не попадают в process.env при чтении vite.config
function resolveBase(mode: string): string {
  const env = loadEnv(mode, process.cwd(), "");
  if (
    env.VITE_TAURI ||
    process.env.VITE_TAURI ||
    process.env.TAURI_PLATFORM ||
    process.env.TAURI_ENV_PLATFORM
  ) {
    return "./";
  }
  const fromEnv = (env.VITE_BASE || process.env.VITE_BASE || "").trim();
  if (fromEnv) {
    return fromEnv.endsWith("/") ? fromEnv : `${fromEnv}/`;
  }
  return "/";
}

export default defineConfig(({ mode }) => ({
  base: resolveBase(mode),
  server: {
    host: "::",
    port: 5173,
  },
  plugins: [
    react(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));