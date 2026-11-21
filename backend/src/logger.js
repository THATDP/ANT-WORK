import { config } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const current = LEVELS[config.logLevel] ?? 2;

function emit(level, scope, args) {
  if (LEVELS[level] > current) return;
  const ts = new Date().toISOString().slice(11, 23);
  const tag = level.toUpperCase().padEnd(5);
  const prefix = `[${ts}] ${tag} ${scope ? `(${scope}) ` : ''}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(prefix, ...args);
}

export function createLogger(scope = '') {
  return {
    error: (...a) => emit('error', scope, a),
    warn: (...a) => emit('warn', scope, a),
    info: (...a) => emit('info', scope, a),
    debug: (...a) => emit('debug', scope, a),
    trace: (...a) => emit('trace', scope, a),
  };
}

export const log = createLogger('app');
