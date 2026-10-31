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
//   pass 1 tokenizes with quote state, comments, redirect operators (with fd
//   digits and `>&N` dups), separators (recording the operator text), `$( )` /
//   backtick / `<( )` / `>( )` / bash 5.3 `${ …; }` and `${| …; }` spans
//   (recursed as nested commands, depth ≤ 3; a command whose scan meets a
//   `${ …` is scanned a second time reading it as a pre-5.3 parameter
//   expansion),
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
// Grep globs are judged per brace alternative (never on the whole glob, so
// `{.env.local,zzz.ts}` cannot hide behind a benign sibling): a pure-wildcard
// alternative (`*`, `**`) is allowed — Grep already skips gitignored files,
// so it is equivalent to no glob; any other alternative is denied when its
// literal prefix is a prefix of `.env.`/`.secrets` (`.e*`, `.env*`, `.s*`) or
// when it matches a probe secret name (`*.local`, `*.*`, `*.env*`). More than
// 64 alternatives is denied as `glob-too-complex` (cheap to retry narrower).
//
// Documented gaps (none are statically resolvable by a hook, and Claude
// Code's own 2.1.259 Bash-side enforcement does not resolve them either):
//   `$VAR` indirection (`bash -c "$TEST_CMD"`, `cat "$F"`), shell globs
//   (`cat .e*`), interpreter one-liners (`python -c "open('.env')"`), a piped
//   script from a non-echo source (`cat gen.sh | bash`, `curl … | sh`), reads
//   inside scripts the agent executes, and `glob: '*'` reaching a
//   NON-gitignored `.env`, and a wrapper (or wrapper option taking a
//   separate value) the WRAPPERS table does not list, or `env -S 'script'` (the split string is skipped as
//   the option's value). The promise is "no looser than the retired rules
//   on plain commands, without arming the compound-`cd` prompt". Writes to
//   secret files are out of scope (Write/Edit were never gated). Commands
//   over 1 MiB are denied outright (`command-too-large`) rather than
//   scanned partially or waved through. (#4639 adds one more, by design: the
//   value of `--env-file` under a container runtime is exempt, so the
//   container's own command can print the interpolated environment
//   (`alpine printenv`, `docker compose config`) — the same exposure class
//   as the pre-existing volume-mount gap (`-v .env:/s`); the flag's value
//   itself is a name, never contents. #4856 adds another: the `cp`/`mv`
//   destination exemption can move a link prepared under a non-secret name
//   onto a secret name (`ln -s .env.example l && mv l .env`), so a later
//   edit of `.env` lands in the link target — a write redirection, the
//   out-of-scope write class, not a read.)
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
//         glob-too-complex | command-too-large | debugger-cli-spawn
// No-op: other tools, non-secret targets, hook errors (fail open — a parser
//        bug in a hook that runs on EVERY Bash call must never brick a
//        session; the crash policy is declared once below).

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

// Brace-alternative budget for a Grep glob before it is denied as too complex.
const MAX_GLOB_ALTERNATIVES = 64;

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
  ['sudo', { short: 'CDghpRrTtUu', long: ['--close-from', '--chdir', '--group', '--host', '--prompt', '--chroot', '--role', '--command-timeout', '--type', '--other-user', '--user'] }],
  ['doas', { short: 'Cu' }],
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
function namesSecret(tok) {
  if (typeof tok !== 'string' || tok === '') return false;
  const lower = tok.toLowerCase();
  if (isSecretBasename(lastSegment(lower))) return true;
  const colon = lower.lastIndexOf(':');
  return colon !== -1 && isSecretBasename(lastSegment(lower.slice(colon + 1)));
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
let heredocBodiesSkippedInSpans = true;
let heredocTagsAsWords = true;

// Index of the `)` closing a `$(` / `<(` / `>(` opened just before `i`, or
// str.length when unterminated. Quote- and heredoc-aware so a `)` inside a
// quoted string or a heredoc body never closes the span early.
function findParenClose(str, i) {
  let depth = 1;
  let heredocTags = [];
  while (i < str.length) {
    const ch = str[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === "'") {
      const j = str.indexOf("'", i + 1);
      i = j === -1 ? str.length : j + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < str.length && str[i] !== '"') {
        if (str[i] === '\\') { i += 2; continue; }
        if (str[i] === '$' && str[i + 1] === '(') { i = findParenClose(str, i + 2) + 1; continue; }
        if (str[i] === '`') {
          const j = str.indexOf('`', i + 1);
          i = j === -1 ? str.length : j + 1;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    if (ch === '`') {
      const j = str.indexOf('`', i + 1);
      i = j === -1 ? str.length : j + 1;
      continue;
    }
    if (heredocBodiesSkippedInSpans && ch === '<' && str[i + 1] === '<' && str[i + 2] !== '<') {
      const tag = readHeredocTag(str, i + 2);
      heredocTags.push(tag);
      i = tag.end;
      continue;
    }
    if (ch === '\n' && heredocTags.length) {
      i = consumeHeredocBodies(str, i + 1, heredocTags).end;
      heredocTags = [];
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return str.length;
}

// Reads the tag word after `<<` / `<<-` starting at `i`.
function readHeredocTag(str, i) {
  let stripTabs = false;
  if (str[i] === '-') { stripTabs = true; i++; }
  while (str[i] === ' ' || str[i] === '\t') i++;
  let quoted = false;
  let tag = '';
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
        const e = findParenClose(str, i + 2);
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
// With `eof`, the body is in a function substitution, where bash 5.3 also
// ends it at a line that starts with the tag when the rest of that line holds
// `eof` (the substitution's `}`) anywhere, and reads that rest as commands:
// `end` is then just past the tag, `split` is set, and the line's later tags
// go unread.
function consumeHeredocBodies(str, i, tags, eof) {
  const bodies = [];
  for (const t of tags) {
    let body = '';
    let terminated = false;
    let rest = -1;
    while (i < str.length) {
      const nl = str.indexOf('\n', i);
      const lineEnd = nl === -1 ? str.length : nl;
      const line = str.slice(i, lineEnd);
      const lineStart = i;
      i = nl === -1 ? str.length : nl + 1;
      const probe = t.stripTabs ? line.replace(/^\t+/, '') : line;
      if (probe === t.tag) { terminated = true; break; }
      if (eof && probe.startsWith(t.tag) && probe.includes(eof, t.tag.length)) {
        rest = lineStart + line.length - probe.length + t.tag.length;
        break;
      }
      body += line + '\n';
    }
    bodies.push({ body, quoted: t.quoted, seg: t.seg, tag: t.tag, into: t.into });
    if (rest !== -1) return { bodies, end: rest, split: true };
    if (!terminated) break;
  }
  return { bodies, end: i };
}

// bash 5.3 function substitution: `${` followed by a blank, a newline or `|`
// runs a command list in the current shell — `${ cmd; }` (its value is the
// output) and `${| cmd; }` (its value is $REPLY) — so its body is a nested
// command, like a `$( )` body (#5518). A parameter expansion (`${VAR}`,
// `${#x}`, `${x:-a b}`) starts with a name or a special character instead and
// stays text. Earlier bash reads the same `${ …` as a parameter expansion,
// which fails only when expanded, so the commands around it still run;
// secondBashReading scans under that reading too. funsubSeen records that
// an opener was met in any text the scan read, a derived `bash -c` or `eval`
// script included, since only then can the two readings differ.
let readFunsubs = true;
let funsubSeen = false;
// bash removes a line continuation (`\` newline) before it reads anything,
// so one can split an opener: `${\⏎ cmd; }`, `$\⏎{ cmd; }`.
function skipContinuations(str, i) {
  while (str[i] === '\\' && str[i + 1] === '\n') i += 2;
  return i;
}
// Index just past the `{` of a function substitution opened at `i`, or -1.
function funsubStart(str, i) {
  if (str[i] !== '$') return -1;
  const b = skipContinuations(str, i + 1);
  if (str[b] !== '{') return -1;
  const c = str[skipContinuations(str, b + 1)];
  return c === ' ' || c === '\t' || c === '\n' || c === '|' ? b + 1 : -1;
}
function funsubOpenerAt(str, i) {
  return funsubStart(str, i) !== -1;
}
function isFunsubOpen(str, i) {
  if (!funsubOpenerAt(str, i)) return false;
  funsubSeen = true;
  return readFunsubs;
}

// Heredoc tags still pending when findFunsubClose returns, a nested one's
// included. bash 5.3 reads such a body from the lines after the `}`
// (`${ cat <<E; }` ⏎ body ⏎ `E`), so they are not commands, and runs the line
// after the terminator; the substitution then fails when it is expanded, so
// its command does not run. A nested one's body starts after the inner `}`
// instead; bash runs nothing more once it expands that substitution in the
// shell itself, but when it never does (`false && …`, a function body) or
// does so in a `&` job, a pipeline or a `( … )` subshell, the lines after the
// outermost `}` run. tokenize, which owns that line, takes the tags
// (takeFunsubTags) and appends what follows to the substitution's command.
// For a tag k substitutions deep, each rescan of a body ends it early and
// appends the rest again, so those lines are read k - 1 levels deeper than
// bash runs them, and past MAX_NESTING_DEPTH not at all.
let funsubTags = [];
function takeFunsubTags() {
  const t = funsubTags;
  funsubTags = [];
  return t;
}

// Where the last top-level findFunsubClose ended a heredoc at a line that
// only starts with its tag (consumeHeredocBodies): funsubBody breaks the line
// there, so tokenize, which reads the body as a command of its own and knows
// only whole-line tags, runs the rest of that line too.
let funsubSplits = [];

// The command text of the function substitution opened at `i` and closed at
// `e`; the `|` of `${|` is not part of it.
function funsubBody(str, i, e) {
  const s = skipContinuations(str, funsubStart(str, i));
  let at = str[s] === '|' ? s + 1 : s;
  let body = '';
  for (const split of funsubSplits) {
    body += str.slice(at, split) + '\n';
    at = split;
  }
  return body + str.slice(at, e);
}

// The tag after `<<` / `<<-` at `i` as bash reads it: quote removal as in
// tokenize's word buffer (a `\` in double quotes escapes only `"`, `\`, `$`,
// a backtick or a newline), a line continuation dropped, and, as
// readHeredocTag reads a tag as a word (#5513), a carriage return, `$( )`,
// `${…}` or backtick part kept as text; any quote makes the body quoted. The
// close finder hands its tags on (funsubTags), so a tag that does not match
// the terminator would carry the lines after it into the substitution;
// readHeredocTag keeps the quotes of `E'x'` and stays as findParenClose's.
function readFunsubHeredocTag(str, i) {
  let stripTabs = false;
  if (str[i] === '-') { stripTabs = true; i++; }
  while (str[i] === ' ' || str[i] === '\t') i++;
  let tag = '';
  let quoted = false;
  while (i < str.length && !/[ \t\n;&|<>()]/.test(str[i])) {
    const ch = str[i];
    if (ch === "'") {
      const j = str.indexOf("'", i + 1);
      const e = j === -1 ? str.length : j;
      tag += str.slice(i + 1, e);
      quoted = true;
      i = e + 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
      while (i < str.length && str[i] !== '"') {
        if (str[i] === '\\' && i + 1 < str.length && '"\\$`\n'.includes(str[i + 1])) {
          if (str[i + 1] !== '\n') tag += str[i + 1];
          i += 2;
          continue;
        }
        tag += str[i];
        i++;
      }
      i++;
      continue;
    }
    if (ch === '\\') {
      if (str[i + 1] === '\n') { i += 2; continue; } // line continuation
      quoted = true;
      if (i + 1 < str.length) tag += str[i + 1];
      i += 2;
      continue;
    }
    if (ch === '$' && str[i + 1] === '(') {
      const e = findParenClose(str, i + 2);
      tag += str.slice(i, e + 1);
      i = e + 1;
      continue;
    }
    if ((ch === '$' && str[i + 1] === '{') || ch === '`') {
      const j = ch === '`' ? str.indexOf('`', i + 1) : str.indexOf('}', i);
      const e = j === -1 ? str.length - 1 : j;
      tag += str.slice(i, e + 1);
      i = e + 1;
      continue;
    }
    tag += ch;
    i++;
  }
  return { tag, quoted, stripTabs, end: i };
}

// `{` and `}` are reserved words only where a command starts, which includes
// the word after one of these (`then { …; }`, `fi }`, `coproc { …; }`).
const COMMAND_POSITION_WORDS = new Set(['!', 'coproc', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'if', 'then', 'time', 'until', 'while']);

// Function substitutions the close finders follow inside one another before
// they read a deeper `${ ` as text, the way the guard read every `${ ` before
// #5518. It bounds the recursion: the guard fails open on a stack overflow,
// and a long `${ ${ …` or `${ "${ "${ …` chain would otherwise reach one.
const MAX_FUNSUB_DEPTH = 32;
let funsubDepth = 0;

// The spans the close finders measured during one top-level findFunsubClose
// call, by finder, start and depth, each with the heredoc tags it left in
// funsubTags. A `((` that does not end in `))` is read again as two
// subshells, so without the record each span nested in it would be scanned
// once more per enclosing `((`, doubling the work at every level.
let spanCache = null;
const FUNSUB_SPAN = 0;
const PARAM_SPAN = 1;
const ARITH_STATE = 2;
function spanKey(kind, i) {
  return (i * (MAX_FUNSUB_DEPTH + 2) + funsubDepth) * 3 + kind;
}
// A failed arithmetic attempt's state: its index and open parens.
function arithKey(i, depth) {
  return spanKey(ARITH_STATE, i) * (MAX_FUNSUB_DEPTH + 2) + depth;
}
// The recorded end of the span at `i`, its tags pushed again, or -1.
function knownSpan(kind, i) {
  const hit = spanCache === null ? undefined : spanCache.get(spanKey(kind, i));
  if (hit === undefined) return -1;
  for (const t of hit.tags) funsubTags.push(t);
  return hit.end;
}
// `mark` is funsubTags' length when the span's scan started.
function recordSpan(kind, i, end, mark) {
  if (spanCache !== null) spanCache.set(spanKey(kind, i), { end, tags: funsubTags.slice(mark) });
}

// Index just past the `"` closing a double-quoted string whose text starts at
// `i`. A `$( )`, backtick or function substitution inside keeps its own
// quoting, so each is skipped whole.
function skipDoubleQuoted(str, i) {
  while (i < str.length && str[i] !== '"') {
    if (str[i] === '\\') { i += 2; continue; }
    if (str[i] === '$' && str[i + 1] === '(') { i = findParenClose(str, i + 2) + 1; continue; }
    if (isFunsubOpen(str, i) && funsubDepth < MAX_FUNSUB_DEPTH) { i = findFunsubClose(str, funsubStart(str, i)) + 1; continue; }
    if (str[i] === '`') {
      const j = str.indexOf('`', i + 1);
      i = j === -1 ? str.length : j + 1;
      continue;
    }
    i++;
  }
  return i + 1;
}

// Index of the `}` closing a `${…}` parameter expansion whose text starts at
// `i`, or str.length. Quote-aware, and a nested expansion, `$( )`, backtick or
// function substitution in the word is skipped whole, so `${x:-a; }` holds
// `a; ` rather than ending a function substitution around it.
// Each `${` met, the first included, is recorded as it closes, so the
// finder met again at a recorded one steps over it.
function findParamClose(str, i) {
  const open = [[i, funsubTags.length]]; // [start, funsubTags mark] of each `${` still open
  while (i < str.length) {
    const ch = str[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === "'") {
      const j = str.indexOf("'", i + 1);
      i = j === -1 ? str.length : j + 1;
      continue;
    }
    if (ch === '"') { i = skipDoubleQuoted(str, i + 1); continue; }
    if (ch === '`') {
      const j = str.indexOf('`', i + 1);
      i = j === -1 ? str.length : j + 1;
      continue;
    }
    if (ch === '$' && str[i + 1] === '(') { i = findParenClose(str, i + 2) + 1; continue; }
    if (isFunsubOpen(str, i) && funsubDepth < MAX_FUNSUB_DEPTH) { i = findFunsubClose(str, funsubStart(str, i)) + 1; continue; }
    if (ch === '$' && str[i + 1] === '{') {
      const known = knownSpan(PARAM_SPAN, i + 2);
      if (known !== -1) { i = known + 1; continue; }
      open.push([i + 2, funsubTags.length]);
      i += 2;
      continue;
    }
    if (ch === '}') {
      const [start, mark] = open.pop();
      recordSpan(PARAM_SPAN, start, i, mark);
      if (open.length === 0) return i;
    }
    i++;
  }
  for (const [start, mark] of open) recordSpan(PARAM_SPAN, start, str.length, mark);
  return str.length;
}

// Index just past a quoted string, escape, substitution or parameter
// expansion starting at `i`, or -1 when none starts there.
function skipWordPart(str, i) {
  const ch = str[i];
  if (ch === '\\') return i + 2;
  if (ch === "'" || ch === '`') {
    const j = str.indexOf(ch, i + 1);
    return j === -1 ? str.length : j + 1;
  }
  if (ch === '"') return skipDoubleQuoted(str, i + 1);
  if (ch === '$' && str[i + 1] === '(') return findParenClose(str, i + 2) + 1;
  if (isFunsubOpen(str, i) && funsubDepth < MAX_FUNSUB_DEPTH) return findFunsubClose(str, funsubStart(str, i)) + 1;
  if (ch === '$' && str[i + 1] === '{') return findParamClose(str, i + 2) + 1;
  return -1;
}

// Index of the second `)` ending an arithmetic command `(( … ))` whose text
// starts at `i`, or str.length when unterminated: bash reads to the end of
// the input looking for it, and so does the finder, rather than rescanning
// the rest from each later `((`. -1 when the parens do not end in `))`, which
// bash reads as a subshell in a subshell (`((cmd) )`), or nest past the cap,
// which bounds that rescan.
// Where an attempt is and how many parens it holds open fix its result, so a
// failed one records the states it reached past a skipped word part, and a
// later `((` that reaches one fails there: a parameter expansion spanning the
// next lines' attempts would otherwise have each read the rest after it.
function findArithClose(str, i) {
  const reached = [];
  let depth = 0;
  let end = str.length;
  while (i < str.length) {
    if (spanCache !== null && spanCache.has(arithKey(i, depth))) { end = -1; break; }
    const e = skipWordPart(str, i);
    if (e !== -1) {
      i = e;
      reached.push(arithKey(i, depth));
      continue;
    }
    if (str[i] === '(') {
      if (++depth > MAX_FUNSUB_DEPTH) { end = -1; break; }
    } else if (str[i] === ')') {
      if (depth === 0) { end = str[i + 1] === ')' ? i + 1 : -1; break; }
      depth--;
    }
    i++;
  }
  if (end === -1 && spanCache !== null) for (const k of reached) spanCache.set(k, null);
  return end;
}

// Index of the `)` ending an array's elements (`name=( … )`) whose text starts
// at `i`, or str.length. A `#` starting a word comments out the rest of its line.
function findArrayClose(str, i) {
  let atWord = true;
  while (i < str.length) {
    const ch = str[i];
    if (ch === ')') return i;
    if (ch === ' ' || ch === '\t' || ch === '\n') { atWord = true; i++; continue; }
    if (ch === '#' && atWord) {
      const j = str.indexOf('\n', i);
      i = j === -1 ? str.length : j;
      continue;
    }
    atWord = false;
    const e = skipWordPart(str, i);
    i = e === -1 ? i + 1 : e;
  }
  return str.length;
}

// Index of the `}` closing a function substitution whose body starts at `i`,
// or str.length when unterminated. bash reads that `}` as a reserved word, so
// it closes only where a command starts: `${ echo }; }` prints `}`, and
// `${ echo a; }x` closes before the `x`. Quote-, comment- and heredoc-aware;
// a `{ …; }` group, a parameter expansion or a nested substitution in the body
// is skipped whole. A `{` also opens a group after `function NAME` and
// `coproc NAME`, `time -p` keeps the command position, `]]` ending a `[[ … ]]`
// and `))` ending an arithmetic command start one, and a `}` inside `[[ … ]]`,
// a case pattern, an arithmetic command or an array's elements is a word.
// Heredoc tags still pending at the close are left in funsubTags.
function findFunsubClose(str, i) {
  const top = spanCache === null;
  if (top) {
    spanCache = new Map();
    funsubSplits = [];
  }
  try {
    const known = knownSpan(FUNSUB_SPAN, i);
    if (known !== -1) return known;
    const mark = funsubTags.length;
    const end = scanFunsubClose(str, i);
    recordSpan(FUNSUB_SPAN, i, end, mark);
    return end;
  } finally {
    if (top) spanCache = null;
  }
}
function scanFunsubClose(str, i) {
  funsubDepth++;
  try {
    let groups = 0;
    let atCommand = true; // the next word starts a command
    let braceOk = false; // a `{` here opens a group though no command starts
    let inWord = false;
    let wordAtCommand = false;
    let word = ''; // the current word's plain text; a quote or expansion in it marks it with \0
    let lead = ''; // `function`, `coproc`, `time` or `for` when the last word was one at command position
    let inCond = false; // inside `[[ … ]]`
    let caseWords = 0; // words left in `case WORD in`
    let casePattern = false; // reading a case pattern list, up to its `)`
    let patternStart = false; // at the first word of a pattern list, where `esac` ends the case
    let heredocTags = [];
    const endWord = () => {
      if (!inWord) return;
      inWord = false;
      const prev = lead;
      lead = '';
      braceOk = false;
      if (inCond) {
        if (word === ']]') { inCond = false; atCommand = true; }
        return;
      }
      if (casePattern) {
        if (word === 'esac' && patternStart) { casePattern = false; atCommand = true; }
        patternStart = false;
        return;
      }
      if (caseWords > 0) {
        if (--caseWords === 0 && word === 'in') { casePattern = true; patternStart = true; }
        atCommand = false;
        return;
      }
      if (prev === 'function') { braceOk = true; atCommand = false; return; }
      if (!wordAtCommand) { atCommand = false; return; }
      if (prev === 'time' && (word === '-p' || word === '--')) { lead = 'time'; atCommand = true; return; }
      if (word === '[[') { inCond = true; atCommand = false; return; }
      if (word === 'case') { caseWords = 2; atCommand = false; return; }
      if (prev === 'coproc') { atCommand = true; return; } // `coproc NAME` may take a compound command
      if (word === 'function' || word === 'coproc' || word === 'time' || word === 'for') lead = word;
      atCommand = COMMAND_POSITION_WORDS.has(word);
    };
    while (i < str.length) {
      const ch = str[i];
      if (ch === '\\' && str[i + 1] === '\n') { i += 2; continue; } // a continuation joins the lines
      if (ch === ' ' || ch === '\t') { endWord(); i++; continue; }
      if (ch === '\n') {
        endWord();
        atCommand = true;
        i++;
        if (heredocTags.length) {
          const r = consumeHeredocBodies(str, i, heredocTags, '}');
          if (r.split && funsubDepth === 1) funsubSplits.push(r.end);
          i = r.end;
          heredocTags = [];
        }
        continue;
      }
      if (!inWord) {
        if (ch === '#') {
          const j = str.indexOf('\n', i);
          i = j === -1 ? str.length : j;
          continue;
        }
        if (ch === '}' && atCommand && !inCond && !casePattern) {
          if (groups === 0) {
            for (const t of heredocTags) funsubTags.push(t);
            return i;
          }
          groups--;
          i++;
          continue;
        }
        if (ch === '{' && (atCommand || braceOk) && !inCond && !casePattern && /[ \t\n]/.test(str[i + 1] || '')) {
          braceOk = false;
          groups++;
          i++;
          continue;
        }
      }
      if (ch === '<' && str[i + 1] === '<' && str[i + 2] === '<') { endWord(); i += 3; continue; } // a here-string
      if (ch === '<' && str[i + 1] === '<') {
        endWord();
        const tag = readFunsubHeredocTag(str, i + 2);
        heredocTags.push(tag);
        i = tag.end;
        continue;
      }
      if ((ch === '<' || ch === '>') && str[i + 1] === '(') {
        endWord();
        i = findParenClose(str, i + 2) + 1;
        continue;
      }
      // `name=(` opens an array's elements, where `}` and `(` are words.
      if (ch === '(' && inWord && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(word)) {
        word += '\0';
        i = findArrayClose(str, i + 1) + 1;
        continue;
      }
      if (ch === '(' && str[i + 1] === '(') {
        endWord();
        // an arithmetic command, where `<<` is a shift; `((cmd) )` is two subshells.
        // A failed attempt drops the pending tags its nested substitutions
        // left: the reading below meets them again and adds them once. Kept,
        // each enclosing failed `((` would double them, and memory with them.
        const tagMark = funsubTags.length;
        const e = atCommand || lead === 'for' ? findArithClose(str, i + 2) : -1;
        if (e === -1) funsubTags.length = tagMark;
        if (e !== -1) {
          lead = '';
          braceOk = false;
          atCommand = true; // `(( 1 )) }` closes; `for ((…)) { …; }` opens a group
          i = e + 1;
          continue;
        }
      }
      if (ch === ';' || ch === '&' || ch === '|' || ch === '(' || ch === ')') {
        endWord();
        braceOk = false;
        atCommand = true;
        if (ch === ')' && casePattern) casePattern = false; // the clause's commands follow
        if (ch === '(' && casePattern) patternStart = false;
        // `;;`, `;&` and `;;&` end a clause; a pattern list follows
        if (ch === ';' && !inCond && (str[i + 1] === ';' || str[i + 1] === '&')) {
          casePattern = true;
          patternStart = true;
          i += str[i + 1] === ';' && str[i + 2] === '&' ? 3 : 2;
          continue;
        }
        i++;
        continue;
      }
      if (ch === '<' || ch === '>') { endWord(); i++; continue; }
      if (!inWord) { inWord = true; wordAtCommand = atCommand; word = ''; }
      if (ch === '\\') { word += '\0'; i += 2; continue; }
      if (ch === "'") {
        word += '\0';
        const j = str.indexOf("'", i + 1);
        i = j === -1 ? str.length : j + 1;
        continue;
      }
      if (ch === '"') { word += '\0'; i = skipDoubleQuoted(str, i + 1); continue; }
      if (ch === '`') {
        word += '\0';
        const j = str.indexOf('`', i + 1);
        i = j === -1 ? str.length : j + 1;
        continue;
      }
      if (ch === '$' && str[i + 1] === '(') { word += '\0'; i = findParenClose(str, i + 2) + 1; continue; }
      if (isFunsubOpen(str, i) && funsubDepth < MAX_FUNSUB_DEPTH) { word += '\0'; i = findFunsubClose(str, funsubStart(str, i)) + 1; continue; }
      if (ch === '$' && str[i + 1] === '{') { word += '\0'; i = findParamClose(str, i + 2) + 1; continue; }
      word += ch;
      i++;
    }
    return str.length;
  } finally {
    funsubDepth--;
  }
}

// `$( )`, function-substitution and backtick spans inside an unquoted heredoc
// body.
function collectSubstitutions(body, nested) {
  let i = 0;
  while (i < body.length) {
    // `\${ ` is text; `\\` is one escaped backslash, so a `${ ` after it opens one.
    if (body[i] === '\\' && (body[i + 1] === '\\' || funsubOpenerAt(body, i + 1))) { i += 2; continue; }
    if (body[i] === '$' && body[i + 1] === '(') {
      const e = findParenClose(body, i + 2);
      nested.push(body.slice(i + 2, e));
      i = e + 1;
      continue;
    }
    if (isFunsubOpen(body, i)) {
      const e = findFunsubClose(body, funsubStart(body, i));
      nested.push(funsubBody(body, i, e));
      takeFunsubTags(); // bash expands the word alone; the next lines stay this body
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
// target). Nested command strings are collected separately.
function tokenize(str) {
  const tokens = [];
  const nested = [];
  let buf = '';
  let quoted = 'none';
  let hasWord = false;
  let seg = 0;
  let heredocs = [];
  let funsubHeredocs = []; // bash reads these before the line's own heredocs
  let expectTag = null;

  const flush = () => {
    if (!hasWord) return;
    if (expectTag) {
      // Record the current seg (still the `<<` segment — flush runs before the
      // newline sep increments it) so pass 2 can attach the body to the shell.
      heredocs.push({ tag: buf, quoted: quoted !== 'none', stripTabs: expectTag.stripTabs, seg });
      expectTag = null;
    } else {
      tokens.push({ kind: 'word', text: buf, quoted, seg });
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
  // A function substitution opened at `j`: its body is a nested command, and a
  // heredoc it left pending is read from the next line into that body.
  const funsub = (j) => {
    const e = findFunsubClose(str, funsubStart(str, j));
    nested.push(funsubBody(str, j, e));
    for (const t of takeFunsubTags()) funsubHeredocs.push({ ...t, seg, into: nested.length - 1 });
    return e + 1;
  };

  let i = 0;
  while (i < str.length) {
    const ch = str[i];

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
        const c = str[i];
        if (c === '\\' && i + 1 < str.length && '"\\$`\n'.includes(str[i + 1])) {
          if (str[i + 1] !== '\n') buf += str[i + 1];
          i += 2;
          continue;
        }
        if (c === '$' && str[i + 1] === '(') {
          const e = findParenClose(str, i + 2);
          nested.push(str.slice(i + 2, e));
          i = e + 1;
          continue;
        }
        if (isFunsubOpen(str, i)) {
          i = funsub(i);
          continue;
        }
        if (c === '`') {
          const j = str.indexOf('`', i + 1);
          const e = j === -1 ? str.length : j;
          nested.push(str.slice(i + 1, e));
          i = e + 1;
          continue;
        }
        buf += c;
        i++;
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
      const e = findParenClose(str, i + 2);
      nested.push(str.slice(i + 2, e));
      if (expectTag && heredocTagsAsWords) buf += str.slice(i, e + 1); // #5513: the tag is taken literally
      i = e + 1;
      continue;
    }

    if (isFunsubOpen(str, i)) {
      hasWord = true;
      i = funsub(i);
      continue;
    }

    if (ch === '$' && str[i + 1] === '{') {
      hasWord = true;
      const j = str.indexOf('}', i);
      const e = j === -1 ? str.length - 1 : j;
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
      const e = findParenClose(str, i + 2);
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
      if (heredocs.length || funsubHeredocs.length) {
        const r = consumeHeredocBodies(str, i, funsubHeredocs.concat(heredocs));
        for (const b of r.bodies) {
          if (b.into !== undefined) { nested[b.into] += '\n' + b.body + b.tag + '\n'; continue; }
          // Emit a heredoc token per body (quoted included) — the body is the
          // stdin script only a shell interpreter runs. Kept out of `words`.
          tokens.push({ kind: 'heredoc', text: b.body, quoted: b.quoted, seg: b.seg });
          if (!b.quoted) collectSubstitutions(b.body, nested); // bash expands $( ) here
        }
        heredocs = [];
        funsubHeredocs = [];
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
    if (ch === '(' || ch === ')') {
      sep(ch);
      i++;
      continue;
    }
    if ((ch === '{' || ch === '}') && !hasWord && (i + 1 >= str.length || /[\s;&|)]/.test(str[i + 1]))) {
      sep(ch);
      i++;
      continue;
    }

    hasWord = true;
    buf += ch;
    i++;
  }
  flush();
  return { tokens, nested };
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
    // getopt_long accepts any unambiguous prefix (`--adj 5`).
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
function reconstructedProcsub(inner) {
  const { tokens } = tokenize(inner);
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
// every other command.
function findSecretReadUnderOtherReadings(command) {
  if (!command.includes('<<')) return null;
  for (const [bodiesSkipped, tagsAsWords] of [[false, true], [true, false]]) {
    heredocBodiesSkippedInSpans = bodiesSkipped;
    heredocTagsAsWords = tagsAsWords;
    try {
      const hit = findSecretRead(command, 0);
      if (hit) return hit;
    } finally {
      heredocBodiesSkippedInSpans = true;
      heredocTagsAsWords = true;
    }
  }
  return null;
}

// Returns the offending token text, or null.
function findSecretRead(command, depth) {
  const { tokens, nested } = tokenize(command);

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
          else if (t.read && namesSecret(target.text)) return target.text;
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
          const src = reconstructedProcsub(w.procsub);
          if (src !== null) {
            const hit = findSecretRead(src, depth + 1);
            if (hit) return hit;
          }
        } else if (operandNamesSecret(w.text)) return w.text;
      }
      continue;
    }

    // xargs turns stdin file names into a sub-command's operands.
    if (base === 'xargs' && depth < MAX_NESTING_DEPTH) {
      const hit = scanXargsPipe(operands, s, bySeg, sepAfter, depth);
      if (hit) return hit;
      // `.env` given to xargs itself (`xargs -a .env cat`) is an ordinary
      // operand — fall through to the operand check below.
    }

    if (SHELL_INTERPRETERS.has(base) && depth < MAX_NESTING_DEPTH) {
      const hit = scanShellInterpreter(operands, heredocs, hereStrings, s, bySeg, sepAfter, depth);
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
      if (operandNamesSecret(operands[k].text)) return operands[k].text;
    }
  }
  return null;
}

// The hook cannot know which bash runs the command, and bash 5.3 reads a
// `${ …` opener as a function substitution where every earlier bash reads a
// parameter expansion (isFunsubOpen). When the first scan met one anywhere —
// in the command or in a script it derived, such as a `bash -c` operand whose
// quotes hid the opener from the raw text — the command is scanned again under
// the second reading, and either one's hit is returned. The second reading is
// the scan as it was before #5518, so nothing it blocked is allowed; when the
// first met no opener the two are the same scan. That holds when the first
// reading throws after meeting one, too (a stack overflow on a deep chain):
// the second still runs, and the error is rethrown only when it finds nothing.
// The handler calls the first scan itself, after beginBashReadings, so it
// starts at the stack depth it did before #5518 and overflows where it did.
// `otherReadings` (findSecretReadUnderOtherReadings, #5513) runs under the
// second reading: its heredoc readings are bash 3.2's and the guard's earlier
// one, and neither reads a function substitution. A first scan that throws
// before meeting an opener is rethrown at once, as its error ends the scan on
// `next` before the other readings run.
function beginBashReadings() {
  readFunsubs = true;
  funsubSeen = false;
  funsubTags = [];
}
function secondBashReading(scan, command, firstError, otherReadings) {
  if (!funsubSeen && firstError !== null) throw firstError;
  readFunsubs = false;
  try {
    let hit = funsubSeen ? scan(command, 0) : null;
    if (hit === null && otherReadings !== null) hit = otherReadings(command);
    if (hit !== null || firstError === null) return hit;
  } finally {
    readFunsubs = true;
  }
  throw firstError;
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
  const { tokens, nested } = tokenize(command);

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
function scanShellInterpreter(operands, heredocs, hereStrings, s, bySeg, sepAfter, depth) {
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
      const src = reconstructedProcsub(fileTok.procsub);
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
function scanXargsPipe(operands, s, bySeg, sepAfter, depth) {
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
    const hit = scanShellInterpreter(operands.slice(subIdx + 1), [], [], s, bySeg, sepAfter, depth);
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
    if (operandNamesSecret(w.text)) return w.text;
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
  if (code === 'glob-too-complex') {
    return `Secret read guard: the Grep glob '${target}' expands to more than ${MAX_GLOB_ALTERNATIVES} ` +
      'alternatives and cannot be checked for secret-file matches. Use a narrower glob.';
  }
  if (code === 'debugger-cli-spawn') {
    return `Debugger spawn guard: this Bash command launches the debugger as a CLI process ('--agent ${target}'). ` +
      'A shell-spawned debugger runs detached, returns no structured result, and the debug checkpoint never advances. ' +
      'Spawn it with the Agent tool instead: Agent(subagent_type="gsd-debugger", run_in_background=false, ...) ' +
      'and wait for its structured return.';
  }
  return `Secret read guard: ${tool} would read '${target}', which matches a protected secret-file ` +
    `pattern (${PATTERN_TEXT}). Secret values must not be read into the conversation. ` +
    'If you need a specific value, ask the user for it; if you need the variable NAMES, ' +
    'read the non-secret template (.env.example) instead.';
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

let input = '';
const stdinTimeout = setTimeout(() => allow(undefined), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = normalizeKimiPayload(JSON.parse(input));

    // A null/primitive payload has nothing to guard — exit deliberately
    // rather than throwing into the fail-open catch below (#2595 class).
    if (data === null || typeof data !== 'object') {
      allow(undefined);
    }

    const tool = bareToolName(data.tool_name);
    if (tool !== 'Read' && tool !== 'Grep' && tool !== 'Bash') {
      allow(undefined);
    }
    if (!data.tool_input || typeof data.tool_input !== 'object') {
      allow(undefined);
    }

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
        const verdict = classifyGrepGlob(glob);
        if (verdict) emitBlock(verdict, tool, glob);
      }
      allow(undefined);
    }

    // Bash
    const command = typeof data.tool_input.command === 'string' ? data.tool_input.command : '';
    if (command === '') allow(undefined);
    if (command.length > MAX_COMMAND_LENGTH) emitBlock('command-too-large', tool, '');
    let firstError = null;
    let hit = null;
    let secretError = null;
    beginBashReadings();
    try { hit = findSecretRead(command, 0); } catch (e) { firstError = e; }
    if (hit === null) {
      try { hit = secondBashReading(findSecretRead, command, firstError, findSecretReadUnderOtherReadings); } catch (e) { secretError = e; }
    }
    if (hit !== null) emitBlock('secret-read', tool, hit);
    // A secret-read scan that threw still lets the debugger-spawn scan run: on a
    // deep chain only the bash 5.3 reading can throw, and the base reading of the
    // same command may find a spawn there.
    firstError = null;
    let spawn = null;
    beginBashReadings();
    try { spawn = findDebuggerCliSpawn(command, 0); } catch (e) { firstError = e; }
    if (spawn === null) spawn = secondBashReading(findDebuggerCliSpawn, command, firstError, null);
    if (spawn !== null) emitBlock('debugger-cli-spawn', tool, spawn);
    if (secretError !== null) throw secretError;
    allow(undefined);
  } catch {
    // Fail open — never block valid tool calls due to hook errors.
    // ON_CRASH is declared ALLOW at module top (#3911).
    crash(ON_CRASH, undefined);
  }
});
