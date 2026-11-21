#!/usr/bin/env node
/**
 * Desenvolvimento local: sobe o backend (porta 8080) e o frontend (Vite 5173),
 * que conversa com o backend pelo proxy de /socket.io, /api e /health.
 *
 * Uso:
 *   npm run dev                 # backend + frontend
 *   npm run dev -- --backend    # só o backend
 *   npm run dev -- --frontend   # só o frontend
 *
 * Em produção nada disso é usado: o backend roda no Render e o frontend
 * estático no GitHub Pages.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = new Set(process.argv.slice(2));
const onlyBackend = args.has('--backend');
const onlyFrontend = args.has('--frontend');

const backendPort = process.env.PORT || '8080';
const frontendPort = process.env.VITE_PORT || '5173';
const children = [];
let stopping = false;

function run(name, command, cmdArgs, cwd, env = {}) {
  const child = spawn(command, cmdArgs, {
    cwd,
    env: {
      ...process.env,
      ...env,
      PERSIST: process.env.PERSIST || 'file',
      PORT: backendPort,
      VITE_PROXY_TARGET: process.env.VITE_PROXY_TARGET || `http://localhost:${backendPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = name === 'backend' ? '\x1b[33m[api]\x1b[0m' : '\x1b[36m[web]\x1b[0m';
  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) console.log(`${prefix} ${line}`);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.log(`${prefix} encerrou (${signal ?? code})`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

if (!onlyFrontend) {
  console.log(`\x1b[33m[api]\x1b[0m iniciando backend em http://localhost:${backendPort}`);
  run('backend', process.execPath, ['--watch', 'src/index.js'], path.join(root, 'backend'));
}
if (!onlyBackend) {
  console.log(`\x1b[36m[web]\x1b[0m iniciando Vite em http://localhost:${frontendPort}`);
  run('frontend', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev', '--', '--port', frontendPort], path.join(root, 'frontend'));
}

console.log(`\nAbra http://localhost:${frontendPort} · Ctrl+C encerra os dois processos.\n`);
