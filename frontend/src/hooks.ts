import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

// ---------------------------------------------------------------- routing
// Hash routes keep the static build servable from any host without rewrites.

function subscribeHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean);
}

export const href = (...parts: string[]) => `#/${parts.join("/")}`;

export function navigate(...parts: string[]) {
  window.location.hash = href(...parts);
}

// ---------------------------------------------------------------- motion

const reducedQuery = () => window.matchMedia("(prefers-reduced-motion: reduce)");

function subscribeReduced(callback: () => void) {
  const query = reducedQuery();
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, () => reducedQuery().matches);
}

// ---------------------------------------------------------------- data

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const run = useCallback(load, deps);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    run()
      .then((value) => !cancelled && (setData(value), setError(null)))
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [run]);

  return { data, error, loading, setData };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
