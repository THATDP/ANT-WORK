import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BaseStore } from './base.js';
import { createLogger } from '../logger.js';

const log = createLogger('db');

/**
 * Persistência no Supabase (Postgres).
 *
 * - Usa apenas a connection string privilegiada no backend (DATABASE_URL).
 * - Escritas em lote a cada PERSIST_INTERVAL_MS (padrão 30 s) + flush no shutdown.
 * - Colônias/estruturas são relacionais; o estado dos nós de recurso é agregado
 *   por chunk em JSONB (poucas linhas, leitura barata no boot).
 * - Migrações idempotentes aplicadas automaticamente (database/migrations/*.sql).
 */

export class PostgresStore extends BaseStore {
  constructor(config) {
    super(config);
    this.pool = null;
    this.pendingNodes = new Map(); // chunkKey -> {nodeId: {amount,respawnAt}}
    this.pendingEvents = [];
    this.loadedNodes = new Map();
  }

  async init() {
    if (!this.config.databaseUrl) throw new Error('DATABASE_URL não configurada');
    const isSupabasePooler = /pooler\.supabase\.com/.test(this.config.databaseUrl);
    this.pool = new pg.Pool({
      connectionString: this.config.databaseUrl,
      max: Number(process.env.PG_POOL_MAX || 8),
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 10_000,
      ssl: /supabase|amazonaws|render\.com/.test(this.config.databaseUrl) ? { rejectUnauthorized: false } : undefined,
      application_name: 'ant-life',
    });
    this.pool.on('error', (err) => {
      this.errors++;
      log.error('Erro no pool do Postgres:', err.message);
    });
    const client = await this.pool.connect();
    try {
      await client.query('select 1');
    } finally {
      client.release();
    }
    if (process.env.AUTO_MIGRATE !== 'false') await this.migrate();
    if (isSupabasePooler) log.debug('Conectado via pooler do Supabase');
  }

  async migrate() {
    const dir = path.join(this.config.repoRoot, 'database', 'migrations');
    let files = [];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    } catch {
      log.warn(`Sem pasta de migrações em ${dir} — pulando`);
      return;
    }
    await this.pool.query(`create table if not exists schema_migrations (
      version text primary key, applied_at timestamptz not null default now())`);
    const { rows } = await this.pool.query('select version from schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      const client = await this.pool.connect();
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file]);
        await client.query('commit');
        log.info(`Migração aplicada: ${file}`);
      } catch (err) {
        await client.query('rollback');
        log.error(`Falha na migração ${file}:`, err.message);
        throw err;
      } finally {
        client.release();
      }
    }
  }

  async loadWorld(worldId) {
    const w = await this.pool.query('select * from worlds where id = $1', [worldId]);
    if (!w.rows.length) return null;
    const worldRow = w.rows[0];
    const colonies = await this.pool.query('select * from colonies where world_id = $1', [worldId]);
    const structures = await this.pool.query('select * from structures where world_id = $1', [worldId]);
    const chunks = await this.pool.query('select chunk_key, nodes from world_chunks where world_id = $1', [worldId]);

    const nodeStates = {};
    for (const row of chunks.rows) {
      nodeStates[row.chunk_key] = row.nodes;
      this.loadedNodes.set(row.chunk_key, row.nodes);
    }

    return {
      id: worldRow.id,
      seed: Number(worldRow.seed),
      tick: Number(worldRow.tick),
      env: worldRow.env ?? { weather: 'clear', dayPhase: 0.25 },
      colonies: colonies.rows.map((r) => ({
        id: r.id, name: r.name, color: r.color, isAi: r.is_ai,
        founder: r.founder_session, nest: { x: Number(r.nest_x), y: Number(r.nest_y) },
        stock: r.stock, morale: Number(r.morale), population: r.population,
        stats: r.stats, territory: r.territory, relations: r.relations,
        queenDead: r.queen_dead, createdAt: Number(r.created_at),
      })),
      structures: structures.rows.map((r) => ({
        id: Number(r.id), type: r.type, cx: r.cx, cy: r.cy, gx: r.gx, gy: r.gy,
        colonyId: r.colony_id, hp: Number(r.hp), progress: Number(r.progress), builtAt: Number(r.built_at),
      })),
      nodeStates,
    };
  }

  peekChunkData(chunkKey) {
    const state = this.pendingNodes.get(chunkKey) ?? this.loadedNodes.get(chunkKey);
    if (!state) return null;
    return {
      nodes: Object.entries(state).map(([id, v]) => ({ id: Number(id), amount: v.amount, respawnAt: v.respawnAt })),
      structures: [],
    };
  }

  async saveWorld(world) {
    const data = world.serialize();
    for (const chunk of world.chunks.chunks.values()) {
      const updates = chunk.drainNodeUpdates();
      if (!updates.length) continue;
      const cur = this.pendingNodes.get(chunk.key) ?? { ...(this.loadedNodes.get(chunk.key) ?? {}) };
      for (const u of updates) cur[u.id] = { amount: Math.round(u.amount * 10) / 10, respawnAt: u.respawnAt };
      this.pendingNodes.set(chunk.key, cur);
    }

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into worlds (id, seed, tick, env, updated_at) values ($1,$2,$3,$4,now())
         on conflict (id) do update set tick = excluded.tick, env = excluded.env, updated_at = now()`,
        [world.id, world.seed, data.tick, JSON.stringify(data.env)]
      );

      for (const c of data.colonies) {
        await client.query(
          `insert into colonies (id, world_id, name, color, is_ai, founder_session, nest_x, nest_y,
             stock, morale, population, stats, territory, relations, queen_dead, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,to_timestamp($16/1000.0),now())
           on conflict (id) do update set name = excluded.name, color = excluded.color,
             nest_x = excluded.nest_x, nest_y = excluded.nest_y, stock = excluded.stock,
             morale = excluded.morale, population = excluded.population, stats = excluded.stats,
             territory = excluded.territory, relations = excluded.relations,
             queen_dead = excluded.queen_dead, updated_at = now()`,
          [c.id, world.id, c.name, c.color, c.isAi, c.founder, c.nest.x, c.nest.y,
            JSON.stringify(c.stock), c.morale, JSON.stringify(c.population), JSON.stringify(c.stats),
            JSON.stringify(c.territory ?? []), JSON.stringify(c.relations ?? []), c.queenDead, c.createdAt ?? Date.now()]
        );
      }

      // membros (jogadores nas colônias) — persiste progresso mesmo offline
      const memberRows = [];
      for (const colony of world.colonies.values()) {
        for (const [sessionId, m] of colony.members) {
          memberRows.push([colony.id, sessionId, m.name, m.role, Math.round(m.contribution ?? 0)]);
        }
      }
      for (const row of memberRows) {
        await client.query(
          `insert into colony_members (colony_id, session_id, name, role, contribution)
           values ($1,$2,$3,$4,$5)
           on conflict (colony_id, session_id) do update set name = excluded.name,
             role = excluded.role, contribution = excluded.contribution`,
          row
        );
      }

      // estruturas: upsert + remoção das que não existem mais
      for (const s of data.structures) {
        await client.query(
          `insert into structures (id, world_id, colony_id, type, cx, cy, gx, gy, hp, progress, built_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
           on conflict (id) do update set colony_id = excluded.colony_id, type = excluded.type,
             cx = excluded.cx, cy = excluded.cy, gx = excluded.gx, gy = excluded.gy,
             hp = excluded.hp, progress = excluded.progress, built_at = excluded.built_at, updated_at = now()`,
          [s.id, world.id, s.colonyId, s.type, s.cx, s.cy, s.gx, s.gy, Math.round(s.hp), Math.round(s.progress), s.builtAt ?? 0]
        );
      }
      const validIds = data.structures.map((s) => s.id);
      if (validIds.length) {
        await client.query('delete from structures where world_id = $1 and not (id = any($2::bigint[]))', [world.id, validIds]);
      } else {
        await client.query('delete from structures where world_id = $1', [world.id]);
      }

      // nós sujos por chunk
      for (const [chunkKey, nodes] of this.pendingNodes) {
        await client.query(
          `insert into world_chunks (world_id, chunk_key, nodes, updated_at) values ($1,$2,$3,now())
           on conflict (world_id, chunk_key) do update set nodes = excluded.nodes, updated_at = now()`,
          [world.id, chunkKey, JSON.stringify(nodes)]
        );
      }
      this.pendingNodes.clear();

      if (this.pendingEvents.length) {
        const evs = this.pendingEvents.splice(0, 200);
        const values = [];
        const params = [];
        evs.forEach((e, i) => {
          const o = i * 6;
          values.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`);
          params.push(world.id, e.kind, e.text, e.x ?? 0, e.y ?? 0, e.tick ?? 0);
        });
        await client.query(
          `insert into world_events (world_id, kind, text, x, y, tick) values ${values.join(',')}`,
          params
        );
      }

      await client.query('commit');
      this.saves++;
      this.lastSaveAt = Date.now();
      this.degraded = false;
      return true;
    } catch (err) {
      try { await client.query('rollback'); } catch { /* ignore */ }
      this.errors++;
      this.degraded = true;
      log.error('Falha ao salvar mundo:', err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  async saveNodes(worldId, chunkKey, updates) {
    if (!updates?.length) return;
    const cur = this.pendingNodes.get(chunkKey) ?? { ...(this.loadedNodes.get(chunkKey) ?? {}) };
    for (const u of updates) cur[u.id] = { amount: Math.round(u.amount * 10) / 10, respawnAt: u.respawnAt };
    this.pendingNodes.set(chunkKey, cur);
  }

  async saveSnapshot(world, label = 'auto') {
    const data = world.serialize();
    await this.pool.query(
      `insert into world_snapshots (world_id, label, data) values ($1,$2,$3)`,
      [world.id, label, JSON.stringify(data)]
    );
    // mantém os 8 mais recentes por mundo
    await this.pool.query(
      `delete from world_snapshots where world_id = $1 and id not in (
         select id from world_snapshots where world_id = $1 order by created_at desc limit 8)`,
      [world.id]
    );
    return true;
  }

  async loadSnapshot(worldId) {
    const { rows } = await this.pool.query(
      'select data from world_snapshots where world_id = $1 order by created_at desc limit 1', [worldId]
    );
    return rows.length ? rows[0].data : null;
  }

  async saveEvents(worldId, events) {
    this.pendingEvents.push(...events);
    return true;
  }

  async savePlayerProgress(sessionId, data) {
    await this.pool.query(
      `insert into players (session_id, name, colony_id, stats, last_seen)
       values ($1,$2,$3,$4,now())
       on conflict (session_id) do update set name = excluded.name, colony_id = excluded.colony_id,
         stats = excluded.stats, last_seen = now()`,
      [sessionId, data.name, data.colonyId, JSON.stringify(data.stats ?? {})]
    );
  }

  async health() {
    try {
      const t0 = Date.now();
      const { rows } = await this.pool.query('select count(*)::int as worlds from worlds');
      return { ok: true, mode: 'postgres', latencyMs: Date.now() - t0, worlds: rows[0].worlds, degraded: this.degraded };
    } catch (err) {
      return { ok: false, mode: 'postgres', error: err.message };
    }
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}
