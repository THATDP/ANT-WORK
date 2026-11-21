/**
 * Renderização do terreno por chunk.
 *
 * O solo é determinístico (mesma semente = mesmo mundo), então o cliente desenha
 * os chunks localmente e nunca recebe tiles pela rede. Cada chunk vira uma
 * RenderTexture em cache, com decoração assada dentro — barato de desenhar e
 * fácil de descartar quando sai da tela.
 */

import { CHUNK_PX, CHUNK_TILES, TILE, BIOME, BIOME_INFO } from '@shared/constants.js';
import { biomeAt, generateDecor, tileShade } from '@shared/worldgen.js';
import { hash2 } from '@shared/util-noise.js';

const CACHE_LIMIT = 56;

function colorToInt(hex, mul = 1) {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * mul));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * mul));
  const b = Math.min(255, Math.round((hex & 255) * mul));
  return (r << 16) | (g << 8) | b;
}

export class TerrainRenderer {
  constructor(scene, seed) {
    this.scene = scene;
    this.seed = seed;
    this.chunks = new Map();
    this.queue = [];
    this.queued = new Set();
    this.lastDispose = 0;
  }

  key(cx, cy) { return `${cx},${cy}`; }

  has(cx, cy) { return this.chunks.has(this.key(cx, cy)); }

  /** Agenda a geração de um chunk sem travar o frame. */
  request(cx, cy, urgent = false) {
    const k = this.key(cx, cy);
    if (this.chunks.has(k) || this.queued.has(k)) {
      const hit = this.chunks.get(k);
      if (hit) hit.lastUsed = this.scene.time.now;
      return;
    }
    this.queued.add(k);
    // chunks sob a câmera entram na frente da fila (orçamento por frame)
    if (urgent) this.queue.unshift({ cx, cy });
    else this.queue.push({ cx, cy });
  }

  /** Processa no máximo `budget` chunks por frame. */
  update(budget = 2) {
    let built = 0;
    while (this.queue.length && built < budget) {
      const { cx, cy } = this.queue.shift();
      this.queued.delete(this.key(cx, cy));
      if (!this.chunks.has(this.key(cx, cy))) this.build(cx, cy);
      built++;
    }
  }

  build(cx, cy) {
    const scene = this.scene;
    const key = this.key(cx, cy);
    const originX = cx * CHUNK_PX;
    const originY = cy * CHUNK_PX;
    const rt = scene.add.renderTexture(originX, originY, CHUNK_PX, CHUNK_PX).setOrigin(0, 0);
    rt.setDepth(-100);

    const g = scene.make.graphics({ add: false });
    // ---------------------------------------------------------- tiles
    for (let gy = 0; gy < CHUNK_TILES; gy++) {
      for (let gx = 0; gx < CHUNK_TILES; gx++) {
        const wx = originX + gx * TILE + TILE / 2;
        const wy = originY + gy * TILE + TILE / 2;
        const b = biomeAt(this.seed, wx, wy);
        const info = BIOME_INFO[b] ?? BIOME_INFO[0];
        const shade = tileShade(this.seed, wx, wy);
        const jitter = hash2(gx + cx * 31, gy + cy * 17, this.seed + 3) * 0.08 - 0.04;
        let color = colorToInt(info.color, Math.max(0.7, Math.min(1.25, shade + jitter)));
        if (b === BIOME.WATER) color = colorToInt(info.color, 0.85 + Math.sin(wx * 0.02 + wy * 0.017) * 0.08);
        g.fillStyle(color, 1);
        g.fillRect(gx * TILE, gy * TILE, TILE + 1, TILE + 1);
      }
    }

    // ---------------------------------------------------------- detalhes do solo
    for (let gy = 0; gy < CHUNK_TILES; gy++) {
      for (let gx = 0; gx < CHUNK_TILES; gx++) {
        const wx = originX + gx * TILE + TILE / 2;
        const wy = originY + gy * TILE + TILE / 2;
        const b = biomeAt(this.seed, wx, wy);
        if (b === BIOME.WATER) {
          // ondulações
          const ph = (wx * 0.05 + wy * 0.03) % 1;
          g.lineStyle(1.4, 0x7fc4e8, 0.18 + Math.sin(wx * 0.01 + wy * 0.013) * 0.08);
          g.beginPath();
          g.moveTo(gx * TILE + 5, gy * TILE + 10 + ph * 4);
          g.lineTo(gx * TILE + 18, gy * TILE + 10 + ph * 4);
          g.strokePath();
          g.beginPath();
          g.moveTo(gx * TILE + 12, gy * TILE + 22 + ph * 3);
          g.lineTo(gx * TILE + 27, gy * TILE + 22 + ph * 3);
          g.strokePath();
        } else if (b === BIOME.ROCK) {
          if ((gx + gy) % 3 === 0) {
            g.lineStyle(1, 0x2f2c28, 0.5);
            g.beginPath();
            g.moveTo(gx * TILE + 4, gy * TILE + 8);
            g.lineTo(gx * TILE + 14, gy * TILE + 12);
            g.lineTo(gx * TILE + 9, gy * TILE + 24);
            g.strokePath();
          }
        } else if (b === BIOME.CONTAMINATED) {
          g.fillStyle(0x8a4fb0, 0.08);
          g.fillCircle(gx * TILE + 16, gy * TILE + 16, 9);
        }
      }
    }

    // ---------------------------------------------------------- decoração
    const decor = generateDecor(this.seed, cx, cy);
    for (const d of decor) {
      this.drawDecor(g, d, originX, originY);
    }

    rt.draw(g);
    g.destroy();

    this.chunks.set(key, { rt, cx, cy, lastUsed: scene.time.now });
    if (this.chunks.size > CACHE_LIMIT) this.disposeFar(scene.cameras.main);
    return rt;
  }

  drawDecor(g, d, originX, originY) {
    const x = d.x - originX;
    const y = d.y - originY;
    const s = d.s;
    switch (d.kind) {
      case 'grass': {
        const c = Math.random() < 0.5 ? 0x4f7a35 : 0x5d8a3c;
        g.lineStyle(1.6, c, 0.75);
        for (let i = -1; i <= 1; i++) {
          g.beginPath();
          g.moveTo(x + i * 2.4 * s, y + 3 * s);
          g.lineTo(x + i * 4 * s + Math.sin(d.a + i) * 3, y - 7 * s);
          g.strokePath();
        }
        break;
      }
      case 'flower': {
        g.lineStyle(1.2, 0x4a7532, 0.9);
        g.beginPath(); g.moveTo(x, y + 4); g.lineTo(x, y - 4); g.strokePath();
        const cols = [0xf0d28a, 0xe89bb4, 0xdcd6f0, 0xf3b26b];
        g.fillStyle(cols[Math.floor(d.a * 4) % cols.length], 0.9);
        g.fillCircle(x, y - 5 * s, 2.1 * s);
        g.fillStyle(0xfff6d8, 0.9);
        g.fillCircle(x, y - 5 * s, 0.9 * s);
        break;
      }
      case 'rock': {
        g.fillStyle(0x6a6459, 0.95);
        g.fillCircle(x, y, 4.4 * s);
        g.fillStyle(0x878076, 0.9);
        g.fillCircle(x - 1.2 * s, y - 1.4 * s, 2.6 * s);
        break;
      }
      case 'pebble': {
        g.fillStyle(0x7d766a, 0.8);
        g.fillCircle(x, y, 2 * s);
        g.fillStyle(0x9b948a, 0.7);
        g.fillCircle(x - 0.6, y - 0.7, 1.1 * s);
        break;
      }
      case 'mushroom': {
        g.fillStyle(0xe4dcc6, 0.85);
        g.fillRect(x - 0.9 * s, y - 1, 1.8 * s, 4.4 * s);
        g.fillStyle(Math.random() < 0.5 ? 0xc4654a : 0xb08a4a, 0.95);
        g.fillEllipse(x, y - 1.4 * s, 7 * s, 4 * s);
        break;
      }
      case 'reed': {
        g.lineStyle(1.5, 0x7f9a55, 0.85);
        for (let i = -1; i <= 1; i++) {
          g.beginPath();
          g.moveTo(x + i * 2, y + 5);
          g.lineTo(x + i * 3 + Math.sin(d.a) * 2, y - 9 * s);
          g.strokePath();
        }
        break;
      }
      case 'puddle': {
        g.fillStyle(0x3f7fa0, 0.55);
        g.fillEllipse(x, y, 10 * s, 5.4 * s);
        g.lineStyle(1, 0x8fd0ea, 0.35);
        g.strokeEllipse(x, y, 8 * s, 4 * s);
        break;
      }
      case 'spore': {
        g.fillStyle(0xb46ae0, 0.22);
        g.fillCircle(x, y, 6 * s);
        g.fillStyle(0xd9a6f5, 0.8);
        g.fillCircle(x, y, 1.7 * s);
        break;
      }
      case 'leafp': {
        g.fillStyle(0x7a6a4a, 0.65);
        g.fillEllipse(x, y, 6 * s, 3 * s);
        g.lineStyle(0.8, 0x5a4a30, 0.6);
        g.beginPath(); g.moveTo(x - 3 * s, y); g.lineTo(x + 3 * s, y); g.strokePath();
        break;
      }
      default: break;
    }
  }

  disposeFar(camera) {
    const now = this.scene.time.now;
    if (now - this.lastDispose < 500) return;
    this.lastDispose = now;
    if (this.chunks.size <= CACHE_LIMIT) return;
    const view = camera.worldView;
    const pad = 900;
    const entries = [...this.chunks.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [k, c] of entries) {
      if (this.chunks.size <= CACHE_LIMIT) break;
      const cx0 = c.cx * CHUNK_PX;
      const cy0 = c.cy * CHUNK_PX;
      const outside = cx0 + CHUNK_PX < view.x - pad || cx0 > view.right + pad ||
        cy0 + CHUNK_PX < view.y - pad || cy0 > view.bottom + pad;
      if (outside) {
        c.rt.destroy();
        this.chunks.delete(k);
      }
    }
  }

  ensureVisible(camera, urgentRadius = 0) {
    const view = camera.worldView;
    const buffer = 1;
    const x0 = Math.floor(view.x / CHUNK_PX) - buffer;
    const y0 = Math.floor(view.y / CHUNK_PX) - buffer;
    const x1 = Math.floor(view.right / CHUNK_PX) + buffer;
    const y1 = Math.floor(view.bottom / CHUNK_PX) + buffer;
    const urgentSet = new Set();
    if (urgentRadius > 0) {
      const px = Math.floor((view.centerX) / CHUNK_PX);
      const py = Math.floor((view.centerY) / CHUNK_PX);
      for (let dy = -urgentRadius; dy <= urgentRadius; dy++) {
        for (let dx = -urgentRadius; dx <= urgentRadius; dx++) urgentSet.add(`${px + dx},${py + dy}`);
      }
    }
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (cx < 0 || cy < 0 || cx >= 48 || cy >= 48) continue;
        const k = this.key(cx, cy);
        if (this.chunks.has(k)) {
          this.chunks.get(k).lastUsed = this.scene.time.now;
          continue;
        }
        // fundo imediato se o chunk está sob a câmera, senão entra na fila
        const inView = cx * CHUNK_PX + CHUNK_PX > view.x && cx * CHUNK_PX < view.right &&
          cy * CHUNK_PX + CHUNK_PX > view.y && cy * CHUNK_PX < view.bottom;
        this.request(cx, cy, inView || urgentSet.has(k));
      }
    }
    this.disposeFar(camera);
  }

  destroy() {
    for (const c of this.chunks.values()) c.rt.destroy();
    this.chunks.clear();
    this.queue.length = 0;
    this.queued.clear();
  }
}
