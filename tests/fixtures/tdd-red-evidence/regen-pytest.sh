#!/usr/bin/env bash
# Regenerate the pytest JUnit XML fixtures in this directory (#6641).
#
#   tests/fixtures/tdd-red-evidence/regen-pytest.sh
#
# Needs `uv` (https://docs.astral.sh/uv/). PYTEST_VERSION and PYTHON_VERSION
# override the pins below. Each source file below is run on its own, in a fresh
# temporary directory, with
#   python -m pytest -q -p no:cacheprovider <file> --junitxml=<report>
# and the expected exit status is checked. The report is then rewritten, and
# nothing else is edited:
#   - the capture directory          -> /tmp/capture
#   - the interpreter's base prefix  -> /usr
#   - testsuite hostname="..."       -> hostname="capture-host"
#   - testsuite timestamp="..."      -> timestamp="2026-11-24T00:00:00.000000+00:00"
#   - every time="..." duration      -> time="0.000"
#   - "object at 0x<address>"        -> "object at 0x0"
# so a rerun with the same pytest and CPython reproduces the files byte for byte.
set -euo pipefail

PYTEST_VERSION="${PYTEST_VERSION:-9.2.0}"
PYTHON_VERSION="${PYTHON_VERSION:-3.14}"
out="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
work="$(pwd -P)"

py() { uv run --quiet --no-project --python "$PYTHON_VERSION" --with "pytest==$PYTEST_VERSION" python "$@"; }

cat > test_evidence.py <<'EOF'
def test_target():
    assert 1 == 2


def test_other():
    assert True
EOF
cat > test_collect.py <<'EOF'
from os import NO_SUCH_NAME


def test_target():
    assert NO_SUCH_NAME
EOF
cat > test_setup.py <<'EOF'
import pytest
@pytest.fixture
def broken():
    raise RuntimeError("boom")


def test_target(broken):
    assert True
EOF
cat > test_teardown.py <<'EOF'
import pytest
@pytest.fixture
def td():
    yield
    raise RuntimeError("teardown boom")


def test_target(td):
    assert True
EOF
cat > test_red_teardown.py <<'EOF'
import pytest
@pytest.fixture
def td():
    yield
    raise RuntimeError("teardown boom")
def test_target(td):
    assert 1 == 2
EOF
mkdir -p tests
cat > tests/test_widget.py <<'EOF'
import pytest


class TestWidget:
    def test_x(self):
        assert 1 == 2


@pytest.mark.parametrize("label,value", [("a", 1)])
def test_param(label, value):
    assert value == 2
EOF

prefix="$(py -c 'import sys; print(sys.base_prefix)')"
echo "pytest $(py -m pytest --version 2>&1 | awk '{print $2}'), $(py -c 'import platform; print("CPython", platform.python_version())')"

capture() { # <source> <fixture> <expected exit status>
  local status=0
  py -m pytest -q -p no:cacheprovider "$1" --junitxml="$work/report.xml" > /dev/null || status=$?
  if [ "$status" -ne "$3" ]; then echo "$1: pytest exited $status, expected $3" >&2; exit 1; fi
  WORK="$work" PREFIX="$prefix" py - "$work/report.xml" "$out/$2" <<'EOF'
import os, re, sys
text = open(sys.argv[1], encoding="utf-8").read()
text = text.replace(os.environ["WORK"], "/tmp/capture").replace(os.environ["PREFIX"], "/usr")
text = re.sub(r'hostname="[^"]*"', 'hostname="capture-host"', text)
text = re.sub(r'timestamp="[^"]*"', 'timestamp="2026-11-24T00:00:00.000000+00:00"', text)
text = re.sub(r' time="[0-9.]*"', ' time="0.000"', text)
text = re.sub(r"object at 0x[0-9a-f]+", "object at 0x0", text)
open(sys.argv[2], "w", encoding="utf-8", newline="").write(text)
EOF
  echo "wrote $2"
}

capture test_evidence.py pytest-red.xml 1
capture test_collect.py pytest-collection-error.xml 2
capture test_setup.py pytest-setup-error.xml 1
capture test_teardown.py pytest-teardown-error.xml 1
capture test_red_teardown.py pytest-red-teardown-error.xml 1
capture tests/test_widget.py pytest-class-red.xml 1
