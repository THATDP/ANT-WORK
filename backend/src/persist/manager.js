import { createLogger } from '../logger.js';

const log = createLogger('persist');

/**
 * Salva periodicamente e em eventos importantes. Nunca grava por frame:
 * um save completo é ~1-3 ms com 4 colônias e ~400 estruturas.
 */
export class PersistenceManager {
  constructor(world, store, intervalMs = 30_000) {
    this.world = world;
    this.store = store;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.saving = false;
    this.pendingEvents = [];
    this.failures = 0;
    this.snapshotEvery = 10; // a cada 10 saves (~5 min)
    this.saveCount = 0;
    this.onSaved = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.save().catch(() => {}), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Eventos importantes entram na fila para gravação. */
  trackEvent(item) {
    if (item.important) this.pendingEvents.push(item);
    if (this.pendingEvents.length > 300) this.pendingEvents.shift();
  }

  async save(label = 'auto') {
    if (this.saving) return false;
    this.saving = true;
    try {
      await this.store.saveWorld(this.world);
      if (this.pendingEvents.length) {
        await this.store.saveEvents(this.world.id, this.pendingEvents.splice(0));
      }
      this.saveCount++;
      this.failures = 0;
      if (this.saveCount % this.snapshotEvery === 0) {
        await this.store.saveSnapshot(this.world, label);
      }
      // progresso dos jogadores (para estatísticas persistentes)
      if (this.store.savePlayerProgress) {
        for (const p of this.world.players.bySession.values()) {
          await this.store.savePlayerProgress(p.sessionId, {
            name: p.name, colonyId: p.colonyId, stats: p.stats,
          }).catch(() => {});
        }
      }
      this.onSaved?.();
      log.debug('Mundo salvo');
      return true;
    } catch (err) {
      this.failures++;
      log.error(`Save falhou (${this.failures}x):`, err.message);
      return false;
    } finally {
      this.saving = false;
    }
  }

  async snapshot(label = 'manual') {
    try {
      await this.store.saveWorld(this.world);
      await this.store.saveSnapshot(this.world, label);
      return true;
    } catch (err) {
      log.error('Snapshot falhou:', err.message);
      return false;
    }
  }

  async shutdown() {
    this.stop();
    log.info('Salvando mundo antes de encerrar...');
    const ok = await this.save('shutdown');
    try { await this.store.close(); } catch { /* já fechado */ }
    return ok;
  }

  status() {
    return {
      intervalMs: this.intervalMs,
      saveCount: this.saveCount,
      failures: this.failures,
      pendingEvents: this.pendingEvents.length,
      ...this.store.metrics?.() ?? {},
    };
  }
}
