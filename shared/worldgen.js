/**
 * Geração procedural determinística do mundo ANT LIFE.
 *
 * Vive em shared/ porque o terreno é DETERMINÍSTICO: cliente e servidor chegam
 * ao mesmo resultado a partir da semente. Assim a rede não precisa transmitir
 * tiles — só o que muda (nós de recurso coletados, construções, criaturas).
 *
 * Escala:
 *  1 tile = 32 px · 1 chunk = 24×24 tiles = 768 px · mundo = 48×48 chunks
 */

import { BIOME, TILE, CHUNK_PX, WORLD_PX, RESOURCE } from './constants.js';
import { fbm2, hash2, hash3, ridge2, value2 } from './util-noise.js';

export const SEED_MIX = {
  elevation: 1013,
  moisture: 2027,
  contam: 3041,
  caves: 4057,
  detail: 5081,
  nodes: 6091,
  decor: 7103,
  regions: 8117,
};

/** Altitude macro do mundo em [0,1]. */
export function elevationAt(seed, x, y) {
  const big = fbm2(x * 0.000045, y * 0.000045, seed + SEED_MIX.elevation, 4);
  const ridge = ridge2(x * 0.00009, y * 0.00009, seed + SEED_MIX.elevation + 5, 4);
  return Math.min(1, Math.max(0, big * 0.68 + ridge * 0.42 - 0.05));
}

export function moistureAt(seed, x, y) {
  return fbm2(x * 0.00011, y * 0.00011, seed + SEED_MIX.moisture, 4);
}

export function contaminationAt(seed, x, y) {
  return fbm2(x * 0.00007, y * 0.00007, seed + SEED_MIX.contam, 3);
}

/** Rede de rios: retorna distância normalizada (0 = centro do rio). */
export function riverDistance(seed, x, y) {
  const warp = fbm2(x * 0.0006, y * 0.0006, seed + 31, 3) - 0.5;
  const px = x / WORLD_PX;
  const center =
    0.5 +
    Math.sin(px * 9.4 + warp * 2.4) * 0.22 +
    (fbm2(x * 0.00028, y * 0.00028, seed + 77, 2) - 0.5) * 0.16;
  const py = y / WORLD_PX;
  return Math.abs(py - center);
}

export function isWater(seed, x, y) {
  const e = elevationAt(seed, x, y);
  const river = riverDistance(seed, x, y);
  if (e < 0.17) return true;                 // lagos e depressões
  if (river < 0.012 && e < 0.62) return true; // leitos de rio
  return false;
}

/** Bioma em coordenadas de mundo (px). */
export function biomeAt(seed, x, y) {
  const e = elevationAt(seed, x, y);
  const m = moistureAt(seed, x, y);
  const c = contaminationAt(seed, x, y);
  const river = riverDistance(seed, x, y);

  if (e < 0.17 || (river < 0.012 && e < 0.62)) return BIOME.WATER;
  if (c > 0.79 && e > 0.30) return BIOME.CONTAMINATED;
  if (e < 0.30 && m > 0.56) return BIOME.WET;
  if (e > 0.66) return BIOME.ROCK;
  if (e > 0.52 && m < 0.42) return BIOME.FIELD;
  if (m > 0.62) return BIOME.FOREST;
  if (m > 0.48) return BIOME.GARDEN;
  return BIOME.FIELD;
}

/** Cavidades subterrâneas (bons locais para câmaras). Não afetam a superfície. */
export function caveAt(seed, x, y) {
  const n = fbm2(x * 0.0016, y * 0.00075, seed + SEED_MIX.caves, 3);
  const worm = 1 - Math.abs(value2(x * 0.0011, y * 0.0011, seed + SEED_MIX.caves + 9) * 2 - 1);
  return Math.max(0, n * 0.7 + worm * 0.5 - 0.52) * 2.4; // 0..~1
}

/** Semente estável por região (chunk), usada para spawns locais. */
export function chunkSeed(seed, cx, cy) {
  return (Math.imul(cx + 1, 73856093) ^ Math.imul(cy + 1, 19349663) ^ seed) >>> 0;
}

/** Tipo de bioma dominante de um chunk (para nome de setor e mapa). */
export function chunkBiome(seed, cx, cy) {
  const cxp = cx * CHUNK_PX + CHUNK_PX / 2;
  const cyp = cy * CHUNK_PX + CHUNK_PX / 2;
  return biomeAt(seed, cxp, cyp);
}

const SECTOR_WORDS = [
  ['Folha', 'Musgo', 'Orvalho', 'Casca', 'Raiz', 'Sombra', 'Néctar', 'Cedro', 'Samambaia', 'Líquen'],
  ['Pedra', 'Sílice', 'Gnaisse', 'Basalto', 'Seixo', 'Areia'],
  ['Lama', 'Junco', 'Turfa', 'Alga', 'Vapor'],
  ['Ninho', 'Trilha', 'Câmara', 'Toca', 'Refúgio'],
];

/** Nome poético e determinístico para um setor do mapa. */
export function sectorName(seed, cx, cy) {
  const b = chunkBiome(seed, cx, cy);
  const group = b === BIOME.ROCK ? 1 : b === BIOME.WET || b === BIOME.WATER ? 2 : b === BIOME.CONTAMINATED ? 3 : 0;
  const words = SECTOR_WORDS[group];
  const w = words[Math.floor(hash2(cx, cy, seed + 991) * words.length)];
  const n = 1 + Math.floor(hash2(cy, cx, seed + 313) * 98);
  return `${w} ${n}`;
}

// ------------------------------------------------------------ recursos
const RESOURCE_TABLE = {
  [BIOME.FOREST]:      [[RESOURCE.LEAF, 46], [RESOURCE.SEED, 12], [RESOURCE.FRUIT, 14], [RESOURCE.MATERIAL, 18], [RESOURCE.SPORE, 2]],
  [BIOME.GARDEN]:      [[RESOURCE.LEAF, 34], [RESOURCE.SEED, 24], [RESOURCE.FRUIT, 22], [RESOURCE.MATERIAL, 8], [RESOURCE.SPORE, 2]],
  [BIOME.FIELD]:       [[RESOURCE.SEED, 44], [RESOURCE.LEAF, 16], [RESOURCE.INSECT, 18], [RESOURCE.MATERIAL, 12], [RESOURCE.FRUIT, 6]],
  [BIOME.ROCK]:        [[RESOURCE.MATERIAL, 55], [RESOURCE.SEED, 8], [RESOURCE.SPORE, 6], [RESOURCE.INSECT, 8]],
  [BIOME.WET]:         [[RESOURCE.WATER, 40], [RESOURCE.INSECT, 22], [RESOURCE.LEAF, 18], [RESOURCE.MATERIAL, 8], [RESOURCE.FRUIT, 6]],
  [BIOME.WATER]:       [[RESOURCE.WATER, 80], [RESOURCE.INSECT, 8]],
  [BIOME.CONTAMINATED]:[[RESOURCE.SPORE, 40], [RESOURCE.INSECT, 18], [RESOURCE.MATERIAL, 18], [RESOURCE.WATER, 10]],
  [BIOME.UNDERGROUND]: [[RESOURCE.MATERIAL, 40], [RESOURCE.SPORE, 22], [RESOURCE.WATER, 20], [RESOURCE.INSECT, 10]],
};

function pickWeighted(table, r) {
  let total = 0;
  for (const [, w] of table) total += w;
  let acc = r * total;
  for (const [kind, w] of table) {
    acc -= w;
    if (acc <= 0) return kind;
  }
  return table[table.length - 1][0];
}

/** Densidade de nós de recurso por bioma (nós por chunk). */
const DENSITY = {
  [BIOME.FOREST]: 9, [BIOME.GARDEN]: 8, [BIOME.FIELD]: 7, [BIOME.ROCK]: 6,
  [BIOME.WET]: 7, [BIOME.WATER]: 4, [BIOME.CONTAMINATED]: 6, [BIOME.UNDERGROUND]: 5,
};

/**
 * Gera os nós de recurso de um chunk de forma determinística.
 * O servidor guarda apenas as diferenças (quantidade restante / esgotado).
 * @returns {Array<{id:number, x:number, y:number, kind:number, max:number, amount:number}>}
 */
export function generateChunkNodes(seed, cx, cy) {
  const cs = chunkSeed(seed, cx, cy);
  const nodes = [];
  const count = 14 + Math.floor(hash2(cx, cy, seed + SEED_MIX.nodes) * 10);
  for (let i = 0; i < count; i++) {
    const rx = hash3(cx, cy, i * 2 + 1, seed + 11);
    const ry = hash3(cx, cy, i * 2 + 2, seed + 23);
    const x = cx * CHUNK_PX + (0.08 + rx * 0.84) * CHUNK_PX;
    const y = cy * CHUNK_PX + (0.08 + ry * 0.84) * CHUNK_PX;
    const b = biomeAt(seed, x, y);
    const table = RESOURCE_TABLE[b] || RESOURCE_TABLE[BIOME.GARDEN];
    const kind = pickWeighted(table, hash3(cx, cy, i + 97, seed + 5));
    const coastal = b === BIOME.WATER;
    const max = Math.round(
      (kind === RESOURCE.WATER ? 220 : kind === RESOURCE.SPORE ? 40 : 90) *
      (0.7 + hash3(cx, cy, i + 41, cs) * 0.8)
    );
    nodes.push({
      id: nodeId(cx, cy, i),
      x, y, kind, max, amount: max,
      respawnAt: 0,
      chunk: `${cx},${cy}`,
      coastal,
    });
  }
  return nodes;
}

export function nodeId(cx, cy, i) {
  // cx,cy < 1000 e i < 1000 → id único e legível
  return cx * 1_000_000 + cy * 1_000 + i;
}

export function decomposeNodeId(id) {
  return { cx: Math.floor(id / 1_000_000), cy: Math.floor((id % 1_000_000) / 1_000), i: id % 1_000 };
}

/** Decoração puramente visual (cliente), determinística. */
export function generateDecor(seed, cx, cy) {
  const out = [];
  const count = 46;
  for (let i = 0; i < count; i++) {
    const x = cx * CHUNK_PX + hash3(cx, cy, i * 3 + 1, seed + SEED_MIX.decor) * CHUNK_PX;
    const y = cy * CHUNK_PX + hash3(cx, cy, i * 3 + 2, seed + SEED_MIX.decor) * CHUNK_PX;
    const b = biomeAt(seed, x, y);
    if (b === BIOME.WATER && hash3(cx, cy, i * 3 + 3, seed + 7) > 0.35) continue;
    const r = hash3(cx, cy, i * 3 + 3, seed + SEED_MIX.decor + 1);
    let kind;
    if (b === BIOME.FOREST) kind = r < 0.42 ? 'grass' : r < 0.68 ? 'leafp' : r < 0.84 ? 'rock' : 'mushroom';
    else if (b === BIOME.GARDEN) kind = r < 0.5 ? 'grass' : r < 0.78 ? 'flower' : 'leafp';
    else if (b === BIOME.FIELD) kind = r < 0.62 ? 'grass' : r < 0.86 ? 'flower' : 'rock';
    else if (b === BIOME.ROCK) kind = r < 0.55 ? 'rock' : r < 0.8 ? 'pebble' : 'grass';
    else if (b === BIOME.WET) kind = r < 0.45 ? 'reed' : r < 0.75 ? 'puddle' : 'mushroom';
    else if (b === BIOME.CONTAMINATED) kind = r < 0.5 ? 'spore' : r < 0.8 ? 'mushroom' : 'rock';
    else kind = r < 0.6 ? 'reed' : 'puddle';
    out.push({
      x, y, kind,
      s: 0.65 + hash3(cx, cy, i * 3 + 4, seed + 3) * 0.85,
      a: hash3(cx, cy, i * 3 + 5, seed + 9) * Math.PI * 2,
    });
  }
  return out;
}

/** Cor média de um tile (usada no minimapa e no terreno). */
export function tileShade(seed, x, y) {
  const e = elevationAt(seed, x, y);
  const d = fbm2(x * 0.004, y * 0.004, seed + SEED_MIX.detail, 2);
  return 0.78 + d * 0.44 + (e - 0.5) * 0.18;
}

/** Encontra um local de nidificação válido perto de (x,y), de forma determinística. */
export function findNestSite(seed, x, y, maxRadius = 6 * CHUNK_PX) {
  const step = TILE * 2;
  for (let r = 0; r <= maxRadius; r += step) {
    const samples = r === 0 ? 1 : Math.max(8, Math.floor((2 * Math.PI * r) / step));
    for (let s = 0; s < samples; s++) {
      const a = (s / samples) * Math.PI * 2 + r * 0.001;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (px < CHUNK_PX || py < CHUNK_PX || px > WORLD_PX - CHUNK_PX || py > WORLD_PX - CHUNK_PX) continue;
      if (isWater(seed, px, py)) continue;
      const b = biomeAt(seed, px, py);
      if (b === BIOME.ROCK || b === BIOME.CONTAMINATED) continue;
      return { x: px, y: py, biome: b };
    }
  }
  return { x, y, biome: biomeAt(seed, x, y) };
}

export const CHUNK_STRIDE = 1; // reservado para futuras versões com LOD de terreno
