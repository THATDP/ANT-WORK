#!/usr/bin/env node
/**
 * Migrações do Postgres/Supabase.
 *
 * - lê database/migrations/*.sql em ordem alfabética;
 * - aplica cada arquivo ainda não registrado em schema_migrations;
 * - usa uma transação por arquivo e um advisory lock (evita duas instâncias
 *   migrando ao mesmo tempo no Render).
 *
 * Uso:
 *   DATABASE_URL=postgres://... node scripts/migrate.js
 *   npm --workspace backend run migrate
 *
 * A connection string deve ser a do pooler do Supabase (porta 6543) ou a
 * conexão direta (5432). Nunca coloque essa URL no frontend.
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const migrationsDir = path.join(repoRoot, 'database/migrations');
const LOCK_ID = 87260121; // constante arbitrária do ANT LIFE

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL não definida. Copie a connection string do Supabase e exporte antes de migrar.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: url.includes('supabase') || /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
});

async function main() {
  const files = (await fs.readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (!files.length) {
    console.log('nenhuma migração encontrada em database/migrations');
    return;
  }

  await client.connect();
  console.log(`conectado · ${files.length} migração(ões) encontradas`);

  await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
  try {
    await client.query(`create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )`);
    const { rows } = await client.query('select version from schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) {
        console.log(`· ${version} já aplicada`);
        continue;
      }
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      console.log(`→ aplicando ${version}…`);
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations(version) values ($1)', [version]);
        await client.query('commit');
        console.log(`  ok: ${version}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`falhou em ${version}: ${err.message}`);
      }
    }
    console.log('migrações concluídas.');
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    await client.end();
  }
}

main().catch(async (err) => {
  console.error(err.message);
  await client.end().catch(() => {});
  process.exit(1);
});
