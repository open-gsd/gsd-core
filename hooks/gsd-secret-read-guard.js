#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Secret Read Guard — PreToolUse hook (Read | Grep | Bash)
//
// Blocks reads of secret files — `.env`, `.env.<suffix>`, `.secrets` — by any
// of the three tools that can put file contents into the conversation: the
// Read tool (file_path), the Grep tool (an explicit path or a glob that
// selects the secret namespace), and Bash (a command whose operands or input
// redirects name a secret file, including inside `$( )`, backticks, `<( )`,
// `bash -c '…'` / `eval "…"` bodies, and `git show <ref>:<path>` shapes).
//
// Why a hook and not permission rules (#4221): since #768 the installer wrote
// three `Read(.env)` / `Read(.env.*)` / `Read(.secrets)` deny rules into
// settings.json. Claude Code 2.1.259 hardened the Bash-side enforcement of
// Read() deny rules so that ANY `cd DIR && cat/grep relative-path` compound
// prompts for approval whenever any Read() deny rule exists — even in `auto`
// permission mode. GSD subagents emit hundreds of those per session. A
// PreToolUse denial is not a permission rule, so it never arms that check,
// and it applies in `auto` and `bypassPermissions` modes alike. The three
// installer-written strings are retired by the same installer change (they
// are filtered out as legacy entries on install and uninstall).
//
// What counts as a secret name (basename match, no path resolution, matched
// case-INSENSITIVELY so `.ENV` / `.Secrets` are caught on the macOS/Windows
// filesystems where they ARE the secret file — the write guard's `/i` stance):
//   .env, .secrets, and .env.<suffix> — EXCEPT .env.example / .env.sample /
//   .env.template / .env.dist, which are the non-secret templates GSD's own
//   phase prompt tells executors to read.
//   Stated cost (#4580): the exemption matches the token's FINAL EXTENSION,
//   not the whole name, so the trusted set is `.env.<anything>.example` /
//   `.sample` / `.template` / `.dist` — an unbounded family, not four fixed
//   names. A real secret named `.env.prod-real-secrets.example` is NOT
//   protected, and renaming any secret to end in one of those four
//   extensions bypasses the guard across Read, Grep and Bash alike. This is
//   the deliberate cost of #4580, which fixed the prior whole-name
//   comparison wrongly refusing committed, secret-free templates like
//   `.env.local.example`.
//   A token containing `:` is also tested on the part after its LAST `:`,
//   so `git show HEAD:.env`, `origin/main:config/.env` and `C:\proj\.env`
//   are caught without git-specific parsing. Leading/interior whitespace is
//   still NOT trimmed: the commit message `fix: .env parsing` yields
//   ` .env parsing`, which is prose, not a name. TRAILING dots and spaces ARE
//   stripped from the basename before classification (`.env.`, `.env..`,
//   `.env `, `.env. ` all normalize to `.env`), because Win32 strips trailing
//   dots and spaces from each path component, so these are aliases for the
//   same on-disk file, not distinct names.
//
// Bash analysis is a two-pass token scan, not a shell:
//   pass 1 tokenizes with quote state (dollar-quoting included, below),
//   comments, redirect operators (with fd digits and `>&N` dups),
//   separators (recording the operator text), `$( )` /
//   backtick / `<( )` / `>( )` spans (recursed as nested commands, depth ≤ 3),
//   and heredocs (one token per body, carrying its `<<` segment). A heredoc
//   body is only ever run as a script when its segment's command is a shell
//   interpreter (below); a DATA heredoc — `cat <<EOF … EOF`, the agent-
//   populated bodies in GSD's own workflows, `git commit -m "$(cat <<'EOF' …
//   EOF)"` — is never operand-checked, so prose mentioning `.env` is safe.
//   pass 2 groups tokens by segment and evaluates each on its own:
//   input redirect targets (`<`, `N<`) are always checked; the command word is
//   located past wrapper prefixes AND their own options (`sudo -u U`,
//   `env -i VAR=x`, `timeout -s KILL 5`, `nice -n 5`, `stdbuf -oL`, `exec`;
//   see WRAPPERS, #5627) and inside an `env -S '…'` string, split by env's own
//   rules (#5514); a closed set of
//   NON-READING commands (test/[/ls/stat/rm/touch/echo/…) exempts that
//   segment's operands — `[ -f .env ]` and `ls .env*` are existence checks
//   GSD's own agents run — while `cp`/`mv`/`ln`/`git` are deliberately NOT
//   exempt (`cp .env x && cat x` launders the name; `git show HEAD:.env`
//   reads). Narrower carve-outs exempt single operand POSITIONS that are
//   names, never contents, and keep checking the rest of the segment: the
//   `--env-file` value under a container runtime (#4639), the pathspecs of
//   `git check-ignore` / `git ls-files` / `git rm --cached`, and the
//   destination of a one-source `cp`/`mv` (#4856). The #4856 carve-outs
//   fail closed: an option they do not list withdraws them from the segment.
//   A git global option the walker does not know also keeps the #5045 `-c`
//   scan running over every later word (see walkGitGlobals).
//   A shell interpreter (bash/sh/zsh/dash/ksh/su) has its script scanned
//   whether it arrives via `-c '…'`, a `<( )` file operand, a heredoc /
//   here-string, or a pipe from a knowable `echo`/`printf` source
//   (`echo cat .env | bash`) or a bare `cat` printing a heredoc / here-string
//   (`cat <<'EOF' | bash`, `bash <(cat <<< 'cat .env')`, #6182); `eval` scans
//   its joined operands; `source`/`.` scans a `<( )` operand; and `find … | xargs cat` infers the upstream
//   segment's names as the sub-command's read operands, as `xargs cat <<< .env` does a here-string's words.
//
// Dollar-quoting (#5255): a command holding `$'…'` or `$"…"`, a run of `$`
// before `{` or `(`, or a quote and zsh's arithmetic (`((`, `$[`), is scanned under
// bash's, zsh's and dash's reading of it, then the scan as it was before
// #5255, and denied on any; a `$'…'` word with
// no value to check is denied as `ansi-c-unterminated` / `ansi-c-undecodable`.
// The readings, and what they do not reach, are in "Bash command scan —
// dollar-quoting" below.
//
// Project exemptions (#4432): `hooks.secret_read_exempt` in the root project's
// .planning/config.json lists repo-relative files that stay readable. An entry
// takes effect only for a file that is a regular file on disk AND a regular
// blob (100644/100755) in the commit HEAD names — read from `.git` directly,
// no subprocess, no timer (hooks/lib/git-head-tree.js). Read and Grep honor an
// absolute or cwd-relative path; Bash honors the absolute path only, and only
// when EVERY command on the line is one of cat/head/tail/grep/egrep/fgrep/rg/
// wc/diff/cmp/sort/uniq/cut/nl/od (after wrapper resolution) with no `$( )`/
// backtick/`<( )` body, heredoc or file-writing redirect or option; any other
// command (mv, ln, cp, git, sh, awk, sed, …) withdraws it for the whole line. A Grep
// `glob` is never widened, and a colon-joined word (`HEAD:.env.production`)
// never matches. An unreadable config or repository means no exemption.
//
// Grep globs are judged per brace alternative (never on the whole glob, so
// `{.env.local,zzz.ts}` cannot hide behind a benign sibling): a pure-wildcard
// alternative (`*`, `**`) is allowed — Grep already skips gitignored files,
// so it is equivalent to no glob; any other alternative is denied when its
// literal prefix is a prefix of `.env.`/`.secrets` (`.e*`, `.env*`, `.s*`) or
// when it matches a probe secret name (`*.local`, `*.*`, `*.env*`). More than
// 64 alternatives is denied as `glob-too-complex` (cheap to retry narrower),
// and so is a glob with so many brace groups that expanding them overflows
// the stack.
//
// Documented gaps (none are statically resolvable by a hook, and Claude
// Code's own 2.1.259 Bash-side enforcement does not resolve them either):
//   `$VAR` indirection (`bash -c "$TEST_CMD"`, `cat "$F"`, and a `${VAR}`
//   inside an `env -S` string that is set, `Z=claude env -S '${Z} …'`,
//   `P=.env env -S 'cat ${P}'`: the string is read with each `${VAR}` kept as
//   written and with it empty, as env expands an unset name), shell globs
//   (`cat .e*`), interpreter one-liners (`python -c "open('.env')"`), a piped
//   script from a non-echo source (`cat gen.sh | bash`, `curl … | sh`), reads
//   inside scripts the agent executes, and `glob: '*'` reaching a
//   NON-gitignored `.env`, a wrapper (or wrapper option taking a
//   separate value) the WRAPPERS table does not list, and a plain command in
//   an `env -S` string in the sub-command of `xargs`, a `find -exec` action or
//   `watch -x` (`xargs env -S 'cat .env'`, `find . -exec env -S 'cat .env' \;`,
//   `watch -x env -S 'cat .env'`), though the secret-read scan does read a
//   shell script there (#6114; the debugger-spawn check reads none of these
//   sub-commands, #6147); the sub-command's own words are still checked as
//   operands. An `env -S` string behind a shell reserved word (`if`,
//   `then`, `elif`, `else`,
//   `while`, `until`, `do`, `!`, bash's `coproc`, zsh's `repeat N`,
//   `nocorrect`, `noglob` and `-`) can go unread
//   (`if true; then env -S 'cat .env'; fi`,
//   `for i in 1; do env -S 'cat .env'; done`, `! env -S 'cat .env'`, which
//   bash 5.2 and dash 0.5.12 run; `coproc env -S 'cat .env'`, which bash 5.2
//   runs; `repeat 1 env -S 'cat .env'` and `noglob env -S 'cat .env'`, which
//   zsh 5.9 runs); the command's own operands are still checked. `env -S`
//   strings are
//   split by GNU coreutils env's rules, and also by FreeBSD/macOS env's (a
//   backslash before a blank is that blank) and uutils env's (a
//   backslash-newline removed, a comment ended by a newline), and read as
//   before #5514, skipped as the option's value; any reading's hit denies.
//   Each reading applies one env's rules at every level, so a string that one
//   env splits into a command running a different env (BSD env invoking a
//   uutils env by path) is not read by the mix of the two.
//   Reached through the same gaps and allowed under
//   every reading, so the decoded-value check (#5255) does not cover them:
//   a `${…}` form that is not a default (`${x/y/.env}`, `${x:0:1}.env`,
//   `${x:-${y}.env}`, whose inner expansion is unknown), or a default another
//   command produces (`${x:-$(echo .env)}`); a quoted default whose bare name is
//   its own word (`"${x:-update .env docs}"`, also with text around the
//   expansion) is denied as the unquoted one; a word with no whitespace of its
//   own and more than 12 optional defaults (or past 2 MB of variants) is denied
//   outright, one with whitespace (a script, a sentence) gets each default on
//   its own, all and none past that; a heredoc tag whose `${…}` holds a quoted `}`, which only
//   the bash and zsh readings read and only with a trigger
//   (`: <<${x#'}'}<newline>${x#'}'}<newline>cat .env`); some arithmetic the
//   scan reads differently from the shell, given here by example with the
//   shells that run each, not as a whole class:
//   `echo $(( ' $(cat .env >&2) ' ))` (bash, dash, zsh),
//   `if((' $(cat .env >&2) '));then :;fi` (bash),
//   `{((' $(cat .env >&2) '));}` (bash, zsh),
//   `echo $[ \[ ' $(cat .env >&2) ' ]` (bash, zsh),
//   `echo $[ \] ' $(cat .env >&2) ' ]` (bash, zsh),
//   `(( \( ' $(cat .env >&2) ' ))` (bash) and
//   `(( \) ' $(cat .env >&2) ' ))` (bash, zsh);
//   a `#` comment in a
//   `$( )`, whose `(` or `)` the scan counts
//   (`echo $(#)'<newline>); cat $'.env' #'`); and a `$` before a line
//   continuation that opens a `$(` inside "…" or a heredoc body
//   (`echo "$\<newline>(cat .env)"`). The tests
//   pin each as allowed, and #5945 and #6132 track them with the further
//   shapes found while closing #5255. The promise is "no looser than
//   the retired rules on plain commands, without arming the compound-`cd`
//   prompt". Writes to secret files are out of scope (Write/Edit were never
//   gated). Commands over 1 MiB are denied outright (`command-too-large`)
//   rather than scanned partially or waved through, and so is a command
//   whose scan overflows the stack or needs more than eight times that much
//   work (`command-too-complex`), and one with an `env -S` string nested
//   more than MAX_NESTING_DEPTH deep (`split-string-too-deep`), whose command
//   is not read. (#4639 adds one more, by design: the
//   value of `--env-file` under a container runtime is exempt, so the
//   container's own command can print the interpolated environment
//   (`alpine printenv`, `docker compose config`) — the same exposure class
//   as the pre-existing volume-mount gap (`-v .env:/s`); the flag's value
//   itself is a name, never contents. #4856 adds another: the `cp`/`mv`
//   destination exemption can move a link prepared under a non-secret name
//   onto a secret name (`ln -s .env.example l && mv l .env`), so a later
//   edit of `.env` lands in the link target — a write redirection, the
//   out-of-scope write class, not a read. #4432 adds three stated limits to
//   the project exemptions: (1) an agent with Bash can rewrite local git state
//   (force-add + commit, `update-ref`) to make a file committed; the
//   committed-file rule stops the one-step "edit the config, then read" path
//   and is the same class as the interpreter one-liner gap above — a
//   guardrail, not a sandbox. (2) The guard vouches for the path, not for
//   working-tree bytes that differ from HEAD; a content-hash check would block
//   re-reading the template after each edit, the flow the issue asks for.
//   (3) A file inside a git submodule cannot be exempted: the submodule's
//   `.git` is a file the reader does not follow.)
//
// A second, unrelated contract is enforced on the Bash leg because this is the
// one hook that already parses EVERY Bash command (#5214): a Bash command that
// launches the debugger as a CLI process — `claude … --agent gsd-debugger` — is
// denied (`debugger-cli-spawn`). The debug session manager is required to spawn
// gsd-debugger with `Agent(run_in_background=false)` so it can read the
// debugger's structured return; on a captured 1.15.0 run it routed around that
// literal and shelled out with the Bash parameter `run_in_background: true`,
// so no return ever came back and the checkpoint never advanced. Prose in the
// agent file cannot stop an improvised tool call; a PreToolUse denial can, and
// Claude Code runs plugin hooks for a subagent's tool calls too. A person
// running `claude --agent gsd-debugger` in their own terminal never reaches
// this hook. Only the debugger is named: it is the agent whose blocking return
// the managed debug loop depends on.
//
// Triggers on: Read, Grep, Bash tool calls (Kimi: ReadFile, Grep, Shell)
// Action: BLOCK (decision: 'block', exit 2) — codes secret-read |
//         glob-too-complex | command-too-large | command-too-complex | nesting-too-deep |
//         split-string-too-deep | ansi-c-unterminated | ansi-c-undecodable |
//         debugger-cli-spawn, and guard-error when the host opted in to
//         deny-on-crash (#5784)
// No-op: other tools, non-secret targets, hook errors (fail open — a parser
//        bug in a hook that runs on EVERY Bash call must never brick a
//        session; the crash policy is declared once below). One error is
//        not a bug but a limit: a Bash command nested deep enough to
//        overflow the parser's stack, or one that needs more than the scan's
//        work budget, is denied as `command-too-complex` (#5255), because
//        failing open there allows a read the scan had not yet reached.
//        Any other error in one of the readings that run beside the plain
//        one — the dollar-quoting readings (#5255) — is a bug, and the hook
//        fails open on it as on a crash: that reading's denials are lost, the
//        other readings' stand, and when nothing denies the command the hook
//        writes one `reading-failed` line on stderr (DIAGNOSTIC.READING_FAILED).
//        An error in a scan of the further reading (#5779) is taken as one in
//        a scan of an `env -S` reading (#5514) is: that scan finds nothing,
//        the scans after it still run, and a command nothing denies gets the
//        host's crash policy.
//        A host may opt in to failing closed instead with
//        GSD_SECRET_READ_GUARD_ON_CRASH=deny (#5784): a hook error, a shell
//        reading that fails on a command no scan blocked (its
//        DIAGNOSTIC.READING_FAILED line is written in both modes), or a stdin
//        that does not close within 3 s then blocks with code guard-error.

'use strict';

const { HOOK_ON_CRASH, allow, deny, crash } = require('./lib/hook-exit.js');
const { finalExtension, normalizeWindowsBasename, lastSegment } = require('./lib/filename-classification.js');

// Fail open on a hook-internal error (see header). Declared ONCE so the
// outer catch states its policy explicitly (#3911). A host that registers this
// guard with Claude Code's `onFailure: "block"` can opt in to DENY with
// GSD_SECRET_READ_GUARD_ON_CRASH=deny (#5784): `onFailure` cannot see a failure
// the hook catches itself and exits 0 on, so without this a crash, a shell
// reading that fails on a command no scan blocked, or a stalled stdin still
// allows. Any other value, or none, keeps ALLOW. Read once, before stdin, so
// the policy is settled before any failure it governs.
const ON_CRASH = process.env.GSD_SECRET_READ_GUARD_ON_CRASH === 'deny'
  ? HOOK_ON_CRASH.DENY
  : HOOK_ON_CRASH.ALLOW;

// Which failure a guard-error block is for, as its payload's `cause` field
// (#5784): a host or a test reads this, never the reason's prose.
const GUARD_ERROR_CAUSE = Object.freeze({
  HOOK_ERROR: 'hook-error',
  READING_FAILED: 'reading-failed',
  STDIN_STALL: 'stdin-stall',
});

// Ends the hook through the declared crash policy. On DENY the payload names
// the cause and stderr carries its plain reason, as emitBlock's denials do:
// Kimi's hook bus reads stderr back to the model verbatim. On ALLOW both stay
// undefined, so the default path is crash(ALLOW, undefined) and emits nothing,
// exactly as before.
function crashFor(cause, why) {
  if (ON_CRASH !== HOOK_ON_CRASH.DENY) {
    crash(ON_CRASH, undefined);
    return;
  }
  const reason = `gsd-secret-read-guard: ${why}; denied because GSD_SECRET_READ_GUARD_ON_CRASH=deny`;
  crash(ON_CRASH, { decision: 'block', code: 'guard-error', cause, reason }, reason);
}

// Commands longer than this are denied rather than scanned (see header).
const MAX_COMMAND_LENGTH = 1024 * 1024;

// Recursion budget for `$( )` / backtick / `<( )` / nested-shell rescans, and
// for `env -S` strings split inside a split string (#5514). A body nested deeper is denied as
// `nesting-too-deep` (#6136), the way an over-length command is denied, never allowed unscanned;
// an `env -S` string nested deeper is denied as `split-string-too-deep`.
const MAX_NESTING_DEPTH = 3;

// Work budget for one Bash command, in characters tokenized, across every
// pass the scan makes over it (#5255): setCommandBudget sets it once, and every
// reading, nested rescan, second look and heredoc pass spends from it. A
// command holding a reading trigger (`$'`, `$"`, `$${`, `$$(`, or a quote with
// `((` or `$[`; readsEachWay) is scanned under four readings and then, when
// they find nothing, four more times by readAsBefore, so its text costs 8 times
// its length; a nested body that holds one (`$( )`, backticks, `<( )`,
// `eval`, `bash -c`, a heredoc or here-string fed to a shell) costs 8 times its
// own length on top, at each level; and a command holding `<<` is scanned
// again under #5513's other heredoc readings (findSecretReadUnderOtherReadings),
// up to three passes, or five when a heredoc tag holds a brace. A heredoc file
// write holding a trigger therefore costs about 24 times its length. A command
// holding an `env -S` option is scanned again under each of ENV_S_READINGS
// (#5514), up to seven passes, all on this one budget. The
// separators every tokenize finds are bounded separately (MAX_SCAN_SEPARATORS),
// the debugger-spawn check's included. The most any of 1,384,856 distinct real
// agent commands needed was 3,040,992 (a 126,708-character heredoc write). The
// costliest shape measured is 1 MiB of redirections in one segment (`b<>`
// repeated) after a `$'a'`, which the spawned hook scans to the end in at most
// 2.2 s wall, 2.5 s CPU, at load 42 on 32 cores; at the same load `next`'s own
// costliest, 1 MiB of `a;b&`, took up to 2.6 s wall. That keeps the hook well
// inside the 8 s after which the Kilo and OpenCode adapters allow a command.
// A command that needs more is denied as
// `command-too-complex` rather than scanned on. Characters here, and in
// MAX_COMMAND_LENGTH, are UTF-16 code units (`String.length`).
const MAX_SCAN_CHARACTERS = 8 * MAX_COMMAND_LENGTH;

// Brace-alternative budget for a Grep glob before it is denied as too complex.
const MAX_GLOB_ALTERNATIVES = 64;

// #4432: project exemptions (`hooks.secret_read_exempt` in the ROOT project's
// .planning/config.json). `root`/`allowRelative` are set once per invocation by
// the stdin handler; `checker` is built lazily on the first secret-classified
// token. Any failure while building or calling it means NOT exempt — never an
// allow, and never a throw into the fail-open crash path.
const exemption = { root: null, allowRelative: false, checker: null, configured: false, bashLine: null, bashReadOnly: null };

// F3: a Bash exemption holds only when every command on the line is one of
// these read-only readers; any other command anywhere on the line withdraws it
// for every token (`mv a b && cat <exempt>` re-anchors or launders the name).
const READ_ONLY_COMMANDS = new Set([
  'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'diff', 'cmp', 'sort', 'uniq', 'cut', 'nl', 'od',
]);

// Per-command options that write a file or run a program, so the command is
// not read-only: `sort -o f`, `sort --compress-program`, `rg --pre`.
function readOnlyOptionsOnly(base, operands) {
  let positional = 0;
  for (const w of operands) {
    const t = w.text;
    if (base === 'sort' && (/^-[A-Za-z]*o/.test(t) || /^--(output|compress-program|files0-from)/.test(t))) return false;
    if (base === 'rg' && /^--(pre|pre-glob|hostname-bin)(=|$)/.test(t)) return false;
    if (base === 'uniq' && !t.startsWith('-')) positional++;
  }
  return base !== 'uniq' || positional <= 1; // `uniq in out` writes `out`
}

// Fail closed: a substitution body, heredoc, process substitution, file
// redirect out, unresolved or unlisted command word, or any exception is false.
// The line is read as the scan reads it (#5255): a command holding a reading
// trigger is read-only only if it is under the plain reading and under each of
// READINGS, since a `$'…'` span the plain reading takes as an open quote can
// hide a command bash runs (`cat <exempt> $'\''; mv a b`), and a word with no
// value to check is not read-only.
function lineIsReadOnly(command) {
  try {
    const readings = readsEachWay(command) ? [false, ...READINGS] : [false];
    return readings.every((reading) => lineIsReadOnlyUnder(command, reading));
  } catch {
    return false;
  }
}

function lineIsReadOnlyUnder(command, reading) {
  const { tokens, nested, unreadable } = tokenizeCharged(command, reading);
  if (nested.length > 0 || unreadable) return false;
  const bySeg = new Map();
  for (const t of tokens) {
    if (t.kind === 'heredoc') return false;
    if (t.kind === 'sep') continue;
    if (t.kind === 'word' && t.procsub !== undefined) return false;
    if (!bySeg.has(t.seg)) bySeg.set(t.seg, []);
    bySeg.get(t.seg).push(t);
  }
  for (const segTokens of bySeg.values()) {
    const words = [];
    for (let k = 0; k < segTokens.length; k++) {
      const t = segTokens[k];
      if (t.kind === 'op') {
        if (t.dup) continue;
        const target = segTokens[k + 1];
        if (!target || target.kind !== 'word') return false;
        k++;
        if (!t.read && target.text !== '/dev/null') return false; // output to a file
        if (t.text.endsWith('<<<')) return false;
        continue;
      }
      words.push(t);
    }
    if (words.length === 0) return false;
    const cmd = resolveCommand(words);
    if (!cmd || !READ_ONLY_COMMANDS.has(cmd.base)) return false;
    if (!readOnlyOptionsOnly(cmd.base, cmd.operands)) return false;
  }
  return true;
}

function isExemptSecret(tok) {
  if (exemption.root === null) return false;
  if (exemption.bashLine !== null) {
    if (exemption.bashReadOnly === null) exemption.bashReadOnly = underPlainReading(() => lineIsReadOnly(exemption.bashLine));
    if (exemption.bashReadOnly !== true) return false;
  }
  try {
    if (exemption.checker === null) {
      const lib = require('./lib/secret-read-exemptions.js');
      const entries = lib.readExemptEntries(exemption.root);
      exemption.configured = entries.length > 0;
      exemption.checker = entries.length === 0
        ? () => false
        : lib.createExemptionChecker({ root: exemption.root, entries, allowRelative: exemption.allowRelative });
    }
    return exemption.checker(tok) === true;
  } catch {
    exemption.checker = () => false;
    return false;
  }
}

// `.env.<suffix>` names that are templates, not secrets (case-insensitive).
const NON_SECRET_ENV_SUFFIXES = new Set(['example', 'sample', 'template', 'dist']);

// Command-prefix wrappers to look through when locating the command word at
// the head of a segment (#5627). Each wrapper runs the words that follow its
// own options, so the table records what resolveCommand must step over:
//   short    letters of short options that take a value (`-n 5`, `-n5`)
//   long     long options that take a SEPARATE value word (`--adjustment 5`);
//            `--opt=value` is one word and needs no entry
//   assigns  leading `VAR=value` words belong to the wrapper (env)
//   split    the option whose value is itself a command line: `env -S STRING`
//            splits STRING into words that are read in its place (#5514)
//   operands positional words after the options (timeout's DURATION)
// Taken from sudo(8), doas(1), env(1), nice(1), time(1), timeout(1),
// stdbuf(1), setsid(1) and bash's `command`/`exec`. A wrong entry fails open
// (the option's value becomes the command word), so keep it to the man pages.
const WRAPPERS = new Map([
  ['sudo', { short: 'aCcDghpRrTtUu', long: ['--auth-type', '--close-from', '--login-class', '--chdir', '--group', '--host', '--prompt', '--chroot', '--role', '--command-timeout', '--type', '--other-user', '--user'],
    // No-value long options, so an exact one never prefix-matches a longer
    // valued one (`--login` vs `--login-class`).
    flags: ['--askpass', '--background', '--bell', '--edit', '--help', '--list', '--login', '--non-interactive', '--preserve-env', '--preserve-groups', '--remove-timestamp', '--reset-timestamp', '--set-home', '--shell', '--stdin', '--validate', '--version'] }],
  ['doas', { short: 'aCu' }],
  ['env', { short: 'uCSaP', long: ['--unset', '--chdir', '--split-string', '--argv0'], assigns: true, split: { short: 'S', long: '--split-string' } }],
  ['nice', { short: 'n', long: ['--adjustment'] }],
  ['nohup', {}],
  ['command', {}],
  ['time', { short: 'fo', long: ['--format', '--output'] }],
  ['timeout', { short: 'sk', long: ['--signal', '--kill-after'], operands: 1 }],
  ['stdbuf', { short: 'ioe', long: ['--input', '--output', '--error'] }],
  ['setsid', {}],
  // `busybox sh -c`, `chroot NEWROOT cmd`, `flock FILE cmd` run the command that follows (#6114).
  ['busybox', {}],
  ['chroot', { operands: 1 }],
  ['flock', { short: 'wE', long: ['--timeout', '--wait', '--conflict-exit-code'], operands: 1 }],
  ['exec', { short: 'a' }],
]);

// A further reading of a segment's command (#5779). The WRAPPERS walk stops at a
// word it does not know and takes it for the command, so `then curl …`, `! bash
// -c …` and `time ! cat …` hide the command behind it. This reading walks past
// those words, as a scan of its own (furtherReading) after the plain scans found
// nothing. It only adds, so what the plain scans deny stays denied (`if [ -f .env ];
// then`, a script named `repeat`).
//   keyword  a shell keyword, so a keyword or an assignment may follow (`time ! cmd`)
//   count    the next word is a count, whatever it looks like (`repeat -1+2 cmd`)
//   assigns  the wrapper's rule for a word that sets a variable: env takes any word
//            holding `=`, sudo's parse_args one not starting `/` or `=`; doas none
//   dashDashEndsAssigns  a word right after `--` is no assignment: sudo's
//            `got_end_of_args` tests whether the previous word is `--`, so
//            `sudo -- A=b cmd` runs a program named `A=b`. env still assigns there
//   dash     a lone `-` is an option (env's `-i`)
const FURTHER_WRAPPERS = new Map([
  ...WRAPPERS,
  ['sudo', {
    ...WRAPPERS.get('sudo'),
    assigns: /^[^/=][^=]*=/,
    dashDashEndsAssigns: true,
  }],
  ['env', { ...WRAPPERS.get('env'), assigns: /=/, dash: true }],
  ['builtin', {}],
  ['noglob', {}],
  ['nocorrect', { keyword: true }],
  ['-', {}],
  ['repeat', { count: true, keyword: true }],
  ['time', { ...WRAPPERS.get('time'), keyword: true }],
]);
// Homebrew's coreutils, findutils and gnu-time install these under a `g` name.
for (const name of ['env', 'nice', 'nohup', 'timeout', 'stdbuf']) {
  FURTHER_WRAPPERS.set(`g${name}`, FURTHER_WRAPPERS.get(name));
}
FURTHER_WRAPPERS.set('gtime', WRAPPERS.get('time')); // a program, not a keyword

// Shell reserved words a command can follow in its segment: `then cmd`,
// `do cmd`, `if cmd`, `! cmd`, `coproc cmd`. A word the tokenizer saw quoted is
// a command name.
const SHELL_COMMAND_KEYWORDS = new Set(['!', 'if', 'elif', 'else', 'then', 'while', 'until', 'do', 'coproc']);
// Words after which bash still takes an assignment in front of the command.
const ASSIGNMENT_PREFIX_WORDS = new Set([...SHELL_COMMAND_KEYWORDS, 'time']);
// Loop heads a body can follow with no separator: `for i do cmd`, and zsh's
// `for a b do cmd`. The first word is the variable, whatever it spells; an `in`
// after it starts a word list, which only a separator ends.
const LOOP_HEADS = new Set(['for', 'select']);

let furtherReading = false;
// The further reading runs once without bash's subscript joins (`a[x y]=1` as
// one word) and, only when that pass allowed and saw a place a join could
// start (joinCandidate), once more with them. A join swallows text into one
// word, so it is kept out of the pass whose denials it could otherwise lose.
let subscriptJoins = false;
let joinCandidate = false;

// Runs `read` with this file's further-reading state off, then restores it.
// #4432 decides once per command whether every command on the line is a
// read-only reader (`exemption.bashReadOnly`), on the first secret-named token
// it meets. When that token is first met in the further reading, the decision
// must still be the plain reading's, or this reading could grant an exemption
// the plain one withholds.
function underPlainReading(read) {
  const saved = [furtherReading, subscriptJoins, joinCandidate];
  furtherReading = false;
  subscriptJoins = false;
  try {
    return read();
  } finally {
    [furtherReading, subscriptJoins, joinCandidate] = saved;
  }
}

// Commands whose ordinary operands are file NAMES, never file CONTENTS. A
// closed set on purpose: anything not listed is assumed to read.
const NON_READING_COMMANDS = new Set([
  'test', '[', '[[', 'ls', 'stat', 'touch', 'rm', 'chmod', 'chown', 'mkdir',
  'basename', 'dirname', 'realpath', 'file', 'echo', 'printf',
]);

// #4639: container runtimes take `--env-file <file>` — the runtime opens the
// file itself, interpolates it into the container environment, and returns
// nothing to the agent, so the flag's VALUE is a name, never contents. The
// same category NON_READING_COMMANDS encodes, expressed as a flag value. Only
// the flag's value under these runtimes is exempt; every other operand in the
// segment is still checked, so the carve-out cannot launder a read.
const CONTAINER_RUNTIMES = new Set(['docker', 'docker-compose', 'podman', 'nerdctl']);
const ENV_FILE_FLAG_RE = /^--env-file(=|$)/;

// #4856: git subcommands that report or drop a path's ignore / tracking
// status and never print the file, so their pathspec operands are names —
// the category NON_READING_COMMANDS encodes. Each carries the closed set of
// its NO-VALUE options (from `git <subcommand> -h`, git 2.49). Any other
// option withdraws the exemption from the whole segment, so an option value
// is never mistaken for a pathspec: `-X <file>` reads the file, and
// `--pathspec-from-file=<file>` echoes its lines in the "did not match"
// error. `requires` names the option without which the subcommand stays
// checked (#4856 scopes `git rm` to `--cached`).
const GIT_PATHSPEC_SUBCOMMANDS = new Map([
  ['check-ignore', {
    flags: new Set(['-q', '--quiet', '-v', '--verbose', '--stdin', '-z', '-n', '--non-matching', '--no-index', '--index']),
  }],
  ['ls-files', {
    flags: new Set([
      '-z', '-t', '-v', '-f', '-c', '--cached', '-d', '--deleted', '-m', '--modified', '-o', '--others',
      '-i', '--ignored', '-s', '--stage', '-k', '--killed', '-u', '--unmerged', '--directory', '--eol',
      '--no-empty-directory', '--resolve-undo', '--exclude-standard', '--full-name',
      '--recurse-submodules', '--error-unmatch', '--abbrev', '--debug', '--deduplicate', '--sparse',
    ]),
  }],
  ['rm', {
    flags: new Set(['--cached', '-f', '--force', '-n', '--dry-run', '-q', '--quiet', '-r', '--ignore-unmatch', '--sparse']),
    requires: '--cached',
  }],
]);

// git's global options (git.c handle_options, git 2.49) — the ONE vocabulary
// both the #4856 pathspec exemption and the #5045 -c scan walk, via
// walkGitGlobals. A value option consumes the next word; the long options in
// GIT_GLOBAL_EQUALS_FORM_OPTIONS also take it attached as `--opt=value`.
// `-C`, `-c` and the hidden `--shallow-file` accept only the separate word
// (git rejects `--shallow-file=x` and `-c<name>=<value>`), and
// `--exec-path` runs a subcommand only as `--exec-path=<path>` (bare, it
// prints the path and exits). Any other option fails closed for both
// consumers: its arity is unknown, so its value could be read as the
// subcommand (`git -C ls-files show HEAD:.env` runs `show`). The pathspec
// exemption is withdrawn, and the -c scan keeps collecting every later
// `-c <value>` pair instead of stopping.
const GIT_GLOBAL_VALUE_OPTIONS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source',
  '--shallow-file',
]);
const GIT_GLOBAL_EQUALS_FORM_OPTIONS = new Set([
  '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--exec-path',
]);
const GIT_GLOBAL_FLAGS = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--no-lazy-fetch',
  '--no-optional-locks', '--no-advice', '--bare',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
]);

// #4856: `cp`/`mv` write their destination and never print it, so a secret
// name that is ONLY the destination of a one-source copy or move is a name
// (`cp .env.example .env`). The exemption holds for exactly two operands
// behind options from this closed set; anything else keeps the whole segment
// checked — `-t`/`--target-directory` (every operand becomes a source), a
// backup (`-b`, `--backup`, `-S`: the old secret survives as `.env~`, a name
// the predicate does not classify), a link (`-l`, `-s`) or `--exchange`
// (the destination shares or swaps the secret). Options must precede the
// operands: a trailing one is an option under GNU getopt's permutation but
// an operand under POSIXLY_CORRECT (`cp a .env -f` then copies `.env` INTO
// `-f/`), so which word is the destination would hang on an environment
// the hook cannot see.
const COPY_NAME_ONLY_FLAGS = new Set(['-f', '--force', '-i', '--interactive', '-n', '--no-clobber', '-v', '--verbose']);

// Shell interpreters that run a script from `-c`, a file operand, or stdin
// (heredoc / here-string / piped `echo`|`printf`). `su` is here for its `-c`
// form (`su [user] -c 'cmd'`); a bare `su user` resolves to file mode, which
// only runs the ordinary operand check. `eval`, `source`/`.` and `xargs` are
// their own cases below; they are not in this set.
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'su', 'ash', 'fish', 'csh', 'tcsh']);

// Shell flags whose VALUE is the next operand (`bash -o pipefail`,
// `bash --rcfile x <<EOF`): skipped when locating a script-file operand, so a
// flag value is not mistaken for the script and stdin mode still applies.
const SHELL_VALUE_FLAGS = new Set(['-o', '-O', '+o', '+O', '--rcfile', '--init-file']);

// Value-taking `xargs` flags (long `--flag=value` forms are single words).
// `-a`/`--arg-file` additionally replaces stdin, so it suppresses the pipeline
// inference below. `-i` and `-l` are not here: GNU xargs takes their value only
// attached (`-iR`, `-l1`), so the word after a bare one is the command.
const XARGS_VALUE_FLAGS = new Set(['-n', '-I', '-L', '-P', '-s', '-d', '-E', '-a']);

// Probe names a Grep glob alternative is matched against. `.env` and
// `.secrets` are the exact names; the rest stand in for the open-ended
// `.env.<suffix>` family so empty-literal-prefix selectors (`*.local`,
// `*.production`, `*env.*`) are caught. Residual, stated in the header:
// an alternative like `*.ts` matches no probe and is allowed even though a
// `.env.foo.ts` would satisfy the name predicate.
const GLOB_PROBES = [
  '.env', '.secrets', '.env.local', '.env.development', '.env.production',
  '.env.staging', '.env.test', '.env.development.local', '.env.production.local',
  '.env.zzq',
];

// ---------------------------------------------------------------------------
// Secret-name predicate
// ---------------------------------------------------------------------------

function isSecretBasename(name) {
  // Win32 strips trailing dots/spaces per path component, so `.env.`,
  // `.env ` etc. resolve to the real `.env` on Windows — normalize FIRST so
  // those aliases can't bypass classification.
  const n = normalizeWindowsBasename(name);
  if (n === '.env' || n === '.secrets') return true;
  if (n.startsWith('.env.')) {
    const suffix = n.slice('.env.'.length);
    return suffix !== '' && !NON_SECRET_ENV_SUFFIXES.has(finalExtension(suffix).toLowerCase());
  }
  return false;
}

// True when the token's basename — or the basename of the part after its
// last `:` (git `<ref>:<path>`, Windows drive) — is a secret name. Folded to
// lower case once at the top so `.ENV` / `.Secrets` match on the
// case-insensitive filesystems (macOS, Windows) where they ARE the secret file
// — the same stance as the write guard's `/i` patterns.
function namesSecretByName(tok, backslashSeparates = true) {
  if (typeof tok !== 'string' || tok === '') return false;
  const lower = tok.toLowerCase();
  if (isSecretBasename(lastSegment(lower, backslashSeparates))) return true;
  const colon = lower.lastIndexOf(':');
  return colon !== -1 && isSecretBasename(lastSegment(lower.slice(colon + 1), backslashSeparates));
}

// A secret-by-name token is still allowed when the project listed that exact
// committed file under `hooks.secret_read_exempt` (#4432). The exemption is
// consulted only on the secret-classified branch, so an ordinary token costs
// no I/O.
function namesSecret(tok, backslashSeparates = true) {
  if (!namesSecretByName(tok, backslashSeparates)) return false;
  return !isExemptSecret(tok);
}

// A drive prefix (`C:\`) or a UNC prefix (`\\host`): a Windows path, whose `\`
// is always a path separator.
const WINDOWS_SHAPED_RE = /^(?:[A-Za-z]:\\|\\\\)/;

// Characters that occur in a regular expression but cannot occur in a Windows
// file name (`|`, `*`, `?`). A word carrying one is a pattern, so its `\` is a
// regex escape (`process\.env` in `'a|process\.env'`) and not a path separator
// (#5883). `( ) [ ] { } + ^ $` are legal in a Windows name, so they do not make
// a word a pattern: `config(1)\.env` stays a path.
const REGEX_ONLY_CHAR_RE = /[|*?]/;

// Does a `\` in this whitespace-free word separate path segments? Yes for a
// Windows path, and for any word that cannot be a regex. A bare `\.env` or
// `.\.env` is fail-safe denied: it is a Windows relative path as readily as a
// pattern.
function wordBackslashIsSeparator(word) {
  return WINDOWS_SHAPED_RE.test(word) || !REGEX_ONLY_CHAR_RE.test(word);
}

// namesSecret for a word of a Bash command. A word with whitespace can be a
// whole command handed to another interpreter (`powershell -c "type .\.env"`),
// so each whitespace-separated piece is classified on its own. The Read tool
// and Grep glob arms call namesSecret directly and keep reading `\` as a
// separator.
function namesSecretOperand(tok) {
  if (typeof tok !== 'string') return false;
  const named = (w) => namesSecret(w, wordBackslashIsSeparator(w));
  if (!/\s/.test(tok)) return named(tok);
  return named(tok) || tok.split(/\s+/).some((w) => w.includes('\\') && named(w));
}

// ---------------------------------------------------------------------------
// Grep glob analysis
// ---------------------------------------------------------------------------

// Expand `{a,b,…}` (nested allowed) into the list of alternatives, or null
// when the list would exceed MAX_GLOB_ALTERNATIVES. Malformed braces are
// treated literally.
function expandBraces(glob) {
  const open = glob.indexOf('{');
  if (open === -1) return [glob];
  let depth = 0;
  let close = -1;
  const commas = [];
  for (let i = open; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { close = i; break; }
    } else if (ch === ',' && depth === 1) commas.push(i);
  }
  if (close === -1) return [glob];
  const pre = glob.slice(0, open);
  const post = glob.slice(close + 1);
  const inner = glob.slice(open + 1, close);
  const parts = [];
  let start = 0;
  for (const c of commas) {
    parts.push(inner.slice(start, c - open - 1));
    start = c - open;
  }
  parts.push(inner.slice(start));
  const out = [];
  for (const part of parts) {
    const expanded = expandBraces(pre + part + post);
    if (expanded === null) return null;
    for (const alt of expanded) {
      out.push(alt);
      if (out.length > MAX_GLOB_ALTERNATIVES) return null;
    }
  }
  return out;
}

// Anchored regex for one brace-free glob alternative (`*` → `[^/]*`,
// `?` → `[^/]`, `[…]` classes passed through with `[!` → `[^`).
function globAltToRegex(alt) {
  let out = '^';
  for (let i = 0; i < alt.length; i++) {
    const ch = alt[i];
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if (ch === '[') {
      const j = alt.indexOf(']', i + 1);
      if (j === -1) out += '\\[';
      else {
        const body = alt.slice(i + 1, j);
        out += '[' + (body.startsWith('!') ? '^' + body.slice(1) : body).replace(/\\/g, '\\\\') + ']';
        i = j;
      }
    } else out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}

// Does this single alternative select any secret name? (See header.)
function globAltSelectsSecret(alt) {
  if (alt === '') return false;
  if (/^[*?]+$/.test(alt)) return false; // pure wildcard: equivalent to no glob
  const wild = alt.search(/[*?[]/);
  const lit = wild === -1 ? alt : alt.slice(0, wild);
  // #4580: when there is no wildcard, `alt` (== `lit`) is a WHOLE literal
  // filename, so classify it exactly the same way Read/Bash do (by its
  // FINAL extension, via isSecretBasename) rather than by a `.env.`-prefix
  // heuristic — that heuristic mis-blocked multi-dot templates like
  // `.env.local.example`. When a wildcard IS present, `lit` is only a
  // PARTIAL literal prefix (`.env.local.exam*` can still select
  // `.env.local`), which cannot be classified exactly, so the original
  // conservative prefix rule stays.
  if (wild === -1) {
    if (isSecretBasename(lit)) return true;
  } else if (lit.startsWith('.env.')) {
    return true;
  }
  if (lit !== '' && ('.env.'.startsWith(lit) || '.secrets'.startsWith(lit))) return true;
  let re;
  try {
    re = globAltToRegex(alt);
  } catch {
    return true; // an unparsable class — Grep would reject it too; deny is the safe side
  }
  return GLOB_PROBES.some((probe) => re.test(probe));
}

// classifyGrepGlob, with a glob of so many brace groups that expanding them
// overflows the stack denied as `glob-too-complex`.
function grepGlobVerdict(glob) {
  try {
    return classifyGrepGlob(glob);
  } catch (e) {
    if (e instanceof RangeError) return 'glob-too-complex';
    throw e;
  }
}

// Returns null (allowed), 'secret-read', or 'glob-too-complex'.
function classifyGrepGlob(glob) {
  // Segment via the SAME `lastSegment` helper Read/Bash use (namesSecret),
  // rather than a hand-rolled forward-slash-only split — the two used to
  // diverge on a backslash-bearing glob (`config\.env`), which `lastSegment`
  // reduces to `.env` but a `/`-only split left untouched, letting it escape
  // this arm's predicate while Read/Bash still blocked it.
  // Case-fold the last segment (GLOB_PROBES are lower case) so `.ENV*` and
  // `*.ENV` select the secret namespace on case-insensitive filesystems.
  const segment = lastSegment(glob).toLowerCase();
  const alts = expandBraces(segment);
  if (alts === null) return 'glob-too-complex';
  return alts.some(globAltSelectsSecret) ? 'secret-read' : null;
}

// ---------------------------------------------------------------------------
// Bash command scan — dollar-quoting (`$'…'`, `$"…"`)
// ---------------------------------------------------------------------------

// #5255: dollar-quoting is read four ways, and which one applies depends on
// the shell that runs the text, which a hook cannot see (zsh is the Bash
// tool's shell on macOS; dash is `sh` on Debian and Ubuntu, and so a `sh -c`
// body there):
//   bash  `$'…'` is ANSI-C quoting — a backslash escapes the next character,
//         so `\'` does not close the span — and the word is the decoded value
//         (`$'.e\x6ev'` is `.env`); `$"…"` is `"…"`.
//   zsh   the same span end, but its own decoding (decodeAnsiCZsh): an unknown
//         escape drops its backslash (`$'.env.\local'` is `.env.local`), a
//         bare `\x` or `\u` is a NUL that cuts the argument (`$'.env\u'` is
//         `.env`), and it decodes heredoc tags, so a tag can end the heredoc
//         on a different line; `$"…"` is `$` and `"…"`. And a run of `$`
//         before `'` always ends in a `$'` opener: `$$'x'` is the PID and a
//         span, where bash reads the PID and a plain 'x' (opensAnsiC); after
//         an even run only `\\` and `\'` are escapes in it, though the zsh
//         reading decodes it in full (opensAnsiC). In `$(( ))`, `(( ))` and
//         `$[ ]` a quote is not one (zshMathEnd).
//   dash  `$` is a literal and the quote after it a plain one, and a run of
//         `$` pairs left to right as bash's does: `$${` is the PID and a `{`.
//   plain the scan as it was before #5255: dash's quoting, but a run is not
//         paired, so `$${` opens a `${…}` at its second `$`.
// Each reading hides what another runs:
//   echo $'x\'y'; cat .env          bash and zsh run `cat .env`; dash's and the
//                                   plain reading see a quote that never closes
//   echo $'x\'; cat .env; echo '\'  dash runs `cat .env`; the ANSI-C readings
//                                   see one quoted word
//   echo $${$'\''}'; cat .env       dash runs `cat .env`; the other three see
//                                   a quote that never closes
// So a command holding either form is scanned under all four and denied on
// any (findSecretRead). The plain reading is the scan as it was before #5255,
// but for a brace in a heredoc tag, which is read both ways (heredocBraceTags),
// so nothing it denied can become allowed. Every scanner below takes `reading`:
// false for the plain reading, or the shell whose reading it is doing —
// 'bash' or 'zsh', which have ANSI-C quoting, or 'dash', which does not.
// Not reached: the word text inside `${…}` is not scanned, so a `$'…'` there is
// not decoded (the `$VAR` indirection gap in the header) — the readings other
// than the plain one read a `${…}` on past a `}` inside a quote, a span, a
// `$( )`, `<( )` or backticks, also within "…", and once it closes scan the
// commands of those last three (ansiCBraceClose). Comments are not read in a
// `$( )`, on any reading: where the shell's grammar outruns that (a `#`
// comment or a `case` pattern's `)` in a `$( )` in a `${…}`) they can end one
// later than the shell does, so the scan is run again with that reader off,
// and its verdict stands (readAsBefore). A command nested deeper than
// MAX_NESTING_DEPTH is not scanned: it is denied as `nesting-too-deep` (#6136). Several thousand levels of `$( )`
// overflow the parser's stack; that fails closed, as `command-too-complex` (findSecretRead). A heredoc tag
// word inside `$( )` holding a `${…}`, `$(…)`, backtick or bare carriage
// return is read by the span-unaware path, so its end can differ from the
// shell's. bash 3.2 (`/bin/bash` on macOS) is not modelled: it has no `\u` /
// `\U` and reads `\c` differently, and on 4,000 generated spans every value
// where it differed from 5.2 still held a backslash or a control byte, which
// no protected name contains.

// The run of `$` starting at `i`: `end` is the index just past it, `last` the
// index of its last `$`, `atQuote` whether a quote follows, and `owned`
// whether a `$` opens that quote. `$$` is the PID and pairs left to right, so
// only an odd `$` left over owns the quote: `$$'x'` is the PID and a plain
// 'x', `$$$'x'` is the PID and `$'x'`. That is bash's and dash's pairing;
// zsh's differs before `'` (opensAnsiC). bash's pairing also decides `{` and
// `(` after a run — `$${` is the PID and a `{` — where zsh's lexer opens a
// `${…}` after any run (tokenize).
// Callers consume the whole run in one step — a megabyte of `$` is read once,
// not once per character.
function dollarRun(str, i) {
  let end = i;
  let last = i;
  let dollars = 0;
  // bash removes `\<newline>` line continuations before it tokenizes, so one
  // does not break a run of `$`: `$\<newline>$'x'` is `$$'x'` to bash, a PID
  // and a plain quote, not ANSI-C quoting. So the run's text is `dollars`
  // `$` characters, never `str.slice(i, end)`, and a caller that does not
  // consume the whole run stops on `last`, never on `end - 1`, which can be
  // the newline of a continuation (`cat $$\<newline> .env` is `cat $$ .env`).
  for (;;) {
    if (str[end] === '$') { dollars++; last = end; end++; }
    else if (str[end] === '\\' && str[end + 1] === '\n') { end += 2; }
    else break;
  }
  const atQuote = str[end] === "'" || str[end] === '"';
  return { end, last, dollars, atQuote, owned: atQuote && dollars % 2 === 1 };
}

// Whether the run's last `$` belongs to the quote after it, under the reading
// `shell`: always for `$'…'`, and for `$"…"` only in bash — zsh keeps the `$`.
// Never under dash's, which has no dollar-quoting.
function ownsQuote(run, str, shell) {
  return shell !== 'dash' && run.owned && (str[run.end] === "'" || shell === 'bash');
}

// Whether the `'` after the run opens a `$'…'` span under the reading `shell`.
// bash pairs the run left to right, so only an odd run does. zsh opens one
// after any run, so `echo $$'\''; cat .env` runs the read under zsh, but after
// an even run it takes only `\\` and `\'` as escapes: `$$'\x41'` is the PID
// and `\x41`, `$$$'\x41'` the PID and `A` (zsh 5.9; a heredoc tag after an
// even run is decoded in full). The zsh reading decodes the span in full
// there too: the bash reading takes the same text as a plain quote, whose
// value is zsh's but for those two escapes. dash never does.
function opensAnsiC(run, str, shell) {
  return str[run.end] === "'" && shell !== 'dash' && (shell === 'zsh' ? run.dollars > 0 : run.owned);
}

// A run of 2+ `$` at `i` inside "…" under any reading but the plain one, or
// null.
// bash, zsh and dash all pair it left to right there: `"$$(x)"` is the PID
// and `(x)`, and `"$$$(…)"` the PID and a `$(…)`. So the "…" ends at its own
// `"`: zsh and dash run `echo "$$(" ; cat .env`, and bash, whose expansion of
// that word fails, drops the rest of its line but runs the next one, so
// `echo $${"$$("` then a newline and `cat .env` runs the read in bash too.
// Returns the PIDs' text and where reading resumes: past an even run, or on
// an odd run's last `$`, for the `$(` test after it.
function quotedRun(str, i) {
  const run = dollarRun(str, i);
  if (run.dollars < 2) return null;
  const odd = run.dollars % 2 === 1;
  return { text: '$'.repeat(odd ? run.dollars - 1 : run.dollars), next: odd ? run.last : run.end };
}

// Index of the `'` closing a `$'…'` span whose opening quote is at `i`, or -1
// when it never closes. A backslash escapes the next character, so `\'` and
// `\\` never close the span. The one definition of where a span ends, shared
// by tokenize, findParenClose and readHeredocTag.
function ansiCQuoteEnd(str, i) {
  i++;
  while (i < str.length && str[i] !== "'") i += str[i] === '\\' ? 2 : 1;
  return i < str.length ? i : -1;
}

// Index of the `}` closing a `${` opened just before `i`, under the reading
// `shell`, or -1 when none does. `inDq` is set for a `${…}` inside "…". The
// shells read quoting inside `${…}`, so a `}` inside "…", a `$( )`, `<( )`
// or backticks, or after a backslash, does not end it, nor one inside '…' or
// a `$'…'` span: the `'` closing a plain quote opens no span, so `${x#'$'}`
// ends at its own `}` and `cat $'.env'` after it is read. Within "…" a `'`
// is a quote to bash, to dash only after a pattern operator (`#`, `##`, `%`,
// `%%`), and text to zsh: `"${x:-'}'}"` ends at the first `}` in dash and
// zsh, where bash reads on (bracePatternOp). A `${` inside is read the same
// way, by its own operator, and a `$(` opens a substitution, each after a run
// of `$` paired as the reading pairs one (tokenize), except that zsh opens a
// `${` after any run outside "…". bash also skips a `<( )` or `>( )` within
// "…" whole, and can run it there. The commands of each `$( )`, `<( )` and
// backtick span inside go to `nested`, when given: the shell runs them when
// it expands the `${…}` (`echo ${x:-`cat .env`}`); tokenize keeps them only
// when the `${…}` closes. The rest of its text is not scanned
// (`cat ${x:-.env}` is the `$VAR` gap in the header). The shell runs nothing
// from a line whose `${` never closes, and one reading's shell can fail where
// another's runs (dash has no `$'…'`), so tokenize then ends the `${…}` at
// its first `}`, as the plain reading does, rather than read the rest of the
// line as its text: a read after it is seen.
// The end of a backtick span whose opener is just before `from`: the first backtick that is not escaped, or -1.
// Inside backticks a backslash escapes the next character, so a nested pair is written \`...\` (#6136).
function backtickEnd(str, from) {
  for (let i = from; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === '`') return i;
  }
  return -1;
}

// The body a backtick span holds as the shell runs it: `\\`, `\`` and `\$` lose their backslash, and so does `\"` when the
// span is inside a double-quoted string (#6433: ``echo "`cat \".env\"`"`` runs `cat ".env"`, which reads `.env`).
function backtickBody(text, inDq) {
  if (text.indexOf('\\') === -1) return text;
  return inDq ? text.replace(/\\([\\`$"])/g, '$1') : text.replace(/\\([\\`$])/g, '$1');
}

function ansiCBraceClose(str, i, shell, nested, inDq) {
  if (asBefore) return ansiCBraceCloseBefore(str, i, shell);
  const quotes = !inDq || shell === 'bash' || (shell === 'dash' && bracePatternOp(str, i));
  const span = (from, to) => { if (nested) nested.push(str.slice(from, to)); return to + 1; };
  let read = i;
  while (i < str.length) {
    chargeReader(i + 1 - read);
    read = i + 1;
    const ch = str[i];
    if (ch === '}') {
      return i;
    } else if (ch === '\\') {
      i += 2;
    } else if (ch === '`') {
      const j = backtickEnd(str, i + 1);
      if (j === -1) return unclosed(str, read);
      if (nested) nested.push(backtickBody(str.slice(i + 1, j), inDq));
      i = j + 1;
    } else if (ch === "'" && quotes) {
      const j = str.indexOf(ch, i + 1);
      if (j === -1) return unclosed(str, read);
      i = j + 1;
    } else if (ch === '"') {
      const j = doubleQuoteEnd(str, i + 1, shell, nested);
      if (j >= str.length) return unclosed(str, read);
      i = j + 1;
    } else if ((ch === '<' || ch === '>') && str[i + 1] === '(' && (!inDq || shell === 'bash')) {
      const e = findParenClose(str, i + 2, shell);
      if (e >= str.length) return unclosed(str, read);
      i = span(i + 2, e);
    } else if (ch !== '$') {
      i++;
    } else {
      const run = dollarRun(str, i);
      const math = str[run.end] === '[' ? zshMathEnd(str, run.end, shell) : -1;
      if (math !== -1) {
        if (nested) collectSubstitutions(str.slice(run.end + 1, math), nested, shell);
        i = math + 1;
      } else if (quotes && opensAnsiC(run, str, shell)) {
        const end = ansiCQuoteEnd(str, run.end);
        if (end === -1) return unclosed(str, read);
        i = end + 1;
      } else if (run.dollars % 2 === 1 && str[run.end] === '(') {
        const e = findParenClose(str, run.end + 1, shell);
        if (e >= str.length) return unclosed(str, read);
        i = span(run.end + 1, e);
      } else if ((run.dollars % 2 === 1 || (shell === 'zsh' && !inDq)) && str[run.end] === '{') {
        const e = ansiCBraceClose(str, run.end + 1, shell, nested, inDq);
        if (e === -1) return unclosed(str, read);
        i = e + 1;
      } else {
        i = run.end; // a quote or `$"…"` after the run: the branches above read it
      }
    }
  }
  return unclosed(str, read);
}

// The simple end of a `${…}`, for readAsBefore:
// it skips only `$'…'` spans, and a span that never closes ends at the next `}`.
function ansiCBraceCloseBefore(str, i, shell) {
  while (i < str.length && str[i] !== '}') {
    if (str[i] !== '$') { i++; continue; }
    const run = dollarRun(str, i);
    if (opensAnsiC(run, str, shell)) {
      const end = ansiCQuoteEnd(str, run.end);
      if (end === -1) return str.indexOf('}', i);
      i = end + 1;
    } else {
      i = run.end;
    }
  }
  return i < str.length ? i : -1;
}

// Whether the `${…}` whose text starts at `i` removes a pattern: its name
// (dash has no arrays, so no subscript), then `#` or `%` (`${x#…}`,
// `${x%%…}`; `${#x}` is a length). dash removes a line continuation before it
// reads any of it, so `${x\<newline>%…` removes a pattern too.
function bracePatternOp(str, i) {
  const skip = (p) => { while (str[p] === '\\' && str[p + 1] === '\n') p += 2; return p; };
  const next = (p, re) => { while (p < str.length && re.test(str[p])) p = skip(p + 1); return p; };
  const start = skip(i);
  const ch = str[start] || '';
  let end;
  if (/[A-Za-z_]/.test(ch)) end = next(start, /[A-Za-z0-9_]/);
  else if (/[0-9]/.test(ch)) end = next(start, /[0-9]/);
  else if (ch !== '' && '@*#?$!-'.includes(ch)) end = skip(start + 1);
  else return false;
  return str[end] === '#' || str[end] === '%';
}

// The index of the `{` of a `${` at `i` inside "…", or -1: bash and dash remove
// a line continuation first, so `"$\<newline>{x}"` is `"${x}"`. zsh keeps it as
// text there.
function quotedBraceOpen(str, i, shell) {
  if (str[i + 1] === '{') return i + 1;
  if (shell === 'zsh') return -1;
  const run = dollarRun(str, i);
  return run.dollars === 1 && str[run.end] === '{' ? run.end : -1;
}

// The readings a command holding dollar-quoting, or a run of `$` before `{`
// or `(`, is scanned under before the plain one (findSecretRead).
const READINGS = ['bash', 'zsh', 'dash'];

// Single-character escapes of bash's `$'…'`, as byte values.
const ANSI_C_ESCAPES = new Map([
  ['a', 0x07], ['b', 0x08], ['e', 0x1b], ['E', 0x1b], ['f', 0x0c], ['n', 0x0a], ['r', 0x0d],
  ['t', 0x09], ['v', 0x0b], ['\\', 0x5c], ["'", 0x27], ['"', 0x22], ['?', 0x3f],
].map(([ch, byte]) => [ch.charCodeAt(0), byte]));

// Bytes that are not UTF-8 decode lossily, in both readings: a U+FFFD can
// neither spell nor hide a secret name, and every ASCII byte keeps its place
// (the decoder never swallows a byte that follows a bad sequence).
const UTF8_LOSSY = new TextDecoder('utf-8', { ignoreBOM: true });

function hexDigit(byte) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  return -1;
}

// The value `shell` ('bash' or 'zsh') gives the text between `$'` and its
// closing quote, in a UTF-8 locale, or null when it has none: the text holds a
// literal NUL (bash drops it from a script it reads and no shell can take it
// in an argument), or zsh refuses the line (below). Both readings
// are measured against the shells themselves in
// tests/fixtures/ansi-c-decode-oracle.json.
function decodeAnsiC(raw, shell) {
  if (raw.includes('\0')) return null;
  return shell === 'zsh' ? decodeAnsiCZsh(raw) : decodeAnsiCBash(raw);
}

// bash 5.2's value (ansicstr, lib/sh/strtrans.c). Works on bytes because bash
// does: `$'\xc3\xa9'` is one character, and `$'\xff'` is the byte 0xff, read
// here as U+FFFD. Escapes: the
// single characters above, `\nnn` (one to three octal digits), `\xHH`, and
// `\x{H…}` (every hex digit, the low byte kept — bash's own form since 4.3,
// not zsh's: zsh reads `\x{` as a NUL), `\uHHHH`, `\UHHHHHHHH`, `\cX`; any
// other escape keeps its backslash. A NUL ends the value while the span still
// runs to its quote, and the word goes on after it: `$'.env\0'x` is `.envx`.
function decodeAnsiCBash(raw) {
  if (!raw.includes('\\')) return raw;
  const s = Buffer.from(raw, 'utf8');
  const out = [];
  let k = 0;
  while (k < s.length) {
    let c = s[k++];
    if (c !== 0x5c || k === s.length) { out.push(c); continue; }
    c = s[k++];
    const simple = ANSI_C_ESCAPES.get(c);
    if (simple !== undefined) { out.push(simple); continue; }
    if (c >= 0x30 && c <= 0x37) {
      let v = c - 0x30;
      for (let n = 0; n < 2 && s[k] >= 0x30 && s[k] <= 0x37; n++) v = v * 8 + (s[k++] - 0x30);
      out.push(v & 0xff);
      continue;
    }
    if (c === 0x78) { // x
      if (s[k] === 0x7b) { // `\x{H…}`: every hex digit, the low byte kept
        k++;
        let v = 0;
        while (hexDigit(s[k]) !== -1) v = ((v << 4) | hexDigit(s[k++])) & 0xff;
        if (s[k] === 0x7d) k++;
        out.push(v);
        continue;
      }
      let v = 0;
      let n = 0;
      while (n < 2 && hexDigit(s[k]) !== -1) { v = v * 16 + hexDigit(s[k++]); n++; }
      if (n === 0) out.push(0x5c, c);
      else out.push(v);
      continue;
    }
    if (c === 0x75 || c === 0x55) { // u, U
      const max = c === 0x75 ? 4 : 8;
      let v = 0;
      let n = 0;
      while (n < max && hexDigit(s[k]) !== -1) { v = v * 16 + hexDigit(s[k++]); n++; }
      if (n === 0) out.push(0x5c, c);
      else out.push(...bashCodePointBytes(v));
      continue;
    }
    if (c === 0x63 && k < s.length) { // `\cX`; `\c\\` is one control character
      const x = s[k++];
      if (x === 0x5c && s[k] === 0x5c) k++;
      out.push(x === 0x3f ? 0x7f : x & 0x1f);
      continue;
    }
    out.push(0x5c, c);
  }
  const cut = out.indexOf(0);
  return UTF8_LOSSY.decode(Uint8Array.from(cut === -1 ? out : out.slice(0, cut)));
}

// The bytes bash 5.2 writes for `\u` / `\U`: the UTF-8 pattern extended to
// every value below 2^31, surrogates and values past U+10FFFF included (`\ud800`
// is ed a0 80, `\U7fffffff` six bytes), and nothing at or above 2^31.
function bashCodePointBytes(v) {
  if (v < 0x80) return [v];
  if (v >= 0x80000000) return [];
  const len = v < 0x800 ? 2 : v < 0x10000 ? 3 : v < 0x200000 ? 4 : v < 0x4000000 ? 5 : 6;
  const bytes = new Array(len);
  for (let n = len - 1; n > 0; n--) { bytes[n] = 0x80 | (v & 0x3f); v = Math.floor(v / 64); }
  bytes[0] = ((0xff00 >> len) & 0xff) | v;
  return bytes;
}

// Single-character escapes of zsh's `$'…'` that are not the character itself.
const ZSH_ANSI_C_ESCAPES = new Map([
  ['a', 0x07], ['b', 0x08], ['e', 0x1b], ['E', 0x1b], ['f', 0x0c], ['n', 0x0a], ['r', 0x0d],
  ['t', 0x09], ['v', 0x0b],
].map(([ch, byte]) => [ch.charCodeAt(0), byte]));

// zsh 5.9's value (getkeystring with GETKEYS_DOLLARS_QUOTE, Src/utils.c), or
// null for a code point zsh cannot encode (a surrogate, or past U+10FFFF): zsh
// stops the line at that word, after running the commands before it. Where
// it differs from bash: any other escape drops its backslash (`\.` is `.`,
// `\c` is `c`, `\8` is `8`); `\x` and an octal escape are read by zstrtol
// over a three-byte window, so `\x` skips blanks and takes a sign before up
// to two hex digits and `\x` with none (or `\x{`) is a NUL; `\u` / `\U` with
// no digit is a NUL; `\M` and `\C` (the dash after them optional) set the meta
// bit and mask the control bits of the next character written, `\C-?` being
// DEL. The value keeps its NULs: a command gets the word cut at the first one
// (tokenize), a heredoc tag keeps it. Bytes that are not UTF-8 decode lossily,
// as bash's do.
function decodeAnsiCZsh(raw) {
  if (!raw.includes('\\')) return raw;
  const s = Buffer.from(raw, 'utf8');
  const out = [];
  let meta = 0; // 2: `\M` written after `\C`, applied first
  let control = 0;
  const modify = () => {
    const t = out.length - 1;
    if (meta === 2) { out[t] |= 0x80; meta = 0; }
    if (control) { out[t] = out[t] === 0x3f ? 0x7f : out[t] & 0x9f; control = 0; }
    if (meta) { out[t] |= 0x80; meta = 0; }
  };
  let k = 0;
  while (k < s.length) {
    const c = s[k++];
    if (c !== 0x5c || k === s.length) { out.push(c); modify(); continue; }
    const e = s[k++];
    const simple = ZSH_ANSI_C_ESCAPES.get(e);
    if (simple !== undefined) { out.push(simple); modify(); continue; }
    if (e === 0x4d || e === 0x43) { // M, C
      if (s[k] === 0x2d) k++;
      if (e === 0x4d) meta = 1 + control;
      else control = 1;
      continue;
    }
    if (e === 0x75 || e === 0x55) { // u, U
      const max = e === 0x75 ? 4 : 8;
      let v = 0;
      let n = 0;
      while (n < max && hexDigit(s[k]) !== -1) { v = v * 16 + hexDigit(s[k++]); n++; }
      if (v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return null; // "character not in range"
      out.push(...Buffer.from(String.fromCodePoint(v), 'utf8'));
      continue; // a pending `\M` / `\C` waits for the next character
    }
    if ((e >= 0x30 && e <= 0x37) || e === 0x78) { // octal digit, x
      const hex = e === 0x78;
      let p = hex ? k : k - 1;
      const stop = Math.min(k + 2, s.length);
      while (p < stop && (s[p] === 0x20 || s[p] === 0x09 || s[p] === 0x0a)) p++;
      let neg = false;
      if (p < stop && (s[p] === 0x2d || s[p] === 0x2b)) { neg = s[p] === 0x2d; p++; }
      let v = 0;
      for (; p < stop; p++) {
        const d = hex ? hexDigit(s[p]) : (s[p] >= 0x30 && s[p] <= 0x37 ? s[p] - 0x30 : -1);
        if (d === -1) break;
        v = v * (hex ? 16 : 8) + d;
      }
      k = p;
      out.push((neg ? -v : v) & 0xff);
      modify();
      continue;
    }
    out.push(e);
    modify();
  }
  return UTF8_LOSSY.decode(Uint8Array.from(out));
}

// A shell metacharacter that ends a heredoc TAG word (ansiCTagWord). Not `\r`,
// which bash keeps inside the word, and spelled out rather than `\s`, which
// also matches a no-break space the shell keeps.
const TAG_WORD_END_RE = /[ \t\n;&|<>()]/;

// The start of a `$'…'` word, bounded, for the block payload's `path`.
function quoteExcerpt(str, i) {
  return str.length - i > 40 ? `${str.slice(i, i + 40)}…` : str.slice(i);
}

// ---------------------------------------------------------------------------
// Bash command scan — pass 1: tokenizer
// ---------------------------------------------------------------------------

// Which reading of a heredoc the scan is making (#5513). The guard scans a command that
// opens a heredoc under every reading below and denies if any of them finds a secret read
// (see findSecretReadUnderOtherReadings), so a change of reading can add a denial but
// never remove one.
//  - heredocBodiesSkippedInSpans: bash 5 skips the bodies of heredocs opened inside a
//    `$( )` span when it looks for the closing `)`; bash 3.2.57 (still `/bin/bash` on
//    macOS) does not, so a `)` on a body line closes the substitution and the rest of
//    that line runs as the OUTER command.
//  - heredocTagsAsWords: an unquoted tag is a bash word (a CR and a substitution belong
//    to it). false is the earlier reading, where the tag stopped at any whitespace and at
//    `(`: kept as a reading so nothing the guard denied before is allowed now.
//  - heredocBraceTags: a `{` or `}` where a tag is due is the tag, and a `${` there is its
//    text to dash and the plain reading, since a tag is not expanded. false is the earlier
//    reading, where the brace was a group and the `${` an expansion. A command that met
//    such a tag at any depth (braceTagRead) is scanned that way too, so nothing it denied
//    is allowed. The flag is per command, so findSecretRead keeps it through a pass.
let heredocBodiesSkippedInSpans = true;
let heredocTagsAsWords = true;
let heredocBraceTags = true;
let braceTagRead = false;
let inHeredocPass = false;
// #5515: heredocs opened inside a `$( )` / `<( )` that closed before any newline are still waiting for their bodies,
// which bash reads at the next newline of the enclosing input (`echo $(cat <<EOF) x`, then the body lines). The span
// reader hands them over here and tokenize takes them into its own pending list, so that newline consumes them.
// One queue for the whole parse, in textual order, as bash keeps one: a newline inside any span consumes all of it.
// Only the first reading uses it (orphanBodies); every other reading keeps the span-local list the guard had before #5515,
// and one more pass runs under that earlier reading, so nothing it denied is allowed now (the queue only adds denials).
let orphanHeredocs = [];
let orphanBodies = true;
// Set when tokenize took a heredoc a span left waiting (a real orphan), so the no-queue reading runs for exactly the commands
// whose verdict the queue can change, whether or not they hold a literal `<<` (a nested body can spell it `<''<`:
// `eval '$(cat <''<B)` then `cat .env'`). A heredoc consumed inside its own span (`$(cat <<EOF` … `EOF` … `)`) is no orphan,
// so a commit message heredoc costs one scan, as before.
let orphanQueued = false;

// findParenClose for a `$( )` inside a heredoc delimiter word: the word is taken literally (and under the earlier reading the
// span is no one's orphan either), so a heredoc opened inside it waits for nothing and must not join the queue
// (`cat <<A$(:<<B)` then `A` ends the one heredoc; B's body is not read).
function findTagSpanClose(str, i, reading) {
  const queue = orphanHeredocs;
  orphanHeredocs = [];
  try {
    return findParenClose(str, i, reading);
  } finally {
    orphanHeredocs = queue;
  }
}

// #5514: the readings of an `env -S` string, declared once. The Bash path scans
// the command once per reading, in this order, and any reading's hit denies, so a
// reading can add a denial but never remove one.
//  - split: false skips the string as the option's value, so resolveCommand reads every command
//    exactly as before #5514. It runs first, on every command. A read or a launch it finds is
//    emitted at once, and so is any other denial until a split option is met; after one, the
//    other denials are held, and a later reading's read or launch outranks them (scanBashReadings).
//  - vars: 'keep' keeps `${NAME}` as written; 'drop' reads it as unset, which every env expands to nothing.
//  - escapes: 'gnu' (GNU coreutils), 'bsd' (FreeBSD and macOS: a backslash before a blank is that
//    blank) or 'uutils' (uutils coreutils, Ubuntu's env since 25.10: a backslash before a newline
//    is removed, in quotes too, and a comment ends at a newline, not the string). See splitEnvString.
//  - runs: 'always'; 'split-or-throw' once an earlier reading met a split option or a scan threw
//    before it could tell; 'split' once one was met. Every splitting reading then runs: an escape can
//    build a `${` or a backslash-blank inside a nested string, so which strings a reading reaches, and
//    what they hold, can differ from what the first saw, and no screen over them tells which to run.
const ENV_S_READINGS = Object.freeze([
  { name: 'unsplit', split: false, runs: 'always' },
  { name: 'gnu', split: true, vars: 'keep', escapes: 'gnu', runs: 'split-or-throw' },
  { name: 'bsd', split: true, vars: 'keep', escapes: 'bsd', runs: 'split' },
  { name: 'uutils', split: true, vars: 'keep', escapes: 'uutils', runs: 'split' },
  { name: 'gnu, unset ${NAME}', split: true, vars: 'drop', escapes: 'gnu', runs: 'split' },
  { name: 'bsd, unset ${NAME}', split: true, vars: 'drop', escapes: 'bsd', runs: 'split' },
  { name: 'uutils, unset ${NAME}', split: true, vars: 'drop', escapes: 'uutils', runs: 'split' },
].map((r) => Object.freeze(r)));

// The `env -S` reading the scans apply (named apart from the `reading`
// parameter the #5255 scanners take, which is a shell's): set by the Bash
// path's loop over ENV_S_READINGS and by scanFurtherReading (ENV_S_READINGS[0],
// then the GNU split again), and the GNU split until then. What the scans
// report back:
//  - splitSeen: a scan met a split option, so the readings that run on 'split' run.
//  - splitTooDeep: a split string nested more than MAX_NESTING_DEPTH deep, whose
//    command is not read. The Bash path denies it as `split-string-too-deep` rather
//    than allow what it could not see.
let envSReading = ENV_S_READINGS[1];
let splitSeen = false;
let splitTooDeep = false;

// Index of the `)` closing a `$(` / `<(` / `>(` opened just before `i`, or
// str.length when unterminated. Quote- and heredoc-aware so a `)` inside a
// quoted string or a heredoc body never closes the span early.
function findParenClose(str, i, reading) {
  if (str[i] === '(' && str[i - 2] === '$') {
    const math = zshMathEnd(str, i, reading);
    if (math !== -1) return math;
  }
  let depth = 1;
  let localTags = [];
  let ownPending = 0; // this span's own tags in the queue
  let read = i;
  while (i < str.length) {
    if (reading) {
      chargeReader(i + 1 - read);
      read = i + 1;
    }
    const ch = str[i];
    if (ch === '\\') { i += 2; continue; }
    if (reading && ch === '$') {
      const run = dollarRun(str, i);
      if (run.atQuote) {
        i = run.end; // a plain quote or `$"…"`: the branches below skip it
        if (opensAnsiC(run, str, reading)) {
          const end = ansiCQuoteEnd(str, i);
          i = end === -1 ? str.length : end + 1;
        }
        continue;
      }
      // A `(` or `)` in a `${…}` is text: it ends where its reader ends it,
      // after a run of `$` paired as the reading pairs one.
      if (!asBefore && (run.dollars % 2 === 1 || reading === 'zsh') && str[run.end] === '{') {
        const j = ansiCBraceClose(str, run.end + 1, reading, null, false);
        if (j !== -1) { i = j + 1; continue; }
      }
      // Any other run: only its last `$` can open `$(`, read below as before.
      if (run.last > i) { i = run.last; continue; }
    }
    if (ch === "'") {
      const j = str.indexOf("'", i + 1);
      i = j === -1 ? str.length : j + 1;
      continue;
    }
    if (ch === '"') {
      i = doubleQuoteEnd(str, i + 1, reading) + 1;
      continue;
    }
    if (ch === '`') {
      const j = backtickEnd(str, i + 1);
      i = j === -1 ? str.length : j + 1;
      continue;
    }
    if (heredocBodiesSkippedInSpans && ch === '<' && str[i + 1] === '<' && str[i + 2] !== '<') {
      const tag = readHeredocTag(str, i + 2, reading);
      if (orphanBodies) ownPending++;
      (orphanBodies ? orphanHeredocs : localTags).push(tag);
      i = tag.end;
      continue;
    }
    if (ch === '\n' && orphanBodies && orphanHeredocs.length) {
      // Entries beyond this span's own are an earlier span's orphans, which base's span-local list dropped: the verdict can
      // differ from the earlier reading here, so the no-queue pass must run.
      if (orphanHeredocs.length > ownPending) orphanQueued = true;
      ownPending = 0;
      i = consumeHeredocBodies(str, i + 1, orphanHeredocs.splice(0)).end;
      continue;
    }
    if (ch === '\n' && localTags.length) {
      i = consumeHeredocBodies(str, i + 1, localTags).end;
      localTags = [];
      continue;
    }
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  if (reading) chargeReader(str.length - read);
  return str.length;
}

// Under zsh's reading, the index of the bracket closing the arithmetic whose
// opener is at `i` — the `[` of `$[`, or the inner `(` of `$((` or `((` — or
// -1 when there is none, under another reading, or with the ${…} reader off.
// zsh takes a `$[ … ]` and a `$(( … ))` as arithmetic before anything else, and
// in arithmetic a quote is not one: `x$(($"));cat .env`,
// `((x' ));cat .env;''` and `echo ${x+$[ } ' ]}; cat $'.env' #'` run the read.
// `$(( … ))` must end in `))`, or it is a `$( )` holding a subshell, and only a
// body holding a quote can read differently, so only that is taken here. Called
// where a caller goes on one character on -1, so each step is charged:
// unclosed openers would otherwise each read to the end.
function zshMathEnd(str, i, reading) {
  if (reading !== 'zsh' || asBefore) return -1;
  const bracket = str[i] === '[';
  const [open, close] = bracket ? '[]' : '()';
  let depth = 0;
  for (let p = i; p < str.length; p++) {
    chargeReader(1);
    if (str[p] === open) depth++;
    else if (str[p] === close && --depth === 0) {
      if (bracket) return p;
      return str[p + 1] === ')' && /["']/.test(str.slice(i, p)) ? p + 1 : -1;
    }
  }
  return -1;
}

// One element of a "…" at `i` (not its closing `"`), read as `reading` reads
// it. tokenize and doubleQuoteEnd both read a "…" through this alone, so they
// cannot end one in different places. Returns where reading resumes and the
// element's text in the word's value. A backslash escapes `"`, a backslash, `$`, a
// backtick and a newline, which it removes; before any other character it is
// text. Under any reading but the plain one a run of `$` is paired first
// (quotedRun), and an odd run's last `$` is then read as a lone one, so zsh's
// `$[ … ]`, a `${…}` and a `$(` are tested after the run: zsh runs the read
// in `echo "$$$[ " ]"; cat .env`. A `${…}` is not opened in a heredoc tag
// (`inTag`), which is not expanded. The commands of a `$( )` or backtick span
// go to `nested`, when given, and so do those inside a `${…}`: once it
// closes when `keepOnClose`, which tokenize passes, else as they are read.
function dqElement(str, i, reading, inTag, nested, keepOnClose) {
  const c = str[i];
  if (c === '\\' && i + 1 < str.length && '"\\$`\n'.includes(str[i + 1])) {
    return { next: i + 2, text: str[i + 1] === '\n' ? '' : str[i + 1] };
  }
  let text = '';
  if (reading && c === '$') {
    const run = quotedRun(str, i);
    if (run) {
      text = run.text;
      i = run.next;
      if (str[i] !== '$') return { next: i, text };
    }
  }
  if (str[i] === '$' && str[i + 1] === '[') {
    const math = zshMathEnd(str, i + 1, reading);
    if (math !== -1) {
      if (nested) collectSubstitutions(str.slice(i + 2, math), nested, reading);
      return { next: math + 1, text: text + str.slice(i, math + 1) };
    }
  }
  const brace = reading && !asBefore && !inTag && str[i] === '$' ? quotedBraceOpen(str, i, reading) : -1;
  if (brace !== -1) {
    const inner = keepOnClose ? [] : nested;
    const j = ansiCBraceClose(str, brace + 1, reading, inner, true);
    if (j !== -1) {
      if (keepOnClose && nested) for (const cmd of inner) nested.push(cmd);
      return { next: j + 1, text: text + str.slice(i, j + 1) };
    }
  }
  if (str[i] === '$' && str[i + 1] === '(') {
    const e = findParenClose(str, i + 2, reading);
    if (nested) {
      const inner = str.slice(i + 2, e);
      nested.push(inner);
      // `"$(( `cat \".env\"` ))"`: dash and zsh read the backtick as inside the double quotes, so `\"` loses its backslash (#6433)
      if (inner.startsWith('(') && inner.includes('`') && inner.includes('\\"')) nested.push(inner.replace(/\\"/g, '"'));
    }
    return { next: e + 1, text };
  }
  if (str[i] === '`') {
    const j = backtickEnd(str, i + 1);
    const e = j === -1 ? str.length : j;
    if (nested) nested.push(backtickBody(str.slice(i + 1, e), true));
    return { next: e + 1, text };
  }
  return { next: i + 1, text: text + str[i] };
}

// Index of the `"` closing a "…" whose text starts at `i`, or str.length
// when it never closes, read by dqElement as tokenize reads it. Shared by
// findParenClose and ansiCBraceClose, which also passes `nested` for the
// commands of the spans inside.
function doubleQuoteEnd(str, i, reading, nested) {
  let read = i;
  while (i < str.length && str[i] !== '"') {
    if (reading) {
      chargeReader(i + 1 - read);
      read = i + 1;
    }
    i = dqElement(str, i, reading, false, nested, false).next;
  }
  if (reading) chargeReader(Math.min(i + 1, str.length) - read);
  return Math.min(i, str.length);
}

// A heredoc tag word that holds a `$'…'` span, read whole the way tokenize
// reads a word — plain and double quotes, a backslash escape, the span's
// value under `shell` — so `<<$'E\x4fF'`, `<<E$'O'F` and `<<'E'$'O'F` all wait
// for `EOF`. zsh decodes a tag too, and where its value differs the heredoc
// ends on a different line: `<<$'\.E'` ends at `.E` in zsh, at `\.E` in bash.
// Returns null for a word with no span: readHeredocTag then reads it exactly
// as it did before #5255.
function ansiCTagWord(str, i, shell) {
  let tag = '';
  let sawSpan = false;
  // #5513's earlier reading ends a tag at any whitespace (readHeredocTag).
  const tagEnd = heredocTagsAsWords ? TAG_WORD_END_RE : /[\s;&|<>()]/;
  while (i < str.length && !tagEnd.test(str[i])) {
    const ch = str[i];
    if (ch === '\\') {
      if (i + 1 < str.length && str[i + 1] !== '\n') tag += str[i + 1]; // `\<newline>` continues the line
      i += 2;
    } else if (ch === '$') {
      const run = dollarRun(str, i);
      // A tag is not expanded, so zsh's `$$'EF'` is `$` and the span (`$EF`),
      // not a PID: the opener takes one `$` under either pairing.
      tag += '$'.repeat(run.dollars - (ownsQuote(run, str, shell) || opensAnsiC(run, str, shell) ? 1 : 0));
      i = run.end; // at the quote, when there is one: the branches below read it
      if (opensAnsiC(run, str, shell)) {
        const end = ansiCQuoteEnd(str, i);
        const raw = str.slice(i + 1, end === -1 ? str.length : end);
        const decoded = decodeAnsiC(raw, shell);
        // An unreadable span is denied where tokenize meets it.
        tag += decoded === null ? raw : decoded;
        sawSpan = true;
        i = end === -1 ? str.length : end + 1;
      }
    } else if (ch === "'") {
      const j = str.indexOf("'", i + 1);
      tag += str.slice(i + 1, j === -1 ? str.length : j);
      i = j === -1 ? str.length : j + 1;
    } else if (ch === '"') {
      i++;
      while (i < str.length && str[i] !== '"') {
        if (str[i] === '\\' && str[i + 1] === '\n') { i += 2; continue; } // line continuation: bash drops it
        if (str[i] === '\\' && i + 1 < str.length && '"\\$`'.includes(str[i + 1])) i++;
        tag += str[i++];
      }
      i++;
    } else {
      tag += str[i++];
    }
  }
  return sawSpan ? { tag, end: Math.min(i, str.length) } : null;
}

// Reads the tag word after `<<` / `<<-` starting at `i`. Under an ANSI-C
// reading a word that holds a `$'…'` span is read whole (ansiCTagWord), and
// bash's `<<$"EOF"` is `<<"EOF"`.
function readHeredocTag(str, i, reading) {
  let stripTabs = false;
  if (str[i] === '-') { stripTabs = true; i++; }
  while (str[i] === ' ' || str[i] === '\t') i++;
  if (reading) {
    const word = ansiCTagWord(str, i, reading);
    if (word !== null) return { tag: word.tag, quoted: true, stripTabs, end: word.end };
  }
  let quoted = false;
  let tag = '';
  if (reading === 'bash' && str[i] === '$' && str[i + 1] === '"') i++;
  if (str[i] === "'" || str[i] === '"') {
    const q = str[i];
    const j = str.indexOf(q, i + 1);
    tag = str.slice(i + 1, j === -1 ? str.length : j);
    quoted = true;
    i = j === -1 ? str.length : j + 1;
  } else {
    if (str[i] === '\\') { quoted = true; i++; }
    // #5513: an unquoted tag is a bash WORD. It ends only at a metacharacter (space, tab,
    // newline, `;&|<>()`): a carriage return is not one, so `EOF` + CR is the tag and the
    // CRLF terminator line matches it; and a substitution inside the word belongs to it,
    // taken literally (`E$(x)F` waits for the line `E$(x)F`).
    while (i < str.length && !(heredocTagsAsWords ? /[ \t\n;&|<>()]/ : /[\s;&|<>()]/).test(str[i])) {
      if (!heredocTagsAsWords) { tag += str[i++]; continue; }
      if (str[i] === '$' && str[i + 1] === '(') {
        const e = findTagSpanClose(str, i + 2, reading);
        tag += str.slice(i, e + 1);
        i = e + 1;
        continue;
      }
      if (str[i] === '$' && str[i + 1] === '{') {
        const j = str.indexOf('}', i);
        const e = j === -1 ? str.length - 1 : j;
        tag += str.slice(i, e + 1);
        i = e + 1;
        continue;
      }
      if (str[i] === '`') {
        const j = backtickEnd(str, i + 1);
        const e = j === -1 ? str.length - 1 : j;
        tag += str.slice(i, e + 1);
        i = e + 1;
        continue;
      }
      tag += str[i++];
    }
  }
  return { tag, quoted, stripTabs, end: i };
}

// From `i` (start of the line after the heredoc-opening line), consume one
// body per pending tag in order. Returns every body with its `quoted`/`seg`
// (the caller emits a token per body and recurses substitutions only for
// unquoted ones) and the index just past the last terminator line. An
// unterminated body consumes to end of input.
function consumeHeredocBodies(str, i, tags) {
  const bodies = [];
  for (const t of tags) {
    let body = '';
    let terminated = false;
    while (i < str.length) {
      const nl = str.indexOf('\n', i);
      const lineEnd = nl === -1 ? str.length : nl;
      const line = str.slice(i, lineEnd);
      i = nl === -1 ? str.length : nl + 1;
      const probe = t.stripTabs ? line.replace(/^\t+/, '') : line;
      if (probe === t.tag) { terminated = true; break; }
      body += line + '\n';
    }
    bodies.push({ body, quoted: t.quoted, seg: t.seg });
    if (!terminated) break;
  }
  return { bodies, end: i };
}

// `$( )` and backtick spans inside an unquoted heredoc body.
function collectSubstitutions(body, nested, reading) {
  let i = 0;
  while (i < body.length) {
    // bash, zsh and dash all pair a `$` run here left to right: in a body
    // `$$( ' $(cat .env) ' )` is the PID, literal text and a `$(cat .env)`
    // they run. Under every reading but the plain one (the `$$(` trigger brings
    // such a command there) an even run is skipped whole, and an odd run's last `$`
    // is read below; the plain reading reads the body as before #5255. A
    // backslash escapes the next character in a body, so `\$` starts no run.
    if (reading && body[i] === '\\') { i += 2; continue; }
    if (reading && body[i] === '$') {
      const run = dollarRun(body, i);
      if (run.dollars > 1) { i = run.dollars % 2 === 1 ? run.last : run.end; continue; }
    }
    if (body[i] === '$' && body[i + 1] === '(') {
      const e = findParenClose(body, i + 2, reading);
      nested.push(body.slice(i + 2, e));
      i = e + 1;
      continue;
    }
    if (body[i] === '`') {
      const j = backtickEnd(body, i + 1);
      const e = j === -1 ? body.length : j;
      const plain = backtickBody(body.slice(i + 1, e));
      nested.push(plain);
      // dash reads the span as inside double quotes (`\"` loses its backslash), bash and zsh do not: both texts are scanned,
      // so a read hidden behind `\"` is seen under any shell (#6433)
      const quoted = backtickBody(body.slice(i + 1, e), true);
      if (quoted !== plain) nested.push(quoted);
      i = e + 1;
      continue;
    }
    i++;
  }
}

// Tokens: { kind: 'word'|'op'|'sep', text, quoted: 'none'|'single'|'double', seg }.
// `op` tokens carry `read` (an input redirect) and `dup` (`>&N`, consumes no
// target). Nested command strings are collected separately. `unreadable` is
// `{ code, text }` for the first `$'…'` word of the ANSI-C reading that has
// no value to check — it never closes, or it does not decode — else null.
function tokenize(str, reading) {
  const tokens = [];
  const nested = [];
  let buf = '';
  let quoted = 'none';
  let hasWord = false;
  let seg = 0;
  let heredocs = [];
  let orphanQueue = [];
  let expectTag = null;
  let unreadable = null;
  // Under the further reading only: whether the next word stands where bash
  // takes an assignment, which is where bash reads a subscript whole
  // (subscriptClose): a command's start, after a reserved word, `time -p` or an
  // assignment, and after a redirection only while nothing but redirections
  // came before it (bash's PST_REDIRLIST: `>f a[x y]=1 cmd` joins, `A=b >f
  // a[x y]=1 cmd` runs `a[x`). A reserved word counts only before any
  // assignment or redirection (`x=1 if …` runs a program named `if`). An
  // unclosed subscript ends bash's parse.
  let atCommandStart = true;
  let onlyRedirects = true;
  let reservedOk = true;
  let redirectTarget = false;
  // The rest of the further reading's state, in one object a closure below
  // holds, so it lives outside tokenize's stack frame: `afterTime` is 1 after
  // `time` and 2 after `time -p`; `closes` holds the `)` closing each `((`'s
  // inner paren (dparenClose); `subscriptsOpen` turns false at an unclosed
  // subscript, which ends bash's parse; `close` is scratch for the subscript
  // just read.
  const further = {
    afterTime: 0,
    closes: new Map(),
    subscriptsOpen: true,
    close: -1,
  };
  orphanHeredocs = [];

  const flush = () => {
    if (!hasWord) return;
    if (expectTag) {
      // Record the current seg (still the `<<` segment — flush runs before the
      // newline sep increments it) so pass 2 can attach the body to the shell.
      heredocs.push({ tag: buf, quoted: quoted !== 'none', stripTabs: expectTag.stripTabs, seg });
      expectTag = null;
    } else {
      // zsh keeps a `\0` escape's NUL in the word and hands a command the
      // word cut there: `$'.env\0'x` is `.env` to zsh, `.envx` to bash.
      const nul = reading === 'zsh' ? buf.indexOf('\0') : -1;
      tokens.push({ kind: 'word', text: nul === -1 ? buf : buf.slice(0, nul), quoted, seg });
      if (furtherReading) noteCommandPosition();
    }
    buf = '';
    quoted = 'none';
    hasWord = false;
  };
  // The word in `buf`, just pushed, moves the further reading's command position.
  const noteCommandPosition = () => {
    const wasAfterTime = further.afterTime;
    further.afterTime = 0;
    if (redirectTarget) {
      redirectTarget = false;
      reservedOk = false;
      if (!onlyRedirects) atCommandStart = false;
    } else if (!atCommandStart) {
      // the command word is behind us
    } else if (reservedOk && quoted === 'none' && ASSIGNMENT_PREFIX_WORDS.has(buf)) {
      onlyRedirects = true;
      further.afterTime = buf === 'time' ? 1 : 0;
    } else if (wasAfterTime === 1 && quoted === 'none' && buf === '-p') {
      further.afterTime = 2;
    } else if (wasAfterTime !== 0 && quoted === 'none' && buf === '--') {
      // `time -p --` and `time --` still take a command
    } else if (FURTHER_ASSIGNMENT_RE.test(buf)) {
      onlyRedirects = false;
      reservedOk = false;
    } else {
      atCommandStart = false;
    }
  };
  // #6438: `{` and `}` are reserved words, which open or close a group only where a command may start. Anywhere else they
  // are ordinary words (`printf '%s|' cat { x }` prints `cat|{|x|}|`; `cat { .env` runs cat on `{` and `.env`), so the word
  // after one is an operand, not a new command. A command may start at the start of a segment and past what can stand
  // before a command: the reserved words that precede one (`then { cat .env; }`, `! {`), a redirection with its target
  // (zsh runs `>out { cat .env; }`), an assignment (zsh runs `A=1 { cat .env; }`), and the heads that take a compound
  // body after their own words (`function f {`, `coproc P {`, `time -p {`). Whatever is unclear is a group: the cost of a
  // wrong group is a false positive, the cost of a wrong word is a secret read the guard no longer sees.
  // The segment's first command word is found once, incrementally, so a run of lone braces is read in linear time.
  let headSeg = -1;
  let headScanned = 0;
  let headWord = null;
  let headSkipTarget = false;
  let headCondition = false;
  // Groups opened and not yet closed: a `}` inside one closes it wherever it stands (zsh: `{ echo x } always { … }`), so it
  // is a word only at depth 0 (`cat } .env`, `echo } done`).
  let groupDepth = 0;
  const braceStartsGroup = () => {
    if (headSeg !== seg) {
      headSeg = seg;
      headWord = null;
      headCondition = false;
      headScanned = tokens.length;
      while (headScanned > 0 && tokens[headScanned - 1].seg === seg) headScanned--;
      // `>&out`: the `&` after a redirection ends a segment here, and the word after it is that redirection's target.
      headSkipTarget = headScanned >= 2 && tokens[headScanned - 1].kind === 'sep' && tokens[headScanned - 1].text === '&' &&
        tokens[headScanned - 2].kind === 'op' && !tokens[headScanned - 2].dup;
    }
    while (headWord === null && headScanned < tokens.length) {
      const token = tokens[headScanned++];
      if (token.kind === 'op') {
        headSkipTarget = !token.dup;
      } else if (token.kind === 'word') {
        if (headSkipTarget) headSkipTarget = false;
        else if (token.quoted === 'none' && RESERVED_BEFORE_COMMAND.has(token.text)) {
          if (CONDITION_WORDS.has(token.text)) headCondition = true;
        } else if (ASSIGNMENT_PREFIX_RE.test(token.text)) continue;
        else headWord = token;
      }
    }
    // zsh also takes a `{` body after a condition (`if true { … }`) or after a compound head's own words.
    return headWord === null || headCondition || (headWord.quoted === 'none' && COMPOUND_BODY_HEADS.has(headWord.text));
  };
  // Emit a heredoc token per consumed body (quoted included): the body is the stdin script only a shell interpreter
  // runs, kept out of `words`. Returns the index just past the last terminator line.
  const emitHeredocBodies = (r) => {
    for (const b of r.bodies) {
      tokens.push({ kind: 'heredoc', text: b.body, quoted: b.quoted, seg: b.seg });
      if (!b.quoted) {
        collectSubstitutions(b.body, nested, reading); // bash expands $( ) here
        orphanHeredocs = [];
      }
    }
    return r.end;
  };
  // The operator text ends segment `seg`; pass 2 reads it to tell `a | bash`
  // (pipe inference) from `a || bash` and to skip grouping seps.
  const sep = (text) => {
    flush();
    tokens.push({ kind: 'sep', text, quoted: 'none', seg });
    seg++;
    atCommandStart = true;
    onlyRedirects = true;
    reservedOk = true;
    further.afterTime = 0;
    redirectTarget = false;
  };
  const op = (text, read, dup) => {
    tokens.push({ kind: 'op', text, quoted: 'none', seg, read, dup });
    if (!dup) redirectTarget = true;
  };

  let i = 0;
  while (i < str.length) {
    // #5515: heredocs a span just closed on this line wait for the next newline, ahead of any opened later.
    if (orphanHeredocs.length) {
      orphanQueued = true;
      for (const tag of orphanHeredocs) {
        const entry = { tag: tag.tag, quoted: tag.quoted, stripTabs: tag.stripTabs, seg, done: false };
        heredocs.push(entry);
        orphanQueue.push(entry);
      }
      orphanHeredocs = [];
    }
    const ch = str[i];

    // A run of `$` under any reading but the plain one: dollar-quoting (none
    // under dash's), tested before the plain quote branches (see the
    // dollar-quoting section above), then the run's pairing. The plain
    // reading reads `$` as it did before #5255.
    if (reading && ch === '$') {
      const run = dollarRun(str, i);
      if (run.atQuote) {
        // The `$` run up to the quote, without its line continuations; the
        // `$` that owns the quote is dropped, the rest is literal word text
        // (zsh's `$$'x'` keeps both: the PID, then the span). A heredoc tag
        // is not expanded, so there the opener takes one `$` (ansiCTagWord).
        const opener = ownsQuote(run, str, reading) || (expectTag !== null && opensAnsiC(run, str, reading));
        const literal = '$'.repeat(run.dollars - (opener ? 1 : 0));
        if (literal) { hasWord = true; buf += literal; }
        if (opensAnsiC(run, str, reading)) {
          hasWord = true;
          if (quoted === 'none') quoted = 'single';
          // A span that bash reads as a plain quote after a PID (an even run,
          // under zsh's reading) never denies for want of a value: `$$'x'` is
          // the PID and a plain quote, as #5255 requires, so the bash reading
          // judges `echo $$'x\'; ls`. Secret reads in the span's word still
          // count (it can still report them).
          const noValue = (code) => {
            if (unreadable === null && run.owned) unreadable = { code, text: quoteExcerpt(str, run.end - 1) };
          };
          const end = ansiCQuoteEnd(str, run.end);
          if (end === -1) {
            noValue('ansi-c-unterminated');
            i = str.length;
            continue;
          }
          const decoded = decodeAnsiC(str.slice(run.end + 1, end), reading);
          if (decoded === null) {
            noValue('ansi-c-undecodable');
          } else {
            buf += decoded;
          }
          i = end + 1;
          continue;
        }
        // A plain quote after the PID, or `$"…"` — `"…"` to bash, `$` and
        // `"…"` to zsh and dash: the quote branches below take it from here.
        i = run.end;
        continue;
      }
      const math = str[run.end] === '[' ? zshMathEnd(str, run.end, reading) : -1;
      if (math !== -1) {
        hasWord = true;
        buf += str.slice(i, math + 1);
        collectSubstitutions(str.slice(run.end + 1, math), nested, reading); // zsh expands them
        i = math + 1;
        continue;
      }
      // Any other run. bash (and dash) pair it left to right, so an even run
      // is all PIDs and the `{` or `(` after it is a literal: bash runs the
      // rest of `echo $${; cat .env`. zsh's lexer instead opens a `${…}` after
      // the run whatever its length and splits it into PID and text only when
      // it expands it: zsh runs the read in `echo $${x #}; cat .env`, where
      // bash and dash read a comment. So bash's and dash's readings pair; under
      // zsh's the last `$` goes to the `$(` / `${` branches below, as before. A
      // line continuation after that `$` is the main loop's to strip.
      if (!run.atQuote && run.dollars > 1) {
        hasWord = true;
        const odd = run.dollars % 2 === 1 || reading === 'zsh';
        buf += '$'.repeat(odd ? run.dollars - 1 : run.dollars);
        i = odd ? run.last : run.end;
        continue;
      }
    }

    if (ch === "'") {
      hasWord = true;
      if (quoted === 'none') quoted = 'single';
      const j = str.indexOf("'", i + 1);
      const end = j === -1 ? str.length : j;
      buf += str.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      hasWord = true;
      if (quoted === 'none') quoted = 'double';
      i++;
      while (i < str.length && str[i] !== '"') {
        const el = dqElement(str, i, reading, expectTag !== null, nested, true);
        buf += el.text;
        i = el.next;
      }
      i++;
      continue;
    }

    if (ch === '\\') {
      if (str[i + 1] === '\n') {
        i += 2; // line continuation
        // #5515: bash reads the body of a heredoc a closed `$( )` left waiting from the next input line, even when the
        // newline before it is a continuation (`echo $(cat <<A) x; cat <<B\`, `A`, `C`, `body`, `BC`): the word goes on
        // after the body.
        if (orphanQueue.length) {
          const orphans = orphanQueue;
          orphanQueue = [];
          for (const h of orphans) h.done = true;
          i = emitHeredocBodies(consumeHeredocBodies(str, i, orphans));
        }
        continue;
      }
      hasWord = true;
      if (i + 1 < str.length) buf += str[i + 1];
      i += 2;
      continue;
    }

    if (ch === '$' && str[i + 1] === '(') {
      hasWord = true;
      const e = expectTag ? findTagSpanClose(str, i + 2, reading) : findParenClose(str, i + 2, reading);
      nested.push(str.slice(i + 2, e));
      if (expectTag && heredocTagsAsWords) buf += str.slice(i, e + 1); // #5513: the tag is taken literally
      i = e + 1;
      continue;
    }

    if (ch === '$' && str[i + 1] === '{') {
      hasWord = true;
      // A heredoc tag is not expanded, so dash ends one at the next metacharacter
      // whatever follows (`<<${;cat .env` runs the read, `<<${;cat .env #}` too).
      if (expectTag && heredocTagsAsWords && heredocBraceTags && reading !== 'bash' && reading !== 'zsh') {
        braceTagRead = true;
        buf += '${';
        i += 2;
        continue;
      }
      const inner = [];
      const j = reading ? ansiCBraceClose(str, i + 2, reading, inner, false) : str.indexOf('}', i);
      if (j !== -1) for (const cmd of inner) nested.push(cmd);
      const k = j === -1 && reading && !asBefore ? str.indexOf('}', i) : j;
      const e = k === -1 ? str.length - 1 : k;
      buf += str.slice(i, e + 1);
      i = e + 1;
      continue;
    }

    if (ch === '`') {
      hasWord = true;
      const j = backtickEnd(str, i + 1);
      const e = j === -1 ? str.length : j;
      const plain = backtickBody(str.slice(i + 1, e));
      nested.push(plain);
      // The plain reading ends a double-quoted word at a quote nested in a `${…}`, so a backtick the shell reads inside
      // double quotes lands here: its `\"` loses the backslash there, so both texts are scanned (#6433).
      const quoted = backtickBody(str.slice(i + 1, e), true);
      if (quoted !== plain) nested.push(quoted);
      if (expectTag && heredocTagsAsWords) buf += str.slice(i, e + 1); // #5513: the tag is taken literally
      i = e + 1;
      continue;
    }

    if ((ch === '<' || ch === '>') && str[i + 1] === '(') {
      flush();
      const e = findParenClose(str, i + 2, reading);
      const inner = str.slice(i + 2, e);
      nested.push(inner);
      // Emit a word carrying the inner script so a shell / `source` operand
      // (`sh <(echo 'cat .env')`) can reconstruct it; the bare nested recursion
      // above only sees `echo …`, whose operands are not read.
      tokens.push({ kind: 'word', text: str.slice(i, e + 1), quoted: 'none', seg, procsub: inner });
      i = e + 1;
      continue;
    }

    if (ch === '\n') {
      sep('\n');
      i++;
      if (heredocs.length) {
        const pending = heredocs.filter((h) => !h.done);
        heredocs = [];
        orphanQueue = [];
        i = emitHeredocBodies(consumeHeredocBodies(str, i, pending));
      }
      continue;
    }

    // #5513: a CR is not a bash metacharacter, so inside a heredoc tag it is part of the word
    // (a CRLF command's terminator line is `EOF` + CR).
    if (ch === '\r' && expectTag && hasWord && heredocTagsAsWords) {
      buf += ch;
      i++;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush();
      i++;
      continue;
    }

    if (ch === '#' && !hasWord) {
      const j = str.indexOf('\n', i);
      i = j === -1 ? str.length : j;
      continue;
    }

    if (ch === '<' || ch === '>' || (ch === '&' && str[i + 1] === '>')) {
      let fd = '';
      // bash also takes a named fd, `{fd}>file`, under the further reading, and
      // only right before `<` or `>` (`{fd}&>f` keeps `{fd}` a word). bash tests
      // the raw word, so a quote, a backslash or a substitution in it (`{f\d}`)
      // leaves a word.
      if (hasWord && quoted === 'none'
          && (/^\d+$/.test(buf)
            || (furtherReading && ch !== '&' && isNamedFd(buf) && isRawWordBefore(str, i, buf)))) {
        fd = buf;
        buf = '';
        hasWord = false;
      } else {
        flush();
      }
      let j = i;
      let text;
      if (str.startsWith('<<<', j)) { text = '<<<'; j += 3; }
      else if (str.startsWith('<<-', j)) { text = '<<-'; j += 3; }
      else if (str.startsWith('<<', j)) { text = '<<'; j += 2; }
      else if (str.startsWith('&>>', j)) { text = '&>>'; j += 3; }
      else if (str.startsWith('&>', j)) { text = '&>'; j += 2; }
      else if (str.startsWith('>>', j)) { text = '>>'; j += 2; }
      else if (str.startsWith('>|', j)) { text = '>|'; j += 2; }
      else { text = ch; j += 1; }
      if (text === '<<' || text === '<<-') {
        expectTag = { stripTabs: text === '<<-' };
        i = j;
        continue;
      }
      let dup = false;
      if ((text === '<' || text === '>') && str[j] === '&' && /[\d-]/.test(str[j + 1] || '')) {
        let k = j + 1;
        while (k < str.length && /[\d-]/.test(str[k])) k++;
        text += str.slice(j, k);
        j = k;
        dup = true;
      }
      op(fd + text, text[0] === '<' && text !== '<<<', dup);
      i = j;
      continue;
    }

    // Lookahead first, THEN record the full operator, so `a || bash` reports
    // `||` (no pipe inference) and `a | bash` reports `|` (pipe inference).
    if (ch === ';') {
      let text = ';';
      i++;
      if (str[i] === ';') { text = ';;'; i++; }
      sep(text);
      continue;
    }
    if (ch === '|') {
      let text = '|';
      i++;
      if (str[i] === '|') { text = '||'; i++; }
      else if (str[i] === '&') { text = '|&'; i++; }
      sep(text);
      continue;
    }
    if (ch === '&') {
      let text = '&';
      i++;
      if (str[i] === '&') { text = '&&'; i++; }
      sep(text);
      continue;
    }
    if (ch === '(' && str[i + 1] === '(' && !hasWord) {
      const math = zshMathEnd(str, i + 1, reading);
      if (math !== -1) {
        collectSubstitutions(str.slice(i + 2, math - 1), nested, reading);
        i = math + 1;
        continue;
      }
    }
    if (ch === '(' || ch === ')') {
      sep(ch);
      i++;
      // `((` opens arithmetic, where bash reads no assignment, when a `))`
      // closes it; otherwise bash reads two subshells (parse_dparen), and a
      // command starts after them. The tokens are the same two seps either way.
      if (ch === '(' && furtherReading && str[i] === '(') {
        sep('(');
        i++;
        if (str[dparenCloseFor(str, i, further) + 1] === ')') atCommandStart = false;
      }
      continue;
    }
    // A brace where a heredoc tag is due is the tag (`<<}; cat .env` is tag `}`,
    // then the read), never a group: every shell takes a `{` there, and bash
    // and dash a `}`.
    if ((ch === '{' || ch === '}') && !hasWord && (i + 1 >= str.length || /[\s;&|)]/.test(str[i + 1]))) {
      if (expectTag && heredocTagsAsWords && heredocBraceTags) {
        braceTagRead = true;
      } else if (expectTag || (ch === '}' && groupDepth > 0) || braceStartsGroup()) {
        if (ch === '{') groupDepth++;
        else if (groupDepth > 0) groupDepth--;
        // Where a heredoc tag is due the earlier reading keeps the brace a group (`: <<} E` read as `}` closing), so nothing denied before is allowed.
        sep(ch);
        i++;
        continue;
      }
      // else: a brace among a command's arguments is an ordinary word (#6438), read below like any other.
    }

    // bash's token_is_ident reads the RAW word: a name spelled through a quote,
    // a backslash or a substitution (`\a[`, `$(x)a[`) takes no subscript.
    if (ch === '[' && furtherReading && atCommandStart && !redirectTarget && further.subscriptsOpen
        && quoted === 'none' && isRawNameBefore(str, i, buf.length)) {
      if (!subscriptJoins) {
        joinCandidate = true;
      } else {
        further.close = subscriptClose(str, i);
        if (further.close === -1) {
          further.subscriptsOpen = false;
        } else {
          buf += str.slice(i, further.close + 1);
          i = further.close + 1;
          continue;
        }
      }
    }

    hasWord = true;
    buf += ch;
    i++;
  }
  flush();
  return { tokens, nested, unreadable };
}

// Whether a word is a named fd to bash: `{name}`, or `{name[sub]}` with a
// non-empty subscript whose `]` is the last one (valid_array_reference), so
// `{a[]}`, `{a[0]]}` and `{a[0][1]}` are words.
function isNamedFd(word) {
  const m = /^\{([A-Za-z_][A-Za-z0-9_]*)(\[[\s\S]*\])?\}$/.exec(word);
  if (!m) return false;
  if (!m[2]) return true;
  const sub = m[2];
  if (sub.length < 3) return false;
  let depth = 0;
  for (let k = 0; k < sub.length; k++) {
    if (sub[k] === '[') depth++;
    else if (sub[k] === ']' && --depth === 0) return k === sub.length - 1;
  }
  return false;
}

// What ends a raw word to bash: a blank (space or tab), a newline, or one of
// `;&|(<>`. Not every `\s`: a carriage return is part of a word to bash, so in
// `env -u\r{fd}>f` the word is `-u\r{fd}` and there is no named fd.
const RAW_WORD_BREAK_RE = /[ \t\n;&|(<>]/;

// Whether `name` is the whole raw word in front of `i`: the same characters,
// with any backslash-newline (removed before bash reads a word; the backslash
// itself unescaped) skipped, and starting the word (at the start, or after a
// RAW_WORD_BREAK_RE character).
function isRawWordBefore(str, i, name) {
  let k = i;
  let n = name.length;
  const continuation = () => continuationBefore(str, k);
  while (n > 0) {
    if (continuation()) { k -= 2; continue; }
    if (k < 1 || str[k - 1] !== name[n - 1]) return false;
    k--;
    n--;
  }
  while (continuation()) k -= 2;
  return k === 0 || RAW_WORD_BREAK_RE.test(str[k - 1]);
}

// Whether a backslash-newline whose backslash is itself unescaped ends at `k`.
function continuationBefore(str, k) {
  if (k < 2 || str[k - 1] !== '\n') return false;
  let j = k - 2;
  while (j >= 0 && str[j] === '\\') j--;
  return (k - 2 - j) % 2 === 1;
}

// Whether the raw word in front of `i` is a shell name `len` characters long,
// any backslash-newline skipped: bash's token_is_ident reads the raw word, so
// a name spelled through a quote, a backslash or a substitution is none. The
// scan goes back over name characters only, so a run of `[` costs one each.
function isRawNameBefore(str, i, len) {
  let k = i;
  let n = 0;
  let first = '';
  for (;;) {
    if (continuationBefore(str, k)) { k -= 2; continue; }
    if (k < 1 || !/[A-Za-z0-9_]/.test(str[k - 1])) break;
    if (++n > len) return false;
    first = str[--k];
  }
  return n === len && n > 0 && !/[0-9]/.test(first)
    && (k === 0 || RAW_WORD_BREAK_RE.test(str[k - 1]));
}

// Index of the `)` closing the paren opened just before `i`, as bash's
// parse_matched_pair reads a `((` body (parse_dparen): quotes hide a paren, `$'…'`
// and backquotes honour a backslash, and no heredoc body is skipped; str.length
// when none does. It records in `dparen.closes`, keyed by the index after each
// nested `(`, the close of every paren it passes, so a command's `((` cost one scan.
// A scan that meets an unclosed quote walks to the end and records nothing, so each
// later `((` walks again (a run of `((x "${"(`: 139 s at 990 KB). So each scan
// charges its distance to the further reading's reader budget (chargeReader), and
// a command that spends it is denied as `command-too-complex` (findSecretRead).
// The further reading's scanners (dparenClose, subscriptClose) can reach this
// inside a `${…}` the plain tokenizer skips, and it recurses once per `"$(`, so a
// long run overflows the stack in that reading alone. The RangeError is not caught
// here: either guess at an unknown close can change how the rest of the line
// reads, so the line is denied as unfinished instead.

// The tokenizer's further-reading lookup, kept out of tokenize so its stack
// frame stays small (see curlOperandOpensSecret).
function dparenCloseFor(str, i, dparen) {
  let close = dparen.closes.get(i);
  if (close === undefined) close = dparenClose(str, i, dparen);
  return close;
}

function dparenClose(str, i, dparen) {
  const start = i;
  const opens = [];
  let close = str.length;
  while (i < str.length) {
    const c = str[i];
    if (c === '\\') { i += 2; continue; }
    let end = -2;
    if (c === "'") end = str.indexOf("'", i + 1);
    else if (c === '$' && str[i + 1] === "'") end = ansiCQuoteClose(str, i + 2);
    else if (c === '"') end = doubleQuoteClose(str, i + 1);
    else if (c === '`') end = backquoteClose(str, i + 1);
    if (end !== -2) {
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (c === '(') {
      opens.push(i + 1);
    } else if (c === ')') {
      if (opens.length === 0) { close = i; break; }
      dparen.closes.set(opens.pop(), i);
    }
    i++;
  }
  chargeReader(close - start);
  for (const o of opens) dparen.closes.set(o, str.length);
  return close;
}

// Index of the backquote closing a backquote span whose body starts at `k`,
// or -1: a backslash escapes the next character, a backquote included.
function backquoteClose(str, k) {
  for (; k < str.length; k++) {
    if (str[k] === '\\') k++;
    else if (str[k] === '`') return k;
  }
  return -1;
}

// Index of the `'` closing an ANSI-C quote `$'…'` whose body starts at `k`, or
// -1: a backslash escapes the next character, `\'` included.
function ansiCQuoteClose(str, k) {
  for (; k < str.length; k++) {
    if (str[k] === '\\') k++;
    else if (str[k] === "'") return k;
  }
  return -1;
}

// Index of the `]` that closes the subscript bash reads from the `[` at `i`
// (`a[x y]=1 cmd` is one word to bash), or -1 when none does, which bash
// reports as an unexpected end of input. Quotes (`$'…'` included), a
// backslash, `$(…)`, `${…}` and backquotes hide a `]`; a nested `[` takes its own.
function subscriptClose(str, i) {
  let depth = 0;
  for (let k = i; k < str.length; k++) {
    const c = str[k];
    if (c === '\\') {
      k++;
    } else if (c === '$' && str[k + 1] === "'") {
      k = ansiCQuoteClose(str, k + 2);
      if (k === -1) return -1;
    } else if (c === "'") {
      k = str.indexOf(c, k + 1);
      if (k === -1) return -1;
    } else if (c === '`') {
      k = backquoteClose(str, k + 1);
      if (k === -1) return -1;
    } else if (c === '"') {
      k = doubleQuoteClose(str, k + 1);
      if (k === -1) return -1;
    } else if (c === '$' && str[k + 1] === '(') {
      k = findParenClose(str, k + 2);
      if (k >= str.length) return -1;
    } else if (c === '$' && str[k + 1] === '{') {
      k = braceClose(str, k + 2);
      if (k === -1) return -1;
    } else if (c === '[') {
      depth++;
    } else if (c === ']' && --depth === 0) {
      return k;
    }
  }
  return -1;
}

// Index of the `}` closing a `${` opened just before `k`, or -1. Quotes, a
// backslash and `$(…)` hide a `}`; a nested `${` takes its own.
function braceClose(str, k) {
  return quotedSpanClose(str, k, '}');
}

// Index of the `"` closing a double-quoted span that starts at `k`, or -1.
// `$(…)`, `${…}` and backquotes hide a `"`.
function doubleQuoteClose(str, k) {
  return quotedSpanClose(str, k, '"');
}

// The one loop behind braceClose and doubleQuoteClose: `open` holds the spans
// still open, innermost last, each as the character that closes it. Inside
// `"…"` a `'` is literal; inside `${…}` it quotes, and a `"` opens a span of
// its own. An explicit stack, so a long run of `"${` costs no call depth.
function quotedSpanClose(str, k, first) {
  const open = [first];
  while (k < str.length) {
    const c = str[k];
    const inBrace = open[open.length - 1] === '}';
    if (c === open[open.length - 1]) {
      open.pop();
      if (open.length === 0) return k;
      k++;
    } else if (c === '\\') {
      k += 2;
    } else if (c === '$' && str[k + 1] === '(') {
      k = findParenClose(str, k + 2);
      if (k >= str.length) return -1;
      k++;
    } else if (c === '$' && str[k + 1] === '{') {
      open.push('}');
      k += 2;
    } else if (c === '`') {
      k = backquoteClose(str, k + 1);
      if (k === -1) return -1;
      k++;
    } else if (inBrace && c === '$' && str[k + 1] === "'") {
      k = ansiCQuoteClose(str, k + 2);
      if (k === -1) return -1;
      k++;
    } else if (inBrace && c === "'") {
      k = str.indexOf(c, k + 1);
      if (k === -1) return -1;
      k++;
    } else if (inBrace && c === '"') {
      open.push('"');
      k++;
    } else {
      k++;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Bash command scan — pass 2: per-segment evaluation
// ---------------------------------------------------------------------------

// Option characters of a bundled short cluster (`-2nif`).
const CLUSTER_FLAG_CHAR_RE = /[A-Za-z0-9]/;

// True when an operand word names a secret file. `@file` (curl -d) and
// `--flag=value` are stripped to the value. In a single-dash word
// (`/^-[^-]./`, so `-2if.env` counts too) the value of a bundled cluster
// starts right after its run of option characters (#5046): `-if.env` holds
// `.env`, `-nf=.env` holds `.env` after the `=`. That value is checked as
// well as the historical two-character strip, so the verdict is never looser
// than base and costs a fixed number of `namesSecret` calls (at most three,
// whatever the word's length). The option run also swallows a value's leading
// letters and digits, so `-fapp.env` is denied although `cat app.env` is not:
// a fail-safe false positive, pinned in tests.
function operandNamesSecret(text) {
  return operandSecretMatch(text) !== null;
}

// The text that names the secret: the word itself, or the variant or field of it that does (#6132), so the denial names
// `.env` and not the whole word. null when nothing does.
function namesSecretVariant(text) {
  return namesSecretOperand(text) || paramVariantsMatch(text, namesSecretOperand) !== null;
}

function operandSecretMatch(text) {
  if (operandWordNamesSecret(text)) return text;
  return paramVariantsMatch(text, operandWordNamesSecret);
}

// A script text a shell runs (`eval`, `-c`, a process substitution, a heredoc or here-string fed to a shell) scanned as
// written and with each `${…}` default expanded, so `eval ${x:-cat .env}` reads what `eval cat .env` does. Fails closed past
// the bounds, like the operand check.
function findSecretReadWithDefaults(text, depth) {
  const direct = findSecretRead(text, depth);
  if (direct || !text.includes('${')) return direct;
  return findSecretReadInVariants(text, depth);
}

// The scan of each variant of `text` (paramVariants), expanded again until none holds a default; null when none reads.
function findSecretReadInVariants(text, depth) {
  if (!text.includes('${')) return null;
  if (text.length > MAX_PARAM_TEXT) return secretRead(text);
  let layer = [text];
  for (let level = 0; level < MAX_PARAM_LEVELS; level++) {
    const next = [];
    for (const word of layer) {
      const expanded = paramVariants(word, MAX_SCRIPT_VARIANTS, true);
      if (expanded.overflow) return secretRead(text);
      for (const variant of expanded.variants) {
        const hit = findSecretRead(variant, depth);
        if (hit) return hit;
        if (variant.includes('${')) next.push(variant);
      }
    }
    if (next.length === 0) return null;
    if (next.length > MAX_SCRIPT_VARIANTS) return secretRead(text);
    layer = next;
  }
  return secretRead(text);
}

// `text` with every balanced `${…}` removed: whitespace left in it means the word is a script or a quoted sentence, whose
// own spaces are not field separators.
// `text` split on whitespace that is not inside a `${…}` (a subscript or default may hold spaces).
function splitOutsideParams(text) {
  const fields = [];
  let current = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '{') {
      const close = paramCloseIndex(text, i + 2);
      const end = close === -1 ? text.length - 1 : close;
      current += text.slice(i, end + 1);
      i = end + 1;
    } else if (/\s/.test(text[i])) {
      if (current !== '') fields.push(current);
      current = '';
      i++;
    } else current += text[i++];
  }
  if (current !== '') fields.push(current);
  return fields;
}

function textOutsideParams(text) {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = text.indexOf('${', pos);
    if (open === -1) return out + text.slice(pos);
    out += text.slice(pos, open);
    const close = paramCloseIndex(text, open + 2);
    if (close === -1) return out;
    pos = close + 1;
  }
}

// The first variant of a word holding `${…}` (paramVariants) that names a secret by `check`, or one of its fields.
// A default can hold another expansion (`${x:-${y:-.env}}`): the variants are expanded again until none holds one. Past
// a bound, or for an expansion that never balances, the word cannot be read exhaustively and fails closed: the name can be
// assembled from decoded or split defaults, so what the raw word spells proves nothing.
function paramVariantsMatch(text, check) {
  if (!text.includes('${')) return null;
  if (text.length > MAX_PARAM_TEXT) return text;
  // An unquoted expansion's value is split into fields (bash, dash), each its own operand, but only in a word that has no
  // whitespace of its own: `cat ${x:-a .env}` splits, `bash -c 'echo ${P:-3}; [ -f .env ]'` is a script.
  const splitFields = !/\s/.test(textOutsideParams(text));
  let layer = [text];
  for (let level = 0; level < MAX_PARAM_LEVELS; level++) {
    const next = [];
    for (const word of layer) {
      const expanded = paramVariants(word, MAX_PARAM_VARIANTS, !splitFields);
      if (expanded.overflow) return text;
      for (const variant of expanded.variants) {
        if (check(variant)) return variant;
        if (splitFields && /\s/.test(variant)) {
          const piece = variant.split(/\s+/).find((field) => field !== '' && check(field));
          if (piece !== undefined) return piece;
        }
        if (variant.includes('${')) next.push(variant);
      }
    }
    if (next.length === 0) return null;
    if (next.length > MAX_PARAM_VARIANTS) return text;
    layer = next;
  }
  return text;
}

// #6132: the words a word holding `${name<op>WORD}` or an empty `${}` can expand to. The shell takes WORD when the
// variable is unset (`-`, `:-`, `=`, `:=`, `?`, `:?`) or set (`+`, `:+`), and nothing in the other case, so each such
// expansion is replaced by its quote-removed WORD, and by nothing; an empty `${}` by nothing (zsh reads it so). The guard
// cannot know the variable, so every combination is a candidate (at most MAX_PARAM_VARIANTS): `cat ${x:-$'.env'}`,
// `cat ${x-$'.e\x6ev'}`, `cat ${x:+a}.env` and `cat .env${}` all name `.env`. Any other `${…}` form is left as it is.
const MAX_PARAM_VARIANTS = 4096;
const MAX_SCRIPT_VARIANTS = 256; // a script text is scanned in full once per variant
const MAX_PARAM_LEVELS = 32;
// Bounds on the work a word can cost: its length, and the characters its variants add up to (the product of many nested
// groups grows fast); past either the word fails closed.
const MAX_PARAM_TEXT = 262144;
const MAX_PARAM_VARIANT_CHARS = 2000000;
// The name before the operator: a variable (also indirect `!name`, subscripted), a positional or special parameter, and in
// zsh an empty name, `(flags)name` or a nested `${…}`.
// Where the operator of a `${…}`'s inner text ends (the index after `-`, `:-`, `+`, `:+`, `=` or `:=`), or -1 when it has
// none: after optional zsh prefix flags (`=`, `~`, `^`, `+`), a `(flags)` group, a name that is any number of nested `${…}`
// then a variable (also `!name`), a positional or special parameter, or nothing (zsh), and an optional quote-aware
// `[subscript]`.
function paramOperatorEnd(inner) {
  let i = 0;
  while (i < inner.length && '=~^+'.includes(inner[i])) i++;
  if (inner[i] === '(') {
    let depth = 0;
    let j = i;
    for (; j < inner.length; j++) {
      if (inner[j] === '\\') { j++; continue; }
      if (inner[j] === '(') depth++;
      else if (inner[j] === ')' && --depth === 0) break;
    }
    if (j >= inner.length) return -1;
    i = j + 1;
  }
  for (;;) {
    if (inner.startsWith('${', i)) {
      const close = paramCloseIndex(inner, i + 2);
      if (close === -1) return -1;
      i = close + 1;
    } else break;
  }
  if (inner[i] === '!') i++;
  const name = /[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*!?#$-]/y;
  name.lastIndex = i;
  const m = name.exec(inner);
  if (m) i += m[0].length;
  if (inner[i] === '[') {
    let depth = 0;
    let j = i;
    for (; j < inner.length; j++) {
      const ch = inner[j];
      if (ch === '\\') { j++; continue; }
      if (ch === "'" || ch === '"') {
        const k = inner.indexOf(ch, j + 1);
        if (k === -1) return -1;
        j = k;
        continue;
      }
      if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) break;
    }
    if (j >= inner.length) return -1;
    i = j + 1;
  }
  if (inner[i] === ':') i++;
  return '-+='.includes(inner[i]) && i < inner.length ? i + 1 : -1;
}

// The index of the `}` closing the `${` whose text starts at `i`, or -1: quotes, `$'…'` spans and nested `${` are read.
function paramCloseIndex(str, i) {
  let depth = 1;
  while (i < str.length) {
    const ch = str[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === "'") {
      const j = str.indexOf("'", i + 1);
      if (j === -1) return -1;
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < str.length && str[i] !== '"') i += str[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (ch === '$' && str[i + 1] === "'") {
      const end = ansiCQuoteEnd(str, i + 1);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '$' && str[i + 1] === '{') { depth++; i += 2; continue; }
    if (ch === '}' && --depth === 0) return i;
    i++;
  }
  return -1;
}

// WORD with its quotes and backslashes removed as the shell removes them, or null for a `$'…'` span with no value.
function unquoteParamWord(word) {
  let out = '';
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === '\\') {
      if (word[i + 1] === '\n') { i++; continue; } // a line continuation: the shell removes both
      if (i + 1 < word.length) out += word[++i];
      continue;
    }
    if (ch === "'") {
      const j = word.indexOf("'", i + 1);
      out += word.slice(i + 1, j === -1 ? word.length : j);
      i = j === -1 ? word.length : j;
      continue;
    }
    if (ch === '"' || (ch === '$' && word[i + 1] === '"')) {
      let j = ch === '"' ? i + 1 : i + 2;
      while (j < word.length && word[j] !== '"') {
        if (word[j] === '\\' && j + 1 < word.length) {
          const next = word[j + 1];
          if (next === '\n') { j += 2; continue; } // a line continuation
          if ('"\\$`'.includes(next)) { out += next; j += 2; continue; }
        }
        out += word[j++];
      }
      i = j;
      continue;
    }
    if (ch === '$' && word[i + 1] === "'") {
      const end = ansiCQuoteEnd(word, i + 1);
      const decoded = decodeAnsiC(word.slice(i + 2, end === -1 ? word.length : end), 'bash');
      if (decoded === null) return null;
      out += decoded;
      i = end === -1 ? word.length : end;
      continue;
    }
    out += ch;
  }
  return out;
}

function paramVariants(text, cap = MAX_PARAM_VARIANTS, linear = false) {
  const parts = []; // a literal string, or the choices an expansion can take
  let pos = 0;
  let changed = false;
  for (;;) {
    const open = text.indexOf('${', pos);
    parts.push(text.slice(pos, open === -1 ? text.length : open));
    if (open === -1) break;
    const close = paramCloseIndex(text, open + 2);
    if (close === -1) {
      // `${x:-"${y:-.env}}`: the quote skipper ran out of text; whatever follows an operator may still be read.
      if (paramOperatorEnd(text.slice(open + 2)) !== -1) return { variants: [], overflow: true };
      parts.push(text.slice(open));
      break;
    }
    const inner = text.slice(open + 2, close);
    const operatorEnd = paramOperatorEnd(inner);
    let choices;
    if (inner === '') choices = [''];
    else if (operatorEnd !== -1) {
      const value = unquoteParamWord(inner.slice(operatorEnd));
      choices = value === null || value === '' ? [''] : [value, ''];
    } else choices = [text.slice(open, close + 1)];
    if (choices.length !== 1 || choices[0] !== text.slice(open, close + 1)) changed = true;
    parts.push(choices);
    pos = close + 1;
  }
  if (!changed) return { variants: [], overflow: false };
  const groups = parts.filter((part) => Array.isArray(part) && part.length > 1).length;
  let tooBig = 2 ** Math.min(groups, 30) > cap;
  if (!tooBig) {
    let variants = [''];
    let chars = 0;
    for (const part of parts) {
      const choices = Array.isArray(part) ? part : [part];
      const next = [];
      for (const v of variants) {
        for (const c of choices) {
          next.push(v + c);
          chars += v.length + c.length;
        }
      }
      if (chars > MAX_PARAM_VARIANT_CHARS) { tooBig = true; break; }
      variants = next;
    }
    if (!tooBig) return { variants, overflow: false };
  }
  if (!linear) return { variants: [], overflow: true };
  // A script with many defaults: each expansion on its own with the others empty, all of them, and none. A name assembled
  // from several of them is then not seen (a gap; the operand check keeps the full product).
  const build = (take) => parts.map((part, index) => {
    if (!Array.isArray(part)) return part;
    return part.length > 1 && take(index) ? part[0] : (part.length > 1 ? '' : part[0]);
  }).join('');
  const indexes = parts.map((part, index) => (Array.isArray(part) && part.length > 1 ? index : -1)).filter((index) => index !== -1);
  const variants = [build(() => true), build(() => false), ...indexes.map((chosen) => build((index) => index === chosen))];
  return { variants, overflow: false };
}

function operandWordNamesSecret(text) {
  let v = text;
  if (v.startsWith('@')) v = v.slice(1);
  if (v.startsWith('--')) {
    const eq = v.indexOf('=');
    if (eq !== -1) v = v.slice(eq + 1);
    return namesSecretOperand(v);
  }
  if (!/^-[^-]./.test(v)) return namesSecretOperand(v);
  if (namesSecretOperand(v.slice(2))) return true;
  let end = 1;
  while (end < v.length && CLUSTER_FLAG_CHAR_RE.test(v[end])) end++;
  if (end > 2 && namesSecretOperand(v.slice(end))) return true;
  return v[end] === '=' && namesSecretOperand(v.slice(end + 1));
}

const CURL_COMMANDS = new Set(['curl', 'curl.exe']);

// curl's two blank sets: ISSPACE, which its -F parser skips and trims before
// 8.13, and ISBLANK, from 8.13.
function isCurlSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f';
}

function isCurlBlank(ch) {
  return ch === ' ' || ch === '\t';
}

// namesSecret judges only a name's last path segment (and the part of it after
// a `:`), so the segment is cut out here first: one pass, where lastSegment's
// trailing-separator regex backtracks on a long run of separators. A name it
// judges secret is kept in curlOpened, so a block reports the file curl opens
// rather than the option word that holds it (`.env`, not `-d@.env`).
function curlNameIsSecret(name) {
  let end = name.length;
  while (end > 0 && (name[end - 1] === '/' || name[end - 1] === '\\')) end--;
  let seg = end;
  while (seg > 0 && name[seg - 1] !== '/' && name[seg - 1] !== '\\') seg--;
  const last = name.slice(seg, end);
  if (!last.includes('.') || !namesSecret(last)) return false;
  curlOpened = name;
  return true;
}

// The secret name the curl reading last found (curlNameIsSecret). Every curl
// reader returns as soon as curlNameIsSecret says yes, so right after a reader
// returns true this is the name that decided it.
let curlOpened = '';

// The grammars curl's -F parser (src/tool_formparse.c) has shipped. They open
// different files for some values, so a value is judged under each:
//   through 8.11  ISSPACE blanks; type= split by sscanf("%127[^/ ]/%127[^;, \n]")
//   8.12          ISSPACE blanks; type= ends at a MIME tspecial
//   from 8.13     ISBLANK blanks; type= ends at a MIME tspecial
// Through 8.20 a file list goes on after any character a part ends at; from
// 8.21 only after `,`, which opens a subset of what 8.13 opens.
const CURL_FORM_GRAMMARS = [
  { blank: isCurlSpace, sscanfType: true },
  { blank: isCurlSpace, sscanfType: false },
  { blank: isCurlBlank, sscanfType: false },
];
const CURL_TYPE_TSPECIALS = '()<>@,;:\\"[]?=\r\n ';

// For each index i of `text`, the index of the first quote at or after i that
// closes a quoted word, or -1. curl's get_param_word skips `\\` and `\"` pairs,
// so a quote closes a word when the run of backslashes before it is even. A
// scan always enters that run from its start, so where it began does not
// matter, and one pass serves every word: no quote is scanned for twice.
function curlQuoteClosers(text) {
  const n = text.length;
  const next = new Int32Array(n + 1);
  next[n] = -1;
  let run = 0;
  const closes = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (text[i] === '"' && run % 2 === 0) closes[i] = 1;
    run = text[i] === '\\' ? run + 1 : 0;
  }
  for (let i = n - 1; i >= 0; i--) next[i] = closes[i] ? i : next[i + 1];
  return next;
}

// Whether curl's -F parser, under grammar `g`, opens a secret file for the
// value `text` (formparse, get_param_part and get_param_word, ported): a file
// of an `@` list, a `<` file, or a `headers=@` / `headers=<` file. Each
// character is read a bounded number of times.
function curlFormOpensSecret(text, g, closers) {
  const n = text.length;
  const at = (k) => (k < n ? text[k] : '');
  // get_param_word: [value, index it stops at, quoted]. A word starting with
  // `"` that a later quote closes is quoted (its trailing data, up to `;` or
  // the end character, is skipped); otherwise it runs to `;` or the end
  // character, quote and all.
  function word(p, endchar) {
    if (text[p] === '"' && closers && closers[p + 1] !== -1) {
      const close = closers[p + 1];
      let k = close + 1;
      while (k < n && text[k] !== ';' && text[k] !== endchar) k++;
      return [text.slice(p + 1, close).replace(/\\([\\"])/g, '$1'), k, true];
    }
    let k = p;
    while (k < n && text[k] !== ';' && text[k] !== endchar) k++;
    return [text.slice(p, k), k, false];
  }
  // An unquoted word loses its trailing blanks.
  function value(w) {
    if (w[2]) return w[0];
    let e = w[0].length;
    while (e > 0 && g.blank(w[0][e - 1])) e--;
    return w[0].slice(0, e);
  }
  function skipBlanks(p) {
    while (p < n && g.blank(text[p])) p++;
    return p;
  }
  function hasPrefix(p, s) {
    return text.slice(p, p + s.length).toLowerCase() === s;
  }
  // get_param_part: the part's data word, then its `;` parameters. Returns
  // { data, sep, end }, { hit } when a headers file is a secret, or { failed }
  // when curl refuses the part (no file of it is opened).
  function part(p, endchar) {
    const d = word(skipBlanks(p), endchar);
    const data = value(d);
    p = d[1];
    let sep = at(p);
    let inType = false;
    while (sep === ';') {
      p = skipBlanks(p + 1);
      if (!inType && hasPrefix(p, 'type=')) {
        p = skipBlanks(p + 5);
        if (g.sscanfType) {
          const major = p;
          while (p < n && p - major < 127 && text[p] !== '/' && text[p] !== ' ') p++;
          if (p === major || text[p] !== '/') return { failed: true };
          // The minor's 127-character cut moves nothing: curl goes on from it
          // to the same `;` or end character, which the minor's own stop set
          // holds, so only an empty minor differs.
          p++;
          if (p === n || ';, \n'.includes(text[p])) return { failed: true };
          while (p < n && text[p] !== ';' && text[p] !== endchar) p++;
        } else {
          while (p < n && !CURL_TYPE_TSPECIALS.includes(text[p])) p++;
        }
        inType = true;
      } else if (hasPrefix(p, 'filename=') || hasPrefix(p, 'encoder=')) {
        inType = false;
        p = word(skipBlanks(p + (text[p] === 'f' || text[p] === 'F' ? 9 : 8)), endchar)[1];
      } else if (hasPrefix(p, 'headers=')) {
        inType = false;
        p += 8;
        if (text[p] === '@' || text[p] === '<') {
          const w = word(skipBlanks(p + 1), endchar);
          if (curlNameIsSecret(value(w))) return { hit: true };
          p = w[1];
        } else {
          p = word(skipBlanks(p), endchar)[1];
        }
      } else if (inType) {
        while (p < n && text[p] !== ';' && text[p] !== endchar) p++;
      } else {
        p = word(p, endchar)[1];
      }
      sep = at(p);
    }
    return { data, sep, end: p };
  }

  const eq = text.indexOf('=');
  if (eq === -1) return false;
  let p = eq + 1;
  if (text[p] === '@') {
    for (;;) {
      const r = part(p + 1, ',');
      if (r.hit) return true;
      if (r.failed) return false;
      if (curlNameIsSecret(r.data)) return true;
      if (r.sep === '') return false;
      p = r.end;
    }
  }
  if (text[p] === '<') {
    const r = part(p + 1, '');
    return r.hit === true || (!r.failed && curlNameIsSecret(r.data));
  }
  return part(p, '').hit === true;
}

const CURL_VARIABLE_FILE_RE = /^%?[A-Za-z0-9_]+(?:\[[0-9]*-[0-9]*\])?@/;

// Whether a curl option outside -F reads a secret file from the value `v`:
// after a leading `@` (-d and the other --data forms, --json, -H, -w,
// --url), after the first `@` when the value holds no `=` (--data-urlencode,
// --url-query), after `name@` or `name[range]@` (--variable), or after
// `ecl:@` (--ech). The name is the rest of the value, unchanged.
function curlAtValueOpensSecret(v) {
  if (v[0] === '@' && curlNameIsSecret(v.slice(1))) return true;
  const a = v.indexOf('@');
  if (a !== -1 && v.indexOf('=') === -1 && curlNameIsSecret(v.slice(a + 1))) return true;
  const m = CURL_VARIABLE_FILE_RE.exec(v);
  if (m && curlNameIsSecret(v.slice(m[0].length))) return true;
  return v.startsWith('ecl:@') && curlNameIsSecret(v.slice(5));
}

// curl opens a file named inside an option value as well as one given as its own
// `@file` word (#5779): `-d@f`, `-H@f`, `--data-urlencode name@f`, `--variable
// name@f`, `-F name=@f`, `-F name=<f`, `-F 'k=v;headers=@f'`. Holding no table of
// curl's options, the guard reads each curl argument both as a -F value, under
// every grammar curl has shipped, and as a value of the options that read `@file`.
// A value attached to short options (`-d@f`, `-sd@f`, `-Fk=@f`) needs no reading of
// its own: option letters hold no `=` or `@`, and where an `=` stops the first-`@`
// reading (`-d@a=b/f`), the file's last path segment is the word's, judged as every
// operand is. curl 8.23's `--option=value` is read the same way after the `--name=`
// (`--form=k=@f`), and as the whole word. The cost is a fail-safe denial where a
// word is read another way than its option gives it (`-d k=@.env`, a URL's `user@`
// part, `--form-string f=@.env`, `--data-urlencode n=@.env`), pinned in tests. A
// value the shell builds when it runs the line, from a variable, a command
// substitution or a glob (`curl -d @$f`, `curl -T .e*`), is judged as written, as
// every operand is (Documented gaps).
function curlValueNamesSecret(text) {
  const option = CURL_LONG_OPTION_RE.exec(text);
  return curlWordNamesSecret(text) || (option !== null && curlWordNamesSecret(text.slice(option[0].length)));
}

const CURL_LONG_OPTION_RE = /^--[A-Za-z0-9-]+=/;

function curlWordNamesSecret(text) {
  const closers = text.includes('"') ? curlQuoteClosers(text) : null;
  for (const g of CURL_FORM_GRAMMARS) {
    if (curlFormOpensSecret(text, g, closers)) return true;
  }
  return curlAtValueOpensSecret(text);
}

// curl's --cert (-E) and --proxy-cert take `file:password`. Unlike the values
// above, a `file:password` reading would find a file in data curl sends
// (`-d 'mount=/app/.env:ro'`) or in a URL, so it is applied only to the value
// of one of those options: the word after `--cert`, `--proxy-cert` or a short
// cluster ending in `E` (`-E`, `-sE`, `-#E`), the rest of a cluster after its
// `E` (`-Ef:pw`, `-s#Ef:pw`), or the part after `=` (`--cert=f:pw`, 8.23).
// Every prefix of either long name shorter than the name is ambiguous with
// `--cert-type` / `--proxy-cert-type` where curl takes abbreviations (8.5).
// curl reads `--expand-<option>` as `<option>`, so `--expand-cert` is one too,
// and through 8.5 it matched long names in any case (`--CERT`).
const CURL_CERT_OPTIONS = new Set(['--cert', '--proxy-cert']);
const CURL_CERT_CLUSTER_RE = /^-[A-Za-z0-9#:]*?E/;

function isCurlCertOption(name) {
  const n = name.toLowerCase();
  return CURL_CERT_OPTIONS.has(n.startsWith('--expand-') ? '--' + n.slice(9) : n);
}

// The value a cert option holds within `text`, or null.
function curlAttachedCertValue(text) {
  const eq = text.indexOf('=');
  if (eq !== -1 && isCurlCertOption(text.slice(0, eq))) return text.slice(eq + 1);
  const m = CURL_CERT_CLUSTER_RE.exec(text);
  return m && m[0].length < text.length ? text.slice(m[0].length) : null;
}

// Whether `text` is a cert option whose value is the next word.
function curlTakesCertValue(text) {
  if (isCurlCertOption(text)) return true;
  const m = CURL_CERT_CLUSTER_RE.exec(text);
  return m !== null && m[0].length === text.length;
}

// The file a cert value names, read as curl's parse_cert_parameter
// (src/tool_getparam.c) reads it: up to the first `:` not escaped by `\`, with
// `\:` and `\\` standing for `:` and `\`, and a `pkcs11:` URI kept whole. On
// Windows a drive letter's colon (`C:\f:pw`) is part of the name; the guard
// does not know the platform, so it judges both names.
function curlCertNamesSecret(v) {
  if (/^pkcs11:/i.test(v)) return curlNameIsSecret(v);
  let name = '';
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === '\\') {
      const next = v[i + 1];
      if (next === undefined) {
        name += '\\';
      } else {
        name += next === '\\' || next === ':' ? next : '\\' + next;
        i++;
      }
    } else if (ch !== ':') {
      name += ch;
    } else if (i === 1 && (v[2] === '\\' || v[2] === '/') && /[A-Za-z]/.test(v[0])) {
      if (curlNameIsSecret(name)) return true;
      name += ':';
    } else {
      break;
    }
  }
  return curlNameIsSecret(name);
}

// Whether curl, given words[k] as an argument, opens a secret through a cert
// option's value in it or in the word before it.
function curlCertOpensSecret(words, k) {
  let v = curlAttachedCertValue(words[k].text);
  if (v === null && k > 0 && curlTakesCertValue(words[k - 1].text)) v = words[k].text;
  return v !== null && curlCertNamesSecret(v);
}

// find's actions that run the words after them, up to `;` (or `+` after
// `{}`), as a command. bfs takes find's actions.
const FIND_EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FIND_COMMANDS = new Set(['find', 'gfind', 'find.exe', 'bfs']);
const XARGS_COMMANDS = new Set(['xargs', 'gxargs', 'xargs.exe']);

// Commands whose documented job is to run another command, other than the
// wrappers resolveCommand unwraps and xargs/find, whose command position is
// read exactly. Their options differ per command, so under them curl's
// arguments start after the first operand whose last segment is curl, as for
// every command before #5779's review narrowed the rule to commands that run
// curl. A command that runs one only through a subcommand or an option
// (`uv run`, `kubectl exec`, `docker compose exec`, `fd -x`) names those
// words, and a curl word counts only after one of them: `uv pip install curl …`
// runs no curl. A subcommand counts only as the command's first operand (or
// first two, `compose exec`) past its options, so `kubectl get exec curl …`
// runs none; an option's run word counts anywhere. Keys are matched without a
// Windows `.exe`, `.cmd` or `.bat` suffix (`docker.exe`, `npx.cmd`).
const CURL_WORD_LAUNCHERS = new Map([
  // Run their operands as a command.
  ...[
    // process, scheduling, privilege and namespace runners
    'watch', 'ionice', 'taskset', 'chrt', 'flock', 'nsenter', 'unshare', 'chroot', 'gchroot',
    'runuser', 'setpriv', 'pkexec', 'run0', 'gosu', 'su-exec', 'systemd-run',
    'systemd-inhibit', 'systemd-nspawn', 'bwrap', 'flatpak-spawn', 'prlimit',
    'numactl', 'cpulimit', 'setarch', 'arch', 'caffeinate', 'sandbox-exec', 'chpst',
    'tini', 'dumb-init', 'faketime', 'eatmydata', 'unbuffer', 'chronic',
    'catchsegv', 'xvfb-run', 'wsl', 'wine',
    // tracers, debuggers and profilers
    'strace', 'ltrace', 'valgrind', 'heaptrack',
    // job runners and file-event runners
    'parallel', 'sem', 'entr', 'busybox',
    // network wrappers
    'torsocks', 'torify', 'tsocks', 'proxychains', 'proxychains4', 'trickle',
    'firejail',
    // package runners that take the command as their operands
    'npx', 'bunx', 'uvx',
  ].map((name) => [name, null]),
  // Run a command only after one of these words.
  ['gdb', new Set(['--args', '-args'])],
  ['perf', new Set(['record', 'stat', 'trace'])],
  ['rr', new Set(['record'])],
  ['fd', new Set(['-x', '--exec', '-X', '--exec-batch'])],
  ['fdfind', new Set(['-x', '--exec', '-X', '--exec-batch'])],
  ['pueue', new Set(['add'])],
  ['scl', new Set(['enable'])],
  ['toolbox', new Set(['run'])],
  ['distrobox', new Set(['enter'])],
  // Container runners: a word pair is a subcommand group's subcommand.
  ...['docker', 'podman', 'nerdctl'].map((name) => [name, new Set([
    'exec', 'run', 'compose exec', 'compose run', 'container exec', 'container run',
    ...(name === 'podman' ? ['unshare'] : []),
  ])]),
  ['docker-compose', new Set(['exec', 'run'])],
  ['podman-compose', new Set(['exec', 'run'])],
  ['lxc', new Set(['exec'])],
  ['incus', new Set(['exec'])],
  ['kubectl', new Set(['exec', 'run', 'debug', 'alpha debug'])],
  ['oc', new Set(['exec', 'run', 'debug', 'alpha debug', 'rsh'])],
  ['dotenv', new Set(['run', '--'])],
  ['dotenvx', new Set(['run'])],
  ['op', new Set(['run'])],
  ['doppler', new Set(['run'])],
  ['infisical', new Set(['run'])],
  ['aws-vault', new Set(['exec'])],
  ['direnv', new Set(['exec'])],
  ['mise', new Set(['exec', 'x'])],
  ['asdf', new Set(['exec'])],
  ['npm', new Set(['exec', 'x'])],
  ['pnpm', new Set(['exec', 'dlx'])],
  // `yarn workspace <name> exec` names a workspace before the run word, so the
  // group word itself counts; `workspaces foreach` runs a command in each.
  ['yarn', new Set(['exec', 'dlx', 'workspace', 'workspaces foreach'])],
  ['bun', new Set(['x'])],
  ['uv', new Set(['run', 'tool run'])],
  ['poetry', new Set(['run'])],
  ['pipenv', new Set(['run'])],
  ['pdm', new Set(['run'])],
  ['hatch', new Set(['run', 'env run'])],
  ['rye', new Set(['run'])],
  ['pixi', new Set(['run', 'exec'])],
  ['pipx', new Set(['run'])],
  ['conda', new Set(['run'])],
  ['mamba', new Set(['run'])],
  ['micromamba', new Set(['run'])],
  ['bundle', new Set(['exec'])],
  ['nix', new Set(['run', 'shell', 'develop'])],
]);

// Which operands curl takes as its arguments (#5779): every one when curl is
// the segment's command, and those after a curl that a launcher runs as a
// command — xargs's sub-command, or the command of a find -exec / -execdir /
// -ok / -okdir action, each past the wrappers resolveCommand unwraps
// (`xargs sudo curl …`) — and, under a CURL_WORD_LAUNCHERS command, those
// after its first curl word (`watch -n 5 curl …`), or after the first curl
// word past the word it runs a command by (`uv run curl …`). Only those
// operands get curl's value reading. A `curl` word anywhere else is an operand
// (`grep curl …`, `apt-get install curl …`), so the words after it are judged
// as before.
// Whether operand `k` is one of curl's arguments that opens a secret. The
// argument map is built once per operand list. A helper, not a local in
// scanCommand, so that function's stack frame stays next's size and the plain
// reading overflows, which denies a command as `command-too-complex`, at the
// depth next's does.
const curlArgumentsByOperands = new WeakMap();
function curlOperandOpensSecret(base, operands, k) {
  let args = curlArgumentsByOperands.get(operands);
  if (args === undefined) {
    args = curlArguments(base, operands);
    curlArgumentsByOperands.set(operands, args);
  }
  return Boolean(args[k]) && (curlValueNamesSecret(operands[k].text) || curlCertOpensSecret(operands, k));
}

function curlArguments(base, operands) {
  const marks = new Uint8Array(operands.length);
  markCurlArguments(base, operands, 0, operands.length, marks, 0);
  return marks;
}

// Marks words[from..to) when `base`, the command they belong to, is curl, and
// follows a launcher to the command it runs. Each level handles a range of the
// segment's words once, and MAX_NESTING_DEPTH bounds the levels.
function markCurlArguments(base, words, from, to, marks, depth) {
  if (CURL_COMMANDS.has(base)) {
    marks.fill(1, from, to);
    return;
  }
  if (depth >= MAX_NESTING_DEPTH) return;
  if (XARGS_COMMANDS.has(base)) {
    const sub = xargsCommandIndex(words, from, to);
    if (sub !== -1) markLaunchedCurl(words, sub, to, marks, depth + 1);
  } else if (CURL_WORD_LAUNCHERS.has(launcherKey(base))) {
    // Options differ per launcher, so the command is the first curl word,
    // after the subcommand or option, if any, that the launcher runs it by.
    const key = launcherKey(base);
    const start = launcherRunIndex(words, from, to, CURL_WORD_LAUNCHERS.get(key), LAUNCHER_PAIR_OPTIONS.get(key));
    if (start === -1) return;
    const container = CONTAINER_LAUNCHERS.has(key);
    for (let k = start; k < to; k++) {
      if (CURL_COMMANDS.has(launchedCurlName(words[k].text, container))) {
        marks.fill(1, k + 1, to);
        return;
      }
    }
  } else if (FIND_COMMANDS.has(base)) {
    for (let j = from; j < to; j++) {
      if (!FIND_EXEC_ACTIONS.has(words[j].text)) continue;
      let end = j + 1;
      while (end < to && !isFindExecEnd(words, end)) end++;
      markLaunchedCurl(words, j + 1, end, marks, depth + 1);
      j = end;
    }
  }
}

function launcherKey(base) {
  return base.replace(/\.(exe|cmd|bat)$/, '');
}

// Index of the first of words[from..to) that a launcher with `runWords` may
// run as a command, or -1. With no run words, every operand may be. Otherwise
// an option run word (`--args`, `-x`) counts anywhere, and a subcommand run
// word only as the first operand past the options, or the second after a
// subcommand group (`compose exec`). An operand right after an option with no
// `=` may be that option's value (`kubectl -n ns exec`), so the subcommand may
// still follow it; an option whose value is itself a run word
// (`docker --context run …`) is read as running a command, the safe side.
// `pairOptions` names the options that take two values (`nix --option k v`).
function launcherRunIndex(words, from, to, runWords, pairOptions) {
  if (runWords === null) return from;
  let group = '';
  let subcommand = true;
  let optionValues = 0;
  for (let k = from; k < to; k++) {
    const t = words[k].text;
    if (t.length > 1 && t[0] === '-') {
      if (runWords.has(t)) return k + 1;
      optionValues = pairOptions && pairOptions.has(t) ? 2 : t.includes('=') ? 0 : 1;
      continue;
    }
    if (!subcommand) continue;
    const sub = group + t;
    if (runWords.has(sub)) return k + 1;
    if (isRunWordGroup(runWords, sub)) {
      group = sub + ' ';
      optionValues = 0;
    } else if (optionValues > 0) {
      optionValues--;
    } else {
      subcommand = false;
    }
  }
  return -1;
}

function isRunWordGroup(runWords, sub) {
  for (const w of runWords) {
    if (w.length > sub.length && w[sub.length] === ' ' && w.startsWith(sub)) return true;
  }
  return false;
}

// Launcher options that take two values, so two operands after one may be
// its values rather than the subcommand.
const LAUNCHER_PAIR_OPTIONS = new Map([
  ['nix', new Set(['--option', '--arg', '--argstr', '--override-input', '--override-flake'])],
]);

// Container runners: an operand may be an image, `--entrypoint=` names the
// command, and kubectl's and oc's `--image=` names the image they run.
const CONTAINER_LAUNCHERS = new Set(['docker', 'podman', 'nerdctl', 'docker-compose', 'podman-compose', 'kubectl', 'oc']);
const CONTAINER_VALUE_PREFIXES = ['--entrypoint=', '--image='];

// A launched command word's name. Under a container runner the value of
// `--entrypoint=` or `--image=` counts as the word, and an image reference
// (a word with a `/` repository path) loses its `:tag` or `@digest`
// (`docker run curlimages/curl:8.5.0 …`, `kubectl run t
// --image=curlimages/curl:8.5.0 -- …` run curl). Any other word is read whole
// (`scp curl@host:f` names no curl).
function launchedCurlName(text, container) {
  if (!container) return commandName(text);
  const prefix = CONTAINER_VALUE_PREFIXES.find((p) => text.startsWith(p));
  const word = prefix ? text.slice(prefix.length) : text;
  const name = commandName(word);
  if (!word.includes('/')) return name;
  const cut = name.search(/[:@]/);
  return cut > 0 ? name.slice(0, cut) : name;
}

// `;` ends a find action's command, and so does `+` right after `{}`.
function isFindExecEnd(words, k) {
  const t = words[k].text;
  return t === ';' || (t === '+' && words[k - 1].text === '{}');
}

// words[from..to) is a command a launcher runs: find its command word past the
// wrappers resolveCommand unwraps, and mark that command's arguments.
function markLaunchedCurl(words, from, to, marks, depth) {
  const c = launchedCommandIndex(words, from, to);
  if (c !== -1) markCurlArguments(commandName(words[c].text), words, c + 1, to, marks, depth);
}

// Index of the command word in words[from..to) that a launcher runs, past the
// wrappers resolveCommand unwraps and their own options, or -1. Unlike a
// shell, a launcher execs a leading `VAR=value` word, so none is skipped.
function launchedCommandIndex(words, from, to) {
  const wrappers = furtherReading ? FURTHER_WRAPPERS : WRAPPERS;
  const pending = words.slice(from, to).reverse();
  while (pending.length) {
    const spec = wrappers.get(commandName(pending[pending.length - 1].text));
    if (!spec) break;
    pending.pop();
    skipWrapperArgs(pending, spec, false);
  }
  return pending.length ? to - pending.length : -1;
}

// lastSegment(text).toLowerCase(), read by hand in one pass: lastSegment's
// trailing-separator regex backtracks on a long run of separators, and the
// launched-command words reach here.
function commandName(text) {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '/' || text[end - 1] === '\\')) end--;
  let seg = end;
  while (seg > 0 && text[seg - 1] !== '/' && text[seg - 1] !== '\\') seg--;
  return text.slice(seg, end).toLowerCase();
}

// #5825: request tools that open a file named after an `@` in a field or request item and send its contents.
//   gh api -F/--field key=@path   (`-f`/`--raw-field` never reads a file; `@-` is stdin)
//   http / https (httpie) items   key=@path  key:=@path  key==@path  Header:@path  key@path[;type=…]
// An httpie item splits at its first separator, so only an `@` form that comes first reads a file, and a key may
// escape a separator with a backslash. Linear in the word: the key run stops at the first separator character.
const HTTPIE_FILE_ITEM_RE = /^(?:[^=:@\\]|\\.)*(?:==@|:=@|=@|:@|@)([\s\S]+)$/;
// gh api short options that take a value: in a cluster the rest of the word is that option's value, not more flags.
const GH_VALUE_SHORT_FLAGS = 'HXqtpf';
const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'elif', '!', 'while', 'until', 'if']);

// `do gh api …`, `then http …`, `! gh api …`: the command word follows the shell keyword, so it is resolved again.
function skipShellKeywords(cmd) {
  let current = cmd;
  while (SHELL_KEYWORDS.has(current.base) && current.operands.length > 0) {
    const next = resolveCommand(current.operands);
    if (!next) break;
    current = next;
  }
  return current;
}

// How `-F` reaches a gh word: `{ value }` attached (`-Fk=v`, `-F=k=v`, a cluster `-iFk=v`), `{ value: null }` when the
// value is the next word (`-F`, `-iF`), or null when the word carries no `-F`. A manual scan, not a regex: the first
// `F` of a letter run decides, whatever follows it (a lazy pattern backtracked quadratically on a long run).
function ghFieldOption(text) {
  if (!text.startsWith('-') || text.startsWith('--')) return null;
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === 'F') {
      const rest = text.slice(i + 1);
      if (rest === '') return { value: null };
      return { value: rest.startsWith('=') ? rest.slice(1) : rest };
    }
    if (!CLUSTER_FLAG_CHAR_RE.test(ch) || GH_VALUE_SHORT_FLAGS.includes(ch)) return null;
  }
  return null;
}

// The text of the operand whose `@path` names a secret for `gh api` / httpie, or null. `base` is the resolved command word.
function requestItemSecretRead(base, operands) {
  const command = base.replace(/\.exe$/i, '');
  if (command === 'gh' && operands.length > 0 && operands[0].text === 'api') {
    for (let k = 1; k < operands.length; k++) {
      const text = operands[k].text;
      let field = null;
      if (text === '--field') field = operands[k + 1] ? operands[k + 1].text : null;
      else if (text.startsWith('--field=')) field = text.slice('--field='.length);
      else {
        const option = ghFieldOption(text);
        if (option) field = option.value !== null ? option.value : (operands[k + 1] ? operands[k + 1].text : null);
      }
      if (field === null) continue;
      const eq = field.indexOf('=');
      if (eq === -1) continue;
      const value = field.slice(eq + 1);
      if (value.startsWith('@') && value !== '@-' && namesSecretVariant(value.slice(1))) return text;
    }
    return null;
  }
  if (command === 'http' || command === 'https') {
    // `http [METHOD] URL [ITEM…]`: the URL is not an item (`http example.com/a@.env` reads nothing).
    const positionals = operands.filter((operand) => !operand.text.startsWith('-'));
    const urlIndex = positionals.length > 0 && /^[A-Za-z]+$/.test(positionals[0].text) ? 1 : 0;
    positionals.forEach((operand, index) => {
      if (index === urlIndex) operand.isUrl = true;
    });
    for (const operand of positionals) {
      if (operand.isUrl) continue;
      const item = HTTPIE_FILE_ITEM_RE.exec(operand.text);
      // `file@path;type=mime` and `;filename=` follow the path after a `;`: both readings are judged.
      if (item && (namesSecretVariant(item[1]) || namesSecretVariant(item[1].split(';')[0]))) return operand.text;
    }
  }
  return null;
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
// The further reading's prefix assignment: bash and zsh also take `NAME+=value`
// and a subscripted `NAME[sub]=value` / `NAME[sub]+=value` in front of a command
// and run the command. A subscript may hold brackets (`a[b[1]]=x`), so the
// bracket span is greedy; one word, so the span ends inside it. bash keeps a
// subscript's blanks in the word (`a[x y]=1`): the tokenizer's `[` branch
// joins those under this reading (subscriptClose).
const FURTHER_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[\s\S]*\])?\+?=/;

// `-c`, or a combined short flag ending in `c` (`-lc`, `-ec`, `-euc`): mode c.
const DASH_C_RE = /^-[A-Za-z]*c$/;

const GROUPING_SEPS = new Set(['(', ')', '{', '}']);

// Reserved words that may stand before a command (and so before a `{` group) in the same segment.
const RESERVED_BEFORE_COMMAND = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']);
// Command words that take a compound body after words of their own, so a `{` after them may still open a group.
// A compound command's closer (`esac`, `fi`, `done`, `end`) at the head of a segment ends a zsh `while` condition, so a `{` after it is the body.
const COMPOUND_BODY_HEADS = new Set(['function', 'coproc', 'time', 'for', 'foreach', 'select', 'repeat', 'case', 'always', '[[', 'esac', 'fi', 'done', 'end']);
// Reserved words that introduce a condition, after which zsh takes a `{` body instead of `then`/`do`.
const CONDITION_WORDS = new Set(['if', 'elif', 'while', 'until']);
// A word that sets a variable before a command (`A=1`, `a[0]+=x`).
const ASSIGNMENT_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

// How many words the option `word` occupies for wrapper `spec`: 2 when it
// takes a separate value word, else 1.
function wrapperOptionWidth(word, spec) {
  if (word.startsWith('--')) {
    if (word.includes('=')) return 1;
    // getopt_long takes an exact match over any longer option it prefixes
    // (`sudo --login` is not `--login-class`), else any unambiguous prefix (`--adj 5`).
    if ((spec.flags || []).includes(word)) return 1;
    return word.length > 2 && (spec.long || []).some((l) => l.startsWith(word)) ? 2 : 1;
  }
  const valued = spec.short || '';
  for (let i = 1; i < word.length; i++) {
    if (valued.includes(word[i])) return i === word.length - 1 ? 2 : 1; // `-n5` carries its value
  }
  return 1;
}

// #5514: when `word` is the wrapper's split option (env's `-S` /
// `--split-string`), the string it carries, or null when the string is the
// next word; undefined for any other word.
function splitOptionValue(word, spec) {
  if (!spec.split) return undefined;
  if (word.startsWith('--')) {
    const eq = word.indexOf('=');
    const name = eq === -1 ? word : word.slice(0, eq);
    if (name.length <= 2 || !spec.split.long.startsWith(name)) return undefined;
    return eq === -1 ? null : word.slice(eq + 1);
  }
  const valued = spec.short || '';
  for (let i = 1; i < word.length; i++) {
    if (!valued.includes(word[i])) continue;
    if (word[i] !== spec.split.short) return undefined; // the value of another option
    return i === word.length - 1 ? null : word.slice(i + 1);
  }
  return undefined;
}

const ENV_S_ESCAPES = { f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
const ENV_S_BLANKS = ' \t\n\v\f\r';
const ENV_S_VAR_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/y;

// The words `env -S STRING` splits STRING into, by GNU env's rules rather than
// the shell's: blanks separate outside quotes; single quotes keep everything but
// `\\` and `\'`; outside them `\_` separates (a space inside double quotes),
// `\c` ends the string, `\f \n \r \t \v` are those characters and
// `\" \# \$ \' \\` the character itself; `#` starting a word starts a comment;
// `${VAR}` outside single quotes is env's own expansion, of a value not known
// here: kept as written, or under `vars: 'drop'` deleted, as an unset name
// expands (no word of its own, and a `#` after it still starts a comment).
// Under `escapes: 'bsd'` a backslash before a blank is that blank; under
// 'uutils' a backslash before a newline is removed, inside quotes too, and a
// comment runs to the next newline, after which splitting goes on. Where env
// would reject the string, the words read up to that point are returned.
function splitEnvString(value, dialect = envSReading) {
  const words = [];
  let word = '';
  let inWord = false;
  let quote = '';
  const end = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (dialect.escapes === 'uutils' && ch === '\\' && value[i + 1] === '\n') {
      i++;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = '';
      else if (ch === '\\' && (value[i + 1] === '\\' || value[i + 1] === "'")) word += value[++i];
      else word += ch;
      continue;
    }
    if (ch === '"' || (ch === "'" && quote === '')) {
      quote = quote === ch ? '' : ch;
      inWord = true;
      continue;
    }
    if (quote === '' && ENV_S_BLANKS.includes(ch)) {
      end();
      continue;
    }
    if (quote === '' && ch === '#' && !inWord) {
      if (dialect.escapes !== 'uutils') break;
      const eol = value.indexOf('\n', i);
      if (eol === -1) break;
      i = eol;
      continue;
    }
    if (ch === '$' && value[i + 1] !== '{') break;
    if (ch === '$' && dialect.vars === 'drop') {
      ENV_S_VAR_RE.lastIndex = i;
      if (ENV_S_VAR_RE.test(value)) {
        i = ENV_S_VAR_RE.lastIndex - 1;
        continue;
      }
    }
    if (ch === '\\') {
      const next = value[++i];
      if (next === '_' && quote === '') {
        end();
        continue;
      }
      if (next === '_') word += ' ';
      else if (next !== undefined && ENV_S_ESCAPES[next]) word += ENV_S_ESCAPES[next];
      else if (next !== undefined && '"#$\'\\'.includes(next)) word += next;
      else if (dialect.escapes === 'bsd' && next !== undefined && ENV_S_BLANKS.includes(next)) word += next;
      else break; // `\c`, or an escape env rejects
      inWord = true;
      continue;
    }
    word += ch;
    inWord = true;
  }
  end();
  return words;
}

// Pushes the words `value` splits into onto `pending`, to be read next. A
// string split out of a split string is one level deeper; past
// MAX_NESTING_DEPTH it is not read, and splitTooDeep makes the command deny.
function pushSplitWords(pending, value, source) {
  const depth = (source.splitDepth || 0) + 1;
  if (depth > MAX_NESTING_DEPTH) {
    splitTooDeep = true;
    return;
  }
  const words = splitEnvString(value);
  for (let k = words.length - 1; k >= 0; k--) {
    pending.push({ kind: 'word', text: words[k], quoted: 'none', seg: source.seg, splitDepth: depth });
  }
}

// Pops a wrapper's own options, assignments and positional operands
// (`-n 5`, `-i A=1`, `-s KILL 5`, `--`) off `pending`, the words still to
// read with the next one last. The walk is the one before #5514, with one
// addition: `env -S STRING` puts the words STRING splits into where the option
// stood, and env goes on reading options (#5514).
// `splitting` is false for a walk that must keep word indices (launchedCommandIndex).
function skipWrapperArgs(pending, spec, splitting = envSReading.split) {
  if (spec.count) {
    pending.pop();
    return;
  }
  const top = () => pending[pending.length - 1].text;
  const assigns = spec.assigns === true ? ASSIGNMENT_RE : spec.assigns;
  let previous = null; // the word popped last (dashDashEndsAssigns)
  const pop = () => {
    const word = pending.pop();
    if (word) previous = word.text;
    return word;
  };
  let optionsEnded = false;
  while (pending.length) {
    const text = top();
    if (assigns && !(spec.dashDashEndsAssigns && previous === '--') && assigns.test(text)) {
      pop();
    } else if (spec.dash && text === '-') {
      pop();
    } else if (!optionsEnded && text === '--') {
      optionsEnded = true;
      pop();
    } else if (!optionsEnded && text.length > 1 && text.startsWith('-')) {
      const word = pop();
      const split = splitOptionValue(text, spec);
      if (split !== undefined) splitSeen = true;
      if (split === undefined || !splitting) {
        if (wrapperOptionWidth(text, spec) === 2) pop();
      } else if (split === null) {
        const value = pop();
        if (value) pushSplitWords(pending, value.text, value);
      } else {
        pushSplitWords(pending, split, word);
      }
    } else {
      break;
    }
  }
  for (let n = 0; n < (spec.operands || 0) && pending.length; n++) pending.pop();
  // `timeout 5 -- cmd`: some getopt builds still accept `--` after DURATION.
  if (spec.operands && pending.length && top() === '--') pending.pop();
}

// Pops the words in front of a command off `pending`: `VAR=val` assignments and,
// under the further reading, the reserved words in front of them and the wider
// assignment forms (`A+=b`, `a[0]=x`).
function skipShellPrefixes(pending) {
  if (furtherReading) pending.length -= reservedWordCount(pending);
  const assignment = furtherReading ? FURTHER_ASSIGNMENT_RE : ASSIGNMENT_RE;
  while (pending.length && assignment.test(pending[pending.length - 1].text)) pending.pop();
}

// How many words from the top of `pending` (the next word last) are reserved
// words a command can follow.
function reservedWordCount(pending) {
  const at = (p) => pending[pending.length - 1 - p];
  let p = 0;
  while (p < pending.length && at(p).quoted === 'none') {
    const text = at(p).text;
    if (SHELL_COMMAND_KEYWORDS.has(text)) {
      p++;
    } else if (LOOP_HEADS.has(text)) {
      const body = bareWordPosition(pending, p + 2, 'do', 'in');
      if (body === -1) break;
      p = body + 1;
    } else if (text === '[[') {
      // zsh's short form runs the word after the test: `if [[ x ]] cmd`.
      const close = bareWordPosition(pending, p + 1, ']]');
      if (close === -1) break;
      p = close + 1;
    } else {
      break;
    }
  }
  return p;
}

// Position from the top of `pending` of the first unquoted `text` from `start`,
// or -1, or -1 at a `stop` first.
function bareWordPosition(pending, start, text, stop) {
  for (let p = start; p < pending.length; p++) {
    const word = pending[pending.length - 1 - p];
    if (word.quoted !== 'none') continue;
    if (word.text === text) return p;
    if (word.text === stop) return -1;
  }
  return -1;
}

// Command base + operands after leading `VAR=val` assignments and prefix
// wrappers with their own options (`sudo -u root`, `env -i VAR=x`,
// `timeout -s KILL 5`, `nice -n 5`, `env -S 'cmd …'`, …), or null when nothing
// but prefixes remain. Linear in the words read: a split string is pushed onto
// the pending stack rather than spliced into a copy of the list. `word` is the
// command word as written: after a split string it can be one of that string's
// words, which `words` does not hold.
function resolveCommand(words) {
  const wrappers = furtherReading ? FURTHER_WRAPPERS : WRAPPERS;
  const pending = words.slice().reverse();
  skipShellPrefixes(pending);
  while (pending.length) {
    const spec = wrappers.get(lastSegment(pending[pending.length - 1].text).toLowerCase());
    if (!spec) break;
    pending.pop();
    skipWrapperArgs(pending, spec);
    if (spec.keyword) skipShellPrefixes(pending);
  }
  if (!pending.length) return null;
  const head = pending.pop();
  return { base: lastSegment(head.text).toLowerCase(), operands: pending.reverse(), word: head.text };
}

/**
 * Rescan only the command-valued -c keys selected by #5045. This deliberately
 * does not resolve config files, --config-env/GIT_CONFIG_* values, or other
 * executing keys (diff drivers, filters, credential helpers, ssh, gpg).
 * Those are documented gaps, not a promise of complete Git config analysis.
 * Global option values and subcommand arguments are data, not more -c flags.
 */
function scanGitConfig(operands, depth) {
  for (const config of walkGitGlobals(operands).configs) {
    const eq = config.indexOf('=');
    if (eq === -1) continue;
    const key = config.slice(0, eq).toLowerCase();
    const value = config.slice(eq + 1);
    let script;
    if (key.startsWith('alias.') && value.startsWith('!')) script = value.slice(1);
    else if (key === 'diff.external') script = value;
    else continue;
    const hit = findSecretRead(script, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// Operand indices the segment's command consumes as a NAME, never as
// CONTENTS (#4639, #4856). Only these positions skip the operand check;
// every other operand is still checked, so a carve-out cannot launder a read
// elsewhere in the segment.
function nameOnlyOperandIndices(base, operands) {
  if (CONTAINER_RUNTIMES.has(base)) return envFileValueIndices(operands);
  if (base === 'git') return gitPathspecIndices(operands);
  if (base === 'cp' || base === 'mv') return copyDestinationIndices(operands);
  if (SEARCH_TOOLS.has(base)) return searchOperandIndices(SEARCH_TOOLS.get(base), operands);
  if (base === 'xargs') return xargsSearchIndices(operands);
  return new Set();
}

// #5884: grep-family, ripgrep and jq command lines. Their pattern or program
// (the first positional when no option supplied one), and the value of an
// exclusion option, are a regular expression, code, or a name to skip, never a
// file the command opens. Each spec is the command's own option vocabulary
// (grep(1) GNU and BSD, rg(1), jq(1)): an option in none of its sets withdraws
// the whole carve-out for the segment, because an unknown option may take a
// value, and an option value mistaken for the pattern would turn the real
// pattern, or a file, into the exempt operand.
//   noShort / valueShort / patternShort: short option letters without a value,
//     with a value, and with a value that IS the pattern or program (`-e`, `-f`).
//   nameShort: short letters whose value is a name to skip (`rg -g`).
//   noLong / valueLong (name -> operand count) / patternLong / nameLong: the
//     same for long options; optionalLong may carry `=value` or none.
//   digits: grep's `-NUM` context count may be bundled in a short cluster.
// A pattern FILE (`-f`, `--file`, `--from-file`) is read by the command, so its
// value is never exempt: it is classified as an ordinary operand.
const GREP_SPEC = {
  noShort: new Set('EFGPiyvwxcLloqsbHhnTZzaIrRUuVOpS'),
  // `-C` / `--context` are not listed: BSD grep (macOS) takes an OPTIONAL
  // number, so `grep -C 3 .env` there reads `.env` with pattern `3`, and a
  // required-value reading would exempt `.env` as the pattern.
  valueShort: new Set('mABdD'),
  patternShort: new Set('ef'),
  nameShort: new Set(),
  noLong: new Set([
    'extended-regexp', 'fixed-strings', 'basic-regexp', 'perl-regexp', 'ignore-case', 'no-ignore-case',
    'invert-match', 'word-regexp', 'line-regexp', 'count', 'files-without-match', 'files-with-matches',
    'only-matching', 'quiet', 'silent', 'no-messages', 'byte-offset', 'with-filename', 'no-filename',
    'initial-tab', 'null', 'null-data', 'text', 'recursive', 'dereference-recursive', 'line-number',
    'line-buffered', 'unix-byte-offsets', 'no-group-separator', 'help', 'version', 'binary', 'mmap',
  ]),
  valueLong: new Map([
    ['max-count', 1], ['after-context', 1], ['before-context', 1], ['devices', 1],
    ['directories', 1], ['binary-files', 1], ['label', 1], ['group-separator', 1],
    // `--include` selects the files to search, so `--include=.env` READS `.env`:
    // its value stays an ordinary operand, like `--exclude-from`.
    ['exclude-from', 1], ['include-dir', 1], ['include', 1],
  ]),
  optionalLong: new Set(['color', 'colour']),
  patternLong: new Set(['regexp', 'file']),
  nameLong: new Set(['exclude', 'exclude-dir']),
  negatedLong: new Set(),
  digits: true,
};
const RG_SPEC = {
  noShort: new Set('iSsnNlcowxvuUFHIPzabqp0.'),
  valueShort: new Set('mABCjMrtTEd'),
  patternShort: new Set('ef'),
  // `-g` / `--glob` / `--iglob` take a glob that SELECTS files unless it starts
  // with `!`, so only a negated value is a name to skip (`rg -g .env` reads it).
  nameShort: new Set('g'),
  noLong: new Set([
    'ignore-case', 'case-sensitive', 'smart-case', 'line-number', 'no-line-number', 'files-with-matches',
    'files-without-match', 'count', 'only-matching', 'word-regexp', 'line-regexp', 'invert-match',
    'fixed-strings', 'hidden', 'no-ignore', 'unrestricted', 'text', 'binary', 'multiline', 'heading',
    'no-heading', 'with-filename', 'no-filename', 'column', 'json', 'no-messages', 'quiet', 'stats',
    'vimgrep', 'null', 'follow', 'pcre2', 'pretty', 'trim', 'help', 'version', 'no-config',
  ]),
  valueLong: new Map([
    ['max-count', 1], ['after-context', 1], ['before-context', 1], ['context', 1], ['threads', 1],
    ['max-columns', 1], ['replace', 1], ['type', 1], ['type-not', 1], ['encoding', 1], ['max-depth', 1],
    ['sort', 1], ['sortr', 1], ['colors', 1], ['path-separator', 1], ['ignore-file', 1], ['pre', 1],
  ]),
  optionalLong: new Set(['color']),
  patternLong: new Set(['regexp', 'file']),
  nameLong: new Set(),
  negatedLong: new Set(['glob', 'iglob']),
  digits: false,
};
const JQ_SPEC = {
  noShort: new Set('nrjascCMSeRhV'),
  valueShort: new Set('L'),
  patternShort: new Set('f'),
  nameShort: new Set(),
  noLong: new Set([
    'null-input', 'raw-input', 'slurp', 'compact-output', 'raw-output', 'join-output', 'ascii-output',
    'color-output', 'monochrome-output', 'sort-keys', 'tab', 'exit-status', 'seq', 'stream',
    'stream-errors', 'unbuffered', 'binary', 'args', 'jsonargs', 'help', 'version', 'raw-output0',
  ]),
  // `--arg NAME VALUE` takes two operands; `--slurpfile` / `--rawfile` read the
  // file named by the second, which stays an ordinary operand.
  valueLong: new Map([
    ['indent', 1], ['library-path', 1], ['arg', 2], ['argjson', 2], ['slurpfile', 2], ['rawfile', 2],
  ]),
  optionalLong: new Set(),
  patternLong: new Set(['from-file']),
  nameLong: new Set(),
  negatedLong: new Set(),
  digits: false,
};
const SEARCH_TOOLS = new Map([
  ['grep', GREP_SPEC], ['egrep', GREP_SPEC], ['fgrep', GREP_SPEC], ['rg', RG_SPEC], ['jq', JQ_SPEC],
]);

// The operand indices that are a pattern, program or exclusion value; the empty
// set when any option is outside the spec (see above).
function searchOperandIndices(spec, operands) {
  const exempt = new Set();
  let patternSupplied = false;
  let firstPositional = -1;
  let endOfOptions = false;
  for (let k = 0; k < operands.length; k++) {
    const t = operands[k].text;
    if (endOfOptions || !t.startsWith('-') || t === '-') {
      if (firstPositional === -1) firstPositional = k;
    } else if (t === '--') {
      endOfOptions = true;
    } else if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq === -1 ? t.slice(2) : t.slice(2, eq);
      if (spec.nameLong.has(name)) {
        exempt.add(k);
        if (eq === -1) {
          if (k + 1 >= operands.length) return new Set();
          exempt.add(++k);
        }
      } else if (spec.negatedLong.has(name)) {
        // Exempt only a negated glob; a selecting glob is read like a file operand.
        if (eq !== -1) {
          if (t.startsWith('!', eq + 1)) exempt.add(k);
        } else {
          if (k + 1 >= operands.length) return new Set();
          if (operands[k + 1].text.startsWith('!')) exempt.add(k + 1);
          k++;
        }
      } else if (spec.patternLong.has(name)) {
        patternSupplied = true;
        if (eq === -1) k++;
      } else if (spec.valueLong.has(name)) {
        if (eq === -1) k += spec.valueLong.get(name);
      } else if (spec.optionalLong.has(name) || (eq === -1 && spec.noLong.has(name))) {
        // no operand of its own
      } else {
        return new Set();
      }
    } else {
      for (let i = 1; i < t.length; i++) {
        const ch = t[i];
        if (spec.noShort.has(ch) || (spec.digits && /[0-9]/.test(ch))) continue;
        const known = spec.valueShort.has(ch) || spec.patternShort.has(ch) || spec.nameShort.has(ch);
        if (!known) return new Set();
        if (spec.patternShort.has(ch)) patternSupplied = true;
        const attached = i + 1 < t.length;
        if (spec.nameShort.has(ch)) {
          if (attached) {
            if (t.startsWith('!', i + 1)) exempt.add(k);
          } else if (k + 1 < operands.length) {
            if (operands[k + 1].text.startsWith('!')) exempt.add(k + 1);
            k++;
          } else {
            return new Set();
          }
        } else if (!attached) {
          k++;
        }
        break;
      }
    }
    if (k >= operands.length) return new Set(); // an option ran off the end of the words
  }
  if (!patternSupplied && firstPositional !== -1) exempt.add(firstPositional);
  return exempt;
}

// A short-option cluster whose replace-string flag is its last letter
// (`-0I {}`, `-tI {}`, `-rI {}`): the next word is the replace string, as for
// a bare `-I`. A letter before it that takes a value takes the rest of the
// cluster instead (XARGS_SHORT_VALUE, XARGS_SHORT_ATTACHED). xargsSubCommand
// skips that word only where xargsCommandIndex puts the command after it, so
// a cluster that is itself an option's value, or follows `--`, is not read so.
function clusterEndsInReplaceFlag(t) {
  if (t.length < 3 || t[0] !== '-' || t[1] === '-') return false;
  for (let c = 1; c < t.length; c++) {
    if (XARGS_SHORT_ATTACHED.includes(t[c]) || XARGS_SHORT_VALUE.includes(t[c])) {
      return t[c] === 'I' && c === t.length - 1;
    }
  }
  return false;
}

// `xargs <sub-command words>`: the word index of the sub-command, or -1.
// `argFile` is true when `-a`/`--arg-file` replaces stdin.
function xargsSubCommand(operands) {
  let argFile = false;
  for (let m = 0; m < operands.length; m++) {
    const t = operands[m].text;
    if (t === '-a' || t === '--arg-file') { argFile = true; m++; continue; }
    if (t.startsWith('--arg-file=')) { argFile = true; continue; }
    if (XARGS_VALUE_FLAGS.has(t)) { m++; continue; }
    if (clusterEndsInReplaceFlag(t) && xargsCommandIndex(operands, 0, operands.length) > m + 1) { m++; continue; }
    if (t.startsWith('--') && t.includes('=')) continue;
    if (t.startsWith('-')) continue; // no-value flag (-0 -r -t -p) or long flag
    return { subIdx: m, argFile };
  }
  return { subIdx: -1, argFile };
}

// The carve-out for a search sub-command run by xargs, shifted to xargs's own
// operand indices. Only the search tools: the words xargs appends from stdin
// follow the sub-command's own, so they never turn the pattern into a file,
// whereas `xargs cp src .env` would make `.env` a source.
function xargsSearchIndices(operands) {
  const { subIdx } = xargsSubCommand(operands);
  if (subIdx === -1) return new Set();
  const sub = lastSegment(operands[subIdx].text).toLowerCase();
  if (!SEARCH_TOOLS.has(sub)) return new Set();
  const inner = searchOperandIndices(SEARCH_TOOLS.get(sub), operands.slice(subIdx + 1));
  return new Set([...inner].map((i) => i + subIdx + 1));
}

// #4639: the `--env-file` word, plus the next operand for the bare flag
// (`--env-file=<value>` is a single word).
function envFileValueIndices(operands) {
  const exempt = new Set();
  for (let k = 0; k < operands.length; k++) {
    if (!ENV_FILE_FLAG_RE.test(operands[k].text)) continue;
    exempt.add(k);
    if (!operands[k].text.includes('=')) exempt.add(++k);
  }
  return exempt;
}

// True when `text` is a listed long option, or a short cluster (`-co`) whose
// every letter is listed. `--opt=value`, an abbreviation, or a cluster
// holding a value option (`-ciX`) is not.
function isListedFlag(text, flags) {
  if (text.startsWith('--')) return flags.has(text);
  return /^-[A-Za-z]+$/.test(text) && [...text.slice(1)].every((ch) => flags.has(`-${ch}`));
}

// Walks git's global options (see GIT_GLOBAL_VALUE_OPTIONS). `sub` is the
// subcommand's index, or -1 when an unlisted option (or the end of the words)
// comes first; `configs` holds every `-c` value seen on the way, in order.
// Past an unlisted option the subcommand cannot be located, so `configs`
// conservatively takes the word after every later `-c` as well: a read
// still needs a command-valued key, so a harmless value stays allowed.
function walkGitGlobals(operands) {
  const configs = [];
  for (let k = 0; k < operands.length; k++) {
    const t = operands[k].text;
    if (!t.startsWith('-')) return { sub: k, configs };
    if (GIT_GLOBAL_VALUE_OPTIONS.has(t)) {
      if (t === '-c' && k + 1 < operands.length) configs.push(operands[k + 1].text);
      k++;
      continue;
    }
    if (GIT_GLOBAL_FLAGS.has(t)) continue;
    const eq = t.indexOf('=');
    if (t.startsWith('--') && eq !== -1 && GIT_GLOBAL_EQUALS_FORM_OPTIONS.has(t.slice(0, eq))) continue;
    for (let j = k + 1; j + 1 < operands.length; j++) {
      if (operands[j].text === '-c') configs.push(operands[++j].text);
    }
    return { sub: -1, configs };
  }
  return { sub: -1, configs };
}

// #4856: the pathspec operands of a GIT_PATHSPEC_SUBCOMMANDS invocation. git
// permutes options, so one may follow a pathspec; after `--` every word is a
// pathspec. The subcommand is matched case-sensitively, as git looks it up.
function gitPathspecIndices(operands) {
  const { sub } = walkGitGlobals(operands);
  const spec = sub === -1 ? undefined : GIT_PATHSPEC_SUBCOMMANDS.get(operands[sub].text);
  if (!spec) return new Set();
  const pathspecs = new Set();
  let required = spec.requires === undefined;
  let endOfOptions = false;
  for (let k = sub + 1; k < operands.length; k++) {
    const t = operands[k].text;
    if (endOfOptions || !t.startsWith('-') || t === '-') pathspecs.add(k);
    else if (t === '--') endOfOptions = true;
    else if (!isListedFlag(t, spec.flags)) return new Set();
    else if (t === spec.requires) required = true;
  }
  return required ? pathspecs : new Set();
}

// #4856: the destination of a one-source `cp`/`mv` (see COPY_NAME_ONLY_FLAGS).
function copyDestinationIndices(operands) {
  const positional = [];
  let endOfOptions = false;
  for (let k = 0; k < operands.length; k++) {
    const t = operands[k].text;
    if (endOfOptions || !t.startsWith('-') || t === '-') positional.push(k);
    else if (positional.length) return new Set(); // an option or `--` after an operand
    else if (t === '--') endOfOptions = true;
    else if (!isListedFlag(t, COPY_NAME_ONLY_FLAGS)) return new Set();
  }
  return positional.length === 2 ? new Set([positional[1]]) : new Set();
}

// What a bare `cat` prints when its stdin is a heredoc or here-string in the command text (#6182): the bodies and
// strings joined by a newline. `cat file` (an operand that is not `-`) reads no stdin, so its output is not knowable here.
function catPrintedText(cmd, feeds) {
  const named = cmd.operands.filter((w) => !w.text.startsWith('-') || w.text === '-');
  if (named.length > 0 && !named.some((w) => w.text === '-')) return null;
  return fedText(feeds);
}

function fedText(feeds) {
  const parts = [...feeds.heredocs, ...feeds.hereStrings];
  return parts.length > 0 ? parts.join('\n') : null;
}

// A command that passes its stdin through unchanged when nothing is fed to it directly (`… | tee out | bash`,
// `… | cat | bash`): the text a shell reads is then that of the segment upstream of it.
function passesStdinThrough(cmd, feeds) {
  if (fedText(feeds) !== null) return false;
  if (cmd.base === 'tee') return true;
  return cmd.base === 'cat' && cmd.operands.every((w) => w.text.startsWith('-'));
}

// The command words of one segment's tokens: the redirect targets (`<<<` text, `> file`) are not operands of the command.
function commandWords(segTokens) {
  const words = [];
  for (let k = 0; k < segTokens.length; k++) {
    const t = segTokens[k];
    if (t.kind === 'op') {
      if (!t.dup && segTokens[k + 1] && segTokens[k + 1].kind === 'word') k++;
      continue;
    }
    if (t.kind === 'word') words.push(t);
  }
  return words;
}

// The here-string targets of one segment's tokens (`cat <<< 'text'`): the word after each `<<<` operator.
function hereStringTargets(segTokens) {
  const out = [];
  for (let k = 0; k < segTokens.length; k++) {
    const t = segTokens[k];
    if (t.kind !== 'op' || t.dup || !t.text.endsWith('<<<')) continue;
    const target = segTokens[k + 1];
    if (target && target.kind === 'word') out.push(target.text);
  }
  return out;
}

// The heredoc bodies of each segment, keyed by the `bySeg` map the scan builds, so a shell reading a pipe can reach
// the bodies of the segment upstream of it without every scanner taking another parameter.
const heredocBodiesBySegMap = new WeakMap();

// The statically-knowable stdin a segment writes: `echo`/`printf` operands
// joined by a space (for `echo`, leading `-neE` flags dropped), or the text a
// bare `cat` prints from a heredoc or here-string given to it (#6182). Any other
// source (`cat gen.sh | bash`, `curl … | sh`) is not knowable → null.
function reconstructedScript(words, feeds = { heredocs: [], hereStrings: [] }) {
  const cmd = resolveCommand(words);
  if (!cmd) return null;
  if (cmd.base === 'cat') return catPrintedText(cmd, feeds);
  if (cmd.base === 'tee') return fedText(feeds); // tee prints its stdin (the files it writes are outputs)
  if (cmd.base === 'echo') {
    let start = 0;
    while (start < cmd.operands.length && /^-[neE]+$/.test(cmd.operands[start].text)) start++;
    return cmd.operands.slice(start).map((w) => w.text).join(' ');
  }
  if (cmd.base === 'printf') return cmd.operands.map((w) => w.text).join(' ');
  return null;
}

// Same rule applied to a `<( … )` / `>( … )` inner script's first segment.
function reconstructedProcsub(inner, reading) {
  const { tokens } = tokenizeCharged(inner, reading);
  const first = [];
  const heredocs = [];
  let sawSeparator = false;
  for (const t of tokens) {
    // The body of a heredoc opened on the first line is emitted after that line's newline separator.
    if (t.kind === 'heredoc' && first.length > 0 && t.seg === first[0].seg) heredocs.push(t.text);
    else if (sawSeparator) continue;
    else if (t.kind === 'sep') sawSeparator = true;
    else first.push(t);
  }
  return reconstructedScript(commandWords(first), { heredocs, hereStrings: hereStringTargets(first) });
}

// The operator connecting segment `s` to the nearest PRECEDING segment that has
// word tokens, skipping empty grouping segments (`(echo cat .env) | bash` has an
// empty segment between `)` and `|`). Returns { op, prevSeg }.
function precedingOp(s, bySeg, sepAfter) {
  let p = s - 1;
  while (p >= 0 && !(bySeg.get(p) || []).some((t) => t.kind === 'word')) p--;
  if (p < 0) return { op: undefined, prevSeg: -1 };
  let op;
  for (let q = p; q < s; q++) {
    const text = sepAfter.get(q);
    if (text !== undefined && !GROUPING_SEPS.has(text)) op = text; // last non-grouping wins
  }
  return { op, prevSeg: p };
}

// #5513: the same scan under the other readings of a heredoc: bash 3.2.57's `$( )` span
// (bodies not skipped) and the earlier tag reading (tag ends at any whitespace). Only a
// command that opens a heredoc can read differently, so the extra passes are skipped for
// every other command. One that met a brace tag gets both span readings with the brace
// read the earlier way as well: that test is the flag, not the text, because a body can
// spell its `<<` so that only the nested scan sees it (`eval ': <''<} …'`).
function findSecretReadUnderOtherReadings(command) {
  const scanUnder = (bodiesSkipped, tagsAsWords, braceTags) => {
    heredocBodiesSkippedInSpans = bodiesSkipped;
    heredocTagsAsWords = tagsAsWords;
    heredocBraceTags = braceTags;
    orphanBodies = false;
    inHeredocPass = true;
    try {
      return findSecretRead(command, 0);
    } finally {
      heredocBodiesSkippedInSpans = true;
      heredocTagsAsWords = true;
      heredocBraceTags = true;
      orphanBodies = true;
      inHeredocPass = false;
    }
  };
  // The first reading with no queue is the guard as it was before #5515 (a queued orphan can take lines another shell runs);
  // it differs from the queue reading only when an orphan was queued.
  // Its nesting-too-deep result is kept for last, as scanBashCommand keeps the first reading's: a read an other reading finds
  // outranks it (#6136).
  const compat = orphanQueued ? scanUnder(true, true, true) : null;
  const hit = (compat !== null && compat.code !== 'nesting-too-deep' ? compat : null) ||
    (command.includes('<<') ? scanUnder(false, true, true) || scanUnder(true, false, true) : null);
  if (hit) return hit;
  if (!braceTagRead) return compat;
  return scanUnder(true, true, false) || scanUnder(false, true, false) || compat;
}

// The debugger-spawn scan, under the earlier reading of a brace tag as well.
// It reads spans as it did before #5515 (no heredoc queue): a queued orphan takes lines a real shell runs
// (`echo $(cat <<EOF) x` then `claude --agent gsd-debugger` spawns it).
function findDebuggerCliSpawnEitherWay(command) {
  orphanBodies = false;
  try {
    const spawn = findDebuggerCliSpawn(command, 0);
    if (spawn !== null || !braceTagRead) return spawn;
    heredocBraceTags = false;
    try {
      return findDebuggerCliSpawn(command, 0);
    } finally {
      heredocBraceTags = true;
    }
  } finally {
    orphanBodies = true;
  }
}

// Returns the block as `{ code, text }` — a secret read (secretRead), or a
// `$'…'` word with no value to check (tokenize's `unreadable`) — or null. A command holding dollar-quoting,
// or a run of `$` before `{` or `(` (where bash and zsh read the run
// differently, tokenize), is scanned under every reading (see the
// dollar-quoting section): bash's, zsh's and dash's readings first, then the
// plain one, which is the scan as it was before #5255. A command holding neither
// gets the plain scan alone, so for it the guard is the pre-#5255 guard by
// construction, and for a brace in a heredoc tag by the extra passes
// (findSecretReadUnderOtherReadings). "Holding" is tested on the text with its `\<newline>`
// continuations removed, because bash joins them before it reads a quote:
// `$\<newline>'x'` is `$'x'`. A run of 2+ `$` before `{` or `(` always ends in
// `$${` or `$$(`, so a substring test finds it in linear time.
function findSecretRead(command, depth) {
  if (depth > 0) return readEachWay(command, depth);
  if (!inHeredocPass) {
    braceTagRead = false;
    orphanQueued = false;
  }
  heldNested = null;
  scanUnfinished = false;
  readingsRan = false;
  if (!budgetHeld) {
    scanBudget = MAX_SCAN_CHARACTERS;
    readerSteps = MAX_SCAN_CHARACTERS;
    budgetSize = MAX_SCAN_CHARACTERS;
    separatorSteps = MAX_SCAN_SEPARATORS;
    separatorSize = MAX_SCAN_SEPARATORS;
    readerSpent = false;
    scanSpent = false;
  }
  let hit = null;
  let failure = null;
  try {
    hit = readEachWay(command, 0);
  } catch (e) {
    if (unfinishedBy(e)) scanUnfinished = true;
    else failure = e;
  }
  // A parser error in the plain reading is the hook's crash (fail open, see
  // header), but only after the scan with the `${…}` reader off has had its say, and
  // a scan that could not finish is still denied.
  const unfinished = scanUnfinished;
  if (hit === null && readingsRan && (!unfinished || failure !== null)) hit = readAsBefore(command);
  if (hit !== null) return hit;
  // A scan that could not finish is the more specific verdict than a body held for being nested too deep (#6136).
  if (heldNested !== null && !(heldNested.code === 'nesting-too-deep' && (unfinished || scanUnfinished))) return heldNested;
  if (unfinished || scanUnfinished) return { code: 'command-too-complex', text: '' };
  if (failure !== null) throw failure;
  return null;
}

// Set when readEachWay ran the readings on `command` or a body it rescans.
let readingsRan = false;

// Set while scanBashCommand runs, so findSecretRead leaves the budgets alone.
let budgetHeld = false;

// The size the budgets were last set to (workSpent).
let budgetSize = MAX_SCAN_CHARACTERS;

// The Bash scan of `command`: findSecretRead, then #5513's heredoc passes
// (findSecretReadUnderOtherReadings), every one of them, with readAsBefore
// inside each, on ONE pair of budgets set here (scanBudget, readerSteps).
// A pass that finds the budgets spent stops at once, so the scan's total work
// is bounded per command, not per pass: a command with no read found by then
// is `command-too-complex`. The Kilo and OpenCode adapters run the hook under
// an 8 s timeout and allow a command whose hook it kills, so the bound is on
// the whole command. `budget` is for tests, which pin the boundary on a small
// one; the hook passes none.
function scanBashCommand(command, budget = MAX_SCAN_CHARACTERS, separatorBudget = MAX_SCAN_SEPARATORS) {
  setCommandBudget(budget, separatorBudget);
  return scanBashReading(command);
}

// Sets the budgets one Bash command's scans share (scanBashCommand).
function setCommandBudget(budget = MAX_SCAN_CHARACTERS, separatorBudget = MAX_SCAN_SEPARATORS) {
  scanBudget = budget;
  readerSteps = budget;
  budgetSize = budget;
  separatorSteps = separatorBudget;
  separatorSize = separatorBudget;
  readerSpent = false;
  scanSpent = false;
}

// scanBashCommand's scan of `command`, on what is left of the budgets: the hook
// runs it once per `env -S` reading (ENV_S_READINGS) after setting them once, so
// every reading of a command spends from the one budget (#5514).
function scanBashReading(command) {
  budgetHeld = true;
  try {
    const first = findSecretRead(command, 0);
    if (first !== null && first.code !== 'nesting-too-deep') return first;
    // A body held for being nested too deep leaves the other readings their say: a read or an unfinished scan they
    // report outranks it (#6136), and it stands when they find nothing more.
    const second = findSecretReadUnderOtherReadings(command);
    return second !== null && second.code !== 'nesting-too-deep' ? second : (first || second);
  } finally {
    budgetHeld = false;
  }
}

// The debugger-spawn check of `command` (findDebuggerCliSpawnEitherWay), on
// what scanBashCommand left of the command's budget: a `debugger-cli-spawn`
// block, `command-too-complex` when the budget runs out first, or null.
function scanDebuggerSpawn(command) {
  budgetHeld = true;
  try {
    const spawn = findDebuggerCliSpawnEitherWay(command);
    return spawn === null ? null : { code: 'debugger-cli-spawn', text: spawn };
  } catch (e) {
    if (e === SCAN_BUDGET_SPENT) return { code: 'command-too-complex', text: '' };
    throw e;
  } finally {
    budgetHeld = false;
  }
}

// The further reading of `command` (#5779, furtherReading): the secret and
// debugger-spawn scans again, with the command resolved past the words the plain
// walk stops at. main runs it last, after scanBashReadings allowed, so it can add
// a denial and cannot lose one. It reads an `env -S` string as next did before
// #5514 (the 'unsplit' reading), and judges the #4432 read-only line under that
// reading. It runs once without bash's
// subscript joins and, only when that pass saw where a join could start, once more
// with them. Both passes share a budget of its own, the size the plain scans get,
// so whether it reads a line never turns on what they spent, and a command's work
// is bounded at twice theirs. `budget` and `separatorBudget` are for tests. Its
// verdict is a block or null:
//   - a stack overflow is `command-too-complex`: findSecretRead returns that block
//     for its own, and one in the spawn scan is thrown, as from scanDebuggerSpawn;
//   - a spent budget is `command-too-complex` too: a line it could not finish is
//     unread, and one that needs both passes is denied from half the plain size;
//   - any other error is a scan error, as one scanBashReadings catches: null, and
//     furtherThrew set, so main gives the command the host's crash policy (#5784).
// A hook timeout is the adapter's: Claude Code reads it as no decision; Pi refuses.
let furtherThrew = false;
function scanFurtherReading(command, budget = MAX_SCAN_CHARACTERS, separatorBudget = MAX_SCAN_SEPARATORS) {
  setCommandBudget(budget, separatorBudget);
  furtherThrew = false;
  budgetHeld = true;
  envSReading = ENV_S_READINGS[0];
  exemption.bashReadOnly = null;
  furtherReading = true;
  joinCandidate = false;
  // Each scan runs under its own catch, as scanBashReadings runs its own, so one
  // that throws leaves the scans and the pass after it their say.
  const attempt = (scan) => {
    try {
      return scan();
    } catch (e) {
      if (e instanceof RangeError || e === SCAN_BUDGET_SPENT) throw e;
      furtherThrew = true;
      return null;
    }
  };
  try {
    for (const joins of [false, true]) {
      if (joins && !joinCandidate) break;
      subscriptJoins = joins;
      const hit = attempt(() => findSecretRead(command, 0)) || attempt(() => findSecretReadUnderOtherReadings(command));
      if (hit !== null) return hit;
      const spawn = attempt(() => findDebuggerCliSpawnEitherWay(command));
      if (spawn !== null) return { code: 'debugger-cli-spawn', text: spawn };
    }
    return null;
  } catch (e) {
    if (e instanceof RangeError) throw e;
    if (e === SCAN_BUDGET_SPENT) return { code: 'command-too-complex', text: '' };
    furtherThrew = true;
    return null;
  } finally {
    budgetHeld = false;
    furtherReading = false;
    subscriptJoins = false;
    envSReading = ENV_S_READINGS[1];
  }
}

// The work the last scan charged against the budgets it had: characters to
// scanCommand's (`scan`) and the readers' (`reader`), separators to
// separatorSteps (`separators`), and whether a charge found one spent
// (`exhausted`). These are work done: a refused character charge charges
// nothing, and a tokenize's separators are charged after it ran.
function workSpent() {
  const spent = (left) => budgetSize - left;
  return {
    scan: spent(scanBudget), reader: spent(readerSteps), separators: separatorSize - separatorSteps, exhausted: readerSpent || scanSpent,
  };
}

// Set while readAsBefore runs: ansiCBraceClose, findParenClose, doubleQuoteEnd
// and tokenize then end a `${…}` the simple way, and zshMathEnd reads nothing.
let asBefore = false;

// The scan of `command` with the `${…}` reader off, at every depth, and its
// verdict, whatever it is. The reader ends a `${…}` where the shell does far
// more often, but where the shell's grammar outruns it (a `#` comment or a
// `case` pattern's `)` in a `$( )` in a `${…}`) it can end one later than the
// shell and miss a read the simple end found. So nothing that scan blocks is
// allowed: findSecretRead runs it on a command the readings found nothing in,
// and blocks on what it blocks. It spends the command's budget, and fails closed
// (`command-too-complex`). A command the readings could not finish is denied
// anyway, so it is not read again; nor is one no reading reached, which that
// scan reads exactly as the plain one does.
function readAsBefore(command) {
  asBefore = true;
  scanUnfinished = false;
  let hit = null;
  try {
    hit = readEachWay(command, 0);
  } catch (e) {
    if (!unfinishedBy(e)) throw e;
    scanUnfinished = true;
  } finally {
    asBefore = false;
  }
  return hit;
}

// Set when a reading could not finish: the stack overflowed somewhere in
// it, or the command spent MAX_SCAN_CHARACTERS. Before, the plain reading's overflow reached the hook's fail-open
// crash policy, and the other readings' overflows were dropped, so past the
// overflow depth a command the scan had not finished was allowed — and the
// readings overflow sooner than the scan before #5255 did, so some commands
// that scan denied were allowed. A read found by any reading is still reported
// as that read; only a command with no read found and an unfinished reading
// is denied as `command-too-complex`. findSecretRead resets it per command.
let scanUnfinished = false;

// What is left of MAX_SCAN_CHARACTERS for the current command; scanCommand
// throws SCAN_BUDGET_SPENT, charging nothing, when a scan would take more than
// is left, and every later scan of the command throws at once, so an
// over-budget command stops in one pass.
let scanBudget = MAX_SCAN_CHARACTERS;

// What is left of the characters the readings' readers (ansiCBraceClose,
// zshMathEnd, and findParenClose and doubleQuoteEnd under a reading) may
// pass in the current command, set with scanBudget. They call each
// other, and when a `${`, `$(` or `$[` inside does not close, the one that
// called it goes on through the text after it and reads it again: so each
// `${$(` or `${"${` doubled their work (with `cat .env` on the line before,
// thirty `${$(` took 36 to 135 s to scan, depending on the host, and a few
// more outlast the hook's 120 s timeout, which lets the command run), and
// text after each unclosed `${$(` or `${"}`, or a
// run of unclosed `$[`, made it quadratic. scanBudget charges only
// scanCommand, which never saw that work. So each reader charges by distance,
// not by step: every character between where it last charged and where it now
// stands, however it got there (a helper's jump over a run of `$`, a quote, a
// `$'…'` span, a heredoc, a nested reader's span), and on a `${` that does not
// close, the rest of the string (unclosed). zshMathEnd, which only steps,
// charges each step. A span a nested reader passed is charged again by the
// reader that jumps over it, so one reader's charge covers another's. Spending
// this throws SCAN_BUDGET_SPENT too, so the reading is unfinished: the read on
// the line before is still named by the plain reading (unless the readings
// also spent scanBudget, which stops the plain reading too), and an
// unfinished command with no read found is denied as `command-too-complex`.
// The plain reading reads as before and charges nothing. The most any of the
// 1,384,856 real agent commands above passes is 339,388.
let readerSteps = MAX_SCAN_CHARACTERS;

// Set when a charge would take more than is left: readerSpent for readerSteps,
// scanSpent for scanBudget and separatorSteps. Every later charge to the same
// budget in the same command then throws too, so a pass that finds it spent
// stops at once.
// The readers' latch stops only the readings that charge them, so the plain
// reading still runs, and can still name a read, after they have spent theirs.
let readerSpent = false;
let scanSpent = false;

// The separators (`;`, `|`, `&&`, a newline, `(` …) the tokenizes of one Bash
// command may produce, across every pass (separatorSteps). A scan's work is
// mostly per segment — grouping its tokens, resolving its command, checking
// its operands — so a command cut into many short segments costs far more per
// character than one long one, which the character budgets do not see: with
// those alone, 1 MiB of `x;y|` after a `$'a'` took about 5.7 s of CPU, and
// 1 MiB of `a ` 0.6 s. With this budget each such shape is denied in at most
// 1.5 s wall at load 42, and the costliest shape left spends the character
// budget (MAX_SCAN_CHARACTERS). Every pass re-tokenizes what it reads, and a
// nested body is read again at each outer pass, so the charge on a script a
// shell reads from a heredoc is a fixed multiple of its length, set by its
// nesting. With a reading trigger in it, each character of a `bash <<'EOF'`
// script is scanned about 120 times and charged up to about 33 separators,
// and such scripts are denied from about 16,000-70,000 characters by shape;
// inside `$( )` or a second heredoc each is scanned about 500 times and
// charged up to about 130, and they are denied from about 4,000-17,000. The
// most any of the 1,384,856 real agent commands above needs is 20,043 (a
// 4,543-character heredoc commit message).
const MAX_SCAN_SEPARATORS = 512 * 1024;

// The separators left in the current command, set with scanBudget.
let separatorSteps = MAX_SCAN_SEPARATORS;

// The size separatorSteps was last set to (workSpent).
let separatorSize = MAX_SCAN_SEPARATORS;

// Charges `n` characters read to readerSteps, or throws SCAN_BUDGET_SPENT,
// charging nothing, when that is more than is left.
function chargeReader(n) {
  if (n <= 0) return;
  if (readerSpent || n > readerSteps) {
    readerSpent = true;
    throw SCAN_BUDGET_SPENT;
  }
  readerSteps -= n;
}

// Charges `n` to scanBudget the same way.
function chargeScan(n) {
  if (scanSpent || n > scanBudget) {
    scanSpent = true;
    throw SCAN_BUDGET_SPENT;
  }
  scanBudget -= n;
}

// Charges the `n` separators a tokenize found to separatorSteps, after it has
// run, so they are charged even when they take more than is left (workSpent
// then reports more than the budget), and then throws SCAN_BUDGET_SPENT.
function chargeSeparators(n) {
  if (scanSpent) throw SCAN_BUDGET_SPENT;
  separatorSteps -= n;
  if (separatorSteps < 0) {
    scanSpent = true;
    throw SCAN_BUDGET_SPENT;
  }
}

// tokenize, charged: its separators to separatorSteps, and, for a scan
// (scanCommand), `str`'s characters to scanBudget before it runs. Every
// tokenize the hook runs on a Bash command goes through here, so its work on
// the command is bounded as a whole. The others — the debugger-spawn check, the
// exemption's read-only check and a process substitution's first segment —
// charge separators only: their cost is per segment, a tokenize alone is cheap
// per character, and they read text the scan has already charged. Under a
// splitting `env -S` reading the debugger-spawn check charges characters as well
// (#5514): it recurses into `eval` and shell bodies once per reading.
function tokenizeCharged(str, reading, chargeCharacters = false) {
  if (chargeCharacters) chargeScan(str.length);
  const result = tokenize(str, reading);
  let separators = 0;
  for (const t of result.tokens) if (t.kind === 'sep') separators++;
  chargeSeparators(separators);
  return result;
}

// A reader's -1 for a `${` that does not close: the text from `read` to the
// end of `str`, which the reader or one it called has read, is charged.
function unclosed(str, read) {
  chargeReader(str.length - read);
  return -1;
}
const SCAN_BUDGET_SPENT = new Error('secret read guard: scan budget spent');

// Whether `e` means a reading could not finish, rather than a parser bug.
function unfinishedBy(e) {
  return e instanceof RangeError || e === SCAN_BUDGET_SPENT;
}

// The first error in a reading that was not a limit: a bug. The hook reports it
// when it has found nothing to deny (main), as one JSON line on stderr whose
// `code` is DIAGNOSTIC.READING_FAILED, so that a reading that stopped
// working does not go unseen. The other scans run on, and their denials stand;
// what that reading alone would have denied at that level is lost with it.
let readingBug = null;

// The codes of the hook's stderr diagnostics, which are not blocks: each is one
// JSON line, `{ hook, code, message }`.
const DIAGNOSTIC = Object.freeze({ READING_FAILED: 'reading-failed' });

// A word with no value to check found in a body the scan rescans, held so that
// a read later in the same pass is the block reported. Nested bodies are
// reached from several scanners, and each stops at the first hit, so it is
// held here, the one way into them, and each gets null. It denies the command
// either way, so what it costs is the name of a read only a later pass sees.
let heldNested = null;

// The readings of `command`, then the plain scan, as described above.
function readEachWay(command, depth) {
  // A body nested past MAX_NESTING_DEPTH is not scanned, so it is denied, named, not allowed unread (#6136). It is held
  // like a word with no value to check: a secret read found elsewhere in the pass is still the block reported.
  if (depth > MAX_NESTING_DEPTH) {
    if (command.trim() === '') return null;
    if (heldNested === null) heldNested = { code: 'nesting-too-deep', text: '' };
    return null;
  }
  const hit = scanEachWay(command, depth);
  if (depth === 0 || hit === null || hit.code === 'secret-read') return hit;
  if (heldNested === null) heldNested = hit;
  return null;
}

// A secret read outranks a word with no value to check, so which block a
// command gets does not hang on which reading reported first.
function scanEachWay(command, depth) {
  if (!readsEachWay(command)) return scanCommand(command, depth, false);
  readingsRan = true;
  let unreadable = null;
  for (const shell of READINGS) {
    let hit = null;
    try {
      hit = scanCommand(command, depth, shell);
    } catch (e) {
      // These readings can reach code the plain one does not: an ANSI-C
      // reading decodes text the plain reading takes literally — a `bash -c $'…'` body whose
      // escaped quotes decode into thousands of nested `"$( )"` overflows the
      // stack in findParenClose. An error here must not cost the plain
      // reading's verdict, which is the one the guard gave before #5255; an
      // overflow, or a spent budget, still leaves the command unfinished
      // (findSecretRead).
      if (unfinishedBy(e)) scanUnfinished = true;
      else if (readingBug === null) readingBug = e;
    }
    if (hit !== null && hit.code === 'secret-read') return hit;
    if (unreadable === null) unreadable = hit;
  }
  return scanCommand(command, depth, false) || unreadable;
}

// Whether `command` holds a form the readings are for (findSecretRead).
function readsEachWay(command) {
  const joined = command.includes('\\\n') ? command.replace(/\\\n/g, '') : command;
  return joined.includes("$'") || joined.includes('$"') || joined.includes('$${') || joined.includes('$$(')
    // zsh's arithmetic holding a quote (zshMathEnd): `$[`, `$((` and `((`.
    || ((joined.includes('"') || joined.includes("'")) && (joined.includes('((') || joined.includes('$[')));
}

// A Bash block for a read of the secret file `text` names.
function secretRead(text) {
  return { code: 'secret-read', text };
}

// One reading of `command`: `reading` is false for the plain reading, or the
// shell ('bash' | 'zsh' | 'dash') whose reading it is; an ANSI-C reading
// (bash's, zsh's) uses that shell's `$'…'` values.
function scanCommand(command, depth, reading) {
  const { tokens, nested, unreadable } = tokenizeCharged(command, reading, true);

  for (const sub of nested) {
    const hit = findSecretRead(sub, depth + 1);
    if (hit) return hit;
  }

  // Group by seg, not separator order: heredoc tokens carry their `<<`
  // segment's seg and must reach the shell even though a data heredoc sits
  // between other separators. Heredocs are kept OUT of `words` so a data body
  // is never operand-checked (`cat <<EOF\n.env\nEOF` stays allowed).
  const bySeg = new Map();
  const heredocsBySeg = new Map();
  const sepAfter = new Map();
  let maxSeg = 0;
  for (const t of tokens) {
    if (t.seg > maxSeg) maxSeg = t.seg;
    if (t.kind === 'sep') {
      sepAfter.set(t.seg, t.text);
    } else if (t.kind === 'heredoc') {
      if (!heredocsBySeg.has(t.seg)) heredocsBySeg.set(t.seg, []);
      heredocsBySeg.get(t.seg).push(t);
    } else {
      if (!bySeg.has(t.seg)) bySeg.set(t.seg, []);
      bySeg.get(t.seg).push(t);
    }
  }

  heredocBodiesBySegMap.set(bySeg, heredocsBySeg);
  for (let s = 0; s <= maxSeg; s++) {
    const segTokens = bySeg.get(s);
    if (!segTokens) continue;

    const words = [];
    const hereStrings = [];
    for (let k = 0; k < segTokens.length; k++) {
      const t = segTokens[k];
      if (t.kind === 'op') {
        if (t.dup) continue;
        const target = segTokens[k + 1];
        if (target && target.kind === 'word') {
          k++;
          if (t.text.endsWith('<<<')) hereStrings.push(target.text); // stdin data for a shell
          // Input redirects are reads regardless of the command's exemption.
          else if (t.read && (namesSecretOperand(target.text) || paramVariantsMatch(target.text, namesSecretOperand) !== null)) return secretRead(target.text);
        }
        continue;
      }
      words.push(t);
    }
    if (!words.length) continue;

    const cmd = resolveCommand(words);
    if (!cmd) continue;
    const { base, operands } = cmd;
    const heredocs = heredocsBySeg.get(s) || [];

    // The command word holds a default (`${x:-cat} .env`, `time ${x:-cat .env}`): the segment is read as the script it
    // becomes when each default is expanded (#6132).
    const rawBase = cmd.word;
    if (rawBase.includes('${')) {
      const named = paramVariants(rawBase);
      if (named.overflow) return secretRead(rawBase);
      // Each variant is scanned with the operands re-quoted as one word each, as the shell hands them over.
      const quotedOperands = operands.map((w) => `'${w.text.replace(/'/g, "'\\''")}'`).join(' ');
      for (const variant of named.variants) {
        if (variant.trim() === '') continue;
        const hit = findSecretRead(`${variant} ${quotedOperands}`, depth + 1);
        if (hit) return hit;
      }
      // A shell or xargs named by the default takes the segment's heredocs, here-strings and piped text as its input.
      for (const variant of named.variants) {
        const inner = resolveCommand([...variant.split(/\s+/).filter(Boolean).map((text) => ({ text })), ...operands]);
        let found = null;
        if (inner && SHELL_INTERPRETERS.has(inner.base)) found = scanShellInterpreter(inner.operands, heredocs, hereStrings, s, bySeg, sepAfter, depth, reading);
        else if (inner && inner.base === 'xargs') found = scanXargsPipe(inner.operands, s, bySeg, sepAfter, depth, reading);
        if (found) return found;
      }
    }

    // eval concatenates ALL its operands and runs the result.
    if (base === 'eval') {
      const hit = findSecretReadWithDefaults(operands.map((w) => w.text).join(' '), depth + 1);
      if (hit) return hit;
      continue;
    }

    // `source` / `.` reads a file (or a process-substitution script).
    if (base === 'source' || base === '.') {
      for (const w of operands) {
        if (w.procsub !== undefined) {
          const src = reconstructedProcsub(w.procsub, reading);
          if (src !== null) {
            const hit = findSecretReadWithDefaults(src, depth + 1);
            if (hit) return hit;
          }
        } else if (operandNamesSecret(w.text)) return secretRead(w.text);
      }
      continue;
    }

    // xargs turns stdin file names into a sub-command's operands.
    if (XARGS_COMMANDS.has(base)) {
      const hit = scanXargsPipe(operands, s, bySeg, sepAfter, depth, reading);
      if (hit) return hit;
      // `.env` given to xargs itself (`xargs -a .env cat`) is an ordinary
      // operand — fall through to the operand check below.
    }

    // find's -exec/-execdir/-ok/-okdir actions run a command; a shell given a script is read like any other (#6114).
    if (base === 'find' || base === 'find.exe') {
      const hit = scanFindActions(operands, heredocs, hereStrings, s, bySeg, sepAfter, depth, reading);
      if (hit) return hit;
    }

    // procps watch joins its operands with spaces and runs the result through `sh -c` (#6114).
    if (base === 'watch') {
      const hit = scanWatch(operands, heredocs, hereStrings, s, bySeg, sepAfter, depth, reading);
      if (hit) return hit;
    }

    if (SHELL_INTERPRETERS.has(base)) {
      const hit = scanShellInterpreter(operands, heredocs, hereStrings, s, bySeg, sepAfter, depth, reading);
      if (hit) return hit;
      // `bash .env` (file mode) is caught by the operand check below.
    }

    // Git -c can carry a shell script instead of a file-name operand (#5045).
    if (base === 'git' || base === 'git.exe') {
      const hit = scanGitConfig(operands, depth);
      if (hit) return hit;
    }

    // `gh api -F key=@.env` and httpie request items read the file named after `@` (#5825).
    const requestCommand = skipShellKeywords({ base, operands });
    const requestItem = requestItemSecretRead(requestCommand.base, requestCommand.operands);
    if (requestItem !== null) return secretRead(requestItem);

    if (NON_READING_COMMANDS.has(base)) continue;

    const nameOnly = nameOnlyOperandIndices(base, operands);
    for (let k = 0; k < operands.length; k++) {
      if (nameOnly.has(k)) continue;
      const named = operandSecretMatch(operands[k].text);
      if (named !== null) return secretRead(curlOperandOpensSecret(base, operands, k) ? curlOpened : named);
      if (curlOperandOpensSecret(base, operands, k)) return secretRead(curlOpened);
    }
  }
  // No secret read found; a `$'…'` word with no value to check still denies.
  return unreadable;
}

// ---------------------------------------------------------------------------
// gsd-debugger CLI spawn scan (#5214)
// ---------------------------------------------------------------------------

const DEBUGGER_AGENT_NAME = 'gsd-debugger';
const CLAUDE_BINARY_RE = /^claude(\.exe)?$/;

// `gsd-debugger`, or a plugin-namespaced `<plugin>:gsd-debugger`.
function isDebuggerAgent(value) {
  return value.slice(value.lastIndexOf(':') + 1) === DEBUGGER_AGENT_NAME;
}

// Returns the `--agent` value text of a debugger launch, or null. A command
// readsEachWay flags is read the way findSecretRead reads it (#5441): under
// bash's, zsh's and dash's readings, then the plain one, and a launch any of
// them finds is the answer, so `claude --agent $'gsd-debugger'` is a launch as
// the unquoted spelling is. readsEachWay joins `\<newline>` continuations first
// (bash joins them before it reads a quote), then flags dollar-quoting (`$'`,
// `$"`), a `$${` or `$$(`, and a quote in a command that also holds `((` or
// `$[`, so `(( n = 1 )); echo "x"` is read every way too. Each body the scan
// rescans (a substitution, an `eval` operand, a `bash -c` body) comes back
// through here and picks its own readings, so
// `bash -c $'claude --agent gsd-debugger'` is decoded by the reading and then
// read again. A command readsEachWay does not flag gets the plain scan alone,
// which is the check as it was before #5441.
//
// A reading that could not finish (a stack overflow, a spent budget) does not
// cost the other readings their say: when none of them finds a launch, its
// error is thrown on, and the command is denied as `command-too-complex`
// (scanDebuggerSpawn, main), as findSecretRead denies one. Any other error in
// a reading is reported as readingBug and the scan goes on; an error in the
// plain reading is thrown as before.
function findDebuggerCliSpawn(command, depth) {
  if (!readsEachWay(command)) return findDebuggerCliSpawnUnder(command, depth, false);
  let unfinished = null;
  for (const shell of READINGS) {
    try {
      const spawn = findDebuggerCliSpawnUnder(command, depth, shell);
      if (spawn !== null) return spawn;
    } catch (e) {
      if (!unfinishedBy(e)) {
        if (readingBug === null) readingBug = e;
      } else if (unfinished === null) {
        unfinished = e;
      }
    }
  }
  const spawn = findDebuggerCliSpawnUnder(command, depth, false);
  if (spawn === null && unfinished !== null) throw unfinished;
  return spawn;
}

// #6439: bash expands `{a,b}` and `{a..z}` before `claude` reads its argv, so `claude --agent {gsd-debugger,x}` hands
// the CLI `gsd-debugger` and `claude {--agent,gsd-debugger}` hands it `--agent gsd-debugger`. Every operand is expanded
// (expandBraces, the expander the Grep glob arm uses, plus letter ranges) into the words bash would produce before the
// `--agent` scan. A quoted word is expanded too: the tokenizer drops the quote marks, so `{"gsd-debugger",x}` (which
// bash does expand) cannot be told from `"{gsd-debugger,x}"` (which it does not), and no real agent name holds a brace.
// A list too long to expand cannot be ruled out, so it counts as a launch. Returns the words, or null when too long.
const BRACE_LETTER_RANGE_RE = /\{([A-Za-z])\.\.([A-Za-z])(?:\.\.-?\d+)?\}/;

function expandOperandWord(text) {
  const range = BRACE_LETTER_RANGE_RE.exec(text);
  if (range === null) return expandBraces(text);
  // Every letter between the ends, whatever the step: a superset only ever over-denies.
  const from = range[1].charCodeAt(0);
  const to = range[2].charCodeAt(0);
  const out = [];
  for (let c = Math.min(from, to); c <= Math.max(from, to); c++) {
    const expanded = expandOperandWord(text.slice(0, range.index) + String.fromCharCode(c) + text.slice(range.index + range[0].length));
    if (expanded === null) return null;
    out.push(...expanded);
    if (out.length > MAX_GLOB_ALTERNATIVES) return null;
  }
  return out;
}

// The `--agent` value text of a debugger launch among the expanded operands, or null. The value is the next word of the
// same operand's expansion when there is one (`{--agent,x}`), otherwise any word of the next operand's expansion (the
// superset the issue asks for: `--agent {x,gsd-debugger}` is denied although bash passes only `x` as the value).
function debuggerAgentInOperands(expandedOperands) {
  for (let i = 0; i < expandedOperands.length; i++) {
    const words = expandedOperands[i];
    for (let j = 0; j < words.length; j++) {
      const text = words[j];
      if (text === '--agent') {
        const candidates = j + 1 < words.length ? [words[j + 1]] : (expandedOperands[i + 1] || []);
        const hit = candidates.find(isDebuggerAgent);
        if (hit !== undefined) return hit;
      } else if (text.startsWith('--agent=') && isDebuggerAgent(text.slice('--agent='.length))) {
        return text.slice('--agent='.length);
      }
    }
  }
  return null;
}

// One reading of findDebuggerCliSpawn: `reading` is false for the plain
// reading, or the shell whose reading it is (scanCommand). Under a splitting
// `env -S` reading the check charges its characters too: it runs once per
// reading, and uncharged it is work the readings repeat outside the command's
// budget (#5514). The first reading charges as before #5514.
function findDebuggerCliSpawnUnder(command, depth, reading) {
  const { tokens, nested } = tokenizeCharged(command, reading, envSReading.split);

  for (const sub of nested) {
    if (depth < MAX_NESTING_DEPTH) {
      const hit = findDebuggerCliSpawn(sub, depth + 1);
      if (hit) return hit;
    }
  }

  const bySeg = new Map();
  for (const t of tokens) {
    if (t.kind !== 'word' && t.kind !== 'op') continue;
    if (!bySeg.has(t.seg)) bySeg.set(t.seg, []);
    bySeg.get(t.seg).push(t);
  }

  for (const segTokens of bySeg.values()) {
    const words = [];
    for (let k = 0; k < segTokens.length; k++) {
      const t = segTokens[k];
      if (t.kind === 'op') {
        // A redirect consumes its target word; it is never the command.
        if (!t.dup && segTokens[k + 1] && segTokens[k + 1].kind === 'word') k++;
        continue;
      }
      words.push(t);
    }
    if (!words.length) continue;

    const cmd = resolveCommand(words);
    if (!cmd) continue;
    const { base, operands } = cmd;

    if (base === 'eval') {
      if (depth < MAX_NESTING_DEPTH) {
        const hit = findDebuggerCliSpawn(operands.map((w) => w.text).join(' '), depth + 1);
        if (hit) return hit;
      }
      continue;
    }

    if (SHELL_INTERPRETERS.has(base)) {
      const hit = depth < MAX_NESTING_DEPTH ? dashCScriptSpawnsDebugger(operands, depth) : null;
      if (hit) return hit;
      continue;
    }

    if (!CLAUDE_BINARY_RE.test(base)) continue;
    const expandedOperands = [];
    for (const operand of operands) {
      const expanded = expandOperandWord(operand.text);
      if (expanded === null) return operand.text;
      expandedOperands.push(expanded);
    }
    const spawnedAgent = debuggerAgentInOperands(expandedOperands);
    if (spawnedAgent !== null) return spawnedAgent;
  }
  return null;
}

// The debugger spawn in the script of a shell's `-c`, read past its options as
// scanShellInterpreter reads it (dashCScriptIndices), at each index
// dashCIndices gives, or null.
function dashCScriptSpawnsDebugger(operands, depth) {
  const cIdxs = dashCIndices(operands);
  for (let i = 0; i < cIdxs.length; i++) {
    for (const k of dashCScriptIndices(operands, cIdxs[i])) {
      const hit = findDebuggerCliSpawn(operands[k].text, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

// A shell interpreter's script comes from `-c`, a file operand, or stdin.
function scanShellInterpreter(operands, heredocs, hereStrings, s, bySeg, sepAfter, depth, reading) {
  const cIdx = operands.findIndex((w) => DASH_C_RE.test(w.text));
  // Mode c: the script follows -c's options (dashCScriptIndices); stdin is DATA (not scanned).
  // A cluster's `-c` before it is read too (`bash -ce 'cat .env' -c`: bash runs the cluster's script).
  if (cIdx !== -1) return dashCScriptReadsSecret(operands, cIdx, depth) || clusteredDashCReadsSecret(operands, depth);
  // A `-c` inside a cluster is read too; with nothing found the reading goes on as before.
  const clustered = clusteredDashCReadsSecret(operands, depth);
  if (clustered) return clustered;
  let fileTok;
  let stdinScript = false;
  for (let m = 0; m < operands.length; m++) {
    if (SHELL_VALUE_FLAGS.has(operands[m].text)) { m++; continue; }
    // `-s` keeps stdin as the script: the operands that follow (`sh -s -- a`) are its positional parameters (#6182).
    if (/^-[A-Za-z]*s[A-Za-z]*$/.test(operands[m].text)) { stdinScript = true; break; }
    if (!operands[m].text.startsWith('-')) { fileTok = operands[m]; break; }
  }
  if (fileTok && !stdinScript) {
    // Mode file: `bash <(echo 'cat .env')`; a plain file is checked as an operand.
    if (fileTok.procsub !== undefined) {
      const src = reconstructedProcsub(fileTok.procsub, reading);
      if (src !== null) return findSecretReadWithDefaults(src, depth + 1);
    }
    return null;
  }
  // Mode stdin: heredoc bodies, here-strings, and a piped echo/printf source.
  for (const h of heredocs) {
    const hit = findSecretReadWithDefaults(h.text, depth + 1);
    if (hit) return hit;
  }
  for (const hs of hereStrings) {
    const hit = findSecretReadWithDefaults(hs, depth + 1);
    if (hit) return hit;
  }
  const src = pipeSourceText(s, bySeg, sepAfter);
  if (src !== null) return findSecretReadWithDefaults(src, depth + 1);
  return null;
}

// The operands a shell's `-c` at `cIdx` may run as its script: the word right
// after a `-c` DASH_C_RE matches, which is the one read before, and the first
// word past the options that may follow it (after a cluster, only that one:
// its next word can be an option's value, as in `bash -co x`). bash, dash and zsh run that one (`bash -c -- 'cat .env'`,
// `sh -c -euo pipefail '…'`, `bash -c + '…'`): `--` or a lone `-` ends the
// options, each `o` or `O` in a cluster takes the next word, and any other
// word starting with `-` or `+` is an option. Reading both keeps every denial
// the first made.
function dashCScriptIndices(operands, cIdx) {
  const out = cIdx + 1 < operands.length && DASH_C_RE.test(operands[cIdx].text) ? [cIdx + 1] : [];
  const k = dashCScriptIndex(operands, cIdx);
  if (k < operands.length && (out.length === 0 || k !== cIdx + 1)) out.push(k);
  return out;
}

// The index of the first word past the options after a shell's `-c` at
// `cIdx`, or operands.length when none is left.
function dashCScriptIndex(operands, cIdx) {
  let k = cIdx + 1 + shortOptionValues(operands[cIdx].text);
  while (k < operands.length) {
    const t = operands[k].text;
    if (t === '--' || t === '-') return k + 1;
    if (t[0] !== '-' && t[0] !== '+') return k;
    k += 1 + shortOptionValues(t);
  }
  return operands.length;
}

// The words a shell's short-option cluster takes as its values: one for each
// `o` or `O` in it (`-o errexit`, `-euo pipefail`, `-oo a b`, `-co x`); a long
// option (`--norc`) takes none here.
function shortOptionValues(t) {
  if (t.length < 2 || t[1] === '-') return 0;
  let n = 0;
  for (let i = 1; i < t.length; i++) if (t[i] === 'o' || t[i] === 'O') n++;
  return n;
}

// The indexes of a shell's `-c`: the word DASH_C_RE matches, as before, and a
// cluster holding `c` (`bash -ce '…'`, `-co errexit`, `+c`) among the options
// before the first other word, where the shell stops reading options (a
// script file's arguments are not options). Both are read: a later word
// DASH_C_RE matches does not hide a cluster's `-c` before it, so in
// `bash -ce 'cat .env' -c` the cluster's script is read (`-c` is `$0`).
function dashCIndices(operands) {
  const cIdx = operands.findIndex((w) => DASH_C_RE.test(w.text));
  const kIdx = dashCClusterIndex(operands);
  const out = cIdx === -1 ? [] : [cIdx];
  if (kIdx !== -1 && kIdx !== cIdx) out.push(kIdx);
  return out;
}
const SHORT_CLUSTER_RE = /^[-+][A-Za-z]+$/;
const SHELL_LONG_OPTIONS = new Set(['norc', 'noprofile', 'noediting', 'login', 'posix', 'verbose', 'debugger',
  'restricted', 'help', 'version', 'pretty-print', 'dump-strings', 'dump-po-strings', 'wordexp', 'protected']);
function dashCClusterIndex(operands) {
  let k = 0;
  while (k < operands.length) {
    const t = operands[k].text;
    if (t === '--' || t === '-' || (t[0] !== '-' && t[0] !== '+')) return -1;
    // bash takes its long options after one dash too (`-rcfile f`, `-norc`).
    const name = t.replace(/^--?/, '');
    if (name === 'rcfile' || name === 'init-file') k += 2;
    else if (SHELL_LONG_OPTIONS.has(name) || t[1] === '-') k++;
    else if (SHORT_CLUSTER_RE.test(t) && t.includes('c', 1)) return k;
    else k += 1 + shortOptionValues(t);
  }
  return -1;
}

// The block for a secret read in the script of a `-c` written inside a
// cluster (dashCClusterIndex), or null.
function clusteredDashCReadsSecret(operands, depth) {
  const cIdx = dashCClusterIndex(operands);
  return cIdx === -1 ? null : dashCScriptReadsSecret(operands, cIdx, depth);
}

// The block for a secret read in the script of a shell's `-c` at `cIdx`, or null.
function dashCScriptReadsSecret(operands, cIdx, depth) {
  for (const k of dashCScriptIndices(operands, cIdx)) {
    const hit = findSecretReadWithDefaults(operands[k].text, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// The statically-knowable text piped into segment `s`: the nearest upstream segment's, looking through `tee` and a bare
// `cat` that only pass their own stdin along (#6182). Each hop moves to an earlier segment, so the walk ends. It is
// found once per segment: `find` can run a shell reading it once per action.
const pipeSourceTextBySegMap = new WeakMap();
function pipeSourceText(s, bySeg, sepAfter) {
  let found = pipeSourceTextBySegMap.get(bySeg);
  if (!found) pipeSourceTextBySegMap.set(bySeg, (found = new Map()));
  if (!found.has(s)) found.set(s, findPipeSourceText(s, bySeg, sepAfter));
  return found.get(s);
}
function findPipeSourceText(s, bySeg, sepAfter) {
  let seg = s;
  for (;;) {
    const { op, prevSeg } = precedingOp(seg, bySeg, sepAfter);
    if (!((op === '|' || op === '|&') && prevSeg >= 0)) return null;
    const upstream = bySeg.get(prevSeg) || [];
    const feeds = {
      heredocs: ((heredocBodiesBySegMap.get(bySeg) || new Map()).get(prevSeg) || []).map((h) => h.text),
      hereStrings: hereStringTargets(upstream),
    };
    const words = commandWords(upstream);
    const own = reconstructedScript(words, feeds);
    if (own !== null) return own;
    const cmd = resolveCommand(words);
    if (!cmd || !passesStdinThrough(cmd, feeds)) return null;
    seg = prevSeg;
  }
}

// xargs's options as GNU findutils 4.9 reads them, for finding the command it
// runs: these short options take a value attached or as the next word (BSD's
// -J, -R and -S too), `-e`, `-i` and `-l` take one only attached, and these
// long options take one as `=value` or as the next word (any unambiguous
// prefix). xargsSubCommand keeps next's reading for the shell and
// non-reading checks.
const XARGS_SHORT_VALUE = 'adEILnPsJRS';
const XARGS_SHORT_ATTACHED = 'eil';
const XARGS_LONG_VALUE = ['--arg-file', '--delimiter', '--max-args', '--max-chars', '--max-procs', '--process-slot-var'];

// Index of the command xargs runs among operands[from..to), or -1.
function xargsCommandIndex(operands, from, to) {
  for (let m = from; m < to; m++) {
    const t = operands[m].text;
    if (t === '--') return m + 1 < to ? m + 1 : -1;
    if (t.length < 2 || t[0] !== '-') return m;
    if (t.startsWith('--')) {
      if (!t.includes('=') && XARGS_LONG_VALUE.some((l) => l.startsWith(t))) m++;
      continue;
    }
    for (let c = 1; c < t.length; c++) {
      if (XARGS_SHORT_ATTACHED.includes(t[c])) break;
      if (XARGS_SHORT_VALUE.includes(t[c])) {
        if (c === t.length - 1) m++;
        break;
      }
    }
  }
  return -1;
}

// The string xargs replaces with each input among its options in
// operands[from..to): `-I R`, `-IR`, BSD `-J R`, `-i` / `-iR` and
// `--replace[=R]` (any unambiguous prefix; `{}` when no R), unless a later
// `-L`, `-l`, `--max-lines`, or `-n` / `--max-args` with a count other than
// 1, cancels it. null when xargs appends the input
// after the command's words. With `cancels` false, nothing cancels it
// (xargsReplaceStrs).
function xargsReplaceString(operands, from, to, cancels = true) {
  let rep = null;
  for (let m = from; m < to; m++) {
    const t = operands[m].text;
    if (t === '--' || t.length < 2 || t[0] !== '-') break;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq === -1 ? t : t.slice(0, eq);
      if (name.length >= 3 && '--replace'.startsWith(name)) {
        rep = eq === -1 ? '{}' : t.slice(eq + 1);
      } else if (name.length >= 7 && '--max-lines'.startsWith(name)) {
        if (cancels) rep = null;
      } else if (name.length >= 7 && '--max-args'.startsWith(name)) {
        const v = eq !== -1 ? t.slice(eq + 1) : m + 1 < to ? operands[m + 1].text : '';
        if (v !== '1' && cancels) rep = null;
        if (eq === -1) m++;
      } else if (eq === -1 && XARGS_LONG_VALUE.some((l) => l.startsWith(t))) {
        m++;
      }
      continue;
    }
    for (let c = 1; c < t.length; c++) {
      if (t[c] === 'i') {
        rep = t.slice(c + 1) || '{}';
        break;
      }
      if (t[c] === 'I' || t[c] === 'J') {
        if (c < t.length - 1) rep = t.slice(c + 1);
        else if (m + 1 < to) rep = operands[++m].text;
        break;
      }
      // GNU lets the last of -I/-i/--replace and -L/-l/--max-lines/-n win: a
      // later -L, or -n with any count but 1, puts xargs back to appending
      // its input.
      if ((t[c] === 'L' || t[c] === 'l') && cancels) rep = null;
      if (t[c] === 'n') {
        const v = c < t.length - 1 ? t.slice(c + 1) : m + 1 < to ? operands[m + 1].text : '';
        if (v !== '1' && cancels) rep = null;
      }
      if (XARGS_SHORT_ATTACHED.includes(t[c])) break;
      if (XARGS_SHORT_VALUE.includes(t[c])) {
        if (c === t.length - 1) m++;
        break;
      }
    }
  }
  return rep === '' ? null : rep;
}

// `find … | xargs cat`: the upstream segment's operands become file names the
// sub-command reads. Only inferred across a real pipe and when stdin is not
// redirected by `-a`/`--arg-file`. A sub-command that is itself a shell
// (`xargs -I{} sh -c 'cat .env'`) carries a literal script and is scanned in
// mode c whether or not a pipe feeds it.
function scanXargsPipe(operands, s, bySeg, sepAfter, depth, reading) {
  const { subIdx, argFile } = xargsSubCommand(operands);
  // The command xargs runs as GNU xargs reads its options, past the wrappers
  // resolveCommand unwraps (#5779): the curl reading below follows it even
  // where next's walk above finds another word or none (`xargs -l curl -s …`).
  const curl = xargsCurlTarget(operands);
  if (subIdx === -1 && curl === null) return null; // no sub-command: xargs defaults to echo

  // The sub-command is resolved through the same wrappers a top-level command is (`xargs sudo sh -c '…'`,
  // `xargs timeout 5 sh -c '…'`, `xargs env sh -c '…'`, #6114); nothing but wrappers left reads as the bare word.
  // With no sub-command next's walk finds, only the curl reading below runs (#5779).
  const resolvedSub = subIdx === -1 ? null : resolveCommand(operands.slice(subIdx));
  const writtenBase = subIdx === -1 ? '' : lastSegment(operands[subIdx].text).toLowerCase();
  const subBase = resolvedSub ? resolvedSub.base : writtenBase;
  const subOperands = resolvedSub ? resolvedSub.operands : operands.slice(subIdx + 1);
  const subIsShell = SHELL_INTERPRETERS.has(subBase);
  if (subIsShell) {
    // Heredocs/here-strings belong to xargs, not the sub-shell; pass none.
    const hit = scanShellInterpreter(subOperands, [], [], s, bySeg, sepAfter, depth, reading);
    if (hit) return hit;
  }
  if (argFile) return null; // stdin replaced by a file — no pipeline inference
  // The exemption stays keyed on the word as written: a wrapper in front (`xargs sudo ls`) does not make a
  // command that reads nothing exempt where it was not before, so nothing denied earlier is allowed now.
  if (curl === null && NON_READING_COMMANDS.has(writtenBase)) return null;
  // The words xargs reads on stdin: every one is a candidate file name — the NON_READING exemption is bypassed for it,
  // but the `.env.example|…` suffix exemption in isSecretBasename still holds.
  const judgeStdinWords = (words) => {
    if (subIsShell) {
      // The shell's script comes from xargs itself: `… | xargs sh -c` runs each piped word (quote-removed) as the
      // script, and `xargs -I{} sh -c 'cat {}'` runs the script with the word substituted for `{}`.
      const hit = scanXargsShellScripts(subOperands, xargsReplaceStrs(operands, subIdx), words, depth);
      if (hit) return hit;
    }
    // Each word as written and as xargs hands it on, kept per word list (pipedWordsReadSecret).
    return pipedWordsReadSecret(words, false, false);
  };
  const { hereWords, bodyWords } = ownFeedWords(s, bySeg);

  // A here-string feeds xargs its text as stdin (`xargs cat <<< .env`, #6433): each word of it is a candidate.
  if (hereWords.length) {
    const hit = judgeStdinWords(hereWords);
    if (hit) return hit;
  }
  // A heredoc is stdin the same way: its body's words are the names xargs reads.
  if (bodyWords.length) {
    const hit = judgeStdinWords(bodyWords);
    if (hit) return hit;
  }

  const fed = xargsFedReadsSecret(operands, subIdx, subIsShell ? subOperands : null, s, bySeg, sepAfter, curl, depth);
  if (fed) return fed;

  const { op, prevSeg } = xargsPrecedingOp(s, bySeg, sepAfter);
  if (op !== '|' && op !== '|&') return null;
  if (prevSeg < 0) return null;

  const prevCmd = upstreamCommand(prevSeg, bySeg);
  if (!prevCmd) return null;
  const printer = xargsPrinter(prevSeg, bySeg, sepAfter);
  if (subIsShell) {
    // The shell's script comes from xargs itself: `… | xargs sh -c` runs each piped word (quote-removed) as the
    // script, and `xargs -I{} sh -c 'cat {}'` runs the script with the word substituted for `{}`.
    const hit = pipedShellScriptsRead(operands, subIdx, subOperands, prevCmd, printer, depth);
    if (hit) return hit;
  }
  return xargsPipedReadsSecret(operands, prevCmd, curl, printer);
}

// The block for a word piped into `xargs … SHELL -c` that the shell runs as
// its script or with the word put into it (scanXargsShellScripts), or null:
// the upstream command's words as written, then the words a printf or echo
// prints (printedWords: `printf 'env\n' | xargs -I{} sh -c 'cat .{}'`), also
// when a `tee` or a bare `cat` passes them on (xargsPrinter).
function pipedShellScriptsRead(operands, subIdx, subOperands, prev, printer, depth) {
  const replaceStrs = xargsReplaceStrs(operands, subIdx);
  return scanXargsShellScripts(subOperands, replaceStrs, prev.operands, depth)
    || (printer !== null && scanXargsShellScripts(subOperands, replaceStrs, printedWords(printer, operands, xargsCommandIndex(operands, 0, operands.length)), depth))
    || null;
}

// The printf or echo whose output an xargs reads from segment `prevSeg`: that
// segment's command, or the one upstream of each `tee` or bare `cat` that
// passes its stdin on (passesStdinThrough: `printf 'env\n' | tee f | xargs …`),
// or null. It is found once per segment, and each segment walked is charged to
// the reader budget.
const xargsPrinterBySegMap = new WeakMap();
function xargsPrinter(prevSeg, bySeg, sepAfter) {
  let found = xargsPrinterBySegMap.get(bySeg);
  if (!found) xargsPrinterBySegMap.set(bySeg, (found = new Map()));
  if (!found.has(prevSeg)) found.set(prevSeg, findXargsPrinter(prevSeg, bySeg, sepAfter));
  return found.get(prevSeg);
}
function findXargsPrinter(prevSeg, bySeg, sepAfter) {
  let seg = prevSeg;
  for (;;) {
    const cmd = upstreamCommand(seg, bySeg);
    if (!cmd) return null;
    if (cmd.base === 'printf' || cmd.base === 'echo') return cmd;
    const tokens = bySeg.get(seg) || [];
    chargeReader(tokens.length);
    const words = resolveCommand(commandWords(tokens));
    const feeds = {
      heredocs: ((heredocBodiesBySegMap.get(bySeg) || new Map()).get(seg) || []).map((h) => h.text),
      hereStrings: hereStringTargets(tokens),
    };
    if (!words || !passesStdinThrough(words, feeds)) return null;
    const { op, prevSeg: up } = precedingOp(seg, bySeg, sepAfter);
    if (!((op === '|' || op === '|&') && up >= 0)) return null;
    seg = up;
  }
}

// precedingOp for an xargs segment, found once per segment: `find` runs many
// xargs in one segment, and precedingOp walks every wordless segment before it.
const xargsPrecedingOpBySegMap = new WeakMap();
function xargsPrecedingOp(s, bySeg, sepAfter) {
  let found = xargsPrecedingOpBySegMap.get(bySeg);
  if (!found) xargsPrecedingOpBySegMap.set(bySeg, (found = new Map()));
  if (!found.has(s)) found.set(s, precedingOp(s, bySeg, sepAfter));
  return found.get(s);
}

// The command of segment `prevSeg`, resolved once per segment: `find` runs
// many xargs in one segment, and each reads the same piped words, so the
// readings of those words (pipedWordsReadSecret, certOptionPiped) are kept by
// the word list this returns.
const upstreamCommandBySegMap = new WeakMap();
function upstreamCommand(prevSeg, bySeg) {
  let found = upstreamCommandBySegMap.get(bySeg);
  if (!found) upstreamCommandBySegMap.set(bySeg, (found = new Map()));
  if (!found.has(prevSeg)) found.set(prevSeg, resolveCommand((bySeg.get(prevSeg) || []).filter((t) => t.kind === 'word')));
  return found.get(prevSeg);
}

// The curl that `xargs` runs, as { runs, subCmd } (the index of the command
// xargs runs, and of the curl behind its wrappers), or null. The xargs-to-curl
// reading lives in this helper and the next, not in scanXargsPipe, so that
// function's stack frame stays next's size: it is on the stack under a piped
// sub-shell's scan (see curlOperandOpensSecret).
function xargsCurlTarget(operands) {
  const runs = xargsCommandIndex(operands, 0, operands.length);
  const subCmd = runs === -1 ? -1 : launchedCommandIndex(operands, runs, operands.length);
  return subCmd !== -1 && CURL_COMMANDS.has(commandName(operands[subCmd].text)) ? { runs, subCmd } : null;
}

// The block for a piped word that names a secret the xargs sub-command
// reads (secretRead), or null. `prev` is the upstream command: its operands
// are the piped words as written, and the words `printer` prints are judged
// too (printedWords): `prev` itself where it is `printf` or `echo`, or one
// upstream of a `tee` or bare `cat` (xargsPrinter).
function xargsPipedReadsSecret(operands, prev, curl, printer = prev) {
  const piped = prev.operands;
  // They become curl's arguments when that command is curl: `xargs sudo curl`.
  // A piped word is a cert option's value where the sub-command's cert option
  // has its value slot open to the input: the option is the last word (xargs
  // appends the input), or its value holds the replace string
  // (`xargs -I{} curl --cert {}`, `-E{}`).
  const toCurl = curl !== null;
  const subCmd = toCurl ? curl.subCmd : -1;
  const rep = toCurl ? xargsReplaceString(operands, 0, curl.runs) : null;
  let certPiped = false;
  for (let k = toCurl ? subCmd + 1 : operands.length; k < operands.length && !certPiped; k++) {
    const t = operands[k].text;
    const v = curlAttachedCertValue(t);
    if (rep !== null && v !== null && v.includes(rep)) certPiped = true;
    else if (curlTakesCertValue(t)) {
      const next = operands[k + 1];
      certPiped = rep === null ? !next : next !== undefined && next.text.includes(rep);
    }
  }
  // And where a piped word is such an option put in by the replace string, the
  // sub-command word after that string is its value
  // (`printf -E | xargs -I{} curl {} f:pw`), quoted or not (`echo '"-E"'`).
  const printed = printer === null ? [] : printedWords(printer, operands, toCurl ? curl.runs : xargsCommandIndex(operands, 0, operands.length));
  if (toCurl && rep !== null && (certOptionPiped(piped) || certOptionPiped(printed))) {
    for (let k = subCmd + 1; k + 1 < operands.length; k++) {
      if (operands[k].text.includes(rep) && curlCertNamesSecret(operands[k + 1].text)) return secretRead(curlOpened);
    }
  }
  return pipedWordsReadSecret(piped, toCurl, certPiped) || pipedWordsReadSecret(printed, toCurl, certPiped);
}

// Whether one of `words` is a cert option, as written or as xargs hands it
// on, kept per word list.
const certOptionPipedByWords = new WeakMap();
function certOptionPiped(words) {
  if (!certOptionPipedByWords.has(words)) {
    certOptionPipedByWords.set(words, words.some((w) => curlTakesCertValue(w.text) || curlTakesCertValue(xargsUnquoted(w.text))));
  }
  return certOptionPipedByWords.get(words);
}

// The block for one of `words`, piped into xargs, that names a secret its
// sub-command reads (curl's when `toCurl`), or null; kept per word list and
// flags, since each xargs that `find` runs reads the same words.
const pipedWordsVerdicts = new WeakMap();
function pipedWordsReadSecret(words, toCurl, certPiped) {
  let found = pipedWordsVerdicts.get(words);
  if (!found) pipedWordsVerdicts.set(words, (found = new Map()));
  const key = (toCurl ? 2 : 0) + (certPiped ? 1 : 0);
  if (!found.has(key)) found.set(key, findPipedWordSecret(words, toCurl, certPiped));
  return found.get(key);
}
function findPipedWordSecret(words, toCurl, certPiped) {
  for (let j = 0; j < words.length; j++) {
    const w = words[j];
    if (operandNamesSecret(w.text)) return secretRead(w.text);
    // xargs removes quotes and backslashes from the words it reads on stdin, so `@".env"` reaches the
    // sub-command as `@.env` (#6114): the word is judged the way the sub-command receives it too.
    const received = xargsUnquoted(w.text);
    if (received !== w.text && operandNamesSecret(received)) return secretRead(w.text);
    if (!toCurl) continue;
    if (curlValueNamesSecret(w.text) || curlCertOpensSecret(words, j)) return secretRead(curlOpened);
    // curl reads the quote-removed word's value too (`-d@".env"`, `--cert ".env":pw`).
    if (received !== w.text && (curlValueNamesSecret(received) || (certPiped && curlCertNamesSecret(received)))) return secretRead(curlOpened);
    if (curlCertOpensSecretUnquoted(words, j)) return secretRead(curlOpened);
    if (certPiped && curlCertNamesSecret(w.text)) return secretRead(curlOpened);
  }
  return null;
}

// curlCertOpensSecret over the words as xargs hands them on, quotes and
// backslashes removed (`--cert ".env":pw`, `-E .env\:pw`); false where neither
// word had any to remove, which curlCertOpensSecret has already judged.
function curlCertOpensSecretUnquoted(words, k) {
  const t = xargsUnquoted(words[k].text);
  const prev = k > 0 ? xargsUnquoted(words[k - 1].text) : null;
  if (t === words[k].text && (prev === null || prev === words[k - 1].text)) return false;
  let v = curlAttachedCertValue(t);
  if (v === null && prev !== null && curlTakesCertValue(prev)) v = t;
  return v !== null && curlCertNamesSecret(v);
}

// The text an xargs in segment `s` reads on stdin from a here-string or a
// heredoc: its own (`xargs cat <<< .env`, `xargs curl x <<EOF`), or one that a
// bare `cat` upstream prints, through any `tee` or bare `cat` that passes it
// on (`cat <<EOF | xargs curl x`), as { text, own }, `own` true for the
// first; null for any other stdin. A pipe from printf or echo is read as
// printedWords reads it, and a file (`xargs cat < list`) is not read.
// It is found once per segment (xargsFedTextBySegMap): `find` runs many xargs
// in one segment, and each would walk the same tokens again.
const xargsFedTextBySegMap = new WeakMap();
function xargsFedText(s, bySeg, sepAfter) {
  let found = xargsFedTextBySegMap.get(bySeg);
  if (!found) xargsFedTextBySegMap.set(bySeg, (found = new Map()));
  if (!found.has(s)) found.set(s, findXargsFedText(s, bySeg, sepAfter));
  return found.get(s);
}
function findXargsFedText(s, bySeg, sepAfter) {
  const own = segmentFedText(s, bySeg);
  if (own !== null) return { text: own, own: true };
  let seg = s;
  for (;;) {
    const { op, prevSeg } = precedingOp(seg, bySeg, sepAfter);
    if (!((op === '|' || op === '|&') && prevSeg >= 0)) return null;
    const cmd = resolveCommand(commandWords(bySeg.get(prevSeg) || []));
    if (!cmd || (cmd.base !== 'cat' && cmd.base !== 'tee')) return null;
    const fed = segmentFedText(prevSeg, bySeg);
    if (fed !== null) return cmd.base === 'tee' || catPrintedText(cmd, { heredocs: [fed], hereStrings: [] }) !== null ? { text: fed, own: false } : null;
    if (cmd.base === 'cat' && !cmd.operands.every((w) => w.text.startsWith('-'))) return null;
    seg = prevSeg;
  }
}

// The heredoc bodies and here-string words given to segment `s`, joined, or
// null. Each token walked is charged to the reader budget.
function segmentFedText(s, bySeg) {
  chargeReader((bySeg.get(s) || []).length);
  const heredocs = ((heredocBodiesBySegMap.get(bySeg) || new Map()).get(s) || []).map((h) => h.text);
  return fedText({ heredocs, hereStrings: hereStringTargets(bySeg.get(s) || []) });
}

// The block for a word xargs reads from the text xargsFedText finds, read as
// a piped word is (xargsPipedReadsSecret), and as a shell's script when xargs
// runs a shell (`shellOperands`, else null); null when there is no such text.
// Each character is charged to the reader budget for the words cut from it,
// as printed text is (PRINTED_WORD_COST).
function xargsFedReadsSecret(operands, subIdx, shellOperands, s, bySeg, sepAfter, curl, depth) {
  const words = xargsFedWords(operands, s, bySeg, sepAfter, curl !== null ? curl.runs : xargsCommandIndex(operands, 0, operands.length));
  if (words === null) return null;
  const hit = shellOperands === null ? null : scanXargsShellScripts(shellOperands, xargsReplaceStrs(operands, subIdx), words, depth);
  return hit || xargsPipedReadsSecret(operands, { base: '', operands: words }, curl);
}

// The words of segment `s`'s own here-strings and heredoc bodies, as { hereWords, bodyWords }, found once per
// segment.
const ownFeedWordsBySegMap = new WeakMap();
function ownFeedWords(s, bySeg) {
  let found = ownFeedWordsBySegMap.get(bySeg);
  if (!found) ownFeedWordsBySegMap.set(bySeg, (found = new Map()));
  if (!found.has(s)) {
    found.set(s, {
      hereWords: hereStringTargets(bySeg.get(s) || []).flatMap((text) => splitOutsideParams(text)).map((text) => ({ text })),
      bodyWords: ((heredocBodiesBySegMap.get(bySeg) || new Map()).get(s) || [])
        .flatMap((h) => splitOutsideParams(h.text)).map((text) => ({ text })),
    });
  }
  return found.get(s);
}

// What a knowable `printf` or `echo` upstream of xargs prints, cut into the
// words xargs could read from it, as { text } objects; [] for any other
// command. The words as written miss what only the printing makes: the
// escapes in printf's format and in its `%b` arguments, and in echo's operands
// (`printf -- '-d\n@.env\n' | xargs curl x`, `printf '.env\n' | xargs cat`).
// The text is cut at blanks, newlines and NULs and at a `-d` delimiter, and
// each line counts as a word too (`-I`, `-L`), which is every way xargs splits
// it and more, so a reading this adds can deny a command xargs would hand an
// argument other than the one judged; the words as written are still judged
// (xargsPipedReadsSecret), so nothing denied before is allowed now. echo is
// read with its escapes on unless `-E` is its last such option: zsh's echo
// and bash's under `xpg_echo` decode them without `-e`. The printed text is
// charged to the reader budget (chargeReader), since printf repeats its format
// while arguments are left.
const printedWordsByPrev = new WeakMap();
function printedWords(prev, operands, runs) {
  if (prev.base !== 'printf' && prev.base !== 'echo') return [];
  let found = printedWordsByPrev.get(prev);
  if (!found) {
    found = { text: prev.base === 'printf' ? printfOutput(prev.operands) : echoOutput(prev.operands), cuts: new Map() };
    printedWordsByPrev.set(prev, found);
  }
  if (found.text === null) return [];
  const to = runs === -1 ? operands.length : runs;
  const key = JSON.stringify([xargsDelimiter(operands, to), xargsReplaceString(operands, 0, to) !== null]);
  if (!found.cuts.has(key)) {
    // Each cut after the first is charged as the first was when it was printed.
    if (found.cuts.size > 0) chargeReader(found.text.length * (1 + PRINTED_WORD_COST));
    found.cuts.set(key, xargsReadWords(found.text, operands, runs));
  }
  return found.cuts.get(key);
}

// The words xargs could read from `text` on its stdin, cut as printedWords
// describes, as { text } objects. `runs` is the index of the command xargs
// runs in `operands`, or -1.
function xargsReadWords(text, operands, runs) {
  const to = runs === -1 ? operands.length : runs;
  const delimiter = xargsDelimiter(operands, to);
  const lines = xargsReplaceString(operands, 0, to) !== null;
  // The text was charged as it was printed (printfOutput, echoOutput); under
  // -I its lines are judged as words too, and are charged again for that.
  if (lines) chargeReader(text.length * PRINTED_WORD_COST);
  // Blanks, and the delimiter -d names, end a word; a newline or a NUL ends a line too.
  const sep = delimiter === null ? /[ \t]/ : new RegExp(`[ \t${delimiter.replace(/[\\\]^-]/g, '\\$&')}]`);
  const words = [];
  const cut = (part) => { if (part !== '') words.push({ text: part }); };
  for (const line of text.split(/[\n\0]/)) {
    const pieces = line.split(sep);
    // A line is a word of its own only under -I, and only where it holds more than one piece.
    if (lines && pieces.length > 1) cut(line.replace(/^[ \t]+/, ''));
    for (const piece of pieces) cut(piece);
  }
  return words;
}

// The reader-budget charge per character of printed text, on top of one for
// printing it, for judging the words cut from it (printedWords): each is read
// as an operand and, under curl, as a -F value under three grammars and as an
// @file value. At this rate a line whose printed text could hold the most
// words is denied as too complex in well under a second, before the text is
// held whole.
const PRINTED_WORD_COST = 16;

// What printf prints for `operands` (bash's builtin: escapes in the format,
// `%s`/`%q`/`%b`/`%c` conversions with a precision, the format repeated while
// arguments are left, `%(fmt)T`'s text), or null when it is given
// no format or its first word is an option. A numeric
// conversion prints a number, which names no file, so it is read as `0`; a
// conversion bash refuses ends the output, as bash's error does.
function printfOutput(operands) {
  let i = 0;
  if (i < operands.length && operands[i].text === '--') i++;
  if (i >= operands.length) return null;
  // bash and zsh read a first word starting with `-` as an option, and print
  // nothing for it: `-v var` prints into a variable, any other is refused.
  if (i === 0 && operands[0].text.length > 1 && operands[0].text[0] === '-') return null;
  const format = operands[i].text;
  const args = operands.slice(i + 1).map((w) => w.text);
  let out = '';
  let a = 0;
  // Each use of the format is charged, and the text it printed, as it is printed.
  const charged = (start) => chargeReader((out.length - start) * (1 + PRINTED_WORD_COST));
  for (;;) {
    chargeReader(format.length);
    const from = a;
    const start = out.length;
    let k = 0;
    while (k < format.length) {
      const ch = format[k];
      if (ch === '\\') {
        const e = printfEscape(format, k, 'format');
        out += e.text;
        k = e.next;
        continue;
      }
      if (ch !== '%') { out += ch; k++; continue; }
      let j = k + 1;
      if (format[j] === '%') { out += '%'; k = j + 1; continue; }
      while (j < format.length && "-+ #0'".includes(format[j])) j++;
      if (format[j] === '*') { a++; j++; } else while (j < format.length && format[j] >= '0' && format[j] <= '9') j++;
      let precision = -1;
      if (format[j] === '.') {
        j++;
        // A negative `*` precision is taken as none, as bash takes it.
        if (format[j] === '*') { precision = parseInt(args[a] || '0', 10) || 0; if (precision < 0) precision = -1; a++; j++; } else {
          const p = j;
          while (j < format.length && format[j] >= '0' && format[j] <= '9') j++;
          precision = parseInt(format.slice(p, j) || '0', 10);
        }
      }
      while (j < format.length && 'hlLjzt'.includes(format[j])) j++;
      // `%(fmt)T` prints the time as strftime writes `fmt`: its text as it is,
      // each conversion a number or a name of the date, read as `0`.
      if (format[j] === '(') {
        const close = format.indexOf(')T', j);
        if (close === -1) { charged(start); return out; }
        out += format.slice(j + 1, close).replace(/%(.?)/g, (m, c) => (c === '%' ? '%' : '0'));
        a++;
        k = close + 2;
        continue;
      }
      const conv = format[j];
      const arg = a < args.length ? args[a] : '';
      const cutTo = (t) => (precision >= 0 ? t.slice(0, precision) : t);
      if (conv === 's' || conv === 'q' || conv === 'Q') { out += cutTo(arg); a++; } else if (conv === 'b') {
        const e = printfEscapes(arg, 'b');
        out += cutTo(e.text);
        a++;
        if (e.stop) { charged(start); return out; }
      } else if (conv === 'c') { out += arg.slice(0, 1); a++; } else if (conv !== undefined && 'diouxXeEfFgGaA'.includes(conv)) {
        out += '0';
        a++;
      } else {
        charged(start);
        return out;
      }
      k = j + 1;
    }
    charged(start);
    if (a >= args.length || a === from) break;
  }
  return out;
}

// What echo prints for `operands`: its leading `-n`/`-e`/`-E` words are
// options, and its escapes are decoded unless the last of `-e`/`-E` is `-E`.
function echoOutput(operands) {
  let start = 0;
  let decode = true;
  while (start < operands.length && /^-[neE]+$/.test(operands[start].text)) {
    const t = operands[start].text;
    const e = t.lastIndexOf('e');
    const E = t.lastIndexOf('E');
    if (e !== -1 || E !== -1) decode = e > E;
    start++;
  }
  const text = operands.slice(start).map((w) => w.text).join(' ');
  chargeReader(text.length * (1 + PRINTED_WORD_COST));
  return decode ? printfEscapes(text, 'echo').text : text;
}

// `text` with its backslash escapes decoded, as { text, stop }, the way bash
// decodes them for `mode`: 'format', printf's format (`\nnn` octal, `\c`
// kept); 'echo', echo -e's operands (`\0nnn` octal); 'b', a printf `%b`
// argument (`\0nnn` and `\nnn` octal). Under 'echo' and 'b' a `\c` ends all
// output (stop).
function printfEscapes(text, mode) {
  let out = '';
  let k = 0;
  while (k < text.length) {
    if (text[k] !== '\\') { out += text[k++]; continue; }
    if (mode !== 'format' && text[k + 1] === 'c') return { text: out, stop: true };
    const e = printfEscape(text, k, mode);
    out += e.text;
    k = e.next;
  }
  return { text: out, stop: false };
}

const PRINTF_ESCAPES = new Map([
  ['a', '\x07'], ['b', '\b'], ['e', '\x1b'], ['E', '\x1b'], ['f', '\f'], ['n', '\n'], ['r', '\r'],
  ['t', '\t'], ['v', '\v'], ['\\', '\\'], ['"', '"'], ["'", "'"], ['?', '?'],
]);

// The escape at text[k] (a backslash) under `mode` (printfEscapes): { text,
// next }. An escape bash does not know keeps its backslash.
function printfEscape(text, k, mode) {
  const c = text[k + 1];
  if (c === undefined) return { text: '\\', next: k + 1 };
  const simple = PRINTF_ESCAPES.get(c);
  if (simple !== undefined) return { text: simple, next: k + 2 };
  const octal = (ch) => ch !== undefined && ch >= '0' && ch <= '7';
  if (mode === 'echo' ? c === '0' : octal(c)) {
    let j = mode !== 'format' && c === '0' ? k + 2 : k + 1;
    let v = 0;
    for (let n = 0; n < 3 && octal(text[j]); n++) v = v * 8 + (text.charCodeAt(j++) - 48);
    return { text: String.fromCharCode(v & 0xff), next: j };
  }
  const hexMax = c === 'x' ? 2 : c === 'u' ? 4 : c === 'U' ? 8 : 0;
  if (hexMax > 0) {
    let j = k + 2;
    let v = 0;
    while (j - k - 2 < hexMax && /[0-9A-Fa-f]/.test(text[j] || '')) v = v * 16 + parseInt(text[j++], 16);
    if (j === k + 2) return { text: '\\' + c, next: k + 2 };
    return { text: v <= 0x10ffff ? String.fromCodePoint(v) : '', next: j };
  }
  return { text: '\\' + c, next: k + 2 };
}

// The delimiter xargs's `-d` / `--delimiter` (any unambiguous prefix) sets
// among its options operands[0..to), as GNU xargs reads them (one character, or
// a C escape), or null.
function xargsDelimiter(operands, to) {
  let d = null;
  for (let m = 0; m < to; m++) {
    const t = operands[m].text;
    if (t === '--' || t.length < 2 || t[0] !== '-') break;
    let v = null;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq === -1 ? t : t.slice(0, eq);
      if (name.length >= 3 && '--delimiter'.startsWith(name)) v = eq !== -1 ? t.slice(eq + 1) : m + 1 < to ? operands[++m].text : null;
      else if (eq === -1 && XARGS_LONG_VALUE.some((l) => l.startsWith(t))) m++;
    } else {
      for (let c = 1; c < t.length; c++) {
        if (t[c] === 'd') {
          v = c < t.length - 1 ? t.slice(c + 1) : m + 1 < to ? operands[++m].text : null;
          break;
        }
        if (XARGS_SHORT_ATTACHED.includes(t[c])) break;
        if (XARGS_SHORT_VALUE.includes(t[c])) {
          if (c === t.length - 1) m++;
          break;
        }
      }
    }
    if (v !== null && v !== '') d = printfEscapes(v, 'format').text.slice(0, 1) || null;
  }
  return d;
}

// A stdin word as xargs hands it to the sub-command: quotes and backslashes removed.
function xargsUnquoted(text) {
  return text.replace(/["'\\]/g, '');
}

// The replace strings a shell script under xargs is read with, from the
// options before the sub-command (xargsReplaceString, so a cluster holding one
// counts: `-0I{}`, `-tI{}`, `-rI{}`): as GNU xargs reads them, where a later
// `-L` or `-n` cancels one, and with nothing cancelling it (`-I{} -L1`).
// null among them is xargs appending its input.
function xargsReplaceStrs(operands, subIdx) {
  const gnu = xargsReplaceString(operands, 0, subIdx);
  const kept = xargsReplaceString(operands, 0, subIdx, false);
  return gnu === kept ? [gnu] : [gnu, kept];
}

// The words xargsReadWords cuts from the fed text of segment `s`, kept per
// segment and cut (delimiter, -I) and charged per cut, or null with no fed
// text: `find` can run many xargs in one segment. A word of xargs's own feed
// that judgeStdinWords has put into a shell's script already (ownFeedWords)
// is marked `judged` and not put in again; a whole line under -I, a word cut
// at a -d delimiter and every word a bare `cat` or `tee` passes on are.
const xargsFedWordsBySegMap = new WeakMap();
function xargsFedWords(operands, s, bySeg, sepAfter, runs) {
  const fed = xargsFedText(s, bySeg, sepAfter);
  if (fed === null) return null;
  const { text } = fed;
  let bySegCuts = xargsFedWordsBySegMap.get(bySeg);
  if (!bySegCuts) xargsFedWordsBySegMap.set(bySeg, (bySegCuts = new Map()));
  const to = runs === -1 ? operands.length : runs;
  const key = JSON.stringify([s, xargsDelimiter(operands, to), xargsReplaceString(operands, 0, to) !== null]);
  if (!bySegCuts.has(key)) {
    chargeReader(text.length * PRINTED_WORD_COST);
    const words = xargsReadWords(text, operands, runs);
    if (fed.own) markJudgedWords(words, s, bySeg);
    bySegCuts.set(key, words);
  }
  return bySegCuts.get(key);
}

// Marks each of `words` that ownFeedWords also cut from segment `s`'s own feed.
function markJudgedWords(words, s, bySeg) {
  const { hereWords, bodyWords } = ownFeedWords(s, bySeg);
  const judged = new Set(hereWords.concat(bodyWords).map((w) => w.text));
  for (const w of words) if (judged.has(w.text)) w.judged = true;
}

// `… | xargs [-I STR] SHELL -c [SCRIPT]` where the script is the piped word itself (no operand after -c, or the
// operand is the replace string) or contains the replace string: each upstream operand, as xargs hands it on
// (quotes and backslashes removed), is read as the script, or substituted into it, for each of `replaceStrs`.
function scanXargsShellScripts(shellOperands, replaceStrs, upstream, depth) {
  const cIdxs = dashCIndices(shellOperands);
  for (let r = 0; r < replaceStrs.length; r++) {
    for (let i = 0; i < cIdxs.length; i++) {
      const hit = xargsShellScriptsAt(shellOperands, cIdxs[i], replaceStrs[r], upstream, depth);
      if (hit) return hit;
    }
  }
  return null;
}

// scanXargsShellScripts for the `-c` at `cIdx`: the word after it, then the
// one past its options, as dashCScriptIndices reads them; with none past them,
// each piped word is the script (`… | xargs sh -c --`).
function xargsShellScriptsAt(shellOperands, cIdx, replaceStr, upstream, depth) {
  const after = DASH_C_RE.test(shellOperands[cIdx].text);
  const first = after ? xargsShellScriptsRead(shellOperands[cIdx + 1], replaceStr, upstream, depth) : null;
  if (first !== null) return first;
  const k = dashCScriptIndex(shellOperands, cIdx);
  return after && k === cIdx + 1 ? null : xargsShellScriptsRead(shellOperands[k], replaceStr, upstream, depth);
}

// scanXargsShellScripts for one `script` operand (undefined: none). The
// script is tested for the replace string once, not once per word, and the
// verdict is kept per word list, script and replace string, since `find` can
// run the same xargs once per action. A word that is the whole script is
// charged as printed text is; a script the word is put into is read as next
// reads it.
const xargsShellScriptVerdicts = new WeakMap();
function xargsShellScriptsRead(script, replaceStr, upstream, depth) {
  let found = xargsShellScriptVerdicts.get(upstream);
  if (!found) xargsShellScriptVerdicts.set(upstream, (found = new Map()));
  const key = JSON.stringify([depth, replaceStr, script ? script.text : null]);
  if (!found.has(key)) found.set(key, findXargsShellScriptRead(script, replaceStr, upstream, depth));
  return found.get(key);
}
function findXargsShellScriptRead(script, replaceStr, upstream, depth) {
  const whole = !script || (replaceStr !== null && script.text === replaceStr);
  const parts = whole || replaceStr === null || replaceStr === '' ? null : script.text.split(replaceStr);
  if (!whole && (parts === null || parts.length < 2)) return null;
  // Past the nesting limit a script is not read, only held as too deep
  // (readEachWay): the first one that is not blank does that, and a blank one
  // nothing. So there no script is built: a part or word that is not blank is
  // held in its place, and a blank word put into blank parts is skipped.
  const deep = depth >= MAX_NESTING_DEPTH;
  const blankParts = whole || parts.every((p) => p.trim() === '');
  const seen = new Set();
  for (const w of upstream) {
    if (!whole && w.judged) continue;
    const word = xargsUnquoted(w.text);
    if (seen.has(word)) continue;
    seen.add(word);
    if (whole) chargeReader((word.length + 1) * PRINTED_WORD_COST);
    if (deep && blankParts && word.trim() === '') continue;
    const read = deep && !blankParts ? parts.find((p) => p.trim() !== '') : whole || deep ? word : parts.join(word);
    const hit = findSecretRead(read, depth + 1);
    if (hit || deep) return hit;
  }
  return null;
}

// `find … -exec CMD … ;` / `+` (also -execdir, -ok, -okdir): a shell among the action commands is read through
// scanShellInterpreter, so `find . -exec sh -c 'cat .env' \;` reads its script. An action whose command is not a
// shell needs nothing more: its operands are already find's operands, which the ordinary check reads.
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
function scanFindActions(operands, heredocs, hereStrings, s, bySeg, sepAfter, depth, reading) {
  for (let i = 0; i < operands.length; i++) {
    if (!FIND_ACTIONS.has(operands[i].text)) continue;
    const action = [];
    let j = i + 1;
    while (j < operands.length && operands[j].text !== ';' && operands[j].text !== '+') action.push(operands[j++]);
    i = j;
    const hit = scanLaunchedCommand(action, s, bySeg, sepAfter, depth, reading);
    if (hit) return hit;
  }
  return null;
}

// A command another program launches (a find action, a `watch -x` command): a shell is read through
// scanShellInterpreter, and the launchers that re-interpret a string (eval, watch, xargs) are read as they are at the
// top level. Anything else needs nothing more: its operands are the launcher's, which the ordinary check reads.
function scanLaunchedCommand(words, s, bySeg, sepAfter, depth, reading) {
  const cmd = resolveCommand(words);
  if (!cmd) return null;
  if (SHELL_INTERPRETERS.has(cmd.base)) return scanShellInterpreter(cmd.operands, [], [], s, bySeg, sepAfter, depth, reading);
  if (cmd.base === 'eval') return findSecretReadWithDefaults(cmd.operands.map((w) => w.text).join(' '), depth + 1);
  if (cmd.base === 'watch') return scanWatch(cmd.operands, [], [], s, bySeg, sepAfter, depth, reading);
  if (cmd.base === 'xargs') return scanXargsPipe(cmd.operands, s, bySeg, sepAfter, depth, reading);
  return null;
}

// procps `watch [options] command…`: without -x/--exec the operands are joined with spaces and handed to
// `sh -c`, so the joined string is a shell script (quotes inside an operand are removed a second time:
// `watch cat '".env"'` runs `cat .env`, and `watch 'cat .env'` is a whole script). With -x/--exec the command
// runs without a shell and its operands are plain words, which the ordinary check judges as before.
// The options that take a value in a separate word (procps `watch`): -n/--interval <secs>, -q/--equexit <cycles> (#6433).
// Every other option is a flag, or carries its value in the same word (`--differences=permanent`).
const WATCH_VALUE_SHORT = 'nq';
// procps-ng watch's long options; getopt_long takes any unambiguous prefix (`--int 1`, `--equ 2`, `--ex`).
const WATCH_LONG_OPTIONS = ['beep', 'color', 'no-color', 'differences', 'errexit', 'chgexit', 'equexit', 'exec', 'help', 'interval',
  'no-linewrap', 'precise', 'no-rerun', 'no-title', 'version'];
function watchLongOption(text) {
  const name = text.slice(2).split('=')[0];
  if (name === '') return null;
  if (WATCH_LONG_OPTIONS.includes(name)) return name;
  const matches = WATCH_LONG_OPTIONS.filter((option) => option.startsWith(name));
  return matches.length === 1 ? matches[0] : null; // none or ambiguous: getopt rejects it, nothing to locate
}
function scanWatch(operands, heredocs, hereStrings, s, bySeg, sepAfter, depth, reading) {
  let exec = false;
  let k = 0;
  for (; k < operands.length; k++) {
    const text = operands[k].text;
    if (text === '--') { k++; break; }
    if (!text.startsWith('-') || text === '-') break;
    if (text.startsWith('--')) {
      const option = watchLongOption(text);
      if (option === 'exec') exec = true;
      else if ((option === 'interval' || option === 'equexit') && !text.includes('=')) k++;
      continue;
    }
    for (let c = 1; c < text.length; c++) {
      if (text[c] === 'd') break; // `-d[VALUE]`: an optional value is attached, so the rest of the word is not options
      if (text[c] === 'x') exec = true;
      if (WATCH_VALUE_SHORT.includes(text[c])) {
        if (c === text.length - 1) k++; // `-n 5`: the value is the next word; `-n5` carries it
        break;
      }
    }
  }
  if (k >= operands.length) return null;
  // -x/--exec: no shell re-reads the operands (`watch -x cat '".env"'` reads a file named `".env"`), but the command
  // itself may be a shell or a launcher that does (`watch -x sh -c 'cat .env'`).
  if (exec) return scanLaunchedCommand(operands.slice(k), s, bySeg, sepAfter, depth, reading);
  return findSecretRead(operands.slice(k).map((w) => w.text).join(' '), depth + 1);
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

const PATTERN_TEXT = '.env, .env.<suffix> (except .env.example/.sample/.template/.dist), .secrets';

function reasonFor(code, tool, target) {
  if (code === 'command-too-large') {
    return `Secret read guard: this Bash command is over ${MAX_COMMAND_LENGTH} characters and ` +
      'cannot be checked for secret-file reads. Split it into smaller commands.';
  }
  if (code === 'nesting-too-deep') {
    return `Secret read guard: this Bash command nests shells or substitutions more than ${MAX_NESTING_DEPTH} levels deep, ` +
      'so the innermost body cannot be checked for secret-file reads. Flatten it or split it into smaller commands.';
  }
  if (code === 'command-too-complex') {
    return 'Secret read guard: this Bash command is nested deep enough to overflow the parser, or ' +
      'needs more work than the scan allows, so it cannot be checked for secret-file reads. ' +
      'Split it into smaller commands.';
  }
  if (code === 'glob-too-complex') {
    return `Secret read guard: the Grep glob '${target}' expands to more than ${MAX_GLOB_ALTERNATIVES} ` +
      'alternatives, or holds too many brace groups to expand, and cannot be checked for ' +
      'secret-file matches. Use a narrower glob.';
  }
  if (code === 'split-string-too-deep') {
    return `Secret read guard: this Bash command nests env -S strings more than ${MAX_NESTING_DEPTH} deep, ` +
      'so the command they run cannot be checked. Run that command without the nested env -S strings.';
  }
  if (code === 'debugger-cli-spawn') {
    return `Debugger spawn guard: this Bash command launches the debugger as a CLI process ('--agent ${target}'). ` +
      'A shell-spawned debugger runs detached, returns no structured result, and the debug checkpoint never advances. ' +
      'Spawn it with the Agent tool instead: Agent(subagent_type="gsd-debugger", run_in_background=false, ...) ' +
      'and wait for its structured return.';
  }
  if (code === 'ansi-c-unterminated') {
    return `Secret read guard: the $'…' quote at ${target} never closes, so the rest of this Bash ` +
      'command cannot be checked for secret-file reads. Close the quote, or use plain quotes.';
  }
  if (code === 'ansi-c-undecodable') {
    return `Secret read guard: the $'…' word at ${target} has no single value to check for a ` +
      'secret-file name: it holds a NUL, which shells cut differently, or a code point zsh ' +
      'refuses. Spell the word with plain quotes, or let the command decode the bytes itself ' +
      "(printf '\\xNN').";
  }
  return `Secret read guard: ${tool} would read '${target}', which matches a protected secret-file ` +
    `pattern (${PATTERN_TEXT}). Secret values must not be read into the conversation. ` +
    'If you need a specific value, ask the user for it; if you need the variable NAMES, ' +
    'read the non-secret template (.env.example) instead.' +
    (tool === 'Bash' && exemption.configured
      ? ' Files the project lists under hooks.secret_read_exempt are readable from Bash only by their absolute path.'
      : '');
}

// stdout gets the typed JSON block; stderr gets the plain reason string
// (Kimi's hook bus reads stderr verbatim back to the model — #3911).
function emitBlock(code, tool, target) {
  const reason = reasonFor(code, tool, target);
  deny({ decision: 'block', code, tool, path: target, reason }, reason);
}

// Strips a `module:` prefix so Kimi's `kimi_cli.tools.file:Grep` (not in the
// KIMI_TOOL_NAMES map — Grep has the same name on both buses) matches.
function bareToolName(raw) {
  return typeof raw === 'string' ? raw.slice(raw.lastIndexOf(':') + 1) : '';
}

// #2304: Kimi's native hook bus delivers Kimi's tool vocabulary in the
// payload (ReadFile / Shell) and `path` instead of `file_path`; the map and
// normalizer below are the byte-identical copy every guard carries (bound by
// tests/kimi-guard-normalization-parity.test.cjs — do not edit locally).
// Grep keeps its name on Kimi and is not in the map; bareToolName() above
// strips the module prefix for it.
const KIMI_TOOL_NAMES = new Map([['WriteFile', 'Write'], ['StrReplaceFile', 'Edit'], ['ReadFile', 'Read'], ['Shell', 'Bash']]);
function normalizeKimiPayload(data) {
  // #2595 (review nit): `JSON.parse('null')` is null, and null/primitive
  // payloads reached the `data.tool_name` read below and threw — falsifying
  // this function's own "total over the inputs JSON can express" claim, which
  // property (e) now tests directly. Harmless in practice (a null payload has
  // nothing to guard, and the throw landed in the same fail-open catch as the
  // exit-0 it now takes deliberately) but the claim should be true as stated.
  if (data === null || typeof data !== 'object') return data;
  const raw = data.tool_name;
  if (typeof raw !== 'string') return data;
  const mapped = KIMI_TOOL_NAMES.get(raw.slice(raw.lastIndexOf(':') + 1));
  if (!mapped) return data;
  data.tool_name = mapped;
  if (data.tool_response === undefined && data.tool_output !== undefined) {
    data.tool_response = data.tool_output;
  }
  const input = data.tool_input;
  if (input && typeof input === 'object') {
    // #2547 (review): Kimi's `path` is AUTHORITATIVE — it must win outright,
    // not merely fill in when `file_path` happens to be absent. kimi-cli's file
    // tools carry no `file_path` field at all (src/kimi_cli/tools/file/write.py,
    // replace.py, @ 4a550ef — the SHA #2547 pins), and soul/toolset.py hands the
    // model's raw json-parsed
    // arguments to PreToolUse verbatim, doing typed validation only later inside
    // tool.call() — after the hook has already decided. So a `file_path` in a
    // Kimi payload is ALWAYS model-supplied, and under the old `=== undefined`
    // condition it SHADOWED the field kimi-cli actually executes on. A payload
    // pairing a cross-root `path` with a spurious `file_path: ""` left every
    // guard reading an empty string and exiting 0, while the identical write
    // without the extra key blocked — a bypass needing no crash at all. The same
    // shadowing also preserved a NON-STRING `file_path` (`[]`), which threw
    // inside gsd-worktree-path-guard's path.isAbsolute() and reached its outer
    // `catch { process.exit(0) }`: the same crash-to-allow this fix closes
    // elsewhere, reached through the guard's own read rather than through
    // normalization. Overwriting can only ever narrow what a guard inspects to
    // the path that will actually be written, so it cannot under-block.
    if (typeof input.path === 'string') {
      input.file_path = input.path;
    }
    const edits = Array.isArray(input.edit) ? input.edit
      : (input.edit && typeof input.edit === 'object') ? [input.edit] : [];
    if (edits.length) {
      // #2547: `e?.old`, not `e.old` — `??` guards the value, not the
      // dereference, so a NULLISH entry (`edit: [null]`) threw a TypeError
      // here. normalizeKimiPayload runs before any tool dispatch, so that throw
      // reached each guard's outer `catch { process.exit(0) }` and silently
      // downgraded a should-BLOCK call into an allow. (A string/number entry
      // never threw — `('x').old` is a legal read yielding undefined.)
      //
      // The String() coercion is guarded for the same reason: `{"toString":
      // null}` is valid JSON that throws "Cannot convert object to primitive
      // value", which is the identical crash-to-allow with a different
      // trigger. Degrading only the non-coercible entry to '' keeps
      // stringification intact for every value that CAN coerce (numbers,
      // arrays, plain objects), so nothing downstream — including
      // gsd-prompt-guard's scan of new_string — loses content it saw before.
      const editText = (v) => { try { return String(v ?? ''); } catch { return ''; } };
      // #2595 (review Major 2): reconstruct UNCONDITIONALLY, mirroring the
      // `path` decision above rather than merely filling in when the field
      // happens to be absent. kimi-cli's StrReplaceFile schema is `path` +
      // `edit` only (src/kimi_cli/tools/file/replace.py @ 4a550ef) — it carries
      // no `old_string`/`new_string` at all, so either field appearing in a
      // Kimi payload is ALWAYS model-supplied, exactly like `file_path`. Under
      // the old `=== undefined` condition a model-supplied `new_string: ""`
      // SHADOWED the reconstruction, leaving gsd-prompt-guard's injection scan
      // reading '' and exiting at its `if (!content)` before it ever saw the
      // real `edit[].new` — a one-key bypass of the very scan this fix's
      // guarded coercion exists to keep fed. A `typeof` test would NOT close
      // it: a benign non-empty string shadows just as effectively as ''.
      input.old_string = edits.map((e) => editText(e?.old)).join('\n');
      input.new_string = edits.map((e) => editText(e?.new)).join('\n');
    }
  }
  return data;
}

// The Bash path's scans of `command`: one pass per reading of ENV_S_READINGS, in
// its order (#5514), all on the one budget set here for the command, so the
// readings together do no more work than one scan may. Returns the block the
// hook emits (null when none) and whether a scan threw. A read or a launch a pass
// finds is returned before the next reading runs, so nothing a later reading does
// can lose it. Any other block (`command-too-complex`, an undecodable `$'…'` word)
// is returned at once too while no split option has been met, as `next` emits it;
// once one has, it is held and returned after the last reading, unless a later one
// names a read or a launch, as findSecretRead ranks its own readings. Each of the
// two scans (the secret scan with its heredoc readings, then the spawn check) runs
// under its own catch. A stack overflow there is held as `command-too-complex`, the
// deny main's catch gives one; any other error finds nothing. Either way the scans
// after it still run, and the command gets the crash verdict only when nothing
// denies it (main). Tests call it in process with a small budget, and can pass the
// spawn check (`spawnCheck`): no command is known that overflows it alone.
function scanBashReadings(command, budget = MAX_SCAN_CHARACTERS, separatorBudget = MAX_SCAN_SEPARATORS, spawnCheck = scanDebuggerSpawn) {
  setCommandBudget(budget, separatorBudget);
  splitSeen = false;
  splitTooDeep = false;
  let threw = false;
  let held = null;
  const attempt = (scan) => {
    try {
      return scan();
    } catch (e) {
      threw = true;
      return e instanceof RangeError ? { code: 'command-too-complex', text: '' } : null;
    }
  };
  try {
    for (const r of ENV_S_READINGS) {
      if (r.runs === 'split' && !splitSeen) continue;
      if (r.runs === 'split-or-throw' && !splitSeen && !threw) continue;
      envSReading = r;
      // The #4432 exemption's read-only line (F3) is judged under this reading,
      // never under the reading that ran first: a split string can hold a
      // command that writes or runs a program where the unsplit reading saw `cat`.
      exemption.bashReadOnly = null;
      for (const scan of [scanBashReading, spawnCheck]) {
        const block = attempt(() => scan(command));
        if (block === null) continue;
        if (block.code === 'secret-read' || block.code === 'debugger-cli-spawn' || !splitSeen) return { block, threw };
        if (held === null) held = block;
      }
      if (splitTooDeep) return { block: { code: 'split-string-too-deep', text: '' }, threw };
    }
    return { block: held, threw };
  } finally {
    envSReading = ENV_S_READINGS[1];
  }
}

// How long the hook waits for its stdin to close (#5784). Exported so the
// stdin-timer tests build their cells from it rather than repeat it.
const STDIN_TIMEOUT_MS = 3000;

// The PreToolUse entry. Tests load the scanners in-process (module.exports
// below); the hook body runs only when the file is executed as the hook.
function main() {
  let input = '';
  // A stdin that has not closed within STDIN_TIMEOUT_MS is a hook failure, not
  // a verdict on the payload, so it takes the declared crash policy (#5784)
  // rather than an unconditional allow. The timer is not reset by `data`: a
  // payload written in full whose stdin stays open is caught here too.
  const stdinTimeout = setTimeout(
    () => crashFor(GUARD_ERROR_CAUSE.STDIN_STALL, `stdin did not close within ${STDIN_TIMEOUT_MS / 1000} s`),
    STDIN_TIMEOUT_MS,
  );
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    clearTimeout(stdinTimeout);
    let tool = '';
    try {
      const data = normalizeKimiPayload(JSON.parse(input));

      // A null/primitive payload has nothing to guard — exit deliberately
      // rather than throwing into the fail-open catch below (#2595 class).
      if (data === null || typeof data !== 'object') {
        allow(undefined);
      }

      tool = bareToolName(data.tool_name);
      if (tool !== 'Read' && tool !== 'Grep' && tool !== 'Bash') {
        allow(undefined);
      }
      if (!data.tool_input || typeof data.tool_input !== 'object') {
        allow(undefined);
      }

      // #4432: exemptions resolve against the payload cwd (as the context
      // monitor does), else the process cwd. Bash honors absolute paths only: a
      // relative word there is re-anchored by cd/find/xargs/git -C.
      exemption.root = typeof data.cwd === 'string' && data.cwd !== '' ? data.cwd : process.cwd();
      exemption.allowRelative = tool === 'Read' || tool === 'Grep';

      // Every payload field is read TYPED in a single statement (#2547 class):
      // `[]`/`{}` are truthy and a non-string degrades to '' here.
      if (tool === 'Read') {
        const filePath = typeof data.tool_input.file_path === 'string' ? data.tool_input.file_path : '';
        if (namesSecret(filePath)) emitBlock('secret-read', tool, filePath);
        allow(undefined);
      }

      if (tool === 'Grep') {
        const grepPath = typeof data.tool_input.path === 'string' ? data.tool_input.path
          : (typeof data.tool_input.file_path === 'string' ? data.tool_input.file_path : '');
        if (namesSecret(grepPath)) emitBlock('secret-read', tool, grepPath);
        const glob = typeof data.tool_input.glob === 'string' ? data.tool_input.glob : '';
        if (glob !== '') {
          const verdict = grepGlobVerdict(glob);
          if (verdict) emitBlock(verdict, tool, glob);
        }
        allow(undefined);
      }

      // Bash
      const command = typeof data.tool_input.command === 'string' ? data.tool_input.command : '';
      if (command === '') allow(undefined);
      if (command.length > MAX_COMMAND_LENGTH) emitBlock('command-too-large', tool, '');
      exemption.bashLine = command;
      const { block, threw } = scanBashReadings(command);
      if (block !== null) emitBlock(block.code, tool, block.text);
      const further = scanFurtherReading(command);
      if (further !== null) emitBlock(further.code, tool, further.text);
      if (readingBug !== null) {
        process.stderr.write(`${JSON.stringify({ hook: 'gsd-secret-read-guard', code: DIAGNOSTIC.READING_FAILED, message: String(readingBug.message) })}\n`);
        // A reading that failed is a hook error the catch below never sees, so
        // it takes the host's crash policy too (#5784): the allow above by
        // default, a guard-error block when the host opted in.
        crashFor(GUARD_ERROR_CAUSE.READING_FAILED, 'a shell reading failed');
      }
      // An error in a scan that is not an overflow is a hook error that
      // scanBashReadings or scanFurtherReading caught before the catch below could
      // see it, so it takes the host's crash policy as that catch does (#5784).
      if (threw || furtherThrew) crashFor(GUARD_ERROR_CAUSE.HOOK_ERROR, 'internal error');
      allow(undefined);
    } catch (e) {
      // A stack overflow is a limit, not a bug: failing open on it allows a
      // read the check had not reached. findSecretRead turns its own into
      // `command-too-complex`, and scanBashReadings holds one the debugger-spawn
      // check throws as the same block. Any RangeError that still reaches this
      // catch is denied the same way. Any other error fails open — never block
      // valid tool calls due to hook errors — unless the host opted in to DENY;
      // ON_CRASH is declared at module top (#3911, #5784).
      if (e instanceof RangeError && tool === 'Bash') emitBlock('command-too-complex', tool, '');
      crashFor(GUARD_ERROR_CAUSE.HOOK_ERROR, 'internal error');
    }
  });
}

module.exports = {
  DIAGNOSTIC, decodeAnsiC, doubleQuoteEnd, findSecretRead, findSecretReadUnderOtherReadings, scanBashCommand, scanBashReadings, scanDebuggerSpawn, scanFurtherReading, tokenize, workSpent, MAX_SCAN_SEPARATORS,
  GUARD_ERROR_CAUSE, MAX_SCAN_CHARACTERS, PRINTED_WORD_COST, STDIN_TIMEOUT_MS,
};

if (require.main === module) main();
