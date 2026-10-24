import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The API serves the built portal from roadalyx/web; scripts/deploy.sh packages it into the Lambda.
  build: {
    outDir: '../roadalyx/web',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('maplibre-gl')) return 'map';
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('gsap')) return 'gsap';
        },
      },
    },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['maplibre-gl'] },
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
});
