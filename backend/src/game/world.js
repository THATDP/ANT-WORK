/**
 * WORLD — o simulador autoritativo.
 *
 * Um único loop fixo (10 Hz) orquestra:
 *   ambiente → eventos → jogadores → IA (LOD) → predadores → defesa/guerra
 *   → economia/ciclo de vida (1 Hz) → limpeza
 *
 * Nada de física por frame no cliente. Nada de posição de formiga indo e voltando
 * pela rede. O cliente recebe apenas snapshots por área de interesse.
 */

import {
  TICK_MS, TICK_HZ, WORLD_CHUNKS, CHUNK_PX, CHUNK_TILES, TILE, WORLD_PX,
  ROLE, ROLE_INFO, TASK, TASK_NAME, BUILDING, BUILDING_INFO, RESOURCE, RESOURCE_INFO,
  COLONY_LIMITS, COLONY_COLORS, NET, BIOME, BIOME_INFO, clamp, dist, emptyStock,
} from '../../../shared/constants.js';
import { biomeAt, isWater, sectorName, chunkBiome } from '../../../shared/worldgen.js';
import { ChunkManager, SpatialIndex, PHERO } from './chunk.js';
import { Colony, ColonyDirector, makeColonyId } from './colony.js';
import { Ant, resetAntSeq } from './ant.js';
import { think, colonyNeeds } from './ai/brain.js';
import { SenseSystem } from './sense.js';
import { BuildSystem, nextStructureId, resetStructureSeq } from './build.js';
import { CombatSystem } from './combat.js';
import { DefenceSystem, MilitarySystem } from './defence.js';
import { PredatorSystem, resetPredSeq } from './predators.js';
import { ResourceSystem, EconomySystem } from './economy.js';
import { Environment, WorldEvents, EventLog } from './events.js';
import { PlayersSystem } from './players.js';

const MAX_TILE_CACHE = 24000;

export class World {
  constructor({ seed, id, store, config, log }) {
    this.seed = seed;
    this.id = id;
    this.store = store;
    this.config = config;
    this.log = log;

    this.tick = 0;
    this.startedAt = Date.now();
    this.chunksAcross = WORLD_CHUNKS;
    this.sizePx = WORLD_PX;

    this.chunks = new ChunkManager(this);
    this.antIndex = new SpatialIndex();
    this.predIndex = new SpatialIndex();

    this.ants = new Map();
    this.colonies = new Map();
    this.directors = new Map();

    this.sense = new SenseSystem(this);
    this.resources = new ResourceSystem(this);
    this.economy = new EconomySystem(this);
    this.build = new BuildSystem(this);
    this.combat = new CombatSystem(this);
    this.defence = new DefenceSystem(this);
    this.military = new MilitarySystem(this);
    this.predators = new PredatorSystem(this);
    this.env = new Environment(this);
    this.worldEvents = new WorldEvents(this);
    this.events = new EventLog(this);
    this.players = new PlayersSystem(this);

    this.maxDetailedAnts = config?.maxDetailedAnts ?? 420;
    this.maxAntsTotal = config?.maxAntsTotal ?? 2600;
    this.maxPredators = config?.maxPredators ?? 90;
    this.maxPlayers = config?.maxPlayers ?? 120;

    this.structureIndex = new Map();
    this.tileCache = new Map();
    this._timers = {};
    this.metrics = {
      ticks: 0, tickMsAvg: 0, tickMsPeak: 0, lastTickMs: 0,
      antsDetailed: 0, snapshotBytes: 0, snapshots: 0,
      aiThinks: 0, startedAt: this.startedAt,
    };
    this.running = false;
    this.initialized = false;
    this.queue = [];
    this.autoAiColonies = config?.autoAiColonies ?? 2;
  }

  get weatherSpeedMul() { return this.env.weatherSpeedMul; }
  get isNight() { return this.env.isNight; }

  // ================================================================ bootstrap
  async load() {
    if (this.initialized) return;
    let saved = null;
    try {
      saved = await this.store?.loadWorld?.(this.id, this.seed);
    } catch (err) {
      this.log?.error('Falha ao carregar mundo persistido:', err.message);
    }
    if (saved) this.restore(saved);
    this.ensureBaseColonies();
    this.initialized = true;
    this.log?.info(`Mundo ${this.id} pronto · seed ${this.seed} · ${this.colonies.size} colônias · ${this.ants.size} formigas`);
  }

  ensureBaseColonies() {
    // Registra construções restauradas nos índices
    for (const colony of this.colonies.values()) {
      colony.ants = colony.ants ?? new Set();
      colony.knownNodes = colony.knownNodes ?? new Set();
      for (const s of colony.structures.values()) {
        this.structureIndex.set(s.id, s);
        if (nextStructureId() <= s.id) resetStructureSeq(s.id + 1);
      }
      if (!colony.queen) this.spawnQueen(colony);
      this.rebuildColonyAnts(colony);
    }

    // Colônias de IA que dão vida ao mundo (se não houver nenhuma)
    const ai = [...this.colonies.values()].filter((c) => c.isAi);
    const wantAi = Math.max(this.autoAiColonies, 0);
    for (let i = ai.length; i < wantAi; i++) {
      this.createAiColony({ index: i + ai.length });
    }
  }

  rebuildColonyAnts(colony) {
    if (!colony.ants) colony.ants = new Set();
    // mantém só os vivos que já existem
    const alive = [...colony.ants].filter((a) => a.alive && this.ants.has(a.id));
    colony.ants = new Set(alive);
    if (colony.queen && !colony.queen.alive) colony.queen = null;

    const target = Math.min(this.populationCapFor(colony), colony.totalPopulation || 0);
    const roles = [
      [ROLE.WORKER, colony.population.worker || 0],
      [ROLE.SCOUT, colony.population.scout || 0],
      [ROLE.SOLDIER, colony.population.soldier || 0],
      [ROLE.LARVA, colony.population.larva || 0],
    ];
    for (const [role, count] of roles) {
      const have = alive.filter((a) => a.role === role).length;
      const need = Math.max(0, count - have);
      for (let i = 0; i < need; i++) {
        if (colony.ants.size >= target) break;
        this.spawnAnt(colony, role, {
          x: colony.nest.x + (Math.random() - 0.5) * 90,
          y: colony.nest.y + (Math.random() - 0.5) * 90,
        });
      }
    }
    colony.rebuildPopulationCounts(colony.ants);
  }

  spawnQueen(colony) {
    const queen = this.spawnAnt(colony, ROLE.QUEEN, {
      x: colony.nest.x, y: colony.nest.y,
    });
    if (queen) {
      queen.eggProgress = 0;
      colony.queen = queen;
      colony.queenDead = false;
    }
    return queen;
  }

  createAiColony({ index = 0, name, near } = {}) {
    const seedRng = this.seed + index * 7919;
    let x, y;
    if (near) { x = near.x; y = near.y; }
    else {
      // posição determinística longe do centro e de outras colônias
      for (let attempt = 0; attempt < 40; attempt++) {
        const a = ((seedRng + attempt * 137) % 360) * (Math.PI / 180);
        const r = 5000 + ((seedRng + attempt * 311) % 8000);
        x = this.sizePx / 2 + Math.cos(a) * r;
        y = this.sizePx / 2 + Math.sin(a) * r;
        if (isWater(this.seed, x, y)) continue;
        if (biomeAt(this.seed, x, y) === BIOME.ROCK || biomeAt(this.seed, x, y) === BIOME.CONTAMINATED) continue;
        if (this.coloniesNear(x, y, 4).length) continue;
        break;
      }
    }
    x = clamp(x, CHUNK_PX, this.sizePx - CHUNK_PX);
    y = clamp(y, CHUNK_PX, this.sizePx - CHUNK_PX);

    const names = ['Colônia Rubra', 'Colônia Obsidiana', 'Colônia Âmbar', 'Colônia Musgo', 'Colônia Cinza'];
    const color = COLONY_COLORS[(index + 1) % COLONY_COLORS.length];
    const colony = new Colony({
      id: makeColonyId(), name: name || names[index % names.length],
      color, x, y, isAi: true,
      aggression: 0.25 + (index % 4) * 0.2,
      industry: 0.4 + (index % 3) * 0.2,
      exploration: 0.5,
    });
    colony.ants = new Set();
    colony.knownNodes = new Set();
    colony.brood.eggs = 4;
    colony.stock = { leaf: 60, seed: 40, fruit: 20, insect: 25, water: 50, material: 70, spore: 1 };
    colony.population = { worker: 18, scout: 4, soldier: 5, larva: 2 };
    colony.totalPopulation = 29;
    this.colonies.set(colony.id, colony);
    this.directors.set(colony.id, new ColonyDirector(this, colony));
    this.spawnQueen(colony);
    this.rebuildColonyAnts(colony);

    // entrada + trilha inicial
    const { cx, cy } = this.chunkOf(x, y);
    const chunk = this.chunks.get(cx, cy);
    colony.claim(chunk.key, 1);
    for (const s of chunk.structures.values()) {
      if (s.colonyId === colony.id) colony.structures.set(s.id, s);
    }
    const gx = Math.floor((x - chunk.originX) / TILE);
    const gy = Math.floor((y - chunk.originY) / TILE);
    const v = this.build.validate(colony, BUILDING.EXIT, cx, cy, gx, gy, null, { asAi: true });
    if (v.ok) {
      const r = this.build.create(colony, BUILDING.EXIT, cx, cy, gx, gy, null, { asAi: true });
      if (r.ok) this.build.complete(r.structure);
    }
    this.events.push('colony', `Nova colônia: ${colony.name}`, x, y, true);
    return colony;
  }

  createPlayerColony({ name, sessionId, x, y, color }) {
    if (x == null || y == null) {
      // escolhe um local livre com boa escavabilidade
      for (let attempt = 0; attempt < 60; attempt++) {
        const a = Math.random() * Math.PI * 2;
        const r = 3000 + Math.random() * 9000;
        const px = this.sizePx / 2 + Math.cos(a) * r;
        const py = this.sizePx / 2 + Math.sin(a) * r;
        if (isWater(this.seed, px, py)) continue;
        const b = biomeAt(this.seed, px, py);
        if (b === BIOME.WATER || b === BIOME.ROCK || b === BIOME.CONTAMINATED) continue;
        if (this.coloniesNear(px, py, 3).length) continue;
        x = px; y = py;
        break;
      }
      if (x == null) { x = this.sizePx * 0.4; y = this.sizePx * 0.4; }
    } else if (isWater(this.seed, x, y)) {
      // o fundador não pode ficar preso na água: procura o ponto seco mais próximo
      outer: for (let r = 1; r <= 8; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const px = x + dx * TILE;
            const py = y + dy * TILE;
            if (!isWater(this.seed, px, py)) { x = px; y = py; break outer; }
          }
        }
      }
    }
    const colony = new Colony({
      id: makeColonyId(),
      name: (name || 'Nova Colônia').slice(0, 24),
      color: color ?? COLONY_COLORS[this.colonies.size % COLONY_COLORS.length],
      x, y, founderSessionId: sessionId, isAi: false,
      aggression: 0.5, industry: 0.5, exploration: 0.5,
    });
    colony.ants = new Set();
    colony.knownNodes = new Set();
    colony.stock = { leaf: 24, seed: 12, fruit: 6, insect: 6, water: 20, material: 30, spore: 0 };
    colony.morale = 70;
    colony.population = { worker: 7, scout: 2, soldier: 2, larva: 1 };
    colony.totalPopulation = 12;
    this.colonies.set(colony.id, colony);
    this.spawnQueen(colony);
    this.rebuildColonyAnts(colony);
    const { cx, cy } = this.chunkOf(x, y);
    const chunk = this.chunks.get(cx, cy);
    colony.claim(chunk.key, 1);
    const gx = Math.floor((x - chunk.originX) / TILE);
    const gy = Math.floor((y - chunk.originY) / TILE);
    const r = this.build.create(colony, BUILDING.EXIT, cx, cy, gx, gy, null, { asAi: true });
    if (r.ok) this.build.complete(r.structure);
    this.events.push('colony', `Colônia ${colony.name} fundada`, x, y, true);
    return colony;
  }

  // ================================================================ loop
  start() {
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    let acc = 0;
    this._interval = setInterval(() => {
      const now = performance.now();
      const delta = Math.min(250, now - last);
      last = now;
      acc += delta;
      let steps = 0;
      while (acc >= TICK_MS && steps < 3) {
        const t0 = performance.now();
        this.step();
        const ms = performance.now() - t0;
        this.metrics.lastTickMs = ms;
        this.metrics.tickMsAvg = this.metrics.tickMsAvg * 0.95 + ms * 0.05;
        this.metrics.tickMsPeak = Math.max(this.metrics.tickMsPeak, ms);
        acc -= TICK_MS;
        steps++;
      }
      if (steps >= 3) acc = 0; // descarta atraso em vez de acumular (evita espiral)
    }, TICK_MS);
    if (this._interval.unref) this._interval.unref();
  }

  stop() {
    this.running = false;
    clearInterval(this._interval);
  }

  step() {
    this.tick++;
    this.metrics.ticks++;
    const dt = 1 / TICK_HZ;

    this.env.tick(dt, this.tick);
    this.worldEvents.tick(dt);
    this.worldEvents.applyContinuous(dt);
    this.players.update(dt);
    this.updatePlayersMovement(dt);

    if (this.tick % 10 === 0) this.updateLOD();
    this.tickAnts(dt);
    this.predators.tick(dt);
    this.defence.update(dt);
    this.military.update(dt);

    if (this.tick % 10 === 0) {
      this.economy.step(1);
      for (const [id, director] of this.directors) {
        const c = this.colonies.get(id);
        if (!c || !c.isAi) continue;
        director.think();
      }
    }

    if (this.tick % 25 === 0) {
      for (const c of this.chunks.chunks.values()) c.evaporate(0.93);
      this.cleanupStructures();
    }

    this.updateIndexes();
    if (this.tick % 200 === 0) this.gc();
  }

  updateIndexes() {
    // reagrupa entidades nos índices espaciais (barato: só quem mudou de chunk)
    if (this.tick % 3 !== 0) return;
    for (const a of this.ants.values()) {
      if (a.alive) this.antIndex.move(a);
    }
    for (const p of this.predators.predators.values()) {
      if (!p.dead) this.predIndex.move(p);
    }
  }

  updatePlayersMovement(dt) {
    for (const p of this.players.bySession.values()) {
      if (!p.alive) continue;
      if (!p.input) continue;
      const { vx, vy } = p.input;
      if (vx || vy) this.players.move(p, vx, vy, dt);
      else { p.vx = 0; p.vy = 0; }
    }
  }

  updateLOD() {
    const active = this.players.all().filter((p) => p.alive);
    const anchors = active.map((p) => ({ x: p.x, y: p.y }));
    let detailed = 0;
    const maxD = this.maxDetailedAnts;
    for (const ant of this.ants.values()) {
      if (!ant.alive) continue;
      let d = Infinity;
      for (const p of anchors) {
        const dd = (p.x - ant.x) ** 2 + (p.y - ant.y) ** 2;
        if (dd < d) d = dd;
      }
      d = Math.sqrt(d);
      let detail;
      if (ant.role === ROLE.QUEEN) detail = d < 1600 ? 0 : 2;
      else if (d < 1150) detail = 0;
      else if (d < 2600) detail = 1;
      else detail = 2;
      if (detail < 2) {
        detailed++;
        if (detailed > maxD) detail = 2;
      }
      ant.detail = detail;
      if (detail === 0) ant.thinkInterval = 3 + (ant.id % 3);
      else if (detail === 1) ant.thinkInterval = 10 + (ant.id % 6);
      else {
        ant.thinkInterval = 30 + (ant.id % 20);
        if (ant.task !== TASK.RETURN && ant.task !== TASK.DEPOSIT) ant.task = TASK.IDLE;
      }
    }
    this.metrics.antsDetailed = detailed;
  }

  // ================================================================ formigas
  spawnAnt(colony, role, opts = {}) {
    if (this.ants.size >= this.maxAntsTotal) return null;
    const ant = new Ant(this, colony, { role, ...opts });
    ant._kind = 'ant';
    this.ants.set(ant.id, ant);
    this.antIndex.add(ant);
    colony.ants.add(ant);
    colony.population[roleKey(role)] = (colony.population[roleKey(role)] || 0) + 1;
    colony.totalPopulation++;
    return ant;
  }

  removeAnt(ant) {
    ant.alive = false;
    this.ants.delete(ant.id);
    this.antIndex.remove(ant);
  }

  onAntDeath(ant, source) {
    const colony = this.colonies.get(ant.colonyId);
    if (colony) {
      colony.population[roleKey(ant.role)] = Math.max(0, (colony.population[roleKey(ant.role)] || 0) - 1);
      colony.totalPopulation = Math.max(0, colony.totalPopulation - 1);
      if (ant.role === ROLE.QUEEN && colony.queen === ant) {
        colony.queen = null;
        colony.queenDead = true;
      }
      if (ant.role === ROLE.LARVA) {
        colony.brood.lost = (colony.brood.lost || 0) + 1;
        colony.alert('brood', 'Uma larva foi perdida', ant.x, ant.y, 6000);
      }
    }
    if (ant.role !== ROLE.LARVA) {
      this.economy.spawnCorpse(ant.x, ant.y, RESOURCE.INSECT, ant.role === ROLE.SOLDIER ? 8 : 4);
    }
    this.antIndex.remove(ant);
  }

  tickAnts(dt) {
    const phase = this.tick & 1;
    for (const ant of this.ants.values()) {
      if (!ant.alive) continue;
      if (ant.role === ROLE.LARVA) continue;
      if (ant.detail >= 2) continue;
      if (ant.detail === 1 && ((ant.id + phase) & 1) !== 0) continue;
      ant.age += dt;
      if (ant.attackCd > 0) ant.attackCd--;
      if (this.tick >= ant.nextThink) {
        think(ant, this);
        this.metrics.aiThinks++;
      }
      this.executeTask(ant, dt);
      this.updatePheromones(ant);
      ant.updateFlags();
    }
  }

  updatePheromones(ant) {
    if (ant.pheroCd > 0) { ant.pheroCd--; return; }
    ant.pheroCd = 8 + (ant.id % 5);
    if (!ant.carrying) return;
    const chunk = this.chunks.chunks.get(`${Math.floor(ant.x / CHUNK_PX)},${Math.floor(ant.y / CHUNK_PX)}`);
    if (!chunk) return;
    chunk.depositPhero(ant.x, ant.y, PHERO.FOOD, ant.role === ROLE.SCOUT ? 3.5 : 2.2);
  }

  executeTask(ant, dt) {
    switch (ant.task) {
      case TASK.FORAGE: return this.taskForage(ant, dt);
      case TASK.DEPOSIT: return this.taskDeposit(ant, dt);
      case TASK.RETURN: return this.taskReturn(ant, dt);
      case TASK.BUILD: return this.taskBuild(ant, dt);
      case TASK.REPAIR: return this.taskRepair(ant, dt);
      case TASK.NURSE: return this.taskNurse(ant, dt);
      case TASK.ATTACK: return this.taskAttack(ant, dt);
      case TASK.EAT: return this.taskEat(ant, dt);
      case TASK.ESCORT: return this.taskEscort(ant, dt);
      case TASK.PATROL:
      case TASK.EXPLORE:
      case TASK.FLEE:
      case TASK.DEFEND:
        return this.taskMove(ant, dt);
      default:
        // ociosa: anda um pouco e repensa logo
        if (ant.detail === 0 && Math.random() < 0.3) {
          const a = Math.random() * Math.PI * 2;
          ant.moveToward(ant.x + Math.cos(a) * 60, ant.y + Math.sin(a) * 60, dt);
        }
        ant.nextThink = Math.min(ant.nextThink, this.tick + 6);
    }
  }

  taskMove(ant, dt) {
    const d = dist(ant.x, ant.y, ant.target.x, ant.target.y);
    if (d < 22) {
      ant.nextThink = this.tick + 2;
      return;
    }
    ant.moveToward(ant.target.x, ant.target.y, dt);
  }

  taskForage(ant, dt) {
    const node = this.findNode(ant.targetId, ant.x, ant.y);
    if (!node || node.amount <= 0) {
      ant.setTask(TASK.IDLE);
      ant.nextThink = this.tick + 2;
      return;
    }
    ant.target.x = node.x; ant.target.y = node.y;
    const d = dist(ant.x, ant.y, node.x, node.y);
    if (d > 20) { ant.moveToward(node.x, node.y, dt); return; }
    const done = ant.work(dt, 1.1, () => {
      const got = this.resources.harvest(node, Math.min(ant.carryCap, 8));
      if (got > 0) {
        ant.cargo = { kind: node.kind, amount: got };
        ant.gatherStreak++;
        const colony = ant.colony;
        if (colony) {
          colony.stats.gathered += got;
          const m = ant.role === ROLE.SCOUT ? 'exploration' : 'industry';
          if (colony.personality) colony.personality[m] = Math.min(1, colony.personality[m] + 0.001);
        }
        this.sense.discover(ant.colonyId, node);
      }
      ant.setTask(TASK.DEPOSIT, ant.colony.nest, 'colony', ant.colonyId);
      return true;
    });
    if (!done) ant.state = 2;
  }

  taskDeposit(ant, dt) {
    const colony = ant.colony;
    if (!colony) { ant.setTask(TASK.IDLE); return; }
    const d = dist(ant.x, ant.y, colony.nest.x, colony.nest.y);
    if (d > 46) { ant.moveToward(colony.nest.x, colony.nest.y, dt); return; }
    if (ant.cargo.amount > 0) {
      const accepted = colony.addStock(ant.cargo.kind, ant.cargo.amount);
      if (accepted < ant.cargo.amount) {
        const lost = ant.cargo.amount - accepted;
        if (lost >= 3 && Math.random() < 0.4) {
          colony.alert('storage', `Armazenamento cheio: ${lost} de ${RESOURCE_INFO[ant.cargo.kind].name} se perdeu`, colony.nest.x, colony.nest.y, 5000);
        }
      }
      ant.cargo = { kind: -1, amount: 0 };
    }
    ant.state = 0;
    ant.setTask(TASK.IDLE);
    ant.nextThink = this.tick + 1;
  }

  taskReturn(ant, dt) {
    const colony = ant.colony;
    const d = dist(ant.x, ant.y, colony.nest.x, colony.nest.y);
    if (d > 46) { ant.moveToward(colony.nest.x, colony.nest.y, dt); return; }
    // exploradora "reporta": reforça a trilha e avisa a colônia
    const chunk = this.chunks.chunks.get(`${Math.floor(colony.nest.x / CHUNK_PX)},${Math.floor(colony.nest.y / CHUNK_PX)}`);
    if (chunk) chunk.depositPhero(colony.nest.x, colony.nest.y, PHERO.FOOD, 6);
    ant.setTask(TASK.EXPLORE, this.pickExplorePoint(ant, 1400), 'point');
  }

  taskBuild(ant, dt) {
    const st = this.structureIndex.get(ant.targetId);
    if (!st || st.progress >= 100) {
      ant.setTask(TASK.IDLE);
      ant.nextThink = this.tick + 2;
      return;
    }
    const d = dist(ant.x, ant.y, st.wx, st.wy);
    if (d > 34) { ant.moveToward(st.wx, st.wy, dt); return; }
    this.build.contribute(st, ant, dt);
    ant.state = 2;
    if (this.tick >= ant.nextThink) ant.nextThink = this.tick + 8;
  }

  taskRepair(ant, dt) {
    const st = this.structureIndex.get(ant.targetId);
    if (!st || st.hp >= st.maxHp) { ant.setTask(TASK.IDLE); return; }
    const d = dist(ant.x, ant.y, st.wx, st.wy);
    if (d > 34) { ant.moveToward(st.wx, st.wy, dt); return; }
    const colony = ant.colony;
    if (colony && colony.stock.material >= 0.02) {
      colony.stock.material = Math.max(0, colony.stock.material - 0.02);
      this.build.repair(st, 6, dt);
    }
    ant.state = 2;
  }

  taskNurse(ant, dt) {
    const larva = this.ants.get(ant.targetId);
    if (!larva || !larva.alive || larva.role !== ROLE.LARVA) {
      ant.setTask(TASK.IDLE);
      ant.nextThink = this.tick + 2;
      return;
    }
    const d = dist(ant.x, ant.y, larva.x, larva.y);
    if (d > 26) { ant.moveToward(larva.x, larva.y, dt); return; }
    larva.nursed = true;
    ant.state = 2;
    ant.workTimer += dt;
    if (ant.workTimer > 2.5) {
      ant.workTimer = 0;
      ant.nextThink = this.tick + 2;
    }
  }

  taskAttack(ant, dt) {
    const obj = this.resolveTarget(ant.targetKind, ant.targetId);
    if (!obj || obj.dead || obj.alive === false) {
      // alvo sumiu: procura outro ou volta ao trabalho
      ant.setTask(TASK.IDLE);
      ant.nextThink = this.tick + 1;
      return;
    }
    ant.target.x = obj.x;
    ant.target.y = obj.y;
    const d = dist(ant.x, ant.y, obj.x, obj.y);
    const range = ant.targetKind === 'predator' ? 34 : 28;
    if (d > range) {
      const speedBoost = ant.role === ROLE.SOLDIER ? 1.12 : 1;
      ant.moveToward(obj.x, obj.y, dt * speedBoost);
      return;
    }
    this.combat.antVsTarget(ant, obj);
    ant.state = 3;
    // reforça alarme
    const chunk = this.chunks.chunks.get(`${Math.floor(ant.x / CHUNK_PX)},${Math.floor(ant.y / CHUNK_PX)}`);
    if (chunk && ant.id % 3 === 0) chunk.depositPhero(ant.x, ant.y, PHERO.ALARM, 6);
  }

  taskEat(ant, dt) {
    const colony = ant.colony;
    if (!colony) return;
    const d = dist(ant.x, ant.y, colony.nest.x, colony.nest.y);
    if (d > 34) { ant.moveToward(colony.nest.x, colony.nest.y, dt); return; }
    const ate = ant.eatFromColony();
    if (ate) {
      ant.cargo = { kind: -1, amount: 0 };
      ant.setTask(TASK.IDLE);
      ant.nextThink = this.tick + 2;
    } else {
      // sem comida na colônia: forragear imediatamente
      const node = this.sense.nodesNear(ant.x, ant.y, 900).find((n) => n.amount > 0);
      if (node) ant.setTask(TASK.FORAGE, { x: node.x, y: node.y }, 'node', node.id);
      else ant.setTask(TASK.EXPLORE, this.pickExplorePoint(ant, 900), 'point');
    }
  }

  taskEscort(ant, dt) {
    const ward = this.ants.get(ant.targetId);
    if (!ward || !ward.alive) { ant.setTask(TASK.IDLE); ant.escort = null; return; }
    const d = dist(ant.x, ant.y, ward.x, ward.y);
    if (d > 50) ant.moveToward(ward.x, ward.y, dt);
    else if (Math.random() < 0.2) {
      ant.nextThink = Math.min(ant.nextThink, this.tick + 5);
    }
  }

  resolveTarget(kind, id) {
    if (kind === 'predator') return this.predators.predators.get(id);
    if (kind === 'ant') return this.ants.get(id);
    if (kind === 'player') return this.players.getById(id);
    if (kind === 'structure') return this.structureIndex.get(id);
    if (kind === 'colony') {
      const c = this.colonies.get(id);
      return c ? { x: c.nest.x, y: c.nest.y, _kind: 'colony', colony: c } : null;
    }
    return null;
  }

  findNode(id, x, y) {
    if (id == null) return null;
    if (id > 0) {
      const cx = Math.floor(id / 1_000_000);
      const cy = Math.floor((id % 1_000_000) / 1_000);
      const chunk = this.chunks.chunks.get(`${cx},${cy}`);
      return chunk?.nodesById.get(id) ?? null;
    }
    // nós dinâmicos (carcaças/eventos): procura no chunk atual
    const { cx, cy } = this.chunkOf(x, y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const chunk = this.chunks.chunks.get(`${cx + dx},${cy + dy}`);
        const n = chunk?.nodesById.get(id);
        if (n) return n;
      }
    }
    return null;
  }

  // ================================================================ utilidades
  chunkOf(x, y) {
    return { cx: Math.floor(x / CHUNK_PX), cy: Math.floor(y / CHUNK_PX) };
  }

  tileInfo(x, y) {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    const key = tx * 4096 + ty;
    let info = this.tileCache.get(key);
    if (info) return info;
    if (this.tileCache.size > MAX_TILE_CACHE) this.tileCache.clear();
    const wx = tx * TILE + TILE / 2;
    const wy = ty * TILE + TILE / 2;
    info = { w: isWater(this.seed, wx, wy), b: biomeAt(this.seed, wx, wy) };
    this.tileCache.set(key, info);
    return info;
  }

  isWaterCached(x, y) { return this.tileInfo(x, y).w; }
  biomeSafe(x, y) { return this.tileInfo(x, y).b; }
  terrainSpeedAt(x, y) { return BIOME_INFO[this.tileInfo(x, y).b]?.speed ?? 1; }

  sectorLabel(x, y) {
    const { cx, cy } = this.chunkOf(x, y);
    return `${sectorName(this.seed, cx, cy)} [${cx},${cy}]`;
  }

  chunkBiomeAt(x, y) {
    const { cx, cy } = this.chunkOf(x, y);
    return { id: chunkBiome(this.seed, cx, cy), ...BIOME_INFO[chunkBiome(this.seed, cx, cy)] };
  }

  pickExplorePoint(ant, radius) {
    const colony = ant.colony;
    const cx = colony?.nest.x ?? ant.x;
    const cy = colony?.nest.y ?? ant.y;
    for (let i = 0; i < 4; i++) {
      const baseAngle = Math.atan2(ant.y - cy, ant.x - cx);
      const angle = baseAngle + (Math.random() - 0.5) * 2.4;
      const r = radius * (0.4 + Math.random() * 0.9);
      const x = clamp(ant.x + Math.cos(angle) * r, 32, this.sizePx - 32);
      const y = clamp(ant.y + Math.sin(angle) * r, 32, this.sizePx - 32);
      if (!this.isWaterCached(x, y)) return { x, y };
    }
    return { x: ant.x, y: ant.y };
  }

  coloniesNear(x, y, chunkRadius = 3) {
    const out = [];
    const limit = chunkRadius * CHUNK_PX;
    for (const c of this.colonies.values()) {
      if (Math.abs(c.nest.x - x) <= limit && Math.abs(c.nest.y - y) <= limit) out.push(c);
    }
    return out;
  }

  populationCapFor(colony) {
    const structures = colony.structures.size;
    return Math.min(240, 26 + structures * 5 + (colony.isAi ? 30 : 14));
  }

  effectiveBuildBonus(colonyId) {
    const c = this.colonies.get(colonyId);
    if (!c) return 1;
    return 1 + c.morale / 250;
  }

  spendFood(colony, amount) {
    return colony.takeFood(amount);
  }

  activityAnchors() {
    const anchors = [];
    for (const p of this.players.bySession.values()) {
      if (p.alive) anchors.push({ x: p.x, y: p.y, kind: 'player' });
    }
    for (const c of this.colonies.values()) {
      anchors.push({ x: c.nest.x, y: c.nest.y, kind: 'colony' });
    }
    return anchors;
  }

  activeChunks() {
    const set = new Set();
    for (const p of this.players.bySession.values()) {
      if (!p.alive) continue;
      const { cx, cy } = this.chunkOf(p.x, p.y);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set.add(`${cx + dx},${cy + dy}`);
      }
    }
    for (const c of this.colonies.values()) {
      const { cx, cy } = this.chunkOf(c.nest.x, c.nest.y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) set.add(`${cx + dx},${cy + dy}`);
      }
    }
    return set;
  }

  cleanupStructures() {
    // remove referências de estruturas destruídas que ficaram nos mapas
    for (const c of this.colonies.values()) {
      for (const [id, s] of c.structures) {
        if (s.hp <= 0 || !this.structureIndex.has(id)) c.structures.delete(id);
      }
    }
  }

  gc() {
    const keep = this.activeChunks();
    const removed = this.chunks.unloadCold(this.tick, keep, 600, 260);
    if (removed) this.log?.debug(`Descarregados ${removed} chunks frios (ativos: ${this.chunks.chunks.size})`);
    this.players.gc(NET.reconnectGraceMs * 2);
    this.tileCache.size > MAX_TILE_CACHE && this.tileCache.clear();
    this.metrics.chunksLoaded = this.chunks.chunks.size;
  }

  // ================================================================ ações de jogador
  /**
   * Única porta de entrada para ações do jogador. Sempre chamada no servidor.
   * @returns {{ok:boolean, reason?:string, data?:any}}
   */
  handleAction(player, action, now = Date.now()) {
    if (!player) return { ok: false, reason: 'Sessão inválida' };
    if (!player.alive) {
      if (action?.type === 'respawn') {
        this.players.respawn(player);
        return { ok: true, data: { respawn: true } };
      }
      return { ok: false, reason: 'Você está morto — aguarde o respawn' };
    }
    if (player.isBusy(now)) return { ok: false, reason: 'Aguarde um instante' };
    const colony = player.colonyId ? this.colonies.get(player.colonyId) : null;

    switch (action?.type) {
      case 'gather': {
        const node = this.findNode(action.nodeId, player.x, player.y) ?? this.nearestNodeToPlayer(player);
        if (!node) return { ok: false, reason: 'Nenhum recurso por perto' };
        if (dist(player.x, player.y, node.x, node.y) > 46) return { ok: false, reason: 'Longe do recurso' };
        if (node.amount <= 0) return { ok: false, reason: 'Recurso esgotado' };
        if (player.carrying.amount >= player.carryCap) return { ok: false, reason: 'Inventário cheio' };
        if (player.carrying.kind !== -1 && player.carrying.kind !== node.kind) {
          return { ok: false, reason: `Entregue ${RESOURCE_INFO[player.carrying.kind].name} antes de coletar outro tipo` };
        }
        const got = this.resources.harvest(node, 1);
        if (!got) return { ok: false, reason: 'Recurso esgotado' };
        player.carrying = { kind: node.kind, amount: player.carrying.amount + got };
        player.stats.gathered += got;
        player.lockAction(now, 650);
        if (colony) {
          colony.stats.gathered += got;
          const m = colony.members.get(player.sessionId);
          if (m) m.contribution += got;
        }
        return { ok: true, data: { kind: node.kind, amount: player.carrying.amount, nodeAmount: node.amount } };
      }

      case 'deposit': {
        if (!colony) return { ok: false, reason: 'Você não pertence a uma colônia' };
        if (player.carrying.amount <= 0) return { ok: false, reason: 'Nada para entregar' };
        const structures = [...colony.structures.values()].filter((s) => s.progress >= 100);
        let near = dist(player.x, player.y, colony.nest.x, colony.nest.y) < 110;
        if (!near) {
          near = structures.some((s) => (s.type === BUILDING.STORAGE || s.type === BUILDING.EXIT || s.type === BUILDING.FEEDING) &&
            Math.hypot(player.x - s.wx, player.y - s.wy) < 90);
        }
        if (!near) return { ok: false, reason: 'Aproxime-se do ninho ou de um depósito' };
        const accepted = colony.addStock(player.carrying.kind, player.carrying.amount);
        const lost = player.carrying.amount - accepted;
        player.carrying = { kind: -1, amount: 0 };
        player.lockAction(now, 250);
        if (lost > 0) return { ok: true, data: { accepted, lost, message: 'Armazenamento cheio — parte se perdeu' } };
        return { ok: true, data: { accepted } };
      }

      case 'build': {
        if (!colony) return { ok: false, reason: 'Você precisa de uma colônia' };
        const type = Number(action.building);
        if (!BUILDING_INFO[type]) return { ok: false, reason: 'Construção inválida' };
        const here = this.chunkOf(player.x, player.y);
        // o cliente pode apontar um setor vizinho; validamos o alcance aqui.
        const cx = Number.isFinite(action.cx) ? Math.round(action.cx) : here.cx;
        const cy = Number.isFinite(action.cy) ? Math.round(action.cy) : here.cy;
        if (Math.abs(cx - here.cx) > 1 || Math.abs(cy - here.cy) > 1) {
          return { ok: false, reason: 'Longe do local da obra' };
        }
        const chunk = this.chunks.get(cx, cy);
        if (!chunk) return { ok: false, reason: 'Setor desconhecido' };
        const gx = action.gx ?? Math.floor((player.x - chunk.originX) / TILE);
        const gy = action.gy ?? Math.floor((player.y - chunk.originY) / TILE);
        const res = this.build.create(colony, type, cx, cy, gx, gy, player.sessionId);
        if (!res.ok) return res;
        player.stats.built++;
        player.lockAction(now, 350);
        const m = colony.members.get(player.sessionId);
        if (m) m.contribution += 5;
        return { ok: true, data: { id: res.structure.id, structure: serializeStructure(res.structure) } };
      }

      case 'work': {
        const st = this.structureIndex.get(action.id);
        if (!st) return { ok: false, reason: 'Estrutura inexistente' };
        const own = colony && st.colonyId === colony.id;
        if (!own) return { ok: false, reason: 'Estrutura de outra colônia' };
        if (st.progress < 100) {
          if (colony.can(player.sessionId, 'build') === false) return { ok: false, reason: 'Sem permissão' };
          if (dist(player.x, player.y, st.wx, st.wy) > 90) return { ok: false, reason: 'Aproxime-se da obra' };
          this.build.contribute(st, player, 0.35, true);
          player.stats.built += 0;
          player.lockAction(now, 300);
          return { ok: true, data: { progress: st.progress, id: st.id } };
        }
        if (st.hp < st.maxHp) {
          if (dist(player.x, player.y, st.wx, st.wy) > 90) return { ok: false, reason: 'Aproxime-se da estrutura' };
          if (!colony.spend({ material: 1 })) return { ok: false, reason: 'Sem material para reparo' };
          this.build.repair(st, 1, 0.35);
          player.lockAction(now, 300);
          return { ok: true, data: { hp: st.hp, id: st.id } };
        }
        return { ok: false, reason: 'Nada a fazer aqui' };
      }

      case 'demolish': {
        const st = this.structureIndex.get(action.id);
        if (!st) return { ok: false, reason: 'Estrutura inexistente' };
        const res = this.build.demolish(st, player.sessionId);
        if (!res.ok) return res;
        this.structureIndex.delete(st.id);
        player.lockAction(now, 400);
        return { ok: true, data: { refund: res.refund } };
      }

      case 'attack': {
        const target = this.resolveTarget(action.kind, action.id);
        if (!target) return { ok: false, reason: 'Alvo inexistente' };
        if (target.dead || target.alive === false) return { ok: false, reason: 'Alvo já está morto' };
        if (dist(player.x, player.y, target.x, target.y) > 52) return { ok: false, reason: 'Alvo fora de alcance' };
        if (action.kind === 'ant') {
          const enemy = this.colonies.get(target.colonyId);
          if (!enemy) return { ok: false, reason: 'Alvo inválido' };
          if (colony && enemy.id === colony.id) return { ok: false, reason: 'Não ataque sua própria colônia' };
          enemy.adjustRelation(player.colonyId, -3);
        }
        player.lockAction(now, 600);
        const dmg = 6;
        if (action.kind === 'predator') {
          target.hp -= dmg;
          target.provoked = true;
          target.lastHitBy = player.colonyId;
          if (target.hp <= 0) {
            this.combat.onPredatorKilled(target, { colony: colony ? { id: colony.id, morale: colony.morale, alert: () => {} } : null });
            player.stats.kills++;
          }
        } else if (action.kind === 'ant') {
          target.damage(dmg, player);
          player.stats.kills++;
        } else if (action.kind === 'player') {
          const victim = this.players.getById(action.id);
          if (!victim) return { ok: false, reason: 'Alvo inválido' };
          this.players.damagePlayer(victim, dmg, player.colonyId, player.name);
        } else {
          return { ok: false, reason: 'Esse alvo não pode ser atacado' };
        }
        return { ok: true, data: { hp: Math.round(target.hp) } };
      }

      case 'eat': {
        if (colony) {
          const dNest = dist(player.x, player.y, colony.nest.x, colony.nest.y);
          if (dNest > 120) return { ok: false, reason: 'Volte ao ninho para se alimentar' };
          let ate = false;
          if (player.hunger > 30 && colony.takeFood(1)) { player.hunger = Math.max(0, player.hunger - 45); ate = true; }
          if (player.thirst > 30 && colony.takeWater(1)) { player.thirst = Math.max(0, player.thirst - 45); ate = true; }
          player.lockAction(now, 500);
          return ate ? { ok: true, data: { hunger: player.hunger, thirst: player.thirst } } : { ok: false, reason: 'A colônia não tem comida/água' };
        }
        if (player.carrying.amount > 0) {
          const info = RESOURCE_INFO[player.carrying.kind];
          player.hunger = Math.max(0, player.hunger - info.food * 12);
          player.thirst = Math.max(0, player.thirst - info.water * 12);
          player.carrying.amount -= 1;
          if (player.carrying.amount <= 0) player.carrying = { kind: -1, amount: 0 };
          player.lockAction(now, 500);
          return { ok: true, data: { hunger: player.hunger } };
        }
        return { ok: false, reason: 'Sem colônia e sem comida' };
      }

      case 'setRole': {
        if (!colony) return { ok: false, reason: 'Sem colônia' };
        const res = colony.setMemberRole(player.sessionId, action.sessionId, action.role);
        return res;
      }

      case 'colonyMessage': {
        if (!colony) return { ok: false, reason: 'Sem colônia' };
        colony.alert('message', String(action.text).slice(0, 120), player.x, player.y, 6000);
        return { ok: true };
      }

      default:
        return { ok: false, reason: 'Ação desconhecida' };
    }
  }

  nearestNodeToPlayer(player) {
    const nodes = this.sense.nodesNear(player.x, player.y, 60);
    let best = null, bestD = Infinity;
    for (const n of nodes) {
      const d = dist(player.x, player.y, n.x, n.y);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  // ================================================================ persistência
  serialize() {
    const structures = [];
    for (const colony of this.colonies.values()) {
      for (const s of colony.structures.values()) {
        structures.push({
          id: s.id, type: s.type, cx: s.cx, cy: s.cy, gx: s.gx, gy: s.gy,
          colonyId: s.colonyId, hp: s.hp, progress: s.progress, builtAt: s.builtAt,
        });
      }
    }
    return {
      id: this.id,
      seed: this.seed,
      tick: this.tick,
      savedAt: Date.now(),
      env: { weather: this.env.weather, dayPhase: this.env.dayPhase },
      colonies: [...this.colonies.values()].filter((c) => !c.isAi || c.stats.gathered > 0 || c.structures.size > 0).map((c) => c.toJSON()),
      structures,
      metrics: { ...this.metrics },
      predators: this.predators.countByKind(),
    };
  }

  restore(saved) {
    const log = this.log;
    this.tick = saved.tick ?? 0;
    if (saved.env) {
      this.env.weather = saved.env.weather ?? 'clear';
      this.env.dayPhase = saved.env.dayPhase ?? 0.25;
    }
    for (const cj of saved.colonies ?? []) {
      const colony = Colony.fromJSON(cj);
      colony.ants = new Set();
      colony.knownNodes = new Set();
      this.colonies.set(colony.id, colony);
      if (colony.isAi) this.directors.set(colony.id, new ColonyDirector(this, colony));
    }
    for (const sj of saved.structures ?? []) {
      const colony = this.colonies.get(sj.colonyId);
      if (!colony) continue; // estrutura órfã é ignorada
      const chunk = this.chunks.get(sj.cx, sj.cy);
      const existing = chunk.structures.get(sj.id);
      const st = existing ?? {
        id: sj.id, type: sj.type, cx: sj.cx, cy: sj.cy, gx: sj.gx, gy: sj.gy,
        colonyId: sj.colonyId,
        wx: sj.cx * CHUNK_PX + sj.gx * TILE + TILE / 2,
        wy: sj.cy * CHUNK_PX + sj.gy * TILE + TILE / 2,
        hp: sj.hp, maxHp: BUILDING_INFO[sj.type]?.hp ?? 40,
        progress: sj.progress ?? 100, builtAt: sj.builtAt ?? 0,
        localIdx: sj.gx + sj.gy * CHUNK_TILES, workers: 0,
      };
      if (!existing) chunk.place(st);
      colony.structures.set(st.id, st);
      this.structureIndex.set(st.id, st);
      colony.claim(chunk.key, 1);
      if (nextStructureId() <= st.id) resetStructureSeq(st.id + 1);
    }
    log?.info(`Estado restaurado: ${this.colonies.size} colônias, ${this.structureIndex.size} estruturas, tick ${this.tick}`);
  }

  metricsSnapshot() {
    return {
      tick: this.tick,
      uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      tickMsAvg: Number(this.metrics.tickMsAvg.toFixed(2)),
      tickMsPeak: Number(this.metrics.tickMsPeak.toFixed(2)),
      ants: this.ants.size,
      antsDetailed: this.metrics.antsDetailed,
      predators: this.predators.predators.size,
      players: this.players.stats(),
      colonies: this.colonies.size,
      structures: this.structureIndex.size,
      chunks: this.chunks.chunks.size,
      weather: this.env.weather,
      night: this.env.isNight,
      aiThinks: this.metrics.aiThinks,
    };
  }

  /** População total do mundo (formigas IA + jogadores). */
  totalPopulation() {
    let n = 0;
    for (const c of this.colonies.values()) n += c.totalPopulation || 0;
    return n;
  }
}

function roleKey(role) {
  return role === ROLE.WORKER ? 'worker' : role === ROLE.SCOUT ? 'scout' : role === ROLE.SOLDIER ? 'soldier' : role === ROLE.LARVA ? 'larva' : 'queen';
}

export function serializeStructure(s) {
  return {
    id: s.id, type: s.type, cx: s.cx, cy: s.cy, gx: s.gx, gy: s.gy,
    colonyId: s.colonyId, hp: Math.round(s.hp), maxHp: s.maxHp,
    progress: Math.round(s.progress), wx: s.wx, wy: s.wy,
  };
}

export { emptyStock, TASK_NAME, ROLE_INFO };
