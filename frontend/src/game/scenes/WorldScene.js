/**
 * Cena do mundo.
 *
 * - Desenha o terreno local (determinístico) e interpola as entidades recebidas
 *   por snapshots de área de interesse.
 * - Entrada do jogador é predita localmente e corrigida pelo servidor.
 * - Nada aqui decide estado autoritativo: coleta, construção, combate e estoque
 *   são validados no backend.
 */

import Phaser from 'phaser';
import {
  CHUNK_PX, TILE, BUILDING_INFO, ROLE_INFO, ROLE, RESOURCE_INFO, BIOME_INFO,
} from '@shared/constants.js';
import { biomeAt, isWater, sectorName } from '@shared/worldgen.js';
import { state, bus, RES_ICON } from '../../state.js';
import { net } from '../../net/client.js';
import { audio } from '../../audio.js';
import { hud } from '../../ui/hud.js';
import { TerrainRenderer } from '../render/terrain.js';
import { BiomeMap } from '../render/biomemap.js';

const ROLE_KEY = ['worker', 'scout', 'soldier', 'queen', 'larva'];
const TEX_SCALE = {
  beetle: 0.75, spider: 0.9, wasp: 0.8, termite: 0.72, lizard: 1.45, antlion: 1.05,
};
const PREDATOR_NAME = {
  beetle: 'besouro', spider: 'aranha', wasp: 'vespa', termite: 'cupim',
  lizard: 'lagarto', antlion: 'formiga-leão',
};

export class WorldScene extends Phaser.Scene {
  constructor() {
    super({ key: 'World' });
  }

  create() {
    this.seed = state.world.seed;
    this.ants = new Map();
    this.predators = new Map();
    this.otherPlayers = new Map();
    this.structures = new Map();
    this.nodeChunks = new Map();
    this.occupied = new Set();
    this.moveTarget = null;
    this.buildMode = null;
    this.ghost = null;
    this.ghostState = null;
    this.markers = [];
    this.floatTexts = [];
    this.interact = null;
    this.lastInteractCheck = 0;
    this.lastMinimap = 0;
    this.lastDataCheck = 0;
    this.keys = {};
    this.stepAccum = 0;
    this.deadSince = 0;

    this.biomeMap = new BiomeMap(this.seed, 192);
    this.terrain = new TerrainRenderer(this, this.seed);

    const spawn = state.self ? { x: state.self[0], y: state.self[1] } : (state.spawn ?? { x: state.world.sizePx / 2, y: state.world.sizePx / 2 });
    this.selfPos = { x: spawn.x, y: spawn.y };
    this.selfServer = { x: spawn.x, y: spawn.y };

    this.setupLayers();
    this.setupSelf();
    this.setupCamera();
    this.setupInput();
    this.setupWeather();
    // primeiro quadro: garante o terreno sob a câmera antes de desenhar
    this.terrain.ensureVisible(this.cameras.main, 1);
    this.terrain.update(4);

    bus.on('snap', (p) => this.applySnapshot(p));
    bus.on('state', () => this.refreshStructureColors());
    bus.on('env', (env) => this.applyEnv(env));
    bus.on('event', (e) => this.onWorldEvent(e));
    bus.on('notice', (n) => this.onNotice(n));
    bus.on('players', () => this.refreshPlayerLabels());
    bus.on('ui:build', (type) => this.enterBuildMode(type));
    bus.on('ui:overlay', ({ open }) => {
      if (open) { this.moveTarget = null; net.setInput(0, 0); }
    });
    bus.on('welcome', (w) => this.resetWorldView(w));
    bus.on('settings:zoom', (z) => this.setZoom(z));
    bus.on('settings:particles', (on) => this.rainEmitter?.setVisible?.(on));
    bus.on('settings:names', () => this.refreshPlayerLabels());
    bus.on('input:touch', (v) => { this.touchInput = v; });

    this.events.once('shutdown', () => this.teardown());
    this.events.once('destroy', () => this.teardown());

    this.zoomDefault = state.settings.zoom || 1;
    this.setZoom(state.settings.zoom || 1);
  }

  // ---------------------------------------------------------------- camadas
  setupLayers() {
    this.shadowG = this.add.graphics().setDepth(2);
    this.cargoG = this.add.graphics().setDepth(21);
    this.hpG = this.add.graphics().setDepth(22);
    this.buildG = this.add.graphics().setDepth(6);
    this.fxG = this.add.graphics().setDepth(40);
    this.nightOverlay = this.add.rectangle(0, 0, 10, 10, 0x081020, 0)
      .setOrigin(0).setScrollFactor(0).setDepth(30);
    this.lightGlow = this.add.image(0, 0, 'glow')
      .setScale(9).setTint(0xffcf8a).setAlpha(0).setBlendMode(Phaser.BlendModes.ADD).setDepth(3);
  }

  setupSelf() {
    this.selfSprite = this.add.image(this.selfPos.x, this.selfPos.y, 'ant_worker_0')
      .setScale(0.55).setDepth(20);
    this.selfRing = this.add.image(this.selfPos.x, this.selfPos.y, 'player-ring')
      .setScale(0.9).setDepth(4).setAlpha(0.85);
    this.cameras.main.startFollow(this.selfSprite, true, 0.12, 0.12);
  }

  setupCamera() {
    const cam = this.cameras.main;
    cam.setBounds(0, 0, state.world.sizePx, state.world.sizePx);
    cam.setBackgroundColor(0x0b100a);
    cam.roundPixels = false;
    this.input.on('wheel', (_p, _o, _dx, dy) => {
      const z = Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.88 : 1.14), 0.38, 2.6);
      cam.setZoom(z);
    });
    this.scale.on('resize', () => this.onResize());
    this.onResize();
  }

  onResize() {
    const w = this.scale.width;
    const h = this.scale.height;
    this.nightOverlay.setSize(w, h);
    if (this.rainEmitter) this.rainEmitter.setPosition(0, 0);
  }

  setZoom(z) {
    this.cameras.main.setZoom(Phaser.Math.Clamp(z, 0.38, 2.6));
  }

  // ---------------------------------------------------------------- input
  setupInput() {
    const kb = this.input.keyboard;
    const codes = {
      W: Phaser.Input.Keyboard.KeyCodes.W,
      A: Phaser.Input.Keyboard.KeyCodes.A,
      S: Phaser.Input.Keyboard.KeyCodes.S,
      D: Phaser.Input.Keyboard.KeyCodes.D,
      UP: Phaser.Input.Keyboard.KeyCodes.UP,
      DOWN: Phaser.Input.Keyboard.KeyCodes.DOWN,
      LEFT: Phaser.Input.Keyboard.KeyCodes.LEFT,
      RIGHT: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      E: Phaser.Input.Keyboard.KeyCodes.E,
      F: Phaser.Input.Keyboard.KeyCodes.F,
      R: Phaser.Input.Keyboard.KeyCodes.R,
      B: Phaser.Input.Keyboard.KeyCodes.B,
      M: Phaser.Input.Keyboard.KeyCodes.M,
      Q: Phaser.Input.Keyboard.KeyCodes.Q,
      SPACE: Phaser.Input.Keyboard.KeyCodes.SPACE,
      ENTER: Phaser.Input.Keyboard.KeyCodes.ENTER,
      TAB: Phaser.Input.Keyboard.KeyCodes.TAB,
      ESC: Phaser.Input.Keyboard.KeyCodes.ESC,
      K: Phaser.Input.Keyboard.KeyCodes.K,
    };
    for (const [name, code] of Object.entries(codes)) this.keys[name] = kb.addKey(code, false, false);
    kb.addCapture(Object.values(codes));

    this.input.mouse?.disableContextMenu();
    this.input.on('pointerdown', (pointer) => this.onPointerDown(pointer));
    this.input.on('pointermove', (pointer) => this.onPointerMove(pointer));

    // ações por botões da HUD
    for (const btn of document.querySelectorAll('.action, .touch-btn')) {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const action = btn.dataset.action;
        this.triggerAction(action);
      });
    }
  }

  triggerAction(action) {
    if (action === 'gather') this.doGather();
    else if (action === 'deposit') this.doDeposit();
    else if (action === 'eat') this.doEat();
    else if (action === 'attack') this.doAttack();
    else if (action === 'build') this.openBuildMenu();
    else if (action === 'map') bus.emit('ui:open', 'map');
  }

  openBuildMenu() {
    if (!state.colony) { hud.toast('Entre em uma colônia para construir', 'error'); return; }
    if (document.activeElement?.tagName === 'INPUT') return;
    bus.emit('ui:open', 'building');
  }

  readingInput() {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  }

  handleKeys(time, delta) {
    if (this.readingInput()) { net.setInput(0, 0); return; }
    const k = this.keys;
    let x = 0, y = 0;
    const touch = this.touchInput;
    if (k.A.isDown || k.LEFT.isDown) x -= 1;
    if (k.D.isDown || k.RIGHT.isDown) x += 1;
    if (k.W.isDown || k.UP.isDown) y -= 1;
    if (k.S.isDown || k.DOWN.isDown) y += 1;
    if (x || y) {
      this.moveTarget = null;
      const l = Math.hypot(x, y);
      net.setInput(x / l, y / l);
    } else if (touch && (touch.x || touch.y)) {
      this.moveTarget = null;
      const l = Math.hypot(touch.x, touch.y) || 1;
      net.setInput(touch.x / l, touch.y / l);
    } else if (this.moveTarget) {
      const dx = this.moveTarget.x - this.selfPos.x;
      const dy = this.moveTarget.y - this.selfPos.y;
      const d = Math.hypot(dx, dy);
      if (d > 24) net.setInput(dx / d, dy / d);
      else { this.moveTarget = null; net.setInput(0, 0); }
    } else {
      net.setInput(0, 0);
    }

    if (Phaser.Input.Keyboard.JustDown(k.E)) { this.doGather(); this.eHeld = true; this.lastE = time; }
    if (k.E.isDown && this.eHeld && time - (this.lastE || 0) > 450) { this.lastE = time; this.doGather(true); }
    if (k.E.isUp) this.eHeld = false;
    if (Phaser.Input.Keyboard.JustDown(k.F)) this.doDeposit();
    if (Phaser.Input.Keyboard.JustDown(k.R)) this.doEat();
    if (Phaser.Input.Keyboard.JustDown(k.SPACE)) this.doAttack();
    if (Phaser.Input.Keyboard.JustDown(k.B)) this.buildMode ? this.cancelBuild() : this.openBuildMenu();
    if (Phaser.Input.Keyboard.JustDown(k.M)) bus.emit('ui:open', 'map');
    if (Phaser.Input.Keyboard.JustDown(k.ENTER)) bus.emit('ui:open-chat');
    if (Phaser.Input.Keyboard.JustDown(k.TAB)) { bus.emit('ui:open', 'players'); }
    if (Phaser.Input.Keyboard.JustDown(k.ESC)) {
      if (this.buildMode) this.cancelBuild();
      else if (this.interact) bus.emit('ui:open', 'settings');
    }
    if (Phaser.Input.Keyboard.JustDown(k.Q)) this.doQuickDepositAll();
    if (Phaser.Input.Keyboard.JustDown(k.K)) bus.emit('ui:open', 'colony');
  }

  onPointerDown(pointer) {
    if (this.readingInput()) return;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);

    if (this.buildMode) {
      if (pointer.rightButtonDown() || pointer.button === 2) { this.cancelBuild(); return; }
      this.placeStructure(world.x, world.y);
      return;
    }
    if (pointer.rightButtonDown() || pointer.button === 2) { this.moveTarget = null; return; }

    const target = this.findInteractableAt(world.x, world.y);
    if (target) {
      this.interact = target;
      if (target.kind === 'node') { this.pendingGather = target; this.doGather(); return; }
      if (target.kind === 'structure') { net.act({ type: 'work', id: target.id }); return; }
      if (target.kind === 'predator') { net.act({ type: 'attack', kind: 'predator', id: target.id }); return; }
    }
    this.moveTarget = { x: world.x, y: world.y };
    this.spawnMarker(world.x, world.y, 0xe9a85b);
  }

  onPointerMove(pointer) {
    if (!this.buildMode) return;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.updateGhost(world.x, world.y);
  }

  // ---------------------------------------------------------------- ações
  findInteractableAt(wx, wy, radius = 54) {
    let best = null, bestD = radius * radius;
    for (const [, chunkMap] of this.nodeChunks) {
      for (const [, v] of chunkMap) {
        const d = (v.x - wx) ** 2 + (v.y - wy) ** 2;
        if (d < bestD) { bestD = d; best = { kind: 'node', id: v.id, x: v.x, y: v.y, data: v }; }
      }
    }
    for (const [, s] of this.structures) {
      const d = (s.x - wx) ** 2 + (s.y - wy) ** 2;
      const r2 = (s.radius ?? 40) + radius;
      if (d < r2 * r2 && d < bestD) { bestD = d; best = { kind: 'structure', id: s.id, x: s.x, y: s.y, data: s }; }
    }
    for (const [, p] of this.predators) {
      const d = (p.x - wx) ** 2 + (p.y - wy) ** 2;
      if (d < bestD) { bestD = d; best = { kind: 'predator', id: p.id, x: p.x, y: p.y, data: p }; }
    }
    return best;
  }

  nearestNode(maxDist = 64) {
    const sx = this.selfPos.x, sy = this.selfPos.y;
    let best = null, bestD = maxDist * maxDist;
    for (const [, chunkMap] of this.nodeChunks) {
      for (const [, v] of chunkMap) {
        const d = (v.x - sx) ** 2 + (v.y - sy) ** 2;
        if (d < bestD) { bestD = d; best = v; }
      }
    }
    return best;
  }

  nearestPredator(maxDist = 90) {
    let best = null, bestD = maxDist * maxDist;
    for (const [, p] of this.predators) {
      const d = (p.x - this.selfPos.x) ** 2 + (p.y - this.selfPos.y) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  doGather(silent = false) {
    if (!this.selfAlive()) return;
    const node = (this.pendingGather?.data && !this.pendingGather.data.dead)
      ? this.pendingGather.data
      : this.nearestNode();
    this.pendingGather = null;
    if (!node) {
      if (!silent) hud.toast('Nenhum recurso por perto — procure folhas, sementes ou pedras', '', 1800);
      return;
    }
    if (state.inventory.kind >= 0 && state.inventory.kind !== node.kind && state.inventory.amount > 0) {
      hud.toast(`Entregue ${RESOURCE_INFO[state.inventory.kind].name} antes de coletar outro recurso`, 'error');
      return;
    }
    net.act({ type: 'gather', nodeId: node.id });
  }

  doDeposit() {
    if (!this.selfAlive()) return;
    if (!state.colony) { hud.toast('Você não pertence a uma colônia', 'error'); return; }
    net.act({ type: 'deposit' });
  }

  doQuickDepositAll() { this.doDeposit(); }

  doEat() {
    if (!this.selfAlive()) return;
    net.act({ type: 'eat' });
  }

  doAttack() {
    if (!this.selfAlive()) return;
    const target = this.nearestPredator(72);
    if (target) { net.act({ type: 'attack', kind: 'predator', id: target.id }); this.faceTo(target.x, target.y); return; }
    let enemy = null, bestD = Infinity;
    for (const [, a] of this.ants) {
      if (a.colonyId === state.colony?.id) continue;
      if (a.role === ROLE.LARVA) continue;
      const d = (a.x - this.selfPos.x) ** 2 + (a.y - this.selfPos.y) ** 2;
      if (d < bestD && d < 90 * 90) { bestD = d; enemy = a; }
    }
    if (enemy) { net.act({ type: 'attack', kind: 'ant', id: enemy.id }); this.faceTo(enemy.x, enemy.y); return; }
    hud.toast('Nada para atacar por perto', '', 1400);
  }

  faceTo(x, y) {
    const a = Math.atan2(y - this.selfPos.y, x - this.selfPos.x);
    this.selfSprite.setRotation(a);
  }

  selfAlive() {
    return state.self ? !!state.self[7] : true;
  }

  onNotice(n) {
    if (!n) return;
    if (n.kind === 'error') { hud.toast(n.text ?? 'Ação inválida', 'error'); return; }
    if (n.kind === 'ok' && n.action) {
      const a = n.action;
      if (a === 'gather' && n.data) {
        audio.gather();
        hud.toast(`+${n.data.amount ?? 1} ${RESOURCE_INFO[n.data.kind]?.name ?? 'recurso'}`, 'ok', 900);
      } else if (a === 'deposit' && n.data) {
        audio.deposit();
        hud.toast(`Entregue: ${n.data.accepted ?? 0}${n.data.lost ? ` (${n.data.lost} perdidos)` : ''}`, 'ok', 1200);
      } else if (a === 'build') {
        audio.build();
        hud.toast('Obra iniciada — as operárias vão ajudar', 'ok', 1600);
      } else if (a === 'work') {
        audio.build();
      } else if (a === 'attack' && n.data) {
        audio.attack();
      } else if (a === 'eat') {
        hud.toast('Você se alimentou', 'ok', 1100);
      }
      return;
    }
    if (n.kind === 'death') {
      hud.showDeath(true, (n.respawnAt - Date.now()) / 1000, 'as formigas cuidam do corpo');
      audio.death();
    }
    if (n.kind === 'respawn') {
      hud.showDeath(false);
      hud.toast('De volta ao mundo', 'ok');
    }
    if (n.kind === 'colony' && n.colony) {
      hud.toast(`Bem-vinda à ${n.colony.name}`, 'ok');
      this.refreshStructureColors();
    }
    if (n.kind === 'warn') hud.toast(n.text ?? '', 'error');
  }

  onWorldEvent(e) {
    if (!e) return;
    hud.log(e.k, e.t, !!e.i);
    if (e.i) {
      hud.toast(e.t, e.k === 'raid' || e.k === 'war' ? 'error' : '', 4200);
      if (e.k === 'raid' || e.k === 'war') audio.alert();
      if (e.k === 'queen') audio.levelUp();
    }
    if (e.x && e.y) this.spawnMarker(e.x, e.y, e.k === 'raid' || e.k === 'war' ? 0xe0533f : 0xe9a85b, 2600);
  }

  spawnMarker(x, y, color, ms = 900) {
    this.markers.push({ x, y, color, until: this.time.now + ms, start: this.time.now });
    if (this.markers.length > 40) this.markers.shift();
  }

  spawnFloatText(x, y, text, color = '#ffffff') {
    const el = this.add.text(x, y, text, {
      fontFamily: 'Inter, sans-serif', fontSize: '11px', color,
      stroke: '#0b0f0a', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(45);
    this.floatTexts.push({ el, born: this.time.now, origY: y });
  }

  // ---------------------------------------------------------------- snapshots
  applySnapshot(p) {
    if (!p) return;
    if (p.self) {
      this.selfServer = { x: p.self[0], y: p.self[1] };
      const alive = !!p.self[7];
      if (!alive && this.selfAlivePrev !== false) {
        this.deadSince = this.time.now;
        this.selfSprite.setAlpha(0.35);
        hud.showDeath(true, ((p.self[8] || 0) - Date.now()) / 1000, 'o mundo é maior que uma formiga');
      } else if (alive && this.selfAlivePrev === false) {
        this.selfPos = { x: p.self[0], y: p.self[1] };
        this.selfSprite.setAlpha(1);
        hud.showDeath(false);
      }
      this.selfAlivePrev = alive;
    }

    if (p.add) for (const a of p.add) this.createAnt(a);
    if (p.up) {
      for (let i = 0; i < p.up.length; i += 4) {
        const a = this.ants.get(p.up[i]);
        if (!a) continue;
        a.tx = p.up[i + 1];
        a.ty = p.up[i + 2];
        a.state = p.up[i + 3];
      }
    }
    if (p.rm) for (const id of p.rm) this.removeAnt(id);

    if (p.padd) for (const d of p.padd) this.createPredator(d);
    if (p.pup) {
      for (let i = 0; i < p.pup.length; i += 5) {
        const pr = this.predators.get(p.pup[i]);
        if (!pr) continue;
        pr.tx = p.pup[i + 1]; pr.ty = p.pup[i + 2];
        pr.state = p.pup[i + 3]; pr.hp = p.pup[i + 4];
      }
    }
    if (p.prm) for (const id of p.prm) {
      const pr = this.predators.get(id);
      if (pr) { pr.sprite.destroy(); this.predators.delete(id); }
    }

    if (p.pl) this.applyPlayers(p.pl);

    if (p.st) for (const s of p.st) this.createStructure(s);
    if (p.strm) for (const id of p.strm) this.removeStructure(id);
    if (p.nd) for (const [chunkKey, rev, flat] of p.nd) this.applyNodes(chunkKey, rev, flat);

    if (p.env) this.applyEnv({
      day: p.env[0], part: p.env[1], weather: p.env[2],
      temperature: p.env[3], night: p.env[4], phase: p.env[5],
    });
  }

  applyEnv(env) {
    if (!env) return;
    this.env = env;
    const night = !!env.night;
    this.nightOverlay.setFillStyle(night ? 0x0a1230 : 0x000000, night ? 0.28 : 0.02);
    this.lightGlow.setAlpha(night ? 0.18 : 0);
    const rainy = env.weather === 'rain' || env.weather === 'storm';
    if (this.rainEmitter) {
      this.rainEmitter.setVisible(rainy && state.settings.particles);
      this.rainEmitter.setFrequency(env.weather === 'storm' ? 18 : env.weather === 'rain' ? 45 : 1200);
    }
    this.updateWeather();
  }

  applyPlayers(list) {
    const seen = new Set();
    for (const pl of list) {
      const [id, x, y, name, colonyId, hp, carryKind, color] = pl;
      if (id === state.selfId) continue;
      seen.add(id);
      let p = this.otherPlayers.get(id);
      if (!p) {
        const sprite = this.add.image(x, y, 'ant_worker_0').setScale(0.55).setDepth(20);
        const label = this.add.text(x, y - 22, name, {
          fontFamily: 'Inter, sans-serif', fontSize: '11px', color: '#f2eddf',
          stroke: '#080b06', strokeThickness: 3,
        }).setOrigin(0.5).setDepth(46);
        p = { id, x, y, tx: x, ty: y, sprite, label, color, hp, colonyId, carryKind };
        this.otherPlayers.set(id, p);
      }
      p.tx = x; p.ty = y; p.hp = hp; p.carryKind = carryKind; p.color = color;
      p.sprite.setTint(color ?? 0xdddddd);
      p.label.setText(name);
      p.label.setVisible(state.settings.names);
    }
    for (const [id, p] of this.otherPlayers) {
      if (!seen.has(id)) { p.sprite.destroy(); p.label.destroy(); this.otherPlayers.delete(id); }
    }
  }

  createAnt(a) {
    const [id, x, y, role, task, hp, astate, carryKind, carryAmt, flags] = a;
    if (role === ROLE.LARVA) {
      let v = this.ants.get(id);
      if (!v) {
        const sprite = this.add.image(x, y, 'ant_larva_0').setScale(0.5).setDepth(8);
        v = { id, role, sprite, x, y, tx: x, ty: y, task, state: astate, hp, carryKind, carryAmt, flags };
        this.ants.set(id, v);
      }
      return;
    }
    let v = this.ants.get(id);
    if (!v) {
      const own = this.findColonyColorForAnt(x, y);
      const sprite = this.add.image(x, y, `ant_${ROLE_KEY[role]}_0`).setScale(0.5).setDepth(10);
      sprite.setTint(own);
      v = {
        id, role, sprite, x, y, tx: x, ty: y, task, state: astate, hp,
        carryKind, carryAmt, flags, color: own, frame: 0, lastFrameAt: 0,
        maxHp: ROLE_INFO[role]?.hp ?? 20,
      };
      this.ants.set(id, v);
    } else {
      v.tx = x; v.ty = y; v.task = task; v.hp = hp; v.state = astate;
      v.carryKind = carryKind; v.carryAmt = carryAmt; v.flags = flags;
    }
  }

  /**
   * O snapshot não carrega colonyId por formiga (economia de bytes); inferimos a
   * cor pela colônia mais próxima dentro de um raio plausível de forrageio.
   * É só leitura visual — nada disso volta para o servidor.
   */
  findColonyColorForAnt(x, y) {
    let best = null;
    let bestD = 2600 * 2600;
    for (const c of state.colonies ?? []) {
      if (!c.nest) continue;
      const d = (c.nest.x - x) ** 2 + (c.nest.y - y) ** 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best?.color ?? 0xd9b48f;
  }

  /** Reconexão / troca de colônia: limpa as visões e reposiciona a câmera. */
  resetWorldView(w) {
    for (const [, a] of this.ants) a.sprite.destroy();
    for (const [, p] of this.predators) { p.sprite.destroy(); p.ring?.destroy(); }
    for (const [, p] of this.otherPlayers) { p.sprite.destroy(); p.label.destroy(); }
    for (const [, s] of this.structures) s.sprite.destroy();
    for (const [, map] of this.nodeChunks) for (const [, n] of map) n.sprite.destroy();
    this.ants.clear();
    this.predators.clear();
    this.otherPlayers.clear();
    this.structures.clear();
    this.nodeChunks.clear();
    this.occupied.clear();
    this.markers.length = 0;
    this.moveTarget = null;
    this.cancelBuild();
    if (w?.spawn) {
      this.selfPos = { x: w.spawn.x, y: w.spawn.y };
      this.selfServer = { ...this.selfPos };
      this.selfSprite.setPosition(w.spawn.x, w.spawn.y);
    }
    if (w?.world?.seed && w.world.seed !== this.seed) {
      this.seed = w.world.seed;
      this.terrain.destroy();
      this.biomeMap = new BiomeMap(this.seed, 192);
    }
    hud.showDeath(false);
  }

  removeAnt(id) {
    const v = this.ants.get(id);
    if (!v) return;
    if (v.sprite.active) {
      const puff = this.add.image(v.x, v.y, 'glow').setScale(0.4).setTint(0x9c552f).setAlpha(0.8).setDepth(9);
      this.tweens.add({ targets: puff, alpha: 0, scale: 0.9, duration: 380, onComplete: () => puff.destroy() });
    }
    v.sprite.destroy();
    this.ants.delete(id);
  }

  createPredator(d) {
    const [id, x, y, kind, hp, pstate] = d;
    let pr = this.predators.get(id);
    if (!pr) {
      const sprite = this.add.image(x, y, `pred_${kind}`)
        .setScale(TEX_SCALE[kind] ?? 0.85).setDepth(15);
      pr = { id, kind, hp, sprite, x, y, tx: x, ty: y, state: pstate, maxHp: hp };
      this.predators.set(id, pr);
      // aura de perigo
      const ring = this.add.image(x, y, 'glow').setScale(0.9).setTint(0xe0533f).setAlpha(0.15).setDepth(3);
      pr.ring = ring;
    }
    pr.tx = x; pr.ty = y; pr.hp = hp; pr.state = pstate;
  }

  createStructure(s) {
    const [id, cx, cy, gx, gy, type, colonyId, hp, progress, wx, wy] = s;
    const info = BUILDING_INFO[type];
    if (!info) return;
    const size = info.size;
    const x = wx + (size - 1) * TILE / 2;
    const y = wy + (size - 1) * TILE / 2;
    let st = this.structures.get(id);
    if (!st) {
      const sprite = this.add.image(x, y, `struct_${info.key}`)
        .setDepth(5)
        .setDisplaySize(size * TILE * 1.12, size * TILE * 1.12);
      st = {
        id, type, sprite, x, y, hp, maxHp: info.hp, progress, colonyId,
        radius: size * TILE * 0.6, wx, wy, gx, gy, cx, cy,
      };
      this.structures.set(id, st);
      this.markOccupied(cx, cy, gx, gy, size, true);
      if (progress < 100) sprite.setAlpha(0.6);
    }
    st.hp = hp; st.progress = progress; st.colonyId = colonyId; st.maxHp = info.hp;
    st.sprite.setAlpha(progress < 100 ? 0.6 : 1);
    this.refreshStructureColors();
  }

  markOccupied(cx, cy, gx, gy, size, on) {
    for (let y = gy; y < gy + size; y++) {
      for (let x = gx; x < gx + size; x++) {
        const k = `${cx},${cy},${x},${y}`;
        if (on) this.occupied.add(k); else this.occupied.delete(k);
      }
    }
  }

  removeStructure(id) {
    const st = this.structures.get(id);
    if (!st) return;
    this.markOccupied(st.cx, st.cy, st.gx, st.gy, BUILDING_INFO[st.type].size, false);
    const puff = this.add.image(st.x, st.y, 'dust').setScale(2.4).setAlpha(0.9).setDepth(9);
    this.tweens.add({ targets: puff, alpha: 0, scale: 5, duration: 600, onComplete: () => puff.destroy() });
    st.sprite.destroy();
    this.structures.delete(id);
  }

  refreshStructureColors() {
    // estruturas da colônia recebem um leve tom da cor da colônia
    for (const [, st] of this.structures) {
      const colony = state.colony;
      if (colony && st.colonyId === colony.id) st.sprite.setTint(0xfff1dd);
      else st.sprite.clearTint();
    }
  }

  applyNodes(chunkKey, rev, flat) {
    let map = this.nodeChunks.get(chunkKey);
    if (!map) { map = new Map(); this.nodeChunks.set(chunkKey, map); }
    const seen = new Set();
    for (let i = 0; i < flat.length; i += 6) {
      const id = flat[i], x = flat[i + 1], y = flat[i + 2], kind = flat[i + 3], amount = flat[i + 4], max = flat[i + 5];
      seen.add(id);
      let n = map.get(id);
      if (!n) {
        const sprite = this.add.image(x, y, `res_${kind}`).setDepth(4);
        n = { id, x, y, kind, amount, max, sprite };
        map.set(id, n);
      }
      n.amount = amount;
      const ratio = Math.max(0.15, Math.min(1, amount / Math.max(1, max)));
      n.sprite.setScale(0.7 + ratio * 0.55);
      n.sprite.setAlpha(0.55 + ratio * 0.45);
    }
    for (const [id, n] of map) {
      if (!seen.has(id)) { n.sprite.destroy(); map.delete(id); }
    }
  }

  // ---------------------------------------------------------------- construção
  enterBuildMode(type) {
    if (!state.colony) { hud.toast('Entre em uma colônia para construir', 'error'); return; }
    const info = BUILDING_INFO[type];
    if (!info) return;
    this.buildMode = { type };
    if (this.ghost) this.ghost.destroy();
    this.ghost = this.add.image(0, 0, `struct_${info.key}`)
      .setDepth(35).setAlpha(0.65)
      .setDisplaySize(info.size * TILE * 1.12, info.size * TILE * 1.12)
      .setVisible(false);
    bus.emit('hud:buildmode', { type });
    hud.toast(`${info.name}: clique para posicionar · Esc cancela`, '', 3200);
  }

  cancelBuild() {
    this.buildMode = null;
    this.ghost?.destroy();
    this.ghost = null;
    bus.emit('hud:buildmode', null);
  }

  snapToGrid(wx, wy) {
    const cx = Math.floor(wx / CHUNK_PX);
    const cy = Math.floor(wy / CHUNK_PX);
    const gx = Math.floor((wx - cx * CHUNK_PX) / TILE);
    const gy = Math.floor((wy - cy * CHUNK_PX) / TILE);
    return { cx, cy, gx, gy };
  }

  updateGhost(wx, wy) {
    if (!this.buildMode || !this.ghost) return;
    const { cx, cy, gx, gy } = this.snapToGrid(wx, wy);
    const info = BUILDING_INFO[this.buildMode.type];
    const size = info.size;
    const x = cx * CHUNK_PX + gx * TILE + (size * TILE) / 2;
    const y = cy * CHUNK_PX + gy * TILE + (size * TILE) / 2;
    this.ghost.setVisible(true);
    this.ghost.setPosition(x, y);
    const check = this.canPlaceClient(cx, cy, gx, gy, this.buildMode.type);
    this.ghostState = { ...check, cx, cy, gx, gy };
    this.ghost.setTint(check.ok ? 0x9dff9d : 0xff8a7a);
    this.ghost.setAlpha(check.ok ? 0.62 : 0.42);
  }

  canPlaceClient(cx, cy, gx, gy, type) {
    const info = BUILDING_INFO[type];
    const size = info.size;
    if (cx < 0 || cy < 0 || cx >= state.world.chunks || cy >= state.world.chunks) return { ok: false, reason: 'fora do mundo' };
    const colony = state.colony;
    if (!colony) return { ok: false, reason: 'sem colônia' };
    const nest = state.colonies.find((c) => c.id === colony.id)?.nest;
    const px = cx * CHUNK_PX + gx * TILE + (size * TILE) / 2;
    const py = cy * CHUNK_PX + gy * TILE + (size * TILE) / 2;
    if (nest && Math.hypot(px - nest.x, py - nest.y) > CHUNK_PX * 6) return { ok: false, reason: 'longe do ninho' };
    const missing = Object.entries(info.cost).filter(([k, v]) => (colony.stock?.[k] ?? 0) < v);
    if (missing.length) return { ok: false, reason: 'recursos' };
    for (let y = gy; y < gy + size; y++) {
      for (let x = gx; x < gx + size; x++) {
        if (this.occupied.has(`${cx},${cy},${x},${y}`)) return { ok: false, reason: 'ocupado' };
        const wx2 = cx * CHUNK_PX + x * TILE + TILE / 2;
        const wy2 = cy * CHUNK_PX + y * TILE + TILE / 2;
        if (isWater(this.seed, wx2, wy2)) return { ok: false, reason: 'água' };
        if (biomeAt(this.seed, wx2, wy2) === 3) return { ok: false, reason: 'rocha' };
      }
    }
    return { ok: true };
  }

  placeStructure(wx, wy) {
    if (!this.buildMode || !this.ghostState) return;
    const st = this.ghostState;
    if (!st.ok) {
      hud.toast(`Não é possível construir aqui: ${st.reason}`, 'error');
      audio.error();
      return;
    }
    net.act({ type: 'build', building: this.buildMode.type, cx: st.cx, cy: st.cy, gx: st.gx, gy: st.gy });
    this.spawnMarker(this.ghost.x, this.ghost.y, 0x9dff9d, 700);
    this.cancelBuild();
  }

  // ---------------------------------------------------------------- clima
  setupWeather() {
    this.rainEmitter = this.add.particles(0, 0, 'rain', {
      x: { min: 0, max: this.scale.width },
      y: -30,
      lifespan: 1100,
      speedY: { min: 620, max: 880 },
      speedX: { min: -90, max: -30 },
      scale: { min: 0.5, max: 1.1 },
      alpha: { start: 0.55, end: 0 },
      quantity: 2,
      frequency: 60,
      blendMode: 'NORMAL',
    }).setScrollFactor(0).setDepth(32).setVisible(false);
    this.updateWeather();
  }

  updateWeather() {
    const env = this.env ?? state.env;
    if (!env) return;
    const rainy = (env.weather === 'rain' || env.weather === 'storm') && state.settings.particles;
    this.rainEmitter?.setVisible(rainy);
    if (this.rainEmitter) this.rainEmitter.setFrequency(env.weather === 'storm' ? 16 : 48);
  }

  // ---------------------------------------------------------------- labels
  refreshPlayerLabels() {
    for (const [, p] of this.otherPlayers) p.label.setVisible(state.settings.names);
  }

  // ---------------------------------------------------------------- update
  update(time, delta) {
    if (!this.scene.isActive()) return;
    const dt = Math.min(64, delta) / 1000;
    this.biomeMap.tick(4);
    this.handleKeys(time, delta);
    this.terrain.ensureVisible(this.cameras.main, 1);
    this.terrain.update(2);

    this.updateSelf(dt, time);
    this.updateAnts(time, dt);
    this.updatePredators(time, dt);
    this.updatePlayersViews(dt);
    this.updateCameraForZoom();
    this.updatePrompt(time);
    this.drawLayers(time);
    this.updateFx(time, dt);
    this.updateMinimap(time);
    this.updateGhostIfNeeded();
    this.updateDeathScreen();
  }

  updateSelf(dt) {
    const s = state.self;
    if (!s) return;
    const speed = 78 * this.terrainSpeed(this.selfPos.x, this.selfPos.y);
    const input = state.input ?? { x: 0, y: 0 };
    const alive = !!s[7];
    if (alive && this.selfAlivePrev !== false && (input.x || input.y)) {
      const nx = this.selfPos.x + input.x * speed * dt;
      const ny = this.selfPos.y + input.y * speed * dt;
      if (!isWater(this.seed, nx, ny)) {
        this.selfPos.x = nx; this.selfPos.y = ny;
      } else if (!isWater(this.seed, nx, this.selfPos.y)) {
        this.selfPos.x = nx;
      } else if (!isWater(this.seed, this.selfPos.x, ny)) {
        this.selfPos.y = ny;
      }
      // passo
      this.stepAccum += Math.hypot(input.x, input.y) * dt;
      if (this.stepAccum > 0.34) { this.stepAccum = 0; audio.step(); }
      this.selfSprite.setRotation(Math.atan2(input.y, input.x));
      this.selfSprite.setScale(0.55, 0.55);
    }
    // correção suave pelo servidor (autoridade)
    const dx = this.selfServer.x - this.selfPos.x;
    const dy = this.selfServer.y - this.selfPos.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 140) { this.selfPos.x = this.selfServer.x; this.selfPos.y = this.selfServer.y; }
    else if (dist > 2) {
      this.selfPos.x += dx * Math.min(0.25, dt * 3.2);
      this.selfPos.y += dy * Math.min(0.25, dt * 3.2);
    }
    this.selfSprite.setPosition(this.selfPos.x, this.selfPos.y);
    this.selfRing.setPosition(this.selfPos.x, this.selfPos.y);
    this.selfRing.rotation += 0.004;
    this.lightGlow.setPosition(this.selfPos.x, this.selfPos.y);
    this.selfSprite.setTint(state.colony?.color ?? 0xd9b48f);
    this.selfSprite.setAlpha(alive ? 1 : 0.3);

    // animação de caminhada
    const moving = Math.abs(input.x) + Math.abs(input.y) > 0.01;
    const frame = moving ? Math.floor(this.time.now / 95) % 4 : 0;
    const tex = `ant_worker_${frame}`;
    if (this.selfSprite.texture.key !== tex) this.selfSprite.setTexture(tex);
  }

  terrainSpeed(x, y) {
    const b = BIOME_INFO[biomeAt(this.seed, x, y)];
    return b?.speed ?? 1;
  }

  updateAnts(time, dt) {
    const now = this.time.now;
    for (const [, a] of this.ants) {
      if (a.role === ROLE.LARVA) {
        a.sprite.x = Phaser.Math.Linear(a.sprite.x, a.tx, Math.min(1, dt * 8));
        a.sprite.y = Phaser.Math.Linear(a.sprite.y, a.ty, Math.min(1, dt * 8));
        a.x = a.sprite.x; a.y = a.sprite.y;
        continue;
      }
      const px = a.sprite.x, py = a.sprite.y;
      const lerp = Math.min(1, dt * (a.state === 3 ? 20 : 11));
      a.sprite.x = Phaser.Math.Linear(px, a.tx, lerp);
      a.sprite.y = Phaser.Math.Linear(py, a.ty, lerp);
      a.x = a.sprite.x; a.y = a.sprite.y;
      const vx = a.sprite.x - px;
      const vy = a.sprite.y - py;
      const sp = Math.hypot(vx, vy);
      if (sp > 0.05) {
        a.sprite.rotation = Phaser.Math.Angle.RotateTo(a.sprite.rotation, Math.atan2(vy, vx), 0.3);
        const frame = Math.floor((now + a.id * 17) / (a.state === 3 ? 65 : 110)) % 4;
        if (frame !== a.frame) {
          a.frame = frame;
          a.sprite.setTexture(`ant_${ROLE_KEY[a.role]}_${frame}`);
        }
      } else if (a.state === 2) {
        const frame = Math.floor((now + a.id * 17) / 140) % 4;
        if (frame !== a.frame) {
          a.frame = frame;
          a.sprite.setTexture(`ant_${ROLE_KEY[a.role]}_${frame}`);
        }
      }
    }
  }

  updatePredators(time, dt) {
    for (const [, p] of this.predators) {
      const lerp = Math.min(1, dt * 9);
      const px = p.sprite.x, py = p.sprite.y;
      p.sprite.x = Phaser.Math.Linear(px, p.tx, lerp);
      p.sprite.y = Phaser.Math.Linear(py, p.ty, lerp);
      const vx = p.sprite.x - px, vy = p.sprite.y - py;
      if (Math.hypot(vx, vy) > 0.05) {
        p.sprite.rotation = Phaser.Math.Angle.RotateTo(p.sprite.rotation, Math.atan2(vy, vx) + Math.PI / 2, 0.2);
      }
      p.x = p.sprite.x; p.y = p.sprite.y;
      if (p.ring) {
        p.ring.x = p.x; p.ring.y = p.y;
        p.ring.setAlpha(0.08 + Math.sin(time / 400) * 0.04 + (p.state === 2 ? 0.12 : 0));
      }
      if (p.hp < p.maxHp * 0.35) p.sprite.setAlpha(0.65);
      else p.sprite.setAlpha(1);
    }
  }

  updatePlayersViews(dt) {
    for (const [, p] of this.otherPlayers) {
      p.sprite.x = Phaser.Math.Linear(p.sprite.x, p.tx, Math.min(1, dt * 10));
      p.sprite.y = Phaser.Math.Linear(p.sprite.y, p.ty, Math.min(1, dt * 10));
      p.x = p.sprite.x; p.y = p.sprite.y;
      p.label.setPosition(p.x, p.y - 24);
      const moving = Math.abs(p.tx - p.sprite.x) + Math.abs(p.ty - p.sprite.y) > 0.4;
      const frame = moving ? Math.floor((this.time.now + p.id.length * 30) / 110) % 4 : 0;
      const tex = `ant_worker_${frame}`;
      if (p.sprite.texture.key !== tex) p.sprite.setTexture(tex);
      if (moving) {
        const a = Math.atan2(p.ty - p.sprite.y, p.tx - p.sprite.x);
        p.sprite.rotation = Phaser.Math.Angle.RotateTo(p.sprite.rotation, a, 0.2);
      }
    }
  }

  updateCameraForZoom() {
    const cam = this.cameras.main;
    // suaviza o zoom apenas se mudou muito (evita tremedeira)
    if (Math.abs(cam.zoom - this._lastZoom) > 0.001) {
      this._lastZoom = cam.zoom;
      this.terrain.update(1);
    }
  }

  updateGhostIfNeeded() {
    if (!this.buildMode) return;
    const pointer = this.input.activePointer;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.updateGhost(world.x, world.y);
  }

  // ---------------------------------------------------------------- interação
  updatePrompt(time) {
    if (time - this.lastInteractCheck < 90) return;
    this.lastInteractCheck = time;
    if (this.buildMode) {
      const st = this.ghostState;
      hud.setPrompt(`<kbd>clique</kbd> construir <span class="sub">${st?.ok ? 'local válido' : (st?.reason ?? '')}</span>`);
      return;
    }
    const tx = this.selfPos.x, ty = this.selfPos.y;
    let best = null, bestD = 70 * 70, text = '';
    // recurso mais próximo
    for (const [, chunkMap] of this.nodeChunks) {
      for (const [, n] of chunkMap) {
        const d = (n.x - tx) ** 2 + (n.y - ty) ** 2;
        if (d < bestD) {
          bestD = d;
          const info = RESOURCE_INFO[n.kind];
          text = `<kbd>E</kbd> coletar ${RES_ICON[info?.key] ?? ''} ${info?.name ?? 'recurso'} <span class="sub">${Math.round(n.amount)} restantes</span>`;
          best = { kind: 'node', data: n };
        }
      }
    }
    // estrutura (obra/reparo)
    for (const [, s] of this.structures) {
      const d = (s.x - tx) ** 2 + (s.y - ty) ** 2;
      if (d < bestD && d < (s.radius + 30) ** 2) {
        if (s.progress < 100) {
          bestD = d;
          const info = BUILDING_INFO[s.type];
          text = `<kbd>E</kbd> ajudar a construir ${info?.name} <span class="sub">${Math.round(s.progress)}%</span>`;
          best = { kind: 'structure', data: s };
        } else if (s.hp < s.maxHp * 0.9) {
          bestD = d;
          text = `<kbd>E</kbd> reparar ${BUILDING_INFO[s.type]?.name} <span class="sub">${Math.round((s.hp / s.maxHp) * 100)}%</span>`;
          best = { kind: 'structure', data: s };
        }
      }
    }
    // predador próximo (perigo)
    for (const [, p] of this.predators) {
      const d = (p.x - tx) ** 2 + (p.y - ty) ** 2;
      if (d < 90 * 90 && d < bestD) {
        bestD = d;
        text = `<kbd>espaço</kbd> atacar ${p.name ?? 'predador'} <span class="sub">${Math.round(p.hp)} HP</span>`;
        best = { kind: 'predator', data: p };
      }
    }
    // depósito
    if (!best && state.colony && state.inventory.amount > 0) {
      const nest = state.colonies.find((c) => c.id === state.colony.id)?.nest;
      if (nest && Math.hypot(nest.x - tx, nest.y - ty) < 110) {
        text = `<kbd>F</kbd> entregar ${state.inventory.amount} ${RESOURCE_INFO[state.inventory.kind]?.name ?? ''} no ninho`;
        best = { kind: 'deposit', data: nest };
      }
    }
    this.interact = best;
    if (text) hud.setPrompt(text);
    else hud.setPrompt(null);
  }

  // ---------------------------------------------------------------- desenho
  drawLayers(time) {
    const cam = this.cameras.main;
    const view = cam.worldView;
    const pad = 80;
    const visible = (x, y) => x > view.x - pad && x < view.right + pad && y > view.y - pad && y < view.bottom + pad;

    const sg = this.shadowG; sg.clear();
    const cg = this.cargoG; cg.clear();
    const hg = this.hpG; hg.clear();
    const bg = this.buildG; bg.clear();

    // sombras
    for (const [, a] of this.ants) {
      if (a.role === ROLE.LARVA || !visible(a.x, a.y)) continue;
      sg.fillStyle(0x000000, 0.18);
      sg.fillEllipse(a.x + 1, a.y + 4, 11, 4.5);
    }
    for (const [, p] of this.predators) {
      if (!visible(p.x, p.y)) continue;
      sg.fillStyle(0x000000, 0.25);
      sg.fillEllipse(p.x + 2, p.y + 6, 26 * (TEX_SCALE[p.kind] ?? 1), 8);
    }

    // carga das formigas + hp
    const maxShow = 400;
    let shown = 0;
    for (const [, a] of this.ants) {
      if (shown > maxShow) break;
      if (a.role === ROLE.LARVA || !visible(a.x, a.y)) continue;
      if (a.role !== ROLE.QUEEN) shown++;
      if (a.carryKind >= 0 && a.carryAmt > 0) {
        const info = RESOURCE_INFO[a.carryKind];
        const ang = a.sprite.rotation;
        cg.fillStyle(info?.color ?? 0xffffff, 0.95);
        cg.fillCircle(a.x + Math.cos(ang) * 5, a.y + Math.sin(ang) * 5 - 3, 2.4);
        cg.lineStyle(1, 0x1a1208, 0.5);
        cg.strokeCircle(a.x + Math.cos(ang) * 5, a.y + Math.sin(ang) * 5 - 3, 2.4);
      }
      if (a.hp < a.maxHp * 0.88) {
        hg.fillStyle(0x1a1208, 0.65);
        hg.fillRect(a.x - 6, a.y - 12, 12, 2.6);
        hg.fillStyle(a.hp / a.maxHp > 0.4 ? 0x9dd06a : 0xe0533f, 0.95);
        hg.fillRect(a.x - 6, a.y - 12, 12 * Math.max(0, a.hp / a.maxHp), 2.6);
      }
    }
    // barras para jogadores
    for (const [, p] of this.otherPlayers) {
      if (!visible(p.x, p.y)) continue;
      hg.fillStyle(0x1a1208, 0.6);
      hg.fillRect(p.x - 8, p.y - 16, 16, 3);
      hg.fillStyle(0x9dd06a, 0.95);
      hg.fillRect(p.x - 8, p.y - 16, 16 * Math.max(0, Math.min(1, p.hp / 70)), 3);
    }

    // obras: anel de progresso e barra
    for (const [, s] of this.structures) {
      if (s.progress >= 100 || !visible(s.x, s.y)) continue;
      const r = s.radius * 0.8;
      bg.lineStyle(2.5, 0x1a1208, 0.5);
      bg.strokeCircle(s.x, s.y, r);
      bg.lineStyle(2.5, 0xe9a85b, 0.9);
      bg.beginPath();
      bg.arc(s.x, s.y, r, -Math.PI / 2, -Math.PI / 2 + (s.progress / 100) * Math.PI * 2, false);
      bg.strokePath();
      bg.fillStyle(0x0b0f0a, 0.75);
      bg.fillRoundedRect(s.x - 16, s.y - r - 16, 32, 11, 3);
      bg.fillStyle(0xe9a85b, 1);
      bg.fillRect(s.x - 14, s.y - r - 14, 28 * (s.progress / 100), 7);
    }
    // dano em estruturas (risco vermelho)
    for (const [, s] of this.structures) {
      if (s.progress < 100 || s.hp >= s.maxHp * 0.9 || !visible(s.x, s.y)) continue;
      bg.lineStyle(1.5, 0xe0533f, 0.4 + Math.sin(time / 220) * 0.2);
      bg.strokeCircle(s.x, s.y, s.radius * 0.85);
    }

    // marcadores de eventos
    const fg = this.fxG;
    fg.clear();
    for (const m of this.markers) {
      const t = (time - m.start) / Math.max(1, m.until - m.start);
      if (t >= 1) continue;
      const alpha = (1 - t) * 0.8;
      const r = 10 + t * 46;
      fg.lineStyle(2, m.color, alpha);
      fg.strokeCircle(m.x, m.y, r);
    }
    // marcador de destino
    if (this.moveTarget) {
      fg.lineStyle(1.5, 0xe9a85b, 0.5 + Math.sin(time / 200) * 0.2);
      fg.strokeCircle(this.moveTarget.x, this.moveTarget.y, 9);
      fg.fillStyle(0xe9a85b, 0.25);
      fg.fillCircle(this.moveTarget.x, this.moveTarget.y, 3);
    }
    // anel no alvo interativo
    if (this.interact && !this.buildMode) {
      const t = this.time.now / 300;
      fg.lineStyle(1.5, 0xffe6b0, 0.5 + Math.sin(t) * 0.2);
      fg.strokeCircle(this.interact.data.x ?? this.interact.data.wx, this.interact.data.y ?? this.interact.data.wy, 14 + Math.sin(t) * 2);
    }
  }

  updateFx(time, dt) {
    for (let i = this.floatTexts.length - 1; i >= 0; i--) {
      const f = this.floatTexts[i];
      const age = (time - f.born) / 1000;
      if (age > 1.1) { f.el.destroy(); this.floatTexts.splice(i, 1); continue; }
      f.el.y = f.origY - age * 22;
      f.el.setAlpha(1 - age);
    }
    // marcadores antigos
    this.markers = this.markers.filter((m) => m.until > time);
    // dica de perigo piscando
    for (const [, p] of this.predators) {
      if (p.state === 2 && p.ring) p.ring.setScale(1.1 + Math.sin(time / 180) * 0.15);
    }
  }

  updateMinimap(time) {
    if (time - this.lastMinimap < 200) return;
    this.lastMinimap = time;
    const cam = this.cameras.main;
    const view = cam.worldView;
    const structures = [...this.structures.values()].slice(0, 400);
    const predators = [...this.predators.values()];
    const data = {
      self: { x: this.selfPos.x, y: this.selfPos.y, dir: this.selfSprite.rotation },
      view: { x: view.x, y: view.y, width: view.width, height: view.height },
      structures: structures.map((s) => ({
        wx: s.x, wy: s.y, color: s.colonyId === state.colony?.id ? state.colony?.color : 0x8a7a5a,
      })),
      base: this.biomeMap.done ? this.biomeMap.canvas : null,
      predators,
    };
    hud.drawMinimap(this.biomeMap.canvas, data);
    if (!document.getElementById('map-panel').classList.contains('hidden')) {
      hud.drawBigMap(this.biomeMap.canvas, { ...data, marker: this.moveTarget });
    }
    // ameaças próximas para a HUD (leitura, não simulação)
    if (!this.lastThreatAt || time - this.lastThreatAt > 250) {
      this.lastThreatAt = time;
      const near = [];
      for (const [, p] of this.predators) {
        const d = Math.hypot(p.x - this.selfPos.x, p.y - this.selfPos.y);
        if (d < 760) near.push({ x: p.x, y: p.y, dist: d, name: PREDATOR_NAME[p.kind] ?? 'predador' });
      }
      near.sort((a, b) => a.dist - b.dist);
      hud.setThreats(near.slice(0, 4), { x: this.selfPos.x, y: this.selfPos.y });
    }
  }

  updateDeathScreen() {
    if (!state.self) return;
    const alive = !!state.self[7];
    if (!alive) {
      const respawnAt = state.self[8] || 0;
      const secs = Math.max(0, (respawnAt - Date.now()) / 1000);
      const timer = document.getElementById('death-timer');
      if (timer) timer.textContent = secs > 0 ? `renascendo em ${Math.ceil(secs)}s` : 'pronto para renascer';
    }
  }

  // ---------------------------------------------------------------- mapa
  mapProvider() {
    const cam = this.cameras.main;
    const view = cam.worldView;
    return {
      base: this.biomeMap.canvas,
      self: { x: this.selfPos.x, y: this.selfPos.y, dir: this.selfSprite.rotation },
      view: { x: view.x, y: view.y, width: view.width, height: view.height },
      structures: [...this.structures.values()].map((s) => ({
        wx: s.x, wy: s.y, color: s.colonyId === state.colony?.id ? state.colony?.color : 0x8a7a5a,
      })),
      predators: [...this.predators.values()],
      marker: this.moveTarget,
    };
  }

  teardown() {
    this.terrain?.destroy();
    this.rainEmitter?.destroy();
    this.ants.clear();
    this.predators.clear();
    this.structures.clear();
    this.nodeChunks.clear();
  }
}

export { sectorName, CHUNK_PX };
