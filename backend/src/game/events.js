/**
 * Ambiente e eventos do ecossistema.
 *
 * O clima não é enfeite: chuva enche os pontos de água e reduz velocidade;
 * calor acelera a sede; neblina reduz a visão das exploradoras; noite deixa
 * besouros e aranhas mais agressivos. Eventos raros mudam a maré de uma partida:
 * floração, seca, nuvem contaminada, migração de predadores.
 *
 * Tudo é determinístico em relação à semente + tempo de jogo, para que o
 * servidor possa reconstruir o estado após um restart.
 */

import {
  DAY_LENGTH_TICKS, WEATHER, WEATHER_INFO, BIOME, RESOURCE, clamp,
} from '../../../shared/constants.js';
import { fbm2, hash2 } from '../../../shared/util-noise.js';

export class Environment {
  constructor(world) {
    this.world = world;
    this.day = 0;
    this.dayPhase = 0.25;          // começa de manhã
    this.isNight = false;
    this.weather = 'clear';
    this.weatherAge = 0;
    this.temperature = 24;
    this.light = 1;
    this.lastWeatherEvent = 0;
  }

  get weatherSpeedMul() {
    return WEATHER_INFO[this.weather]?.speedMul ?? 1;
  }

  get visibility() { return WEATHER_INFO[this.weather]?.visibility ?? 1; }

  tick(dt, tick) {
    this.day = Math.floor(tick / DAY_LENGTH_TICKS);
    this.dayPhase = (tick % DAY_LENGTH_TICKS) / DAY_LENGTH_TICKS;
    const wasNight = this.isNight;
    this.isNight = this.dayPhase > 0.76 || this.dayPhase < 0.06;
    this.light = this.isNight ? 0.45 : 0.65 + Math.sin(this.dayPhase * Math.PI * 2 - Math.PI / 2) * 0.35;
    if (wasNight !== this.isNight) {
      this.world.events.push('env', this.isNight ? 'A noite cai sobre o formigueiro' : 'O sol nasce', this.world.sizePx / 2, this.world.sizePx / 2, false);
    }

    // transição de clima determinística com base na semente e no tempo
    this.weatherAge += dt;
    if (this.weatherAge > 150) {
      const r = hash2(Math.floor(tick / 10), this.world.seed & 0xffff, this.world.seed + 17);
      const cold = this.dayPhase < 0.3 || this.dayPhase > 0.8;
      if (r < 0.32) this.setWeather('clear');
      else if (r < 0.52) this.setWeather(cold ? 'fog' : 'heat');
      else if (r < 0.74) this.setWeather('rain');
      else if (r < 0.86) this.setWeather('storm');
      else this.setWeather(this.weather === 'rain' ? 'storm' : 'clear');
    }

    const baseTemp = 22 + Math.sin((this.dayPhase - 0.25) * Math.PI * 2) * 8;
    const wTemp = this.weather === 'heat' ? 7 : this.weather === 'rain' ? -4 : this.weather === 'storm' ? -6 : this.weather === 'fog' ? -2 : 0;
    this.temperature = baseTemp + wTemp;
  }

  setWeather(w) {
    if (!WEATHER.includes(w) || w === this.weather) return;
    this.weather = w;
    this.weatherAge = 0;
    this.world.events.push('env', `Clima: ${WEATHER_INFO[w].name.toLowerCase()}`, this.world.sizePx / 2, this.world.sizePx / 2, false);
  }

  describe() {
    const w = WEATHER_INFO[this.weather]?.name ?? 'Limpo';
    const phase = this.dayPhase;
    const part = phase < 0.22 ? 'amanhecer' : phase < 0.5 ? 'manhã' : phase < 0.72 ? 'tarde' : phase < 0.9 ? 'anoitecer' : 'noite';
    return { day: this.day + 1, part, weather: w, weatherKey: this.weather, temperature: Math.round(this.temperature), night: this.isNight, phase };
  }
}

const EVENT_TYPES = [
  { kind: 'bloom', weight: 30, cooldown: 240 },
  { kind: 'drought', weight: 18, cooldown: 420 },
  { kind: 'migration', weight: 18, cooldown: 300 },
  { kind: 'contamination', weight: 10, cooldown: 600 },
  { kind: 'honeydew', weight: 16, cooldown: 300 },
  { kind: 'windfall', weight: 14, cooldown: 360 },
];

export class WorldEvents {
  constructor(world) {
    this.world = world;
    this.timer = 120;
    this.cooldowns = new Map();
    this.active = [];
  }

  /** Escolhe uma área com atividade para o evento acontecer (não no vazio). */
  pickArea() {
    const anchors = this.world.activityAnchors();
    if (!anchors.length) {
      return { x: this.world.sizePx / 2, y: this.world.sizePx / 2 };
    }
    return anchors[Math.floor(Math.random() * anchors.length)];
  }

  tick(dt) {
    this.timer -= dt;
    this.active = this.active.filter((a) => a.until > this.world.tick);
    if (this.timer > 0) return;
    this.timer = 100 + Math.random() * 110;
    this.trigger(this.pickEvent());
  }

  pickEvent() {
    const now = this.world.tick;
    const options = EVENT_TYPES.filter((e) => (this.cooldowns.get(e.kind) ?? 0) < now);
    if (!options.length) return null;
    let total = options.reduce((s, e) => s + e.weight, 0);
    let r = Math.random() * total;
    for (const e of options) { r -= e.weight; if (r <= 0) return e.kind; }
    return options[0].kind;
  }

  trigger(kind) {
    if (!kind) return;
    const world = this.world;
    const ev = EVENT_TYPES.find((e) => e.kind === kind);
    if (ev) this.cooldowns.set(kind, world.tick + ev.cooldown * 10);
    const area = this.pickArea();
    const { cx, cy } = world.chunkOf(area.x, area.y);
    const label = world.sectorLabel(area.x, area.y);

    switch (kind) {
      case 'bloom': {
        // floração: recursos de folha/fruta/semente rebrotam na região
        const chunks = this.nearChunks(cx, cy, 2);
        let revived = 0;
        for (const c of chunks) {
          for (const n of c.nodes) {
            if (n.id < 0) continue;
            if ([RESOURCE.LEAF, RESOURCE.FRUIT, RESOURCE.SEED].includes(n.kind) && n.amount < n.max) {
              n.amount = Math.min(n.max, n.amount + n.max * 0.6);
              c.dirtyNodes.add(n.id);
              revived++;
            }
          }
        }
        world.events.push('env', `Floração em ${label}: ${revived} fontes de alimento revigoradas`, area.x, area.y, true);
        break;
      }
      case 'drought': {
        const chunks = this.nearChunks(cx, cy, 3);
        let dried = 0;
        for (const c of chunks) {
          for (const n of c.nodes) {
            if (n.kind === RESOURCE.WATER && n.id > 0) {
              n.amount = Math.max(0, n.amount * 0.25);
              n.respawnAt = world.tick + 300;
              c.dirtyNodes.add(n.id);
              dried++;
            }
          }
        }
        world.env.setWeather('heat');
        world.events.push('env', `Seca em ${label}: ${dried} pontos de água secaram`, area.x, area.y, true);
        break;
      }
      case 'migration': {
        const colonies = world.coloniesNear(area.x, area.y, 5);
        const target = colonies[Math.floor(Math.random() * Math.max(1, colonies.length))];
        const count = 3 + Math.floor(Math.random() * 5);
        const group = world.predators.migration(count, target);
        world.events.push('env', group?.length
          ? `Migração de ${group[0].name.toLowerCase()}s (${group.length}) rumo a ${target?.name ?? label}`
          : `Rastros de migração em ${label}`, area.x, area.y, true);
        break;
      }
      case 'contamination': {
        // nuvem contaminada: dano lento a quem está na área, mas esporos raros
        const chunk = world.chunks.get(cx, cy);
        for (const n of chunk.nodes) {
          if (n.id > 0 && (n.kind === RESOURCE.LEAF || n.kind === RESOURCE.SEED)) {
            n.kind = RESOURCE.SPORE;
            n.max = Math.max(20, n.max * 0.5);
            n.amount = n.max;
            chunk.dirtyNodes.add(n.id);
          }
        }
        this.active.push({ kind: 'contamination', x: area.x, y: area.y, radius: 700, until: world.tick + 1200, dps: 0.35 });
        chunk.resourceVersion++;
        world.events.push('env', `Nuvem contaminada avança sobre ${label}`, area.x, area.y, true);
        break;
      }
      case 'honeydew': {
        // pulgões: chuva de açúcar — frutas e sementes extras
        const chunk = world.chunks.get(cx, cy);
        for (let i = 0; i < 6; i++) {
          const node = {
            id: -(1_000_000 + Math.floor(Math.random() * 900_000)),
            x: chunk.originX + Math.random() * 768,
            y: chunk.originY + Math.random() * 768,
            kind: Math.random() < 0.5 ? RESOURCE.FRUIT : RESOURCE.SEED,
            amount: 60, max: 60,
            respawnAt: world.tick + 2400,
            chunk: chunk.key, temporary: true,
          };
          chunk.nodes.push(node);
          chunk.nodesById.set(node.id, node);
        }
        chunk.resourceVersion++;
        world.events.push('env', `Doce de pulgão cai em ${label}`, area.x, area.y, true);
        break;
      }
      case 'windfall': {
        // queda de material (galho/folhas) em abundância
        const chunk = world.chunks.get(cx, cy);
        for (let i = 0; i < 5; i++) {
          const node = {
            id: -(2_000_000 + Math.floor(Math.random() * 900_000)),
            x: chunk.originX + Math.random() * 768,
            y: chunk.originY + Math.random() * 768,
            kind: RESOURCE.MATERIAL,
            amount: 120, max: 120,
            respawnAt: world.tick + 1800,
            chunk: chunk.key, temporary: true,
          };
          chunk.nodes.push(node);
          chunk.nodesById.set(node.id, node);
        }
        chunk.resourceVersion++;
        world.events.push('env', `Galhos caem em ${label}: materiais disponíveis`, area.x, area.y, true);
        break;
      }
      default: break;
    }
  }

  nearChunks(cx, cy, r) {
    const out = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const c = this.world.chunks.chunks.get(`${cx + dx},${cy + dy}`);
        if (c) out.push(c);
      }
    }
    return out;
  }

  /** Efeitos contínuos (nuvem contaminada). */
  applyContinuous(dt) {
    for (const a of this.active) {
      if (a.kind !== 'contamination') continue;
      for (const ant of this.world.antIndex.near(a.x, a.y, 1, [])) {
        if (Math.hypot(ant.x - a.x, ant.y - a.y) > a.radius) continue;
        if (ant.role === 4) continue;
        ant.hp -= a.dps * dt;
        if (ant.hp <= 0) ant.die('contaminação');
      }
      for (const p of this.world.players.near(a.x, a.y, a.radius)) {
        if (!p.alive) continue;
        this.world.players.damagePlayer(p, a.dps * dt, null, 'nuvem contaminada', true);
      }
    }
  }

  describeActive() {
    return this.active.map((a) => ({ kind: a.kind, x: a.x, y: a.y, radius: a.radius, until: a.until }));
  }
}

/** Log de eventos do mundo (ring buffer) enviado aos clientes. */
export class EventLog {
  constructor(world, max = 120) {
    this.world = world;
    this.max = max;
    this.items = [];
    this.seq = 1;
  }

  push(kind, text, x = 0, y = 0, important = false) {
    const item = { id: this.seq++, kind, text, x: Math.round(x), y: Math.round(y), tick: this.world.tick, important };
    this.items.push(item);
    if (this.items.length > this.max) this.items.shift();
    this.world.onEvent?.(item);
    return item;
  }

  recent(n = 14) { return this.items.slice(-n); }
}

export { fbm2, BIOME, clamp };
