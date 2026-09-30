import { useSyncExternalStore } from "react";

export const PHONE = "(max-width: 639px)";
export const TABLET = "(max-width: 899px)";
export const RAIL = "(max-width: 1199px)";
export const COARSE = "(pointer: coarse)";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
