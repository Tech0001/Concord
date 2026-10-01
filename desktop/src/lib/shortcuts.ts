import { useEffect, useRef } from "react";

export type KeyInput = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
};
export type Shortcut = {
  key: string;
  shift?: boolean;
  mod?: boolean;
  /** Fire even when focus is in a text field or a dialog is open (global mod shortcuts only). */
  global?: boolean;
  run: (e: KeyboardEvent) => void;
};
type ElementLike = {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  role?: string | null;
  getAttribute?: (name: string) => string | null;
};

export function isTypingTarget(target: unknown): boolean {
  const el = target as ElementLike | null;
  if (!el || typeof el !== "object") return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !["checkbox", "radio", "button", "submit", "reset"].includes((el.type ?? "text").toLowerCase());
}

export function isInteractiveTarget(target: unknown): boolean {
  const el = target as ElementLike | null;
  if (!el || typeof el !== "object") return false;
  const tag = (el.tagName ?? "").toUpperCase();
  const role = el.role ?? el.getAttribute?.("role") ?? "";
  return ["BUTTON", "A", "SUMMARY"].includes(tag) || ["button", "menuitem", "slider", "radio", "tab", "option"].includes(role);
}

export function matches(e: KeyInput, s: Shortcut): boolean {
  const mod = e.ctrlKey || e.metaKey;
  if (!!s.mod !== mod || e.altKey) return false;
  if (s.shift !== undefined && s.shift !== e.shiftKey) return false;
  return e.key.toLowerCase() === s.key.toLowerCase();
}

export function useShortcuts(shortcuts: Shortcut[], enabled = true): void {
  const current = useRef(shortcuts);
  current.current = shortcuts;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const typing = isTypingTarget(e.target);
      const dialogOpen = !!document.querySelector('[role="dialog"][data-state="open"]');
      const ownsKey =
        (e.key === " " || e.key === "Enter" || e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") &&
        isInteractiveTarget(e.target);
      for (const s of current.current) {
        if (!s.global && (typing || dialogOpen || ownsKey)) continue;
        if (matches(e, s)) {
          e.preventDefault();
          s.run(e);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
