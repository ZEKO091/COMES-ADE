import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const VITE_HOST = '127.0.0.1';
export const VITE_PORT = 1420;
export const VITE_ORIGIN = `http://${VITE_HOST}:${VITE_PORT}/`;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PID_FILE = join(ROOT, '.vite-dev.pid');

function portOpen() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: VITE_HOST, port: VITE_PORT });
    socket.setTimeout(400);
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function viteReady() {
  try {
    const response = await fetch(VITE_ORIGIN, { redirect: 'manual' });
    if (response.status !== 200) return false;
    const body = await response.text();
    // Do not treat an unrelated HTTP service on port 1420 as Vite.
    return body.includes('/@vite/client') && body.includes('/src/main.ts');
  } catch {
    return false;
  }
}

function startVite() {
  const viteJs = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteJs], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
    shell: false,
  });
  if (typeof child.pid === 'number') {
    writeFileSync(PID_FILE, String(child.pid), 'utf8');
  }
  child.unref();
  return child;
}

async function waitForVite(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await viteReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export async function ensureVite() {
  if (await viteReady()) {
    console.log(`[comesade] Vite listo en ${VITE_ORIGIN}`);
    return true;
  }

  if (await portOpen()) {
    if (await waitForVite(8_000)) {
      console.log(`[comesade] Vite listo en ${VITE_ORIGIN}`);
      return true;
    }
    console.error(`[comesade] El puerto ${VITE_PORT} está ocupado y no responde como Vite.`);
    return false;
  }

  console.log(`[comesade] Arrancando Vite en segundo plano en ${VITE_ORIGIN}`);
  startVite();
  if (await waitForVite()) {
    console.log(`[comesade] Vite listo en ${VITE_ORIGIN}`);
    return true;
  }
  console.error(`[comesade] Vite no respondió en ${VITE_ORIGIN}`);
  return false;
}
