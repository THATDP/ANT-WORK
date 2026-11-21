/**
 * Servidor HTTP + Socket.IO.
 *
 * Segurança aplicada aqui (nunca no cliente):
 *  - handshake obrigatório com nome validado;
 *  - token de reconexão opaco por sessão;
 *  - token buckets por socket (input 40/s, ações 10/s, chat 20/min);
 *  - toda ação de jogo passa por world.handleAction (distância, cooldown, permissões);
 *  - CORS restrito às origens configuradas.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { Server as SocketServer } from 'socket.io';

import { MSG, NET, TICK_MS, COLONY_LIMITS } from '../../../shared/constants.js';
import { sanitizeChat, sanitizeInput, sanitizeName } from '../../../shared/protocol.js';
import { InterestManager } from './aoi.js';
import { ColonyDirector } from '../game/colony.js';
import { createLogger } from '../logger.js';

const log = createLogger('net');

const CLIENT_VERSION = '1.0.0';

function originAllowed(config, origin) {
  if (!origin) return true; // conexões nativas (bots/testes)
  if (config.corsOrigin.includes('*')) return true;
  return config.corsOrigin.includes(origin) || /^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(origin);
}

export function createRealtimeServer({ world, store, persistence, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(compression());
  app.use(cors({
    origin(origin, cb) { cb(null, originAllowed(config, origin)); },
    credentials: false,
  }));
  app.use(express.json({ limit: '32kb' }));

  const startedAt = Date.now();
  const aoi = new InterestManager(world);
  const sessionsToSocket = new Map(); // sessionId -> socket.id

  const httpServer = http.createServer(app);
  const io = new SocketServer(httpServer, {
    cors: {
      origin(origin, cb) { cb(null, originAllowed(config, origin)); },
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    perMessageDeflate: { threshold: 512 },
    maxHttpBufferSize: 32 * 1024,
    pingInterval: 20_000,
    pingTimeout: 25_000,
    connectionStateRecovery: { maxDisconnectionDuration: 30_000, skipMiddlewares: true },
  });

  // ---------------------------------------------------------------- hooks do mundo
  const eventBuffer = [];
  let lastBroadcast = 0;
  world.onEvent = (item) => {
    eventBuffer.push(item);
    if (eventBuffer.length > 100) eventBuffer.shift();
    const now = Date.now();
    if (!item.important && now - lastBroadcast < 180) return;
    lastBroadcast = now;
    // eventos importantes vão para todos; os locais são filtrados no cliente
    if (item.important) io.emit(MSG.EVENT, { k: item.kind, t: item.text, x: item.x, y: item.y, i: 1 });
    else io.emit(MSG.EVENT, { k: item.kind, t: item.text, x: item.x, y: item.y });
    persistence?.trackEvent(item);
  };
  world.onPlayerEvent = (player, kind) => {
    const sid = sessionsToSocket.get(player.sessionId);
    if (!sid) return;
    if (kind === 'die') {
      io.to(sid).emit(MSG.NOTICE, { kind: 'death', text: `Você morreu. Respawn em ${Math.round((player.respawnAt - Date.now()) / 1000)}s`, respawnAt: player.respawnAt });
    } else if (kind === 'respawn') {
      io.to(sid).emit(MSG.NOTICE, { kind: 'respawn', text: 'Você voltou à colônia' });
    }
  };

  // ---------------------------------------------------------------- HTTP
  app.get('/', (_req, res) => {
    res.json({
      name: 'ANT LIFE',
      description: 'Simulador multiplayer de uma civilização de formigas',
      version: CLIENT_VERSION,
      endpoints: ['/health', '/metrics', '/api/world', '/api/config', '/api/colonies', '/socket.io'],
      docs: 'https://github.com/THATDP/ANT-WORK/tree/main/docs',
    });
  });

  app.get('/health', async (_req, res) => {
    const mem = process.memoryUsage();
    let db = { ok: false };
    try { db = store ? await Promise.race([store.health(), timeout(1500)]) : { ok: false, mode: 'none' }; }
    catch (err) { db = { ok: false, error: err.message }; }
    const worldMetrics = world.metricsSnapshot();
    const ok = world.initialized && worldMetrics.tickMsAvg < TICK_MS * 2;
    res.status(ok ? 200 : 503).json({
      ok,
      version: CLIENT_VERSION,
      uptimeS: Math.round((Date.now() - startedAt) / 1000),
      world: worldMetrics,
      store: { ...db, ...(persistence?.status() ?? {}) },
      memory: { rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576) },
      limits: {
        players: config.maxPlayers, detailedAnts: config.maxDetailedAnts,
        ants: config.maxAntsTotal, predators: config.maxPredators,
      },
    });
  });

  app.get('/metrics', (_req, res) => {
    const m = world.metricsSnapshot();
    const lines = [
      `ant_life_ticks_total ${world.tick}`,
      `ant_life_tick_ms_avg ${m.tickMsAvg}`,
      `ant_life_tick_ms_peak ${m.tickMsPeak}`,
      `ant_life_ants ${m.ants}`,
      `ant_life_ants_detailed ${m.antsDetailed}`,
      `ant_life_predators ${m.predators}`,
      `ant_life_players ${m.players.total}`,
      `ant_life_colonies ${m.colonies}`,
      `ant_life_structures ${m.structures}`,
      `ant_life_chunks_loaded ${m.chunks}`,
      `ant_life_snapshot_bytes ${aoi.stats.bytes}`,
      `ant_life_ai_thinks_total ${m.aiThinks}`,
      `ant_life_population_total ${world.totalPopulation()}`,
    ];
    res.type('text/plain').send(lines.join('\n') + '\n');
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      worldId: world.id,
      seed: world.seed,
      tickHz: Math.round(1000 / TICK_MS),
      worldChunks: world.chunksAcross,
      chunkPx: world.sizePx / world.chunksAcross,
      snapshotHz: 10,
    });
  });

  app.get('/api/world', (_req, res) => {
    res.json({
      ...world.metricsSnapshot(),
      env: world.env.describe(),
      population: world.totalPopulation(),
      predatorsByKind: world.predators.countByKind(),
      colonies: [...world.colonies.values()].map((c) => ({
        id: c.id, name: c.name, pop: c.totalPopulation, structures: c.structures.size,
        isAi: c.isAi, members: c.members.size, nest: { x: Math.round(c.nest.x), y: Math.round(c.nest.y) },
      })),
      events: world.events.recent(10),
    });
  });

  app.get('/api/colonies', (_req, res) => {
    res.json([...world.colonies.values()].map((c) => ({
      id: c.id, name: c.name, color: c.color, isAi: c.isAi,
      pop: c.totalPopulation, structures: c.structures.size,
      members: [...c.members.values()].map((m) => m.name),
      nest: { x: Math.round(c.nest.x), y: Math.round(c.nest.y) },
      morale: Math.round(c.morale),
    })));
  });

  app.post('/admin/save', async (req, res) => {
    const token = req.get('x-admin-token');
    if (!config.adminToken || token !== config.adminToken) return res.status(401).json({ ok: false, error: 'token inválido' });
    const ok = await persistence.save('admin');
    res.json({ ok });
  });

  app.post('/admin/snapshot', async (req, res) => {
    const token = req.get('x-admin-token');
    if (!config.adminToken || token !== config.adminToken) return res.status(401).json({ ok: false });
    const ok = await persistence.snapshot('admin');
    res.json({ ok });
  });

  // ---------------------------------------------------------------- Socket.IO
  io.on('connection', (socket) => {
    aoi.initClient(socket);
    socket.data.buckets = new Map();
    socket.data.sessionId = null;
    socket.data.helloAt = Date.now();

    const helloTimeout = setTimeout(() => {
      if (!socket.data.player) socket.disconnect(true);
    }, 12_000);
    if (helloTimeout.unref) helloTimeout.unref();

    socket.on(MSG.HELLO, (msg) => {
      clearTimeout(helloTimeout);
      try { handleHello(socket, msg); } catch (err) {
        log.error('hello falhou:', err);
        socket.emit(MSG.ERROR, { error: 'Falha ao entrar no mundo' });
      }
    });

    socket.on(MSG.INPUT, (msg) => {
      const p = socket.data.player;
      if (!p || !p.alive) return;
      if (!take(socket, 'input', NET.maxInputPerSecond, 1)) return;
      const input = sanitizeInput(msg);
      if (!input) return;
      p.input = input;
      p.lastSeq = msg?.seq ?? p.lastSeq;
      world.players.touch(p.sessionId);
    });

    socket.on(MSG.ACT, (msg) => {
      const p = socket.data.player;
      if (!p) return;
      if (!take(socket, 'act', 12, 0.8)) {
        socket.emit(MSG.NOTICE, { kind: 'warn', text: 'Ações muito rápidas' });
        return;
      }
      const result = world.handleAction(p, msg?.action ?? msg);
      if (!result.ok) socket.emit(MSG.NOTICE, { kind: 'error', text: result.reason ?? 'Ação inválida' });
      else if (result.data) socket.emit(MSG.NOTICE, { kind: 'ok', action: msg?.action?.type ?? msg?.type, data: result.data });
    });

    socket.on(MSG.CHAT, (msg) => {
      const p = socket.data.player;
      if (!p) return;
      if (!take(socket, 'chat', 4, 0.34)) return;
      const text = sanitizeChat(msg?.text);
      if (!text) return;
      const channel = msg?.channel === 'colony' ? 'colony' : 'global';
      const payload = {
        from: p.name, text, channel, at: Date.now(),
        colony: p.colonyId ? world.colonies.get(p.colonyId)?.name : null,
      };
      if (channel === 'colony' && p.colonyId) io.to(`colony:${p.colonyId}`).emit(MSG.CHAT_MSG, payload);
      else io.emit(MSG.CHAT_MSG, payload);
    });

    socket.on(MSG.COLONY_OP, (msg) => {
      const p = socket.data.player;
      if (!p) return;
      if (!take(socket, 'colony', 6, 0.5)) return;
      try { handleColonyOp(socket, p, msg); }
      catch (err) { log.error('colony op:', err); socket.emit(MSG.ERROR, { error: 'Operação inválida' }); }
    });

    socket.on(MSG.SETTINGS, (msg) => {
      const p = socket.data.player;
      if (!p) return;
      const r = Number(msg?.aoiRadius);
      if (Number.isFinite(r)) p.aoiRadius = Math.max(1, Math.min(3, Math.round(r)));
    });

    socket.on(MSG.PING, (msg) => {
      const p = socket.data.player;
      if (p) world.players.touch(p.sessionId);
      socket.emit(MSG.PONG, { t: msg?.t ?? 0, server: Date.now(), tick: world.tick });
    });

    socket.on('disconnect', () => {
      const p = socket.data.player;
      if (!p) return;
      sessionsToSocket.delete(p.sessionId);
      p.lastPos = { x: p.x, y: p.y };
      p.lastSeen = Date.now();
      const sess = world.players.sessions.get(p.sessionId);
      if (sess) { sess.lastPos = { x: p.x, y: p.y }; sess.colonyId = p.colonyId; }
      world.events.push('player', `${p.name} saiu do mundo`, p.x, p.y);
      world.players.remove(p.sessionId);
      socket.data.player = null;
      // libera as entidades do AOI para outros clientes não verem duplicado
    });
  });

  function take(socket, key, capacity, refillPerSec) {
    const now = Date.now();
    let b = socket.data.buckets.get(key);
    if (!b) { b = { tokens: capacity, at: now }; socket.data.buckets.set(key, b); }
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  function handleHello(socket, msg) {
    if (socket.data.player) return;
    if (world.players.all().length >= config.maxPlayers) {
      socket.emit(MSG.ERROR, { error: 'Servidor cheio no momento. Tente novamente.' });
      socket.disconnect(true);
      return;
    }
    const name = sanitizeName(msg?.name);
    if (!name) {
      socket.emit(MSG.ERROR, { error: 'Nome inválido (2 a 20 caracteres)' });
      return;
    }

    let token = typeof msg?.token === 'string' && msg.token.length === 36 ? msg.token : null;
    let sessionId = null;
    let colonyId = null;
    let lastPos = null;

    const resolved = token ? world.players.resolveToken(token) : null;
    if (resolved) {
      sessionId = resolved.sessionId;
      colonyId = resolved.colonyId ?? null;
      lastPos = resolved.lastPos ?? null;
      const existingPlayer = world.players.get(sessionId);
      if (existingPlayer) {
        // mesma sessão em outra aba: derruba a antiga
        const old = sessionsToSocket.get(sessionId);
        if (old && old !== socket.id) io.to(old).emit(MSG.KICK, { reason: 'Sessão aberta em outra aba' });
        world.players.remove(sessionId);
      }
    }
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      token = crypto.randomUUID();
      world.players.rememberSession(sessionId, token, name, null);
    } else {
      const s = world.players.sessions.get(sessionId);
      if (s) { s.lastSeen = Date.now(); s.name = name; }
    }

    // colônia: validar que ainda existe e que o jogador é membro
    let colony = colonyId ? world.colonies.get(colonyId) : null;
    if (colony && !colony.members.has(sessionId)) colony = null;
    if (!colony && msg?.colonyId) {
      const candidate = world.colonies.get(String(msg.colonyId));
      if (candidate && !candidate.isAi && candidate.members.size < COLONY_LIMITS.maxMembers) {
        const add = candidate.addMember(sessionId, name);
        if (add.ok) colony = candidate;
      }
    }

    const spawn = colony
      ? { x: colony.nest.x + (Math.random() - 0.5) * 60, y: colony.nest.y + (Math.random() - 0.5) * 60 }
      : findSpawnPoint(world);

    const player = world.players.spawn(sessionId, name, colony?.id ?? null, spawn.x, spawn.y,
      colony?.color ?? 0xdddddd);
    player.token = token;
    if (lastPos) { player.x = lastPos.x; player.y = lastPos.y; }

    socket.data.player = player;
    socket.data.sessionId = sessionId;
    socket.data.helloAt = Date.now();
    sessionsToSocket.set(sessionId, socket.id);
    socket.join('world');
    if (colony) socket.join(`colony:${colony.id}`);

    const s = world.players.sessions.get(sessionId);
    if (s) s.colonyId = colony?.id ?? null;

    world.players.touch(sessionId);
    world.events.push('player', `${name} entrou no mundo`, player.x, player.y);

    socket.emit(MSG.WELCOME, {
      token,
      sessionId,
      selfId: player.id,
      name,
      world: {
        id: world.id, seed: world.seed, sizePx: world.sizePx,
        chunkPx: world.sizePx / world.chunksAcross, chunks: world.chunksAcross,
        tick: world.tick, serverTime: Date.now(),
      },
      spawn: { x: Math.round(player.x), y: Math.round(player.y) },
      colony: colony ? { id: colony.id, name: colony.name, color: colony.color, role: colony.memberRole(sessionId) } : null,
      colonies: [...world.colonies.values()].map((c) => ({
        id: c.id, name: c.name, color: c.color, isAi: c.isAi,
        pop: c.totalPopulation, members: c.members.size, structures: c.structures.size,
        nest: { x: Math.round(c.nest.x), y: Math.round(c.nest.y) },
        open: !c.isAi && c.members.size < COLONY_LIMITS.maxMembers,
      })),
      events: world.events.recent(12),
      limits: { maxPlayers: config.maxPlayers },
    });

    log.info(`${name} entrou (${player.id}) · sessão ${sessionId.slice(0, 8)} · ${world.players.all().length} online`);
  }

  function handleColonyOp(socket, player, msg) {
    const op = msg?.op;
    const now = Date.now();
    const current = player.colonyId ? world.colonies.get(player.colonyId) : null;
    const reply = (obj) => socket.emit(MSG.NOTICE, obj);

    switch (op) {
      case 'create': {
        if (current) return reply({ kind: 'error', text: 'Você já pertence a uma colônia' });
        const name = sanitizeName(msg?.name);
        if (!name) return reply({ kind: 'error', text: 'Nome de colônia inválido' });
        const minPlay = config.colonyCreateMinPlaytime ?? 3;
        if (player.stats.playtime < minPlay) return reply({ kind: 'error', text: 'Explore um pouco antes de fundar uma colônia' });
        const colony = world.createPlayerColony({
          name, sessionId: player.sessionId,
          color: Number(msg?.color) || undefined,
          x: player.x, y: player.y,   // o ninho nasce onde o fundador está
        });
        colony.addMember(player.sessionId, player.name);
        player.colonyId = colony.id;
        player.color = colony.color;
        player.x = colony.nest.x + (Math.random() - 0.5) * 50;
        player.y = colony.nest.y + (Math.random() - 0.5) * 50;
        socket.join(`colony:${colony.id}`);
        const s = world.players.sessions.get(player.sessionId);
        if (s) s.colonyId = colony.id;
        broadcastColonies();
        reply({ kind: 'colony', op: 'create', colony: { id: colony.id, name: colony.name, color: colony.color } });
        return undefined;
      }
      case 'join': {
        if (current) return reply({ kind: 'error', text: 'Você já pertence a uma colônia' });
        const target = world.colonies.get(String(msg?.id));
        if (!target) return reply({ kind: 'error', text: 'Colônia não encontrada' });
        if (target.isAi) return reply({ kind: 'error', text: 'Não é possível entrar em uma colônia selvagem' });
        const add = target.addMember(player.sessionId, player.name);
        if (!add.ok) return reply({ kind: 'error', text: add.reason });
        player.colonyId = target.id;
        player.color = target.color;
        player.x = target.nest.x + (Math.random() - 0.5) * 60;
        player.y = target.nest.y + (Math.random() - 0.5) * 60;
        socket.join(`colony:${target.id}`);
        const sess = world.players.sessions.get(player.sessionId);
        if (sess) sess.colonyId = target.id;
        target.alert('member', `${player.name} entrou na colônia`, target.nest.x, target.nest.y, 6000);
        io.to(`colony:${target.id}`).emit(MSG.CHAT_MSG, {
          from: 'Colônia', text: `${player.name} entrou na colônia`, channel: 'colony', system: true, at: now,
        });
        broadcastColonies();
        reply({ kind: 'colony', op: 'join', colony: { id: target.id, name: target.name, color: target.color } });
        return undefined;
      }
      case 'leave': {
        if (!current) return reply({ kind: 'error', text: 'Sem colônia' });
        current.removeMember(player.sessionId);
        player.colonyId = null;
        socket.leave(`colony:${current.id}`);
        const sess = world.players.sessions.get(player.sessionId);
        if (sess) sess.colonyId = null;
        if (current.members.size === 0) {
          // colônia abandonada continua viva como colônia selvagem (emergente!)
          current.isAi = true;
          current.name = current.name.endsWith(' (abandonada)') ? current.name : `${current.name} (abandonada)`;
          world.directors.set(current.id, new ColonyDirector(world, current));
          world.events.push('colony', `${current.name} foi abandonada e segue sozinha`, current.nest.x, current.nest.y, true);
        }
        broadcastColonies();
        reply({ kind: 'colony', op: 'leave' });
        return undefined;
      }
      case 'rename': {
        if (!current) return reply({ kind: 'error', text: 'Sem colônia' });
        if (!current.can(player.sessionId, 'manageRoles')) return reply({ kind: 'error', text: 'Sem permissão' });
        const name = sanitizeName(msg?.name);
        if (!name) return reply({ kind: 'error', text: 'Nome inválido' });
        current.name = name;
        broadcastColonies();
        reply({ kind: 'colony', op: 'rename', name });
        return undefined;
      }
      case 'role': {
        if (!current) return reply({ kind: 'error', text: 'Sem colônia' });
        const res = current.setMemberRole(player.sessionId, String(msg?.sessionId), String(msg?.role));
        if (!res.ok) return reply({ kind: 'error', text: res.reason });
        reply({ kind: 'colony', op: 'role' });
        return undefined;
      }
      case 'kick': {
        if (!current) return reply({ kind: 'error', text: 'Sem colônia' });
        if (!current.can(player.sessionId, 'kick')) return reply({ kind: 'error', text: 'Sem permissão' });
        const targetSid = String(msg?.sessionId);
        if (targetSid === player.sessionId) return reply({ kind: 'error', text: 'Não é possível expulsar a si mesmo' });
        const targetSocket = sessionsToSocket.get(targetSid);
        current.removeMember(targetSid);
        if (targetSocket) {
          io.to(targetSocket).emit(MSG.KICK, { reason: `Você foi removido de ${current.name}` });
          io.sockets.sockets.get(targetSocket)?.leave(`colony:${current.id}`);
          const tp = world.players.get(targetSid);
          if (tp) tp.colonyId = null;
        }
        broadcastColonies();
        reply({ kind: 'colony', op: 'kick' });
        return undefined;
      }
      case 'permissions': {
        if (!current) return reply({ kind: 'error', text: 'Sem colônia' });
        if (!current.can(player.sessionId, 'manageRoles')) return reply({ kind: 'error', text: 'Sem permissão' });
        const role = String(msg?.role);
        const perm = String(msg?.perm);
        if (!current.permissions[role] || !(perm in current.permissions[role])) {
          return reply({ kind: 'error', text: 'Permissão inválida' });
        }
        current.permissions[role][perm] = !!msg?.value;
        reply({ kind: 'colony', op: 'permissions' });
        return undefined;
      }
      case 'war': {
        if (!current) return reply({ kind: 'error', text: 'Sem colônia' });
        if (!current.can(player.sessionId, 'war')) return reply({ kind: 'error', text: 'Sem permissão para declarar guerra' });
        const target = world.colonies.get(String(msg?.id));
        if (!target || target.id === current.id) return reply({ kind: 'error', text: 'Alvo inválido' });
        current.adjustRelation(target.id, -60);
        target.adjustRelation(current.id, -60);
        target.alert('war', `${current.name} declarou guerra!`, current.nest.x, current.nest.y, 15000);
        io.emit(MSG.EVENT, { k: 'war', t: `${current.name} declarou guerra a ${target.name}`, x: current.nest.x, y: current.nest.y, i: 1 });
        reply({ kind: 'colony', op: 'war' });
        return undefined;
      }
      case 'peace': {
        if (!current) return reply({ kind: 'error', text: 'Sem colônia' });
        const target = world.colonies.get(String(msg?.id));
        if (!target) return reply({ kind: 'error', text: 'Alvo inválido' });
        current.adjustRelation(target.id, 60);
        target.adjustRelation(current.id, 60);
        reply({ kind: 'colony', op: 'peace' });
        return undefined;
      }
      default:
        return reply({ kind: 'error', text: 'Operação desconhecida' });
    }
  }

  function broadcastColonies() {
    io.emit(MSG.COLONIES, [...world.colonies.values()].map((c) => ({
      id: c.id, name: c.name, color: c.color, isAi: c.isAi,
      pop: c.totalPopulation, members: c.members.size, structures: c.structures.size,
      nest: { x: Math.round(c.nest.x), y: Math.round(c.nest.y) },
      open: !c.isAi && c.members.size < COLONY_LIMITS.maxMembers,
    })));
  }

  function findSpawnPoint(world) {
    // perto de uma colônia ativa, mas não dentro dela
    const colonies = [...world.colonies.values()];
    if (colonies.length) {
      const c = colonies[Math.floor(Math.random() * colonies.length)];
      const a = Math.random() * Math.PI * 2;
      const r = 180 + Math.random() * 260;
      const x = c.nest.x + Math.cos(a) * r;
      const y = c.nest.y + Math.sin(a) * r;
      if (!world.isWaterCached(x, y)) return { x, y };
      return { x: c.nest.x + 120, y: c.nest.y + 120 };
    }
    let x = world.sizePx / 2;
    let y = world.sizePx / 2;
    for (let i = 0; i < 50; i++) {
      const px = world.sizePx / 2 + (Math.random() - 0.5) * 6000;
      const py = world.sizePx / 2 + (Math.random() - 0.5) * 6000;
      if (!world.isWaterCached(px, py)) { x = px; y = py; break; }
    }
    return { x, y };
  }

  // ---------------------------------------------------------------- loop de snapshots
  let snapCounter = 0;
  const snapTimer = setInterval(() => {
    snapCounter++;
    const players = [...io.sockets.sockets.values()].filter((s) => s.data.player?.alive || s.data.player);
    const load = players.length;
    // degradação graciosa: mais jogadores → snapshots um pouco mais espaçados
    const every = load > 100 ? 3 : load > 60 ? 2 : 1;
    if (snapCounter % every !== 0) return;
    const full = snapCounter % 5 === 0;

    for (const socket of players) {
      const p = socket.data.player;
      if (!p) continue;
      try {
        const payload = aoi.build(socket, p, full ? 'full' : 'move');
        socket.emit(MSG.SNAP, payload);
        if (full) {
          socket.emit(MSG.STATE, aoi.buildColonyState(p));
          if (snapCounter % 20 === 0) socket.emit('players', aoi.buildPlayersList(p));
        }
      } catch (err) {
        log.error('snapshot falhou:', err.message);
      }
    }
  }, 100);
  if (snapTimer.unref) snapTimer.unref();

  // limpeza de sessões ociosas
  const gcTimer = setInterval(() => {
    world.players.gc(NET.reconnectGraceMs);
  }, 30_000);
  if (gcTimer.unref) gcTimer.unref();

  async function close() {
    clearInterval(snapTimer);
    clearInterval(gcTimer);
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  }

  return { app, httpServer, io, aoi, close, broadcastColonies };
}

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

export { CLIENT_VERSION };
