/**
 * ANT LIFE — entrada do backend.
 *
 * Sobe o mundo persistente, o HTTP (health/metrics/API) e o Socket.IO.
 * Um único processo = uma única simulação autoritativa (por mundo).
 * Para escalar horizontalmente: um processo por WORLD_ID + roteamento sticky.
 */

import { config, isProd } from './config.js';
import { createLogger } from './logger.js';
import { World } from './game/world.js';
import { createStore } from './persist/store.js';
import { PersistenceManager } from './persist/manager.js';
import { createRealtimeServer } from './net/server.js';

const log = createLogger('boot');

async function main() {
  log.info(`ANT LIFE backend · env=${config.env} · mundo=${config.worldId} · seed=${config.worldSeed}`);

  const store = await createStore(config);
  const world = new World({ seed: config.worldSeed, id: config.worldId, store, config, log });
  await world.load();
  world.start();

  const persistence = new PersistenceManager(world, store, config.persistIntervalMs);
  persistence.start();

  const net = createRealtimeServer({ world, store, persistence, config });

  const server = net.httpServer.listen(config.port, '0.0.0.0', () => {
    log.info(`HTTP + Socket.IO em 0.0.0.0:${config.port} (health: /health)`);
  });
  server.keepAliveTimeout = 65_000;

  // métricas no log a cada minuto (útil em produção/Render)
  const metricsTimer = setInterval(() => {
    const m = world.metricsSnapshot();
    log.info(
      `tick=${m.tick} ants=${m.ants}/${m.antsDetailed}d pred=${m.predators} ` +
      `players=${m.players.total} col=${m.colonies} struct=${m.structures} ` +
      `chunks=${m.chunks} tickMs=${m.tickMsAvg} clima=${m.weather}${m.night ? ' noite' : ''}`
    );
  }, 60_000);
  if (metricsTimer.unref) metricsTimer.unref();

  // ---------------------------------------------------------------- shutdown
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Sinal ${signal}: encerrando com segurança...`);
    world.stop();
    clearInterval(metricsTimer);
    await persistence.shutdown();
    await net.close().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 6000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    log.error('Promise rejeitada sem tratamento:', err?.stack || err);
  });
  process.on('uncaughtException', (err) => {
    log.error('Exceção não tratada:', err?.stack || err);
    if (isProd) shutdown('uncaughtException');
  });

  return { world, store, persistence, net, server };
}

main().catch((err) => {
  console.error('[boot] falha ao iniciar:', err);
  process.exit(1);
});
