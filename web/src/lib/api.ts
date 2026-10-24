import { useEffect, useState } from 'react';

const cache = new Map<string, Promise<unknown>>();

/** GET a JSON endpoint once per URL; failed requests are evicted so a retry refetches. */
export function getJson<T>(url: string): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined;
  if (!p) {
    p = fetch(url, { headers: { Accept: 'application/json' } }).then(async (r) => {
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        throw new Error(body?.detail ? JSON.stringify(body.detail) : `${r.status} ${r.statusText}`);
      }
      return r.json() as Promise<T>;
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

export interface Loaded<T> { data: T | null; error: string | null; loading: boolean }

/** Data for `url`; keeps the previous answer on screen while the next one loads. */
export function useApi<T>(url: string | null): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null, loading: !!url });
  useEffect(() => {
    if (!url) return;
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    getJson<T>(url).then(
      (data) => live && setState({ data, error: null, loading: false }),
      (e: Error) => live && setState((s) => ({ ...s, error: e.message, loading: false })),
    );
    return () => { live = false; };
  }, [url]);
  return state;
}
