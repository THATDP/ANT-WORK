/**
 * Estado global do cliente + um emissor de eventos minúsculo.
 * Não é framework: é um objeto com atualizações explícitas e eventos nomeados.
 */

import { BIOME_INFO, RESOURCE_INFO, RESOURCE_KEYS, ROLE_INFO, BUILDING_INFO } from '@shared/constants.js';

class Emitter {
  constructor() { this.map = new Map(); }
  on(evt, fn) {
    if (!this.map.has(evt)) this.map.set(evt, new Set());
    this.map.get(evt).add(fn);
    return () => this.map.get(evt)?.delete(fn);
  }
  emit(evt, payload) {
    for (const fn of this.map.get(evt) ?? []) {
      try { fn(payload); } catch (err) { console.error(`[bus:${evt}]`, err); }
    }
  }
}

export const bus = new Emitter();

const SETTINGS_KEY = 'antlife.settings.v1';

function loadSettings() {
  const defaults = {
    volume: 0.45, zoom: 1, particles: true, names: true, shake: true, sound: true,
    name: '', token: '', server: '',
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch {
    return defaults;
  }
}

export const state = {
  phase: 'loading',            // loading | menu | playing
  settings: loadSettings(),
  serverUrl: '',
  connected: false,
  connecting: false,
  error: '',

  token: '',
  sessionId: '',
  selfId: '',
  name: '',
  world: null,                 // {id, seed, sizePx, chunkPx, chunks}
  spawn: null,
  self: null,                  // [x,y,hp,hunger,thirst,carryKind,carryAmount,alive,respawnAt,colonyId,dir]
  colony: null,                // estado detalhado da colônia
  nearbyColonies: [],
  colonies: [],
  players: [],
  inventory: { kind: -1, amount: 0, cap: 8 },

  env: { day: 1, part: 'manhã', weather: 'clear', temperature: 24, night: 0, phase: 0.3 },
  log: [],
  chat: [],
  chatChannel: 'global',
  unreadChat: 0,
  latency: 0,
  joinedAt: 0,             // usado para liberar a fundação de colônia
  input: { x: 0, y: 0 },   // vetor de intenção enviado ao servidor (nunca posição)

  pingTs: 0,
  lastSnapAt: 0,
  serverTick: 0,
  icons: {},
};

export function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      volume: state.settings.volume,
      zoom: state.settings.zoom,
      particles: state.settings.particles,
      names: state.settings.names,
      shake: state.settings.shake,
      sound: state.settings.sound,
      name: state.settings.name,
      token: state.token || state.settings.token,
      server: state.settings.server,
    }));
  } catch { /* modo privado */ }
}

export const RES_META = RESOURCE_KEYS.map((k) => ({ key: k, ...RESOURCE_INFO[RESOURCE_KEYS.indexOf(k)] }));
export const BIOMES = BIOME_INFO;
export const ROLES = ROLE_INFO;
export const BUILDINGS = BUILDING_INFO;

export function hex(color) {
  return `#${(color ?? 0xffffff).toString(16).padStart(6, '0')}`;
}

export function fmt(n) {
  if (n == null || Number.isNaN(n)) return '–';
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

export function clockLabel(env) {
  const phase = env?.phase ?? 0;
  const hours = Math.floor(((phase * 24) + 6) % 24);
  const mins = Math.floor((((phase * 24) + 6) % 1) * 60);
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

export const WEATHER_ICON = {
  clear: '☀', rain: '🌧', storm: '⛈', fog: '🌫', heat: '🔥',
};

export const RES_ICON = {
  leaf: '❧', seed: '•', fruit: '❍', insect: '✦', water: '≈', material: '▰', spore: '✷',
};

export function resourceColor(kind) {
  const meta = RESOURCE_INFO[kind];
  return meta ? `#${meta.color.toString(16).padStart(6, '0')}` : '#999';
}

export function resourceName(kind) {
  return RESOURCE_INFO[kind]?.name ?? 'Recurso';
}

/** Distância segura para o jogador (px de mundo). */
export function distTo(x, y) {
  const s = state.self;
  if (!s) return Infinity;
  return Math.hypot(s[0] - x, s[1] - y);
}
