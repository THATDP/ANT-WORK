/**
 * Colônia: identidade, membros, permissões, estoque, população, território.
 *
 * REGRAS DE OURO
 *  - Todo recurso entra/sai por spend()/addStock(), que são atômicos e conferem
 *    capacidade de armazenamento. Não existe caminho para duplicar recurso.
 *  - Ações destrutivas exigem permissão explícita e estrutura "própria" não pode
 *    ser demolida por membro comum (nem pelo fundador, se houver jogador na colônia
 *    sem cargo — regra aplicada em build.js).
 *  - População é sempre a soma dos indivíduos vivos + crias; nada de números mágicos.
 */

import {
  BUILDING, BUILDING_INFO, RESOURCE_INFO, RESOURCE_KEYS, emptyStock,
  COLONY_LIMITS, COLONY_ROLE, DEFAULT_PERMISSIONS, ROLE, ROLE_INFO, clamp,
} from '../../../shared/constants.js';

let colonySeq = 1;

export function makeColonyId() {
  return `c${(colonySeq++).toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

export class Colony {
  constructor({ id, name, color, founderSessionId = null, x, y, isAi = false, aggression = 0.5, industry = 0.5, exploration = 0.5 }) {
    this.id = id || makeColonyId();
    this.name = name;
    this.color = color;
    this.isAi = isAi;
    this.founderSessionId = founderSessionId;
    this.createdAt = Date.now();
    this.nest = { x, y };
    this.queen = null;               // instância de formiga rainha (set por world)
    this.stock = emptyStock();
    this.ants = new Set();           // indivíduos vivos desta colônia
    this.knownNodes = new Set();     // nós descobertos por exploradoras
    this.pendingBuilds = 0;
    this.antsBuilding = 0;
    this.members = new Map();        // sessionId -> { name, role, joinedAt, contribution }
    this.structures = new Map();     // id -> structure (referência viva no chunk)
    this.territory = new Map();      // chunkKey -> peso
    this.brood = { eggs: 0, eggTimer: 0 };
    this.larvae = 0;                 // contagem (indivíduos também existem como ants)
    this.population = { worker: 0, scout: 0, soldier: 0, larva: 0 };
    this.totalPopulation = 0;
    this.stats = {
      gathered: 0, consumed: 0, births: 0, deaths: 0, kills: 0,
      built: 0, lost: 0, raids: 0, defended: 0,
    };
    this.morale = 60;                // 0..100
    this.foodStress = 0;             // 0..1 média móvel da escassez
    this.alerts = [];                // { kind, x, y, text, until }
    this.relations = new Map();      // colonyId -> -100..100
    this.permissions = structuredClone(DEFAULT_PERMISSIONS);
    this.personality = { aggression, industry, exploration };
    this.directorTimer = 0;
    this.dirty = true;
    this.lastActive = Date.now();
    this.queenDead = false;
    this.colorHex = color;
  }

  // ---------------------------------------------------------------- membros
  addMember(sessionId, name) {
    if (this.members.size >= COLONY_LIMITS.maxMembers) {
      return { ok: false, reason: `Colônia cheia (${COLONY_LIMITS.maxMembers} formigas jogadoras)` };
    }
    const role = this.members.size === 0 && !this.isAi ? COLONY_ROLE.FOUNDER : COLONY_ROLE.MEMBER;
    this.members.set(sessionId, { name, role, joinedAt: Date.now(), contribution: 0 });
    this.dirty = true;
    return { ok: true, role };
  }

  removeMember(sessionId) {
    const m = this.members.get(sessionId);
    this.members.delete(sessionId);
    this.dirty = true;
    // fundador saindo: promove o oficial/membro mais antigo
    if (m?.role === COLONY_ROLE.FOUNDER && this.members.size) {
      const next = [...this.members.entries()].sort((a, b) => a[1].joinedAt - b[1].joinedAt)[0];
      next[1].role = COLONY_ROLE.FOUNDER;
      this.founderSessionId = next[0];
    }
    return !!m;
  }

  memberRole(sessionId) {
    return this.members.get(sessionId)?.role ?? null;
  }

  can(sessionId, permission) {
    if (this.isAi) return false;
    const role = this.memberRole(sessionId);
    if (!role) return false;
    return !!this.permissions[role]?.[permission];
  }

  setMemberRole(actorSessionId, targetSessionId, role) {
    if (!this.can(actorSessionId, 'manageRoles')) return { ok: false, reason: 'Sem permissão para gerenciar cargos' };
    if (!Object.values(COLONY_ROLE).includes(role)) return { ok: false, reason: 'Cargo inválido' };
    const target = this.members.get(targetSessionId);
    if (!target) return { ok: false, reason: 'Jogador não pertence à colônia' };
    if (target.role === COLONY_ROLE.FOUNDER) return { ok: false, reason: 'O fundador não pode ser rebaixado' };
    if (role === COLONY_ROLE.FOUNDER) return { ok: false, reason: 'Não é possível criar outro fundador' };
    target.role = role;
    this.dirty = true;
    return { ok: true };
  }

  // ---------------------------------------------------------------- estoque
  get storageCap() {
    let cap = COLONY_LIMITS.baseStorage;
    for (const s of this.structures.values()) {
      if (s.type === BUILDING.STORAGE) cap += COLONY_LIMITS.storagePerDepot;
      else if (s.type === BUILDING.CHAMBER) cap += 30;
    }
    return cap;
  }

  totalStored() {
    let t = 0;
    for (const k of RESOURCE_KEYS) t += this.stock[k];
    return t;
  }

  hasStock(cost) {
    for (const [k, v] of Object.entries(cost)) {
      if ((this.stock[k] ?? 0) < v) return false;
    }
    return true;
  }

  missingStock(cost) {
    const out = {};
    for (const [k, v] of Object.entries(cost)) {
      const lack = v - (this.stock[k] ?? 0);
      if (lack > 0) out[k] = lack;
    }
    return out;
  }

  /** Adiciona recurso respeitando capacidade. Retorna quanto coube. */
  addStock(kind, amount) {
    const key = typeof kind === 'string' ? kind : RESOURCE_KEYS[kind];
    if (!key || !(key in this.stock) || !(amount > 0)) return 0;
    kind = key;
    const free = Math.max(0, this.storageCap - this.totalStored());
    const accepted = Math.min(Math.floor(amount), free);
    if (accepted <= 0) return 0;
    this.stock[kind] += accepted;
    this.stats.gathered += accepted;
    this.markDirty();
    return accepted;
  }

  /** Consome recursos de forma atômica. */
  spend(cost) {
    if (!this.hasStock(cost)) return false;
    for (const [k, v] of Object.entries(cost)) {
      this.stock[k] -= v;
      if (this.stock[k] < 0) this.stock[k] = 0;
    }
    this.markDirty();
    return true;
  }

  withdraw(kind, amount) {
    const have = this.stock[kind] ?? 0;
    const take = Math.max(0, Math.min(Math.floor(amount), have));
    this.stock[kind] = have - take;
    this.markDirty();
    return take;
  }

  /** Retira a melhor comida disponível (menor valor nutricional primeiro? não: prioriza perecível). */
  takeFood(amount) {
    let need = Math.floor(amount);
    let got = 0;
    for (const kind of ['insect', 'fruit', 'seed', 'leaf', 'spore']) {
      if (need <= 0) break;
      const take = Math.min(need, this.stock[kind]);
      this.stock[kind] -= take;
      got += take;
      need -= take;
    }
    return got;
  }

  takeWater(amount) {
    const take = Math.min(Math.floor(amount), this.stock.water);
    this.stock.water -= take;
    return take;
  }

  markDirty() { this.dirty = true; this.lastActive = Date.now(); }

  // ---------------------------------------------------------------- território
  claim(chunkKey, weight = 1) {
    this.territory.set(chunkKey, Math.max(this.territory.get(chunkKey) ?? 0, weight));
  }

  ownsChunk(chunkKey) {
    return (this.territory.get(chunkKey) ?? 0) > 0;
  }

  decayTerritory(keepKeys) {
    for (const [k, w] of this.territory) {
      if (keepKeys.has(k)) continue;
      const nw = w - 0.01;
      if (nw <= 0) this.territory.delete(k);
      else this.territory.set(k, nw);
    }
  }

  // ---------------------------------------------------------------- status
  alert(kind, text, x = this.nest.x, y = this.nest.y, ttlMs = 8000) {
    this.alerts.push({ kind, text, x, y, until: Date.now() + ttlMs });
    if (this.alerts.length > 24) this.alerts.shift();
  }

  relationTo(colonyId) {
    return this.relations.get(colonyId) ?? 0;
  }

  adjustRelation(colonyId, delta) {
    const v = clamp(this.relationTo(colonyId) + delta, -100, 100);
    this.relations.set(colonyId, v);
    return v;
  }

  isHostileTo(colonyId) {
    return this.relationTo(colonyId) < -25;
  }

  effectivePopulation() {
    return this.population.worker + this.population.scout + this.population.soldier;
  }

  rebuildPopulationCounts(ants) {
    const pop = { worker: 0, scout: 0, soldier: 0, larva: 0 };
    for (const a of ants) {
      if (!a.alive) continue;
      if (a.role === ROLE.WORKER) pop.worker++;
      else if (a.role === ROLE.SCOUT) pop.scout++;
      else if (a.role === ROLE.SOLDIER) pop.soldier++;
      else if (a.role === ROLE.LARVA) pop.larva++;
    }
    this.population = pop;
    this.totalPopulation = pop.worker + pop.scout + pop.soldier + pop.larva;
    return pop;
  }

  /** Papel que a colônia mais precisa agora (usado pela rainha e pelo diretor). */
  desiredRole() {
    const { worker, scout, soldier } = this.population;
    const army = this.personality.aggression;
    const total = worker + scout + soldier || 1;
    if (soldier / total < 0.10 + army * 0.22) return ROLE.SOLDIER;
    if (scout / total < 0.14 + this.personality.exploration * 0.12) return ROLE.SCOUT;
    return ROLE.WORKER;
  }

  // ---------------------------------------------------------------- serialização
  toJSON() {
    return {
      id: this.id, name: this.name, color: this.color, isAi: this.isAi,
      founder: this.founderSessionId, nest: this.nest,
      stock: { ...this.stock }, morale: this.morale, population: { ...this.population },
      stats: { ...this.stats }, territory: [...this.territory.keys()],
      relations: [...this.relations.entries()],
      createdAt: this.createdAt, queenDead: this.queenDead,
    };
  }

  static fromJSON(j, opts = {}) {
    const c = new Colony({
      id: j.id, name: j.name, color: j.color, x: j.nest?.x ?? 0, y: j.nest?.y ?? 0,
      isAi: !!j.isAi, founderSessionId: j.founder ?? null,
      ...opts,
    });
    Object.assign(c.stock, emptyStock(), j.stock || {});
    c.morale = j.morale ?? 60;
    c.population = { worker: 0, scout: 0, soldier: 0, larva: 0, ...(j.population || {}) };
    c.stats = { ...c.stats, ...(j.stats || {}) };
    for (const k of j.territory || []) c.territory.set(k, 1);
    for (const [k, v] of j.relations || []) c.relations.set(k, v);
    c.createdAt = j.createdAt ?? Date.now();
    c.queenDead = !!j.queenDead;
    return c;
  }
}

// ---------------------------------------------------------------- diretor de IA
/**
 * O "diretor" de uma colônia não é uma formiga: é uma camada de estratégia que
 * roda a cada ~2s e ajusta metas (construir, expandir, atacar, recrutar).
 * As formigas continuam reagindo localmente; o diretor só mexe em prioridades
 * e constrói estruturas com o estoque real da colônia.
 */
export class ColonyDirector {
  constructor(world, colony) {
    this.world = world;
    this.colony = colony;
    this.plan = null;
    this.cooldown = 0;
  }

  /** Estruturas prioritárias conforme situação da colônia. */
  nextBlueprint() {
    const c = this.colony;
    const has = (t) => [...c.structures.values()].some((s) => s.type === t);
    const count = (t) => [...c.structures.values()].filter((s) => s.type === t).length;

    if (!has(BUILDING.EXIT)) return BUILDING.EXIT;
    if (count(BUILDING.STORAGE) < 2 && c.totalStored() > c.storageCap * 0.6) return BUILDING.STORAGE;
    if (!has(BUILDING.NURSERY) && c.brood.eggs + c.population.larva > 0) return BUILDING.NURSERY;
    if (!has(BUILDING.FEEDING) && c.morale < 70) return BUILDING.FEEDING;
    if (!has(BUILDING.BARRACKS) && c.personality.aggression > 0.45) return BUILDING.BARRACKS;
    if (count(BUILDING.TUNNEL) < 6) return BUILDING.TUNNEL;
    if (count(BUILDING.CHAMBER) < 3) return BUILDING.CHAMBER;
    if (!has(BUILDING.FUNGUS) && c.stock.material > 30) return BUILDING.FUNGUS;
    if (!has(BUILDING.WATCHTOWER) && c.morale > 65) return BUILDING.WATCHTOWER;
    if (!has(BUILDING.SHRINE) && c.stock.fruit > 30 && c.population.worker > 8) return BUILDING.SHRINE;
    if (count(BUILDING.STORAGE) < 4) return BUILDING.STORAGE;
    return BUILDING.TUNNEL;
  }

  think() {
    const c = this.colony;
    if (c.queenDead) return null;
    this.cooldown--;
    if (this.cooldown > 0) return null;
    this.cooldown = 12 + Math.floor(Math.random() * 10); // 1.2–2.2s

    // 1. construir se houver recursos e espaço (mantendo reserva de comida)
    const blueprint = this.nextBlueprint();
    const info = BUILDING_INFO[blueprint];
    const foodReserve = (c.stock.leaf + c.stock.seed + c.stock.fruit + c.stock.insect) > c.totalPopulation * 1.4;
    if (c.hasStock(info.cost) && foodReserve && c.structures.size < COLONY_LIMITS.maxStructures) {
      const placed = this.world.build.aiTryBuild(c, blueprint, this.world);
      if (placed.ok) return { action: 'build', structure: placed.structure };
    }

    // 2. expansão / guerra
    const enemies = this.world.coloniesNear(c.nest.x, c.nest.y, 4).filter((o) => o.id !== c.id);
    if (enemies.length && c.effectivePopulation() > 20) {
      const target = enemies.sort((a, b) => a.effectivePopulation() - b.effectivePopulation())[0];
      const hostile = c.relationTo(target.id) < -20 || c.personality.aggression > 0.72;
      if (hostile && c.population.soldier >= 6) {
        this.world.military.requestRaid(c, target);
        return { action: 'raid', target: target.id };
      }
    }

    // 3. crescimento populacional: gastar excedente em crias (respeitando berçário e comida)
    const nursery = [...c.structures.values()].filter((s) => s.type === BUILDING.NURSERY && s.progress >= 100).length;
    const eggCap = 4 + nursery * 3;
    if (c.moralOk() && c.stock.insect + c.stock.fruit > 25 && c.brood.eggs < eggCap &&
        c.totalPopulation < this.world.populationCapFor(c) && c.stock.water > 4) {
      const add = c.spend({ fruit: 2 }) ? 1 : 0;
      if (add && c.spend({ insect: 1 })) c.brood.eggs += add;
    }
    return null;
  }
}

// helper small & local (evita import circular)
Colony.prototype.moralOk = function () { return this.morale > 35; };
