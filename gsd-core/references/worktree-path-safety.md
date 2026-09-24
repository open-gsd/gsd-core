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
# True when raw shell text contains an unquoted single `&` or `|`. `&&` and
# `||` keep the current shell's cwd; the single forms cross a process boundary.
_resets_cwd(){ local s=$1 q='' i c p n; for ((i=0;i<${#s};i++)); do c=${s:i:1}
    if [ -z "$q" ]; then case "$c" in
      "'"|'"') q=$c ;; '\') i=$((i+1)) ;;
      '&'|'|') p=''; n=''; [ "$i" -gt 0 ] && p=${s:i-1:1}; [ "$i" -lt $((${#s}-1)) ] && n=${s:i+1:1};
        [ "$p" = "$c" ] || [ "$n" = "$c" ] || return 0 ;;
    esac
    elif [ "$q" = '"' ]; then case "$c" in '"') q='' ;; '\') i=$((i+1)) ;; esac
    else [ "$c" = "'" ] && q=''; fi
  done; return 1; }
# The relocating verbs — `cd` / `pushd` (bare, `builtin`/`command`-prefixed, env-prefixed, or with
# `--`) and a tool's own directory flag (`npm`/`npx`/`pnpm` `--prefix`, `yarn --cwd`, `pnpm -C`,
# `make -C`, `git -C`; both `--flag <p>` and `--flag=<p>`) at the start of a segment, including after a
# `(`/`{` opener or a `&` background operator. Each match is stripped of its prefix with an ANCHORED sed,
# so the target is taken verbatim, unquoted, and compared LITERALLY — never interpolated into a regex.
_VERB='((builtin|command)[[:space:]]+)?(cd|pushd)([[:space:]]+--)?'
_ENV='([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*'
# `&` joins the operator set; grep is line-oriented, so a newline is already covered by `^`.
# CONTROL KEYWORDS (`if`, `then`, `do`, …) WERE TRIED HERE AND REVERTED, and the reason is the rule
# this fence is built on rather than a detail: these operators are matched against RAW TEXT, with no
# awareness of quoting, so a keyword that is also an ordinary English word turns prose inside a
# quoted argument into a command boundary — `grep -F 'if cd ../main; then' README.md` halted on a
# command that relocates nothing. That buys a rare false negative (`if cd ../main; then …`) at the
# cost of a realistic false positive, and this guard's whole posture is that the false-positive
# direction is the one that gets it routed around. The residual is disclosed instead.
# Spell the literal ERE operators as bracket expressions. `\|` / `\(` / `\{`
# are GNU-tolerated but undefined by POSIX and BSD sed rejects the same boundary
# expression with "unbalanced brackets" before the scan can run (#4767).
_OPEN='(^|&&|&|;|[|][|]|[|]|[(]|[{])[[:space:]]*'
# LAUNCHERS are a NAMED set, not `[^&;|]*`. A wrapper reached through a launcher is still a wrapper,
# and the set admits an absolute path (`/usr/bin/env`) and an option with a SEPARATE operand
# (`env -u FOO`, `timeout --signal TERM`, `stdbuf -o L`). Which options TAKE an operand is
# TOOL-SCOPED for the same reason `_DIR`'s flags are: `-i` takes one on `stdbuf` and NONE on `env`,
# so a flat set consumed the COMMAND after an operandless flag and `env -i echo bash -c '…'` —
# which runs `echo` — halted. `command` and `exec` are deliberately NOT in the set: `command -v
# bash` is a name PROBE that executes nothing, and halting it is the false-positive direction
# again. The cost is that a genuine `command bash -c …` is not unwrapped; that is disclosed.
# but a catch-all leading run also unwraps interpreter TEXT that is merely an argument — `echo bash -c
# 'cd ../main'` halted on a command that executes nothing. A spurious unwrap is NOT harmless: the scans
# halt on a path the shell would never visit. Name the launchers instead.
_LOPT='([[:space:]]+-[^[:space:]]+|[[:space:]]+[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*)*'
# THE SHAPE IS `(<generic opts> <opt> <operand>)* <generic opts>`, NOT `<generic opts> (<opt>
# <operand>)* <generic opts>`. The second admits only ONE contiguous run of operand-taking options,
# so a generic option BETWEEN two of them ends the run and hides everything after it:
# `env -u FOO --debug -u BAR -C ../main` relocates and passed silently. Interleaving is the normal
# way these tools are invoked, so the grammar has to allow it. Same shape for timeout and stdbuf.
# env's own separate-operand options, factored out because BOTH consumers need them: $_LAUNCH, so a
# payload behind `env -u FOO bash -c …` is unwrapped, and $_DIR, so `env -u FOO -C ../main` is still
# seen as a relocation. Generic $_LOPT cannot consume `FOO`, so without this the option HID the flag.
_ENVOPT='('"$_LOPT"'[[:space:]]+(-u|--unset)[[:space:]]+'"$_TOK"')*'"$_LOPT"
# $_LAUNCH needs a WIDER env group than $_DIR does, and the difference is deliberate. $_DIR must leave
# `-C`/`--chdir` UNCONSUMED — that flag is the thing it is looking for. $_LAUNCH must consume it, or
# `env -C scripts bash -c '…'` has its relocation seen and its PAYLOAD never unwrapped, which is the
# bypass class this whole guard is about. Two groups, one per consumer.
_ENVOPTL='('"$_LOPT"'[[:space:]]+((-u|--unset)[[:space:]]+|(-C|--chdir)([[:space:]]+|=))'"$_TOK"')*'"$_LOPT"
_LAUNCH='((/[^[:space:]]*/)?((env|setsid|nohup)'"$_ENVOPTL"'|timeout('"$_LOPT"'[[:space:]]+(-s|--signal|-k|--kill-after)[[:space:]]+[^[:space:]]+)*'"$_LOPT"'[[:space:]]+[0-9]+[smhd]?|(stdbuf|nice|ionice)('"$_LOPT"'[[:space:]]+(-i|-o|-e|-n|-c)[[:space:]]+[^[:space:]]+)*'"$_LOPT"')[[:space:]]+)*'
# The directory flags are TOOL-SCOPED, because the same spelling is not the same flag on every tool:
# `git archive --prefix=../main/ HEAD` names archive MEMBERS and changes no directory, so a flat
# six-tool `--prefix` halts a legitimate command. `--prefix`/`--cwd`/`--dir`/`-C` belong to the node
# package managers; `-C`/`--directory` to make and git. $_LAUNCH leads it for $_EXEC's reason — a
# recognised tool behind `env` is still that tool.
_DIR='(('"$_LAUNCH"')(npm|npx|pnpm|yarn)[[:space:]]+([^&;|]*[[:space:]]+)?(--prefix|--cwd|--dir|-C)|('"$_LAUNCH"')(make|git)[[:space:]]+([^&;|]*[[:space:]]+)?(-C|--directory)|('"$_LAUNCH"')(/[^[:space:]]*/)?env'"$_ENVOPT"'[[:space:]]+(--chdir|-C))[[:space:]=]+'
# Command-string interpreters. `eval "cd <main> && x"`, `sh -c "…"`, `bash -c '…'`, `node -e '…'` bury
# the real command inside ONE opaque quoted token, and that defeats BOTH scans below at once: the
# relocating verb never sits at a boundary scan 1 recognizes, and scan 2's tokenizer swallows the whole
# quoted span, which after unquoting does not begin with `/`. These are ordinary portability idioms, not
# obfuscation — a planner imitating a CI script reaches for one without any adversarial intent — so the
# payload is UNWRAPPED and re-scanned rather than trusted or rejected wholesale. $_LAUNCH lets the
# launcher forms a planner actually writes — `env bash -c`, a `timeout`-wrapped `bash -c`,
# `nohup sh -c` — reach the same unwrap as a bare one, and an absolute or option-bearing
# interpreter (`/bin/bash -c`, `bash --noprofile -c`) with it.
_EXEC='('"$_LAUNCH"')((/[^[:space:]]*/)?(sh|bash|zsh|dash|ksh)([[:space:]]+--[a-z-]+)*[[:space:]]+-[a-z]*c|(/[^[:space:]]*/)?(python3?|node|perl|ruby)([[:space:]]+--[a-z-]+)*[[:space:]]+-[a-z]*[ce]|eval)[[:space:]]+'
# `eval` runs in the current shell, unlike the other interpreters above; its payload's final cwd must
# therefore flow into the next event. A subprocess payload is scanned from the reached cwd and then
# restores its caller's cwd.
_EVAL='eval[[:space:]]+'
# ONE ordered pass per scanned string, each event tagged `C` (a cd/pushd — moves the cwd), `N` (a
# tool's directory flag — resolved from the cwd reached so far but does NOT move it), `E` (`eval`,
# whose cwd change persists), or `W` (a subprocess interpreter, whose cwd change does not). Ordering
# is load-bearing: scanning every outer relocation before an earlier payload lets a later `cd` supply
# that payload with a cwd the shell has not reached yet. `_scan` is a FUNCTION so an unwrapped payload
# reaches the SAME event scan as the top-level command; it halts with
# `exit 1`, never a return code, so a halt inside a payload is exactly as fatal as one outside; and it
# ends `return 0` so a trailing non-`C` target cannot make the function itself look failed under `set -e`.
CUR=$WT_ROOT
_scan(){ local CMD=$1 D=$2 RAW BODY BFR REST K Q T R P S PREFIX LDS LD _T _P
  _T=$( printf '%s' "$CMD" | grep -oE "${_OPEN}(${_ENV}${_EXEC}|${_ENV}${_VERB}[[:space:]]+|${_DIR})${_TOK}" \
        | sed '/^$/d' )
  # 1. Every relocating target, relative or absolute, resolved from the cwd the command has reached
  # (chained `cd scripts && cd ..` lands back at the root and passes; `cd scripts && cd ../..` does
  # not): outside the worktree → halt. A target the shell would expand (`~`, `$VAR`, `$(…)`) cannot
  # be evaluated here and passes through — the plan-checker's probe already reports those as
  # `dynamic_path`, and `$(git rev-parse --show-toplevel)` is the form step 0b itself recommends.
  REST=$CMD
  while IFS= read -r RAW; do
    [ -n "$RAW" ] || continue
    # Preserve process boundaries even when an unrecognized command sits between
    # one and the next recognized event (`cd x & echo y && bash -c ...`).
    BFR=${REST%%"$RAW"*}; REST=${REST#*"$RAW"}
    if _resets_cwd "$BFR" || _resets_cwd "$RAW"; then CUR=$WT_ROOT; fi
    BODY=$(printf '%s' "$RAW" | sed -E "s/^(&&|&|;|[|][|]|[|]|[(]|[{])?[[:space:]]*//")
    # Classify with the same grep implementation that produced the event and
    # remove the matched prefix literally. Expanding these composed EREs into a
    # multi-expression BSD sed program fails with "unbalanced brackets" on
    # macOS even though BSD grep accepts the event expression (#4767).
    if _P=$(printf '%s' "$BODY" | grep -oE "^${_ENV}${_EVAL}"); then K=E
    elif _P=$(printf '%s' "$BODY" | grep -oE "^${_ENV}${_EXEC}"); then K=W
    elif _P=$(printf '%s' "$BODY" | grep -oE "^${_DIR}"); then K=N
    else _P=$(printf '%s' "$BODY" | grep -oE "^${_ENV}${_VERB}[[:space:]]+"); K=C
    fi
    Q=${BODY#"$_P"}; T=$(_unquote "$Q")
    case "$K" in
      E) [ "$D" -ge 4 ] || _walk "$T" "$((D+1))" ;;
      W) if [ "$D" -lt 4 ]; then
           S=$CUR
           # `_EXEC` is longer than `_DIR`, so a wrapper reached through
           # `env -C/--chdir` wins grep's leftmost-longest match. Recover that
           # launcher's relocation here: validate it, start the child there,
           # then restore the parent cwd when the payload scan returns.
           PREFIX=${BODY%"$Q"}
           LDS=$(printf '%s' "$PREFIX" | grep -oE "(^|[[:space:]])(-C|--chdir)([[:space:]]+|=)${_TOK}" \
             | sed -E 's/^[[:space:]]*(-C|--chdir)([[:space:]]+|=)//' || true)
           while IFS= read -r LD; do
             [ -n "$LD" ] || continue
             LD=$(_unquote "$LD"); R=$(_resolve "$LD" "$CUR")
             if _outside_wt "$R"; then
               echo "FATAL: <automated> command relocates to $LD -> $R, outside the worktree ($WT_ROOT) — it would verify the wrong checkout. Rewrite the plan's command root-relative (cwd is the checkout root); do not rewrite it in place." >&2
               exit 1
             fi
             CUR=$R
           done <<EOF_LAUNCH_DIRS
$LDS
EOF_LAUNCH_DIRS
           _walk "$T" "$((D+1))"; CUR=$S
         fi ;;
      C|N)
        R=$(_resolve "$T" "$CUR")
        if _outside_wt "$R"; then
          echo "FATAL: <automated> command relocates to $T -> $R, outside the worktree ($WT_ROOT) — it would verify the wrong checkout. Rewrite the plan's command root-relative (cwd is the checkout root); do not rewrite it in place." >&2
          exit 1
        fi
        [ "$K" = C ] && CUR=$R ;;
    esac
  done <<EOF_TARGETS
$_T
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
$(printf '%s' "$CMD" | grep -oE "$_TOK")
EOF_ABS
  return 0; }
# EVERY s-COMMAND THAT INTERPOLATES ONE OF THESE REGEXES USES `#`, NOT `/`. $_EXEC, $_LAUNCH and
# (through $_LAUNCH) $_DIR all contain a literal `/` from their absolute-path groups, and a `/`
# inside the pattern closes an `s/…/…/` early: sed dies `unknown option to 's'` on STDERR inside a
# command substitution, the extracted list comes back EMPTY, and the scan silently stops happening
# while every command reads as a clean pass. It is written as a rule about ALL of them rather than
# about the one that had a slash first, because that is exactly how it recurred: $_EXEC was fixed,
# then $_LAUNCH gained `(/[^[:space:]]*/)?` and took $_DIR down with it. Both driven, not theorised.
# 3. The ordered event scan unwraps each interpreter payload in place, to a bounded depth — a wrapper
# inside a wrapper is still a wrapper, and the bound is what keeps a pathological nest finite.
# A payload the shell would build at run time (`bash -c $CMD`) is not a literal token here and passes
# through as a dynamic_path, exactly as scan 1 treats an expansion.
_walk(){ _scan "$1" "$2"; }
_walk "$AUTOMATED_CMD" 0
```

A halt here is a plan defect, not an executor deviation: report it via the checkpoint return
format naming the task and the offending command verbatim, and stop. The plan-checker's path
probe (`check verify-command-paths`) warns on the *outside-orchestrator-root* case before
execution; this guard is the one that sees the executor's actual root.

### What this guard does NOT see — step 0c's stated boundary

The two scans recognize **fixed sets** — relocating verbs, directory flags, interpreters, launchers,
command boundaries — and the domain they act on, shell a planner may write, can acquire a member without
this file changing. So the boundary is written out rather than left to be rediscovered, and each entry
says what follows from it.

**The largest one first, because it is the one a reader will otherwise assume away:**

- **A RELATIVE path argument to a command that is not a recognized relocating verb.**
  `python3 -m pytest ../main/tests`, `node ../main/test.js`, `make -f ../main/Makefile`, a redirect from
  `../main/file` — all pass. The catch-all scan evaluates only words that begin with `/`, so it never
  resolves a relative one, and the verb scan does not fire because none of these relocates. This is the
  widest gap in the guard and it is not new. Closing it means resolving every relative word in the
  command against the reached cwd, which halts on ordinary in-worktree arguments unless it can tell a
  path from a flag value from a bare string — a much larger change than this guard is, and one that
  fails toward false positives, which is the direction that gets a guard deleted.

The rest, in descending order of how likely a planner is to reach them:

- **Spellings that hide the verb from a text scan.** `cd$IFS/x` and its relatives split at run time, so
  no static tokenizer sees a `cd` at a boundary. Deliberate: the guard's domain is what a planner
  plausibly writes, not an adversary.
- **Anything the shell builds at run time.** `cd $VAR`, `cd "$(…)"`, `~`, and equally `bash -c "$CMD"` —
  the payload is not a literal token, so there is nothing to unwrap. These pass through by design;
  `check verify-command-paths` reports them as `dynamic_path` before execution, and
  `$(git rev-parse --show-toplevel)` is the form step 0b recommends.
- **A command boundary outside `$_OPEN`'s set — and the set is matched against RAW TEXT.** `&&` `&`
  `;` `|` `(` `{` open a command. Control keywords (`if cd ../main; then …`) are deliberately NOT in
  the set: these operators have no awareness of quoting, so a keyword that is also an ordinary English
  word turns prose inside a quoted argument into a boundary — `grep -F 'if cd ../main; then' README.md`
  halted on a command that relocates nothing. The same quote-blindness is why
  `echo 'note; bash -c "cd ../main"'` halts on its `;`: an over-halt on quoted data is the standing
  cost of scanning text, and it is paid in the loud direction.
- **A launcher outside `$_LAUNCH`'s set**, and therefore an interpreter or directory flag behind it.
  `env` `timeout` `nohup` `stdbuf` `nice` `ionice` `setsid` are recognized, named by bare word or
  absolute path, with options that take a separate operand (`env -u FOO`, `timeout --signal TERM`).
  The set is named rather than a catch-all deliberately: a catch-all also unwrapped interpreter text
  that was merely an *argument* (`echo bash -c '…'`), and halting on a command that executes nothing
  is the false-positive direction. `command` and `exec` are excluded for that same reason —
  `command -v bash` is a name probe.
- **An interpreter outside `$_EXEC`'s set.** The set is stated because the entries above name only the
  handful a planner reaches for most, which reads as the whole of it — `perl -e 'chdir "/main"'` IS
  unwrapped and rescanned. Recognized, each named by a bare word OR an absolute path: `sh` `bash`
  `zsh` `dash` `ksh`, and `python3`/`python` `node` `perl` `ruby`. The option is a short-option
  CLUSTER, not the literal flag — `-[a-z]*c` for the shells and `-[a-z]*[ce]` for the rest — so
  `-c`, `-ec` and even `-abc` all match. Recognized as a BARE WORD ONLY, with no absolute-path
  form: `eval`; `/bin/eval 'cd ../main'` is NOT seen (driven).
  Not recognized: an interpreter with no entry (`awk`, `php`, a shell not listed), whose payload stays
  one opaque token, so only an absolute path written as a bare word in it is caught by the catch-all
  scan. **The two lists are delimited on purpose** — the parity test in
  `tests/executor-mvp-tdd-section.test.cjs` reads only the span between `Recognized,` and
  `Not recognized:`, matching BACKTICKED TOKENS rather than substrings, because a containment check over the whole section is satisfied by a name that
  appears here saying it is UNsupported: adding `awk` to `$_EXEC` with this prose untouched passed
  that test, driven by the pre-push review of the round that added it.
- **An interpreter option that takes an operand.** `bash --noprofile -c` is recognized;
  `bash -O extglob -c` is not, because `_EXEC` admits long options without values, and widening it to
  consume operands risks swallowing the `-c` it is looking for.
- **A genuine `command bash -c …` or `exec bash -c …` is not unwrapped.** Those two words were removed
  from `$_LAUNCH` to stop `command -v bash` — a name probe that executes nothing — from halting. A
  deliberate trade of a rare false negative for a common false positive, recorded so it reads as a
  decision rather than an omission.
- **A payload behind a RELOCATING launcher is scanned from the command's cwd, not the launcher's.**
  `env -C scripts bash -c 'cd ..'` lands back inside the worktree in reality, and halts here, because
  the `-C` target is checked but is not threaded into the payload's starting cwd. An over-halt, in the
  loud direction, on a shape a planner is unlikely to write.
- **An operand-taking option ordering outside the grammar.** Options that take a separate operand
  are matched interleaved with ordinary ones, so `env -u FOO --debug -u BAR -C ../main` is seen; a
  spelling outside each tool's own list still is not.
- **A launcher form outside the grammar**: `env -S 'cmd args'`, a launcher named through a quoted
  string, or an option-with-operand spelling not in the tool's list. Which options take an operand is
  TOOL-SCOPED (`-i` takes one on `stdbuf`, none on `env`); a flat list consumed the command itself
  after an operandless flag.
- **`_DIR`'s tool-to-flag run is still a catch-all**, so a pass-through argument that happens to spell
  a directory flag can over-halt: `npm run package -- --prefix=../main/` halts although the flag goes
  to the script, not to npm. Pre-existing, and again in the loud direction.
- **A non-shell payload whose path is computed.** `python3 -c` / `node -e` payloads are scanned *as
  shell text*, which catches a path written as a literal word (`os.chdir('/main')`) and not one the
  program assembles (`os.path.join(root, '..')`).
- **Wrapping nested more than four deep.** `_walk` bounds its own recursion.
- **A directory flag on a tool outside the recognized set.** `--prefix`/`--cwd`/`--dir`/`-C` on `npm`
  `npx` `pnpm` `yarn`, `-C`/`--directory` on `make` `git`, and `--chdir`/`-C` on `env` itself — the
  last because `env` is not only a launcher, it relocates — including behind a launcher. The
  scoping is per-tool because the same spelling is not the same flag everywhere: `git archive
  --prefix=` names archive members and changes no directory. For an unrecognized tool the **absolute**
  form of its flag is still caught by the catch-all; what is uncovered is the **relative** form.

The enumerations are the parts that rot: they mirror a toolchain this file does not own. Adding a tool
is one alternation in `_DIR` plus a row in each of the two tables in
`tests/executor-mvp-tdd-section.test.cjs`. The guard is the executor's last containment check, not its
only one — a halt it misses still has to get past `check verify-command-paths` at plan time.
