import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// API_ORIGIN lets dev server proxy to a local Go backend; in Docker the built
// app is served by nginx which proxies /api and /healthz to the backend.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: '离线巡检系统',
        short_name: '巡检',
        description: '离线优先的现场巡检记录系统',
        theme_color: '#0f766e',
        background_color: '#0b1220',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      },
      workbox: {
        // Only precache the app shell; inspection data always comes from
        // IndexedDB / the API, never the HTTP cache.
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true
      }
    })
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: process.env.API_ORIGIN || 'http://localhost:8080', changeOrigin: true },
      '/healthz': { target: process.env.API_ORIGIN || 'http://localhost:8080', changeOrigin: true }
    }
  }
});
