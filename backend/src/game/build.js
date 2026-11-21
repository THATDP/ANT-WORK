/**
 * Construção: regras espaciais, custos, progresso cooperativo e demolição.
 *
 * Segurança (anti-grief):
 *  - quem constrói precisa de permissão "build" na colônia;
 *  - só se constrói até 6 chunks do ninho e nunca em cima de estrutura alheia;
 *  - demolição exige permissão "demolish" (por padrão só fundador/oficial) e só
 *    vale para estruturas da própria colônia;
 *  - custo é debitado ANTES da criação; se algo falhar, é reembolsado.
 *
 * Progresso: a estrutura nasce com progress 0 e só fica funcional aos 100%.
 * Operárias de IA e jogadores contribuem; 3 formigas no máximo por obra.
 */

import {
  BUILDING, BUILDING_INFO, CHUNK_PX, CHUNK_TILES, TILE, COLONY_LIMITS,
} from '../../../shared/constants.js';

let structureSeq = 1;
export function resetStructureSeq(v = 1) { structureSeq = v; }
export function nextStructureId() { return structureSeq++; }

export const BUILD_RULES = {
  maxDistanceFromNestPx: CHUNK_PX * 6,
  maxBuildersPerSite: 3,
  buildRatePerSecond: 9,       // % por formiga/segundo
  playerBuildRate: 24,         // jogador contribui mais rápido
  refundRatio: 0.4,
  minDistanceToForeignStructure: TILE * 2,
  repairCostPerPoint: 0.05,
};

export class BuildSystem {
  constructor(world) {
    this.world = world;
    this.blueprints = new Map(); // reservas de obra (evita duas pessoas no mesmo tile)
  }

  structureWorldPos(s) {
    return {
      wx: s.cx * CHUNK_PX + s.gx * TILE + TILE / 2,
      wy: s.cy * CHUNK_PX + s.gy * TILE + TILE / 2,
    };
  }

  info(type) { return BUILDING_INFO[type]; }

  /** Validação completa. Retorna { ok, reason?, structure? }. */
  validate(colony, type, cx, cy, gx, gy, sessionId = null, opts = {}) {
    const info = BUILDING_INFO[type];
    if (!info) return { ok: false, reason: 'Construção desconhecida' };
    if (!colony) return { ok: false, reason: 'Você precisa de uma colônia' };
    if (!opts.asAi && !colony.can(sessionId, 'build')) {
      return { ok: false, reason: 'Sem permissão de construção nesta colônia' };
    }
    if (cx < 0 || cy < 0 || cx >= this.world.chunksAcross || cy >= this.world.chunksAcross) {
      return { ok: false, reason: 'Fora do mundo conhecido' };
    }
    if (colony.structures.size >= COLONY_LIMITS.maxStructures) {
      return { ok: false, reason: `Limite de ${COLONY_LIMITS.maxStructures} estruturas da colônia` };
    }
    const wx = cx * CHUNK_PX + gx * TILE + TILE / 2;
    const wy = cy * CHUNK_PX + gy * TILE + TILE / 2;
    const dNest = Math.hypot(wx - colony.nest.x, wy - colony.nest.y);
    if (dNest > BUILD_RULES.maxDistanceFromNestPx) {
      return { ok: false, reason: 'Longe demais do ninho (máx. 6 setores)' };
    }
    if (sessionId) {
      const missing = colony.missingStock(info.cost);
      if (Object.keys(missing).length) {
        const list = Object.entries(missing).map(([k, v]) => `${v} ${k}`).join(', ');
        return { ok: false, reason: `Recursos insuficientes: ${list}` };
      }
    }
    // estrutura estrangeira muito perto → bloqueia (proteção de entrada alheia)
    const foreign = this.world.sense.nearestForeignStructure(colony.id, wx, wy, BUILD_RULES.minDistanceToForeignStructure);
    // entrada de outra colônia é sempre protegida num raio maior
    const foreignNest = this.world.coloniesNear(wx, wy, 1).find((c) => c.id !== colony.id);
    if (foreignNest && Math.hypot(wx - foreignNest.nest.x, wy - foreignNest.nest.y) < 460) {
      return { ok: false, reason: `Respeite o território de ${foreignNest.name}` };
    }
    if (foreign && dNest > CHUNK_PX * 2) {
      return { ok: false, reason: 'Há uma estrutura de outra colônia neste local' };
    }

    const chunk = this.world.chunks.get(cx, cy);
    const place = chunk.canPlace(this.world.seed, gx, gy, info.size, type);
    if (!place.ok) return { ok: false, reason: place.reason };

    // ocupação: o mesmo tile não pode ter duas obras em andamento
    const key = `${cx},${cy},${gx},${gy}`;
    if (this.blueprints.has(key)) return { ok: false, reason: 'Obra já reservada neste local' };

    return { ok: true, wx, wy, chunk };
  }

  create(colony, type, cx, cy, gx, gy, sessionId = null, opts = {}) {
    const v = this.validate(colony, type, cx, cy, gx, gy, sessionId, opts);
    if (!v.ok) return v;
    const info = BUILDING_INFO[type];
    if (!colony.spend(info.cost)) return { ok: false, reason: 'Recursos insuficientes' };

    const chunk = v.chunk;
    const localIdx = gx + gy * CHUNK_TILES;
    const structure = {
      id: nextStructureId(),
      type,
      cx, cy, gx, gy,
      colonyId: colony.id,
      wx: v.wx, wy: v.wy,
      hp: Math.round(info.hp * 0.35),
      maxHp: info.hp,
      progress: 0,
      builtAt: this.world.tick,
      localIdx,
      workers: 0,
      workersSet: new Set(),
      lastWorkTick: 0,
      repairCooldown: 0,
    };
    chunk.place(structure);
    colony.structures.set(structure.id, structure);
    this.world.structureIndex.set(structure.id, structure);
    colony.claim(chunk.key, 1);
    colony.pendingBuilds = (colony.pendingBuilds || 0) + 1;
    this.blueprints.set(`${cx},${cy},${gx},${gy}`, structure.id);
    colony.markDirty();
    colony.alert('build', `Obra iniciada: ${info.name}`, v.wx, v.wy, 6000);
    this.world.events.push('build', `${colony.name} iniciou ${info.name}`, v.wx, v.wy);
    if (sessionId) {
      const m = colony.members.get(sessionId);
      if (m) m.contribution += 1;
    }
    return { ok: true, structure };
  }

  /** Contribuição de uma formiga/jogador. */
  contribute(structure, entity, dt, isPlayer = false) {
    if (!structure || structure.progress >= 100) return false;
    const now = this.world.tick;
    if (structure.lastWorkTick && now - structure.lastWorkTick < 2 && !isPlayer) return false;
    structure.lastWorkTick = now;
    const rate = isPlayer ? BUILD_RULES.playerBuildRate : BUILD_RULES.buildRatePerSecond;
    const bonus = this.world.effectiveBuildBonus(structure.colonyId);
    structure.progress = Math.min(100, structure.progress + rate * bonus * dt);
    structure.hp = Math.min(structure.maxHp, structure.hp + structure.maxHp * 0.01 * dt);
    if (structure.progress >= 100) this.complete(structure);
    return true;
  }

  complete(structure) {
    structure.progress = 100;
    structure.hp = structure.maxHp;
    const colony = this.world.colonies.get(structure.colonyId);
    if (!colony) return;
    if (colony.pendingBuilds > 0) colony.pendingBuilds--;
    const info = BUILDING_INFO[structure.type];
    colony.stats.built++;
    colony.morale = Math.min(100, colony.morale + 1.2);
    colony.markDirty();
    this.blueprints.delete(`${structure.cx},${structure.cy},${structure.gx},${structure.gy}`);
    colony.alert('build', `${info.name} concluída`, structure.wx, structure.wy, 7000);
    this.world.events.push('build', `${colony.name} concluiu ${info.name} em ${this.world.sectorLabel(structure.wx, structure.wy)}`, structure.wx, structure.wy);
    this.world.onStructureChanged?.(structure, 'complete');
  }

  repair(structure, amount, dt) {
    if (structure.hp >= structure.maxHp) return false;
    structure.hp = Math.min(structure.maxHp, structure.hp + 6 * dt);
    return true;
  }

  damage(structure, amount, source = null) {
    if (!structure) return;
    structure.hp -= amount;
    const colony = this.world.colonies.get(structure.colonyId);
    if (structure.hp <= 0) {
      this.destroy(structure, source);
    } else if (colony && Math.random() < 0.25) {
      colony.alert('damage', `${BUILDING_INFO[structure.type].name} sob ataque`, structure.wx, structure.wy, 5000);
    }
  }

  destroy(structure, source = null) {
    const colony = this.world.colonies.get(structure.colonyId);
    const chunk = this.world.chunks.get(structure.cx, structure.cy);
    chunk?.remove(structure);
    this.world.structureIndex.delete(structure.id);
    this.blueprints.delete(`${structure.cx},${structure.cy},${structure.gx},${structure.gy}`);
    if (colony) {
      colony.structures.delete(structure.id);
      colony.stats.lost++;
      colony.morale = Math.max(0, colony.morale - 4);
      if (structure.progress < 100 && colony.pendingBuilds > 0) colony.pendingBuilds--;
      colony.alert('damage', `${BUILDING_INFO[structure.type].name} foi destruída`, structure.wx, structure.wy, 9000);
      colony.markDirty();
    }
    this.world.economy.spawnCorpse(structure.wx, structure.wy, 5, 6); // material recuperável
    this.world.events.push('damage', `${BUILDING_INFO[structure.type].name} destruída`, structure.wx, structure.wy);
    this.world.onStructureChanged?.(structure, 'destroy');
  }

  demolish(structure, sessionId, asAi = false) {
    const colony = this.world.colonies.get(structure.colonyId);
    if (!colony) return { ok: false, reason: 'Estrutura de colônia inexistente' };
    if (!asAi && !colony.can(sessionId, 'demolish')) {
      return { ok: false, reason: 'Sem permissão para demolir (só fundador/oficiais)' };
    }
    if (structure.type === BUILDING.SHRINE && colony.structures.size > 1) {
      const otherShrines = [...colony.structures.values()].filter((s) => s.type === BUILDING.SHRINE && s.id !== structure.id).length;
      if (!otherShrines) return { ok: false, reason: 'A câmara da rainha não pode ser demolida' };
    }
    const info = BUILDING_INFO[structure.type];
    const refund = {};
    for (const [k, v] of Object.entries(info.cost)) {
      const amt = Math.floor(v * BUILD_RULES.refundRatio);
      if (amt > 0) refund[k] = amt;
    }
    for (const [k, v] of Object.entries(refund)) colony.addStock(k, v);
    this.destroy(structure, null);
    this.world.events.push('build', `${colony.name} demoliu ${info.name}`, structure.wx, structure.wy);
    return { ok: true, refund };
  }

  /** IA: tenta construir perto do ninho, procurando um tile livre. */
  aiTryBuild(colony, type, world = this.world) {
    const info = BUILDING_INFO[type];
    if (!colony.hasStock(info.cost)) return { ok: false, reason: 'Recursos insuficientes' };
    const { cx, cy } = world.chunkOf(colony.nest.x, colony.nest.y);
    // posições candidatas em espiral
    for (let ring = 0; ring <= 5; ring++) {
      const candidates = [];
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          for (const off of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
            candidates.push([cx + dx, cy + dy, off[0], off[1]]);
          }
        }
      }
      // embaralha determinístico por tick para variar o lado
      candidates.sort(() => Math.random() - 0.5);
      for (const [ncx, ncy, ox, oy] of candidates) {
        if (ncx < 0 || ncy < 0 || ncx >= world.chunksAcross || ncy >= world.chunksAcross) continue;
        const gx = Math.floor(Math.random() * CHUNK_TILES);
        const gy = Math.floor(Math.random() * CHUNK_TILES);
        const v = this.validate(colony, type, ncx, ncy, gx, gy, null, { asAi: true });
        if (v.ok) {
          return this.create(colony, type, ncx, ncy, gx, gy, null, { asAi: true });
        }
      }
    }
    return { ok: false, reason: 'Sem espaço para construir' };
  }

  /** Palpite do cliente para preview (não altera estado). */
  preview(colony, type, cx, cy, gx, gy, sessionId) {
    return this.validate(colony, type, cx, cy, gx, gy, sessionId);
  }
}

export { structureSeq };
