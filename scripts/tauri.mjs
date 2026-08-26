import { spawn } from 'node:child_process';
import { openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureVite, VITE_ORIGIN } from './vite-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAURI_JS = join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const PID_FILE = join(ROOT, '.tauri-dev.pid');
const LOG_FILE = join(ROOT, '.tauri-dev.log');
const CARGO_TARGET_DIR = join(ROOT, 'src-tauri', 'target');
const SANDBOX_MARKER = 'cursor-sandbox-cache';
const HIDE_CONSOLE_SCRIPT = join(ROOT, 'scripts', 'hide-background-console.ps1');

const args = process.argv.slice(2);
const isDev = args[0] === 'dev';
const foreground = args.includes('--foreground');
const tauriArgs = args.filter((arg) => arg !== '--foreground');

function tauriEnv() {
  const env = { ...process.env };
  const userTemp = env.LOCALAPPDATA
    ? join(env.LOCALAPPDATA, 'Temp')
    : tmpdir();

  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    const value = String(env[key] ?? '');
    if (name === 'CARGO_TARGET_DIR' || (value.includes(SANDBOX_MARKER) && (name === 'TMP' || name === 'TEMP' || name === 'TMPDIR'))) {
      delete env[key];
    }
  }

  env.CARGO_TARGET_DIR = CARGO_TARGET_DIR;
  env.TMP = env.TMP && !env.TMP.includes(SANDBOX_MARKER) ? env.TMP : userTemp;
  env.TEMP = env.TEMP && !env.TEMP.includes(SANDBOX_MARKER) ? env.TEMP : userTemp;
  if (foreground) {
    delete env.COMESADE_BACKGROUND;
  } else {
    env.COMESADE_BACKGROUND = '1';
  }
  env.TMPDIR = env.TMPDIR && !env.TMPDIR.includes(SANDBOX_MARKER) ? env.TMPDIR : userTemp;
  return env;
}

if (isDev) {
  const ready = await ensureVite();
  if (!ready) process.exit(1);
  if (!tauriArgs.includes('--no-dev-server-wait')) {
    tauriArgs.splice(1, 0, '--no-dev-server-wait');
  }
}

function spawnTauriForeground() {
  const child = spawn(process.execPath, [TAURI_JS, ...tauriArgs], {
    cwd: ROOT,
    env: tauriEnv(),
    shell: false,
    stdio: 'inherit',
    windowsHide: false,
  });
  child.on('exit', (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 0);
  });
}

function spawnTauriBackground() {
  const logFd = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [TAURI_JS, ...tauriArgs], {
    cwd: ROOT,
    env: tauriEnv(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    // The desktop process owns its own UI. Keep the Node/Tauri launcher
    // completely detached so Windows does not create a console window for
    // users who start ComesADE from a normal desktop launcher.
    windowsHide: true,
    shell: false,
  });
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    const consoleHelper = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-File',
      HIDE_CONSOLE_SCRIPT,
      '-RootPid',
      String(child.pid),
    ], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    consoleHelper.unref();
  }
  if (typeof child.pid === 'number') {
    writeFileSync(PID_FILE, String(child.pid), 'utf8');
  }
  child.unref();
  return child;
}

if (isDev && !foreground) {
  const child = spawnTauriBackground();
  console.log(`[comesade] Vite en segundo plano en ${VITE_ORIGIN}`);
  console.log(`[comesade] Ventana de escritorio ComesADE (pid ${child.pid ?? '?'}).`);
  process.exit(0);
}

spawnTauriForeground();
