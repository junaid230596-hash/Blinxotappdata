import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, get } from "./api";

export function useDebounce<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// Loads `path` (null = skip). Ignores stale responses so fast typing/paging never shows out-of-order data.
export function useFetch<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  useEffect(() => {
    if (path === null) { setLoading(false); return; }
    const id = ++latest.current; setLoading(true);
    get<T>(path).then((d) => { if (id === latest.current) { setData(d); setError(null); } })
      .catch((e) => { if (id === latest.current) setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", "Something went wrong")); })
      .finally(() => { if (id === latest.current) setLoading(false); });
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export function useTitle(title: string) {
  useEffect(() => { document.title = `${title} · Blinxot`; }, [title]);
}
