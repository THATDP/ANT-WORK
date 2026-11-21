/** Contrato base de persistência — separado para evitar import circular. */
export class BaseStore {
  constructor(config) {
    this.config = config;
    this.degraded = false;
    this.lastSaveAt = 0;
    this.saves = 0;
    this.errors = 0;
  }
  async init() {}
  async loadWorld() { return null; }
  async saveWorld() {}
  async saveSnapshot() {}
  async loadSnapshot() { return null; }
  async saveEvents() {}
  async saveNodes() {}
  async health() { return { ok: true }; }
  async close() {}
  metrics() {
    return { saves: this.saves, errors: this.errors, lastSaveAt: this.lastSaveAt, degraded: this.degraded };
  }
}
