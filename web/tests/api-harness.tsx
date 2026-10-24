// Isolated browser fixture. Not referenced by the production entry point.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useApi } from '../src/lib/api';
const pending = new Map<string, (r: Response) => void>();
const nativeFetch = window.fetch;
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  return url.startsWith('/fixture/') ? new Promise<Response>((resolve) => pending.set(url, resolve)) : nativeFetch(input, init);
}) as typeof fetch;
const resolve = (url: string, value: number) => pending.get(url)?.(new Response(JSON.stringify({ value }), { headers: { 'Content-Type': 'application/json' } }));
function Harness() {
  const [url, setUrl] = useState<string | null>('/fixture/a');
  const state = useApi<{ value: number }>(url);
  return <main><h1>useApi regression fixture</h1>
    <p>Current URL: {url ?? 'disabled'}</p>
    <output aria-label="Result">{JSON.stringify(state)}</output>
    <button onClick={() => resolve('/fixture/a', 11)}>Resolve A</button>
    <button onClick={() => setUrl('/fixture/b')}>Select B</button>
    <button onClick={() => resolve('/fixture/b', 22)}>Resolve B</button>
    <button onClick={() => setUrl('/fixture/c')}>Select C</button>
    <button onClick={() => setUrl('/fixture/d')}>Select D</button>
    <button onClick={() => resolve('/fixture/c', 33)}>Resolve late C</button>
    <button onClick={() => resolve('/fixture/d', 44)}>Resolve D</button>
    <button onClick={() => setUrl(null)}>Disable request</button>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
