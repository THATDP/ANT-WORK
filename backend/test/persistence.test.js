import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, advance } from './helpers.js';
import { World } from '../src/game/world.js';
import { MemoryStore } from '../src/persist/memory.js';
import { BUILDING, RESOURCE_KEYS } from '../../shared/constants.js';

const silentLog = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

test('estado sobrevive a reinicialização do backend (colônias, estruturas, estoque)', async () => {
  const store = new MemoryStore({});
  const { world } = await makeWorld({ store, config: { autoAiColonies: 0 } });
  const c = world.createPlayerColony({ name: 'Persistente', sessionId: 's1' });
  c.addMember('s1', 'Persistente');
  c.stock.material = 300;
  c.stock.insect = 42;
  const { cx, cy } = world.chunkOf(c.nest.x, c.nest.y);
  const st = world.build.create(c, BUILDING.STORAGE, cx, cy, 6, 6, 's1');
  assert.equal(st.ok, true, st.reason);
  st.structure.progress = 100;
  advance(world, 50);
  await store.saveWorld(world);

  const world2 = new World({ seed: world.seed, id: world.id, store, config: world.config, log: silentLog });
  await world2.load();
  const restored = world2.colonies.get(c.id);
  assert.ok(restored, 'colônia deve ser restaurada');
  assert.equal(restored.name, 'Persistente');
  assert.equal(restored.stock.insect, 42);
  assert.ok(restored.structures.size >= 1, 'estrutura deve sobreviver');
  const st2 = [...restored.structures.values()].find((s) => s.type === BUILDING.STORAGE);
  assert.ok(st2, 'depósito restaurado');
  assert.equal(st2.progress, 100);
  assert.ok(world2.structureIndex.has(st2.id));
  assert.ok(restored.ants.size > 0, 'população é reconstruída a partir do estado salvo');
  assert.equal(world2.tick, world.tick);
});

test('estado de nós de recurso é preservado entre reinícios', async () => {
  const store = new MemoryStore({});
  const { world } = await makeWorld({ store, config: { autoAiColonies: 0 } });
  const { cx, cy } = world.chunkOf(world.sizePx / 2, world.sizePx / 2);
  const chunk = world.chunks.get(cx, cy);
  const node = chunk.nodes.find((n) => n.amount > 30);
  node.amount = 3;
  chunk.dirtyNodes.add(node.id);
  await store.saveWorld(world);

  const world2 = new World({ seed: world.seed, id: world.id, store, config: world.config, log: silentLog });
  await world2.load();
  const chunk2 = world2.chunks.get(cx, cy);
  const node2 = chunk2.nodesById.get(node.id);
  // o chunk é hidratado ao carregar (peekChunkData do store)
  assert.ok(node2, 'nó deve existir');
  assert.equal(node2.amount, 3, 'quantidade coletada deve persistir');
});

test('snapshot completo permite voltar no tempo', async () => {
  const store = new MemoryStore({});
  const { world } = await makeWorld({ store, config: { autoAiColonies: 0 } });
  const c = world.createPlayerColony({ name: 'Snap', sessionId: 's1' });
  c.stock.insect = 10;
  await store.saveSnapshot(world, 'antes');
  c.stock.insect = 500;
  assert.equal(c.stock.insect, 500);
  const loaded = await store.loadSnapshot(world.id);
  assert.equal(loaded.colonies.find((x) => x.id === c.id).stock.insect, 10);
});

test('eventos importantes são registrados', async () => {
  const store = new MemoryStore({});
  const { world } = await makeWorld({ store, config: { autoAiColonies: 0 } });
  world.events.push('war', 'Batalha de teste', 100, 100, true);
  await store.saveEvents(world.id, world.events.recent(10));
  const saved = store.events.get(world.id);
  assert.ok(saved.some((e) => e.text === 'Batalha de teste'));
});

test('falha de persistência não derruba a simulação', async () => {
  const brokenStore = new MemoryStore({});
  brokenStore.saveWorld = async () => { throw new Error('banco fora do ar'); };
  const { world } = await makeWorld({ store: brokenStore, config: { autoAiColonies: 0 } });
  const c = world.createPlayerColony({ name: 'Resiliente', sessionId: 's1' });
  const before = c.totalPopulation;
  advance(world, 100);
  assert.ok(world.tick >= 100);
  assert.ok(c.totalPopulation > 0);
  assert.ok(before > 0);
});
