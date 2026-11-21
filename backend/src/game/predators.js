/**
 * Predadores e ameaças naturais — cada espécie tem um comportamento próprio.
 *
 *  besouro   — caçador de formigas isoladas. Evita grupos.
 *  aranha    — emboscada em trilhas: fica parada perto de feromônio de comida.
 *  vespa     — ataca berçário/larvas, ignora adultas se puder; foge de guarnição.
 *  cupim     — enxame que rói túneis e câmaras (dano em estruturas).
 *  lagarto   — grande, ignora formigas; se provocado, causa dano em área e vai embora.
 *  formiga-leão — armadilha fixa em solo úmido; captura quem passa por perto.
 *
 * Nenhum deles "persegue o jogador para sempre": todos têm fome, medo,
 * tolerância a resistência e um território de caça.
 */

import {
  BIOME, RESOURCE, ROLE, clamp, dist,
} from '../../../shared/constants.js';
import { biomeAt, isWater } from '../../../shared/worldgen.js';

export const PREDATOR = {
  BEETLE: 'beetle', SPIDER: 'spider', WASP: 'wasp',
  TERMITE: 'termite', LIZARD: 'lizard', ANTLION: 'antlion',
};

const SPECIES = {
  [PREDATOR.BEETLE]: {
    name: 'Besouro', hp: 42, power: 5, speed: 42, reach: 24, sight: 230,
    attackInterval: 12, power_rating: 5, tolerance: 2, hungerRate: 0.35,
    biomes: [BIOME.FOREST, BIOME.GARDEN, BIOME.FIELD, BIOME.ROCK],
  },
  [PREDATOR.SPIDER]: {
    name: 'Aranha', hp: 58, power: 8, speed: 66, reach: 28, sight: 180,
    attackInterval: 14, power_rating: 8, tolerance: 3, hungerRate: 0.28,
    biomes: [BIOME.FOREST, BIOME.WET, BIOME.GARDEN],
  },
  [PREDATOR.WASP]: {
    name: 'Vespa', hp: 30, power: 7, speed: 92, reach: 22, sight: 340,
    attackInterval: 10, power_rating: 7, tolerance: 2, hungerRate: 0.4,
    biomes: [BIOME.GARDEN, BIOME.FOREST, BIOME.FIELD],
  },
  [PREDATOR.TERMITE]: {
    name: 'Cupim', hp: 24, power: 4, speed: 46, reach: 20, sight: 260,
    attackInterval: 16, power_rating: 4, tolerance: 1, hungerRate: 0.5,
    biomes: [BIOME.ROCK, BIOME.FOREST, BIOME.UNDERGROUND],
  },
  [PREDATOR.LIZARD]: {
    name: 'Lagarto', hp: 220, power: 22, speed: 60, reach: 46, sight: 200,
    attackInterval: 20, power_rating: 20, tolerance: 8, hungerRate: 0.12,
    biomes: [BIOME.FIELD, BIOME.ROCK, BIOME.GARDEN],
  },
  [PREDATOR.ANTLION]: {
    name: 'Formiga-leão', hp: 36, power: 9, speed: 0, reach: 34, sight: 120,
    attackInterval: 18, power_rating: 8, tolerance: 4, hungerRate: 0.08,
    biomes: [BIOME.WET, BIOME.FIELD],
  },
};

export const PREDATOR_STATE = {
  PATROL: 0, HUNT: 1, ATTACK: 2, FLEE: 3, GORGE: 4, RAID: 5, AMBUSH: 6,
};

let predSeq = 1;
export function resetPredSeq(v = 1) { predSeq = v; }

export class Predator {
  constructor(world, kind, x, y, opts = {}) {
    const sp = SPECIES[kind];
    this._kind = 'predator';
    this.id = `d${predSeq++}`;
    this.world = world;
    this.type = kind;
    this.name = sp.name;
    this.species = sp;
    this.x = x; this.y = y;
    this.homeX = opts.homeX ?? x;
    this.homeY = opts.homeY ?? y;
    this.dir = Math.random() * Math.PI * 2;
    this.hp = sp.hp * (opts.scale ?? 1);
    this.maxHp = this.hp;
    this.power = sp.power;
    this.speed = sp.speed;
    this.reach = sp.reach;
    this.sight = sp.sight;
    this.powerRating = sp.power_rating;
    this.tolerance = sp.tolerance;
    this.attackInterval = sp.attackInterval;
    this.attackCd = 0;
    this.hunger = opts.hunger ?? 30 + Math.random() * 40;
    this.state = PREDATOR_STATE.PATROL;
    this.target = null;
    this.targetKind = null;
    this.dead = false;
    this.provoked = false;
    this.lastHitBy = null;
    this.nextThink = world.tick + Math.floor(Math.random() * 20);
    this.nextAttackCheck = 0;
    this.retreat = 0;
    this.homeColony = opts.homeColony ?? null;  // para cupins: colônia alvo
    this.structureTarget = null;
    this.webX = x; this.webY = y;
    this._spatialKey = null;
    this.regen = 0;
    this.detail = 2;
  }

  get isMobile() { return this.speed > 0; }

  think(world) {
    const sp = this.species;
    this.nextThink = world.tick + 12 + (this.id.length % 7);
    if (!this.isMobile) { this.ambushThink(world); return; }

    // 1. medo: vida baixa ou resistência forte
    const resistance = world.defence.resistanceNear(this.x, this.y, 260);
    if (this.hp < this.maxHp * 0.3 || (this.state === PREDATOR_STATE.ATTACK && resistance > this.tolerance * 2.2)) {
      this.state = this.retreat > 0 ? PREDATOR_STATE.FLEE : PREDATOR_STATE.PATROL;
      if (this.retreat <= 0 && this.hp < this.maxHp * 0.45 && Math.random() < 0.7) {
        this.retreat = world.tick + 260; // ~26s longe do perigo
        this.world.events.push('predator', `${this.name} recuou para se recuperar`, this.x, this.y);
      }
      this.target = null;
      return;
    }
    if (this.retreat > world.tick) {
      this.state = PREDATOR_STATE.FLEE;
      this.target = { x: this.homeX, y: this.homeY };
      return;
    }
    if (this.retreat > 0 && this.retreat <= world.tick) {
      this.retreat = 0;
      this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.4);
      this.provoked = false;
    }

    // 2. vespa: procura larvas / berçário
    if (this.type === PREDATOR.WASP && this.hunger > 25) {
      const larva = world.sense.nearestLarvaAnywhere(this.x, this.y, 900);
      if (larva) {
        this.target = { x: larva.x, y: larva.y };
        this.targetKind = 'ant';
        this.attackTarget = larva;
        this.state = PREDATOR_STATE.RAID;
        return;
      }
    }

    // 3. cupim: rói estruturas da colônia alvo
    if (this.type === PREDATOR.TERMITE) {
      const st = world.sense.nearestStructureNear(this.x, this.y, 700, this.homeColony);
      if (st) {
        this.target = { x: st.wx, y: st.wy };
        this.targetKind = 'structure';
        this.structureTarget = st;
        this.state = PREDATOR_STATE.RAID;
        return;
      }
    }

    // 4. fome → caça; saciado → patrulha/emboscada
    if (this.hunger > 45) {
      const q = this.findPrey(world);
      if (q) {
        this.target = { x: q.x, y: q.y };
        this.attackTarget = q;
        this.targetKind = q._kind === 'player' ? 'player' : q._kind === 'ant' ? 'ant' : 'ant';
        this.state = this.provoked ? PREDATOR_STATE.ATTACK : PREDATOR_STATE.HUNT;
        return;
      }
    }
    this.attackTarget = null;
    this.state = this.type === PREDATOR.SPIDER ? PREDATOR_STATE.AMBUSH : PREDATOR_STATE.PATROL;
    if (!this.target || dist(this.x, this.y, this.target.x, this.target.y) < 40) {
      const a = Math.random() * Math.PI * 2;
      const r = 180 + Math.random() * 420;
      let tx = this.homeX + Math.cos(a) * r;
      let ty = this.homeY + Math.sin(a) * r;
      if (isWater(this.world.seed, tx, ty)) { tx = this.homeX; ty = this.homeY; }
      this.target = { x: tx, y: ty };
      this.targetKind = 'point';
    }
  }

  /** Aranha escolhe trilhas com feromônio; besouro escolhe presas isoladas. */
  findPrey(world) {
    const candidates = [];
    // aranha prioriza feromônio de comida e presas distraídas
    for (const a of world.sense.antsNear(this.x, this.y, this.sight, null)) {
      if (!a.alive || a.role === ROLE.LARVA) continue;
      const lonely = world.sense.alliesNear(a.x, a.y, 150, a.colonyId).filter((o) => o.role === ROLE.SOLDIER).length;
      if (lonely > this.tolerance) continue;
      let score = 1000 - dist(this.x, this.y, a.x, a.y);
      if (a.carrying) score += 120;
      if (lonely === 0) score += 180;
      if (this.type === PREDATOR.SPIDER) {
        const chunk = world.chunks.get(Math.floor(a.x / 768), Math.floor(a.y / 768));
        if (chunk && chunk.pheroAt(a.x, a.y, 0) > 6) score += 300;
      }
      candidates.push([a, score]);
    }
    for (const p of world.players.near(this.x, this.y, this.sight)) {
      if (!p.alive) continue;
      let score = this.type === PREDATOR.LIZARD ? 300 : 650 - dist(this.x, this.y, p.x, p.y);
      if (this.provoked) score += 400;
      candidates.push([p, score]);
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b[1] - a[1]);
    return candidates[0][0];
  }

  ambushThink(world) {
    // formiga-leão: ataca quem pisa na armadilha; senão fica semi-enterrada
    this.state = PREDATOR_STATE.AMBUSH;
    const prey = world.sense.nearestPreyInRange(this.x, this.y, 46, this.sight);
    if (prey && world.tick > this.attackCd) {
      this.attackTarget = prey;
      this.attackCd = world.tick + this.attackInterval;
      world.combat.predatorAttack(this, prey);
      if (prey.damage) prey.damage(this.power, this);
    }
  }

  tick(world) {
    if (this.dead) return;
    if (world.tick >= this.nextThink) this.think(world);

    if (this.attackCd > 0) this.attackCd--;

    if (this.attackTarget && !this.attackTarget.dead && this.attackTarget.alive !== false) {
      const a = this.attackTarget;
      const d = dist(this.x, this.y, a.x, a.y);
      if (d > this.reach * 0.9) {
        this.stepToward(a.x, a.y, world);
      } else {
        world.combat.predatorAttack(this, a);
      }
      this.hunger = clamp(this.hunger + 0.02, 0, 100);
    } else if (this.target && this.isMobile) {
      const d = this.stepToward(this.target.x, this.target.y, world);
      if (d < 6) this.target = null;
    }

    this.hunger = clamp(this.hunger + this.species.hungerRate * 0.05, 0, 100);
    if (this.hunger > 95) this.hp -= 0.02; // fome prolongada enfraquece
    if (this.hp <= 0) {
      this.dead = true;
      world.economy.spawnCorpse(this.x, this.y, RESOURCE.INSECT, this.type === PREDATOR.LIZARD ? 55 : 12);
    }
  }

  stepToward(tx, ty, world) {
    const dx = tx - this.x, dy = ty - this.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.5) return d;
    const speed = this.speed * (this.state === PREDATOR_STATE.ATTACK ? 1.15 : 1) * (0.6 + this.hp / this.maxHp * 0.4);
    let nx = this.x + (dx / d) * speed * 0.1;
    let ny = this.y + (dy / d) * speed * 0.1;
    // nenhum predador terrestre atravessa rio/lago (vespa voa)
    if (this.type !== PREDATOR.WASP && isWater(world.seed, nx, ny)) {
      const ang = Math.atan2(dy, dx) + 1.1;
      nx = this.x + Math.cos(ang) * speed * 0.1;
      ny = this.y + Math.sin(ang) * speed * 0.1;
      if (isWater(world.seed, nx, ny)) { nx = this.x; ny = this.y; }
    }
    nx = clamp(nx, 16, world.sizePx - 16);
    ny = clamp(ny, 16, world.sizePx - 16);
    this.dir = Math.atan2(ny - this.y, nx - this.x);
    this.x = nx; this.y = ny;
    world.predIndex?.move(this);
    return d;
  }

  toNet() {
    return { id: this.id, x: this.x, y: this.y, kind: this.type, hp: this.hp, state: this.state };
  }
}

export { SPECIES as PREDATOR_SPECIES };

/** Sistema que mantém a população de predadores viva e interessante. */
export class PredatorSystem {
  constructor(world) {
    this.world = world;
    this.spawnTimer = 0;
    this.predators = new Map();
    this.migrations = [];
  }

  spawn(kind, x, y, opts = {}) {
    if (this.predators.size >= this.world.maxPredators) return null;
    if (isWater(this.world.seed, x, y) && kind !== PREDATOR.WASP) return null;
    const p = new Predator(this.world, kind, x, y, opts);
    this.predators.set(p.id, p);
    this.world.predIndex.add(p);
    return p;
  }

  chooseKind(x, y) {
    const b = biomeAt(this.world.seed, x, y);
    const options = Object.entries(SPECIES).filter(([, sp]) => sp.biomes.includes(b));
    if (!options.length) return PREDATOR.BEETLE;
    const night = this.world.isNight;
    const weights = options.map(([k, sp]) => {
      let w = 1;
      if (k === PREDATOR.WASP && night) w *= 0.35;
      if (k === PREDATOR.BEETLE && night) w *= 1.8;
      if (k === PREDATOR.SPIDER && !night) w *= 0.7;
      if (k === PREDATOR.LIZARD) w *= 0.25;
      if (k === PREDATOR.ANTLION) w *= 0.5;
      return [k, w * (sp.hungerRate + 0.4)];
    });
    let total = weights.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [k, w] of weights) { r -= w; if (r <= 0) return k; }
    return options[0][0];
  }

  /** Spawna perto de atividade (colônias/jogadores), nunca dentro da visão do jogador. */
  tick(dt) {
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 2.5;
      this.rebalance();
    }
    for (const p of this.predators.values()) {
      if (p.dead) { this.predators.delete(p.id); this.world.predIndex.remove(p); continue; }
      p.tick(this.world);
    }
  }

  rebalance() {
    const world = this.world;
    const anchors = world.activityAnchors();
    if (!anchors.length) return;

    // alvo de predadores proporcional à atividade, com teto global
    const target = Math.min(world.maxPredators, 12 + anchors.length * 5);
    if (this.predators.size >= target) return;

    const anchor = anchors[Math.floor(Math.random() * anchors.length)];
    const angle = Math.random() * Math.PI * 2;
    const radius = 600 + Math.random() * 2200;
    const x = anchor.x + Math.cos(angle) * radius;
    const y = anchor.y + Math.sin(angle) * radius;
    if (x < 64 || y < 64 || x > world.sizePx - 64 || y > world.sizePx - 64) return;
    if (world.players.near(x, y, 700).length) return; // nunca "nascer" na cara do jogador
    const kind = this.chooseKind(x, y);
    this.spawn(kind, x, y);
  }

  /** Onda de ataque coordenada (evento ambiental "migração"). */
  migration(count, targetColony) {
    const world = this.world;
    if (!targetColony) return;
    const angle = Math.random() * Math.PI * 2;
    const dist0 = 900 + Math.random() * 500;
    const bx = targetColony.nest.x + Math.cos(angle) * dist0;
    const by = targetColony.nest.y + Math.sin(angle) * dist0;
    const kind = targetColony.stock.water < targetColony.population.worker ? PREDATOR.WASP : PREDATOR.TERMITE;
    const group = [];
    for (let i = 0; i < count; i++) {
      const p = this.spawn(kind, bx + (Math.random() - 0.5) * 260, by + (Math.random() - 0.5) * 260, {
        homeColony: targetColony.id,
        homeX: bx, homeY: by,
        hunger: 70,
      });
      if (p) group.push(p);
    }
    if (group.length) {
      targetColony.alert('raid', `${group.length} ${group[0].name}s vindos de ${world.sectorLabel(bx, by)}`, bx, by, 12000);
      world.events.push('raid', `${group[0].name}s atacando ${targetColony.name}`, targetColony.nest.x, targetColony.nest.y, true);
    }
    return group;
  }

  countByKind() {
    const out = {};
    for (const p of this.predators.values()) out[p.type] = (out[p.type] || 0) + 1;
    return out;
  }
}
