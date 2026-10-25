"""Release pruning with a fake AWS command; these tests never contact AWS."""

import os
from pathlib import Path
import subprocess

import pytest


pytestmark = pytest.mark.skipif(os.name == "nt", reason="The deployment script runs in Bash on Unix")


@pytest.mark.parametrize("keys,list_status,delete_status,expected_status,deleted", [
    ("", 0, 0, 0, []),
    ("None\n", 0, 0, 0, []),
    ("\n", 0, 0, 0, []),
    ("releases/old-a.zip\treleases/old-b.zip\n", 0, 0, 0,
     ["s3://test-bucket/releases/old-a.zip", "s3://test-bucket/releases/old-b.zip"]),
    ("", 7, 0, 7, []),
    ("releases/old-a.zip\treleases/old-b.zip", 0, 8, 8,
     ["s3://test-bucket/releases/old-a.zip"]),
])
def test_release_pruning_keeps_empty_success_and_real_errors(
    tmp_path, keys, list_status, delete_status, expected_status, deleted,
):
    script = (Path(__file__).parents[1] / "scripts" / "deploy.sh").read_text()
    # Exercise the actual function without running the deployment's other commands.
    function = script.split("prune_releases() {", 1)[1].split("\n}", 1)[0]
    log = tmp_path / "deleted.txt"
    shell = r'''
set -euo pipefail
BUCKET=test-bucket
aws() {
  if [[ "$1" == s3api && "$2" == list-objects-v2 ]]; then
    printf '%s' "$KEYS"
    return "$LIST_STATUS"
  fi
  if [[ "$1" == s3 && "$2" == rm ]]; then
    printf '%s\n' "$3" >> "$DELETE_LOG"
    return "$DELETE_STATUS"
  fi
  return 99
}
prune_releases() {''' + function + r'''
}
prune_releases
printf 'smoke test reached\n'
'''
    result = subprocess.run(["bash", "-c", shell], capture_output=True, text=True,
                            env={**os.environ, "KEYS": keys, "LIST_STATUS": str(list_status),
                                 "DELETE_STATUS": str(delete_status), "DELETE_LOG": str(log)})
    assert result.returncode == expected_status, result.stderr
    assert (log.read_text().splitlines() if log.exists() else []) == deleted
    assert ("smoke test reached" in result.stdout) == (expected_status == 0)
