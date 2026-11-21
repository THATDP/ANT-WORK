/**
 * Camada de persistência.
 *
 * Contrato único (todos os backends implementam):
 *   init()                       — prepara conexão/arquivos
 *   loadWorld(worldId, seed)     — reconstrói colônias, estruturas, nós e meta
 *   saveWorld(world)             — grava diferenças (colônias, estruturas, nós sujos, meta)
 *   saveSnapshot(world, label)   — snapshot completo (recuperação pontual)
 *   loadSnapshot(worldId)        — último snapshot completo
 *   saveEvents(worldId, events)  — eventos importantes
 *   health()                     — diagnóstico para /health
 *   close()                      — flush + fechamento
 *
 * O mundo NUNCA depende de um banco para funcionar: se o Postgres cair, o
 * servidor continua com a memória e grava em arquivo (modo degradado), avisando
 * no /health. Isso evita partidas travadas por instabilidade de infraestrutura.
 */

import { MemoryStore } from './memory.js';
import { FileStore } from './file.js';
import { PostgresStore } from './postgres.js';
import { createLogger } from '../logger.js';
import { BaseStore } from './base.js';

const log = createLogger('persist');

export async function createStore(config) {
  const mode = config.persist;
  if (mode === 'memory') {
    log.warn('PERSIST=memory: nada será salvo após reiniciar (use apenas em testes)');
    return new MemoryStore(config);
  }
  if (mode === 'postgres' || (mode === 'auto' && config.databaseUrl)) {
    const store = new PostgresStore(config);
    try {
      await store.init();
      log.info('Persistência: Supabase/Postgres conectado');
      return store;
    } catch (err) {
      log.error('Postgres indisponível:', err.message);
      if (mode === 'postgres') throw err;
      log.warn('Fallback para armazenamento em arquivo (modo degradado)');
      const file = new FileStore(config);
      await file.init();
      file.degraded = true;
      return file;
    }
  }
  const store = new FileStore(config);
  await store.init();
  log.info(`Persistência: arquivos em ${config.snapshotDir}`);
  return store;
}

export { BaseStore } from './base.js';
