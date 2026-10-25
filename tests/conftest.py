"""Point the API at a dataset built from the synthetic fixture, before roadalyx.api is imported.

tests/fixtures/mini_export.csv is a hand-made CRIS export of a few crashes, laid out like the real
file (disclaimer lines, person rows) and seeded with its messiness, so every test runs without the
lab's data and gives the same numbers on any machine.
"""

import os
from pathlib import Path

from roadalyx import cris, dataset

FIXTURE = Path(__file__).parent / "fixtures" / "mini_export.csv"


def pytest_configure(config):
    out = Path(config.rootpath) / ".pytest_cache" / "fixture-crashes.json.gz"
    dataset.save(out, cris.build_crashes(cris.read_export(FIXTURE).persons), {"source": "test fixture"})
    os.environ["ROADALYX_DATA"] = str(out)
    os.environ["ROADALYX_WEB"] = str(out.parent / "no-portal")  # API only
