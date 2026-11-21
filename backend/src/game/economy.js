/**
 * Economia, recursos e ciclo de vida.
 *
 * Este é o "coração lento" do mundo: roda 1× por segundo e resolve o que não
 * precisa ser simulado a cada tick.
 *
 *  - RECURSOS: nós regeneram, corpos apodrecem, chuva enche pontos de água.
 *  - LOD ABSTRATO: formigas distantes produzem/consomem por estatística,
 *    mantendo a colônia viva sem simular passos e colisões.
 *  - CICLO DE VIDA: ovos → larvas (cuidadas por operárias) → adultas, com
 *    rainha botando ovos conforme comida, moral e a Câmara da Rainha.
 *  - CONSERVAÇÃO: todo recurso passa por harvest()/addStock(); nada duplica.
 */

import {
  RESOURCE, RESOURCE_KEYS, RESOURCE_INFO, ROLE, ROLE_INFO, TASK,
  COLONY_LIMITS, BUILDING, clamp, dist,
} from '../../../shared/constants.js';
import { antDistance } from './ai/helpers.js';

const EGGS_TO_LARVA_SECONDS = 18;
const LARVA_TO_ADULT_SECONDS = 55;
const CARRION_TTL_SECONDS = 90;

let corpseSeq = -1;

export class ResourceSystem {
  constructor(world) {
    this.world = world;
    this.regrowPhase = 0;
  }

  /** Retira recurso de um nó de forma atômica (fonte única de verdade). */
  harvest(node, amount) {
    if (!node || node.amount <= 0 || amount <= 0) return 0;
    const take = Math.min(Math.floor(node.amount), Math.floor(amount));
    if (take <= 0) return 0;
    node.amount -= take;
    const chunk = this.world.chunks.chunks.get(node.chunk);
    if (chunk) {
      chunk.dirtyNodes.add(node.id);
      chunk.resourceVersion++;
      if (node.amount <= 0) {
        node.respawnAt = this.world.tick + this.respawnDelay(node);
        chunk.dirtyNodes.add(node.id);
      }
    }
    return take;
  }

  respawnDelay(node) {
    const base = node.kind === RESOURCE.WATER ? 30 : node.kind === RESOURCE.SPORE ? 240 : 150;
    return Math.round(base * (0.75 + (node.max / 200) * 0.5)) * 10; // em ticks
  }

  regenRate(node) {
    const w = this.world.env.weather;
    switch (node.kind) {
      case RESOURCE.WATER: return w === 'rain' ? 2.2 : w === 'storm' ? 3.2 : w === 'heat' ? 0.15 : 0.7;
      case RESOURCE.LEAF: return 0.12;
      case RESOURCE.SEED: return 0.08;
      case RESOURCE.FRUIT: return 0.06;
      case RESOURCE.INSECT: return 0.05;
      case RESOURCE.MATERIAL: return 0.04;
      case RESOURCE.SPORE: return 0.02;
      default: return 0.05;
    }
  }

  tick(dt) {
    const world = this.world;
    this.regrowPhase = (this.regrowPhase + 1) % 5;
    // percorre 1/5 dos nós dos chunks carregados por segundo (economia de CPU)
    for (const chunk of world.chunks.chunks.values()) {
      const arr = chunk.nodes;
      for (let i = this.regrowPhase; i < arr.length; i += 5) {
        const n = arr[i];
        if (n.id < 0) {
          // carcaça: apodrece e vira adubo (some do mundo)
          if (world.tick > n.respawnAt) {
            chunk.dirtyNodes.add(n.id);
            const idx = arr.indexOf(n);
            if (idx >= 0) arr.splice(idx, 1);
            chunk.nodesById.delete(n.id);
          }
          continue;
        }
        if (n.amount >= n.max) continue;
        if (world.tick < n.respawnAt) continue;
        const rate = this.regenRate(n);
        const gain = Math.max(0.02, rate * dt * 5);
        n.amount = Math.min(n.max, n.amount + gain);
        chunk.dirtyNodes.add(n.id);
        chunk.resourceVersion++;
      }
    }
  }

  /** Carcaça/espólio: entra no mundo como nó temporário de comida. */
  spawnCorpse(x, y, kind = RESOURCE.INSECT, amount = 8) {
    const world = this.world;
    if (x < 0 || y < 0 || x >= world.sizePx || y >= world.sizePx) return null;
    const { cx, cy } = world.chunkOf(x, y);
    const chunk = world.chunks.get(cx, cy);
    const id = corpseSeq--;
    const node = {
      id, x, y, kind, amount, max: amount,
      respawnAt: world.tick + CARRION_TTL_SECONDS * 10,
      chunk: chunk.key, corpse: true,
    };
    chunk.nodes.push(node);
    chunk.nodesById.set(id, node);
    chunk.resourceVersion++;
    return node;
  }

  /** Quantidade total de comida disponível no mundo (métrica de saúde do ecossistema). */
  worldFoodEstimate() {
    let total = 0;
    for (const c of this.world.chunks.chunks.values()) {
      for (const n of c.nodes) if (n.amount > 0) total += n.amount;
    }
    return total;
  }
}

export class EconomySystem {
  constructor(world) {
    this.world = world;
    this.phase = 0;
    this.tickCount = 0;
    this.lastSummary = null;
  }

  step(dt = 1) {
    this.tickCount++;
    const world = this.world;
    world.resources.tick(dt);
    if (this.tickCount % 2 === 0) world.sense.recountAssignments();

    for (const colony of world.colonies.values()) {
      this.colonyTick(colony, dt);
      this.broodTick(colony, dt);
      this.abstractTick(colony, dt);
    }
    this.hungerTick(dt);
    this.gcTick();
  }

  // ------------------------------------------------------------ colônia
  colonyTick(colony, dt) {
    const pop = Math.max(1, colony.effectivePopulation());
    const food = colony.stock.leaf + colony.stock.seed + colony.stock.fruit + colony.stock.insect + colony.stock.spore;
    const foodPerPop = food / pop;
    const targetStress = foodPerPop < 1.5 ? 1 : foodPerPop < 3 ? 0.45 : 0;
    colony.foodStress = colony.foodStress * 0.94 + targetStress * 0.06;

    // moral
    let delta = 0;
    if (foodPerPop > 4) delta += 0.12;
    else if (foodPerPop < 1.5) delta -= 0.5;
    if (colony.stock.water / pop < 0.35) delta -= 0.15;
    if (colony.defenceNeed > 0.5) delta -= 0.15;
    for (const s of colony.structures.values()) if (s.progress >= 100) delta += 0.004;
    colony.morale = clamp(colony.morale + delta * dt, 0, 100);

    // fungos: alimento lento em troca de água
    let fungi = 0;
    for (const s of colony.structures.values()) {
      if (s.type === BUILDING.FUNGUS && s.progress >= 100) fungi++;
    }
    if (fungi > 0) {
      const water = colony.takeWater(0.35 * fungi * dt);
      if (water > 0) colony.addStock('leaf', Math.round(water * 1.6 * dt * 10) / 10 || 0);
      else colony.morale = clamp(colony.morale - 0.02, 0, 100);
    }

    // alimentação passiva das crias e feridos
    if (colony.population.larva > 0) {
      colony.takeFood(colony.population.larva * 0.008 * dt);
    }

    // rainha
    this.queenTick(colony, dt);
    colony.needs = this.computeNeeds(colony);
    colony.pendingBuilds = [...colony.structures.values()].filter((s) => s.progress < 100).length;
    colony.antsBuilding = [...colony.ants].filter((a) => a.task === TASK.BUILD).length;
  }

  computeNeeds(colony) {
    const pop = Math.max(1, colony.effectivePopulation());
    const food = colony.stock.leaf + colony.stock.seed + colony.stock.fruit + colony.stock.insect + colony.stock.spore;
    return {
      food,
      foodPerPop: food / pop,
      hungry: food / pop < 3.2 || colony.foodStress > 0.35,
      starving: food / pop < 1.2,
      needWater: colony.stock.water / pop < 1.4,
      needMaterial: colony.stock.material < 24 || colony.pendingBuilds > 0,
      needNurses: colony.population.larva > 0,
      defence: colony.defenceNeed ?? 0,
      buildNeed: colony.pendingBuilds > 0,
    };
  }

  queenTick(colony, dt) {
    const queen = colony.queen;
    if (!queen || !queen.alive) {
      // recuperação: larva pode ser coroada se houver câmara da rainha
      if (!colony.queenDead) {
        colony.queenDead = true;
        colony.morale = clamp(colony.morale - 20, 0, 100);
        colony.alert('queen', 'A rainha morreu!', colony.nest.x, colony.nest.y, 20000);
        this.world.events.push('queen', `A rainha de ${colony.name} morreu`, colony.nest.x, colony.nest.y, true);
      }
      const shrine = [...colony.structures.values()].some((s) => s.type === BUILDING.SHRINE && s.progress >= 100);
      const larva = [...colony.ants].find((a) => a.alive && a.role === ROLE.LARVA && a.development > 60);
      if (shrine && larva) {
        larva.crowned = true;
        this.morphToAdult(larva, ROLE.QUEEN);
        colony.queenDead = false;
        colony.morale = clamp(colony.morale + 15, 0, 100);
        colony.alert('queen', 'Uma nova rainha emergiu', larva.x, larva.y, 15000);
        this.world.events.push('queen', `Nova rainha em ${colony.name}`, larva.x, larva.y, true);
      }
      return;
    }

    const pop = Math.max(1, colony.effectivePopulation());
    const food = colony.stock.leaf + colony.stock.seed + colony.stock.fruit + colony.stock.insect + colony.stock.spore;
    const shrine = [...colony.structures.values()].some((s) => s.type === BUILDING.SHRINE && s.progress >= 100);
    const nursery = [...colony.structures.values()].filter((s) => s.type === BUILDING.NURSERY && s.progress >= 100).length;
    const eggCap = 6 + nursery * 4 + (shrine ? 6 : 0);
    if (colony.morale > 35 && food > pop * 1.6 && colony.brood.eggs < eggCap && colony.totalPopulation < this.world.populationCapFor(colony)) {
      const rate = 1 + (shrine ? 0.8 : 0) + (nursery ? 0.4 : 0) + colony.personality.industry * 0.5;
      colony.brood.eggTimer += dt * rate;
      if (colony.brood.eggTimer >= 9) {
        colony.brood.eggTimer -= 9;
        if (colony.spend({ insect: Math.min(colony.stock.insect, 2), leaf: colony.stock.insect >= 2 ? 0 : Math.min(colony.stock.leaf, 2) })) {
          colony.brood.eggs++;
          queen.eggProgress = (queen.eggProgress || 0) + 1;
        }
      }
    }
  }

  // ------------------------------------------------------------ crias
  broodTick(colony, dt) {
    // ovos → larvas
    if (colony.brood.eggs > 0) {
      colony.brood.hatchTimer = (colony.brood.hatchTimer || 0) + dt;
      const perEgg = EGGS_TO_LARVA_SECONDS;
      while (colony.brood.hatchTimer >= perEgg && colony.brood.eggs > 0) {
        colony.brood.hatchTimer -= perEgg;
        colony.brood.eggs--;
        this.spawnLarva(colony);
      }
    } else {
      colony.brood.hatchTimer = 0;
    }

    // larvas → adultas (crescimento depende de cuidado)
    const nurses = [...colony.ants].filter((a) => a.alive && a.task === TASK.NURSE).length;
    for (const larva of colony.ants) {
      if (!larva.alive || larva.role !== ROLE.LARVA) continue;
      const near = larva.nursed ? 1.6 : 0.5;
      const care = 1 + nurses * 0.25;
      larva.development = Math.min(100, larva.development + (dt / LARVA_TO_ADULT_SECONDS) * 100 * near * care);
      larva.nursed = false;
      if (larva.development >= 100) {
        this.morphToAdult(larva, colony.desiredRole());
      }
    }
  }

  spawnLarva(colony) {
    const world = this.world;
    if (colony.totalPopulation >= this.world.populationCapFor(colony)) return null;
    const queen = colony.queen;
    const base = queen && queen.alive ? queen : colony.nest;
    const a = world.spawnAnt(colony, ROLE.LARVA, {
      x: base.x + (Math.random() - 0.5) * 60,
      y: base.y + (Math.random() - 0.5) * 60,
    });
    if (a) {
      a.development = 0;
      colony.stats.births++;
    }
    return a;
  }

  morphToAdult(larva, role) {
    const world = this.world;
    const colony = world.colonies.get(larva.colonyId);
    if (!colony) return;
    if (role === ROLE.QUEEN) {
      larva.role = ROLE.QUEEN;
      larva.info = ROLE_INFO[ROLE.QUEEN];
      larva.maxHp = ROLE_INFO[ROLE.QUEEN].hp;
      larva.hp = larva.maxHp;
      larva.task = TASK.BREED;
      larva.development = 100;
      colony.queen = larva;
      return;
    }
    larva.role = role;
    larva.info = ROLE_INFO[role];
    larva.maxHp = larva.info.hp;
    larva.hp = larva.maxHp;
    larva.carryCap = larva.info.carry;
    larva.development = 0;
    larva.task = TASK.IDLE;
    larva.nextThink = world.tick;
    colony.population.larva = Math.max(0, colony.population.larva - 1);
    if (role === ROLE.WORKER) colony.population.worker++;
    else if (role === ROLE.SCOUT) colony.population.scout++;
    else if (role === ROLE.SOLDIER) colony.population.soldier++;
    world.events.push('birth', `Nova ${ROLE_INFO[role].name.toLowerCase()} em ${colony.name}`, larva.x, larva.y);
  }

  // ------------------------------------------------------------ LOD abstrato
  /**
   * Formigas distantes produzem/consomem por estatística. A produção é
   * direcionada ao que a colônia mais precisa AGORA (comida, água, material),
   * o que faz o comportamento coletivo "aparecer" mesmo sem simular passos.
   */
  abstractTick(colony, dt) {
    let farWorkers = 0, farScouts = 0, farSoldiers = 0;
    for (const a of colony.ants) {
      if (!a.alive || a.detail < 2) continue;
      if (a.role === ROLE.WORKER) farWorkers++;
      else if (a.role === ROLE.SCOUT) farScouts++;
      else if (a.role === ROLE.SOLDIER) farSoldiers++;
    }
    if (!farWorkers && !farScouts) return;
    if (colony.structures.size === 0) {
      colony.morale = clamp(colony.morale - 0.02, 0, 100);
      return;
    }

    const needs = colony.needs || this.computeNeeds(colony);
    const pop = Math.max(1, colony.totalPopulation);
    const food = colony.stock.leaf + colony.stock.seed + colony.stock.fruit + colony.stock.insect + colony.stock.spore;

    // quanto cada recurso está "devendo" (0..1)
    const materialReserve = 160 + pop * 2;   // o suficiente para as próximas obras
    const deficit = {
      insect: clamp(1 - colony.stock.insect / (pop * 1.1), 0, 1),
      fruit: clamp(1 - colony.stock.fruit / (pop * 1.1), 0, 1),
      seed: clamp(1 - colony.stock.seed / (pop * 1.1), 0, 1),
      leaf: clamp(1 - colony.stock.leaf / (pop * 1.1), 0, 1),
      water: clamp(1 - colony.stock.water / (pop * 1.2), 0, 1),
      material: colony.stock.material >= materialReserve
        ? 0
        : clamp(1 - colony.stock.material / Math.max(30, pop * 0.8), 0, 1),
    };
    if (needs.starving) { deficit.insect += 0.6; deficit.fruit += 0.5; deficit.seed += 0.4; }
    if (needs.needMaterial && colony.stock.material < materialReserve) deficit.material += 0.4;
    // sede é urgente: prioriza água sobre o resto
    if (colony.stock.water < pop * 0.8) deficit.water += 0.8;

    const totalDeficit = Object.values(deficit).reduce((s, v) => s + v, 0);
    if (totalDeficit <= 0.0001) return;

    const production = Math.min(farWorkers, 80) * 0.05 + Math.min(farScouts, 25) * 0.075;
    const buffer = colony.prodBuffer ?? (colony.prodBuffer = {});
    let produced = 0;
    for (const [kind, dv] of Object.entries(deficit)) {
      if (dv <= 0) continue;
      const share = production * dt * (dv / totalDeficit);
      buffer[kind] = (buffer[kind] || 0) + share;
      if (buffer[kind] >= 1) {
        const whole = Math.floor(buffer[kind]);
        buffer[kind] -= whole;
        produced += colony.addStock(kind, whole);
      }
    }
    if (produced > 0) colony.farProduction = (colony.farProduction || 0) + produced;

    // obras continuam avançando em LOD abstrato: sem isso, colônias longe de
    // qualquer jogador acumulariam canteiros parados para sempre
    let pendingSite = null;
    for (const s of colony.structures.values()) {
      if (s.progress < 100) { pendingSite = s; break; }
    }
    if (pendingSite) {
      const workers = Math.min(farWorkers, 20);
      const advance = dt * (0.02 + workers * 0.035);
      this.world.build.contribute(pendingSite, { id: `abstract-${colony.id}` }, advance);
    }

    // desgaste: soldados distantes podem cair em patrulha
    if (farSoldiers > 0 && Math.random() < 0.0004 * farSoldiers) {
      const victim = [...colony.ants].find((a) => a.detail >= 2 && a.role === ROLE.SOLDIER);
      if (victim) victim.die('patrulha');
    }
    // fome e sede coletivas (se a colônia não tem nada, todos sofrem)
    if (food <= 0 && colony.stock.water <= 0 && Math.random() < 0.05) {
      const victim = [...colony.ants].find((a) => a.detail >= 2 && a.role !== ROLE.QUEEN);
      if (victim) victim.die('fome');
    }
  }

  // ------------------------------------------------------------ fome individual
  hungerTick(dt) {
    const world = this.world;
    let i = 0;
    for (const ant of world.ants.values()) {
      if (!ant.alive) continue;
      i++;
      // formigas distantes atualizam fome em rodízio (1/6 por segundo)
      const stride = ant.detail >= 2 ? 6 : 1;
      if (i % stride !== (this.phase % stride)) continue;
      const mult = ant.role === ROLE.LARVA ? 0.25 : 1;
      ant.hunger = Math.min(120, ant.hunger + 0.34 * mult * dt * stride);
      ant.thirst = Math.min(120, ant.thirst + 0.26 * mult * dt * stride);
      if (ant.detail >= 2 && (ant.hunger > 55 || ant.thirst > 60)) {
        // formigas abstratas se alimentam no ninho (sem simular o caminho)
        const colony = ant.colony;
        if (colony) {
          if (ant.thirst > 55 && colony.stock.water > 0) {
            colony.takeWater(1);
            ant.thirst = Math.max(0, ant.thirst - 40 * stride);
          }
          if (ant.hunger > 50 && colony.takeFood(1) > 0) {
            ant.hunger = Math.max(0, ant.hunger - 42 * stride);
          }
        }
      }
      if (ant.hunger > 85 || ant.thirst > 90) {
        ant.hp -= 0.35 * dt * stride;
        if (ant.hp <= 0) ant.die('fome');
      }
      if (ant.hunger > 60 || ant.thirst > 70) {
        ant.nextThink = Math.min(ant.nextThink, world.tick + 1);
      }
    }
    this.phase++;
  }

  // ------------------------------------------------------------ limpeza
  gcTick() {
    const world = this.world;
    if (world.tick % 100 !== 0) return;
    for (const [id, ant] of world.ants) {
      if (!ant.alive) {
        world.ants.delete(id);
        world.antIndex.remove(ant);
      }
    }
    for (const colony of world.colonies.values()) {
      colony.ants = new Set([...colony.ants].filter((a) => a.alive && colony.ants.has(a)));
      colony.rebuildPopulationCounts(colony.ants);
    }
  }

  /** Atalho: carcaças pertencem ao sistema de recursos. */
  spawnCorpse(x, y, kind = RESOURCE.INSECT, amount = 8) {
    return this.world.resources.spawnCorpse(x, y, kind, amount);
  }

  summary() {
    const out = { colonies: {}, food: 0 };
    for (const c of this.world.colonies.values()) {
      out.colonies[c.id] = { stock: { ...c.stock }, pop: c.totalPopulation, morale: Math.round(c.morale) };
      out.food += c.stock.leaf + c.stock.seed + c.stock.fruit + c.stock.insect + c.stock.spore;
    }
    this.lastSummary = out;
    return out;
  }
}

export { EGGS_TO_LARVA_SECONDS, LARVA_TO_ADULT_SECONDS, CARRION_TTL_SECONDS };
