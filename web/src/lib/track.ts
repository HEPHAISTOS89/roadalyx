// Anonymous interaction log: what a visitor clicks, filters, zooms, drags, hovers and scrolls, in order.
// No cookie, no IP, no typed text: a random id per tab groups one visit, and labels come from the page itself.
// Sent in small batches to /api/v1/events, which writes one CloudWatch line per event.

interface Ev { t: number; a: string; d: string; p: string; n: number }

const id = (() => {
  try {
    let s = sessionStorage.getItem('rx-s');
    if (!s) sessionStorage.setItem('rx-s', (s = Math.random().toString(36).slice(2, 10).padEnd(8, '0')));
    return s;
  } catch { return Math.random().toString(36).slice(2, 10).padEnd(8, '0'); }
})();
const queue: Ev[] = [];
let last: (Ev & { at: number }) | null = null;
let deepest = 0;

const clip = (s: string | null | undefined, n = 80) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const page = () => (location.pathname + location.search).slice(0, 120);

/** Record one action; the same action on the same thing within 3 s is merged into a count. */
export function track(a: string, d = '') {
  const now = performance.now();
  d = clip(d, 200);
  if (last && last.a === a && last.d === d && last.p === page() && now - last.at < 3000) {
    last.n += 1; last.at = now; return;
  }
  last = { t: Math.round(now), a, d, p: page(), n: 1, at: now };
  queue.push(last);
  if (queue.length >= 40) flush();
}

function flush() {
  if (!queue.length) return;
  const e = queue.splice(0).map(({ t, a, d, p, n }) => ({ t, a, d, p, n }));
  last = null;
  fetch('/api/v1/events', {
    method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ s: id, e }),
  }).catch(() => {});
}

/** The chart, panel or map an element belongs to, named by its heading or label. */
function region(el: Element): string {
  const box = el.closest('section, [aria-label], dialog, header, footer');
  const h = box?.querySelector('h1, h2, h3')?.textContent;
  return clip(h || box?.getAttribute('aria-label') || box?.tagName.toLowerCase() || 'page', 60);
}

function label(el: Element): string {
  const own = el.getAttribute('aria-label') || el.textContent || el.getAttribute('title');
  const group = el.closest('fieldset')?.querySelector('legend')?.textContent;
  return clip(group ? `${group}: ${own}` : own);
}

let installed = false;
export function installTracking() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  track('start', `${innerWidth}x${innerHeight} ${document.documentElement.dataset.theme ?? ''}`);

  addEventListener('click', (e) => {
    const t = e.target as Element;
    const ctl = t.closest('button, a, [role="button"], [role="tab"], [role="option"], summary, tr[tabindex], li[tabindex]');
    if (ctl instanceof HTMLAnchorElement && ctl.host && ctl.host !== location.host) track('leave', ctl.href);
    else if (ctl) track('click', `${label(ctl)} · ${region(ctl)}`);
    else if (t.closest('canvas, svg') && !dragged) track('click', `on ${region(t)}`);
    dragged = false;
  }, true);

  addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    if (t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'search')) return; // never typed text
    const v = t instanceof HTMLInputElement && t.type === 'checkbox' ? String(t.checked) : t.value;
    track('change', `${label(t.labels?.[0] ?? t)} = ${v} · ${region(t)}`);
  }, true);

  addEventListener('wheel', (e) => { const t = e.target as Element; if (t.closest('canvas')) track('zoom', region(t)); }, { capture: true, passive: true });

  let down: { x: number; y: number; el: Element } | null = null;
  let dragged = false; // the click that ends a drag is not a click
  addEventListener('pointerdown', (e) => { const t = e.target as Element; down = t.closest('canvas') ? { x: e.clientX, y: e.clientY, el: t } : null; }, true);
  addEventListener('pointerup', (e) => {
    dragged = !!down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12;
    if (dragged) track('drag', region(down!.el));
    down = null;
  }, true);

  let hoverAt = 0;
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || performance.now() - hoverAt < 400) return;
    hoverAt = performance.now();
    const t = e.target as Element;
    if (t.closest('canvas, svg, table')) track('hover', region(t));
  }, { capture: true, passive: true });

  addEventListener('scroll', () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    const pct = max > 0 ? Math.floor((scrollY / max) * 4) * 25 : 100;
    if (pct > deepest) { deepest = pct; track('scroll', `${pct}%`); }
  }, { passive: true });

  addEventListener('fullscreenchange', () => track('fullscreen', document.fullscreenElement ? 'on' : 'off'));
  document.addEventListener('visibilitychange', () => {
    track('tab', document.visibilityState); // hidden = switched tab or app, visible = came back
    if (document.visibilityState === 'hidden') flush();
  });
  addEventListener('pagehide', flush);
  setInterval(flush, 5000);
}

/** Call on every route change; resets the scroll depth for the new page. */
export function trackPage() { deepest = 0; track('page', page()); }
