/**
 * ANT LIFE — constantes compartilhadas entre backend (Node) e frontend (Phaser).
 * Este arquivo é ESM puro, sem dependências, importado pelos dois lados.
 */

// ---------------------------------------------------------------- mundo base
export const TILE = 32;                 // px por tile
export const CHUNK_TILES = 24;          // tiles por lado do chunk
export const CHUNK_PX = TILE * CHUNK_TILES; // 768 px
export const WORLD_CHUNKS = 48;         // 48x48 chunks
export const WORLD_PX = CHUNK_PX * WORLD_CHUNKS; // 36.864 px

export const TICK_HZ = 10;              // simulação autoritativa
export const TICK_MS = 1000 / TICK_HZ;
export const SNAPSHOT_HZ = 10;          // snapshots de rede
export const WORLD_SEED_DEFAULT = 20261121;

// ---------------------------------------------------------------- biomas
export const BIOME = {
  FOREST: 0,
  GARDEN: 1,
  FIELD: 2,
  ROCK: 3,
  WET: 4,
  WATER: 5,
  UNDERGROUND: 6,
  CONTAMINATED: 7,
};

export const BIOME_INFO = {
  [BIOME.FOREST]:      { name: 'Floresta',        color: 0x2f5a34, accent: 0x3f7442, speed: 0.92, danger: 2 },
  [BIOME.GARDEN]:      { name: 'Jardim',          color: 0x4c7a3a, accent: 0x6f9b4b, speed: 1.00, danger: 1 },
  [BIOME.FIELD]:       { name: 'Campo Aberto',    color: 0x6c8a3e, accent: 0x8aa74e, speed: 1.08, danger: 1 },
  [BIOME.ROCK]:        { name: 'Região Rochosa',  color: 0x5b5852, accent: 0x746f66, speed: 0.80, danger: 2 },
  [BIOME.WET]:         { name: 'Solo Úmido',      color: 0x3c5c52, accent: 0x4c7263, speed: 0.86, danger: 2 },
  [BIOME.WATER]:       { name: 'Água',            color: 0x264d66, accent: 0x2f6480, speed: 0.00, danger: 3 },
  [BIOME.UNDERGROUND]: { name: 'Subterrâneo',     color: 0x241d16, accent: 0x352a1f, speed: 1.02, danger: 3 },
  [BIOME.CONTAMINATED]:{ name: 'Área Contaminada',color: 0x4a3a52, accent: 0x63496e, speed: 0.88, danger: 4 },
};

// ---------------------------------------------------------------- recursos
export const RESOURCE = {
  LEAF: 0, SEED: 1, FRUIT: 2, INSECT: 3, WATER: 4, MATERIAL: 5, SPORE: 6,
};

export const RESOURCE_INFO = {
  [RESOURCE.LEAF]:     { key: 'leaf',     name: 'Folhas',        color: 0x6fbf4a, food: 1, water: 0, material: 0 },
  [RESOURCE.SEED]:     { key: 'seed',     name: 'Sementes',      color: 0xd7b45a, food: 2, water: 0, material: 0 },
  [RESOURCE.FRUIT]:    { key: 'fruit',    name: 'Frutas',        color: 0xe0645a, food: 3, water: 1, material: 0 },
  [RESOURCE.INSECT]:   { key: 'insect',   name: 'Insetos',       color: 0xb98356, food: 4, water: 0, material: 0 },
  [RESOURCE.WATER]:    { key: 'water',    name: 'Água',          color: 0x4aa8d8, food: 0, water: 3, material: 0 },
  [RESOURCE.MATERIAL]: { key: 'material', name: 'Materiais',     color: 0x9c8f7a, food: 0, water: 0, material: 2 },
  [RESOURCE.SPORE]:    { key: 'spore',    name: 'Esporos Raros', color: 0xc77bff, food: 2, water: 0, material: 0 },
};

export const RESOURCE_KEYS = ['leaf', 'seed', 'fruit', 'insect', 'water', 'material', 'spore'];

export function emptyStock() {
  return { leaf: 0, seed: 0, fruit: 0, insect: 0, water: 0, material: 0, spore: 0 };
}

// ---------------------------------------------------------------- formigas
export const ROLE = {
  WORKER: 0, SCOUT: 1, SOLDIER: 2, QUEEN: 3, LARVA: 4,
};

export const ROLE_INFO = {
  [ROLE.WORKER]:  { key: 'worker',  name: 'Operária',   speed: 52, hp: 20, carry: 6, sight: 210, damage: 1, color: 0xa9653f },
  [ROLE.SCOUT]:   { key: 'scout',   name: 'Exploradora',speed: 68, hp: 14, carry: 3, sight: 340, damage: 1, color: 0xd08b3e },
  [ROLE.SOLDIER]: { key: 'soldier', name: 'Guerreira',  speed: 58, hp: 46, carry: 4, sight: 260, damage: 4, color: 0x8b3a2f },
  [ROLE.QUEEN]:   { key: 'queen',   name: 'Rainha',     speed: 18, hp: 160, carry: 0, sight: 160, damage: 2, color: 0x9c3f6e },
  [ROLE.LARVA]:   { key: 'larva',   name: 'Larva',      speed: 0,  hp: 8,  carry: 0, sight: 0,   damage: 0, color: 0xe8dcc0 },
};

// intenções / tarefas de IA
export const TASK = {
  IDLE: 0, FORAGE: 1, HAUL: 2, BUILD: 3, NURSE: 4, REPAIR: 5,
  EXPLORE: 6, PATROL: 7, DEFEND: 8, ATTACK: 9, FLEE: 10,
  RETURN: 11, DEPOSIT: 12, EAT: 13, BREED: 14, ESCORT: 15,
};

export const TASK_NAME = {
  [TASK.IDLE]: 'Ociosa', [TASK.FORAGE]: 'Coletando', [TASK.HAUL]: 'Transportando',
  [TASK.BUILD]: 'Construindo', [TASK.NURSE]: 'Cuidando', [TASK.REPAIR]: 'Reparando',
  [TASK.EXPLORE]: 'Explorando', [TASK.PATROL]: 'Patrulhando', [TASK.DEFEND]: 'Defendendo',
  [TASK.ATTACK]: 'Atacando', [TASK.FLEE]: 'Recuando', [TASK.RETURN]: 'Retornando',
  [TASK.DEPOSIT]: 'Depositando', [TASK.EAT]: 'Alimentando', [TASK.BREED]: 'Reproduzindo',
  [TASK.ESCORT]: 'Escoltando',
};

// banda de formigas: resolve step em fases sem varrer todas por tick
export const ANT_STATE = {
  SEEK: 0, MOVE: 1, WORK: 2, ATTACK: 3, DEAD: 4, FOLLOW: 5,
};

// ---------------------------------------------------------------- construções
export const BUILDING = {
  TUNNEL: 0, CHAMBER: 1, STORAGE: 2, NURSERY: 3, FEEDING: 4,
  BARRACKS: 5, EXIT: 6, WATCHTOWER: 7, FUNGUS: 8, SHRINE: 9,
};

// custos em recursos do estoque da colônia
export const BUILDING_INFO = {
  [BUILDING.TUNNEL]:    { key: 'tunnel',    name: 'Túnel',            size: 1, cost: { material: 4 },                       buildTime: 4,  surface: false, hp: 30, desc: 'Conecta câmaras e acelera o transporte interno.' },
  [BUILDING.CHAMBER]:   { key: 'chamber',   name: 'Câmara',           size: 2, cost: { material: 14 },                      buildTime: 8,  surface: false, hp: 60, desc: 'Espaço genérico que aumenta a capacidade da colônia.' },
  [BUILDING.STORAGE]:   { key: 'storage',   name: 'Depósito',         size: 2, cost: { material: 18 },                      buildTime: 9,  surface: false, hp: 50, desc: '+250 de capacidade de estoque.' },
  [BUILDING.NURSERY]:   { key: 'nursery',   name: 'Berçário',         size: 2, cost: { material: 22, leaf: 10 },            buildTime: 11, surface: false, hp: 50, desc: 'Acelera o desenvolvimento de larvas.' },
  [BUILDING.FEEDING]:   { key: 'feeding',   name: 'Sala de Alimentação', size: 2, cost: { material: 12, seed: 8 },           buildTime: 8,  surface: false, hp: 45, desc: 'Reduz a fome da população próxima.' },
  [BUILDING.BARRACKS]:  { key: 'barracks',  name: 'Área de Defesa',   size: 2, cost: { material: 26, insect: 6 },            buildTime: 12, surface: false, hp: 90, desc: 'Reforça a defesa e aumenta o moral de guerreiras.' },
  [BUILDING.EXIT]:      { key: 'exit',      name: 'Entrada Alternativa', size: 1, cost: { material: 10 },                    buildTime: 6,  surface: true,  hp: 30, desc: 'Segunda boca de colônia: rotas de fuga e coleta.' },
  [BUILDING.WATCHTOWER]:{ key: 'watchtower',name: 'Torre de Vigia',   size: 1, cost: { material: 16, spore: 1 },             buildTime: 10, surface: true,  hp: 40, desc: 'Amplia o alcance de detecção de ameaças.' },
  [BUILDING.FUNGUS]:    { key: 'fungus',    name: 'Jardim de Fungos', size: 2, cost: { material: 20, water: 12 },            buildTime: 14, surface: false, hp: 40, desc: 'Produz alimento lentamente a partir de matéria orgânica.' },
  [BUILDING.SHRINE]:    { key: 'shrine',    name: 'Câmara da Rainha', size: 3, cost: { material: 40, fruit: 20, spore: 2 },   buildTime: 20, surface: false, hp: 140, desc: 'Aumenta a taxa de postura da rainha.' },
};

export const BUILDING_KEYS = Object.values(BUILDING_INFO).map((b) => b.key);
export const BUILDING_BY_KEY = Object.fromEntries(Object.entries(BUILDING_INFO).map(([id, info]) => [info.key, { id: Number(id), ...info }]));

// ---------------------------------------------------------------- colônias
export const COLONY_ROLE = { FOUNDER: 'founder', OFFICER: 'officer', MEMBER: 'member' };

export const COLONY_PERMISSION = {
  BUILD: 'build', DEMOLISH: 'demolish', STOCK_WITHDRAW: 'withdraw',
  MANAGE_ROLES: 'manageRoles', KICK: 'kick', DECLARE_WAR: 'war',
};

export const DEFAULT_PERMISSIONS = {
  [COLONY_ROLE.FOUNDER]: { build: true, demolish: true, withdraw: true, manageRoles: true, kick: true, war: true },
  [COLONY_ROLE.OFFICER]: { build: true, demolish: true, withdraw: true, manageRoles: false, kick: true, war: true },
  [COLONY_ROLE.MEMBER]:  { build: true, demolish: false, withdraw: false, manageRoles: false, kick: false, war: false },
};

export const COLONY_LIMITS = {
  maxMembers: 12,
  maxStructures: 220,
  maxPopulation: 900,          // formigas vivas simuladas (detalhe + abstrato)
  baseStorage: 400,
  storagePerDepot: 250,
};

export const COLONY_COLORS = [0xe0532f, 0x3fa1d8, 0x8f5fd8, 0x2fa86a, 0xd8a03f, 0xd84f8f, 0x5fd8c4, 0xa8d84f];

// ---------------------------------------------------------------- rede
export const MSG = {
  // cliente -> servidor
  HELLO: 'hello', INPUT: 'input', ACT: 'act', SUB: 'sub', CHAT: 'chat',
  COLONY_OP: 'colony', SETTINGS: 'settings', PING: 'ping', RESPAWN: 'respawn',
  // servidor -> cliente
  WELCOME: 'welcome', SNAP: 'snap', SELF: 'self', STATE: 'state',
  EVENT: 'event', CHAT_MSG: 'chat', PONG: 'pong', ERROR: 'error',
  COLONIES: 'colonies', NOTICE: 'notice', KICK: 'kick',
};

export const QUANT = 0.25; // precisão de posição enviada pela rede

export const NET = {
  inputHz: 15,
  maxInputPerSecond: 40,
  chatMaxLen: 160,
  chatIntervalMs: 1500,
  maxChatPerMinute: 20,
  actionCooldownMs: 120,
  reconnectGraceMs: 90_000,
  aoiRadiusChunks: 2,       // raio de chunks assinados ao redor do jogador
  maxEntitiesPerSnap: 220,
  fullRefreshTicks: 25,
  maxEntitiesTracked: 4000,
};

export const PACKET_LIMIT = {
  softBytesPerSecPerClient: 90 * 1024,
};

// ---------------------------------------------------------------- tempo/clima
export const DAY_LENGTH_TICKS = 3600; // 6 min de dia completo a 10Hz
export const WEATHER = ['clear', 'rain', 'storm', 'fog', 'heat'];
export const WEATHER_INFO = {
  clear: { name: 'Limpo', speedMul: 1.0, visibility: 1.0, waterGain: 0 },
  rain: { name: 'Chuva', speedMul: 0.9, visibility: 0.85, waterGain: 1 },
  storm: { name: 'Tempestade', speedMul: 0.78, visibility: 0.6, waterGain: 2 },
  fog: { name: 'Neblina', speedMul: 0.95, visibility: 0.5, waterGain: 0 },
  heat: { name: 'Calor', speedMul: 1.05, visibility: 1.0, waterGain: -1 },
};

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
export const dist = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));
export const q = (v) => Math.round(v / QUANT) * QUANT;
