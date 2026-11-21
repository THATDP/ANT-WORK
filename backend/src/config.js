import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORLD_SEED_DEFAULT } from '../../shared/constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  repoRoot,
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 8080),
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:4173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  worldSeed: num(process.env.WORLD_SEED, WORLD_SEED_DEFAULT),
  worldId: process.env.WORLD_ID || 'ant-life-1',

  persist: (process.env.PERSIST || 'auto').toLowerCase(),
  persistIntervalMs: num(process.env.PERSIST_INTERVAL_MS, 30_000),
  snapshotDir: path.resolve(repoRoot, process.env.SNAPSHOT_DIR || 'backend/data/snapshots'),

  databaseUrl: process.env.DATABASE_URL || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

  adminToken: process.env.ADMIN_TOKEN || '',
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),

  // limites de simulação (ajustados nos testes de carga — ver docs/LIMITES.md)
  maxDetailedAnts: num(process.env.MAX_DETAILED_ANTS, 420),
  maxAntsTotal: num(process.env.MAX_ANTS, 2600),
  maxPredators: num(process.env.MAX_PREDATORS, 90),
  maxPlayers: num(process.env.MAX_PLAYERS, 120),
  autoAiColonies: num(process.env.AI_COLONIES, 2),
};

export const isProd = config.env === 'production';
