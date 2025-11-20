import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
// removed lovable-tagger to avoid esbuild issues in some environments

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  // For Tauri packaged builds, use relative assets to avoid blank screen.
  // We check explicit VITE_TAURI (set from tauri.conf beforeBuildCommand) or TAURI_* envs.
  base: (process.env.VITE_TAURI || process.env.TAURI_PLATFORM || process.env.TAURI_ENV_PLATFORM)
    ? './'
    : (mode === 'production' ? '/app/' : '/'),
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