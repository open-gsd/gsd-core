Run this block after the plan's tasks are committed. It resolves `PLAN_PATH`, then marks only requirement IDs that are ready. It fails closed: an unresolved plan, an ambiguous plan, or a failed lookup marks nothing.

```bash
# Locate assigned plan path for ready-ids check; fail closed if not found (#4944).
# Integers longer than 9 digits are rejected before arithmetic so bash and zsh cannot wrap them.
PLAN_PATH="${PLAN_PATH:-}"
_nf=0; _ng=0; _ws=0; _fg=0
if [ -n "${ZSH_VERSION:-}" ]; then
  [[ -o noglob ]] && _nf=1
  [[ -o nullglob ]] && _ng=1
  case "$options[shwordsplit]" in on) _ws=1;; esac
else
  case $- in *f*) _nf=1;; esac
  shopt -q nullglob 2>/dev/null && _ng=1
  shopt -q failglob 2>/dev/null && _fg=1
fi
# Pad a 1-9 digit integer. Longer tokens return 1 and print nothing (no wrap).
_pad() {
  case "$1" in ''|*[!0-9]*|??????????*) return 1;; esac
  _n=$((10#$1))
  [ "$_n" -lt 10 ] && printf '%02d' "$_n" || printf '%s' "$_n"
}
# Mirrors normalizePhaseName; direct fast-check parity lives in milestone.test.cjs.
# Phase segments are strings: preserve leading zeros and avoid arithmetic overflow.
_pph() {
  _phase=$(printf '%s' "$1" | sed -E 's/^[A-Z][A-Z0-9_]*-([0-9])/\1/')
  if printf '%s' "$_phase" | grep -Eq '^[0-9]+(-[0-9]+)+[A-Za-z]?(\.[0-9]+)*$'; then
    _rest="$_phase"; _normalized=""; _separator=""
    while :; do
      _digits="${_rest%%[!0-9]*}"; _rest="${_rest#"$_digits"}"
      [ "${#_digits}" -ge 2 ] || _digits="0$_digits"
      _normalized="${_normalized}${_separator}${_digits}"
      case "$_rest" in -*) _rest="${_rest#-}"; _separator="-";; *) printf '%s%s' "$_normalized" "$_rest"; return;; esac
    done
  fi
  _parts=$(printf '%s' "$_phase" | sed -nE 's/^([0-9]+)([A-Za-z]?)((\.[0-9]+)*).*/\1|\2\3/p')
  if [ -z "$_parts" ]; then printf '%s' "$1"; return; fi
  _digits="${_parts%%|*}"; _suffix="${_parts#*|}"
  [ "${#_digits}" -ge 2 ] || _digits="0$_digits"
  printf '%s%s' "$_digits" "$_suffix"
}
# First frontmatter block only. CR and a leading UTF-8 BOM are ignored.
_fm() {
  _b=$(tr -d '\r' <"$1") || return 1
  printf '%s\n' "${_b#$'\357\273\277'}" | awk 'NR==1&&/^---[[:space:]]*$/{f=1;next} NR==1{exit} f&&/^---[[:space:]]*$/{exit} f'
}
_mp() {
  _raw=$(_fm "$1" | sed -n 's/^plan:[[:space:]]*//p' | head -n 1 || true)
  _fp=$(printf '%s' "${_raw%%#*}" | sed 's/[[:space:]]*$//;s/^["'\'']//;s/["'\'']$//')
  [ -n "$_fp" ] || return 1
  [ "$_fp" = "${PLAN:-}" ] || [ "$_fp" = "$P" ] && return 0
  _v=$(_pad "$_fp") || return 1
  [ "$_v" = "$P" ]
}
# Path $1 is a regular non-symlink file whose parent directory is inside canonical directory $2.
_in() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ -d "$2" ] || return 1
  _d=$(cd "${2%/}" && pwd -P) || return 1
  _f=$(cd "$(dirname -- "$1")" && pwd -P)/$(basename -- "$1") || return 1
  case "$_f" in "$_d"/*) ;; *) return 1;; esac
}
_bad=0; _mc=0
P="${PLAN:-}"
case "${PLAN:-}" in ''|*[!0-9]*) ;; *) P=$(_pad "${PLAN:-}") || _bad=1;; esac
if [ "$_bad" = 1 ]; then
  echo "WARN: plan number too long (${PLAN:-})" >&2
  PLAN_PATH=""
else
  D="${PHASE_DIR:-$(printf '%s' "${INIT:-}" | jq -r '.phase_dir // empty' 2>/dev/null || true)}"
  D="${D%/}"
  if [ -n "$PLAN_PATH" ] && [ -f "$PLAN_PATH" ] && _mp "$PLAN_PATH" && [ -d "$D" ] && _in "$PLAN_PATH" "$D"; then
    :
  else
    PLAN_PATH=""
    if [ -z "$D" ] || [ ! -d "$D" ]; then
      echo "WARN: Phase directory not found for plan resolution (${D:-unset})" >&2
    else
      # Globs must expand even when the caller had noglob set. Restored below.
      if [ -n "${ZSH_VERSION:-}" ]; then unsetopt noglob; setopt NULL_GLOB; else set +f; shopt -u failglob 2>/dev/null; shopt -s nullglob; fi
      PH=$(_pph "${PHASE:-}")
      C=()
      for pfx in "${PHASE:-}" "$PH"; do for pl in "$P" "${PLAN:-}"; do
        for f in "$D/plans/PLAN-${pl}.md" "$D/plans/PLAN-${pl}-"*.md "$D/${pfx}-${pl}-PLAN.md" "$D/${pfx}-${pl}-"*-PLAN.md; do
          [ -f "$f" ] && { case " ${C[*]} " in *" $f "*) ;; *) _in "$f" "$D" && _mp "$f" && C+=("$f");; esac; }
        done
      done; done
      if [ -n "${ZSH_VERSION:-}" ]; then [ "$_ng" = 1 ] || unsetopt NULL_GLOB; else [ "$_ng" = 1 ] || shopt -u nullglob; [ "$_fg" = 1 ] && shopt -s failglob; fi
      if [ "${#C[@]}" = 1 ]; then for c in "${C[@]}"; do PLAN_PATH="$c"; done
      else echo "WARN: Could not resolve unambiguous PLAN_PATH in $D (matches: ${#C[@]})" >&2; fi
    fi
  fi
fi
if [ -n "$PLAN_PATH" ] && [ -f "$PLAN_PATH" ] && [ -n "$(printf '%s' "${REQ_IDS:-}" | tr -d '[:space:]')" ]; then
  _ef=$(mktemp 2>/dev/null || mktemp -t gsd.XXXXXX 2>/dev/null || echo "/tmp/gsd.$$.$RANDOM")
  # zsh set -f is NO_RCS, not noglob. Bracketed IDs need noglob on both shells.
  if [ -n "${ZSH_VERSION:-}" ]; then setopt SH_WORD_SPLIT; setopt noglob; else set -f; fi
  READY=$(gsd_run query requirements.ready-ids "${PLAN_PATH}" ${REQ_IDS} 2>"$_ef" || true)
  READY_IDS=$(printf '%s' "$READY" | jq -r '.ready[]' 2>>"$_ef" | tr '\n' ' ' || true)
  _mc=0
  if [ -n "$(printf '%s' "$READY_IDS" | tr -d '[:space:]')" ]; then
    # Keep a mark-complete failure visible, but restore shell options first.
    gsd_run query requirements.mark-complete ${READY_IDS} || _mc=$?
  else
    _em=$(tr '\n' ' ' <"$_ef" 2>/dev/null || true)
    echo "WARN: No requirement IDs ready to mark complete for ${PLAN_PATH} (blocked or query failed)${_em:+: $_em}" >&2
  fi
  rm -f "$_ef"
  [ -n "${ZSH_VERSION:-}" ] && { [ "$_ws" = 1 ] || unsetopt SH_WORD_SPLIT; }
fi
_mc=${_mc:-0}
if [ -n "${ZSH_VERSION:-}" ]; then [ "$_nf" = 1 ] && setopt noglob || unsetopt noglob
else [ "$_nf" = 1 ] && set -f || set +f; fi
[ "$_mc" -eq 0 ]
```
