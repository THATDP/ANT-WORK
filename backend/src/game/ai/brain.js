/**
 * Cérebro das formigas: sistema de tarefas com prioridades pontuadas.
 *
 * Cada "pensamento" acontece em intervalos escalonados (nunca por frame) e
 * produz uma tarefa + alvo. As prioridades são dinâmicas: uma operária que
 * encontra um predador no caminho abandona a coleta; um soldado larga a patrulha
 * quando o alarme da colônia dispara; uma exploradora retorna para "reportar"
 * um recurso (deixando feromônio no caminho).
 *
 * Nada é aleatório sem motivo: se a formiga vagueia é porque a colônia não tem
 * necessidade urgente e a exploração é a tarefa de maior valor esperado.
 */

import {
  ROLE, ROLE_INFO, TASK, ANT_STATE, BUILDING, RESOURCE, RESOURCE_INFO, RESOURCE_KEYS,
  TASK_NAME, dist, clamp, BUILDING_INFO,
} from '../../../../shared/constants.js';
import { antDistance } from './helpers.js';

const isPredator = (e) => e && e._kind === 'predator';
const isEnemyAnt = (e) => e && e._kind === 'ant';

const SIGHT = { [ROLE.WORKER]: 190, [ROLE.SCOUT]: 320, [ROLE.SOLDIER]: 250, [ROLE.QUEEN]: 150 };

/** Quantas formigas de cada papel podem estar numa mesma tarefa antes de saturar. */
function taskSaturation(colony, task) {
  let n = 0;
  for (const a of colony.ants) if (a.task === task) n++;
  return n;
}

/** Necessidades da colônia, calculadas 1× por segundo em world.updateNeeds(). */
export function colonyNeeds(colony) {
  const pop = Math.max(1, colony.totalPopulation);
  const food = colony.stock.leaf + colony.stock.seed + colony.stock.fruit + colony.stock.insect + colony.stock.spore;
  const foodPerPop = food / pop;
  const hasBuildNeed = colony.pendingBuilds > 0;
  return {
    food,
    foodPerPop,
    hungry: foodPerPop < 3.2 || colony.foodStress > 0.35,
    starving: foodPerPop < 1.2,
    needWater: colony.stock.water / pop < 1.4,
    needMaterial: colony.stock.material < 24 || hasBuildNeed,
    needNurses: colony.population.larva > 0,
    defence: colony.defenceNeed ?? 0,
    buildNeed: hasBuildNeed,
  };
}

// ------------------------------------------------------------ utilidades
function nearestNode(world, ant, wantKinds, radius) {
  let best = null, bestScore = Infinity;
  const nodes = world.sense.nodesNear(ant.x, ant.y, radius);
  for (const n of nodes) {
    if (n.amount <= 0) continue;
    if (wantKinds && !wantKinds.includes(n.kind)) continue;
    const d = antDistance(ant.x, ant.y, n.x, n.y);
    if (d > radius) continue;
    const assigned = world.sense.nodeAssigned(n);
    const score = d + assigned * 90 + (n.kind === RESOURCE.WATER && ant.thirst < 40 ? 500 : 0);
    if (score < bestScore) { bestScore = score; best = n; }
  }
  return best;
}

function desiredKinds(ant, needs) {
  const c = ant.colony;
  const kinds = [];
  if (needs.needWater) kinds.push(RESOURCE.WATER);
  if (needs.hungry) kinds.push(RESOURCE.INSECT, RESOURCE.FRUIT, RESOURCE.SEED, RESOURCE.LEAF);
  if (needs.needMaterial) kinds.push(RESOURCE.MATERIAL);
  if (c && c.stock.spore < 3) kinds.push(RESOURCE.SPORE);
  // sem necessidade urgente: prefere o que está mais escasso no estoque
  if (!kinds.length) {
    const order = RESOURCE_KEYS.slice().sort((a, b) => (c?.stock[a] ?? 0) - (c?.stock[b] ?? 0));
    for (const k of order) {
      const id = RESOURCE_KEYS.indexOf(k);
      if (id === RESOURCE.WATER && (c?.stock.water ?? 0) > 40) continue;
      kinds.push(id);
    }
  }
  return kinds;
}

function nearestThreat(world, ant, radius) {
  const out = world.sense.threatsNear(ant.x, ant.y, radius, ant.colonyId);
  let best = null, bestD = Infinity;
  for (const t of out) {
    const d = antDistance(ant.x, ant.y, t.x, t.y);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best ? { ent: best, dist: bestD } : null;
}

function friendStrength(world, ant) {
  let n = 0;
  for (const a of world.sense.alliesNear(ant.x, ant.y, 230, ant.colonyId)) {
    if (a.role === ROLE.SOLDIER) n += 2;
    else n += 0.5;
  }
  return n;
}

function threatStrength(ent) {
  if (!ent) return 0;
  if (isPredator(ent)) return ent.power ?? 4;
  if (isEnemyAnt(ent)) return ent.role === ROLE.SOLDIER ? 3 : 1;
  return 2;
}

// ------------------------------------------------------------ decisão
export function think(ant, world) {
  const colony = ant.colony;
  if (!colony || !ant.alive) return;
  ant.nextThink = world.tick + thinkInterval(ant);

  if (ant.role === ROLE.LARVA) {
    // larvas só existem: desenvolvimento é resolvido pelo lifecycle
    ant.state = ANT_STATE.IDLE;
    return;
  }

  const needs = colony.needs || colonyNeeds(colony);
  const sight = SIGHT[ant.role] ?? 190;

  // 1. sobrevivência: ameaça imediata
  const threat = nearestThreat(world, ant, sight);
  if (threat) {
    const strong = friendStrength(world, ant);
    const danger = threatStrength(threat.ent);
    const canFight = ant.role === ROLE.SOLDIER || (strong > danger && ant.hp > ant.maxHp * 0.45);
    if (canFight && threat.dist < sight * 0.9) {
      colony.alert('combat', `${ROLE_INFO[ant.role].name} enfrenta ameaça`, threat.ent.x, threat.ent.y, 4000);
      engage(ant, threat.ent, world);
      return;
    }
    if (ant.role !== ROLE.SOLDIER && threat.dist < sight * 0.55) {
      ant.setTask(TASK.FLEE, colony.nest, 'point');
      ant.fleeTimer = world.tick + 30;
      return;
    }
  }

  if (ant.role === ROLE.SOLDIER) return soldierThink(ant, world, colony, needs, sight);
  if (ant.role === ROLE.SCOUT) return scoutThink(ant, world, colony, needs, sight);
  return workerThink(ant, world, colony, needs, sight);
}

function thinkInterval(ant) {
  if (ant.detail === 0) return 4 + (ant.id % 3);
  if (ant.detail === 1) return 12 + (ant.id % 6);
  return 30 + (ant.id % 20);
}

// ------------------------------------------------------------ operária
function workerThink(ant, world, colony, needs, sight) {
  // carregando? entrega primeiro (a menos que esteja fugindo)
  if (ant.carrying) {
    ant.setTask(TASK.DEPOSIT, colony.nest, 'colony', colony.id);
    return;
  }

  if (ant.canEat() && antDistance(ant.x, ant.y, colony.nest.x, colony.nest.y) < 420) {
    ant.setTask(TASK.EAT, colony.nest, 'colony', colony.id);
    return;
  }

  // cuidado com larvas: prioridade social alta se há larvas famintas
  if (needs.needNurses) {
    const nurses = taskSaturation(colony, TASK.NURSE);
    const larvae = colony.population.larva;
    if (nurses < Math.max(1, Math.ceil(larvae / 4)) && colony.totalPopulation > 4) {
      const larva = world.sense.nearestLarva(ant.x, ant.y, colony.id, 520);
      if (larva) { ant.setTask(TASK.NURSE, { x: larva.x, y: larva.y }, 'ant', larva.id); return; }
    }
  }

  // construção pendente
  if (needs.buildNeed && colony.antsBuilding < 6) {
    const site = world.sense.nearestBuildSite(colony.id, ant.x, ant.y);
    if (site) {
      ant.setTask(TASK.BUILD, { x: site.wx, y: site.wy }, 'structure', site.id);
      return;
    }
  }

  // reparo de estruturas danificadas
  if (ant.id % 7 === 0) {
    const broken = world.sense.nearestDamaged(colony.id, ant.x, ant.y, 700);
    if (broken) { ant.setTask(TASK.REPAIR, { x: broken.wx, y: broken.wy }, 'structure', broken.id); return; }
  }

  // reparo de túneis danificados por predadores é tratado acima; agora coleta
  const radius = ant.role === ROLE.SCOUT ? 900 : 620;
  const node = nearestNode(world, ant, desiredKinds(ant, needs), radius);
  if (node) {
    ant.setTask(TASK.FORAGE, { x: node.x, y: node.y }, 'node', node.id);
    return;
  }

  // sem recurso por perto: seguir trilha de feromônio ou explorar
  const chunk = world.chunks.get(Math.floor(ant.x / 768), Math.floor(ant.y / 768));
  const grad = chunk?.pheroGradient(ant.x, ant.y, 0);
  if (grad && grad.v > 4 && Math.random() < 0.75) {
    ant.setTask(TASK.FORAGE, {
      x: ant.x + grad.x * 260 + (Math.random() - 0.5) * 90,
      y: ant.y + grad.y * 260 + (Math.random() - 0.5) * 90,
    }, 'point');
    return;
  }
  ant.setTask(TASK.EXPLORE, world.pickExplorePoint(ant, 700), 'point');
}

// ------------------------------------------------------------ exploradora
function scoutThink(ant, world, colony, needs, sight) {
  if (ant.carrying) { ant.setTask(TASK.DEPOSIT, colony.nest, 'colony', colony.id); return; }

  // encontrou algo bom? volta marcando trilha (comportamento de recrutamento)
  const node = nearestNode(world, ant, null, 360);
  if (node && !world.sense.isKnown(colony.id, node.id) && node.amount > 15) {
    world.sense.discover(colony.id, node);
    colony.alert('discovery', `${RESOURCE_INFO[node.kind].name} descobertas em ${world.sectorLabel(node.x, node.y)}`, node.x, node.y, 9000);
    ant.setTask(TASK.RETURN, colony.nest, 'colony', colony.id);
    ant.reportNode = node.id;
    return;
  }

  if (needs.hungry && node) { ant.setTask(TASK.FORAGE, { x: node.x, y: node.y }, 'node', node.id); return; }
  if (ant.id % 9 === 0) {
    const site = world.sense.nearestBuildSite(colony.id, ant.x, ant.y);
    if (site && needs.needMaterial) { ant.setTask(TASK.BUILD, { x: site.wx, y: site.wy }, 'structure', site.id); return; }
  }

  const target = world.pickExplorePoint(ant, 1500);
  ant.setTask(TASK.EXPLORE, target, 'point');
}

// ------------------------------------------------------------ guerreira
function soldierThink(ant, world, colony, needs, sight) {
  const alarm = world.defence.threatNear(ant.x, ant.y, 700, colony.id);
  if (alarm) { engage(ant, alarm.ent, world); return; }

  if (needs.defence > 0.2 && ant.id % 5 === 0) {
    const invader = world.defence.deepestThreat(colony);
    if (invader) { engage(ant, invader.ent, world); return; }
  }

  const enemies = world.sense.enemyAntsNear(ant.x, ant.y, 320, colony.id);
  if (enemies.length) {
    const t = enemies.sort((a, b) => a.hp - b.hp)[0];
    engage(ant, t, world);
    return;
  }

  // escoltar operária carregada (proteção de trilha)
  if (ant.id % 3 === 0) {
    const worker = world.sense.nearestCarrier(ant.x, ant.y, colony.id, 300);
    if (worker) {
      ant.setTask(TASK.ESCORT, { x: worker.x, y: worker.y }, 'ant', worker.id);
      ant.escort = worker.id;
      return;
    }
  }
  ant.escort = null;

  const patrol = world.defence.patrolPoint(colony, ant);
  ant.setTask(TASK.PATROL, patrol, 'point');
}

export function engage(ant, ent, world) {
  const kind = ent._kind === 'predator' ? 'predator' : ent._kind === 'player' ? 'player' : 'ant';
  ant.setTask(TASK.ATTACK, { x: ent.x, y: ent.y }, kind, ent.id);
  ant.state = ANT_STATE.SEEK;
  world.defence.registerAttack(ant, ent);
}

export { taskSaturation, nearestNode, nearestThreat, desiredKinds };
