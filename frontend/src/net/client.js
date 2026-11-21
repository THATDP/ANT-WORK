/**
 * Cliente de rede. Fala com o backend autoritativo via Socket.IO.
 *
 * - O servidor manda snapshots por área de interesse; aqui só aplicamos.
 * - Entrada é enviada a 15 Hz (vetor de intenção, nunca posição).
 * - Reconexão automática com token de sessão, mantendo colônia e progresso.
 */

import { io } from 'socket.io-client';
import { MSG, NET } from '@shared/constants.js';
import { state, bus } from '../state.js';

function resolveServerUrl() {
  const params = new URLSearchParams(location.search);
  const explicit = params.get('server') || import.meta.env.VITE_SERVER_URL || state.settings.server;
  if (explicit) return explicit.replace(/\/$/, '');
  // Em desenvolvimento o Vite faz proxy de /socket.io para o backend.
  return location.origin;
}

export class NetClient {
  constructor() {
    this.socket = null;
    this.url = resolveServerUrl();
    this.connectedOnce = false;
    this.lastInput = 0;
    this.inputTimer = null;
    this.pingTimer = null;
    this.lastSelfAt = 0;
    this.handlers = [];
  }

  connect({ name, token, colonyId = null } = {}) {
    if (this.socket) this.socket.close();
    state.connecting = true;
    state.error = '';
    bus.emit('connecting', { url: this.url });

    const socket = io(this.url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 12,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      timeout: 9000,
      autoConnect: true,
    });
    this.socket = socket;
    const pending = { name: name || state.settings.name || 'Formiga', token: token || state.token || null, colonyId };
    this.pending = pending;

    socket.on('connect', () => {
      state.connected = true;
      state.connecting = false;
      state.serverUrl = this.url;
      bus.emit('socket:connect');
      // usa o token mais recente: reconectar mantém colônia, progresso e posição
      socket.emit(MSG.HELLO, {
        name: state.name || pending.name,
        token: state.token || pending.token || null,
        colonyId: pending.colonyId,
      });
      this.startLoops();
    });

    socket.on('connect_error', (err) => {
      state.connecting = false;
      state.connected = false;
      state.error = err?.message ?? 'falha de conexão';
      bus.emit('socket:error', state.error);
    });

    socket.on('disconnect', (reason) => {
      state.connected = false;
      bus.emit('socket:disconnect', reason);
      this.stopLoops();
    });

    socket.io.on('reconnect_attempt', (n) => bus.emit('socket:reconnecting', n));
    socket.io.on('reconnect', () => bus.emit('socket:reconnected'));

    socket.on(MSG.WELCOME, (w) => {
      state.token = w.token;
      state.sessionId = w.sessionId;
      state.selfId = w.selfId;
      state.name = w.name;
      state.world = w.world;
      state.spawn = w.spawn;
      state.colony = w.colony ? { ...w.colony } : null;
      state.colonies = w.colonies ?? [];
      state.connectedOnce = true;
      state.connected = true;
      state.settings.name = w.name;
      state.phase = 'playing';
      bus.emit('welcome', w);
    });

    socket.on(MSG.SNAP, (p) => {
      state.serverTick = p.t ?? state.serverTick;
      if (p.self) {
        state.self = p.self;
        state.inventory.amount = p.self[6] ?? 0;
        state.inventory.kind = p.self[5] ?? -1;
      }
      if (p.env) {
        const e = p.env;
        state.env = { day: e[0], part: e[1], weather: e[2], temperature: e[3], night: e[4], phase: e[5] };
        bus.emit('env', state.env);
      }
      state.lastSnapAt = performance.now();
      bus.emit('snap', p);
    });

    socket.on(MSG.STATE, (s) => {
      state.colony = s.colony;
      state.nearbyColonies = s.nearby ?? [];
      bus.emit('state', s);
    });

    socket.on('players', (list) => {
      state.players = list ?? [];
      bus.emit('players', state.players);
    });

    socket.on(MSG.COLONIES, (list) => {
      state.colonies = list ?? [];
      bus.emit('colonies', state.colonies);
    });

    socket.on(MSG.NOTICE, (n) => bus.emit('notice', n));
    socket.on(MSG.EVENT, (e) => bus.emit('event', e));
    socket.on(MSG.CHAT_MSG, (c) => bus.emit('chat', c));
    socket.on(MSG.ERROR, (e) => bus.emit('server:error', e));
    socket.on(MSG.KICK, (k) => bus.emit('kick', k));
    socket.on(MSG.PONG, (p) => {
      state.latency = Math.max(0, Date.now() - (p.t || 0));
      state.serverTick = p.tick ?? state.serverTick;
      bus.emit('pong', p);
    });

    // ping de latência
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (socket.connected) socket.emit(MSG.PING, { t: Date.now() });
    }, 3000);
  }

  startLoops() {
    this.stopLoops();
    // envia intenção de movimento a ~15 Hz
    this.inputTimer = setInterval(() => {
      const input = state.input;
      if (!input) return;
      if (!this.socket?.connected) return;
      this.socket.emit(MSG.INPUT, {
        seq: ++this.inputSeq,
        vx: input.x,
        vy: input.y,
      });
    }, 1000 / NET.inputHz);
    this.inputSeq = 0;
  }

  stopLoops() {
    clearInterval(this.inputTimer);
    this.inputTimer = null;
  }

  act(action) {
    if (!this.socket?.connected) return false;
    this.socket.emit(MSG.ACT, { action });
    return true;
  }

  chat(text, channel = 'global') {
    if (!this.socket?.connected) return;
    this.socket.emit(MSG.CHAT, { text, channel });
  }

  colonyOp(op, payload = {}) {
    if (!this.socket?.connected) return;
    this.socket.emit(MSG.COLONY_OP, { op, ...payload });
  }

  settings(payload) {
    this.socket?.emit(MSG.SETTINGS, payload);
  }

  reconnect() {
    if (this.socket) this.connect({ name: state.name || state.settings.name, token: state.token });
  }

  disconnect() {
    this.stopLoops();
    clearInterval(this.pingTimer);
    this.socket?.close();
    this.socket = null;
    state.connected = false;
  }

  setInput(x, y) {
    state.input = { x, y };
  }
}

export const net = new NetClient();
