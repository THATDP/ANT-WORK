/**
 * Protocolo compacto do ANT LIFE.
 *
 * Regra de ouro: o cliente NUNCA decide estado autoritativo. Ele envia apenas
 * intenção (vetor de movimento, tecla de ação, alvo). O servidor responde com
 * snapshots de área de interesse.
 *
 * Formato dos snapshots (arrays posicionais, para reduzir bytes):
 *   ant: [id, x, y, role, task, hp, state, carryKind, carryAmt, flags]
 *   predador: [id, x, y, kind, hp, state]
 *   jogador: [id, x, y, name, colonyId, role, hp, carrying]
 *   estrutura: [id, cx, cy, gx, gy, type, ownerColonyId, hp, progress]
 *   nodo: [id, x, y, kind, amount]
 */

import { QUANT, q } from './constants.js';

export function packEntity(e) {
  return [
    e.id,
    q(e.x),
    q(e.y),
    e.role,
    e.task,
    Math.round(e.hp),
    e.state,
    e.carryKind ?? -1,
    e.carryAmt ? Math.round(e.carryAmt) : 0,
    e.flags ?? 0,
  ];
}

export function packPredator(p) {
  return [p.id, q(p.x), q(p.y), p.kind, Math.round(p.hp), p.state];
}

export function packPlayer(p) {
  return [p.id, q(p.x), q(p.y), p.name, p.colonyId ?? 0, p.role ?? 0, Math.round(p.hp), p.carryKind ?? -1];
}

export function packStructure(s) {
  return [s.id, s.cx, s.cy, s.gx, s.gy, s.type, s.colonyId, Math.round(s.hp), Math.round(s.progress ?? 100)];
}

export function packNode(n) {
  return [n.id, q(n.x), q(n.y), n.kind, Math.round(n.amount)];
}

export function unpackEntity(a) {
  return {
    id: a[0], x: a[1], y: a[2], role: a[3], task: a[4], hp: a[5],
    state: a[6], carryKind: a[7], carryAmt: a[8], flags: a[9],
  };
}

/** Verifica se um vetor de input é plausível (anti-cheat básico). */
export function sanitizeInput(msg) {
  if (!msg || typeof msg !== 'object') return null;
  let { vx = 0, vy = 0 } = msg;
  if (typeof vx !== 'number' || typeof vy !== 'number' || !Number.isFinite(vx) || !Number.isFinite(vy)) {
    return { vx: 0, vy: 0 };
  }
  // nunca aceitar aceleração absurda
  const len = Math.hypot(vx, vy);
  if (len > 1e-6) {
    const m = Math.min(1, len);
    vx = (vx / len) * m;
    vy = (vy / len) * m;
  }
  return { vx, vy };
}

export function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20);
  return name.length >= 2 ? name : null;
}

export function sanitizeChat(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 160);
  return text.length ? text : null;
}

export const quant = (v) => Math.round(v / QUANT) * QUANT;

/** Hash determinístico de string → uint32 (para tokens de reconexão). */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
