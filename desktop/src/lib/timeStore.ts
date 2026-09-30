import { useSyncExternalStore } from "react";

export type TimeStore = { get(): number; set(t: number): void; subscribe(listener: () => void): () => void };

export function createTimeStore(initial = 0): TimeStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(t) {
      if (t === value) return;
      value = t;
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Subscribe to a derived value so a component re-renders only when that value changes. */
export function useTime<T>(store: TimeStore, select: (t: number) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => select(store.get()),
  );
}
