import { Check, CircleAlert, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "../lib/cx.ts";

type Action = { label: string; run: () => void };
type Toast = { id: number; kind: "success" | "error" | "info"; message: string; action?: Action };
export type ToastApi = {
  success(message: string, action?: Action): void;
  info(message: string, action?: Action): void;
  error(err: unknown): void;
};

const Context = createContext<ToastApi | null>(null);
const ICONS = { success: Check, error: CircleAlert, info: Info };

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (kind: Toast["kind"], message: string, action?: Action) => {
      const id = next.current++;
      setToasts((all) => [...all.slice(-2), { id, kind, message, action }]);
      if (kind !== "error") setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      success: (m, a) => push("success", m, a),
      info: (m, a) => push("info", m, a),
      error: (e) => push("error", errorMessage(e)),
    }),
    [push],
  );
  return (
    <Context.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => {
          const Icon = ICONS[t.kind];
          return (
            <div key={t.id} className={cx("toast", `toast-${t.kind}`)} role={t.kind === "error" ? "alert" : "status"}>
              <Icon size={16} aria-hidden className="toast-icon" />
              <span className="toast-message">{t.message}</span>
              {t.action && (
                <button
                  type="button"
                  className="toast-action"
                  onClick={() => {
                    t.action!.run();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </Context.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(Context);
  if (!api) throw new Error("useToast must be used inside ToastProvider");
  return api;
}
