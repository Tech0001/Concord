import { useCallback, useState } from "react";

/** Read a stored value. Values written before JSON storage (plain strings) are still accepted. */
export function readStored<T>(key: string, fallback: T, valid: (v: unknown) => boolean = () => true): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    return valid(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage can be unavailable in a restricted webview; keep the value in memory. */
  }
}

export function useStoredState<T>(key: string, fallback: T, valid?: (v: unknown) => boolean) {
  const [value, setValue] = useState<T>(() => readStored(key, fallback, valid));
  const update = useCallback(
    (next: T | ((prev: T) => T)) =>
      setValue((prev) => {
        const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        writeStored(key, v);
        return v;
      }),
    [key],
  );
  return [value, update] as const;
}
