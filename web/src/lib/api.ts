// Fetching from the Roadalyx API: a per-URL promise cache, and a hook that keeps each
// response tied to the URL (that is, the filter selection) it was requested for.
import { useEffect, useState } from 'react';

// Several panels ask for the same URL (e.g. /meta); they share one request.
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

/** Responses belong to their URL: never show old figures under a new selection. */
export function useApi<T>(url: string | null): Loaded<T> {
  const [state, setState] = useState<Loaded<T> & { url: string | null }>({ url, data: null, error: null, loading: !!url });
  useEffect(() => {
    if (!url) return;
    let live = true;
    setState({ url, data: null, loading: true, error: null });
    getJson<T>(url).then(
      (data) => live && setState({ url, data, error: null, loading: false }),
      (e: Error) => live && setState({ url, data: null, error: e.message, loading: false }),
    );
    return () => { live = false; };
  }, [url]);
  // In the render right after the URL changes, the effect has not run yet: report loading, not the old data.
  return url && state.url === url ? state : { data: null, error: null, loading: !!url };
}
