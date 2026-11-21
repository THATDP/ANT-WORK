import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers.js';
import { BUILDING, BUILDING_INFO, COLONY_ROLE, RESOURCE_KEYS, TILE, CHUNK_TILES } from '../../shared/constants.js';

function freeSpot(world, c, cx, cy, type) {
  const chunk = world.chunks.get(cx, cy);
  const size = BUILDING_INFO[type].size;
  for (let gy = 0; gy + size <= CHUNK_TILES; gy++) {
    for (let gx = 0; gx + size <= CHUNK_TILES; gx++) {
      if (chunk.canPlace(world.seed, gx, gy, size, type).ok) return { gx, gy };
    }
  }
  return null;
}

async function setupWithSpace() {
  const { world } = await makeWorld({ config: { autoAiColonies: 0 } });
  const c = world.createPlayerColony({ name: 'Obras', sessionId: 's1' });
  c.addMember('s1', 'Fundadora');
  c.stock = { leaf: 500, seed: 500, fruit: 500, insect: 500, water: 500, material: 900, spore: 20 };
  const { cx, cy } = world.chunkOf(c.nest.x, c.nest.y);
  const chunk = world.chunks.get(cx, cy);
  return { world, c, cx, cy, chunk };
}

test('construir exige recursos e debita o custo', async () => {
  const { world, c, cx, cy } = await setupWithSpace();
  c.stock.material = 0;
  const res = world.build.create(c, BUILDING.TUNNEL, cx, cy, 4, 4, 's1');
  assert.equal(res.ok, false);
  assert.match(res.reason, /insuficiente/i);

  c.stock.material = 100;
  const before = c.stock.material;
  const spot = freeSpot(world, c, cx, cy, BUILDING.TUNNEL);
  const ok = world.build.create(c, BUILDING.TUNNEL, cx, cy, spot.gx, spot.gy, 's1');
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(c.stock.material, before - BUILDING_INFO[BUILDING.TUNNEL].cost.material);
  assert.ok(world.structureIndex.has(ok.structure.id));
});

test('estruturas não podem se sobrepor nem sair do chunk', async () => {
  const { world, c, cx, cy } = await setupWithSpace();
  const spot = freeSpot(world, c, cx, cy, BUILDING.CHAMBER);
  assert.ok(spot, 'deve haver espaço livre');
  const a = world.build.create(c, BUILDING.CHAMBER, cx, cy, spot.gx, spot.gy, 's1');
  assert.equal(a.ok, true, a.reason);
  const b = world.build.create(c, BUILDING.TUNNEL, cx, cy, spot.gx, spot.gy, 's1');
  assert.equal(b.ok, false);
  assert.match(b.reason, /ocupado/i);
  const out = world.build.create(c, BUILDING.TUNNEL, cx, cy, CHUNK_TILES, CHUNK_TILES, 's1');
  assert.equal(out.ok, false);
  assert.match(out.reason, /limites/i);
  // estrutura 2×2 não pode vazar a borda do chunk
  const edge = world.build.create(c, BUILDING.CHAMBER, cx, cy, CHUNK_TILES - 1, 4, 's1');
  assert.equal(edge.ok, false);
});

test('não é possível construir sobre água', async () => {
  const { world, c } = await setupWithSpace();
  // procura um tile de água num chunk próximo
  let found = null;
  for (let cx = 0; cx < world.chunksAcross && !found; cx++) {
    for (let cy = 0; cy < world.chunksAcross && !found; cy++) {
      const chunk = world.chunks.get(cx, cy);
      for (let gy = 0; gy < CHUNK_TILES && !found; gy++) {
        for (let gx = 0; gx < CHUNK_TILES && !found; gx++) {
          const wx = cx * 768 + gx * TILE;
          const wy = cy * 768 + gy * TILE;
          if (world.isWaterCached(wx + 16, wy + 16)) found = { cx, cy, gx, gy };
        }
      }
    }
  }
  assert.ok(found, 'o mundo precisa ter água');
  c.nest.x = found.cx * 768 + 300;
  c.nest.y = found.cy * 768 + 300;
  const res = world.build.create(c, BUILDING.TUNNEL, found.cx, found.cy, found.gx, found.gy, 's1');
  assert.equal(res.ok, false);
  assert.match(res.reason, /água/i);
});

test('distância máxima do ninho é respeitada', async () => {
  const { world, c } = await setupWithSpace();
  const farCx = Math.min(world.chunksAcross - 1, Math.floor(c.nest.x / 768) + 9);
  const farCy = Math.floor(c.nest.y / 768);
  const res = world.build.create(c, BUILDING.TUNNEL, farCx, farCy, 3, 3, 's1');
  assert.equal(res.ok, false);
  assert.match(res.reason, /longe/i);
});

test('membro comum não pode demolir; fundador pode e recebe reembolso', async () => {
  const { world, c, cx, cy } = await setupWithSpace();
  const spot = freeSpot(world, c, cx, cy, BUILDING.STORAGE);
  assert.ok(spot);
  const st = world.build.create(c, BUILDING.STORAGE, cx, cy, spot.gx, spot.gy, 's1').structure;
  st.progress = 100;
  st.hp = st.maxHp;

  // segundo jogador entra como membro
  world.players.spawn('s2', 'Membro', c.id, c.nest.x, c.nest.y);
  c.addMember('s2', 'Membro');
  assert.equal(c.memberRole('s2'), COLONY_ROLE.MEMBER);

  const denied = world.build.demolish(st, 's2');
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /permissão/i);
  assert.ok(world.structureIndex.has(st.id), 'estrutura deve continuar de pé');

  c.stock = { leaf: 0, seed: 0, fruit: 0, insect: 0, water: 0, material: 0, spore: 0 };
  const before = c.stock.material;
  const ok = world.build.demolish(st, 's1');
  assert.equal(ok.ok, true, ok.reason);
  assert.ok(c.stock.material > before, 'reembolso parcial de material');
  assert.equal(world.structureIndex.has(st.id), false);
  assert.equal(c.structures.has(st.id), false);
});

test('jogador sem colônia não constrói', async () => {
  const { world, c, cx, cy } = await setupWithSpace();
  const res = world.build.validate(null, BUILDING.TUNNEL, cx, cy, 3, 3, 'sX');
  assert.equal(res.ok, false);
  assert.match(res.reason, /colônia/i);
});

test('progresso cooperativo conclui a obra e libera espaço', async () => {
  const { world, c, cx, cy } = await setupWithSpace();
  const spot = freeSpot(world, c, cx, cy, BUILDING.TUNNEL);
  assert.ok(spot);
  const builtBefore = c.stats.built;
  const st = world.build.create(c, BUILDING.TUNNEL, cx, cy, spot.gx, spot.gy, 's1').structure;
  assert.equal(st.progress, 0);
  assert.equal(c.pendingBuilds, 1);
  for (let i = 0; i < 400 && st.progress < 100; i++) {
    world.build.contribute(st, { id: 1 }, 0.1, true);
  }
  assert.equal(st.progress, 100);
  assert.equal(st.hp, st.maxHp);
  assert.equal(c.pendingBuilds, 0);
  assert.equal(c.stats.built, builtBefore + 1);
});

test('não é possível construir em cima do ninho de outra colônia', async () => {
  const { world, c } = await setupWithSpace();
  const other = world.createPlayerColony({
    name: 'Vizinha', sessionId: 's2', x: c.nest.x + 260, y: c.nest.y + 120,
  });
  const { cx, cy } = world.chunkOf(other.nest.x, other.nest.y);
  const res = world.build.create(c, BUILDING.TUNNEL, cx, cy, 10, 10, 's1');
  assert.equal(res.ok, false);
  assert.match(res.reason, /território/i);
});

test('limite de estruturas por colônia é aplicado', async () => {
  const { world, c, cx, cy } = await setupWithSpace();
  c.stock.material = 999999;
  c.structures.clear();
  // preenche artificialmente o mapa da colônia
  for (let i = 0; i < 221; i++) c.structures.set(i, { id: i, type: BUILDING.TUNNEL, progress: 100, hp: 30, wx: 0, wy: 0 });
  const res = world.build.validate(c, BUILDING.TUNNEL, cx, cy, 20, 20, 's1');
  assert.equal(res.ok, false);
  assert.match(res.reason, /limite/i);
});

test('IA constrói sozinha dentro do território', async () => {
  const { world } = await makeWorld({ config: { autoAiColonies: 1 } });
  const ai = [...world.colonies.values()].find((x) => x.isAi);
  ai.stock = { leaf: 400, seed: 400, fruit: 200, insect: 200, water: 200, material: 400, spore: 5 };
  const before = ai.structures.size;
  for (let i = 0; i < 400; i++) world.step();
  assert.ok(ai.structures.size > before, `esperava construções novas (antes ${before}, agora ${ai.structures.size})`);
});
