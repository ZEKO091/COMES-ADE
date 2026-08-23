import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  build: {
    // Monaco's TypeScript language service is a lazy vendor worker around 6 MB.
    chunkSizeWarningLimit: 6500,
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    hmr: {
      host: '127.0.0.1',
      port: 1420,
      protocol: 'ws',
    },
    watch: {
      ignored: ['**/src-tauri/target/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
});
