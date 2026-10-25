// Shapes returned by the Roadalyx API (roadalyx/schemas.py is the source of truth).
export type Sev = 'K' | 'A' | 'B' | 'C';
export const SEVS: Sev[] = ['K', 'A', 'B', 'C'];

export interface Applied {
  county: string[]; severity: Sev[]; road_class: string[]; vru: string[];
  year_from: number | null; year_to: number | null; factor: string | null;
}
interface Filtered { filters: Applied; total: number }

export interface Choice { value: string; label: string; crashes: number }
export interface Meta {
  dataset: {
    source: string; source_file: string; filters: string[]; person_rows: number; crashes: number;
    declared: { crashes: number | null; units: number | null; persons: number | null };
    missing_coordinates: number; unknown_speed_limit: number; conflicting_crashes: number; processed_at: string;
  };
  coverage: { start: string; end: string };
  filters: { county: Choice[]; road_class: Choice[]; factor: Choice[]; year: number[]; severity: Sev[]; vru: string[] };
  definitions: Record<string, unknown> & { severity: Record<Sev, string> };
}
export interface SeverityRes extends Filtered {
  severity: { code: Sev; label: string; crashes: number; share: number | null }[];
  ka_share: number | null; deaths: number; serious_injuries: number;
}
export interface FactorRow { rank: number; factor: string; crashes: number; share: number | null; ka_crashes: number; ka_share: number }
export interface FactorsRes extends Filtered { crashes_without_coded_factor: number; factors: FactorRow[] }
export interface Bucket { key: number | string; label: string; complete: boolean; crashes: number; K: number; A: number; B: number; C: number }
export interface TrendRes extends Filtered { by: 'year' | 'month' | 'hour' | 'weekday'; unknown: number; buckets: Bucket[] }
export interface HeatmapRes extends Filtered { rows: string[]; crashes: number[][]; ka_crashes: number[][] }
export interface Group { value: string | number | boolean | null; crashes: number; K: number; A: number; B: number; C: number; ka_share: number | null; deaths: number }
export interface BreakdownRes extends Filtered { by: string; groups: Group[] }
export interface Crash {
  id: number; date: string; time: string | null; year: number; month: number; weekday: number; hour: number | null;
  county: string | null; severity: Sev; deaths: number; serious_injuries: number; injuries: number; people: number;
  factors: string[]; road_class: string | null; speed_limit: number | null; lat: number | null; lon: number | null;
  rural: boolean | null; intersection: string | null; at_intersection: boolean | null; weather: string | null;
  collision: string | null; first_event: string | null; street: string | null; construction_zone: boolean | null;
  school_zone: boolean | null; reportable: boolean | null; vru: string[];
}
export interface CrashPage extends Filtered { limit: number; offset: number; crashes: Crash[] }
export interface Points extends Filtered { located: number; start: string; id: number[]; lon: number[]; lat: number[]; severity: string; day: number[]; streets: string[]; street: number[] }
