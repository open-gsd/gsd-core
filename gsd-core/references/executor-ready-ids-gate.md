Run this block after the plan's tasks are committed. It resolves `PLAN_PATH`, then marks only requirement IDs that are ready. It fails closed: an unresolved plan, an ambiguous plan, or a failed lookup marks nothing.

```bash
# Locate assigned plan path for ready-ids check; fail closed if not found (#4944).
# Integers longer than 9 digits are rejected before arithmetic so bash and zsh cannot wrap them.
PLAN_PATH="${PLAN_PATH:-}"
_nf=0; _ng=0; _ws=0
if [ -n "${ZSH_VERSION:-}" ]; then
  [[ -o noglob ]] && _nf=1
  [[ -o nullglob ]] && _ng=1
  case "$options[shwordsplit]" in on) _ws=1;; esac
else
  case $- in *f*) _nf=1;; esac
  shopt -q nullglob 2>/dev/null && _ng=1
fi
# Pad a 1-9 digit integer. Longer tokens return 1 and print nothing (no wrap).
_pad() {
  case "$1" in ''|*[!0-9]*|??????????*) return 1;; esac
  _n=$((10#$1))
  [ "$_n" -lt 10 ] && printf '%02d' "$_n" || printf '%s' "$_n"
}
# Pad a phase token the way normalizePhaseName does.
# Milestone 5-5 and 5-5A.1 pad each dash segment; 05-05 stays 05-05.
# Standard 5, 5.1, 5.10, 5A, 5.1.2 pad only the leading integer.
# Anything else, including a 10-digit segment, is returned unchanged (no wrap).
_pph() {
  if printf '%s' "$1" | grep -Eq '^[0-9]+(-[0-9]+)+[A-Za-z]?(\.[0-9]+)*$'; then
    _rest="$1"; _out=""; _first=1
    while [ -n "$_rest" ]; do
      _seg="${_rest%%[!0-9]*}"; _rest="${_rest#"$_seg"}"
      _p=$(_pad "$_seg") || { printf '%s' "$1"; return; }
      if [ "$_first" = 1 ]; then _out="$_p"; _first=0; else _out="${_out}-${_p}"; fi
      case "$_rest" in -*) _rest="${_rest#-}"; ;; *) printf '%s%s' "$_out" "$_rest"; return;; esac
    done
  fi
  _l="${1%%[!0-9]*}"
  _r="${1#"$_l"}"
  if [ -z "$_r" ]; then _pad "$1" || printf '%s' "$1"; return; fi
  printf '%s' "$_r" | grep -Eq '^[A-Za-z]?(\.[0-9]+)*$' || { printf '%s' "$1"; return; }
  _p=$(_pad "$_l") || { printf '%s' "$1"; return; }
  printf '%s%s' "$_p" "$_r"
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
  [ "$_fp" = "$PLAN" ] || [ "$_fp" = "$P" ] && return 0
  _v=$(_pad "$_fp") || return 1
  [ "$_v" = "$P" ]
}
# Canonical path of $1 is inside canonical directory $2 (symlink and /tmp vs /private/tmp).
_in() {
  [ -f "$1" ] && [ -d "$2" ] || return 1
  _d=$(cd "${2%/}" && pwd -P) || return 1
  _f=$(cd "$(dirname -- "$1")" && pwd -P)/$(basename -- "$1") || return 1
  case "$_f" in "$_d"/*) ;; *) return 1;; esac
}
_bad=0
P="$PLAN"
case "$PLAN" in ''|*[!0-9]*) ;; *) P=$(_pad "$PLAN") || _bad=1;; esac
if [ "$_bad" = 1 ]; then
  echo "WARN: plan number too long (${PLAN})" >&2
  PLAN_PATH=""
else
  D="${PHASE_DIR:-$(printf '%s' "${INIT:-}" | jq -r '.phase_dir // empty' 2>/dev/null)}"
  D="${D%/}"
  if [ -n "$PLAN_PATH" ] && [ -f "$PLAN_PATH" ] && _mp "$PLAN_PATH" && { [ ! -d "$D" ] || _in "$PLAN_PATH" "$D"; }; then
    :
  else
    PLAN_PATH=""
    if [ -z "$D" ] || [ ! -d "$D" ]; then
      echo "WARN: Phase directory not found for plan resolution (${D:-unset})" >&2
    else
      # Globs must expand even when the caller had noglob set. Restored below.
      if [ -n "${ZSH_VERSION:-}" ]; then unsetopt noglob; setopt NULL_GLOB; else set +f; shopt -s nullglob; fi
      PH=$(_pph "$PHASE")
      C=()
      for pfx in "$PHASE" "$PH"; do for pl in "$P" "$PLAN"; do
        for f in "$D/plans/PLAN-${pl}.md" "$D/plans/PLAN-${pl}-"*.md "$D/${pfx}-${pl}-PLAN.md" "$D/${pfx}-${pl}-"*-PLAN.md; do
          [ -f "$f" ] && { case " ${C[*]} " in *" $f "*) ;; *) _mp "$f" && C+=("$f");; esac; }
        done
      done; done
      if [ -n "${ZSH_VERSION:-}" ]; then [ "$_ng" = 1 ] || unsetopt NULL_GLOB; else [ "$_ng" = 1 ] || shopt -u nullglob; fi
      if [ "${#C[@]}" = 1 ]; then for c in "${C[@]}"; do PLAN_PATH="$c"; done
      else echo "WARN: Could not resolve unambiguous PLAN_PATH in $D (matches: ${#C[@]})" >&2; fi
    fi
  fi
fi
if [ -n "$PLAN_PATH" ] && [ -f "$PLAN_PATH" ] && [ -n "$(printf '%s' "${REQ_IDS:-}" | tr -d '[:space:]')" ]; then
  # zsh set -f is NO_RCS, not noglob. Bracketed IDs need noglob on both shells.
  if [ -n "${ZSH_VERSION:-}" ]; then setopt SH_WORD_SPLIT; setopt noglob; else set -f; fi
  _ef=$(mktemp)
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
