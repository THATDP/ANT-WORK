/**
 * Combate autoritativo. Cliente só pede "atacar alvo X"; servidor calcula
 * distância, cooldown, dano, morte e espólio.
 *
 * Regras:
 *  - soldado causa 4, operária/exploradora 1, rainha 2 (por golpe).
 *  - guarnição: cada soldado aliado a 200px soma +8% de dano (máx +40%).
 *  - predador tem poder próprio e foge quando a relação ameaça/defesa é ruim.
 *  - formiga morta vira "carcaça" (recurso INSECT) — o ecossistema recicla tudo.
 */

import { ROLE, RESOURCE, TASK, clamp } from '../../../shared/constants.js';

const ATTACK_RANGE = { ant: 20, predator: 30, player: 26 };
const BASE_COOLDOWN = 9; // ticks (0.9s)

export class CombatSystem {
  constructor(world) {
    this.world = world;
    this.recentKills = [];
  }

  garrisonBonus(ant) {
    let allies = 0;
    for (const a of this.world.sense.alliesNear(ant.x, ant.y, 200, ant.colonyId)) {
      if (a.role === ROLE.SOLDIER && a.alive) allies++;
    }
    return Math.min(0.4, allies * 0.08);
  }

  /** Chamado no tick para formigas com tarefa de ataque. */
  antVsTarget(ant, target) {
    if (!target || target.dead || target.alive === false) return;
    if (ant.attackCd > 0) { ant.attackCd--; return; }
    const dx = target.x - ant.x, dy = target.y - ant.y;
    const d = Math.hypot(dx, dy);
    const kind = target._kind === 'predator' ? 'predator' : target._kind === 'player' ? 'player' : 'ant';
    if (d > (ATTACK_RANGE[kind] ?? 24)) return;

    ant.attackCd = BASE_COOLDOWN + (ant.id % 3);
    let dmg = ant.info.damage * (1 + this.garrisonBonus(ant));
    if (ant.hp < ant.maxHp * 0.3) dmg *= 0.7;
    dmg *= 0.85 + Math.random() * 0.3; // variação natural
    dmg = Math.max(1, Math.round(dmg));

    if (kind === 'predator') {
      target.hp -= dmg;
      target.provoked = true;
      target.lastHitBy = ant.colonyId;
      if (target.hp <= 0) this.onPredatorKilled(target, ant);
    } else if (kind === 'ant') {
      target.damage?.(dmg, ant);
      if (!target.alive) this.onAntKilled(target, ant);
    } else if (kind === 'player') {
      this.world.players.damagePlayer(target, dmg, ant.colonyId, 'formigas inimigas');
    }

  }

  onAntKilled(victim, killerAnt) {
    const killerColony = killerAnt?.colony;
    if (killerColony) {
      killerColony.stats.kills++;
      killerColony.morale = clamp(killerColony.morale + 1, 0, 100);
    }
    const victimColony = this.world.colonies.get(victim.colonyId);
    if (victimColony) {
      victimColony.adjustRelation(killerAnt.colonyId, -6);
    }
    this.world.economy.spawnCorpse(victim.x, victim.y, RESOURCE.INSECT, 6);
    this.world.events.push('battle', victimColony
      ? `Uma ${victim.role === ROLE.SOLDIER ? 'guerreira' : 'formiga'} de ${victimColony.name} caiu`
      : 'Uma formiga morreu', victim.x, victim.y);
  }

  onPredatorKilled(pred, ant) {
    pred.dead = true;
    pred.hp = 0;
    this.world.economy.spawnCorpse(pred.x, pred.y, RESOURCE.INSECT, pred.kind === 'lizard' ? 60 : pred.kind === 'beetle' ? 22 : 14);
    const c = ant?.colony;
    if (c) {
      c.stats.kills++;
      c.morale = clamp(c.morale + 3, 0, 100);
      c.alert('victory', `${pred.name} abatido`, pred.x, pred.y, 7000);
    }
    this.world.events.push('battle', `${pred.name} foi abatido`, pred.x, pred.y);
    this.recentKills.push({ id: pred.id, tick: this.world.tick });
  }

  /** Predador atacando uma formiga ou jogador. */
  predatorAttack(pred, target) {
    if (pred.attackCd > 0) { pred.attackCd--; return; }
    const d = Math.hypot(target.x - pred.x, target.y - pred.y);
    if (d > pred.reach) return;
    pred.attackCd = pred.attackInterval;
    const dmg = pred.power * (0.8 + Math.random() * 0.5);
    if (target._kind === 'player') {
      this.world.players.damagePlayer(target, dmg, null, pred.name);
    } else {
      target.damage?.(dmg, pred);
      if (!target.alive) this.world.economy.spawnCorpse(target.x, target.y, RESOURCE.INSECT, 5);
    }
    pred.hunger = clamp(pred.hunger - 12, 0, 100);
  }

  /** Estatísticas para o painel de rede. */
  summary() {
    return { recentKills: this.recentKills.length };
  }
}

export { ATTACK_RANGE };
