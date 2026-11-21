export function antDistance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

export function angleTo(ax, ay, bx, by) {
  return Math.atan2(by - ay, bx - ax);
}

/** Distância ao segmento (usado para predador que guarda trilha). */
export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function weightedPick(entries, rnd = Math.random) {
  let total = 0;
  for (const [, w] of entries) total += w;
  let r = rnd() * total;
  for (const [k, w] of entries) { r -= w; if (r <= 0) return k; }
  return entries.length ? entries[entries.length - 1][0] : null;
}

/** Evita consultas repetidas ao mesmo conjunto no mesmo tick. */
export class TTLMap {
  constructor(ttl) { this.ttl = ttl; this.map = new Map(); }
  get(key, factory, now = Date.now()) {
    const hit = this.map.get(key);
    if (hit && hit.exp > now) return hit.val;
    const val = factory();
    this.map.set(key, { val, exp: now + this.ttl });
    if (this.map.size > 512) {
      for (const [k, v] of this.map) if (v.exp <= now) this.map.delete(k);
    }
    return val;
  }
}
