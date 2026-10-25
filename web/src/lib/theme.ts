// Light/dark theme: React reads it from the <html> attribute, so the map and 3D scene can rebuild on a switch.
import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

/** The theme lives on <html data-theme>; public/theme.js sets it before the first paint (saved choice, else light). */
const read = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
const subscribe = (cb: () => void) => {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
};

export const useTheme = () => useSyncExternalStore(subscribe, read, () => 'light' as Theme);

/** Apply and remember a theme, updating the browser chrome colour too. */
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
