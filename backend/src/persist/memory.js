import { BaseStore } from './base.js';

/** Armazenamento em memória — usado nos testes e em PERSIST=memory. */
export class MemoryStore extends BaseStore {
  constructor(config) {
    super(config);
    this.worlds = new Map();
    this.events = new Map();
    this.snapshots = new Map();
    this.writes = 0;
  }

  async saveWorld(world) {
    const data = world.serialize();
    const nodeStates = {};
    for (const chunk of world.chunks.chunks.values()) {
      const updates = chunk.drainNodeUpdates();
      if (!updates.length) continue;
      nodeStates[chunk.key] = updates.map((u) => ({ ...u }));
    }
    const prev = this.worlds.get(world.id) ?? { nodes: {} };
    this.worlds.set(world.id, {
      ...data,
      nodes: { ...prev.nodes, ...nodeStates },
      savedAt: Date.now(),
    });
    this.writes++;
    this.lastSaveAt = Date.now();
    this.saves++;
    return true;
  }

  async loadWorld(worldId) {
    const w = this.worlds.get(worldId);
    if (!w) return null;
    return { ...w, nodeStates: w.nodes };
  }

  peekChunkData(chunkKey) {
    for (const w of this.worlds.values()) {
      if (w.nodes?.[chunkKey]) {
        return { nodes: w.nodes[chunkKey], structures: [] };
      }
    }
    return null;
  }

  async saveNodes(worldId, chunkKey, updates) {
    if (!updates?.length) return;
    const w = this.worlds.get(worldId);
    if (!w) return;
    w.nodes = w.nodes ?? {};
    const cur = w.nodes[chunkKey] ?? {};
    for (const u of updates) cur[u.id] = { amount: Math.round(u.amount * 10) / 10, respawnAt: u.respawnAt };
    w.nodes[chunkKey] = cur;
    this.writes++;
  }

  async saveSnapshot(world, label = 'auto') {
    const list = this.snapshots.get(world.id) ?? [];
    // clona de verdade: um snapshot não pode mudar depois de tirado
    list.push({ label, at: Date.now(), data: JSON.parse(JSON.stringify(world.serialize())) });
    while (list.length > 6) list.shift();
    this.snapshots.set(world.id, list);
    return true;
  }

  async loadSnapshot(worldId) {
    const list = this.snapshots.get(worldId);
    return list?.length ? list[list.length - 1].data : null;
  }

  async saveEvents(worldId, events) {
    const list = this.events.get(worldId) ?? [];
    list.push(...events);
    this.events.set(worldId, list.slice(-500));
    return true;
  }

  async health() { return { ok: true, mode: 'memory' }; }
}
