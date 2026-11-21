/**
 * Sensoriamento com custo controlado.
 *
 * - Consultas espaciais usam índice por chunk (O(vizinhos), não O(mundo)).
 * - Nós de recurso são lidos apenas nos chunks próximos.
 * - Conhecimento é compartilhado: quando uma exploradora descobre um nó, a
 *   colônia inteira passa a conhecê-lo (é isso que dá coordenação à IA).
 */

import { CHUNK_PX, ROLE, TASK } from '../../../shared/constants.js';

export class SenseSystem {
  constructor(world) {
    this.world = world;
    this.assignedCount = new Map(); // nodeId -> nº de formigas indo buscar
  }

  nodesNear(x, y, radiusPx) {
    const world = this.world;
    const out = [];
    const rChunks = Math.ceil(radiusPx / CHUNK_PX);
    const cx = Math.floor(x / CHUNK_PX), cy = Math.floor(y / CHUNK_PX);
    for (let dy = -rChunks; dy <= rChunks; dy++) {
      for (let dx = -rChunks; dx <= rChunks; dx++) {
        const chunk = world.chunks.chunks.get(`${cx + dx},${cy + dy}`);
        if (!chunk) continue;
        for (const n of chunk.nodes) {
          if (n.amount <= 0) continue;
          if (Math.abs(n.x - x) > radiusPx || Math.abs(n.y - y) > radiusPx) continue;
          out.push(n);
        }
      }
    }
    return out;
  }

  nodeAssigned(node) {
    return this.assignedCount.get(node.id) || 0;
  }

  recountAssignments() {
    this.assignedCount.clear();
    for (const a of this.world.ants.values()) {
      if (!a.alive || a.targetKind !== 'node' || a.targetId == null) continue;
      this.assignedCount.set(a.targetId, (this.assignedCount.get(a.targetId) || 0) + 1);
    }
  }

  antsNear(x, y, radiusPx, colonyId = null) {
    const out = [];
    const near = this.world.antIndex.near(x, y, 1, []);
    for (const a of near) {
      if (!a.alive) continue;
      if (colonyId && a.colonyId !== colonyId) continue;
      const d2 = (a.x - x) ** 2 + (a.y - y) ** 2;
      if (d2 <= radiusPx * radiusPx) out.push(a);
    }
    return out;
  }

  alliesNear(x, y, radiusPx, colonyId) {
    return this.antsNear(x, y, radiusPx, colonyId);
  }

  enemyAntsNear(x, y, radiusPx, colonyId) {
    const out = [];
    const colony = this.world.colonies.get(colonyId);
    for (const a of this.world.antIndex.near(x, y, 1, [])) {
      if (!a.alive || a.colonyId === colonyId) continue;
      if (a.role === ROLE.LARVA) continue;
      if (!colony || !colony.isHostileTo(a.colonyId)) {
        // sem guerra declarada, soldados não caçam, mas defendem se atacados
        const other = this.world.colonies.get(a.colonyId);
        if (!other || other.relationTo(colonyId) > -25) continue;
      }
      const d2 = (a.x - x) ** 2 + (a.y - y) ** 2;
      if (d2 <= radiusPx * radiusPx) out.push(a);
    }
    return out;
  }

  threatsNear(x, y, radiusPx, colonyId) {
    const out = [];
    for (const p of this.world.predIndex.near(x, y, 1, [])) {
      if (p.dead) continue;
      const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d2 <= radiusPx * radiusPx) out.push(p);
    }
    // jogadores de colônias hostis
    const colony = this.world.colonies.get(colonyId);
    if (colony) {
      for (const pl of this.world.players.near(x, y, radiusPx)) {
        if (!pl.alive || !pl.colonyId || pl.colonyId === colonyId) continue;
        if (colony.isHostileTo(pl.colonyId)) out.push(pl);
      }
      // formigas inimigas
      out.push(...this.enemyAntsNear(x, y, radiusPx, colonyId));
    }
    return out;
  }

  nearestLarva(x, y, colonyId, radiusPx) {
    let best = null, bestD = radiusPx * radiusPx;
    for (const a of this.antsNear(x, y, radiusPx, colonyId)) {
      if (a.role !== ROLE.LARVA) continue;
      const d = (a.x - x) ** 2 + (a.y - y) ** 2;
      if (d < bestD) { bestD = d; best = a; }
    }
    return best;
  }

  nearestLarvaAnywhere(x, y, radiusPx) {
    let best = null, bestD = radiusPx * radiusPx;
    for (const a of this.world.antIndex.near(x, y, 1, [])) {
      if (a.role !== ROLE.LARVA || !a.alive) continue;
      const d = (a.x - x) ** 2 + (a.y - y) ** 2;
      if (d < bestD) { bestD = d; best = a; }
    }
    return best;
  }

  nearestPreyInRange(x, y, radiusPx, sight) {
    let best = null, bestD = radiusPx * radiusPx;
    for (const a of this.world.antIndex.near(x, y, 1, [])) {
      if (!a.alive || a.role === ROLE.LARVA) continue;
      const d = (a.x - x) ** 2 + (a.y - y) ** 2;
      if (d < bestD) { bestD = d; best = a; }
    }
    for (const p of this.world.players.near(x, y, radiusPx)) {
      if (!p.alive) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  nearestBuildSite(colonyId, x, y) {
    const colony = this.world.colonies.get(colonyId);
    if (!colony) return null;
    let best = null, bestD = Infinity;
    for (const s of colony.structures.values()) {
      if (s.progress >= 100) continue;
      const d = (s.wx - x) ** 2 + (s.wy - y) ** 2;
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  nearestDamaged(colonyId, x, y, radiusPx) {
    const colony = this.world.colonies.get(colonyId);
    if (!colony) return null;
    let best = null, bestD = radiusPx * radiusPx;
    for (const s of colony.structures.values()) {
      if (s.progress < 100 || s.hp >= s.maxHp * 0.85) continue;
      const d = (s.wx - x) ** 2 + (s.wy - y) ** 2;
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  nearestCarrier(x, y, colonyId, radiusPx) {
    let best = null, bestD = radiusPx * radiusPx;
    for (const a of this.antsNear(x, y, radiusPx, colonyId)) {
      if (a.role !== ROLE.WORKER || !a.carrying) continue;
      const d = (a.x - x) ** 2 + (a.y - y) ** 2;
      if (d < bestD) { bestD = d; best = a; }
    }
    return best;
  }

  nearestStructureNear(x, y, radiusPx, colonyId) {
    let best = null, bestD = radiusPx * radiusPx;
    const rChunks = Math.ceil(radiusPx / CHUNK_PX);
    const cx = Math.floor(x / CHUNK_PX), cy = Math.floor(y / CHUNK_PX);
    for (let dy = -rChunks; dy <= rChunks; dy++) {
      for (let dx = -rChunks; dx <= rChunks; dx++) {
        const chunk = this.world.chunks.chunks.get(`${cx + dx},${cy + dy}`);
        if (!chunk) continue;
        for (const s of chunk.structures.values()) {
          if (colonyId && s.colonyId !== colonyId) continue;
          const d = (s.wx - x) ** 2 + (s.wy - y) ** 2;
          if (d < bestD) { bestD = d; best = s; }
        }
      }
    }
    return best;
  }

  nearestForeignStructure(colonyId, x, y, extraPad = 0) {
    let best = null, bestD = Infinity;
    const cx = Math.floor(x / CHUNK_PX), cy = Math.floor(y / CHUNK_PX);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const chunk = this.world.chunks.chunks.get(`${cx + dx},${cy + dy}`);
        if (!chunk) continue;
        for (const s of chunk.structures.values()) {
          if (s.colonyId === colonyId) continue;
          const d = Math.hypot(s.wx - x, s.wy - y);
          if (d < bestD) { bestD = d; best = s; }
        }
      }
    }
    return bestD <= extraPad ? best : null;
  }

  isKnown(colonyId, nodeId) {
    return this.world.colonies.get(colonyId)?.knownNodes?.has(nodeId) ?? false;
  }

  discover(colonyId, node) {
    const c = this.world.colonies.get(colonyId);
    if (!c) return;
    if (!c.knownNodes) c.knownNodes = new Set();
    if (c.knownNodes.size > 600) {
      // esquece os mais antigos
      const first = c.knownNodes.values().next().value;
      c.knownNodes.delete(first);
    }
    c.knownNodes.add(node.id);
  }

  /** Limpa referências mortas (chamado junto do GC de entidades). */
  prune() {
    this.assignedCount.clear();
  }
}
