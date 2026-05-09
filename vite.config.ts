import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
    build: {
      chunkSizeWarningLimit: 2000,
    },
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          name: 'Ghana Health AI',
          short_name: 'HealthAI',
          theme_color: '#0d9488',
          icons: [
            {
              src: 'https://cdn-icons-png.flaticon.com/512/3063/3063822.png',
              sizes: '192x192',
              type: 'image/png',
            },
            {
              src: 'https://cdn-icons-png.flaticon.com/512/3063/3063822.png',
              sizes: '512x512',
              type: 'image/png',
            },
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
});
