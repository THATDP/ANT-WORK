/**
 * ANT LIFE — bootstrap do cliente.
 * Liga Phaser, a rede, a HUD e os menus; mantém um único fluxo de estado.
 */

import Phaser from 'phaser';
import './styles.css';
import { state, bus, saveSettings } from './state.js';
import { net } from './net/client.js';
import { hud } from './ui/hud.js';
import { panels } from './ui/panels.js';
import { audio } from './audio.js';
import { buildTextures } from './game/art/textures.js';
import { WorldScene } from './game/scenes/WorldScene.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- Phaser
class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }
  create() {
    buildTextures(this);
    this.scene.stop();
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-root',
  width: window.innerWidth,
  height: window.innerHeight,
  backgroundColor: '#0b100a',
  scene: [BootScene, WorldScene],
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: {
    antialias: true,
    powerPreference: 'high-performance',
    roundPixels: false,
  },
  input: { activePointers: 2 },
  banner: false,
  audio: { noAudio: true },
});

let sceneStarted = false;

function startWorldScene() {
  if (sceneStarted) return;
  sceneStarted = true;
  game.scene.start('World');
}

// ---------------------------------------------------------------- loading
let loadingStep = 0;
const loadingSteps = ['carregando o solo…', 'germinando sementes…', 'acordando as operárias…', 'abrindo os túneis…', 'pronto.'];
function advanceLoading(pct, text) {
  $('loading-fill').style.width = `${Math.round(pct * 100)}%`;
  if (text) $('loading-text').textContent = text;
}
let loadPct = 0.05;
const loadTimer = setInterval(() => {
  loadPct = Math.min(0.95, loadPct + 0.09);
  advanceLoading(loadPct, loadingSteps[Math.min(3, loadingStep++)]);
}, 180);

function finishLoading() {
  clearInterval(loadTimer);
  advanceLoading(1, 'pronto.');
  setTimeout(() => {
    $('loading').classList.add('hidden');
    panels.showMenu(true);
    state.phase = 'menu';
  }, 260);
}

// ---------------------------------------------------------------- inicialização
function init() {
  hud.init();
  panels.init({
    mapProvider: () => {
      const s = game.scene.getScene('World');
      return s?.mapProvider ? s.mapProvider() : {};
    },
    onBuild: (type) => bus.emit('ui:build', type),
    onQuit: () => {
      net.disconnect();
      location.reload();
    },
    onRespawn: () => net.act({ type: 'respawn' }),
  });

  bus.on('ui:open', (name) => {
    if (name === 'players') panels.open('players');
    else panels.open(name);
  });
  bus.on('ui:chat', (msg) => {
    if (msg?.text) net.chat(msg.text, msg.channel ?? state.chatChannel);
  });
  bus.on('ui:open-chat', () => panels.toggleChat(true));
  bus.on('ui:colony-op', (op) => {
    net.colonyOp(op.op, op);
  });
  bus.on('ui:demolish', ({ id }) => net.act({ type: 'demolish', id }));
  bus.on('settings:volume', (v) => { audio.setVolume(v); saveSettings(); });
  bus.on('chat', (msg) => {
    panels.addChat(msg);
    if (msg.from !== state.name && !msg.system) {
      const typing = document.activeElement?.id === 'chat-input';
      if (!typing && $('chat-panel').classList.contains('hidden')) {
        audio.tone(880, 0.06, 'sine', 0.02);
      }
    }
  });

  // preferências leves são persistidas a cada mudança
  for (const evt of ['settings:zoom', 'settings:particles', 'settings:names', 'settings:shake']) {
    bus.on(evt, () => saveSettings());
  }

  // seleção de texto + primeiro gesto (áudio)
  window.addEventListener('pointerdown', () => {
    audio.ensure();
    audio.setVolume(state.settings.volume);
    audio.startAmbient();
  }, { once: true });

  initMenu();
  initTouch();
  finishLoading();
}

// ---------------------------------------------------------------- menu inicial
function initMenu() {
  $('menu-name').value = state.settings.name || '';
  $('btn-enter').addEventListener('click', () => {
    const name = $('menu-name').value.trim();
    if (name.length < 2) {
      panels.setMenuStatus('escolha um nome com 2 a 20 letras', 'err');
      $('menu-name').focus();
      return;
    }
    state.settings.name = name;
    panels.setMenuStatus('conectando ao formigueiro…');
    $('btn-enter').disabled = true;
    net.connect({ name, token: state.token || state.settings.token || null });
  });
  $('menu-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-enter').click();
  });

  // estatísticas públicas do mundo
  const refreshStats = async () => {
    try {
      const res = await fetch(`${net.url}/api/world`, { cache: 'no-store' });
      if (!res.ok) throw new Error('offline');
      const data = await res.json();
      panels.updateMenuStats({
        players: data.players?.total ?? 0,
        colonies: data.colonies?.length ?? 0,
        population: data.population ?? 0,
      });
      if (!state.connected && state.phase === 'menu') {
        const weather = data.env?.weather ?? 'limpo';
        panels.setMenuStatus(`servidor ok · ${data.env?.part ?? 'dia'} · clima ${weather}`, 'ok');
      }
    } catch {
      panels.setMenuStatus('servidor indisponível — verifique o backend no Render', 'err');
    }
  };
  refreshStats();
  setInterval(refreshStats, 15000);
}

// ---------------------------------------------------------------- rede
bus.on('connecting', ({ url }) => {
  panels.setMenuStatus(`conectando a ${url.replace(/^https?:\/\//, '')}…`);
});
bus.on('socket:connect', () => {
  panels.setMenuStatus('conectado — entrando no mundo…', 'ok');
  hud.setConnection(true, false);
});
bus.on('socket:error', (err) => {
  $('btn-enter').disabled = false;
  panels.setMenuStatus(`falha: ${err}. O backend está no ar?`, 'err');
});
bus.on('socket:disconnect', () => {
  hud.setConnection(false, true);
});
bus.on('socket:reconnected', () => {
  hud.setConnection(true, false);
  hud.toast('Reconectado', 'ok');
});

bus.on('welcome', (w) => {
  $('btn-enter').disabled = false;
  $('loading').classList.add('hidden');
  panels.showMenu(false);
  $('game-shell').classList.remove('hidden');
  requestAnimationFrame(() => game.scale.resize(window.innerWidth, window.innerHeight));
  saveSettings();
  audio.startAmbient();
  startWorldScene();
  hud.setConnection(true, false);
  state.settings.name = w.name;
  state.joinedAt = Date.now();
  const colony = w.colony;
  if (colony) {
    hud.toast(`Bem-vinda de volta, ${w.name}`, 'ok', 1800);
    hud.log('colony', `Você está em ${colony.name}`, false);
    setTimeout(() => panels.close('select'), 400);
  } else {
    panels.openColonySelect(true);
  }
  if (w.events?.length) {
    for (const e of w.events.slice(-6)) hud.log(e.kind, e.text, e.important);
  }
  window.__ANT_WORLD__ = w.world;
});

bus.on('snap', (p) => {
  if (state.self) hud.updateVitals(state.self);
});
bus.on('env', (env) => hud.updateEnv(env));
bus.on('state', (s) => {
  hud.updateColony(s.colony, s.colony?.role);
  const open = $('colony-panel');
  if (!open.classList.contains('hidden')) panels.refreshColony();
  const bopen = $('building-menu');
  if (!bopen.classList.contains('hidden')) panels.refreshBuildMenu();
});
bus.on('players', (list) => hud.updatePlayers(list));
bus.on('colonies', (list) => {
  state.colonies = list;
  if (!$('colony-select').classList.contains('hidden')) panels.openColonySelect(false);
});

bus.on('notice', (n) => {
  if (n.kind === 'colony') {
    if (n.op === 'create' && n.colony) state.colony = { ...(state.colony ?? {}), id: n.colony.id, name: n.colony.name, color: n.colony.color };
    if (n.op === 'join' && n.colony) state.colony = { ...(state.colony ?? {}), id: n.colony.id, name: n.colony.name, color: n.colony.color };
    if (n.op === 'leave') state.colony = null;
    if (n.op === 'error') hud.toast(n.text ?? 'Erro', 'error');
  }
});

bus.on('kick', (k) => {
  hud.toast(k?.reason ?? 'Você foi removido da colônia', 'error', 5000);
  if (k?.reason?.includes('aba')) {
    setTimeout(() => {
      hud.toast('Esta sessão foi aberta em outra aba', 'error', 5000);
    }, 1200);
  }
});

bus.on('server:error', (e) => hud.toast(e?.error ?? 'Erro do servidor', 'error'));

// ---------------------------------------------------------------- joystick
function initTouch() {
  const joy = $('joystick');
  const knob = $('joystick-knob');
  if (!joy) return;
  let active = false;
  const apply = (e) => {
    const rect = joy.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = (e.clientX - cx) / (rect.width / 2);
    let dy = (e.clientY - cy) / (rect.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    knob.style.transform = `translate(${dx * 28}px, ${dy * 28}px)`;
    bus.emit('input:touch', { x: dx, y: dy });
  };
  joy.addEventListener('pointerdown', (e) => {
    active = true;
    joy.setPointerCapture(e.pointerId);
    apply(e);
  });
  joy.addEventListener('pointermove', (e) => { if (active) apply(e); });
  const end = () => {
    active = false;
    knob.style.transform = 'translate(0,0)';
    bus.emit('input:touch', { x: 0, y: 0 });
  };
  joy.addEventListener('pointerup', end);
  joy.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------- start
window.addEventListener('load', init);
if (document.readyState === 'complete') init();
