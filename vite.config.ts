import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// COOP/COEP headers are required for SharedArrayBuffer which DuckDB-WASM uses.
export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  build: {
    // Our bundle is dominated by @duckdb/duckdb-wasm (~300 kB). The app is a
    // single-page desktop-style tool that loads once and is cached, so the
    // default 500 kB warning threshold is unhelpful noise.
    chunkSizeWarningLimit: 800,
  },
})
