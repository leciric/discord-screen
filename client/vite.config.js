import { defineConfig } from 'vite';
import { LOCAL_PADRAO, LOCAL_WS_PADRAO } from '../shared/porta.js';

export default defineConfig({
  // O .env fica na raiz do projeto, não dentro de client/.
  envDir: '..',
  server: {
    port: 5173,
    // Necessário quando o Vite é exposto por um túnel (cloudflared/ngrok).
    allowedHosts: true,
    proxy: {
      '/api': LOCAL_PADRAO,
      '/ws': { target: LOCAL_WS_PADRAO, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
