IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END' || true
$ARGUMENTS
GSD_ARGS_END
GSD_ARGS=${GSD_ARGS%$'\n'}
GSD_WS=$(echo " $GSD_ARGS" | sed -nE 's/.* --ws +["'\'']?([A-Za-z0-9][A-Za-z0-9._-]*).*/--ws \1/p' | head -1)
read -ra _gsd_argv <<<"$GSD_ARGS"; set -- "${_gsd_argv[@]}"
while [ "$#" -gt 0 ]; do case "$1" in --ws|--wave) shift; [ "$#" -gt 0 ] && shift;; -*) shift;; *) break;; esac; done
PHASE_NUMBER=${PHASE_NUMBER:-$(gsd_run query init.phase-op ${GSD_WS:+--ws=${GSD_WS##* }} "${1}" --pick phase_number)}
DISCUSS_PRE_HOOKS_JSON=$(gsd_run loop render-hooks discuss:pre --raw --phase "${PHASE_NUMBER}" ${GSD_WS:+--ws=${GSD_WS##* }})
