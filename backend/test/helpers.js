import { World } from '../src/game/world.js';
import { MemoryStore } from '../src/persist/memory.js';
import { PersistenceManager } from '../src/persist/manager.js';
import { createRealtimeServer } from '../src/net/server.js';

export const TEST_SEED = 777001;
export const silentLog = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

export async function makeWorld(overrides = {}) {
  const store = overrides.store ?? new MemoryStore({ snapshotDir: '/tmp/ant-life-test' });
  const config = {
    maxDetailedAnts: 200,
    maxAntsTotal: 800,
    maxPredators: 30,
    maxPlayers: 60,
    autoAiColonies: 1,
    persistIntervalMs: 100000,
    repoRoot: process.cwd(),
    ...overrides.config,
  };
  const world = new World({
    seed: overrides.seed ?? TEST_SEED,
    id: overrides.id ?? 'test-world',
    store, config, log: silentLog,
  });
  await world.load();
  return { world, store, config };
}

/** Avança a simulação sem depender de tempo real. */
export function advance(world, ticks, playerInput = null) {
  for (let i = 0; i < ticks; i++) {
    if (playerInput) for (const p of world.players.bySession.values()) p.input = playerInput(p, i);
    world.step();
  }
}

export async function startServer(world, config = {}) {
  const store = { health: async () => ({ ok: true, mode: 'test' }), metrics: () => ({}) };
  const persistence = new PersistenceManager(world, store, 999999);
  const cfg = {
    corsOrigin: ['http://localhost:5173'], maxPlayers: 60,
    maxDetailedAnts: 200, maxAntsTotal: 800, maxPredators: 30,
    adminToken: 'test-token', ...config,
  };
  const net = createRealtimeServer({ world, store, persistence, config: cfg });
  await new Promise((resolve) => net.httpServer.listen(0, '127.0.0.1', resolve));
  const port = net.httpServer.address().port;
  return { port, net, persistence, close: async () => { net.io.close(); net.httpServer.close(); } };
}

export function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(fn, timeoutMs = 4000, interval = 40) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await wait(interval);
  }
  return null;
}
