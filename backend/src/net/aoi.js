/**
 * Área de interesse (AOI) — o coração do multiplayer escalável.
 *
 * O servidor assina os chunks ao redor do jogador e envia somente:
 *   - entidades novas ("add"), posições que mudaram ("up"), saídas ("rm");
 *   - estruturas e nós apenas quando as revisões do chunk mudam;
 *   - estado do próprio jogador e resumo da colônia.
 *
 * Nenhuma formiga IA é transmitida fora do AOI. Nada de posições absolutas em
 * alta frequência: quantização de 0.25 px + interpolação no cliente.
 */

import { CHUNK_PX, NET, QUANT } from '../../../shared/constants.js';


const q = (v) => Math.round(v / QUANT) * QUANT;

export class InterestManager {
  constructor(world) {
    this.world = world;
    this.stats = { bytes: 0, snapshots: 0, entities: 0, avgBytes: 0 };
  }

  initClient(socket) {
    socket.data.net = {
      ents: new Map(),        // id -> [x,y,role,task,hp,state,carryKind,carryAmt,flags]
      preds: new Map(),
      players: new Map(),
      structures: new Map(),
      chunkRev: new Map(),
      lastFullTick: -999,
      lastSnapTick: -1,
    };
  }

  aoiChunks(player, radiusChunks = NET.aoiRadiusChunks) {
    const cx = Math.floor(player.x / CHUNK_PX);
    const cy = Math.floor(player.y / CHUNK_PX);
    const out = [];
    for (let dy = -radiusChunks; dy <= radiusChunks; dy++) {
      for (let dx = -radiusChunks; dx <= radiusChunks; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= this.world.chunksAcross || ny >= this.world.chunksAcross) continue;
        out.push(`${nx},${ny}`);
      }
    }
    return out;
  }

  /**
   * Monta o snapshot de um jogador. `mode`:
   *   'move' → posições (5 Hz)
   *   'full' → entidades completas + estruturas + nós (2 Hz)
   */
  build(socket, player, mode = 'move', now = Date.now()) {
    const net = socket.data.net;
    const world = this.world;
    const tick = world.tick;
    const chunks = this.aoiChunks(player, player.aoiRadius ?? NET.aoiRadiusChunks);
    const chunkSet = new Set(chunks);
    const payload = { t: tick };

    const up = [];
    const add = [];
    const seen = new Set();

    for (const key of chunks) {
      const set = world.antIndex.map.get(key);
      if (set) {
        for (const a of set) {
          if (!a.alive) continue;
          seen.add(a.id);
          const prev = net.ents.get(a.id);
          const x = q(a.x), y = q(a.y);
          if (!prev) {
            const packed = [a.id, x, y, a.role, a.task, Math.round(a.hp), a.state, a.cargo.kind, Math.round(a.cargo.amount), a.flags];
            add.push(packed);
            net.ents.set(a.id, packed);
          } else if (prev[1] !== x || prev[2] !== y || prev[6] !== a.state) {
            prev[1] = x; prev[2] = y; prev[6] = a.state;
            up.push(a.id, x, y, a.state);
          }
        }
      }
    }
    const rm = [];
    for (const id of net.ents.keys()) {
      if (!seen.has(id)) { rm.push(id); net.ents.delete(id); }
    }

    // predadores
    const pUp = [], pAdd = [], pRm = [];
    const pSeen = new Set();
    for (const key of chunks) {
      const set = world.predIndex.map.get(key);
      if (!set) continue;
      for (const p of set) {
        if (p.dead) continue;
        pSeen.add(p.id);
        const prev = net.preds.get(p.id);
        const x = q(p.x), y = q(p.y);
        if (!prev) {
          const packed = [p.id, x, y, p.type, Math.round(p.hp), p.state];
          pAdd.push(packed); net.preds.set(p.id, packed);
        } else if (prev[1] !== x || prev[2] !== y || prev[5] !== p.state || prev[4] !== Math.round(p.hp)) {
          prev[1] = x; prev[2] = y; prev[4] = Math.round(p.hp); prev[5] = p.state;
          pUp.push(p.id, x, y, p.state, Math.round(p.hp));
        }
      }
    }
    for (const id of net.preds.keys()) if (!pSeen.has(id)) { pRm.push(id); net.preds.delete(id); }

    // jogadores (poucos, sempre completos)
    const plSeen = new Set();
    const pl = [];
    for (const p of world.players.bySession.values()) {
      if (!p.alive) continue;
      if (Math.abs(p.x - player.x) > CHUNK_PX * 3 || Math.abs(p.y - player.y) > CHUNK_PX * 3) continue;
      plSeen.add(p.id);
      pl.push([p.id, q(p.x), q(p.y), p.name, p.colonyId ?? '', p.hp, p.carrying.kind, p.color]);
    }
    for (const id of net.players.keys()) if (!plSeen.has(id)) net.players.delete(id);
    for (const e of pl) net.players.set(e[0], e);

    const procFull = mode === 'full';
    if (add.length) payload.add = add;
    if (up.length) payload.up = up;
    if (rm.length) payload.rm = rm;
    if (pAdd.length) payload.padd = pAdd;
    if (pUp.length) payload.pup = pUp;
    if (pRm.length) payload.prm = pRm;
    if (pl.length) payload.pl = pl;

    // estruturas e recursos: só quando a revisão do chunk muda
    if (procFull) {
      const structs = [];
      const nodeChunks = [];
      for (const key of chunks) {
        const chunk = world.chunks.chunks.get(key);
        if (!chunk) continue;
        const rev = chunk.resourceVersion;
        const prevRev = net.chunkRev.get(key);
        if (prevRev !== rev) {
          net.chunkRev.set(key, rev);
          const nodes = [];
          for (const n of chunk.nodes) {
            if (n.amount <= 0 && n.id > 0) continue;
            nodes.push(n.id, Math.round(n.x), Math.round(n.y), n.kind, Math.round(n.amount), n.max);
          }
          nodeChunks.push([key, rev, nodes]);
        }
        for (const s of chunk.structures.values()) {
          const sig = `${s.id}:${Math.round(s.progress / 10)}:${Math.round(s.hp)}:${s.colonyId}`;
          const prev = net.structures.get(s.id);
          if (prev !== sig) {
            net.structures.set(s.id, sig);
            structs.push([s.id, s.cx, s.cy, s.gx, s.gy, s.type, s.colonyId, Math.round(s.hp), Math.round(s.progress), s.wx, s.wy]);
          }
        }
      }
      // estruturas que saíram do AOI / foram destruídas
      const removedStructs = [];
      const aliveStructs = new Set();
      for (const key of chunks) {
        const chunk = world.chunks.chunks.get(key);
        if (chunk) for (const s of chunk.structures.keys()) aliveStructs.add(s);
      }
      for (const id of net.structures.keys()) {
        if (!aliveStructs.has(id)) { removedStructs.push(id); net.structures.delete(id); }
      }
      if (structs.length) payload.st = structs;
      if (removedStructs.length) payload.strm = removedStructs;
      if (nodeChunks.length) payload.nd = nodeChunks;
      // revisões de chunks que saíram do AOI (limpeza)
      for (const key of net.chunkRev.keys()) if (!chunkSet.has(key)) net.chunkRev.delete(key);
    }

    // estado do jogador (sempre que muda algo relevante)
    payload.self = [
      q(player.x), q(player.y), Math.round(player.hp), Math.round(player.hunger),
      Math.round(player.thirst), player.carrying.kind, player.carrying.amount,
      player.alive ? 1 : 0, player.respawnAt ?? 0, player.colonyId ?? '', player.dir,
    ];

    // relógio/ambiente (a cada 1s)
    if (procFull) {
      const env = world.env.describe();
      payload.env = [env.day, env.part, env.weatherKey, env.temperature, env.night ? 1 : 0, env.phase];
    }

    const bytes = estimateBytes(payload);
    this.stats.bytes += bytes;
    this.stats.snapshots++;
    this.stats.entities += add.length + up.length / 4;
    this.stats.avgBytes = Math.round(this.stats.bytes / this.stats.snapshots);
    return payload;
  }

  /** Estado agregado da colônia (2 Hz). */
  buildColonyState(player) {
    const world = this.world;
    const colony = player.colonyId ? world.colonies.get(player.colonyId) : null;
    if (!colony) {
      return {
        colony: null,
        nearby: world.coloniesNear(player.x, player.y, 3).map((c) => ({
          id: c.id, name: c.name, color: c.color, pop: c.totalPopulation, isAi: c.isAi,
          dist: Math.round(Math.hypot(c.nest.x - player.x, c.nest.y - player.y)),
        })),
      };
    }
    const needs = colony.needs ?? {};
    return {
      colony: {
        id: colony.id, name: colony.name, color: colony.color,
        stock: colony.stock, cap: colony.storageCap, morale: Math.round(colony.morale),
        pop: colony.population, totalPop: colony.totalPopulation,
        structures: [...colony.structures.values()].map((s) => ({
          id: s.id, type: s.type, progress: Math.round(s.progress), hp: Math.round(s.hp),
          maxHp: s.maxHp, cx: s.cx, cy: s.cy, gx: s.gx, gy: s.gy,
        })),
        pending: colony.pendingBuilds ?? 0,
        eggs: colony.brood.eggs, larva: colony.population.larva,
        queen: colony.queen ? { hp: Math.round(colony.queen.hp), alive: colony.queen.alive } : null,
        queenDead: !!colony.queenDead,
        foodStress: Number((colony.foodStress ?? 0).toFixed(2)),
        alerts: colony.alerts.filter((a) => a.until > Date.now()).slice(-6),
        members: [...colony.members.entries()].map(([sid, m]) => ({ id: sid, name: m.name, role: m.role, contribution: m.contribution })),
        role: colony.memberRole(player.sessionId),
        permissions: colony.permissions[colony.memberRole(player.sessionId)] ?? null,
        needs: {
          hungry: !!needs.hungry, needWater: !!needs.needWater,
          needMaterial: !!needs.needMaterial, defence: Number((needs.defence ?? 0).toFixed(2)),
        },
      },
      nearby: world.coloniesNear(player.x, player.y, 4)
        .filter((c) => c.id !== colony.id)
        .map((c) => ({
          id: c.id, name: c.name, color: c.color, pop: c.totalPopulation, isAi: c.isAi,
          relation: colony.relationTo(c.id),
          dist: Math.round(Math.hypot(c.nest.x - player.x, c.nest.y - player.y)),
        })),
      threats: world.defence.deepestThreat(colony) ? 1 : 0,
    };
  }

  buildPlayersList(player) {
    const world = this.world;
    return world.players.all().filter((p) => p.alive).map((p) => {
      const colony = p.colonyId ? world.colonies.get(p.colonyId) : null;
      return {
        id: p.id, name: p.name, colony: colony?.name ?? 'Sem colônia',
        color: colony?.color ?? 0x999999, hp: Math.round(p.hp),
        dist: Math.round(Math.hypot(p.x - player.x, p.y - player.y)),
        x: Math.round(p.x), y: Math.round(p.y),
      };
    });
  }
}

function estimateBytes(obj) {
  try { return JSON.stringify(obj).length; } catch { return 0; }
}

export { q };
