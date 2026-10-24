const n0 = new Intl.NumberFormat('en-US');
export const int = (v: number | null | undefined) => (v == null ? '–' : n0.format(v));
export const pct = (v: number | null | undefined, digits = 1) => (v == null ? '–' : `${(v * 100).toFixed(digits)}%`);

/** CRIS writes labels in capitals; display them in sentence case, keeping road codes and acronyms. */
const KEEP = new Set(['US', 'FM', 'RM', 'IH', 'SH', 'SL', 'CR', 'ROW', 'HOV', 'K', 'A', 'B', 'C']);
export function title(v: string | null | undefined) {
  if (!v) return '–';
  return v.split(/(\s+|-|\/|\()/).map((w, i) => (KEEP.has(w) ? w : i === 0 ? w.charAt(0) + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
}
export const county = (v: string | null | undefined) => (v ? v.charAt(0) + v.slice(1).toLowerCase() : '–');
export const dateLong = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
