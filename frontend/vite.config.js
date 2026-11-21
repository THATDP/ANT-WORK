import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  resolve: {
    alias: {
      '@shared': path.resolve(root, '../shared'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // o preview roda em um domínio próprio (e2b.app); não bloqueie o host
    allowedHosts: true,
    strictPort: true,
    // permite importar o código compartilhado (terreno determinístico)
    fs: { allow: [path.resolve(root, '..')] },
    proxy: {
      // Em desenvolvimento o frontend fala com o backend pela mesma origem,
      // evitando problemas de CORS e de preview remoto.
      '/socket.io': { target: process.env.VITE_PROXY_TARGET || 'http://localhost:8080', ws: true, changeOrigin: true },
      '/api': { target: process.env.VITE_PROXY_TARGET || 'http://localhost:8080', changeOrigin: true },
      '/health': { target: process.env.VITE_PROXY_TARGET || 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: { phaser: ['phaser'] },
      },
    },
  },
});
