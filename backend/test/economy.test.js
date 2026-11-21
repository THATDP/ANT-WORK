import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers.js';
import { RESOURCE_KEYS, RESOURCE_INFO, RESOURCE, BUILDING, BUILDING_INFO, ROLE, CHUNK_TILES } from '../../shared/constants.js';

test('estoque nunca ultrapassa a capacidade e nada é duplicado', async () => {
  const { world } = await makeWorld({ config: { autoAiColonies: 0 } });
  const c = world.createPlayerColony({ name: 'Cap', sessionId: 's1' });
  c.stock = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, 0]));
  const cap = c.storageCap;
  assert.equal(cap, 400);

  const first = c.addStock('leaf', cap - 10);
  assert.equal(first, cap - 10);
  const second = c.addStock('leaf', 100);
  assert.equal(second, 10, 'só deve aceitar o que cabe');
  assert.equal(c.totalStored(), cap);
  assert.equal(c.addStock('water', 50), 0, 'estoque cheio não aceita mais');
  assert.equal(c.totalStored(), cap);
});

test('spend é atômico: ou paga tudo ou não paga nada', async () => {
  const { world } = await makeWorld({ config: { autoAiColonies: 0 } });
  const c = world.createPlayerColony({ name: 'Atômica', sessionId: 's1' });
  c.stock = { leaf: 5, seed: 0, fruit: 0, insect: 0, water: 0, material: 4, spore: 0 };
  assert.equal(c.hasStock({ material: 4, leaf: 5 }), true);
  assert.equal(c.spend({ material: 10 }), false);
  assert.equal(c.stock.material, 4, 'falha não pode debitar nada');
  assert.equal(c.spend({ material: 4, leaf: 5 }), true);
  assert.equal(c.totalStored(), 0);
});

test('coleta concorrente do mesmo nó não duplica recurso', async () => {
  const { world } = await makeWorld({ config: { autoAiColonies: 0 } });
  const c = world.createPlayerColony({ name: 'Coleta', sessionId: 's1' });
  const { cx, cy } = world.chunkOf(c.nest.x, c.nest.y);
  const chunk = world.chunks.get(cx, cy);
  const node = chunk.nodes.find((n) => n.amount > 0);
  node.amount = 1;

  const p1 = world.players.spawn('s1', 'Ana', c.id, node.x + 8, node.y + 8);
  const p2 = world.players.spawn('s2', 'Bia', c.id, node.x - 8, node.y - 8);

  const r1 = world.handleAction(p1, { type: 'gather', nodeId: node.id });
  const r2 = world.handleAction(p2, { type: 'gather', nodeId: node.id });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.equal(node.amount, 0);
  assert.equal(p1.carrying.amount + p2.carrying.amount, 1, 'total coletado não pode passar do nó');
  assert.equal(p1.carrying.kind, node.kind);
  assert.equal(world.resources.harvest(node, 5), 0, 'nó vazio não entrega nada');
});

test('cliente não consegue declarar quantidade ao coletar (servidor decide)', async () => {
  const { world } = await makeWorld({ config: { autoAiColonies: 0 } });
  const c = world.createPlayerColony({ name: 'AntiCheat', sessionId: 's1' });
  const { cx, cy } = world.chunkOf(c.nest.x, c.nest.y);
  const chunk = world.chunks.get(cx, cy);
  const node = chunk.nodes.find((n) => n.amount > 2);
  const before = node.amount;
  const p = world.players.spawn('s1', 'Cheater', c.id, node.x, node.y);
  const res = world.handleAction(p, { type: 'gather', nodeId: node.id, amount: 9999, xp: 999 });
  assert.equal(res.ok, true);
  assert.equal(node.amount, before - 1, 'servidor ignora a quantidade pedida');
  assert.equal(p.carrying.amount, 1);
});

test('jogador não coleta recurso longe dele', async () => {
  const { world } = await makeWorld({ config: { autoAiColonies: 0 } });
  const c = world.createPlayerColony({ name: 'Longe', sessionId: 's1' });
  const { cx, cy } = world.chunkOf(c.nest.x, c.nest.y);
  const node = world.chunks.get(cx, cy).nodes.find((n) => n.amount > 0);
  const p = world.players.spawn('s1', 'Longe', c.id, c.nest.x, c.nest.y);
  node.x = p.x + 500;
  node.y = p.y + 500;
  const res = world.handleAction(p, { type: 'gather', nodeId: node.id });
  assert.equal(res.ok, false);
  assert.match(res.reason, /longe/i);
});

test('depósito exige proximidade e respeita o limite do estoque', async () => {
  const { world } = await makeWorld({ config: { autoAiColonies: 0 } });
  const c = world.createPlayerColony({ name: 'Dep', sessionId: 's1' });
  c.stock = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, 0]));
  const p = world.players.spawn('s1', 'Dep', c.id, c.nest.x, c.nest.y);
  p.carrying = { kind: RESOURCE.LEAF, amount: 5 };
  c.stock.leaf = c.storageCap - 2;
  assert.equal(c.totalStored(), c.storageCap - 2);
  const res = world.handleAction(p, { type: 'deposit' });
  assert.equal(res.ok, true);
  assert.equal(res.data.accepted, 2);
  assert.equal(res.data.lost, 3);
  assert.equal(c.totalStored(), c.storageCap);
  assert.equal(p.carrying.amount, 0);

  const far = world.players.spawn('s2', 'Longe', c.id, c.nest.x + 3000, c.nest.y);
  far.carrying = { kind: RESOURCE.LEAF, amount: 2 };
  const res2 = world.handleAction(far, { type: 'deposit' });
  assert.equal(res2.ok, false);
});

test('depósitos aumentam a capacidade de armazenamento', async () => {
  const { world } = await makeWorld({ config: { autoAiColonies: 0 } });
  const c = world.createPlayerColony({ name: 'Storage', sessionId: 's1' });
  const base = c.storageCap;
  const { cx, cy } = world.chunkOf(c.nest.x, c.nest.y);
  const chunk = world.chunks.get(cx, cy);
  c.stock.material = 200;
  // o ninho ocupa células e o bioma varia: procure um local válido de verdade
  let cell = null;
  for (let gy = 1; gy < CHUNK_TILES - 2 && !cell; gy++) {
    for (let gx = 1; gx < CHUNK_TILES - 2; gx++) {
      if (chunk.canPlace(world.seed, gx, gy, BUILDING_INFO[BUILDING.STORAGE].size, BUILDING.STORAGE).ok) {
        cell = { gx, gy };
        break;
      }
    }
  }
  assert.ok(cell, 'deve existir um local livre no setor do ninho');
  const r = world.build.create(c, BUILDING.STORAGE, cx, cy, cell.gx, cell.gy, null, { asAi: true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(c.storageCap, base + 250);
});

test('fome individual leva a morte e gera carcaça', async () => {
  const { world } = await makeWorld({ config: { autoAiColonies: 0 } });
  const c = world.createPlayerColony({ name: 'Fome', sessionId: 's1' });
  c.stock = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, 0]));
  const ant = [...c.ants].find((a) => a.role === ROLE.WORKER);
  ant.hunger = 119;
  ant.hp = 1;
  const corpsesBefore = [...world.chunks.chunks.values()].reduce((s, ch) => s + ch.nodes.filter((n) => n.id < 0).length, 0);
  ant.hp = -1;
  ant.die('fome');
  assert.equal(ant.alive, false);
  const corpsesAfter = [...world.chunks.chunks.values()].reduce((s, ch) => s + ch.nodes.filter((n) => n.id < 0).length, 0);
  assert.ok(corpsesAfter > corpsesBefore, 'morte deve produzir carcaça');
  assert.equal(c.population.worker >= 0, true);
});

test('consumo de comida esgota o estoque e nunca deixa negativo', async () => {
  const { world } = await makeWorld({ config: { autoAiColonies: 0 } });
  const c = world.createPlayerColony({ name: 'Consumo', sessionId: 's1' });
  c.stock = { leaf: 2, seed: 0, fruit: 0, insect: 0, water: 0, material: 0, spore: 0 };
  assert.equal(c.takeFood(5), 2);
  assert.equal(c.stock.leaf, 0);
  assert.equal(c.takeFood(5), 0);
  for (const v of Object.values(c.stock)) assert.ok(v >= 0);
});

test('ciclo de vida: ovos → larvas → adultas', async () => {
  const { world } = await makeWorld({ config: { autoAiColonies: 0 } });
  const c = world.createPlayerColony({ name: 'Berço', sessionId: 's1' });
  c.stock = { leaf: 200, seed: 200, fruit: 200, insect: 200, water: 200, material: 200, spore: 5 };
  c.morale = 90;
  const before = c.totalPopulation;
  const larvaeBefore = c.population.larva;
  // ambiente controlado: sem predadores atrapalhando o berçário
  world.maxPredators = 0;
  for (const p of world.predators.predators.values()) { p.dead = true; }
  world.predators.tick(1);
  c.brood.eggs = 3;
  for (let i = 0; i < 400; i++) world.step();
  assert.ok(c.totalPopulation > 0); // 40s: ovos viram larvas
  assert.ok(c.population.larva > larvaeBefore, `esperava larvas novas (antes ${larvaeBefore}, agora ${c.population.larva})`);
  assert.ok(c.population.larva > 0);
  assert.ok(c.totalPopulation >= before);
});

test('economia abstrata (LOD 2) mantém a colônia viva sem simular passos', async () => {
  const { world } = await makeWorld({ config: { autoAiColonies: 1 } });
  const ai = [...world.colonies.values()].find((c) => c.isAi);
  ai.stock = { leaf: 0, seed: 0, fruit: 0, insect: 0, water: 0, material: 0, spore: 0 };
  for (const a of ai.ants) a.detail = 2;
  const popBefore = ai.totalPopulation;
  for (let i = 0; i < 600; i++) world.step();
  const food = ai.stock.leaf + ai.stock.seed + ai.stock.fruit + ai.stock.insect;
  assert.ok(food > 0, 'formigas distantes devem produzir comida');
  assert.ok(ai.totalPopulation > 0, 'colônia não pode desaparecer em 60s');
  assert.ok(ai.totalPopulation >= popBefore * 0.5);
});

test('recursos do mundo regeneram com o tempo', async () => {
  const { world } = await makeWorld({ config: { autoAiColonies: 0 } });
  const { cx, cy } = world.chunkOf(world.sizePx / 2, world.sizePx / 2);
  const chunk = world.chunks.get(cx, cy);
  const node = chunk.nodes.find((n) => n.kind === RESOURCE.WATER || n.amount > 20);
  node.amount = 0;
  node.respawnAt = world.tick;
  const before = node.amount;
  for (let i = 0; i < 300; i++) world.step();
  assert.ok(node.amount > before, 'nó deve regenerar');
});
