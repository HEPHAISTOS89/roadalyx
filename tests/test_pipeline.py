"""Cleaning and metric rules, checked on a small synthetic export and, when present, on the real file."""

import csv

from datetime import date
from pathlib import Path

import pytest

from roadalyx import cris, dataset, metrics
from roadalyx.__main__ import main
from roadalyx.dataset import Dataset, load

FIXTURE = Path(__file__).parent / "fixtures" / "mini_export.csv"
REAL = Path(__file__).parents[1] / "data" / "raw" / "district_crashes.csv"


@pytest.fixture(scope="module")
def export():
    return cris.read_export(FIXTURE)


@pytest.fixture(scope="module")
def crashes(export):
    return {c["id"]: c for c in cris.build_crashes(export.persons)}


def test_header_lines_are_skipped_and_declared_counts_read(export):
    assert export.persons.columns[0] == "Crash ID"  # BOM stripped too
    assert (export.declared_crashes, export.declared_units, export.declared_persons) == (4, 5, 7)
    assert export.filters == ["Crash Year Is In  2024 or 2025", "TxDOT District Is Equal To LUBBOCK"]


def test_one_record_per_crash_not_per_person(export, crashes):
    assert len(export.persons) == 7
    assert len(crashes) == 4
    assert crashes[100]["people"] == 3
    assert cris.conflicting_crashes(export.persons) == 0


def test_factor_lists_are_split_on_both_separators(crashes):
    # "A; B" and "A;B" must give the same token, or one factor is counted as two
    assert crashes[100]["factors"] == ["FAILED TO CONTROL SPEED", "UNSAFE SPEED"]
    assert crashes[102]["factors"] == ["FAILED TO CONTROL SPEED", "DRIVER INATTENTION"]


def test_sentinels_and_codes(crashes):
    c = crashes[100]
    assert c["lat"] is None and c["lon"] is None        # "No Data"
    assert c["speed_limit"] is None                     # -1 means unknown
    assert (c["hour"], c["time"]) == (0, "00:05")       # HHMM integer 5
    assert crashes[103]["lat"] is None                  # 0,0 is outside Texas
    assert crashes[103]["hour"] is None                 # 2460 is not a time
    assert crashes[101]["weather"] == "RAIN"            # "3 - RAIN" loses its code


def test_inconsistent_casing_is_normalised(crashes):
    assert crashes[102]["county"] == "LUBBOCK"          # "lubbock " in the file
    assert crashes[100]["at_intersection"] is True      # "true"
    assert crashes[101]["construction_zone"] is True    # "YES"
    assert crashes[101]["school_zone"] is False         # "no"
    assert crashes[101]["rural"] is True                # "Yes"


def test_vulnerable_road_users_come_from_person_rows(crashes):
    assert crashes[100]["vru"] == ["pedestrian"]
    assert crashes[102]["vru"] == ["motorcyclist"]
    assert crashes[101]["vru"] == []


def test_metrics(crashes):
    records = list(crashes.values())
    sev = metrics.severity_counts(records)
    assert [s["crashes"] for s in sev["severity"]] == [1, 1, 1, 1]
    assert sev["deaths"] == 1 and sev["ka_share"] == 0.5

    top = metrics.top_factors(records)
    assert top["factors"][0] == {"rank": 1, "factor": "FAILED TO CONTROL SPEED", "crashes": 2,
                                 "share": 0.5, "ka_crashes": 1, "ka_share": 0.5}
    assert all(f["factor"] not in metrics.NON_CAUSAL_FACTORS for f in top["factors"])
    assert top["crashes_without_coded_factor"] == 2  # NONE only, OTHER only

    coverage = (date(2024, 3, 5), date(2025, 12, 31))
    years = metrics.trend(records, "year", coverage)["buckets"]
    assert [(b["key"], b["crashes"], b["complete"]) for b in years] == [(2024, 3, False), (2025, 1, True)]
    months = metrics.trend(records, "month", coverage)["buckets"]
    assert len(months) == 22 and months[0]["key"] == "2024-03" and months[0]["complete"] is False
    hours = metrics.trend(records, "hour", coverage)
    assert hours["unknown"] == 1 and sum(b["crashes"] for b in hours["buckets"]) == 3


def test_cli_refuses_an_export_that_disagrees_with_its_header(tmp_path):
    bad = tmp_path / "bad.csv"
    bad.write_text(FIXTURE.read_text(encoding="utf-8").replace("4 Crashes", "5 Crashes"), encoding="utf-8")
    out = tmp_path / "crashes.json.gz"
    assert main([str(bad), "--out", str(out)]) == 1 and not out.exists()
    assert main([str(bad), "--out", str(out), "--force"]) == 0 and out.exists()


def test_cli_writes_a_loadable_dataset(tmp_path):
    out = tmp_path / "crashes.json.gz"
    assert main([str(FIXTURE), "--out", str(out)]) == 0
    data = load(str(out))
    assert len(data.crashes) == 4 and data.meta["declared"]["crashes"] == 4


@pytest.mark.skipif(not REAL.exists(), reason="real CRIS export not present (data/raw is not committed)")
def test_real_export_matches_its_own_header():
    export = cris.read_export(REAL)
    records = cris.build_crashes(export.persons)
    assert len(records) == export.declared_crashes == 24_261
    assert len(export.persons) == export.declared_persons
    assert cris.conflicting_crashes(export.persons) == 0
    # severity on the crash equals its worst person injury, so K crashes carry deaths and others none
    assert all((c["severity"] == "K") == (c["deaths"] > 0) for c in records)
    data = Dataset(records, {})
    assert data.coverage == (date(2020, 1, 1), date(2026, 10, 20))
    # the same crashes, counted three ways, give the same total
    assert sum(s["crashes"] for s in metrics.severity_counts(records)["severity"]) == len(records)
    for by in ("year", "month", "hour", "weekday"):
        t = metrics.trend(records, by, data.coverage)
        assert sum(b["crashes"] for b in t["buckets"]) + t["unknown"] == len(records)


@pytest.mark.parametrize("column,value", [
    ("Crash Date", ""), ("Crash Date", "No Data"), ("Crash Date", "2024-02-30"),
    ("Crash ID", ""), ("Crash ID", "abc"), ("Crash ID", "0"),
])
def test_missing_or_invalid_required_fields_are_rejected(export, column, value):
    persons = export.persons.copy()
    persons[column] = value
    with pytest.raises(ValueError, match=column):
        cris.build_crashes(persons)


@pytest.mark.parametrize("force", [False, True])
@pytest.mark.parametrize("case", ["date", "id", "empty"])
def test_cli_keeps_existing_output_when_input_is_invalid(export, tmp_path, capsys, case, force):
    persons = export.persons.copy()
    if case == "empty":
        persons = persons.iloc[:0]
    else:
        persons["Crash Date" if case == "date" else "Crash ID"] = ""
    source = FIXTURE.read_text(encoding="utf-8-sig")
    preamble = source[:source.index('"Crash ID"')]
    bad = tmp_path / "bad.csv"
    bad.write_text(preamble + persons.to_csv(index=False, quoting=csv.QUOTE_ALL), encoding="utf-8")
    out = tmp_path / "crashes.json.gz"
    out.write_bytes(b"previous valid dataset")
    args = [str(bad), "--out", str(out)] + (["--force"] if force else [])
    assert main(args) == 1
    assert out.read_bytes() == b"previous valid dataset"
    assert "ERROR:" in capsys.readouterr().err


def test_cli_validates_dataset_before_replacing_output(tmp_path, monkeypatch, capsys):
    def reject_dataset(*args):
        raise ValueError("dataset validation failed")
    monkeypatch.setattr("roadalyx.dataset.Dataset", reject_dataset)
    out = tmp_path / "crashes.json.gz"
    out.write_bytes(b"previous valid dataset")
    assert main([str(FIXTURE), "--out", str(out)]) == 1
    assert out.read_bytes() == b"previous valid dataset"
    assert "dataset validation failed" in capsys.readouterr().err


def test_dataset_rejects_empty_input_and_duplicate_ids(crashes):
    with pytest.raises(ValueError, match="no crash records"):
        Dataset([], {})
    records = list(crashes.values())
    with pytest.raises(ValueError, match="duplicate Crash ID"):
        Dataset([records[0], records[0]], {})


@pytest.mark.parametrize("value,expected", [
    ("NA", None), (" unknown ", None), ("", None), ("No Data", None),
    ("NA ST", "NA ST"), ("19TH ST", "19TH ST"),
])
def test_unknown_streets_are_missing_not_named_roads(export, value, expected):
    persons = export.persons.copy()
    persons["Street Name"] = value
    assert all(c["street"] == expected for c in cris.build_crashes(persons))


def test_street_placeholders_do_not_change_other_categories(export):
    persons = export.persons.copy()
    persons["Street Name"] = "UNKNOWN"
    persons["First Harmful Event"] = "UNKNOWN"
    assert all(c["street"] is None and c["first_event"] == "UNKNOWN" for c in cris.build_crashes(persons))


@pytest.mark.parametrize("column", [
    "Crash Death Count", "Crash Suspected Serious Injury Count", "Crash Total Injury Count",
])
@pytest.mark.parametrize("value", ["", "No Data", "NaN", "abc", "-1", "1.5"])
def test_unknown_or_invalid_victim_counts_are_not_zero(export, column, value):
    persons = export.persons.copy()
    persons[column] = value
    with pytest.raises(ValueError, match=column):
        cris.build_crashes(persons)


@pytest.mark.parametrize("force", [False, True])
def test_cli_preserves_output_on_unknown_victim_count(export, tmp_path, capsys, force):
    persons = export.persons.copy()
    persons["Crash Death Count"] = ""
    source = FIXTURE.read_text(encoding="utf-8-sig")
    preamble = source[:source.index('"Crash ID"')]
    bad = tmp_path / "bad.csv"
    bad.write_text(preamble + persons.to_csv(index=False, quoting=csv.QUOTE_ALL), encoding="utf-8")
    out = tmp_path / "crashes.json.gz"
    out.write_bytes(b"previous valid dataset")
    args = [str(bad), "--out", str(out)] + (["--force"] if force else [])
    assert main(args) == 1
    assert out.read_bytes() == b"previous valid dataset"
    assert "Crash Death Count" in capsys.readouterr().err


@pytest.mark.parametrize("existing", [False, True])
@pytest.mark.parametrize("stage", ["serialization", "write", "replace"])
def test_failed_save_preserves_destination_and_removes_temporary_file(crashes, tmp_path, monkeypatch, existing, stage):
    out = tmp_path / "crashes.json.gz"
    if existing:
        out.write_bytes(b"previous valid dataset")

    def fail(*args, **kwargs):
        raise OSError("simulated failure")

    if stage == "serialization":
        monkeypatch.setattr(dataset.json, "dumps", fail)
    elif stage == "write":
        monkeypatch.setattr(dataset.gzip.GzipFile, "write", fail)
    else:
        monkeypatch.setattr(Path, "replace", fail)
    with pytest.raises(OSError, match="simulated failure"):
        dataset.save(out, list(crashes.values()), {})
    if existing:
        assert out.read_bytes() == b"previous valid dataset"
    else:
        assert not out.exists()
    assert set(tmp_path.iterdir()) == ({out} if existing else set())


def test_successful_save_replaces_file_and_is_deterministic(crashes, tmp_path):
    records = list(crashes.values())
    first, second = tmp_path / "first.json.gz", tmp_path / "second.json.gz"
    first.write_bytes(b"previous dataset")
    dataset.save(first, records, {})
    dataset.save(second, records, {})
    assert load(str(first)).crashes == records
    assert first.read_bytes() == second.read_bytes()
    assert set(tmp_path.iterdir()) == {first, second}


def test_cli_reports_a_write_failure_without_losing_previous_output(tmp_path, monkeypatch, capsys):
    out = tmp_path / "crashes.json.gz"
    out.write_bytes(b"previous valid dataset")

    def fail(*args, **kwargs):
        raise OSError("simulated write failure")

    monkeypatch.setattr(dataset.gzip.GzipFile, "write", fail)
    assert main([str(FIXTURE), "--out", str(out)]) == 1
    assert "ERROR: simulated write failure" in capsys.readouterr().err
    assert out.read_bytes() == b"previous valid dataset"
    assert set(tmp_path.iterdir()) == {out}


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_save_rejects_non_finite_json_without_replacing_output(crashes, tmp_path, value):
    out = tmp_path / "crashes.json.gz"
    out.write_bytes(b"previous valid dataset")
    with pytest.raises(ValueError):
        dataset.save(out, list(crashes.values()), {"invalid_number": value})
    assert out.read_bytes() == b"previous valid dataset"
    assert set(tmp_path.iterdir()) == {out}
