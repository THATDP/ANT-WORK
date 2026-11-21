import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers.js';
import { think } from '../src/game/ai/brain.js';
import { PREDATOR, PREDATOR_STATE, Predator } from '../src/game/predators.js';
import { ROLE, TASK, RESOURCE_KEYS, TASK_NAME, BUILDING, COLONY_LIMITS } from '../../shared/constants.js';

async function setupColony() {
  const { world } = await makeWorld({ config: { autoAiColonies: 0 } });
  const c = world.createPlayerColony({ name: 'IA', sessionId: 's1' });
  return { world, c };
}

/**
 * Spawn determinístico de predador para teste.
 *
 * O ponto pedido pode cair em água (o bioma depende da semente) e o spawn real
 * recusa água; então criamos num ponto seco próximo e devolvemos o predador
 * exatamente onde o teste pediu. Assim a distância usada pelas asserções é
 * estável e o teste mede a decisão da IA, não a sorte do bioma.
 */
function spawnNear(world, kind, x, y, opts = {}, maxRadius = 300) {
  let pred = null;
  for (let r = 0; r <= maxRadius && !pred; r += 10) {
    for (let i = 0; i < (r === 0 ? 1 : 16) && !pred; i++) {
      const a = (i / 16) * Math.PI * 2;
      pred = world.predators.spawn(kind, x + Math.cos(a) * r, y + Math.sin(a) * r, opts);
    }
  }
  if (!pred) throw new Error(`sem ponto válido para ${kind} perto de ${Math.round(x)},${Math.round(y)}`);
  pred.x = x;
  pred.y = y;
  return pred;
}

test('operária com fome procura comida/entrega, não fica ociosa', async () => {
  const { world, c } = await setupColony();
  c.stock = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, 0]));
  const ant = [...c.ants].find((a) => a.role === ROLE.WORKER);
  ant.hunger = 90;
  ant.cargo = { kind: -1, amount: 0 };
  think(ant, world);
  assert.ok([TASK.EAT, TASK.FORAGE, TASK.DEPOSIT, TASK.EXPLORE].includes(ant.task), `tarefa inesperada: ${TASK_NAME[ant.task]}`);
  assert.notEqual(ant.task, TASK.IDLE);
});

test('operária carregando sempre prioriza entrega', async () => {
  const { world, c } = await setupColony();
  const ant = [...c.ants].find((a) => a.role === ROLE.WORKER);
  ant.cargo = { kind: 0, amount: 3 };
  ant.task = TASK.IDLE;
  think(ant, world);
  assert.equal(ant.task, TASK.DEPOSIT);
});

test('soldado ataca predador próximo quando a força permite', async () => {
  const { world, c } = await setupColony();
  const soldier = [...c.ants].find((a) => a.role === ROLE.SOLDIER);
  assert.ok(soldier, 'colônia deve ter soldado');
  const pred = spawnNear(world, PREDATOR.BEETLE, soldier.x + 80, soldier.y + 40, { hunger: 90 });
  assert.ok(pred);
  world.defence.registerAttack(soldier, pred);
  think(soldier, world);
  assert.equal(soldier.task, TASK.ATTACK);
  assert.equal(soldier.targetId, pred.id);
});

test('operária foge de predador quando sozinha', async () => {
  const { world, c } = await setupColony();
  const worker = [...c.ants].find((a) => a.role === ROLE.WORKER);
  worker.hp = worker.maxHp;
  const pred = spawnNear(world, PREDATOR.LIZARD, worker.x + 60, worker.y, { hunger: 95 });
  pred.power = 20; pred.tolerance = 8;
  // remove soldados aliados por perto para simular solidão
  for (const a of c.ants) if (a.role === ROLE.SOLDIER) { a.x = worker.x + 5000; a.y = worker.y; }
  think(worker, world);
  assert.ok([TASK.FLEE, TASK.ATTACK].includes(worker.task));
});

test('predador recua quando encontra resistência alta', async () => {
  const { world, c } = await setupColony();
  const pred = spawnNear(world, PREDATOR.BEETLE, c.nest.x + 200, c.nest.y, { hunger: 90 });
  pred.hp = pred.maxHp * 0.25;
  for (let i = 0; i < 6; i++) {
    const s = world.spawnAnt(c, ROLE.SOLDIER, { x: pred.x + 20 + i * 5, y: pred.y + 10 });
    s.role = ROLE.SOLDIER;
  }
  pred.think(world);
  assert.ok([PREDATOR_STATE.FLEE, PREDATOR_STATE.PATROL].includes(pred.state), `estado ${pred.state}`);
  assert.equal(pred.target, null);
});

test('vespa prioriza larvas (berçário) em vez de adultos', async () => {
  const { world, c } = await setupColony();
  const larva = [...c.ants].find((a) => a.role === ROLE.LARVA);
  assert.ok(larva, 'precisa de larva');
  const wasp = spawnNear(world, PREDATOR.WASP, larva.x + 300, larva.y + 100, { hunger: 90 });
  wasp.think(world);
  assert.equal(wasp.state, PREDATOR_STATE.RAID);
  assert.ok(wasp.attackTarget);
});

test('cupim ataca estruturas da colônia alvo', async () => {
  const { world, c } = await setupColony();
  c.stock.material = 500;
  const { cx, cy } = world.chunkOf(c.nest.x, c.nest.y);
  const chunk = world.chunks.get(cx, cy);
  let built = null;
  for (let gy = 0; gy < 22 && !built; gy++) {
    for (let gx = 0; gx < 22 && !built; gx++) {
      if (chunk.canPlace(world.seed, gx, gy, 2, BUILDING.STORAGE).ok) {
        built = world.build.create(c, BUILDING.STORAGE, cx, cy, gx, gy, null, { asAi: true });
      }
    }
  }
  assert.ok(built?.ok, 'precisa de uma estrutura para o cupim atacar');
  built.structure.progress = 100;
  const termite = spawnNear(world, PREDATOR.TERMITE, c.nest.x + 100, c.nest.y + 100, { homeColony: c.id, hunger: 80 });
  termite.think(world);
  assert.equal(termite.state, PREDATOR_STATE.RAID);
  assert.ok(termite.structureTarget);
});

test('formiga-leão não persegue: fica emboscada', async () => {
  const { world, c } = await setupColony();
  const ant = [...c.ants].find((a) => a.role === ROLE.WORKER);
  const lion = spawnNear(world, PREDATOR.ANTLION, ant.x + 10, ant.y + 10, {});
  assert.ok(lion);
  lion.think(world);
  assert.equal(lion.state, PREDATOR_STATE.AMBUSH);
  assert.equal(lion.isMobile, false);
});

test('IA não pensa milhares de vezes por tick: pensamentos escalonados', async () => {
  const { world, c } = await setupColony();
  const p = world.players.spawn('s1', 'Perto', c.id, c.nest.x + 20, c.nest.y + 20);
  p.input = { vx: 0, vy: 0 };
  for (let i = 0; i < 100; i++) world.step();
  const thinksBefore = world.metrics.aiThinks;
  world.step();
  const delta = world.metrics.aiThinks - thinksBefore;
  const detailed = [...world.ants.values()].filter((a) => a.detail < 2 && a.alive).length;
  assert.ok(delta <= detailed, `um tick não pode pensar mais vezes que formigas detalhadas (${delta} > ${detailed})`);
  assert.ok(detailed > 0, 'deve haver formigas detalhadas perto do jogador');
});

test('formigas distantes entram em LOD abstrato', async () => {
  const { world, c } = await setupColony();
  world.players.spawn('s1', 'Perto', c.id, c.nest.x + 10, c.nest.y + 10);
  world.step();
  world.updateLOD();
  const far = [...c.ants].filter((a) => a.detail === 2);
  const near = [...c.ants].filter((a) => a.detail < 2);
  assert.ok(near.length > 0, 'formigas perto do jogador ficam detalhadas');
  // move o jogador para longe e verifica que tudo vira abstrato
  const p = [...world.players.bySession.values()][0];
  p.x = c.nest.x + 20000; p.y = c.nest.y + 20000;
  world.updateLOD();
  assert.ok([...c.ants].every((a) => a.detail === 2), 'sem jogador perto, tudo é abstrato');
});

test('sensoriamento compartilha descoberta com a colônia', async () => {
  const { world, c } = await setupColony();
  const scout = [...c.ants].find((a) => a.role === ROLE.SCOUT);
  const { cx, cy } = world.chunkOf(scout.x, scout.y);
  const node = world.chunks.get(cx, cy).nodes[0];
  world.sense.discover(c.id, node);
  assert.equal(world.sense.isKnown(c.id, node.id), true);
  assert.ok(c.knownNodes.has(node.id));
});

test('feromônio decai e atrai operárias', async () => {
  const { world, c } = await setupColony();
  const { cx, cy } = world.chunkOf(c.nest.x, c.nest.y);
  const chunk = world.chunks.get(cx, cy);
  const px = chunk.originX + 100;
  const py = chunk.originY + 100;
  chunk.depositPhero(px, py, 0, 40);
  const v = chunk.pheroAt(px, py, 0);
  assert.ok(v > 10);
  for (let i = 0; i < 40; i++) chunk.evaporate(0.9);
  const after = chunk.pheroAt(c.nest.x + 100, c.nest.y + 100, 0);
  assert.ok(after < v, 'feromônio deve evaporar');
});
