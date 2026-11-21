import test from 'node:test';
import assert from 'node:assert/strict';
import {
  biomeAt, generateChunkNodes, nodeId, decomposeNodeId, isWater, elevationAt,
  sectorName, caveAt, chunkBiome,
} from '../../shared/worldgen.js';
import { BIOME, CHUNK_PX, RESOURCE, TILE, WORLD_PX } from '../../shared/constants.js';

const SEED = 424242;

test('mundo é determinístico: mesma semente gera os mesmos biomas', () => {
  for (let i = 0; i < 200; i++) {
    const x = (i * 7919) % WORLD_PX;
    const y = (i * 104729) % WORLD_PX;
    assert.equal(biomeAt(SEED, x, y), biomeAt(SEED, x, y));
  }
  // sementes diferentes devem divergir em pelo menos alguns pontos
  let diff = 0;
  for (let i = 0; i < 100; i++) {
    const x = i * 311 + 500;
    const y = i * 977 + 300;
    if (biomeAt(SEED, x, y) !== biomeAt(SEED + 1, x, y)) diff++;
  }
  assert.ok(diff > 5, `esperava divergência entre sementes, veio ${diff}`);
});

test('chunks são reprodutíveis e contêm recursos com ids únicos', () => {
  const a = generateChunkNodes(SEED, 12, 9);
  const b = generateChunkNodes(SEED, 12, 9);
  assert.deepEqual(a.map((n) => [n.id, n.kind, n.amount]), b.map((n) => [n.id, n.kind, n.amount]));
  assert.ok(a.length >= 14, 'chunk deve ter recursos');
  const ids = new Set(a.map((n) => n.id));
  assert.equal(ids.size, a.length, 'ids de nós devem ser únicos dentro do chunk');
  for (const n of a) {
    assert.ok(n.x >= 12 * CHUNK_PX && n.x <= 13 * CHUNK_PX);
    assert.ok(n.amount > 0 && n.amount <= n.max);
    assert.ok(Number.isInteger(n.kind));
    const d = decomposeNodeId(n.id);
    assert.equal(d.cx, 12);
    assert.equal(d.cy, 9);
    assert.equal(nodeId(d.cx, d.cy, d.i), n.id);
  }
});

test('biomas cobrem o mundo e água respeita rios/lagos', () => {
  const counts = new Map();
  for (let cx = 0; cx < 48; cx += 3) {
    for (let cy = 0; cy < 48; cy += 3) {
      const x = cx * CHUNK_PX + 100;
      const y = cy * CHUNK_PX + 100;
      const b = biomeAt(SEED, x, y);
      counts.set(b, (counts.get(b) || 0) + 1);
      if (isWater(SEED, x, y)) {
        // água nunca é "construível" — garantido pela validação de build
        assert.notEqual(b, BIOME.ROCK);
      }
    }
  }
  assert.ok(counts.size >= 4, `esperava pelo menos 4 biomas, achei ${counts.size}`);
  assert.ok(counts.get(BIOME.FOREST) || counts.get(BIOME.GARDEN), 'deve haver vegetação');
});

test('nomes de setores são estáveis e legíveis', () => {
  const a = sectorName(SEED, 7, 11);
  assert.equal(a, sectorName(SEED, 7, 11));
  assert.match(a, /^[A-Za-zÀ-ÿ]+ \d+$/);
});

test('cavernas existem mas não cobrem tudo', () => {
  let high = 0;
  for (let i = 0; i < 400; i++) {
    const v = caveAt(SEED, (i * 997) % WORLD_PX, (i * 6011) % WORLD_PX);
    if (v > 0.2) high++;
  }
  assert.ok(high > 5 && high < 390, `distribuição de cavernas suspeita: ${high}/400`);
});

test('elevação fica em [0,1] e chunkBiome corresponde ao centro', () => {
  for (let i = 0; i < 300; i++) {
    const e = elevationAt(SEED, (i * 1237) % WORLD_PX, (i * 5521) % WORLD_PX);
    assert.ok(e >= 0 && e <= 1);
  }
  assert.equal(chunkBiome(SEED, 5, 6), biomeAt(SEED, 5 * CHUNK_PX + CHUNK_PX / 2, 6 * CHUNK_PX + CHUNK_PX / 2));
});

test('tipos de recurso são todos alcançáveis', () => {
  const seen = new Set();
  for (let cx = 0; cx < 40; cx += 2) {
    for (let cy = 0; cy < 40; cy += 2) {
      for (const n of generateChunkNodes(SEED, cx, cy)) seen.add(n.kind);
    }
  }
  assert.ok(seen.has(RESOURCE.LEAF) && seen.has(RESOURCE.WATER) && seen.has(RESOURCE.MATERIAL));
  assert.ok(seen.has(RESOURCE.SEED) || seen.has(RESOURCE.FRUIT));
  assert.equal(TILE, 32);
});
