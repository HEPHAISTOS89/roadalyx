const n0 = new Intl.NumberFormat('en-US');
export const int = (v: number | null | undefined) => (v == null ? '–' : n0.format(v));
export const pct = (v: number | null | undefined, digits = 1) => (v == null ? '–' : `${(v * 100).toFixed(digits)}%`);

/** CRIS writes labels in capitals; display them in sentence case, keeping road codes and acronyms. */
const KEEP = new Set(['US', 'FM', 'RM', 'IH', 'SH', 'SL', 'CR', 'ROW', 'HOV', 'K', 'A', 'B', 'C']);
export function title(v: string | null | undefined) {
  if (!v) return '–';
  return v.split(/(\s+|-|\/|\()/).map((w, i) => (KEEP.has(w) ? w : i === 0 ? w.charAt(0) + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
}
/** TxDOT route codes as signed on the road: IH0027 -> I-27, SL0289 -> Loop 289, FM2255 -> FM 2255. */
const ROUTE: Record<string, string> = {
  IH: 'I-', US: 'US ', SH: 'SH ', FM: 'FM ', RM: 'RM ', SL: 'Loop ', SS: 'Spur ', CR: 'CR ', PR: 'Park Rd ',
  BU: 'Bus. US ', BS: 'Bus. SH ', BI: 'Bus. I-', BF: 'Bus. FM ',
};
export function road(v: string | null | undefined) {
  if (!v) return '–';
  const m = /^([A-Z]{2})0*(\d+)([A-Z]?)$/.exec(v);
  // city streets as on a street sign: "82ND ST" -> "82nd St"
  return m && ROUTE[m[1]] ? `${ROUTE[m[1]]}${m[2]}${m[3]}` : v.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
/** A street filter slug back to its name: 'us0084' -> 'US 84', 'slide-rd' -> 'Slide Rd'. */
export const streetName = (s: string) => road(s.toUpperCase().replace(/-/g, ' '));
export const county = (v: string | null | undefined) => (v ? v.charAt(0) + v.slice(1).toLowerCase() : '–');
export const dateLong = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
