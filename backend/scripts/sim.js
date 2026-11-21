#!/usr/bin/env node
/**
 * Simulação headless do mundo — mede custo de tick, população, economia e IA
 * sem nenhum navegador. Serve para produzir números reais para docs/LIMITES.md.
 *
 * Uso:
 *   node scripts/sim.js                       # 10 minutos simulados, 4 bots
 *   node scripts/sim.js --minutes=30 --bots=8
 *   node scripts/sim.js --minutes=5 --json    # saída JSON (para CI)
 *
 * Nada aqui usa tempo real: os ticks rodam o mais rápido possível e medimos
 * quanto cada um custou. O mundo é o mesmo código do servidor.
 */

import { World } from '../src/game/world.js';
import { clamp } from '../../shared/constants.js';
import { MemoryStore } from '../src/persist/memory.js';
import { BUILDING, CHUNK_TILES, TICK_HZ } from '../../shared/constants.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const MINUTES = Number(args.minutes ?? 10);
const BOTS = Number(args.bots ?? 4);
const SEED = Number(args.seed ?? 20261121);
const JSON_OUT = !!args.json;
const TICKS = Math.round(MINUTES * 60 * TICK_HZ);

const silentLog = { info() {}, warn() {}, error() {}, debug() {}, trace() {} };
const buildStats = { attempts: 0, ok: 0, reasons: {} };

class Bot {
  constructor(world, index) {
    this.world = world;
    this.index = index;
    this.name = `Bot${index + 1}`;
    this.sessionId = `sim-${index + 1}`;
    this.player = null;
    this.target = null;
    this.wanderAt = 0;
    this.nextActionAt = 0;
    this.nextColonyAt = TICK_HZ * 8 + index * TICK_HZ * 4;   // funda após 8 s
    this.nextBuildAt = TICK_HZ * 30;
  }

  spawn() {
    const w = this.world;
    // começa perto de um ninho selvagem: há trilhas, recursos e predadores por perto
    const nests = [...w.colonies.values()];
    const nest = (nests[this.index % nests.length] ?? { nest: { x: w.sizePx / 2, y: w.sizePx / 2 } }).nest;
    const x = clamp(nest.x + (Math.random() - 0.5) * 320, 40, w.sizePx - 40);
    const y = clamp(nest.y + (Math.random() - 0.5) * 320, 40, w.sizePx - 40);
    this.player = w.players.spawn(this.sessionId, this.name, null, x, y, 0x3fa1d8);
    this.player.stats.playtime = 120; // bots já "jogaram" o bastante para fundar
    return this.player;
  }

  tick(tick) {
    const p = this.player;
    if (!p) return;
    if (!p.alive) {
      // na simulação o tempo é acelerado: não esperamos os 7 s reais de respawn
      p.respawnAt = Date.now() - 1;
      return;
    }
    const w = this.world;

    if (tick > this.nextColonyAt && !p.colonyId) {
      const c = w.createPlayerColony({
        name: `Colônia ${this.name}`, sessionId: this.sessionId, color: 0x3fa1d8,
        x: p.x, y: p.y,
      });
      c.addMember(this.sessionId, this.name);
      p.colonyId = c.id;
      this.nextColonyAt = Infinity;
      return;
    }

    const colony = p.colonyId ? w.colonies.get(p.colonyId) : null;
    const nest = colony?.nest;

    // volta para o próprio ninho antes de forragear longe
    if (nest && Math.hypot(nest.x - p.x, nest.y - p.y) > 360) {
      this.moveToward(nest.x, nest.y);
      return;
    }

    // obra de vez em quando (testa custo, ocupação e progresso cooperativo)
    if (colony && tick > this.nextBuildAt && !p.isBusy(Date.now())) {
      const type = BUILDING.CHAMBER;
      const { cx, cy } = w.chunkOf(nest.x, nest.y);
      const chunk = w.chunks.get(cx, cy);
      let cell = null;
      for (let gy = 1; gy < CHUNK_TILES - 2 && !cell; gy += 2) {
        for (let gx = 1; gx < CHUNK_TILES - 2; gx += 2) {
          if (chunk.canPlace(w.seed, gx, gy, 2, type).ok) { cell = { gx, gy }; break; }
        }
      }
      if (cell) {
        buildStats.attempts++;
        const res = w.handleAction(p, { type: 'build', building: type, cx, cy, ...cell });
        if (res.ok) buildStats.ok++;
        else buildStats.reasons[res.reason] = (buildStats.reasons[res.reason] ?? 0) + 1;
        this.nextBuildAt = tick + TICK_HZ * 25;
        if (res.ok) return;
      }
    }

    // entrega quando está carregando
    if (p.carrying.amount > 0 && nest) {
      const dNest = Math.hypot(nest.x - p.x, nest.y - p.y);
      if (dNest < 100) {
        if (tick > this.nextActionAt) {
          w.handleAction(p, { type: 'deposit' });
          this.nextActionAt = tick + 8;
        }
        p.input = { vx: 0, vy: 0 };
        return;
      }
      this.moveToward(nest.x, nest.y);
      return;
    }

    // procura recurso próximo
    const nodes = w.sense.nodesNear(p.x, p.y, 520);
    let best = null;
    let bestD = Infinity;
    for (const n of nodes) {
      if (n.amount <= 0) continue;
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < bestD) { bestD = d; best = n; }
    }
    if (best) {
      this.target = best;
      if (bestD < 36) {
        p.input = { vx: 0, vy: 0 };
        if (tick > this.nextActionAt) {
          w.handleAction(p, { type: 'gather', nodeId: best.id });
          this.nextActionAt = tick + 9;
        }
      } else {
        this.moveToward(best.x, best.y);
      }
      return;
    }

    // sem recurso por perto: patrulha em volta do ninho
    if (!this.target || Math.hypot(this.target.x - p.x, this.target.y - p.y) < 40 || tick > this.wanderAt) {
      const cx = nest?.x ?? w.sizePx / 2;
      const cy = nest?.y ?? w.sizePx / 2;
      const a = Math.random() * Math.PI * 2;
      const r = 160 + Math.random() * 520;
      this.target = { x: Math.max(32, Math.min(w.sizePx - 32, cx + Math.cos(a) * r)), y: Math.max(32, Math.min(w.sizePx - 32, cy + Math.sin(a) * r)) };
      this.wanderAt = tick + 120;
    }
    this.moveToward(this.target.x, this.target.y);
  }

  moveToward(x, y) {
    const p = this.player;
    const dx = x - p.x;
    const dy = y - p.y;
    const d = Math.hypot(dx, dy) || 1;
    p.input = { vx: dx / d, vy: dy / d };
  }
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

async function main() {
  const store = new MemoryStore({ snapshotDir: '/tmp/ant-life-sim' });
  const config = {
    maxDetailedAnts: Number(args.detailed ?? 420),
    maxAntsTotal: Number(args.ants ?? 2600),
    maxPredators: Number(args.predators ?? 90),
    maxPlayers: Number(args.players ?? 120),
    autoAiColonies: Number(args.colonies ?? 3),
    persistIntervalMs: 1e9,
    repoRoot: process.cwd(),
  };
  const world = new World({ seed: SEED, id: 'sim', store, config, log: silentLog });
  await world.load();
  world.maxPredators = config.maxPredators;

  const bots = [];
  for (let i = 0; i < BOTS; i++) {
    const b = new Bot(world, i);
    b.spawn();
    bots.push(b);
  }

  const times = [];
  const samples = [];
  const started = performance.now();

  for (let tick = 1; tick <= TICKS; tick++) {
    for (const b of bots) b.tick(tick);
    const t0 = performance.now();
    world.step();
    times.push(performance.now() - t0);

    if (tick % (TICK_HZ * 60) === 0) {
      const m = world.metricsSnapshot();
      samples.push({
        minute: tick / (TICK_HZ * 60),
        ants: m.ants,
        detailed: m.antsDetailed,
        predators: m.predators,
        colonies: m.colonies,
        structures: m.structures,
        players: m.players.total,
        aiThinks: m.aiThinks,
        botsAlive: bots.filter((b) => b.player?.alive).length,
        avgDistToNest: Math.round(
          bots.filter((b) => b.player?.colonyId).reduce((sum, b) => {
            const c = world.colonies.get(b.player.colonyId);
            return sum + Math.hypot(c.nest.x - b.player.x, c.nest.y - b.player.y);
          }, 0) / Math.max(1, bots.filter((b) => b.player?.colonyId).length)
        ),
      });
      if (!JSON_OUT) {
        const pop = [...world.colonies.values()].reduce((s, c) => s + c.totalPopulation, 0);
        process.stdout.write(
          `min ${String(samples.length).padStart(2)} · formigas ${String(m.ants).padStart(4)} ` +
          `(${m.antsDetailed} detalhadas) · pop ${String(pop).padStart(5)} · colônias ${m.colonies} ` +
          `· obras ${String(m.structures).padStart(3)} · predadores ${String(m.predators).padStart(2)} ` +
          `· tick médio ${(times.slice(-600).reduce((a, b) => a + b, 0) / Math.min(600, times.length)).toFixed(2)} ms\n`
        );
      }
    }
  }

  const elapsed = (performance.now() - started) / 1000;
  const sorted = [...times].sort((a, b) => a - b);
  const total = times.reduce((a, b) => a + b, 0);
  const result = {
    seed: SEED,
    minutes: MINUTES,
    ticks: TICKS,
    bots: BOTS,
    wallSeconds: Number(elapsed.toFixed(2)),
    tickMs: {
      avg: Number((total / times.length).toFixed(3)),
      p50: Number(pct(sorted, 50).toFixed(3)),
      p95: Number(pct(sorted, 95).toFixed(3)),
      p99: Number(pct(sorted, 99).toFixed(3)),
      max: Number(sorted.at(-1).toFixed(3)),
    },
    ticksPerSecondReal: Math.round(TICKS / elapsed),
    final: (() => {
      const m = world.metricsSnapshot();
      const colonies = [...world.colonies.values()].map((c) => ({
        name: c.name,
        ai: c.isAi,
        pop: c.totalPopulation,
        members: c.members.size,
        structures: c.structures.size,
        morale: Math.round(c.morale),
        stock: Object.fromEntries(Object.entries(c.stock).filter(([, v]) => v > 0)),
      }));
      return { ants: m.ants, detailed: m.antsDetailed, predators: m.predators, structures: m.structures, colonies };
    })(),
    samples,
    memoryMb: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
    builds: buildStats,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('\nresumo');
    console.log(`  tempo de parede: ${result.wallSeconds}s (${result.ticksPerSecondReal} ticks/s reais)`);
    console.log(`  tick: média ${result.tickMs.avg} ms · p95 ${result.tickMs.p95} ms · p99 ${result.tickMs.p99} ms · máx ${result.tickMs.max} ms`);
    console.log(`  formigas ${result.final.ants} (${result.final.detailed} detalhadas) · predadores ${result.final.predators} · estruturas ${result.final.structures}`);
    console.log(`  memória RSS: ${result.memoryMb} MB · obras dos bots: ${buildStats.ok}/${buildStats.attempts} ${JSON.stringify(buildStats.reasons)}`);
    for (const c of result.final.colonies) {
      console.log(`  ${c.ai ? 'IA ' : 'humana '}${c.name}: pop ${c.pop} · obras ${c.structures} · moral ${c.morale} · estoque ${JSON.stringify(c.stock)}`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
