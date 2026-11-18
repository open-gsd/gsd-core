#!/usr/bin/env bash
# prompt.sh head|base <projectdir> : prints the iteration-N reviewer prompt (fresh shell, shipped read snippet + shipped template)
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib/env.sh"
run_shipped prompt "$1" "$2"
