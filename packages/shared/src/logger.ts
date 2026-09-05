import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  requestId?: string;
  userId?: string | null;
  workspaceId?: string | null;
  taskId?: string | null;
  agent?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  credentialId?: string | null;
  poolId?: string | null;
  latencyMs?: number;
  ttftMs?: number | null;
  tokens?: number;
  cost?: number;
  fallback?: number;
  errorCode?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derive a logger that stamps every line with the given fields. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** 'json' for machine ingestion, 'pretty' for a terminal. */
  format?: 'json' | 'pretty';
  sink?: (line: string) => void;
}

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[2;37m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

/**
 * Structured logger. Every field passed in is run through {@link redact}
 * before it is emitted, so a credential cannot reach a log sink even if a
 * caller hands one over by accident.
 */
export function createLogger(opts: LoggerOptions = {}, base: LogFields = {}): Logger {
  const level = opts.level ?? 'info';
  const format = opts.format ?? 'json';
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const min = ORDER[level];

  const emit = (lvl: LogLevel, msg: string, fields?: LogFields): void => {
    if (ORDER[lvl] < min) return;
    const merged = redact({ ...base, ...(fields ?? {}) }) as LogFields;
    const safeMsg = redact(msg);
    if (format === 'json') {
      sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg: safeMsg, ...merged }));
      return;
    }
    const extras = Object.entries(merged)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' ');
    const ts = new Date().toISOString().slice(11, 23);
    sink(`${COLORS[lvl]}${lvl.padEnd(5)}\x1b[0m \x1b[2m${ts}\x1b[0m ${safeMsg}${extras ? ` \x1b[2m${extras}\x1b[0m` : ''}`);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger(opts, { ...base, ...fields }),
  };
}

/** A logger that discards everything — used by tests. */
export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};
