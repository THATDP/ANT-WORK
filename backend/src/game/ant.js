/**
 * Formiga individual (IA). Cada uma tem objetivos, limitações e um estado.
 *
 * NÍVEIS DE DETALHE (LOD)
 *  0 — perto de um jogador: pensa a cada ~0.4s e anda todo tick.
 *  1 — a até ~2.5 chunks: pensa a cada ~1.2s, anda a cada 2 ticks.
 *  2 — longe: modo abstrato. Não tem física: resolve coleta/entrega por
 *      estatística no "tick abstrato" da colônia (world.economy). Continua
 *      existindo como indivíduo (população, fome, morte), sem gastar CPU.
 *
 * Isso mantém milhares de formigas vivas no mundo com custo próximo de zero
 * quando ninguém está olhando.
 */

import {
  ROLE, ROLE_INFO, TASK, TASK_NAME, ANT_STATE, BUILDING, RESOURCE, RESOURCE_INFO,
  BIOME_INFO, clamp, dist,
} from '../../../shared/constants.js';
import { biomeAt } from '../../../shared/worldgen.js';

let antSeq = 1;
export function resetAntSeq(v = 1) { antSeq = v; }
export function nextAntId() { return antSeq++; }

export class Ant {
  constructor(world, colony, opts = {}) {
    this.world = world;
    this.id = opts.id ?? nextAntId();
    this.colonyId = colony.id;
    this.role = opts.role ?? ROLE.WORKER;
    this.info = ROLE_INFO[this.role];
    this.x = opts.x ?? colony.nest.x;
    this.y = opts.y ?? colony.nest.y;
    this.vx = 0;
    this.vy = 0;
    this.dir = Math.random() * Math.PI * 2;
    this.maxHp = this.info.hp;
    this.hp = opts.hp ?? this.maxHp;
    this.alive = true;
    this.task = TASK.IDLE;
    this.state = ANT_STATE.SEEK;
    this.target = { x: this.x, y: this.y };
    this.targetKind = null;   // 'node' | 'structure' | 'ant' | 'predator' | 'point'
    this.targetId = null;
    this.cargo = { kind: -1, amount: 0 };
    this.hunger = opts.hunger ?? Math.random() * 30;
    this.thirst = opts.thirst ?? Math.random() * 25;
    this.age = opts.age ?? 0;
    this.nextThink = world.tick + Math.floor(Math.random() * 8);
    this.thinkInterval = 4;
    this.detail = 2;
    this.stepPhase = 0;
    this.workTimer = 0;
    this.workNeeded = 0;
    this.attackCd = 0;
    this.speedMul = 0.9 + Math.random() * 0.2;
    this.carryCap = this.info.carry;
    this.fleeTimer = 0;
    this.pheroCd = 0;
    this.homeChunk = `${Math.floor(this.x / 768)},${Math.floor(this.y / 768)}`;
    this.development = this.role === ROLE.LARVA ? (opts.development ?? 0) : 0;
    this.lastTask = -1;
    this.flags = 0;           // bit0: carregando, bit1: construindo, bit2: ferida
    this.gatherStreak = 0;
    this.escort = null;
    this._spatialKey = null;
  }

  get colony() { return this.world.colonies.get(this.colonyId); }

  get carrying() { return this.cargo.amount > 0; }

  updateFlags() {
    let f = 0;
    if (this.carrying) f |= 1;
    if (this.task === TASK.BUILD || this.task === TASK.REPAIR) f |= 2;
    if (this.hp < this.maxHp * 0.4) f |= 4;
    if (this.task === TASK.ATTACK || this.task === TASK.DEFEND) f |= 8;
    this.flags = f;
  }

  setTask(task, target = null, targetKind = null, targetId = null) {
    // repensar a mesma tarefa no mesmo alvo NÃO pode zerar o progresso de
    // trabalho (senão uma operária nunca termina de coletar: o cérebro
    // reafirma FORAGE a cada 4–6 ticks e a coleta leva ~11 ticks)
    const sameTarget = this.task === task && this.targetKind === targetKind && this.targetId === targetId;
    this.task = task;
    if (!sameTarget) {
      this.state = ANT_STATE.SEEK;
      this.workTimer = 0;
      this.workNeeded = 0;
    } else if (this.state === ANT_STATE.SEEK) {
      this.state = ANT_STATE.MOVE;
    }
    if (target) { this.target.x = target.x; this.target.y = target.y; }
    this.targetKind = targetKind;
    this.targetId = targetId;
  }

  setTargetPoint(x, y) {
    this.target.x = x;
    this.target.y = y;
    this.targetKind = 'point';
    this.targetId = null;
  }

  // ------------------------------------------------------------ movimento
  moveToward(tx, ty, dt) {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-3) return 0;
    const speed = this.effectiveSpeed();
    const arrive = Math.min(1, d / 24);
    const nx = (dx / d) * speed * arrive;
    const ny = (dy / d) * speed * arrive;
    return this.stepVelocity(nx, ny, dt);
  }

  effectiveSpeed() {
    const colony = this.colony;
    const b = this.world.biomeSafe(this.x, this.y);
    const info = BIOME_INFO[b] || BIOME_INFO[0];
    let s = this.info.speed * this.speedMul * info.speed * this.world.weatherSpeedMul;
    if (this.carrying) s *= 0.82;
    if (this.hunger > 70) s *= 0.86;
    if (this.hp < this.maxHp * 0.35) s *= 0.8;
    if (colony && colony.morale < 25) s *= 0.9;
    if (this.escort) s *= 1.02;
    return s;
  }

  /** Move com desvio de água e limites do mundo. Retorna distância andada. */
  stepVelocity(vx, vy, dt) {
    const world = this.world;
    let nx = this.x + vx * dt;
    let ny = this.y + vy * dt;
    if (world.isWaterCached(nx, ny)) {
      // desliza pela margem: testa componentes isoladas e girando o vetor
      const tryX = world.isWaterCached(nx, this.y);
      const tryY = world.isWaterCached(this.x, ny);
      if (!tryX) { ny = this.y; }
      else if (!tryY) { nx = this.x; }
      else {
        const ang = Math.atan2(vy, vx) + (this.id % 2 ? 1.2 : -1.2);
        nx = this.x + Math.cos(ang) * Math.hypot(vx, vy) * dt;
        ny = this.y + Math.sin(ang) * Math.hypot(vx, vy) * dt;
        if (world.isWaterCached(nx, ny)) { nx = this.x; ny = this.y; }
      }
    }
    nx = clamp(nx, 8, world.sizePx - 8);
    ny = clamp(ny, 8, world.sizePx - 8);
    const moved = Math.hypot(nx - this.x, ny - this.y);
    if (moved > 1e-4) this.dir = Math.atan2(ny - this.y, nx - this.x);
    this.x = nx;
    this.y = ny;
    this.vx = vx;
    this.vy = vy;
    return moved;
  }

  /** Progresso de trabalho (coleta, construção, cuidado). */
  work(dt, needed, onDone) {
    this.state = ANT_STATE.WORK;
    this.workNeeded = needed;
    this.workTimer += dt;
    if (this.workTimer >= needed) {
      this.workTimer = 0;
      this.workNeeded = 0;
      return onDone ? onDone() : true;
    }
    return false;
  }

  // ------------------------------------------------------------ dano/morte
  damage(amount, source) {
    if (!this.alive) return;
    this.hp -= amount;
    this.hp = Math.max(0, this.hp);
    if (this.hp <= 0) this.die(source);
  }

  die(source = null) {
    if (!this.alive) return;
    this.alive = false;
    this.state = ANT_STATE.DEAD;
    const colony = this.colony;
    if (colony) {
      colony.stats.deaths++;
      colony.morale = clamp(colony.morale - (this.role === ROLE.LARVA ? 2.5 : 0.6), 0, 100);
    }
    this.world.onAntDeath(this, source);
  }

  canEat() {
    return this.hunger > 55 || this.thirst > 60 || this.hp < this.maxHp * 0.5;
  }

  /** Alimenta-se do estoque da colônia. Só chamado perto do ninho/berçário. */
  eatFromColony() {
    const colony = this.colony;
    if (!colony) return false;
    let ate = false;
    if (this.thirst > 45 && colony.stock.water > 0) {
      const w = colony.takeWater(1);
      if (w) { this.thirst = Math.max(0, this.thirst - 45); ate = true; }
    }
    if (this.hunger > 45 && colony.takeFood(1) > 0) {
      this.hunger = Math.max(0, this.hunger - 45);
      this.hp = Math.min(this.maxHp, this.hp + 2);
      ate = true;
    }
    return ate;
  }

  describe() {
    if (this.role === ROLE.LARVA) return 'Larva em desenvolvimento';
    return `${ROLE_INFO[this.role].name} · ${TASK_NAME[this.task]}`;
  }
}

export const ANT_MOVE_EPS = 12;
