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
  // Only public Vite configuration belongs in the renderer bundle. In
  // particular, never expose TAURI_SIGNING_PRIVATE_KEY from CI to the app.
  envPrefix: 'VITE_',
});
