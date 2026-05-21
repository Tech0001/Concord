import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Personal / work category — drives the header viewing toggle. Stored
 * values on the server are 'personal' | 'work'; "both" is a UI-only
 * state meaning "no filter".
 *
 * Consumers should:
 *   - Read `category` to bind to UI controls + send as a query param.
 *   - Read `serverCategory` when building API URLs — it's "" for "both"
 *     so you don't even need to send the param (server defaults to no
 *     filter when missing).
 *   - Subscribe to `category` in deps arrays of fetch effects so they
 *     re-run when the toggle flips.
 */
export type Category = "personal" | "work" | "both";

const STORAGE_KEY = "concord-category-v1";

function readStored(): Category {
  if (typeof window === "undefined") return "both";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "personal" || v === "work" || v === "both" ? v : "both";
}

interface CategoryContextValue {
  category: Category;
  serverCategory: "" | "personal" | "work";
  setCategory: (c: Category) => void;
}

const CategoryContext = createContext<CategoryContextValue | null>(null);

export function CategoryProvider({ children }: { children: ReactNode }) {
  const [category, setCategoryState] = useState<Category>(readStored);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, category);
  }, [category]);

  const setCategory = useCallback((c: Category) => setCategoryState(c), []);

  const value = useMemo<CategoryContextValue>(() => ({
    category,
    serverCategory: category === "both" ? "" : category,
    setCategory,
  }), [category, setCategory]);

  return <CategoryContext.Provider value={value}>{children}</CategoryContext.Provider>;
}

export function useCategory(): CategoryContextValue {
  const ctx = useContext(CategoryContext);
  if (!ctx) throw new Error("useCategory must be used inside CategoryProvider");
  return ctx;
}
