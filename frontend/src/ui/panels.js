/**
 * Painéis e menus: construção, colônia, mapa, configurações, jogadores,
 * seleção de colônia, chat e menu inicial.
 */

import {
  BUILDING_INFO, BUILDING_KEYS, BUILDING_BY_KEY, RESOURCE_KEYS, RESOURCE_INFO,
  COLONY_COLORS, COLONY_LIMITS,
} from '@shared/constants.js';
import { state, bus, hex, fmt, RES_ICON } from '../state.js';
import { hud, escapeHtml, qs as $ } from './hud.js';

const OVERLAYS = ['building-menu', 'colony-panel', 'map-panel', 'settings-panel', 'colony-select', 'help-panel', 'credits-panel'];

export const panels = {
  mapProvider: null,
  buildCallback: null,
  quitCallback: null,
  respawnCallback: null,
  initialized: false,

  init({ mapProvider, onBuild, onQuit, onRespawn, onEnterMenu } = {}) {
    if (this.initialized) return;
    this.initialized = true;
    this.mapProvider = mapProvider ?? (() => ({}));
    this.buildCallback = onBuild;
    this.quitCallback = onQuit;
    this.respawnCallback = onRespawn;
    this.enterMenuCallback = onEnterMenu;
    this.buildSelectedColor = COLONY_COLORS[0];

    // abrir/fechar por botões
    for (const btn of document.querySelectorAll('[data-open]')) {
      btn.addEventListener('click', () => this.open(btn.dataset.open));
    }
    for (const btn of document.querySelectorAll('[data-close]')) {
      btn.addEventListener('click', () => this.close(btn.dataset.close));
    }
    $('btn-menu').addEventListener('click', () => this.toggle('settings'));
    $('btn-how').addEventListener('click', () => this.toggle('help'));
    $('btn-settings').addEventListener('click', () => this.toggle('settings'));
    $('btn-credits').addEventListener('click', () => this.toggle('credits'));
    $('btn-players').addEventListener('click', () => this.toggle('players'));
    $('btn-chat').addEventListener('click', () => this.toggleChat());
    $('chat-close').addEventListener('click', () => this.toggleChat(false));
    $('btn-respawn').addEventListener('click', () => this.respawnCallback?.());
    $('btn-change-colony').addEventListener('click', () => {
      this.close('settings');
      this.openColonySelect(true);
    });
    $('btn-quit').addEventListener('click', () => this.quitCallback?.());

    // clicar no fundo fecha
    for (const id of OVERLAYS) {
      const el = $(id);
      el.addEventListener('click', (e) => { if (e.target === el) this.close(id); });
    }

    bus.on('notice', (n) => {
      if (n?.kind === 'colony') this.pendingCreate = false;
      if (n?.kind === 'error' && this.pendingCreate) {
        this.pendingCreate = false;
        setTimeout(() => this.openColonySelect(true), 250);
      }
    });

    this.initBuildMenu();
    this.initSettings();
    this.initChat();
    this.initColonySelect();
    this.initEscHandler();
  },

  open(name) {
    if (name === 'players') {
      $('players-panel').classList.remove('hidden');
      return;
    }
    const id = { build: 'building-menu', building: 'building-menu', colony: 'colony-panel', map: 'map-panel', settings: 'settings-panel', help: 'help-panel', credits: 'credits-panel', select: 'colony-select' }[name] ?? name;
    if (id === 'map-panel') this.refreshMap();
    if (id === 'colony-panel') this.refreshColony();
    if (id === 'building-menu') this.refreshBuildMenu();
    $(id)?.classList.remove('hidden');
    bus.emit('ui:overlay', { name: id, open: true });
  },

  close(name) {
    if (name === 'players') { $('players-panel').classList.add('hidden'); return; }
    const id = { build: 'building-menu', building: 'building-menu', colony: 'colony-panel', map: 'map-panel', settings: 'settings-panel', help: 'help-panel', credits: 'credits-panel', select: 'colony-select' }[name] ?? name;
    $(id)?.classList.add('hidden');
    bus.emit('ui:overlay', { name: id, open: false });
  },

  toggle(name) {
    if (name === 'players') { $('players-panel').classList.toggle('hidden'); return; }
    const id = { build: 'building-menu', building: 'building-menu', colony: 'colony-panel', map: 'map-panel', settings: 'settings-panel', help: 'help-panel', credits: 'credits-panel', select: 'colony-select' }[name] ?? name;
    const el = $(id);
    if (!el) return;
    if (el.classList.contains('hidden')) this.open(name);
    else this.close(name);
  },

  closeAll() {
    for (const id of OVERLAYS) $(id)?.classList.add('hidden');
    $('players-panel')?.classList.add('hidden');
    bus.emit('ui:overlay', { name: '*', open: false });
  },

  isAnyOpen() {
    return OVERLAYS.some((id) => !$(id).classList.contains('hidden'));
  },

  initEscHandler() {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.phase === 'playing') {
        if (document.activeElement?.tagName === 'INPUT') return;
        if (this.isAnyOpen()) { this.closeAll(); e.preventDefault(); }
        else this.open('settings');
      }
    });
    // fechar overlays ao clicar em "fechar" já tratado
  },

  // ---------------------------------------------------------------- construção
  initBuildMenu() {
    const grid = $('build-grid');
    grid.innerHTML = '';
    for (const key of BUILDING_KEYS) {
      const info = BUILDING_BY_KEY[key];
      const el = document.createElement('button');
      el.className = 'build-card';
      el.dataset.type = String(info.id);
      el.innerHTML = `
        <span class="bc-key">${info.size}×${info.size}</span>
        <span class="bc-name">${info.name}</span>
        <span class="bc-desc">${info.desc}</span>
        <span class="bc-cost" data-cost></span>`;
      el.addEventListener('click', () => {
        if (el.classList.contains('locked')) {
          hud.toast('Recursos insuficientes para esta obra', 'error');
          return;
        }
        this.close('building');
        this.buildCallback?.(info.id);
      });
      grid.appendChild(el);
    }
  },

  refreshBuildMenu() {
    const colony = state.colony;
    const stock = colony?.stock ?? {};
    const hint = $('build-hint');
    for (const el of document.querySelectorAll('.build-card')) {
      const type = Number(el.dataset.type);
      const info = BUILDING_INFO[type];
      const costs = Object.entries(info.cost);
      const missing = costs.filter(([k, v]) => (stock[k] ?? 0) < v);
      el.classList.toggle('locked', missing.length > 0 || !colony);
      el.querySelector('[data-cost]').innerHTML = costs.map(([k, v]) => {
        const res = RESOURCE_INFO[RESOURCE_KEYS.indexOf(k)];
        const has = (stock[k] ?? 0) >= v;
        return `<span class="${has ? '' : 'missing'}">${RES_ICON[k]} ${v} ${res?.name?.toLowerCase() ?? k}</span>`;
      }).join('');
    }
    if (!colony) hint.textContent = 'Você precisa estar em uma colônia para construir.';
    else hint.textContent = 'Escolha uma estrutura e clique no chão para posicionar. Clique direito ou Esc cancela.';
  },

  // ---------------------------------------------------------------- colônia
  refreshColony() {
    const c = state.colony;
    const title = $('colony-panel-title');
    if (!c) {
      title.textContent = 'sem colônia';
      $('colony-stock').innerHTML = '<span class="muted">Funde uma colônia no menu para guardar recursos e construir.</span>';
      $('colony-members').innerHTML = '';
      $('colony-structures').innerHTML = '';
      $('colony-status').innerHTML = '';
      $('colony-perms').textContent = '';
      return;
    }
    title.textContent = c.name;
    const stock = c.stock ?? {};
    $('colony-stock').innerHTML = RESOURCE_KEYS.map((k, i) => {
      const info = RESOURCE_INFO[i];
      return `<div class="row"><span><i style="display:inline-block;width:7px;height:7px;border-radius:2px;background:${hex(info.color)};margin-right:6px"></i>${info.name}</span><b>${fmt(stock[k] || 0)}</b></div>`;
    }).join('') + `<div class="row"><span>capacidade</span><b>${Math.round(RESOURCE_KEYS.reduce((s, k) => s + (stock[k] || 0), 0))}/${c.cap}</b></div>`;

    $('colony-members').innerHTML = (c.members ?? []).map((m) => {
      const roleLabel = m.role === 'founder' ? 'fundadora' : m.role === 'officer' ? 'oficial' : 'membro';
      const isFounder = c.role === 'founder' || c.role === 'officer';
      const canPromote = isFounder && m.id !== state.sessionId && m.role !== 'founder';
      return `<div class="member-row">
        <span>${escapeHtml(m.name)}</span>
        <span class="role-tag">${roleLabel}</span>
        ${canPromote ? `<button class="mini-btn" data-promote="${m.id}" data-role="${m.role === 'officer' ? 'member' : 'officer'}">${m.role === 'officer' ? 'rebaixar' : 'promover'}</button>` : ''}
        ${isFounder && m.id !== state.sessionId ? `<button class="mini-btn" data-kick="${m.id}">expulsar</button>` : ''}
      </div>`;
    }).join('');

    for (const btn of $('colony-members').querySelectorAll('[data-promote]')) {
      btn.addEventListener('click', () => {
        bus.emit('ui:colony-op', { op: 'role', sessionId: btn.dataset.promote, role: btn.dataset.role });
      });
    }
    for (const btn of $('colony-members').querySelectorAll('[data-kick]')) {
      btn.addEventListener('click', () => bus.emit('ui:colony-op', { op: 'kick', sessionId: btn.dataset.kick }));
    }

    const structures = [...(c.structures ?? [])].sort((a, b) => b.progress - a.progress);
    const canDemolish = !!c.permissions?.demolish;
    $('colony-structures').innerHTML = structures.length ? structures.map((s) => {
      const info = BUILDING_INFO[s.type];
      const pct = Math.round(s.progress);
      const hpPct = Math.round((s.hp / (s.maxHp || 1)) * 100);
      return `<div class="structure-row" title="${info?.desc ?? ''}">
        <span class="sname">${info?.name ?? '?'}</span>
        <span class="progress-mini"><i style="width:${pct}%;background:${pct >= 100 ? (hpPct < 50 ? '#e0533f' : '#8fb45b') : '#e9a85b'}"></i></span>
        <b>${pct}%</b>
        ${canDemolish ? `<button class="mini-btn" data-demolish="${s.id}">×</button>` : ''}
      </div>`;
    }).join('') : '<span class="muted">nenhuma estrutura ainda</span>';

    for (const btn of $('colony-structures').querySelectorAll('[data-demolish]')) {
      btn.addEventListener('click', () => {
        if (!confirm('Demolir esta estrutura? Parte do material é recuperada.')) return;
        bus.emit('ui:demolish', { id: Number(btn.dataset.demolish) });
      });
    }

    const queen = c.queen ? (c.queen.alive ? `viva (${Math.round(c.queen.hp)} HP)` : 'morta') : 'ausente';
    $('colony-status').innerHTML = `
      <div class="row"><span>moral</span><b>${Math.round(c.morale ?? 0)}</b></div>
      <div class="row"><span>população</span><b>${c.totalPop ?? 0}/${COLONY_LIMITS.maxPopulation}</b></div>
      <div class="row"><span>rainha</span><b>${queen}</b></div>
      <div class="row"><span>ovos</span><b>${c.eggs ?? 0}</b></div>
      <div class="row"><span>larvas</span><b>${c.pop?.larva ?? 0}</b></div>
      <div class="row"><span>obras</span><b>${c.pending ?? 0}</b></div>
      <div class="row"><span>fome</span><b>${c.needs?.hungry ? 'alta' : 'controlada'}</b></div>
      <div class="row"><span>defesa</span><b>${c.needs?.defence > 0.3 ? 'ameaçada' : 'estável'}</b></div>`;

    $('colony-perms').innerHTML = `<b>suas permissões:</b> ${Object.entries(c.permissions ?? {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'nenhuma'}`;
  },

  // ---------------------------------------------------------------- mapa
  refreshMap() {
    const data = this.mapProvider?.() ?? {};
    hud.drawBigMap(data.base, data);
  },

  // ---------------------------------------------------------------- configurações
  initSettings() {
    const volume = $('set-volume');
    const zoom = $('set-zoom');
    const particles = $('set-particles');
    const names = $('set-names');
    const shake = $('set-shake');
    volume.value = Math.round(state.settings.volume * 100);
    zoom.value = Math.round(state.settings.zoom * 100);
    particles.checked = state.settings.particles;
    names.checked = state.settings.names;
    shake.checked = state.settings.shake;

    volume.addEventListener('input', () => {
      state.settings.volume = Number(volume.value) / 100;
      bus.emit('settings:volume', state.settings.volume);
    });
    zoom.addEventListener('input', () => {
      state.settings.zoom = Number(zoom.value) / 100;
      bus.emit('settings:zoom', state.settings.zoom);
    });
    particles.addEventListener('change', () => {
      state.settings.particles = particles.checked;
      bus.emit('settings:particles', particles.checked);
    });
    names.addEventListener('change', () => {
      state.settings.names = names.checked;
      bus.emit('settings:names', names.checked);
    });
    shake.addEventListener('change', () => {
      state.settings.shake = shake.checked;
      bus.emit('settings:shake', shake.checked);
    });
  },

  // ---------------------------------------------------------------- chat
  initChat() {
    $('chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('chat-input');
      const text = input.value.trim();
      if (!text) return;
      bus.emit('ui:chat', { text, channel: state.chatChannel });
      input.value = '';
      this.toggleChat(false);
    });
    for (const tab of document.querySelectorAll('.chat-tab')) {
      tab.addEventListener('click', () => {
        state.chatChannel = tab.dataset.channel;
        for (const t of document.querySelectorAll('.chat-tab')) t.classList.toggle('active', t === tab);
        $('chat-input').placeholder = tab.dataset.channel === 'colony' ? 'diga algo à colônia…' : 'diga algo ao mundo…';
      });
    }
    $('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.toggleChat(false); e.target.blur(); }
      e.stopPropagation();
    });
  },

  toggleChat(force) {
    const el = $('chat-panel');
    const show = force ?? el.classList.contains('hidden');
    el.classList.toggle('hidden', !show);
    if (show) {
      state.unreadChat = 0;
      hud.setUnreadChat(0);
      setTimeout(() => $('chat-input').focus(), 30);
    } else {
      $('chat-input').blur();
    }
    bus.emit('ui:chat-toggle', show);
  },

  addChat(msg) {
    const wrap = $('chat-messages');
    const el = document.createElement('div');
    el.className = `chat-msg${msg.system ? ' system' : ''}`;
    const time = new Date(msg.at ?? Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = msg.system
      ? `${escapeHtml(msg.text)}<span class="when">${time}</span>`
      : `<b>${escapeHtml(msg.from ?? 'anônimo')}</b>${msg.colony ? ` <span class="muted">[${escapeHtml(msg.colony)}]</span>` : ''}: ${escapeHtml(msg.text)}<span class="when">${time}</span>`;
    wrap.appendChild(el);
    wrap.scrollTop = wrap.scrollHeight;
    while (wrap.children.length > 80) wrap.firstChild.remove();
    if ($('chat-panel').classList.contains('hidden')) {
      state.unreadChat++;
      hud.setUnreadChat(state.unreadChat);
    }
  },

  // ---------------------------------------------------------------- seleção de colônia
  initColonySelect() {
    const colors = $('new-colony-colors');
    colors.innerHTML = COLONY_COLORS.map((c) => `<button class="color-swatch" data-color="${c}" style="background:${hex(c)}"></button>`).join('');
    const swatches = [...colors.querySelectorAll('.color-swatch')];
    const setColor = (c) => {
      this.buildSelectedColor = c;
      swatches.forEach((s) => s.classList.toggle('active', Number(s.dataset.color) === c));
    };
    setColor(COLONY_COLORS[0]);
    swatches.forEach((s) => s.addEventListener('click', () => setColor(Number(s.dataset.color))));

    $('btn-create-colony').addEventListener('click', () => {
      const name = $('new-colony-name').value.trim();
      if (name.length < 2) { hud.toast('Dê um nome à sua colônia (2+ letras)', 'error'); return; }
      this.pendingCreate = true;
      bus.emit('ui:colony-op', { op: 'create', name, color: this.buildSelectedColor });
      this.close('colony-select');
    });
    $('btn-solo').addEventListener('click', () => {
      this.close('colony-select');
      hud.toast('Explore o mundo. Você pode fundar ou entrar em uma colônia depois.', '', 4200);
    });
  },

  openColonySelect(force = false) {
    const list = $('colony-list');
    const colonies = state.colonies ?? [];
    const joinable = colonies.filter((c) => !c.isAi && c.open !== false);
    list.innerHTML = joinable.length ? joinable.map((c) => `
      <button class="colony-card" data-id="${c.id}">
        <span class="cc-dot" style="background:${hex(c.color)}"></span>
        <span class="cc-main">
          <span class="cc-name">${escapeHtml(c.name)}</span>
          <span class="cc-meta">${c.pop} formigas · ${c.members ?? 0} jogadores · ${c.structures ?? 0} estruturas</span>
        </span>
        <span class="cc-join">entrar →</span>
      </button>`).join('') : '<p class="muted">Nenhuma colônia de jogadores ainda. Funde a primeira!</p>';
    for (const card of list.querySelectorAll('[data-id]')) {
      card.addEventListener('click', () => {
        bus.emit('ui:colony-op', { op: 'join', id: card.dataset.id });
        this.close('colony-select');
      });
    }
    if (force) {
      $('colony-select-hint').textContent = state.colony
        ? 'trocar de colônia: o estoque e as obras ficam com a colônia atual'
        : 'escolha uma colônia ou funde a sua';
      $('btn-change-colony').disabled = !!state.colony;
    }
    // fundar exige alguns segundos de exploração (regra do servidor)
    const elapsed = state.joinedAt ? (Date.now() - state.joinedAt) / 1000 : 0;
    const wait = Math.max(0, Math.ceil(3 - elapsed));
    $('btn-create-colony').disabled = wait > 0 || !!state.colony;
    if (wait > 0 && !state.colony) {
      $('colony-select-hint').textContent = `explore o mundo por ${wait}s antes de fundar sua colônia`;
      clearTimeout(this._playtimeTimer);
      this._playtimeTimer = setTimeout(() => {
        if (!$('colony-select').classList.contains('hidden')) this.openColonySelect(false);
      }, 500);
    }
    this.open('select');
  },

  // ---------------------------------------------------------------- menu inicial
  updateMenuStats(stats) {
    if (!stats) return;
    $('mw-players').textContent = stats.players ?? '–';
    $('mw-colonies').textContent = stats.colonies ?? '–';
    $('mw-pop').textContent = stats.population ?? '–';
  },

  setMenuStatus(text, kind = '') {
    const el = $('menu-status');
    el.textContent = text;
    el.className = `menu-status ${kind}`;
  },

  showMenu(show) {
    $('menu').classList.toggle('hidden', !show);
  },
};
