import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const proxyTarget = process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:8000'
const wsProxyTarget = proxyTarget.replace(/^http/i, 'ws')

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: wsProxyTarget,
        ws: true,
        changeOrigin: true,
      },
      '/uploads': {
        target: proxyTarget,
        changeOrigin: true,
      },
      '/health': {
        target: proxyTarget,
        changeOrigin: true,
      },
      '/docs': {
        target: proxyTarget,
        changeOrigin: true,
      },
      '/openapi.json': {
        target: proxyTarget,
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
