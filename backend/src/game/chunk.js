/**
 * Gerenciamento de chunks (setores) do mundo.
 *
 * Carregamento sob demanda: um chunk só existe em memória quando alguém chega perto
 * ou quando contém estruturas de colônia. Nós de recurso são gerados de forma
 * determinística e depois "hidratados" com o estado persistido (quantidade restante).
 *
 * Cada chunk tem:
 *  - nós de recurso (gerados + estado mutável)
 *  - construções (0..220 por colônia, indexadas por colônia)
 *  - grade de ocupação de tiles (para validação espacial barata)
 *  - dois campos de feromônio (comida e alarme) em 24×24
 *  - contador de atividade para descarregar chunks frios
 */

import {
  BIOME, CHUNK_TILES, CHUNK_PX, TILE, BUILDING_INFO, COLONY_LIMITS,
} from '../../../shared/constants.js';
import { generateChunkNodes, biomeAt, isWater, chunkBiome } from '../../../shared/worldgen.js';

export const PHERO = { FOOD: 0, ALARM: 1 };
const PHERO_SIZE = CHUNK_TILES * CHUNK_TILES * 2;

export class Chunk {
  constructor(seed, cx, cy) {
    this.seed = seed;
    this.cx = cx;
    this.cy = cy;
    this.key = `${cx},${cy}`;
    this.biome = chunkBiome(seed, cx, cy);
    this.nodes = generateChunkNodes(seed, cx, cy);
    this.nodesById = new Map(this.nodes.map((n) => [n.id, n]));
    this.structures = new Map();          // id -> structure
    this.decor = null;                    // gerado pelo cliente
    this.occupancy = new Uint8Array(CHUNK_TILES * CHUNK_TILES); // 0 livre, 1 ocupado
    this.structureIds = new Uint16Array(CHUNK_TILES * CHUNK_TILES);
    this.phero = new Float32Array(PHERO_SIZE);
    this.pheroTouched = false;
    this.antIds = new Set();
    this.lastActive = 0;
    this.persistedNodeState = new Map(); // id -> {amount, respawnAt}
    this.dirtyNodes = new Set();
    this.dirty = false;
    this.resourceVersion = 0;
    this.claims = new Map();              // colonyId -> peso de território
    this.waterMask = null;                // Uint8Array — calculado sob demanda
    this.loaded = true;
  }

  get originX() { return this.cx * CHUNK_PX; }
  get originY() { return this.cy * CHUNK_PX; }

  /** Máscara de água por tile (cache). Evita recalcular ruído a cada passo de formiga. */
  computeWaterMask() {
    if (this.waterMask) return this.waterMask;
    const mask = new Uint8Array(CHUNK_TILES * CHUNK_TILES);
    for (let gy = 0; gy < CHUNK_TILES; gy++) {
      for (let gx = 0; gx < CHUNK_TILES; gx++) {
        const wx = this.originX + gx * TILE + TILE / 2;
        const wy = this.originY + gy * TILE + TILE / 2;
        mask[gy * CHUNK_TILES + gx] = isWater(this.seed, wx, wy) ? 1 : 0;
      }
    }
    this.waterMask = mask;
    return mask;
  }

  isWaterAt(x, y) {
    const gx = Math.floor((x - this.originX) / TILE);
    const gy = Math.floor((y - this.originY) / TILE);
    if (gx < 0 || gy < 0 || gx >= CHUNK_TILES || gy >= CHUNK_TILES) return false;
    return this.computeWaterMask()[gy * CHUNK_TILES + gx] === 1;
  }

  /** Índice de tile local. */
  static cellIndex(gx, gy) { return gy * CHUNK_TILES + gx; }

  inBounds(gx, gy) {
    return gx >= 0 && gy >= 0 && gx < CHUNK_TILES && gy < CHUNK_TILES;
  }

  /** Verifica se uma área (size×size) está livre e em terreno construível. */
  canPlace(seed, gx, gy, size, buildingType) {
    const info = BUILDING_INFO[buildingType];
    for (let y = gy; y <= gy + size - 1; y++) {
      for (let x = gx; x <= gx + size - 1; x++) {
        if (!this.inBounds(x, y)) return { ok: false, reason: 'Fora dos limites do setor' };
        if (this.occupancy[Chunk.cellIndex(x, y)]) return { ok: false, reason: 'Espaço ocupado' };
        const wx = this.originX + x * TILE + TILE / 2;
        const wy = this.originY + y * TILE + TILE / 2;
        if (isWater(seed, wx, wy)) return { ok: false, reason: 'Não é possível construir sobre água' };
        const b = biomeAt(seed, wx, wy);
        if (b === BIOME.ROCK) return { ok: false, reason: 'Rocha dura: escolha solo escavável' };
        if (!info.surface && b === BIOME.CONTAMINATED) return { ok: false, reason: 'Solo contaminado demais' };
      }
    }
    return { ok: true };
  }

  place(structure) {
    const info = BUILDING_INFO[structure.type];
    const cx0 = structure.gx;
    const cy0 = structure.gy;
    for (let y = cy0; y < cy0 + info.size; y++) {
      for (let x = cx0; x < cx0 + info.size; x++) {
        if (!this.inBounds(x, y)) continue;
        this.occupancy[Chunk.cellIndex(x, y)] = 1;
        this.structureIds[Chunk.cellIndex(x, y)] = structure.localIdx;
      }
    }
    this.structures.set(structure.id, structure);
    this.dirty = true;
  }

  remove(structure) {
    const info = BUILDING_INFO[structure.type];
    for (let y = structure.gy; y < structure.gy + info.size; y++) {
      for (let x = structure.gx; x < structure.gx + info.size; x++) {
        if (!this.inBounds(x, y)) continue;
        this.occupancy[Chunk.cellIndex(x, y)] = 0;
        this.structureIds[Chunk.cellIndex(x, y)] = 0;
      }
    }
    this.structures.delete(structure.id);
    this.dirty = true;
  }

  /** Estrutura que cobre um tile local, se houver. */
  structureAt(gx, gy) {
    if (!this.inBounds(gx, gy)) return null;
    const idx = this.structureIds[Chunk.cellIndex(gx, gy)];
    if (!idx) return null;
    for (const s of this.structures.values()) {
      if (s.localIdx === idx) return s;
    }
    return null;
  }

  /** Aplica estado persistido vindo do banco (quantidade restante dos nós). */
  hydrate(nodesState, structures) {
    for (const st of nodesState) {
      const node = this.nodesById.get(st.id);
      if (!node) continue;
      node.amount = Math.max(0, Math.min(node.max, st.amount));
      node.respawnAt = st.respawn_at ?? st.respawnAt ?? 0;
      this.persistedNodeState.set(node.id, { amount: node.amount, respawnAt: node.respawnAt });
    }
    for (const s of structures) {
      if (this.structures.has(s.id)) continue;
      const st = {
        id: s.id, type: s.type, cx: this.cx, cy: this.cy,
        gx: s.gx, gy: s.gy, colonyId: s.colony_id ?? s.colonyId,
        hp: s.hp ?? BUILDING_INFO[s.type].hp,
        progress: s.progress ?? 100,
        builtAt: s.built_at ?? 0,
        localIdx: s.local_idx ?? (s.gx + s.gy * CHUNK_TILES),
        workers: 0,
      };
      this.place(st);
    }
  }

  /** Exporta somente o que mudou desde o último save. */
  drainNodeUpdates() {
    const out = [];
    for (const id of this.dirtyNodes) {
      const node = this.nodesById.get(id);
      if (!node) continue;
      out.push({ id, amount: node.amount, respawnAt: node.respawnAt, max: node.max });
    }
    this.dirtyNodes.clear();
    return out;
  }

  drainStructures() {
    return [...this.structures.values()].map((s) => ({
      id: s.id, type: s.type, gx: s.gx, gy: s.gy, colonyId: s.colonyId,
      hp: s.hp, progress: s.progress, builtAt: s.builtAt,
    }));
  }

  // ------------------------------------------------------------ feromônios
  cellOf(x, y) {
    const gx = Math.floor((x - this.originX) / TILE);
    const gy = Math.floor((y - this.originY) / TILE);
    if (gx < 0 || gy < 0 || gx >= CHUNK_TILES || gy >= CHUNK_TILES) return -1;
    return gy * CHUNK_TILES + gx;
  }

  depositPhero(x, y, kind, amount) {
    const cell = this.cellOf(x, y);
    if (cell < 0) return;
    const i = cell * 2 + kind;
    this.phero[i] = Math.min(100, this.phero[i] + amount);
    this.pheroTouched = true;
  }

  pheroAt(x, y, kind) {
    const cell = this.cellOf(x, y);
    if (cell < 0) return 0;
    return this.phero[cell * 2 + kind];
  }

  /** Amostra o gradiente de feromônio num raio de 2 tiles. */
  pheroGradient(x, y, kind) {
    const cell = this.cellOf(x, y);
    if (cell < 0) return { x: 0, y: 0, v: 0 };
    const gx = cell % CHUNK_TILES;
    const gy = (cell / CHUNK_TILES) | 0;
    let bx = 0, by = 0, best = this.phero[cell * 2 + kind];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = gx + dx, ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= CHUNK_TILES || ny >= CHUNK_TILES) continue;
        const v = this.phero[(ny * CHUNK_TILES + nx) * 2 + kind];
        if (v > best) { best = v; bx = dx; by = dy; }
      }
    }
    if (bx === 0 && by === 0) return { x: 0, y: 0, v: best };
    const l = Math.hypot(bx, by) || 1;
    return { x: bx / l, y: by / l, v: best };
  }

  evaporate(factor) {
    if (!this.pheroTouched) return;
    const arr = this.phero;
    let any = false;
    const step = 4; // processa 1/4 por vez (chamadas alternadas) para custo baixo
    this._evapPhase = (this._evapPhase || 0) + 1;
    const phase = this._evapPhase % step;
    for (let i = phase; i < arr.length; i += step) {
      const v = arr[i] * factor;
      arr[i] = v < 0.6 ? 0 : v;
      if (arr[i] > 0) any = true;
    }
    if (!any) this.pheroTouched = false;
  }
}

export class ChunkManager {
  constructor(world) {
    this.world = world;
    this.chunks = new Map();
  }

  key(cx, cy) { return `${cx},${cy}`; }

  has(cx, cy) { return this.chunks.has(this.key(cx, cy)); }

  get(cx, cy) {
    const k = this.key(cx, cy);
    let c = this.chunks.get(k);
    if (!c) {
      c = new Chunk(this.world.seed, cx, cy);
      const saved = this.world.store?.peekChunkData?.(c.key);
      if (saved) {
        c.hydrate(saved.nodes || [], saved.structures || []);
      }
      this.chunks.set(k, c);
      this.world.onChunkLoaded?.(c);
    }
    c.lastActive = this.world.tick;
    return c;
  }

  getByKey(key) {
    const [cx, cy] = key.split(',').map(Number);
    return this.get(cx, cy);
  }

  /** Chunks com estruturas precisam existir sempre (persistência/colônia). */
  static chunkOfPoint(x, y) {
    return { cx: Math.floor(x / CHUNK_PX), cy: Math.floor(y / CHUNK_PX) };
  }

  forEach(fn) { for (const c of this.chunks.values()) fn(c); }

  /** Descarrega chunks frios e sem estruturas, salvando o estado dos nós. */
  unloadCold(nowTick, keepSet, maxIdleTicks = 900, maxChunks = 260) {
    if (this.chunks.size <= maxChunks) {
      for (const c of this.chunks.values()) {
        if (c.lastActive + maxIdleTicks > nowTick) continue;
        if (c.structures.size > 0 || keepSet.has(c.key)) continue;
        this.world.store?.saveNodes(this.world.worldId, c.key, c.drainNodeUpdates());
        this.chunks.delete(c.key);
      }
      return 0;
    }
    const list = [...this.chunks.values()].sort((a, b) => a.lastActive - b.lastActive);
    let removed = 0;
    for (const c of list) {
      if (this.chunks.size <= maxChunks) break;
      if (c.structures.size > 0 || keepSet.has(c.key)) continue;
      this.world.store?.saveNodes(this.world.worldId, c.key, c.drainNodeUpdates());
      this.chunks.delete(c.key);
      removed++;
    }
    return removed;
  }
}

/** Índice espacial simples por chunk, para consultas de vizinhança em O(1). */
export class SpatialIndex {
  constructor() { this.map = new Map(); }
  key(x, y) { return `${Math.floor(x / CHUNK_PX)},${Math.floor(y / CHUNK_PX)}`; }
  add(ent) {
    const k = this.key(ent.x, ent.y);
    let s = this.map.get(k);
    if (!s) { s = new Set(); this.map.set(k, s); }
    s.add(ent);
    ent._spatialKey = k;
  }
  remove(ent) {
    const s = this.map.get(ent._spatialKey);
    if (s) { s.delete(ent); if (!s.size) this.map.delete(ent._spatialKey); }
    ent._spatialKey = null;
  }
  move(ent) {
    const k = this.key(ent.x, ent.y);
    if (k === ent._spatialKey) return;
    this.remove(ent);
    this.add(ent);
  }
  /** Entidades em chunks próximos (raio em chunks). */
  near(x, y, radiusChunks = 1, out = []) {
    const cx = Math.floor(x / CHUNK_PX), cy = Math.floor(y / CHUNK_PX);
    for (let dy = -radiusChunks; dy <= radiusChunks; dy++) {
      for (let dx = -radiusChunks; dx <= radiusChunks; dx++) {
        const s = this.map.get(`${cx + dx},${cy + dy}`);
        if (s) for (const e of s) out.push(e);
      }
    }
    return out;
  }
  clear() { this.map.clear(); }
}

export { CHUNK_TILES, CHUNK_PX, TILE, COLONY_LIMITS };
