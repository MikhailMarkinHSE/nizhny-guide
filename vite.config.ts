import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // ... ваши настройки PWA ...
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,geojson,json,mjs}'],
        // Возможно, потребуется исключить воркер из кэширования
        navigateFallbackDenylist: [/^\/maplibre-gl-worker/],
      },
    }),
  ],
  optimizeDeps: {
    exclude: ['maplibre-gl'],
    esbuildOptions: {
      target: 'es2022',
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
  },
});