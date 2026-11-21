/**
 * Mapa de biomas em baixa resolução. É construído progressivamente (algumas
 * linhas por frame) a partir da mesma função procedural do servidor, e serve
 * para o minimapa e para o mapa grande.
 */

import { WORLD_PX, BIOME_INFO } from '@shared/constants.js';
import { biomeAt } from '@shared/worldgen.js';

export class BiomeMap {
  constructor(seed, size = 192) {
    this.seed = seed;
    this.size = size;
    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    this.ctx = this.canvas.getContext('2d');
    this.row = 0;
    this.done = false;
    this.ctx.fillStyle = '#0d110c';
    this.ctx.fillRect(0, 0, size, size);
    this.image = this.ctx.createImageData(size, size);
    this.px = this.image.data;
    this.base = this.ctx.createImageData(1, 1).data;
  }

  get progress() { return this.row / this.size; }

  /** Avança a geração; chamado no update do menu/loading. */
  tick(rowsPerFrame = 6) {
    if (this.done) return true;
    const { size, seed } = this;
    const step = WORLD_PX / size;
    for (let n = 0; n < rowsPerFrame && this.row < size; n++, this.row++) {
      for (let x = 0; x < size; x++) {
        const wx = x * step + step / 2;
        const wy = this.row * step + step / 2;
        const b = biomeAt(seed, wx, wy);
        const info = BIOME_INFO[b] ?? BIOME_INFO[0];
        const i = (this.row * size + x) * 4;
        // leve variação para o mapa não ficar chapado
        const v = 1 + Math.sin(wx * 0.0007 + wy * 0.0011) * 0.08;
        this.px[i] = Math.min(255, ((info.color >> 16) & 255) * v);
        this.px[i + 1] = Math.min(255, ((info.color >> 8) & 255) * v);
        this.px[i + 2] = Math.min(255, (info.color & 255) * v);
        this.px[i + 3] = 255;
      }
    }
    if (this.row >= size) {
      this.ctx.putImageData(this.image, 0, 0);
      this.done = true;
    }
    return this.done;
  }

  toWorld(px, py) {
    return { x: px / this.size * WORLD_PX, y: py / this.size * WORLD_PX };
  }

  toMap(x, y) {
    return { x: x / WORLD_PX * this.size, y: y / WORLD_PX * this.size };
  }
}
