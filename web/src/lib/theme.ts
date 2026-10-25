import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

/** The theme lives on <html data-theme>; public/theme.js sets it before the first paint (saved choice, else the system's). */
const read = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const subscribe = (cb: () => void) => {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
};

export const useTheme = () => useSyncExternalStore(subscribe, read, () => 'dark' as Theme);

export function setTheme(t: Theme) {
  const apply = () => {
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#f4f2ee' : '#101010');
  };
  try { localStorage.setItem('theme', t); } catch { /* private mode: the choice lasts for this page only */ }
  // A cross-fade of the whole page where the browser supports it; a plain switch elsewhere.
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(apply);
  else apply();
}
