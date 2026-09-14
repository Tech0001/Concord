import { inspect } from "node:util";

export type RuntimeLogLevel = "log" | "info" | "warn" | "error" | "debug";

export interface RuntimeLogEntry {
  id: number;
  timestamp: string;
  level: RuntimeLogLevel;
  message: string;
}

type RuntimeLogListener = (entry: RuntimeLogEntry) => void;

interface RuntimeLogState {
  installed: boolean;
  nextId: number;
  entries: RuntimeLogEntry[];
  listeners: Set<RuntimeLogListener>;
}

const RUNTIME_LOG_STATE = Symbol.for("concord.runtime-log-state");
const MAX_ENTRIES = 2_000;

function getState(): RuntimeLogState {
  const root = globalThis as typeof globalThis & Record<symbol, unknown>;
  let state = root[RUNTIME_LOG_STATE] as RuntimeLogState | undefined;
  if (!state) {
    state = {
      installed: false,
      nextId: 1,
      entries: [],
      listeners: new Set(),
    };
    root[RUNTIME_LOG_STATE] = state;
  }
  return state;
}

function formatArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  return inspect(value, {
    breakLength: 140,
    colors: false,
    compact: 3,
    depth: 6,
    maxArrayLength: 100,
  });
}

function appendRuntimeLog(level: RuntimeLogLevel, args: unknown[]): void {
  const state = getState();
  const entry: RuntimeLogEntry = {
    id: state.nextId++,
    timestamp: new Date().toISOString(),
    level,
    message: args.map(formatArgument).join(" "),
  };
  state.entries.push(entry);
  if (state.entries.length > MAX_ENTRIES) {
    state.entries.splice(0, state.entries.length - MAX_ENTRIES);
  }
  state.listeners.forEach(listener => {
    try {
      listener(entry);
    } catch {
      // Logging must never be able to crash the server.
    }
  });
}

/**
 * Capture the process console once while preserving normal stdout/stderr.
 * The state lives on globalThis via Symbol.for so Electron's main bundle and
 * the separately-built server bundle share one scrollback buffer.
 */
export function installRuntimeLogCapture(): void {
  const state = getState();
  if (state.installed) return;
  state.installed = true;

  const original: Record<RuntimeLogLevel, (...args: unknown[]) => void> = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  for (const level of Object.keys(original) as RuntimeLogLevel[]) {
    console[level] = (...args: unknown[]) => {
      original[level](...args);
      appendRuntimeLog(level, args);
    };
  }
}

export function getRuntimeLogs(afterId = 0): RuntimeLogEntry[] {
  return getState().entries.filter(entry => entry.id > afterId);
}

export function subscribeRuntimeLogs(listener: RuntimeLogListener): () => void {
  const state = getState();
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function clearRuntimeLogs(): void {
  getState().entries.length = 0;
}

// Importing this module is enough to capture standalone-server startup logs.
// Electron also calls the exported installer explicitly; the operation is
// idempotent across both bundles.
installRuntimeLogCapture();
