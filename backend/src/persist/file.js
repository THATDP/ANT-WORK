import fs from 'node:fs/promises';
import path from 'node:path';
import { BaseStore } from './base.js';

/**
 * Persistência em arquivo JSON atômico.
 * Usada em desenvolvimento/local e como fallback quando o Postgres cai.
 * Estrutura:
 *   data/snapshots/<worldId>/world.json      -> meta, colônias, estruturas
 *   data/snapshots/<worldId>/nodes.json      -> estado dos nós por chunk
 *   data/snapshots/<worldId>/events.json     -> eventos importantes
 *   data/snapshots/<worldId>/backup-*.json   -> snapshots completos
 */
export class FileStore extends BaseStore {
  constructor(config) {
    super(config);
    this.dir = null;
    this.nodeCache = new Map();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.config.snapshotDir, { recursive: true });
  }

  dirFor(worldId) {
    return path.join(this.config.snapshotDir, worldId);
  }

  async ensureDir(worldId) {
    const d = this.dirFor(worldId);
    await fs.mkdir(d, { recursive: true });
    return d;
  }

  async writeAtomic(file, data) {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fs.rename(tmp, file);
  }

  async saveWorld(world) {
    const d = await this.ensureDir(world.id);
    const data = world.serialize();
    const dirty = [];
    for (const chunk of world.chunks.chunks.values()) {
      const updates = chunk.drainNodeUpdates();
      if (updates.length) dirty.push([chunk.key, updates]);
    }
    for (const [key, updates] of dirty) {
      const cur = this.nodeCache.get(key) ?? {};
      for (const u of updates) cur[u.id] = { amount: Math.round(u.amount * 10) / 10, respawnAt: u.respawnAt };
      this.nodeCache.set(key, cur);
    }
    // serializa escritas para não corromper arquivos
    this.writeQueue = this.writeQueue.then(async () => {
      await this.writeAtomic(path.join(d, 'world.json'), data);
      if (dirty.length) {
        const obj = Object.fromEntries(this.nodeCache);
        await this.writeAtomic(path.join(d, 'nodes.json'), obj);
      }
    }).catch((err) => {
      this.errors++;
      console.error('[persist] falha ao gravar:', err.message);
    });
    await this.writeQueue;
    this.saves++;
    this.lastSaveAt = Date.now();
    return true;
  }

  async loadWorld(worldId) {
    try {
      const d = this.dirFor(worldId);
      const worldRaw = await fs.readFile(path.join(d, 'world.json'), 'utf8');
      const data = JSON.parse(worldRaw);
      let nodeStates = {};
      try {
        const nodesRaw = await fs.readFile(path.join(d, 'nodes.json'), 'utf8');
        nodeStates = JSON.parse(nodesRaw);
        for (const [k, v] of Object.entries(nodeStates)) this.nodeCache.set(k, v);
      } catch { /* primeira execução sem nós alterados */ }
      return { ...data, nodeStates };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return null;
    }
  }

  peekChunkData(chunkKey) {
    const state = this.nodeCache.get(chunkKey);
    if (!state) return null;
    return {
      nodes: Object.entries(state).map(([id, v]) => ({ id: Number(id), amount: v.amount, respawnAt: v.respawnAt })),
      structures: [],
    };
  }

  async saveNodes(worldId, chunkKey, updates) {
    if (!updates?.length) return;
    const cur = this.nodeCache.get(chunkKey) ?? {};
    for (const u of updates) cur[u.id] = { amount: Math.round(u.amount * 10) / 10, respawnAt: u.respawnAt };
    this.nodeCache.set(chunkKey, cur);
    const d = await this.ensureDir(worldId);
    this.writeQueue = this.writeQueue.then(() =>
      this.writeAtomic(path.join(d, 'nodes.json'), Object.fromEntries(this.nodeCache))
    ).catch((err) => { this.errors++; console.error('[persist] falha ao gravar nós:', err.message); });
    await this.writeQueue;
  }

  async saveSnapshot(world, label = 'auto') {
    const d = await this.ensureDir(world.id);
    const file = path.join(d, `backup-${label}-${Date.now()}.json`);
    await this.writeAtomic(file, world.serialize());
    // mantém no máximo 6 backups
    const files = (await fs.readdir(d)).filter((f) => f.startsWith('backup-')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - 6))) {
      await fs.unlink(path.join(d, old)).catch(() => {});
    }
    return true;
  }

  async loadSnapshot(worldId) {
    const d = this.dirFor(worldId);
    try {
      const files = (await fs.readdir(d)).filter((f) => f.startsWith('backup-')).sort();
      if (!files.length) return null;
      const raw = await fs.readFile(path.join(d, files[files.length - 1]), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async saveEvents(worldId, events) {
    const d = await this.ensureDir(worldId);
    const file = path.join(d, 'events.json');
    let prev = [];
    try { prev = JSON.parse(await fs.readFile(file, 'utf8')); } catch { prev = []; }
    const merged = [...prev, ...events].slice(-800);
    await this.writeAtomic(file, merged);
    return true;
  }

  async health() {
    try {
      await fs.access(this.config.snapshotDir);
      return { ok: true, mode: 'file', dir: this.config.snapshotDir, degraded: this.degraded };
    } catch (err) {
      return { ok: false, mode: 'file', error: err.message };
    }
  }
}
