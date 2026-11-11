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
//   see WRAPPERS, #5627); a closed set of
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
//   (`echo cat .env | bash`); `eval` scans its joined operands; `source`/`.`
//   scans a `<( )` operand; and `find … | xargs cat` infers the upstream
//   segment's names as the sub-command's read operands.
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
//   `$VAR` indirection (`bash -c "$TEST_CMD"`, `cat "$F"`), shell globs
//   (`cat .e*`), interpreter one-liners (`python -c "open('.env')"`), a piped
//   script from a non-echo source (`cat gen.sh | bash`, `curl … | sh`), reads
//   inside scripts the agent executes, and `glob: '*'` reaching a
//   NON-gitignored `.env`, and a wrapper (or wrapper option taking a
//   separate value) the WRAPPERS table does not list, or `env -S 'script'` (the split string is skipped as
//   the option's value). Reached through the same gaps and allowed under
//   every reading, so the decoded-value check (#5255) does not cover them:
//   a `${…}` default spelled with `$'…'` (`cat ${x:-$'.env'}`,
//   `cat ${x-$'.e\x6ev'}`), since the text inside `${…}` is not scanned; a
//   name joined to an expansion (`cat ${x:+a}$'.env'`, `cat .env${}`), the
//   `$VAR` gap; a heredoc tag whose `${…}` holds a quoted `}`, which only
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
//   work (`command-too-complex`). (#4639 adds one more, by design: the
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
//         glob-too-complex | command-too-large | command-too-complex |
//         ansi-c-unterminated | ansi-c-undecodable | debugger-cli-spawn
// No-op: other tools, non-secret targets, hook errors (fail open — a parser
//        bug in a hook that runs on EVERY Bash call must never brick a
//        session; the crash policy is declared once below). One error is
//        not a bug but a limit: a Bash command nested deep enough to
//        overflow the parser's stack, or one that needs more than the scan's
//        work budget, is denied as `command-too-complex` (#5255), because
//        failing open there allows a read the scan had not yet reached.

'use strict';

const { HOOK_ON_CRASH, allow, deny, crash } = require('./lib/hook-exit.js');
const { finalExtension, normalizeWindowsBasename, lastSegment } = require('./lib/filename-classification.js');

// Fail open on a hook-internal error (see header). Declared ONCE so the
// outer catch states its policy explicitly (#3911).
const ON_CRASH = HOOK_ON_CRASH.ALLOW;

// Commands longer than this are denied rather than scanned (see header).
const MAX_COMMAND_LENGTH = 1024 * 1024;

// Recursion budget for `$( )` / backtick / `<( )` / nested-shell rescans.
const MAX_NESTING_DEPTH = 3;

// Work budget for one Bash command, in characters tokenized, across every
// pass the scan makes over it (#5255): scanBashCommand sets it once, and every
// reading, nested rescan, second look and heredoc pass spends from it. A
// command holding a reading trigger (`$'`, `$"`, `$${`, `$$(`, or a quote with
// `((` or `$[`; readsEachWay) is scanned under four readings and then, when
// they find nothing, four more times by readAsBefore, so its text costs 8 times
// its length; a nested body that holds one (`$( )`, backticks, `<( )`,
// `eval`, `bash -c`, a heredoc or here-string fed to a shell) costs 8 times its
// own length on top, at each level; and a command holding `<<` is scanned
// again under #5513's other heredoc readings (findSecretReadUnderOtherReadings),
// up to three passes, or five when a heredoc tag holds a brace. A heredoc file
// write holding a trigger therefore costs about 24 times its length. The
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
    if (exemption.bashReadOnly === null) exemption.bashReadOnly = lineIsReadOnly(exemption.bashLine);
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
  ['env', { short: 'uCSaP', long: ['--unset', '--chdir', '--split-string', '--argv0'], assigns: true }],
  ['nice', { short: 'n', long: ['--adjustment'] }],
  ['nohup', {}],
  ['command', {}],
  ['time', { short: 'fo', long: ['--format', '--output'] }],
  ['timeout', { short: 'sk', long: ['--signal', '--kill-after'], operands: 1 }],
  ['stdbuf', { short: 'ioe', long: ['--input', '--output', '--error'] }],
  ['setsid', {}],
  ['exec', { short: 'a' }],
]);

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
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'su']);

// Shell flags whose VALUE is the next operand (`bash -o pipefail`,
// `bash --rcfile x <<EOF`): skipped when locating a script-file operand, so a
// flag value is not mistaken for the script and stdin mode still applies.
const SHELL_VALUE_FLAGS = new Set(['-o', '-O', '+o', '+O', '--rcfile', '--init-file']);

// Value-taking `xargs` flags (long `--flag=value` forms are single words).
// `-a`/`--arg-file` additionally replaces stdin, so it suppresses the pipeline
// inference below.
const XARGS_VALUE_FLAGS = new Set(['-n', '-I', '-i', '-L', '-l', '-P', '-s', '-d', '-E', '-a']);

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
function namesSecretByName(tok) {
  if (typeof tok !== 'string' || tok === '') return false;
  const lower = tok.toLowerCase();
  if (isSecretBasename(lastSegment(lower))) return true;
  const colon = lower.lastIndexOf(':');
  return colon !== -1 && isSecretBasename(lastSegment(lower.slice(colon + 1)));
}

// A secret-by-name token is still allowed when the project listed that exact
// committed file under `hooks.secret_read_exempt` (#4432). The exemption is
// consulted only on the secret-classified branch, so an ordinary token costs
// no I/O.
function namesSecret(tok) {
  if (!namesSecretByName(tok)) return false;
  return !isExemptSecret(tok);
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
// MAX_NESTING_DEPTH is not scanned at all. Several thousand levels of `$( )`
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
    } else if ((ch === "'" && quotes) || ch === '`') {
      const j = str.indexOf(ch, i + 1);
      if (j === -1) return unclosed(str, read);
      i = ch === '`' ? span(i + 1, j) : j + 1;
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

// Index of the `)` closing a `$(` / `<(` / `>(` opened just before `i`, or
// str.length when unterminated. Quote- and heredoc-aware so a `)` inside a
// quoted string or a heredoc body never closes the span early.
function findParenClose(str, i, reading) {
  if (str[i] === '(' && str[i - 2] === '$') {
    const math = zshMathEnd(str, i, reading);
    if (math !== -1) return math;
  }
  let depth = 1;
  let heredocTags = [];
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
      const j = str.indexOf('`', i + 1);
      i = j === -1 ? str.length : j + 1;
      continue;
    }
    if (heredocBodiesSkippedInSpans && ch === '<' && str[i + 1] === '<' && str[i + 2] !== '<') {
      const tag = readHeredocTag(str, i + 2, reading);
      heredocTags.push(tag);
      i = tag.end;
      continue;
    }
    if (ch === '\n' && heredocTags.length) {
      i = consumeHeredocBodies(str, i + 1, heredocTags).end;
      heredocTags = [];
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
    if (nested) nested.push(str.slice(i + 2, e));
    return { next: e + 1, text };
  }
  if (str[i] === '`') {
    const j = str.indexOf('`', i + 1);
    const e = j === -1 ? str.length : j;
    if (nested) nested.push(str.slice(i + 1, e));
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
        const e = findParenClose(str, i + 2, reading);
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
        const j = str.indexOf('`', i + 1);
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
      const j = body.indexOf('`', i + 1);
      const e = j === -1 ? body.length : j;
      nested.push(body.slice(i + 1, e));
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
  let expectTag = null;
  let unreadable = null;

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
    }
    buf = '';
    quoted = 'none';
    hasWord = false;
  };
  // The operator text ends segment `seg`; pass 2 reads it to tell `a | bash`
  // (pipe inference) from `a || bash` and to skip grouping seps.
  const sep = (text) => {
    flush();
    tokens.push({ kind: 'sep', text, quoted: 'none', seg });
    seg++;
  };
  const op = (text, read, dup) => {
    tokens.push({ kind: 'op', text, quoted: 'none', seg, read, dup });
  };

  let i = 0;
  while (i < str.length) {
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
      if (str[i + 1] === '\n') { i += 2; continue; } // line continuation
      hasWord = true;
      if (i + 1 < str.length) buf += str[i + 1];
      i += 2;
      continue;
    }

    if (ch === '$' && str[i + 1] === '(') {
      hasWord = true;
      const e = findParenClose(str, i + 2, reading);
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
      const j = str.indexOf('`', i + 1);
      const e = j === -1 ? str.length : j;
      nested.push(str.slice(i + 1, e));
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
        const r = consumeHeredocBodies(str, i, heredocs);
        for (const b of r.bodies) {
          // Emit a heredoc token per body (quoted included) — the body is the
          // stdin script only a shell interpreter runs. Kept out of `words`.
          tokens.push({ kind: 'heredoc', text: b.body, quoted: b.quoted, seg: b.seg });
          if (!b.quoted) collectSubstitutions(b.body, nested, reading); // bash expands $( ) here
        }
        heredocs = [];
        i = r.end;
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
      if (hasWord && quoted === 'none' && /^\d+$/.test(buf)) {
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
      continue;
    }
    // A brace where a heredoc tag is due is the tag (`<<}; cat .env` is tag `}`,
    // then the read), never a group: every shell takes a `{` there, and bash
    // and dash a `}`.
    if ((ch === '{' || ch === '}') && !hasWord && (i + 1 >= str.length || /[\s;&|)]/.test(str[i + 1]))) {
      if (expectTag && heredocTagsAsWords && heredocBraceTags) {
        braceTagRead = true;
      } else {
        sep(ch);
        i++;
        continue;
      }
    }

    hasWord = true;
    buf += ch;
    i++;
  }
  flush();
  return { tokens, nested, unreadable };
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
  let v = text;
  if (v.startsWith('@')) v = v.slice(1);
  if (v.startsWith('--')) {
    const eq = v.indexOf('=');
    if (eq !== -1) v = v.slice(eq + 1);
    return namesSecret(v);
  }
  if (!/^-[^-]./.test(v)) return namesSecret(v);
  if (namesSecret(v.slice(2))) return true;
  let end = 1;
  while (end < v.length && CLUSTER_FLAG_CHAR_RE.test(v[end])) end++;
  if (end > 2 && namesSecret(v.slice(end))) return true;
  return v[end] === '=' && namesSecret(v.slice(end + 1));
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

// `-c`, or a combined short flag ending in `c` (`-lc`, `-ec`, `-euc`): mode c.
const DASH_C_RE = /^-[A-Za-z]*c$/;

const GROUPING_SEPS = new Set(['(', ')', '{', '}']);

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

// Index of the first word after a wrapper's own options, assignments and
// positional operands (`-n 5`, `-i A=1`, `-s KILL 5`, `--`).
function skipWrapperArgs(words, start, spec) {
  let idx = start;
  let optionsEnded = false;
  while (idx < words.length) {
    const text = words[idx].text;
    if (spec.assigns && ASSIGNMENT_RE.test(text)) {
      idx++;
    } else if (!optionsEnded && text === '--') {
      optionsEnded = true;
      idx++;
    } else if (!optionsEnded && text.length > 1 && text.startsWith('-')) {
      idx += wrapperOptionWidth(text, spec);
    } else {
      break;
    }
  }
  if (!spec.operands) return idx;
  idx = Math.min(idx + spec.operands, words.length);
  // `timeout 5 -- cmd`: some getopt builds still accept `--` after DURATION.
  return idx < words.length && words[idx].text === '--' ? idx + 1 : idx;
}

// Command base + operands after leading `VAR=val` assignments and prefix
// wrappers with their own options (`sudo -u root`, `env -i VAR=x`,
// `timeout -s KILL 5`, `nice -n 5`, …), or null when nothing but prefixes remain.
function resolveCommand(words) {
  let idx = 0;
  while (idx < words.length && ASSIGNMENT_RE.test(words[idx].text)) idx++;
  while (idx < words.length) {
    const spec = WRAPPERS.get(lastSegment(words[idx].text).toLowerCase());
    if (!spec) break;
    idx = skipWrapperArgs(words, idx + 1, spec);
  }
  if (idx >= words.length) return null;
  return { base: lastSegment(words[idx].text).toLowerCase(), operands: words.slice(idx + 1) };
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
  return new Set();
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

// The statically-knowable stdin a segment writes: `echo`/`printf` operands
// joined by a space (for `echo`, leading `-neE` flags dropped). Any other
// source (`cat gen.sh | bash`, `curl … | sh`) is not knowable → null.
function reconstructedScript(words) {
  const cmd = resolveCommand(words);
  if (!cmd) return null;
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
  const words = [];
  for (const t of tokens) {
    if (t.kind === 'sep') break;
    if (t.kind === 'word') words.push(t);
  }
  return reconstructedScript(words);
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
    inHeredocPass = true;
    try {
      return findSecretRead(command, 0);
    } finally {
      heredocBodiesSkippedInSpans = true;
      heredocTagsAsWords = true;
      heredocBraceTags = true;
      inHeredocPass = false;
    }
  };
  const hit = command.includes('<<') ? scanUnder(false, true, true) || scanUnder(true, false, true) : null;
  if (hit || !braceTagRead) return hit;
  return scanUnder(true, true, false) || scanUnder(false, true, false);
}

// The debugger-spawn scan, under the earlier reading of a brace tag as well.
function findDebuggerCliSpawnEitherWay(command) {
  const spawn = findDebuggerCliSpawn(command, 0);
  if (spawn !== null || !braceTagRead) return spawn;
  heredocBraceTags = false;
  try {
    return findDebuggerCliSpawn(command, 0);
  } finally {
    heredocBraceTags = true;
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
  if (!inHeredocPass) braceTagRead = false;
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
  if (heldNested !== null) return heldNested;
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
  scanBudget = budget;
  readerSteps = budget;
  budgetSize = budget;
  separatorSteps = separatorBudget;
  separatorSize = separatorBudget;
  readerSpent = false;
  scanSpent = false;
  budgetHeld = true;
  try {
    return findSecretRead(command, 0) || findSecretReadUnderOtherReadings(command);
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
// per character, and they read text the scan has already charged.
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
    if (depth < MAX_NESTING_DEPTH) {
      const hit = findSecretRead(sub, depth + 1);
      if (hit) return hit;
    }
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
          else if (t.read && namesSecret(target.text)) return secretRead(target.text);
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

    // eval concatenates ALL its operands and runs the result.
    if (base === 'eval') {
      if (depth < MAX_NESTING_DEPTH) {
        const hit = findSecretRead(operands.map((w) => w.text).join(' '), depth + 1);
        if (hit) return hit;
      }
      continue;
    }

    // `source` / `.` reads a file (or a process-substitution script).
    if (base === 'source' || base === '.') {
      for (const w of operands) {
        if (w.procsub !== undefined && depth < MAX_NESTING_DEPTH) {
          const src = reconstructedProcsub(w.procsub, reading);
          if (src !== null) {
            const hit = findSecretRead(src, depth + 1);
            if (hit) return hit;
          }
        } else if (operandNamesSecret(w.text)) return secretRead(w.text);
      }
      continue;
    }

    // xargs turns stdin file names into a sub-command's operands.
    if (base === 'xargs' && depth < MAX_NESTING_DEPTH) {
      const hit = scanXargsPipe(operands, s, bySeg, sepAfter, depth, reading);
      if (hit) return hit;
      // `.env` given to xargs itself (`xargs -a .env cat`) is an ordinary
      // operand — fall through to the operand check below.
    }

    if (SHELL_INTERPRETERS.has(base) && depth < MAX_NESTING_DEPTH) {
      const hit = scanShellInterpreter(operands, heredocs, hereStrings, s, bySeg, sepAfter, depth, reading);
      if (hit) return hit;
      // `bash .env` (file mode) is caught by the operand check below.
    }

    // Git -c can carry a shell script instead of a file-name operand (#5045).
    if ((base === 'git' || base === 'git.exe') && depth < MAX_NESTING_DEPTH) {
      const hit = scanGitConfig(operands, depth);
      if (hit) return hit;
    }

    if (NON_READING_COMMANDS.has(base)) continue;

    const nameOnly = nameOnlyOperandIndices(base, operands);
    for (let k = 0; k < operands.length; k++) {
      if (nameOnly.has(k)) continue;
      if (operandNamesSecret(operands[k].text)) return secretRead(operands[k].text);
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

// Returns the `--agent` value text of a debugger launch, or null.
function findDebuggerCliSpawn(command, depth) {
  const { tokens, nested } = tokenizeCharged(command);

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
      const cIdx = operands.findIndex((w) => DASH_C_RE.test(w.text));
      if (cIdx !== -1 && operands[cIdx + 1] && depth < MAX_NESTING_DEPTH) {
        const hit = findDebuggerCliSpawn(operands[cIdx + 1].text, depth + 1);
        if (hit) return hit;
      }
      continue;
    }

    if (!CLAUDE_BINARY_RE.test(base)) continue;
    for (let k = 0; k < operands.length; k++) {
      const text = operands[k].text;
      if (text === '--agent') {
        const value = operands[k + 1];
        if (value && isDebuggerAgent(value.text)) return value.text;
      } else if (text.startsWith('--agent=') && isDebuggerAgent(text.slice('--agent='.length))) {
        return text.slice('--agent='.length);
      }
    }
  }
  return null;
}

// A shell interpreter's script comes from `-c`, a file operand, or stdin.
function scanShellInterpreter(operands, heredocs, hereStrings, s, bySeg, sepAfter, depth, reading) {
  const cIdx = operands.findIndex((w) => DASH_C_RE.test(w.text));
  if (cIdx !== -1) {
    // Mode c: the next operand is the script; stdin is DATA (not scanned).
    const script = operands[cIdx + 1];
    if (script) return findSecretRead(script.text, depth + 1);
    return null;
  }
  let fileTok;
  for (let m = 0; m < operands.length; m++) {
    if (SHELL_VALUE_FLAGS.has(operands[m].text)) { m++; continue; }
    if (!operands[m].text.startsWith('-')) { fileTok = operands[m]; break; }
  }
  if (fileTok) {
    // Mode file: `bash <(echo 'cat .env')`; a plain file is checked as an operand.
    if (fileTok.procsub !== undefined) {
      const src = reconstructedProcsub(fileTok.procsub, reading);
      if (src !== null) return findSecretRead(src, depth + 1);
    }
    return null;
  }
  // Mode stdin: heredoc bodies, here-strings, and a piped echo/printf source.
  for (const h of heredocs) {
    const hit = findSecretRead(h.text, depth + 1);
    if (hit) return hit;
  }
  for (const hs of hereStrings) {
    const hit = findSecretRead(hs, depth + 1);
    if (hit) return hit;
  }
  const { op, prevSeg } = precedingOp(s, bySeg, sepAfter);
  if ((op === '|' || op === '|&') && prevSeg >= 0) {
    const src = reconstructedScript((bySeg.get(prevSeg) || []).filter((t) => t.kind === 'word'));
    if (src !== null) return findSecretRead(src, depth + 1);
  }
  return null;
}

// `find … | xargs cat`: the upstream segment's operands become file names the
// sub-command reads. Only inferred across a real pipe and when stdin is not
// redirected by `-a`/`--arg-file`. A sub-command that is itself a shell
// (`xargs -I{} sh -c 'cat .env'`) carries a literal script and is scanned in
// mode c whether or not a pipe feeds it.
function scanXargsPipe(operands, s, bySeg, sepAfter, depth, reading) {
  let argFile = false;
  let subIdx = -1;
  for (let m = 0; m < operands.length; m++) {
    const t = operands[m].text;
    if (t === '-a' || t === '--arg-file') { argFile = true; m++; continue; }
    if (t.startsWith('--arg-file=')) { argFile = true; continue; }
    if (XARGS_VALUE_FLAGS.has(t)) { m++; continue; }
    if (t.startsWith('--') && t.includes('=')) continue;
    if (t.startsWith('-')) continue; // no-value flag (-0 -r -t -p) or long flag
    subIdx = m;
    break;
  }
  if (subIdx === -1) return null; // no sub-command: xargs defaults to echo

  const subBase = lastSegment(operands[subIdx].text).toLowerCase();
  if (SHELL_INTERPRETERS.has(subBase)) {
    // Heredocs/here-strings belong to xargs, not the sub-shell; pass none.
    const hit = scanShellInterpreter(operands.slice(subIdx + 1), [], [], s, bySeg, sepAfter, depth, reading);
    if (hit) return hit;
  }
  if (argFile) return null; // stdin replaced by a file — no pipeline inference
  if (NON_READING_COMMANDS.has(subBase)) return null;

  const { op, prevSeg } = precedingOp(s, bySeg, sepAfter);
  if (op !== '|' && op !== '|&') return null;
  if (prevSeg < 0) return null;

  // Every upstream operand is a candidate file name — the NON_READING
  // exemption is bypassed for it, but the `.env.example|…` suffix exemption in
  // isSecretBasename still holds.
  const prevCmd = resolveCommand((bySeg.get(prevSeg) || []).filter((t) => t.kind === 'word'));
  if (!prevCmd) return null;
  for (const w of prevCmd.operands) {
    if (operandNamesSecret(w.text)) return secretRead(w.text);
  }
  return null;
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

// The PreToolUse entry. Tests load the scanners in-process (module.exports
// below); the hook body runs only when the file is executed as the hook.
function main() {
  let input = '';
  const stdinTimeout = setTimeout(() => allow(undefined), 3000);
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
      const hit = scanBashCommand(command);
      if (hit !== null) emitBlock(hit.code, tool, hit.text);
      const spawn = scanDebuggerSpawn(command);
      if (spawn !== null) emitBlock(spawn.code, tool, spawn.text);
      if (readingBug !== null) {
        process.stderr.write(`${JSON.stringify({ hook: 'gsd-secret-read-guard', code: DIAGNOSTIC.READING_FAILED, message: String(readingBug.message) })}\n`);
      }
      allow(undefined);
    } catch (e) {
      // A stack overflow is a limit, not a bug: failing open on it allows a
      // read the check had not reached. findSecretRead turns its own into
      // `command-too-complex`; the debugger-spawn scan unwraps `timeout`,
      // which the secret scan does not, so its tokenizer can overflow on a
      // body the secret scan never read. Any other error fails open — never
      // block valid tool calls due to hook errors.
      if (e instanceof RangeError && tool === 'Bash') emitBlock('command-too-complex', tool, '');
      // ON_CRASH is declared ALLOW at module top (#3911).
      crash(ON_CRASH, undefined);
    }
  });
}

module.exports = {
  DIAGNOSTIC, decodeAnsiC, doubleQuoteEnd, findSecretRead, findSecretReadUnderOtherReadings, scanBashCommand, scanDebuggerSpawn, tokenize, workSpent, MAX_SCAN_SEPARATORS,
  MAX_SCAN_CHARACTERS,
};

if (require.main === module) main();
