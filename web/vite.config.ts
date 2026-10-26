import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `npm run dev:web` serves the panel from Vite's port and proxies /api to the server on 4321.
// The server only accepts its own Host and rejects POSTs from a foreign Origin, so the proxy
// rewrites Host (changeOrigin) and drops the browser's Origin header.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4321',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin'))
        },
      },
    },
  },
})
