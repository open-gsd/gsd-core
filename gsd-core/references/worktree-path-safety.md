# Worktree Path Safety

Guards for executor agents running inside Claude Code worktrees. The
supplied-root pin (step 0p) runs in EVERY mode; the remaining checks run before
any staging, Edit, or Write operation in worktree mode.

---

## Supplied-root pin — step 0p (#4254, EVERY mode)

Sequential-mode dispatch (no `isolation="worktree"`) gives the executor no
spawn-time cwd guarantee, and the worktree-only guards below do not apply — so
a sequential executor whose process cwd resolved to a different checkout of
the same repo would self-derive that checkout as its root and commit there,
silently. Step 0p closes that hole by comparing the executor's actual root
against a root the ORCHESTRATOR already validated — never against anything the
executor derives itself.

**Runtime contract (executor):** if your prompt contains a `<project_root_pin>`
block, run its guard script verbatim before your first Edit/Write and again
before every commit, in the same cwd as that write or commit. On FATAL, halt
and report — recovery (moving commits between checkouts) is an
orchestrator/human decision, never agent self-repair. If your prompt contains
NO `<project_root_pin>` block (worktree/isolated dispatch, or a legacy
orchestrator), emit one warning line and continue with steps 0a/0b below — do
not fail closed on dispatches that never carried a pin. **Never bind
`{PINNED_ROOT}` yourself**: if this template reaches you unbound it is
reference prose, not your pin — only the orchestrator's build-time
substitution produces a valid guard.

**Composition contract (orchestrator — build time, NOT a sub-agent runtime
step):** copy the guard below into the dispatched prompt inside a
`<project_root_pin>` block, substituting `{PINNED_ROOT}` with the literal value
of `$ORCHESTRATOR_WT` captured at execute_waves entry, shell-single-quoted:
wrap the path in `'…'` and escape any embedded `'` as `'\''`. A path that
cannot be quoted this way must halt the phase (surface a blocker) rather than
ship a pin that could mis-parse. The comparison is git-vs-git on BOTH sides —
`git -C` resolves the pinned path to its repo's canonical toplevel in git's
own path representation, so symlink aliases, trailing slashes, `/var` vs
`/private/var` spellings, and Windows drive-letter forms — forward- or
backslash-separated, `RUNNER~1`-style short names included — compare equal by
construction (shell `pwd -P` normalization does NOT match git's emission on
Windows — do not re-introduce it).

Two portability rules baked into the guard below, learned from the #4254 CI
Windows legs: (1) a backslash comparator must be GENERATED at runtime
(`printf '\134'`), because a backslash written twice in the script text does
not survive the Windows command-line round-trip into bash — the doubled form
arrives halved, which silently rewrites any escape pattern that relies on it;
(2) every FATAL names its `Guard stage` and, where a git capture failed,
git's own stderr in a `Diagnostic` line, so a platform failure self-describes
instead of surfacing as a bare `Actual root: <none>`.

```bash
# gsd:guard=supplied-root-pin (#4254) — run before the first Edit/Write and before every commit.
PINNED_ROOT='{PINNED_ROOT}'  # orchestrator build-time substitution — the only valid source of this value
PIN_STAGE=''
PIN_DIAG=''
gsd_pin_fail() {
  echo "FATAL: executor root does not match the orchestrator-supplied PROJECT_ROOT pin (#4254)." >&2
  echo "  Pinned root: ${PINNED_ROOT:-<empty or unexpanded>}" >&2
  echo "  Actual root: ${ACTUAL_ROOT:-<none>}" >&2
  echo "  Guard stage: ${PIN_STAGE:-<unset>}" >&2
  if [ -n "$PIN_DIAG" ]; then echo "  Diagnostic: $PIN_DIAG" >&2; fi
  echo "  No writes or commits are permitted from this checkout. HALT and report; recovery is an" >&2
  echo "  orchestrator/human decision. Only the IMMEDIATE submodule of the pinned checkout is a" >&2
  echo "  legitimate other cwd — nested submodules must surface as a blocker, not self-route." >&2
  exit 1
}
# Backslash comparator, generated at runtime: a backslash written twice in this
# script does not survive the Windows spawn path into bash (the command-line
# round-trip halves the doubled form), which rejected every C:\ pin at the form
# gate on the #4254 CI Windows legs. printf's octal escape is a lone backslash,
# which does survive; the quoted expansion below is literal in a case pattern.
BS=$(printf '\134')
# Fail closed if the comparator could not be generated: an empty BS would widen
# the drive-form arm below to drive-RELATIVE pins (C:foo) — the one fail-open
# seam in this construction, closed loudly rather than trusted to the shell.
if [ -z "$BS" ]; then
  PIN_STAGE=form-gate
  PIN_DIAG='backslash comparator generation failed (printf octal escape returned empty)'
  gsd_pin_fail
fi
case "$PINNED_ROOT" in
  ''|'{PINNED_ROOT}') PIN_STAGE=pin-unbound; gsd_pin_fail ;;  # empty or unexpanded pin — fail closed, never warn-and-proceed
  /*) ;;                                                     # absolute POSIX form
  [A-Za-z]:/*|[A-Za-z]:"$BS"*) ;;                            # Windows drive form, forward- or backslash-separated
  *) PIN_STAGE=form-gate; gsd_pin_fail ;;                    # relative pin — never trustworthy across cwds
esac
ACTUAL_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$ACTUAL_ROOT" ]; then
  PIN_STAGE=actual-capture
  PIN_DIAG="git rev-parse --show-toplevel from the cwd failed: $(git rev-parse --show-toplevel 2>&1 1>/dev/null)"
  gsd_pin_fail
fi
PINNED_TL=$(git -C "$PINNED_ROOT" rev-parse --show-toplevel 2>/dev/null)
if [ -z "$PINNED_TL" ]; then
  PIN_STAGE=pinned-capture
  PIN_DIAG="git -C <pinned root> rev-parse --show-toplevel failed: $(git -C "$PINNED_ROOT" rev-parse --show-toplevel 2>&1 1>/dev/null)"
  gsd_pin_fail
fi
if [ "$ACTUAL_ROOT" != "$PINNED_TL" ]; then
  # Registered-submodule allowance: sub_repos plans legitimately commit inside an
  # immediate submodule of the pinned checkout. The superproject working tree is
  # git-emitted in the same representation as PINNED_TL, so the equality is
  # representation-safe on every platform.
  SUPER_TL=$(git rev-parse --show-superproject-working-tree 2>/dev/null)
  if [ "$SUPER_TL" != "$PINNED_TL" ]; then
    PIN_STAGE=root-mismatch
    PIN_DIAG="actual=${ACTUAL_ROOT} pinned=${PINNED_TL} superproject=${SUPER_TL:-<none>}"
    gsd_pin_fail
  fi
fi
```

---

## Worktree branch check (run once at spawn-time)

The spawn-time HEAD/base guard now lives in the canonical fragment
`gsd-core/references/worktree-branch-check.md`, which the orchestrator embeds directly
into your prompt at dispatch. Run that block FIRST, before any reset/checkout or staging.
If your prompt contains a `<worktree_branch_check>` embed instruction rather than the block itself, complete that read-and-embed step before any reset/checkout or staging.

---

## cwd-drift sentinel — step 0a (#3097)

A prior Bash call may have `cd`'d out of the worktree into the main repo. When
that happens `[ -f .git ]` is false (main repo's `.git` is a directory), silently
skipping all worktree guards. The sentinel captures the spawn-time toplevel and
detects drift before every commit.

```bash
if [ -f .git ]; then  # we are in a worktree
  WT_GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
  case "$WT_GIT_DIR" in
    *.git/worktrees/*)
      SENTINEL="$WT_GIT_DIR/gsd-spawn-toplevel"
      [ ! -f "$SENTINEL" ] && git rev-parse --show-toplevel > "$SENTINEL" 2>/dev/null
      EXPECTED_TL=$(cat "$SENTINEL" 2>/dev/null)
      ACTUAL_TL=$(git rev-parse --show-toplevel 2>/dev/null)
      if [ -n "$EXPECTED_TL" ] && [ "$ACTUAL_TL" != "$EXPECTED_TL" ]; then
        echo "FATAL: cwd drifted from spawn-time worktree root (#3097)" >&2
        echo "  Spawn-time: $EXPECTED_TL" >&2
        echo "  Current:    $ACTUAL_TL" >&2
        echo "RECOVERY: cd \"$EXPECTED_TL\" before staging, then re-run this commit." >&2
        exit 1
      fi
      ;;
  esac
fi
```

---

## Absolute-path guard — step 0b (#3099)

Edit/Write calls using absolute paths constructed from the **orchestrator's** `pwd`
(main repo root) will resolve to the main repo, not the worktree. Writes land in
the wrong directory; `git commit` from the worktree sees a clean tree and the work
is silently lost.

Before any Edit or Write using an absolute path:

```bash
WT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
# Fail fast if ABS_PATH resolves outside the worktree
if [[ "$ABS_PATH" != "$WT_ROOT"* ]]; then
  echo "WARNING: $ABS_PATH is outside the worktree ($WT_ROOT)" >&2
  echo "Use a relative path or recompute the absolute path from WT_ROOT." >&2
fi
```

**Prefer relative paths** for all Edit/Write operations. When an absolute path is
unavoidable, always derive it from `git rev-parse --show-toplevel` run inside the
worktree — never from `pwd` captured in the orchestrator context.

---

## `<automated>` command guard — step 0c (#4767)

The plan's `<automated>` text is where an orchestrator-cwd absolute path most often
arrives: the planner saw absolute paths in its own context and wrote one into the
command. Run as written, `cd /abs/main-checkout/… && <test>` leaves the worktree, runs
against the main tree, and **passes on code this worktree changed and the main tree did
not** — a green verify that verified nothing. Before executing any `<automated>` command,
scan its text for absolute paths and halt if one is outside the worktree. Fail loud; never
rewrite the prefix silently (#3050) — a rewritten command hides the defective plan, and the
next executor meets it again.

```bash
# WT_ROOT as in step 0b. MAIN_ROOT is the checkout this worktree was created from — the one an
# orchestrator-cwd path points at.
WT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
MAIN_ROOT=$(cd "$(git rev-parse --git-common-dir)/.." 2>/dev/null && pwd -P)
# Resolve a path the way the shell would land in it. A relative path is taken from the second
# argument — the cwd a chained `cd` has reached so far — or the worktree root. An existing directory resolves through `cd && pwd -P`; a file through its directory (a
# symlinked file through its link target first), so a symlink or `..` hop inside the worktree that
# lands in the main checkout is seen for what it is; a path that does not exist yet — a Wave-0
# scaffold — is normalized lexically and must still PASS when it sits under the worktree. Never
# `readlink -m` / `realpath -m` — GNU-only. `_norm` splits with `read -ra` (no glob expansion) and
# expands the array with the `${a[@]+"${a[@]}"}` idiom (bash < 4.4 errors on an empty array under -u).
_norm(){ local -a out=() seg; local s; IFS=/ read -ra seg <<<"$1"
  for s in ${seg[@]+"${seg[@]}"}; do case "$s" in ''|.) ;; ..) [ ${#out[@]} -gt 0 ] && unset 'out[${#out[@]}-1]' ;; *) out+=("$s") ;; esac; done
  printf '/%s' ${out[@]+"${out[@]}"}; [ ${#out[@]} -gt 0 ] || printf '/'; }
_resolve(){ local p t; case "$1" in /*) p=$1 ;; *) p="${2:-$WT_ROOT}/$1" ;; esac
  if [ -L "$p" ] && ! [ -d "$p" ]; then t=$(readlink "$p"); case "$t" in /*) p=$t ;; *) p="$(dirname -- "$p")/$t" ;; esac; fi
  ( cd -- "$p" 2>/dev/null && pwd -P ) \
  || ( cd -- "$(dirname -- "$p")" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$(basename -- "$p")" ) \
  || _norm "$p"; }
_outside_wt(){ case "$1" in "$WT_ROOT"|"$WT_ROOT"/*) return 1 ;; *) return 0 ;; esac; }
# A shell word as the planner wrote it: runs of bare characters, "…" / '…' spans, and backslash
# escapes, in any mix (`"/x"/y`, `"O'Reilly"`, `path\ with\ space`, `release=main`). `_unquote`
# walks it with the shell's own three quoting states and returns the string the shell would pass.
_TOK='("[^"]*"|'"'"'[^'"'"']*'"'"'|\\.|[^[:space:]"'"'"';|&()])+'
_unquote(){ local s=$1 out='' q='' c i
  for ((i=0; i<${#s}; i++)); do c=${s:i:1}
    if [ -z "$q" ]; then case "$c" in '"'|"'") q=$c ;; '\') i=$((i+1)); out+=${s:i:1} ;; *) out+=$c ;; esac
    elif [ "$q" = '"' ]; then case "$c" in '"') q='' ;; '\') i=$((i+1)); out+=${s:i:1} ;; *) out+=$c ;; esac
    else case "$c" in "'") q='' ;; *) out+=$c ;; esac; fi
  done; printf '%s' "$out"; }
# The relocating verbs — `cd` / `pushd` (bare, `builtin`/`command`-prefixed, env-prefixed, or with
# `--`) and `npm --prefix` (both `--prefix <p>` and `--prefix=<p>`) at the start of a segment,
# including after a `(`/`{` opener. Each match is stripped of its prefix with an ANCHORED sed, so
# the target is taken verbatim, unquoted, and compared LITERALLY — never interpolated into a regex.
_VERB='((builtin|command)[[:space:]]+)?(cd|pushd)([[:space:]]+--)?'
_ENV='([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*'
_OPEN='(^|&&|;|\||\(|\{)[[:space:]]*'
_NPM='npm[[:space:]]+(--prefix|run[^&;|]*--prefix)[[:space:]=]+'
# One ordered pass, each target tagged `C` (a cd/pushd — moves the cwd) or `N` (an npm prefix —
# resolved from the cwd reached so far but does NOT move it).
_TARGETS=$( printf '%s' "$AUTOMATED_CMD" | grep -oE "${_OPEN}(${_ENV}${_VERB}[[:space:]]+|${_NPM})${_TOK}" \
            | sed -E "s/^(&&|;|\||\(|\{)?[[:space:]]*//; s/^${_NPM}/N /; s/^${_ENV}${_VERB}[[:space:]]+/C /" | sed '/^$/d' )
# 1. Every relocating target, relative or absolute, resolved from the cwd the command has reached
# (chained `cd scripts && cd ..` lands back at the root and passes; `cd scripts && cd ../..` does
# not): outside the worktree → halt. A target the shell would expand (`~`, `$VAR`, `$(…)`) cannot
# be evaluated here and passes through — the plan-checker's probe already reports those as
# `dynamic_path`, and `$(git rev-parse --show-toplevel)` is the form step 0b itself recommends.
CUR=$WT_ROOT
while IFS= read -r L; do
  [ -n "$L" ] || continue
  K=${L%% *}; T=${L#* }
  T=$(_unquote "$T"); R=$(_resolve "$T" "$CUR")
  if _outside_wt "$R"; then
    echo "FATAL: <automated> command relocates to $T -> $R, outside the worktree ($WT_ROOT) — it would verify the wrong checkout. Rewrite the plan's command root-relative (cwd is the checkout root); do not rewrite it in place." >&2
    exit 1
  fi
  [ "$K" = C ] && CUR=$R
done <<EOF_TARGETS
$_TARGETS
EOF_TARGETS
# 2. Any other absolute word that resolves under the MAIN checkout — a file argument, a redirect,
# an include — is the same defect by a different verb; system paths such as /dev/null or /usr/bin
# are neither and pass.
while IFS= read -r P; do
  [ -n "$P" ] || continue
  P=$(_unquote "$P"); case "$P" in [A-Za-z_]*=*|--*=*) P=${P#*=} ;; esac   # FOO=/x, --flag=/x
  case "$P" in /*) ;; *) continue ;; esac
  R=$(_resolve "$P")
  _outside_wt "$R" || continue
  case "$R" in
    "$MAIN_ROOT"|"$MAIN_ROOT"/*)
      echo "FATAL: <automated> command names $P (-> $R) inside the main checkout, outside the worktree ($WT_ROOT) — it would verify the wrong checkout. Rewrite the plan's command root-relative (cwd is the checkout root); do not rewrite it in place." >&2
      exit 1 ;;
  esac
done <<EOF_ABS
$(printf '%s' "$AUTOMATED_CMD" | grep -oE "$_TOK")
EOF_ABS
```

A halt here is a plan defect, not an executor deviation: report it via the checkpoint return
format naming the task and the offending command verbatim, and stop. The plan-checker's path
probe (`check verify-command-paths`) warns on the *outside-orchestrator-root* case before
execution; this guard is the one that sees the executor's actual root.
