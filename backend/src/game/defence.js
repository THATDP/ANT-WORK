/**
 * Defesa e guerra.
 *
 *  DefenceSystem  — percepção de ameaças, alarme, pontos de patrulha, guarnição.
 *  MilitarySystem — raids coordenadas entre colônias, com logística e desgaste.
 *
 * A IA reage a ameaças reais: alarme de colônia atrai guerreiras, e o predador
 * percebe a resistência (quanto mais soldados, maior a chance de recuar).
 */

import { ROLE, TASK, clamp, dist } from '../../../shared/constants.js';

export class DefenceSystem {
  constructor(world) {
    this.world = world;
    this.threats = new Map();       // id -> { ent, colonyId, since, x, y }
    this.alertCooldown = new Map();
    this.patrolPhase = 0;
  }

  registerAttack(ant, ent) {
    const colony = ant.colony;
    if (!colony) return;
    const key = `${colony.id}:${ent._kind}:${ent.id}`;
    const now = Date.now();
    if ((this.alertCooldown.get(key) ?? 0) > now) return;
    this.alertCooldown.set(key, now + 5000);
    this.threats.set(ent.id, { ent, colonyId: colony.id, since: this.world.tick, x: ent.x, y: ent.y });
    colony.alert('combat', `Ameaça detectada: ${ent.name || 'invasor'}`, ent.x, ent.y, 6000);
    if (ent._kind === 'predator') colony.defenceNeed = Math.min(1, (colony.defenceNeed ?? 0) + 0.35);
    if (this.alertCooldown.size > 400) {
      for (const [k, t] of this.alertCooldown) if (t < now) this.alertCooldown.delete(k);
    }
  }

  threatNear(x, y, radius, colonyId) {
    let best = null, bestD = radius * radius;
    for (const p of this.world.predIndex.near(x, y, 1, [])) {
      if (p.dead || p.state === 3 /* FLEE */) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) { bestD = d; best = { ent: p, kind: 'predator' }; }
    }
    for (const e of this.world.sense.enemyAntsNear(x, y, radius, colonyId)) {
      const d = (e.x - x) ** 2 + (e.y - y) ** 2;
      if (d < bestD) { bestD = d; best = { ent: e, kind: 'ant' }; }
    }
    return best;
  }

  /** Maior ameaça ponderada (perto do ninho pesa mais). */
  deepestThreat(colony) {
    let score = 0, best = null;
    for (const t of this.threats.values()) {
      if (t.colonyId !== colony.id) continue;
      const ent = t.ent;
      if (ent.dead || ent.alive === false) continue;
      const d = dist(ent.x, ent.y, colony.nest.x, colony.nest.y);
      const s = (ent.power ?? 2) * Math.max(0, 1 - d / 2200) + (d < 500 ? 3 : 0);
      if (s > score) { score = s; best = { ent, score, dist: d }; }
    }
    return best;
  }

  /** Resistência total (todas as colônias) — o predador avalia o custo de atacar. */
  resistanceNear(x, y, radius) {
    let n = 0;
    for (const a of this.world.antIndex.near(x, y, 1, [])) {
      if (!a.alive) continue;
      if (a.role !== ROLE.SOLDIER) continue;
      if (Math.abs(a.x - x) <= radius && Math.abs(a.y - y) <= radius) n += 1;
    }
    return n;
  }

  patrolPoint(colony, ant) {
    this.patrolPhase++;
    const t = this.world.tick * 0.01 + (parseInt(String(ant.id).replace(/\D/g, ''), 10) % 12) * 0.5;
    const radius = 140 + (ant.id % 5) * 55;
    const spread = 0.7;
    const a = t + (ant.id % 7) * spread;
    const cx = colony.nest.x + Math.cos(a) * radius;
    const cy = colony.nest.y + Math.sin(a) * radius;
    return { x: cx, y: cy };
  }

  update(dt) {
    // expira ameaças antigas
    for (const [id, t] of this.threats) {
      const ent = t.ent;
      if (ent.dead || ent.alive === false) { this.threats.delete(id); continue; }
      const d = dist(ent.x, ent.y, t.x, t.y);
      if (d < 30) t.stale = (t.stale ?? 0) + 1;
      else { t.x = ent.x; t.y = ent.y; t.stale = 0; }
      if (t.stale > 12 || this.world.tick - t.since > 1200) this.threats.delete(id);
    }
    const now = Date.now();
    for (const [k, until] of this.alertCooldown) if (until < now) this.alertCooldown.delete(k);

    for (const colony of this.world.colonies.values()) {
      let threatScore = 0;
      for (const t of this.threats.values()) {
        if (t.colonyId !== colony.id) continue;
        const d = dist(t.ent.x, t.ent.y, colony.nest.x, colony.nest.y);
        threatScore += Math.max(0.1, 1 - d / 1600);
      }
      const target = clamp(threatScore / 3, 0, 1);
      colony.defenceNeed = (colony.defenceNeed ?? 0) * 0.92 + target * 0.08;
      if (colony.defenceNeed > 0.5 && Math.random() < 0.04) {
        colony.alert('alert', 'Invasão! Guerreiras convocadas', colony.nest.x, colony.nest.y, 6000);
      }
    }
  }
}

export class MilitarySystem {
  constructor(world) {
    this.world = world;
    this.raids = [];
    this.cooldowns = new Map(); // `${attacker}->${defender}` -> tick
    this.raidSeq = 1;
    this.repairCooldowns = new Map();
  }

  requestRaid(attacker, defender) {
    if (!attacker || !defender || attacker.id === defender.id) return null;
    const key = `${attacker.id}->${defender.id}`;
    if ((this.cooldowns.get(key) ?? 0) > this.world.tick) return null;
    if (attacker.population.soldier < 5) return null;
    this.cooldowns.set(key, this.world.tick + 900); // 90 s

    const maxSoldiers = Math.min(10, Math.floor(attacker.population.soldier * 0.6));
    const group = [];
    for (const a of attacker.ants) {
      if (group.length >= maxSoldiers) break;
      if (!a.alive || a.role !== ROLE.SOLDIER) continue;
      group.push(a);
    }
    if (!group.length) return null;

    attacker.adjustRelation(defender.id, -45);
    defender.adjustRelation(attacker.id, -45);
    const angle = Math.atan2(defender.nest.y - attacker.nest.y, defender.nest.x - attacker.nest.x);
    const rally = {
      x: attacker.nest.x + Math.cos(angle) * 220,
      y: attacker.nest.y + Math.sin(angle) * 220,
    };
    for (const a of group) {
      a.setTask(TASK.PATROL, rally, 'point');
      a.raidId = this.raidSeq;
      a.state = 5;
    }
    const raid = {
      id: this.raidSeq++,
      attackerId: attacker.id,
      defenderId: defender.id,
      tick: this.world.tick,
      startedAt: Date.now(),
      soldiers: group.map((a) => a.id),
      phase: 'rally',
      rally,
      target: { x: defender.nest.x, y: defender.nest.y },
      losses: 0,
    };
    this.raids.push(raid);
    attacker.stats.raids++;
    attacker.alert('raid', `Tropas marcham contra ${defender.name}`, rally.x, rally.y, 12000);
    defender.alert('raid', `${attacker.name} está atacando!`, attacker.nest.x, attacker.nest.y, 15000);
    this.world.events.push('war', `${attacker.name} declarou ataque a ${defender.name}`, rally.x, rally.y, true);
    return raid;
  }

  update(dt) {
    const now = this.world.tick;
    for (let i = this.raids.length - 1; i >= 0; i--) {
      const r = this.raids[i];
      const attacker = this.world.colonies.get(r.attackerId);
      const defender = this.world.colonies.get(r.defenderId);
      if (!attacker || !defender) { this.raids.splice(i, 1); continue; }

      const alive = r.soldiers.map((id) => this.world.ants.get(id)).filter((a) => a && a.alive);
      if (alive.length < Math.max(2, r.soldiers.length * 0.3)) {
        r.phase = 'retreat';
      }
      if (r.phase === 'rally') {
        const arrived = alive.filter((a) => dist(a.x, a.y, r.rally.x, r.rally.y) < 60).length;
        if (arrived >= Math.max(2, alive.length * 0.7) || now - r.tick > 60) {
          r.phase = 'march';
          for (const a of alive) {
            a.setTask(TASK.ATTACK, r.target, 'colony', r.defenderId);
            a.raidId = r.id;
            a.raidTarget = { x: r.target.x, y: r.target.y };
          }
          this.world.events.push('war', `${attacker.name} avançando sobre ${defender.name}`, r.target.x, r.target.y, true);
        }
      } else if (r.phase === 'march') {
        // atacar estruturas no caminho quando não há formigas
        for (const a of alive) {
          if (a.task !== TASK.ATTACK) { a.setTask(TASK.ATTACK, r.target, 'colony', r.defenderId); }
          const st = this.world.sense.nearestStructureNear(a.x, a.y, 60, r.defenderId);
          if (st && st.progress >= 100) {
            this.world.build.damage(st, 6 * dt, a);
            defender.stats.defended++;
          }
        }
        if (now - r.tick > 1400) { r.phase = 'retreat'; }
        if (defender.population.soldier + defender.population.worker <= 1) r.phase = 'retreat';
      } else {
        for (const a of alive) {
          a.setTask(TASK.RETURN, { x: attacker.nest.x, y: attacker.nest.y }, 'point');
          a.raidId = null;
        }
        if (!alive.length || now - r.tick > 1600) this.raids.splice(i, 1);
      }
    }

    // relações esfriam com o tempo
    if (now % 300 === 0) {
      for (const c of this.world.colonies.values()) {
        for (const [other, v] of c.relations) {
          if (v < 0) c.relations.set(other, Math.min(0, v + 0.5));
        }
      }
    }
  }
}
