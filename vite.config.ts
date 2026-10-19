import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { scriptRunner } from './vite/scriptRunner'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), scriptRunner()],
  server: {
    host: true,
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
})
