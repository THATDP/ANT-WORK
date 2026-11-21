import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioc } from 'socket.io-client';
import { makeWorld, startServer, wait, waitFor } from './helpers.js';
import { MSG, BUILDING, RESOURCE_KEYS } from '../../shared/constants.js';

async function boot(opts = {}) {
  const { world } = await makeWorld({ config: { autoAiColonies: opts.ai ?? 0 } });
  const server = await startServer(world, { colonyCreateMinPlaytime: 0 });
  return { world, server, url: `http://127.0.0.1:${server.port}` };
}

function connect(url, name, token) {
  const socket = ioc(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  const client = { socket, snaps: [], snapBytes: 0, notices: [], states: [], events: [], chats: [] };
  socket.on(MSG.SNAP, (p) => { client.snaps.push(p); client.snapBytes += JSON.stringify(p).length; });
  socket.on(MSG.NOTICE, (n) => client.notices.push(n));
  socket.on(MSG.STATE, (s) => client.states.push(s));
  socket.on(MSG.EVENT, (e) => client.events.push(e));
  socket.on(MSG.CHAT_MSG, (c) => client.chats.push(c));
  socket.on(MSG.ERROR, (e) => client.notices.push({ kind: 'error', text: e.error }));
  client.ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout conectando ${name}`)), 5000);
    socket.on(MSG.WELCOME, (w) => { clearTimeout(t); client.welcome = w; resolve(w); });
    socket.on('connect_error', (e) => { clearTimeout(t); reject(e); });
    socket.on('connect', () => socket.emit(MSG.HELLO, { name, token }));
  });
  return client;
}

test('handshake entrega token, mundo e estado inicial', async () => {
  const { server, url } = await boot();
  const a = connect(url, 'Formiguinha');
  const w = await a.ready;
  assert.ok(w.token && w.token.length === 36);
  assert.equal(w.world.chunkPx, 768);
  assert.ok(w.spawn.x > 0);
  await waitFor(() => a.snaps.length > 2);
  assert.ok(a.snaps[0].self, 'snapshot traz estado do próprio jogador');
  assert.ok(a.snaps.length > 0);
  a.socket.close();
  await server.close();
});

test('dois jogadores compartilham a mesma colônia e se veem', async () => {
  const { world, server, url } = await boot();
  const a = connect(url, 'Ana');
  const wa = await a.ready;
  a.socket.emit(MSG.COLONY_OP, { op: 'create', name: 'Colônia Unida' });
  const created = await waitFor(() => a.notices.find((n) => n.kind === 'colony' && n.op === 'create'));
  assert.ok(created, 'colônia deve ser criada');
  const colonyId = created.colony.id;

  const b = connect(url, 'Bia');
  await b.ready;
  await wait(150);
  b.socket.emit(MSG.COLONY_OP, { op: 'join', id: colonyId });
  const joined = await waitFor(() => b.notices.find((n) => n.kind === 'colony' && n.op === 'join'));
  assert.ok(joined, 'segundo jogador deve entrar');
  assert.equal(world.colonies.get(colonyId).members.size, 2);

  await waitFor(() => b.states.some((s) => s.colony?.id === colonyId && s.colony.members.length === 2));
  const state = b.states.find((s) => s.colony?.id === colonyId);
  assert.ok(state.colony.members.some((m) => m.name === 'Ana'));
  assert.ok(b.snaps.some((s) => (s.pl || []).some((p) => p[3] === 'Ana')), 'Bia enxerga Ana');
  a.socket.close(); b.socket.close();
  await server.close();
});

test('construções concorrentes no mesmo tile: só uma vence e o custo é debitado uma vez', async () => {
  const { world, server, url } = await boot();
  const a = connect(url, 'Fundadora');
  await a.ready;
  a.socket.emit(MSG.COLONY_OP, { op: 'create', name: 'Obras Concorrentes' });
  const created = await waitFor(() => a.notices.find((n) => n.kind === 'colony' && n.op === 'create'));
  const colonyId = created.colony.id;
  const colony = world.colonies.get(colonyId);
  colony.stock = { leaf: 500, seed: 500, fruit: 500, insect: 500, water: 500, material: 500, spore: 10 };
  const players = [a];
  for (let i = 0; i < 4; i++) {
    const c = connect(url, `Operária${i}`);
    await c.ready;
    c.socket.emit(MSG.COLONY_OP, { op: 'join', id: colonyId });
    await waitFor(() => c.notices.find((n) => n.kind === 'colony' && n.op === 'join'));
    players.push(c);
  }
  const p = [...world.players.bySession.values()][0];
  const { cx, cy } = world.chunkOf(colony.nest.x, colony.nest.y);
  const chunk = world.chunks.get(cx, cy);
  let spot = null;
  for (let gy = 0; gy < 24 && !spot; gy++) {
    for (let gx = 0; gx < 24 && !spot; gx++) {
      if (chunk.canPlace(world.seed, gx, gy, 1, BUILDING.TUNNEL).ok) spot = { gx, gy };
    }
  }
  assert.ok(spot, 'deve existir tile livre');
  const materialBefore = colony.stock.material;
  // todos pedem a mesma posição no mesmo instante
  players.forEach((c) => c.socket.emit(MSG.ACT, { action: { type: 'build', building: BUILDING.TUNNEL, gx: spot.gx, gy: spot.gy } }));
  await waitFor(() => [...colony.structures.values()].some((s) => s.gx === spot.gx && s.gy === spot.gy && s.cx === cx), 3000);
  await wait(300);
  const built = [...colony.structures.values()].filter((s) => s.type === BUILDING.TUNNEL && s.cx === cx && s.cy === cy && s.gx === spot.gx && s.gy === spot.gy);
  assert.equal(built.length, 1, `esperava 1 obra, veio ${built.length}`);
  assert.equal(colony.stock.material, materialBefore - 4, 'custo cobrado exatamente uma vez');
  const owned = built[0];
  assert.ok(world.structureIndex.has(owned.id));
  players.forEach((c) => c.socket.close());
  await server.close();
  assert.ok(p);
});

test('reconexão com token preserva colônia e nome', async () => {
  const { world, server, url } = await boot();
  const a = connect(url, 'Reconecta');
  const wa = await a.ready;
  a.socket.emit(MSG.COLONY_OP, { op: 'create', name: 'Casa' });
  const created = await waitFor(() => a.notices.find((n) => n.kind === 'colony' && n.op === 'create'));
  const colonyId = created.colony.id;
  a.socket.close();
  await wait(200);
  assert.equal(world.players.all().length, 0, 'jogador sai do mundo ao desconectar');

  const b = connect(url, 'Reconecta', wa.token);
  const wb = await b.ready;
  assert.equal(wb.token, wa.token, 'mesmo token de sessão');
  assert.equal(wb.colony?.id, colonyId, 'mesma colônia');
  const sess = world.players.sessions.get(wb.sessionId);
  assert.ok(sess, 'sessão preservada');
  assert.equal(world.colonies.get(colonyId).members.size, 1, 'membro mantido');
  b.socket.close();
  await server.close();
});

test('AOI não envia o mundo inteiro: só o que está perto', async () => {
  const { world, server, url } = await boot({ ai: 1 });
  const a = connect(url, 'Observadora');
  const wa = await a.ready;
  const p = [...world.players.bySession.values()][0];
  // colônia de IA distante: cria formigas lá e garante que não chegam no snapshot
  const ai = [...world.colonies.values()].find((c) => c.isAi);
  const farX = p.x > world.sizePx / 2 ? 1000 : world.sizePx - 1000;
  ai.nest.x = farX; ai.nest.y = farX;
  for (let i = 0; i < 30; i++) world.spawnAnt(ai, 0, { x: farX + i, y: farX + i });
  await wait(600);
  const last = a.snaps[a.snaps.length - 1];
  const ids = new Set((last.add || []).map((e) => e[0]).concat((last.up || []).filter((_, i) => i % 4 === 0)));
  const farIds = [...ai.ants].map((x) => x.id);
  assert.ok(!farIds.some((id) => ids.has(id)), 'formigas fora do AOI não devem ser transmitidas');
  assert.ok(a.snapBytes / a.snaps.length < 20000, 'snapshot médio deve ser pequeno');
  a.socket.close();
  await server.close();
  assert.ok(wa);
});

test('servidor é autoritativo: input absurdo não teletransporta e água bloqueia', async () => {
  const { world, server, url } = await boot();
  const a = connect(url, 'Trapaça');
  await a.ready;
  const p = [...world.players.bySession.values()][0];
  p.x = world.sizePx / 2; p.y = world.sizePx / 2;
  const startX = p.x;
  for (let i = 0; i < 20; i++) a.socket.emit(MSG.INPUT, { vx: 1e9, vy: 1e9, seq: i });
  await wait(400);
  const moved = Math.hypot(p.x - startX, p.y - world.sizePx / 2);
  assert.ok(moved < 78 * 1.5, `não deve teletransportar (andou ${moved.toFixed(1)}px)`);
  assert.ok(p.x >= 0 && p.x <= world.sizePx && p.y >= 0 && p.y <= world.sizePx);
  a.socket.close();
  await server.close();
});

test('rate limit barra spam de ações', async () => {
  const { server, url } = await boot();
  const a = connect(url, 'Spam');
  await a.ready;
  for (let i = 0; i < 60; i++) a.socket.emit(MSG.ACT, { action: { type: 'gather' } });
  await wait(600);
  const warned = a.notices.some((n) => /rápid/i.test(n.text ?? ''));
  assert.ok(warned, 'deve haver aviso de ações muito rápidas');
  a.socket.close();
  await server.close();
});

test('chat é sanitizado e distribui para a colônia', async () => {
  const { server, url } = await boot();
  const a = connect(url, 'Falante');
  await a.ready;
  a.socket.emit(MSG.COLONY_OP, { op: 'create', name: 'Chat' });
  await waitFor(() => a.notices.find((n) => n.kind === 'colony'));
  a.socket.emit(MSG.CHAT, { text: '<script>alert(1)</script> olá', channel: 'colony' });
  const msg = await waitFor(() => a.chats.find((c) => c.text));
  assert.ok(msg);
  assert.ok(!msg.text.includes('<'));
  assert.ok(msg.text.includes('olá'));
  a.socket.close();
  await server.close();
});

test('saúde e métricas respondem com dados reais', async () => {
  const { world, server } = await boot();
  for (let i = 0; i < 30; i++) world.step();
  const health = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json();
  assert.equal(health.ok, true);
  assert.ok(health.world.tick > 0);
  assert.ok(health.memory.rssMb > 0);
  const metrics = await (await fetch(`http://127.0.0.1:${server.port}/metrics`)).text();
  assert.match(metrics, /ant_life_ants \d+/);
  const cfg = await (await fetch(`http://127.0.0.1:${server.port}/api/config`)).json();
  assert.equal(cfg.seed, world.seed);
  await server.close();
});
