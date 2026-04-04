import { useState, useEffect, useCallback } from "react";

const apiCache = new Map<string, unknown>();

export function getApiCache<T>(key: string): T | undefined {
  return apiCache.get(key) as T | undefined;
}

export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = [], cacheKey?: string) {
  const cached = cacheKey !== undefined ? (apiCache.get(cacheKey) as T | undefined) : undefined;
  const [data, setData] = useState<T | null>(cached ?? null);
  const [loading, setLoading] = useState(cached === undefined);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    fetcher()
      .then((result) => {
        if (cacheKey !== undefined) apiCache.set(cacheKey, result);
        setData(result);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}
