#!/usr/bin/env node
/**
 * Teste de carga realista (sem navegador): sobe o servidor em processo, conecta
 * N clientes Socket.IO que jogam de verdade (entrar, mover, coletar, entregar,
 * construir, conversar, reconectar) e mede números honestos.
 *
 * Uso:
 *   node scripts/loadtest.js --players=20 --seconds=30
 *   node scripts/loadtest.js --players=50 --seconds=45 --build-every=15
 *
 * Métricas:
 *   - tick do mundo (média/pico) e CPU do processo;
 *   - bytes/s e snapshots/s por cliente (payload JSON decodificado);
 *   - RTT de ping (p50/p95);
 *   - reconexão com token preservando sessão e colônia.
 */

import { io } from 'socket.io-client';
import { World } from '../src/game/world.js';
import { MemoryStore } from '../src/persist/memory.js';
import { PersistenceManager } from '../src/persist/manager.js';
import { createRealtimeServer } from '../src/net/server.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const PLAYERS = Number(args.players ?? 20);
const SECONDS = Number(args.seconds ?? 30);
const SEED = Number(args.seed ?? 20261121);
const BUILD_EVERY = Number(args.buildEvery ?? 20);
const CHAT_EVERY = Number(args.chatEvery ?? 12);

const silentLog = { info() {}, warn() {}, error() {}, debug() {}, trace() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))];
};

class VirtualPlayer {
  constructor(index, url, world) {
    this.index = index;
    this.url = url;
    this.world = world;
    this.name = `Carga${String(index + 1).padStart(2, '0')}`;
    this.socket = null;
    this.selfId = null;
    this.token = null;
    this.sessionId = null;
    this.colonyId = null;
    this.nest = null;
    this.self = null;
    this.nodes = [];
    this.target = null;
    this.bytes = 0;
    this.snaps = 0;
    this.chatMsgs = 0;
    this.gathered = 0;
    this.built = 0;
    this.rtts = [];
    this.lastInput = 0;
    this.lastGatherAt = 0;
    this.lastDepositAt = 0;
    this.lastBuildAt = 0;
    this.lastChatAt = 0;
    this.nextRetarget = 0;
    this.reconnected = false;
    this.errors = [];
    this.alive = true;
  }

  connect(withToken = null) {
    const socket = io(this.url, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    this.socket = socket;

    socket.on('connect', () => {
      socket.emit('hello', { name: this.name, token: withToken ?? this.token ?? null });
    });

    socket.on('welcome', (w) => {
      const wasSame = this.sessionId && w.sessionId === this.sessionId;
      this.selfId = w.selfId;
      this.token = w.token;
      this.sessionId = w.sessionId;
      this.colonyId = w.colony?.id ?? null;
      const mine = w.colonies?.find((c) => c.id === this.colonyId) ?? null;
      this.nest = mine?.nest ?? w.colonies?.[0]?.nest ?? null;
      if (withToken) this.reconnected = !!wasSame;
      // funda uma colônia própria depois do tempo mínimo de exploração
      if (!w.colony && this.index % 4 === 0) {
        setTimeout(() => this.socket?.emit('colony', {
          op: 'create', name: `Colônia ${this.name}`, color: 0x3fa1d8,
        }), 3200 + (this.index % 5) * 120);
      }
    });

    socket.onAny((event, ...payload) => {
      // estimativa do payload JSON decodificado (o que trafega depois do framing)
      try { this.bytes += JSON.stringify(payload).length; } catch { /* ignora */ }
      if (event === 'snap') this.snaps++;
    });

    socket.on('snap', (p) => {
      if (p.self) {
        this.self = p.self;
        this.alive = !!p.self[7];
      }
      if (p.nd) {
        const seen = new Map();
        for (const [, , flat] of p.nd) {
          for (let i = 0; i < flat.length; i += 6) {
            seen.set(flat[i], { id: flat[i], x: flat[i + 1], y: flat[i + 2], kind: flat[i + 3], amount: flat[i + 4] });
          }
        }
        this.nodes = [...seen.values()];
      }
    });

    socket.on('state', (s) => {
      if (s.colony) {
        this.colonyId = s.colony.id;
        if (!this.nest) {
          const c = this.world.colonies.get(s.colony.id);
          if (c) this.nest = { x: Math.round(c.nest.x), y: Math.round(c.nest.y) };
        }
      }
    });

    socket.on('notice', (n) => {
      if (n.kind === 'error') this.errors.push(n.text);
      if (n.kind === 'colony' && n.colony) this.colonyId = n.colony.id;
    });
    socket.on('error', (e) => this.errors.push(e?.error ?? 'erro'));
    socket.on('pong', (p) => {
      if (p?.t) this.rtts.push(Date.now() - p.t);
    });
  }

  tick(now) {
    const s = this.socket;
    if (!s?.connected || !this.self) return;
    if (!this.alive) {
      s.emit('act', { action: { type: 'respawn' } });
      return;
    }
    const [x, y, , , , carryKind, carryAmount] = this.self;

    // resolve o próprio ninho depois de fundar
    if (this.colonyId && !this.nest) {
      const c = this.world.colonies.get(this.colonyId);
      if (c) this.nest = { x: Math.round(c.nest.x), y: Math.round(c.nest.y) };
    }

    // entrega ao chegar no ninho
    if (carryAmount > 0 && this.nest && Math.hypot(this.nest.x - x, this.nest.y - y) < 90) {
      if (now - this.lastDepositAt > 500) {
        this.lastDepositAt = now;
        s.emit('act', { action: { type: 'deposit' } });
      }
      return;
    }

    // coleta quando há recurso ao alcance
    if (carryAmount < 8 && now - this.lastGatherAt > 420) {
      let near = null;
      let best = 46 * 46;
      for (const n of this.nodes) {
        const d = (n.x - x) ** 2 + (n.y - y) ** 2;
        if (d < best && n.amount > 0) { best = d; near = n; }
      }
      if (near) {
        this.lastGatherAt = now;
        s.emit('act', { action: { type: 'gather', nodeId: near.id } });
        this.gathered++;
        return;
      }
    }

    // constrói de vez em quando
    if (this.colonyId && now - this.lastBuildAt > BUILD_EVERY * 1000 && now - this.lastBuildAt > 4000) {
      this.lastBuildAt = now;
      const c = this.world.colonies.get(this.colonyId);
      if (c) {
        const chunkPx = this.world.sizePx / this.world.chunksAcross;
        const cx = Math.floor(c.nest.x / chunkPx);
        const cy = Math.floor(c.nest.y / chunkPx);
        s.emit('act', { action: { type: 'build', building: 1, cx, cy, gx: 2 + (this.index % 6) * 3, gy: 2 } });
        this.built++;
      }
    }

    // conversa
    if (now - this.lastChatAt > CHAT_EVERY * 1000) {
      this.lastChatAt = now;
      s.emit('chat', { text: `carga ${this.index} ok`, channel: 'global' });
      this.chatMsgs++;
    }

    // anda em direção a um recurso (ou patrulha)
    if (now > this.nextRetarget) {
      this.nextRetarget = now + 2500 + Math.random() * 2000;
      let best = null;
      let bestD = 640 * 640;
      for (const n of this.nodes) {
        const d = (n.x - x) ** 2 + (n.y - y) ** 2;
        if (d < bestD && n.amount > 0) { bestD = d; best = n; }
      }
      if (carryAmount > 0 && this.nest) this.target = { x: this.nest.x, y: this.nest.y };
      else if (best) this.target = { x: best.x, y: best.y };
      else if (this.nest) {
        const a = Math.random() * Math.PI * 2;
        this.target = { x: this.nest.x + Math.cos(a) * (200 + Math.random() * 400), y: this.nest.y + Math.sin(a) * (200 + Math.random() * 400) };
      }
    }
    if (this.target && now - this.lastInput > 66) {
      this.lastInput = now;
      const dx = this.target.x - x;
      const dy = this.target.y - y;
      const d = Math.hypot(dx, dy) || 1;
      s.emit('input', { vx: dx / d, vy: dy / d, seq: 1 });
    }

    if (now % 3000 < 120) s.emit('ping', { t: Date.now() });
  }

  disconnect() { this.socket?.disconnect(); }
}

async function main() {
  const store = new MemoryStore({ snapshotDir: '/tmp/ant-life-load' });
  const config = {
    maxDetailedAnts: Number(args.detailed ?? 420),
    maxAntsTotal: Number(args.ants ?? 2600),
    maxPredators: Number(args.predators ?? 90),
    maxPlayers: Number(args.maxPlayers ?? 120),
    autoAiColonies: Number(args.colonies ?? 3),
    persistIntervalMs: 1e9,
    repoRoot: process.cwd(),
    corsOrigin: '*',
  };
  const world = new World({ seed: SEED, id: 'load', store, config, log: silentLog });
  await world.load();
  world.start();

  const persistence = new PersistenceManager(world, store, 1e9);
  const net = createRealtimeServer({ world, store, persistence, config });
  await new Promise((resolve) => net.httpServer.listen(0, '127.0.0.1', resolve));
  const port = net.httpServer.address().port;
  const url = `http://127.0.0.1:${port}`;

  console.log(`servidor de carga em ${url} · ${PLAYERS} clientes · ${SECONDS}s · seed ${SEED}`);

  const players = [];
  for (let i = 0; i < PLAYERS; i++) {
    const vp = new VirtualPlayer(i, url, world);
    players.push(vp);
    vp.connect();
    await sleep(40 + Math.random() * 60);
  }

  await sleep(1500);
  const connected = players.filter((p) => p.selfId).length;
  console.log(`conectados: ${connected}/${PLAYERS}`);
  if (!connected) {
    console.error('nenhum cliente conectou — servidor não respondeu');
    process.exit(1);
  }

  const cpu0 = process.cpuUsage();
  const t0 = Date.now();
  let lagPeak = 0;
  let last = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    lagPeak = Math.max(lagPeak, now - last - 100);
    last = now;
  }, 100);

  // reconexão: um cliente cai e volta com token no meio do teste
  let reconnectTarget = null;
  if (PLAYERS >= 2) {
    setTimeout(() => {
      const vp = players[1];
      reconnectTarget = { token: vp.token, sessionId: vp.sessionId, name: vp.name };
      vp.disconnect();
      setTimeout(() => vp.connect(reconnectTarget.token), 1200);
    }, Math.round(SECONDS * 1000 * 0.5));
  }

  while (Date.now() - t0 < SECONDS * 1000) {
    const now = Date.now();
    for (const p of players) p.tick(now);
    await sleep(50);
  }

  clearInterval(lagTimer);
  const wall = (Date.now() - t0) / 1000;
  const cpu = process.cpuUsage(cpu0);
  const cpuPct = ((cpu.user + cpu.system) / 1000 / 1000 / wall) * 100;

  const snapshots = net.aoi.stats.snapshots;
  const totalBytes = net.aoi.stats.bytes;
  const avgPayload = net.aoi.stats.avgBytes;
  const perClientBytes = players.map((p) => p.bytes / wall);
  const rtts = players.flatMap((p) => p.rtts);
  const metrics = world.metricsSnapshot();
  const reconnectedOk = players[1]?.reconnected || false;

  const result = {
    players: PLAYERS,
    seconds: wall,
    seed: SEED,
    ants: metrics.ants,
    detailedAnts: metrics.antsDetailed,
    predators: metrics.predators,
    colonies: metrics.colonies,
    structures: metrics.structures,
    tickMsAvg: metrics.tickMsAvg,
    tickMsPeak: metrics.tickMsPeak,
    eventLoopLagPeakMs: lagPeak,
    cpuPct: Number(cpuPct.toFixed(1)),
    memoryMb: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
    snapshots,
    snapshotsPerSecond: Math.round(snapshots / wall),
    avgPayloadBytes: avgPayload,
    bytesPerClientPerSecond: Math.round(pct(perClientBytes, 50)),
    bytesPerClientP95: Math.round(pct(perClientBytes, 95)),
    totalMBps: Number((totalBytes / wall / 1048576).toFixed(2)),
    rttP50: pct(rtts, 50),
    rttP95: pct(rtts, 95),
    gatheredActions: players.reduce((s, p) => s + p.gathered, 0),
    buildActions: players.reduce((s, p) => s + p.built, 0),
    chatMessages: players.reduce((s, p) => s + p.chatMsgs, 0),
    errors: [...new Set(players.flatMap((p) => p.errors))].slice(0, 8),
    reconnect: Boolean(reconnectedOk),
  };

  console.log(JSON.stringify(result, null, 2));

  for (const p of players) p.disconnect();
  await sleep(200);
  world.stop();
  net.io.close();
  net.httpServer.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
