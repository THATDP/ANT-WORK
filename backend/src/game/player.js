/**
 * Jogador (formiga controlada por humano). O servidor guarda posição, vida,
 * carga e fome; o cliente só envia intenção. Nada aqui confia no cliente.
 */

import { clamp, COLONY_COLORS } from '../../../shared/constants.js';

let playerSeq = 1;

export class Player {
  constructor({ sessionId, name, colonyId = null, x, y, color }) {
    this.id = `p${playerSeq++}`;
    this._kind = 'player';
    this.sessionId = sessionId;
    this.name = name;
    this.colonyId = colonyId;
    this.x = x; this.y = y;
    this.dir = 0;
    this.vx = 0; this.vy = 0;
    this.maxHp = 70;
    this.hp = 70;
    this.alive = true;
    this.respawnAt = 0;
    this.carrying = { kind: -1, amount: 0 };
    this.carryCap = 8;
    this.hunger = 0;
    this.thirst = 0;
    this.speed = 78;
    this.color = color ?? COLONY_COLORS[0];
    this.lastAction = 0;
    this.actionLock = 0;
    this.gathering = null;   // { nodeId, until }
    this.joinedAt = Date.now();
    this.stats = { gathered: 0, built: 0, deaths: 0, kills: 0, playtime: 0 };
  }

  get carryingTotal() { return this.carrying.amount; }

  isBusy(now) { return this.actionLock > now; }

  lockAction(now, ms) { this.actionLock = now + ms; }
}

export function resetPlayerSeq(v = 1) { playerSeq = v; }
export { Player as default };
