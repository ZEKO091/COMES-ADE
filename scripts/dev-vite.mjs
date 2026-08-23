import { ensureVite, VITE_ORIGIN } from './vite-server.mjs';

const once = process.argv.includes('--once');

function keepAlive() {
  return new Promise(() => {
    const stop = () => process.exit(0);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('SIGHUP', stop);
  });
}

const ready = await ensureVite();
if (!ready) process.exit(1);
if (once) process.exit(0);
console.log(`[comesade] Vite se mantiene en segundo plano en ${VITE_ORIGIN}`);
await keepAlive();
