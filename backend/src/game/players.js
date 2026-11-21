/**
 * Sistema de jogadores: movimento autoritativo, fome/sede, morte e respawn.
 * O cliente nunca informa posição — só o vetor de intenção.
 */

import { clamp, RESOURCE, RESOURCE_INFO } from '../../../shared/constants.js';
import { Player, resetPlayerSeq } from './player.js';

export class PlayersSystem {
  constructor(world) {
    this.world = world;
    this.bySession = new Map();
    this.byId = new Map();
    this.tokens = new Map();      // token de reconexão -> sessionId
    this.sessions = new Map();    // sessionId -> { token, name, lastSeen, colonyId }
  }

  spawn(sessionId, name, colonyId, x, y, color) {
    let p = this.bySession.get(sessionId);
    if (p) return p;
    p = new Player({ sessionId, name, colonyId, x, y, color });
    this.bySession.set(sessionId, p);
    this.byId.set(p.id, p);
    return p;
  }

  remove(sessionId) {
    const p = this.bySession.get(sessionId);
    if (!p) return;
    this.bySession.delete(sessionId);
    this.byId.delete(p.id);
  }

  get(sessionId) { return this.bySession.get(sessionId); }
  getById(id) { return this.byId.get(id); }

  all() { return [...this.bySession.values()]; }

  near(x, y, radius) {
    const out = [];
    const r2 = radius * radius;
    for (const p of this.bySession.values()) {
      if (!p.alive) continue;
      const dx = p.x - x, dy = p.y - y;
      if (dx * dx + dy * dy <= r2) out.push(p);
    }
    return out;
  }

  /** Aplica movimento com colisão de água (mesma regra das formigas). */
  move(p, vx, vy, dt, speedMul = 1) {
    if (!p.alive) return;
    const world = this.world;
    const speed = p.speed * speedMul * world.terrainSpeedAt(p.x, p.y);
    let nx = p.x + vx * speed * dt;
    let ny = p.y + vy * speed * dt;
    if (world.isWaterCached(nx, ny)) {
      const tryX = world.isWaterCached(nx, p.y);
      const tryY = world.isWaterCached(p.x, ny);
      if (!tryX) ny = p.y;
      else if (!tryY) nx = p.x;
      else { nx = p.x; ny = p.y; }
    }
    nx = clamp(nx, 10, world.sizePx - 10);
    ny = clamp(ny, 10, world.sizePx - 10);
    if (Math.abs(nx - p.x) + Math.abs(ny - p.y) > 0.001) {
      p.dir = Math.atan2(ny - p.y, nx - p.x);
    }
    p.x = nx; p.y = ny;
    p.vx = vx; p.vy = vy;
  }

  update(dt) {
    const world = this.world;
    const now = Date.now();
    for (const p of this.bySession.values()) {
      if (!p.alive) {
        if (p.respawnAt && now >= p.respawnAt) {
          // auto-respawn no ninho (ou ponto inicial se não tiver colônia)
          this.respawn(p);
        }
        continue;
      }
      p.stats.playtime += dt;
      p.hunger = Math.min(120, p.hunger + 0.5 * dt);
      p.thirst = Math.min(120, p.thirst + 0.4 * dt);
      if (p.hunger > 85 || p.thirst > 90) {
        p.hp -= 0.4 * dt;
        if (p.hp <= 0) this.kill(p, null, 'fome');
      } else if (p.hp < p.maxHp && p.hunger < 40 && p.thirst < 40) {
        p.hp = Math.min(p.maxHp, p.hp + 0.25 * dt);
      }
      // efeito do bioma: contaminado machuca devagar
      const biome = world.biomeSafe(p.x, p.y);
      if (biome === 7) p.hp -= 0.25 * dt;
      if (p.hp <= 0) this.kill(p, null, 'contaminação');
    }
  }

  damagePlayer(p, dmg, sourceColonyId, label = 'ameaça', silent = false) {
    if (!p || !p.alive) return;
    p.hp -= dmg;
    if (!silent) p.lastHit = { label, at: Date.now() };
    if (sourceColonyId) {
      const c = this.world.colonies.get(p.colonyId);
      const attacker = this.world.colonies.get(sourceColonyId);
      if (c && attacker) c.adjustRelation(attacker.id, -2);
    }
    if (p.hp <= 0) this.kill(p, sourceColonyId, label);
  }

  kill(p, sourceColonyId, label = 'ameaça') {
    if (!p.alive) return;
    p.alive = false;
    p.hp = 0;
    p.respawnAt = Date.now() + 7000;
    p.stats.deaths++;
    // carga cai no chão
    if (p.carrying.amount > 0 && p.carrying.kind >= 0) {
      this.world.resources.spawnCorpse(p.x, p.y, p.carrying.kind, Math.min(p.carrying.amount, 20));
      p.carrying = { kind: -1, amount: 0 };
    }
    const colony = this.world.colonies.get(p.colonyId);
    if (colony) {
      colony.stats.deaths++;
      colony.morale = clamp(colony.morale - 1.5, 0, 100);
      colony.alert('death', `${p.name} caiu para ${label}`, p.x, p.y, 9000);
    }
    if (sourceColonyId) {
      const attacker = this.world.colonies.get(sourceColonyId);
      if (attacker) attacker.stats.kills++;
    }
    this.world.events.push('death', `${p.name} morreu (${label})`, p.x, p.y, true);
    this.world.onPlayerEvent?.(p, 'die');
  }

  respawn(p) {
    const colony = this.world.colonies.get(p.colonyId);
    const x = colony ? colony.nest.x + (Math.random() - 0.5) * 70 : this.world.sizePx / 2;
    const y = colony ? colony.nest.y + (Math.random() - 0.5) * 70 : this.world.sizePx / 2;
    p.x = x; p.y = y;
    p.hp = Math.round(p.maxHp * 0.6);
    p.hunger = Math.max(0, p.hunger - 40);
    p.thirst = Math.max(0, p.thirst - 40);
    p.alive = true;
    p.respawnAt = 0;
    p.carrying = { kind: -1, amount: 0 };
    this.world.onPlayerEvent?.(p, 'respawn');
    return p;
  }

  /** Registra sessão e token de reconexão (o token é gerado pela camada de rede). */
  rememberSession(sessionId, token, name, colonyId) {
    this.sessions.set(sessionId, { token, name, lastSeen: Date.now(), colonyId });
    this.tokens.set(token, sessionId);
  }

  findByToken(token) {
    const sid = this.tokens.get(token);
    if (!sid) return null;
    return this.sessions.get(sid) ?? null;
  }

  /** Resolve token opaco → sessão (usado no handshake de reconexão). */
  resolveToken(token) {
    const sessionId = this.tokens.get(token);
    if (!sessionId) return null;
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return { sessionId, ...s };
  }

  touch(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s) s.lastSeen = Date.now();
  }

  /** Limpa sessões ociosas depois da janela de reconexão. */
  gc(maxIdleMs) {
    const now = Date.now();
    for (const [sid, s] of this.sessions) {
      if (now - s.lastSeen > maxIdleMs && !this.bySession.has(sid)) {
        this.sessions.delete(sid);
        this.tokens.delete(s.token);
      }
    }
  }

  stats() {
    const players = [...this.bySession.values()];
    return {
      total: players.length,
      alive: players.filter((p) => p.alive).length,
      carrying: players.reduce((s, p) => s + p.carrying.amount, 0),
    };
  }

  reset() {
    this.bySession.clear();
    this.byId.clear();
    this.tokens.clear();
    this.sessions.clear();
    resetPlayerSeq();
  }
}
