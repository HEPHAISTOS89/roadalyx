"""Process a CRIS export: validate it, print the required metrics, write the processed dataset.

    python -m roadalyx data/raw/district_crashes.csv [--out data/processed/crashes.json.gz]

This is the pipeline's entry point. It uses the functions in cris.py in order, refuses to write
anything if the cleaned crash count disagrees with the totals in the export header, prints the
three required metrics, and writes the gzipped JSON file that the API serves (locally or from S3).
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import cris, dataset, metrics


def main(argv: list[str] | None = None) -> int:
    """Parse the command line and run the pipeline; returns the process exit code."""
    parser = argparse.ArgumentParser(prog="python -m roadalyx", description=__doc__.splitlines()[0])
    parser.add_argument("csv", type=Path, help="CRIS query export (CSV)")
    parser.add_argument("--out", type=Path, default=Path("data/processed/crashes.json.gz"))
    parser.add_argument("--force", action="store_true", help="write the dataset even if the checks fail")
    args = parser.parse_args(argv)
    # A bad export is a user error, not a crash: print one readable line and exit with code 1.
    try:
        return _process(args)
    except (ValueError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


def _process(args: argparse.Namespace) -> int:
    """Read, check, clean, report, write."""
    # Read the export and build one record per crash (see cris.py for every cleaning rule).
    export = cris.read_export(args.csv)
    persons = export.persons
    conflicts = cris.conflicting_crashes(persons)
    crashes = cris.build_crashes(persons)

    # The export header states how many crashes and persons it holds: the cleaned table must agree.
    problems = []
    if export.declared_crashes is not None and export.declared_crashes != len(crashes):
        problems.append(f"header declares {export.declared_crashes:,} crashes, found {len(crashes):,}")
    if export.declared_persons is not None and export.declared_persons != len(persons):
        problems.append(f"header declares {export.declared_persons:,} persons, found {len(persons):,} rows")
    if conflicts:
        problems.append(f"{conflicts} crashes have person rows that disagree on crash-level fields")
    for p in problems:
        print(f"ERROR: {p}", file=sys.stderr)
    if problems and not args.force:
        print(f"Nothing written to {args.out}. Fix the export or pass --force.", file=sys.stderr)
        return 1

    # Provenance travels with the data: the API shows it in /api/v1/meta and every figure can be traced back.
    meta = {
        "source": "TxDOT Crash Records Information System (CRIS), query export",
        "source_file": args.csv.name,
        "filters": export.filters,
        "declared": {"crashes": export.declared_crashes, "units": export.declared_units,
                     "persons": export.declared_persons},
        "person_rows": len(persons),
        "crashes": len(crashes),
        "conflicting_crashes": conflicts,
        "missing_coordinates": sum(1 for c in crashes if c["lat"] is None or c["lon"] is None),
        "unknown_speed_limit": sum(1 for c in crashes if c["speed_limit"] is None),
        "processed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    }
    # Check the dataset and compute the report before replacing an existing output file.
    data = dataset.Dataset(crashes, meta)
    summary = report(data)
    out = dataset.save(args.out, crashes, meta)
    print(summary)
    print(f"\nWrote {len(crashes):,} crash records to {out} ({out.stat().st_size / 1e6:.1f} MB)")
    return 0


def report(data: dataset.Dataset) -> str:
    """The three required metrics, as plain text: severity counts, top 5 factors, crashes per year."""
    crashes = data.crashes
    sev = metrics.severity_counts(crashes)
    top = metrics.top_factors(crashes)
    years = metrics.trend(crashes, "year", data.coverage)
    start, end = data.coverage
    lines = [
        f"{len(crashes):,} crashes from {data.meta['person_rows']:,} person rows, {start} to {end}",
        "",
        "Crashes by severity (KABCO)",
        *(f"  {s['code']}  {s['label']:<26} {s['crashes']:>7,}  {s['share']:6.1%}" for s in sev["severity"]),
        "",
        "Top 5 contributing factors (crashes citing each factor)",
        *(f"  {f['rank']}. {f['factor']:<48} {f['crashes']:>6,}  {f['share']:6.1%}" for f in top["factors"]),
        f"  ({top['crashes_without_coded_factor']:,} crashes cite no coded factor: NONE or OTHER only)",
        "",
        "Crashes per year",
        *(f"  {b['label']}  {b['crashes']:>6,}{'' if b['complete'] else '  (partial year)'}" for b in years["buckets"]),
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(main())
