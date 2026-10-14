import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// base: './' keeps every asset path relative, so the build works on GitHub Pages
// (https://<user>.github.io/<repo>/) or any other static host without changes.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: '旅遊行程規劃',
        short_name: '行程規劃',
        description: '依天安排行程、候選景點、地圖路線與 AI 討論',
        lang: 'zh-TW',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#f6f5f2',
        theme_color: '#0f766e',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
});
