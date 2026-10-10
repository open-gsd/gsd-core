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
//   located past `sudo`/`env VAR=x`/`nohup`-style prefixes; a closed set of
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
//   A shell interpreter (bash/sh/zsh/dash/ksh/su) has its script scanned
//   whether it arrives via `-c '…'`, a `<( )` file operand, a heredoc /
//   here-string, or a pipe from a knowable `echo`/`printf` source
//   (`echo cat .env | bash`); `eval` scans its joined operands; `source`/`.`
//   scans a `<( )` operand; and `find … | xargs cat` infers the upstream
//   segment's names as the sub-command's read operands.
//
// Dollar-quoting (#5255): `$'…'` is ANSI-C quoting in bash and zsh — `\'`
// does not close it and the word is its decoded value, so `$'.e\x6ev'` is
// `.env` — and `$` plus a plain quote in dash, the `sh` of Debian and Ubuntu.
// The hook cannot see which shell runs a command or a `sh -c` body, and each
// reading hides what the other one runs, so a command holding `$'` or `$"` is
// scanned under both and denied on either. A `$'…'` word with no value to
// check is denied too, with its own code: `ansi-c-unterminated` when the
// quote never closes, `ansi-c-undecodable` when its bytes are not valid UTF-8
// or it holds a literal NUL. An escaped NUL (`\0`) ends the span's value but
// not the word, and bash and zsh then read the word to different lengths —
// bash keeps the rest, zsh's kernel cuts the argument at the NUL — so the
// word is checked at BOTH lengths (`cat $'.env\0'x` is a zsh read of `.env`).
// A `$'…'` inside `${…}` is not read: `${…}` is taken whole, as before.
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
//   NON-gitignored `.env`. The promise is "no looser than the retired rules
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
//   #5255's `$'…'` handling adds its own, all shared with the pre-#5255
//   scanner and unreachable by a realistic command: a `\<newline>` line
//   continuation is modelled only where the main loop and `dollarRun` already
//   strip it, not inside a double-quoted heredoc-tag part read by other
//   scanners; a heredoc tag word (inside `$( )`) holding a `${…}`, a `$(…)`,
//   a backtick or a bare carriage return is read by the span-unaware path, so
//   its end can differ from bash's; and several-thousand-level nested `$( )`
//   overflows the parser and fails open under both the old and new scanner
//   (the new one carries a larger frame, so the depth at which it does is
//   somewhat lower) — bounded by the 1 MiB cap, and absent from a 423k-command
//   corpus. The decoder models BASH's `$'…'` value; zsh shares `\'`-does-not-
//   close and the common escapes but differs on some (`\C-x`, a bare `\x`/`\u`),
//   so a zsh-only escape that yields a NUL could truncate an argument the hook
//   reads at full length — unmeasured as a reachable read, named here so the
//   next editor weighs covering zsh's escape set.
//
// Triggers on: Read, Grep, Bash tool calls (Kimi: ReadFile, Grep, Shell)
// Action: BLOCK (decision: 'block', exit 2) — codes secret-read |
//         glob-too-complex | command-too-large | ansi-c-unterminated |
//         ansi-c-undecodable
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
// the head of a segment (same set as hooks/gsd-windsurf-pre-command.js).
const CMD_PREFIXES = new Set(['sudo', 'env', 'command', 'nice', 'nohup', 'time', 'doas']);

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

// git's global options (its own usage line, git 2.49), needed to locate the
// subcommand. A value option consumes the next word unless written
// `--opt=value`; an option in neither set fails closed, so a value is never
// read as the subcommand (`git -C ls-files show HEAD:.env` runs `show`).
const GIT_GLOBAL_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
const GIT_GLOBAL_FLAGS = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--no-lazy-fetch',
  '--no-optional-locks', '--no-advice', '--bare',
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

// A word token names a secret under EITHER shell's reading: its bash value
// (`text`) or, when a `\0` span cut it, zsh's shorter value (`altText`, set in
// tokenize). Returns the offending literal — the bash value when both match,
// since that is what the agent wrote — or null. `normalize` strips the
// `@file` / `--flag=value` / `-Xvalue` operand forms; a redirect target is a
// bare path and passes false.
function wordSecret(tok, normalize) {
  if (namesSecret(normalize ? normalizeOperand(tok.text) : tok.text)) return tok.text;
  if (tok.altText !== undefined && namesSecret(normalize ? normalizeOperand(tok.altText) : tok.altText)) return tok.altText;
  return null;
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
// Bash command scan — dollar-quoting (`$'…'`, `$"…"`)
// ---------------------------------------------------------------------------

// #5255: dollar-quoting has two readings, and which one applies depends on
// the shell that runs the text, which a hook cannot see. bash and zsh read
// `$'…'` as ANSI-C quoting: a backslash escapes the next character, so `\'`
// does not close the span, and the word's value is the decoded string
// (`$'.e\x6ev'` is `.env`). bash also reads `$"…"` as `"…"`. dash, which is
// `sh` on Debian and Ubuntu, has neither form: `$` is a literal and the quote
// after it is a plain one (zsh reads `$"…"` that way too). Each reading hides
// what the other one runs:
//   echo $'x\'y'; cat .env          bash and zsh run `cat .env`; the plain
//                                   reading sees a quote that never closes
//   echo $'x\'; cat .env; echo '\'  dash runs `cat .env`; the ANSI-C reading
//                                   sees one quoted word
// So a command holding either form is scanned under BOTH readings and denied
// on either (findSecretRead). The plain reading is the scan as it was before
// #5255, so nothing it denied can become allowed. Every scanner below takes
// `ansiC` to say which reading it is doing.
// Not reached, under either reading: `${…}` is still taken whole up to its
// first `}`, so a `$'…'` inside one is neither decoded nor checked for
// readability (the `$VAR` indirection gap in the header), and a command nested
// deeper than MAX_NESTING_DEPTH is not scanned at all.

// The run of `$` starting at `i`: `end` is the index just past it, `atQuote`
// whether a quote follows, and `owned` whether a `$` opens that quote. `$$`
// is the PID and pairs left to right, so only an odd `$` left over owns the
// quote: `$$'x'` is the PID and a plain 'x', `$$$'x'` is the PID and `$'x'`.
// Callers consume the whole run in one step — a megabyte of `$` is read once,
// not once per character.
function dollarRun(str, i) {
  let end = i;
  let dollars = 0;
  // bash removes `\<newline>` line continuations before it tokenizes, so one
  // does not break a run of `$`: `$\<newline>$'x'` is `$$'x'` to bash, a PID
  // and a plain quote, not ANSI-C quoting.
  for (;;) {
    if (str[end] === '$') { dollars++; end++; }
    else if (str[end] === '\\' && str[end + 1] === '\n') { end += 2; }
    else break;
  }
  const atQuote = str[end] === "'" || str[end] === '"';
  return { end, dollars, atQuote, owned: atQuote && dollars % 2 === 1 };
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

// Single-character escapes of `$'…'`, as byte values.
const ANSI_C_ESCAPES = new Map([
  ['a', 0x07], ['b', 0x08], ['e', 0x1b], ['E', 0x1b], ['f', 0x0c], ['n', 0x0a], ['r', 0x0d],
  ['t', 0x09], ['v', 0x0b], ['\\', 0x5c], ["'", 0x27], ['"', 0x22], ['?', 0x3f],
].map(([ch, byte]) => [ch.charCodeAt(0), byte]));

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function hexDigit(byte) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  return -1;
}

// The value bash gives the text between `$'` and its closing quote, in a
// UTF-8 locale: `{ value, nul }`, or null when the bytes are not valid UTF-8
// (`$'\xff'`, a surrogate or out-of-range `\U`) or the text holds a literal
// NUL, which no file name the guard classifies can be compared with. Works on bytes because bash does:
// `$'\xc3\xa9'` is one character. Escapes: the single characters above,
// `\nnn` (one to three octal digits), `\xHH` and `\x{H…}`, `\uHHHH`,
// `\UHHHHHHHH`, `\cX`; any other escape keeps its backslash. A NUL ends the
// value (`nul`) while the span still runs to its quote.
function decodeAnsiC(raw) {
  // A literal NUL (not an escape): bash drops it from a script it reads and no
  // shell can take it in an argument, so the span has no one value.
  if (raw.includes('\0')) return null;
  if (!raw.includes('\\')) return { value: raw, nul: false };
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
      // 0xff is never valid UTF-8: the strict decode below rejects the value
      // unless a NUL cut it off first, as bash's own encoding would be.
      else if (v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) out.push(0xff);
      else out.push(...Buffer.from(String.fromCodePoint(v), 'utf8'));
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
  try {
    return { value: UTF8_STRICT.decode(Uint8Array.from(cut === -1 ? out : out.slice(0, cut))), nul: cut !== -1 };
  } catch {
    return null;
  }
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

// Index of the `)` closing a `$(` / `<(` / `>(` opened just before `i`, or
// str.length when unterminated. Quote- and heredoc-aware so a `)` inside a
// quoted string or a heredoc body never closes the span early.
function findParenClose(str, i, ansiC) {
  let depth = 1;
  let heredocTags = [];
  while (i < str.length) {
    const ch = str[i];
    if (ch === '\\') { i += 2; continue; }
    if (ansiC && ch === '$') {
      const run = dollarRun(str, i);
      if (run.atQuote) {
        i = run.end; // a plain quote or `$"…"`: the branches below skip it
        if (run.owned && str[i] === "'") {
          const end = ansiCQuoteEnd(str, i);
          i = end === -1 ? str.length : end + 1;
        }
        continue;
      }
      // Any other run: only its last `$` can open `$(`, read below as before.
      if (run.end - i > 1) { i = run.end - 1; continue; }
    }
    if (ch === "'") {
      const j = str.indexOf("'", i + 1);
      i = j === -1 ? str.length : j + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < str.length && str[i] !== '"') {
        if (str[i] === '\\') { i += 2; continue; }
        if (str[i] === '$' && str[i + 1] === '(') { i = findParenClose(str, i + 2, ansiC) + 1; continue; }
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
    if (ch === '<' && str[i + 1] === '<' && str[i + 2] !== '<') {
      const tag = readHeredocTag(str, i + 2, ansiC);
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

// A heredoc tag word that holds a `$'…'` span, read whole the way tokenize
// reads a word — plain and double quotes, a backslash escape, the span's
// decoded value — so `<<$'E\x4fF'`, `<<E$'O'F` and `<<'E'$'O'F` all wait for
// `EOF`. Returns null for a word with no span: readHeredocTag then reads it
// exactly as it did before #5255.
function ansiCTagWord(str, i) {
  let tag = '';
  let sawSpan = false;
  while (i < str.length && !TAG_WORD_END_RE.test(str[i])) {
    const ch = str[i];
    if (ch === '\\') {
      if (i + 1 < str.length && str[i + 1] !== '\n') tag += str[i + 1]; // `\<newline>` continues the line
      i += 2;
    } else if (ch === '$') {
      const run = dollarRun(str, i);
      tag += str.slice(i, run.end - (run.owned ? 1 : 0));
      i = run.end; // at the quote, when there is one: the branches below read it
      if (run.owned && str[i] === "'") {
        const end = ansiCQuoteEnd(str, i);
        const raw = str.slice(i + 1, end === -1 ? str.length : end);
        const decoded = decodeAnsiC(raw);
        // An unreadable span is denied where tokenize meets it.
        tag += decoded === null ? raw : decoded.value;
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

// Reads the tag word after `<<` / `<<-` starting at `i`. Under the ANSI-C
// reading a word that holds a `$'…'` span is read whole (ansiCTagWord), and
// `<<$"EOF"` is `<<"EOF"`.
function readHeredocTag(str, i, ansiC) {
  let stripTabs = false;
  if (str[i] === '-') { stripTabs = true; i++; }
  while (str[i] === ' ' || str[i] === '\t') i++;
  if (ansiC) {
    const word = ansiCTagWord(str, i);
    if (word !== null) return { tag: word.tag, quoted: true, stripTabs, end: word.end };
  }
  let quoted = false;
  let tag = '';
  if (ansiC && str[i] === '$' && str[i + 1] === '"') i++;
  if (str[i] === "'" || str[i] === '"') {
    const q = str[i];
    const j = str.indexOf(q, i + 1);
    tag = str.slice(i + 1, j === -1 ? str.length : j);
    quoted = true;
    i = j === -1 ? str.length : j + 1;
  } else {
    if (str[i] === '\\') { quoted = true; i++; }
    while (i < str.length && !/[\s;&|<>()]/.test(str[i])) tag += str[i++];
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
function collectSubstitutions(body, nested, ansiC) {
  let i = 0;
  while (i < body.length) {
    if (body[i] === '$' && body[i + 1] === '(') {
      const e = findParenClose(body, i + 2, ansiC);
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
function tokenize(str, ansiC) {
  const tokens = [];
  const nested = [];
  let buf = '';
  let quoted = 'none';
  let hasWord = false;
  let seg = 0;
  let heredocs = [];
  let expectTag = null;
  let unreadable = null;
  // zsh's value of the current word when a `\0` span truncated it (see the
  // dollar branch); undefined when the word has no NUL span.
  let nulValue;

  const flush = () => {
    if (!hasWord) { nulValue = undefined; return; }
    if (expectTag) {
      // Record the current seg (still the `<<` segment — flush runs before the
      // newline sep increments it) so pass 2 can attach the body to the shell.
      heredocs.push({ tag: buf, quoted: quoted !== 'none', stripTabs: expectTag.stripTabs, seg });
      expectTag = null;
    } else {
      const tok = { kind: 'word', text: buf, quoted, seg };
      if (nulValue !== undefined) tok.altText = nulValue; // the shorter zsh reading
      tokens.push(tok);
    }
    buf = '';
    quoted = 'none';
    hasWord = false;
    nulValue = undefined;
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

    // Dollar-quoting, tested before the plain quote branches (see the
    // dollar-quoting section above).
    if (ansiC && ch === '$') {
      const run = dollarRun(str, i);
      if (run.atQuote) {
        // The `$` run (and any line continuation in it) up to the quote; the
        // `$` that owns a span is dropped, the rest is literal word text.
        const literal = str.slice(i, run.end - (run.owned ? 1 : 0));
        if (literal) { hasWord = true; buf += literal; }
        if (run.owned && str[run.end] === "'") {
          hasWord = true;
          if (quoted === 'none') quoted = 'single';
          const end = ansiCQuoteEnd(str, run.end);
          if (end === -1) {
            if (unreadable === null) unreadable = { code: 'ansi-c-unterminated', text: quoteExcerpt(str, run.end - 1) };
            i = str.length;
            continue;
          }
          const decoded = decodeAnsiC(str.slice(run.end + 1, end));
          if (decoded === null) {
            if (unreadable === null) unreadable = { code: 'ansi-c-undecodable', text: quoteExcerpt(str, run.end - 1) };
          } else {
            buf += decoded.value;
            // A `\0` escape ends the span's VALUE but not the word: bash drops
            // it and keeps reading the word (`$'.env\0'x` is `.envx`), while
            // zsh keeps the NUL and the kernel cuts the whole argument there
            // (`.env`). The word's bash value is `buf` as it ends; its zsh
            // value is `buf` AT THE FIRST NUL, recorded here so the operand
            // scan checks both — `cat $'.env\0'x` is a zsh read of `.env`.
            if (decoded.nul && nulValue === undefined) nulValue = buf;
          }
          i = end + 1;
          continue;
        }
        // A plain quote after the PID, or `$"…"` read as `"…"`: the quote
        // branches below take it from here.
        i = run.end;
        continue;
      }
      // Any other run: every `$` but the last is a literal, and the last is
      // read by the `$(` / `${` branches below, exactly as before.
      if (run.dollars > 1) {
        hasWord = true;
        buf += str.slice(i, run.end - 1);
        i = run.end - 1;
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
        const c = str[i];
        if (c === '\\' && i + 1 < str.length && '"\\$`\n'.includes(str[i + 1])) {
          if (str[i + 1] !== '\n') buf += str[i + 1];
          i += 2;
          continue;
        }
        if (c === '$' && str[i + 1] === '(') {
          const e = findParenClose(str, i + 2, ansiC);
          nested.push(str.slice(i + 2, e));
          i = e + 1;
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
      const e = findParenClose(str, i + 2, ansiC);
      nested.push(str.slice(i + 2, e));
      i = e + 1;
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
      i = e + 1;
      continue;
    }

    if ((ch === '<' || ch === '>') && str[i + 1] === '(') {
      flush();
      const e = findParenClose(str, i + 2, ansiC);
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
          if (!b.quoted) collectSubstitutions(b.body, nested, ansiC); // bash expands $( ) here
        }
        heredocs = [];
        i = r.end;
      }
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
  return { tokens, nested, unreadable };
}

// ---------------------------------------------------------------------------
// Bash command scan — pass 2: per-segment evaluation
// ---------------------------------------------------------------------------

// `@file` (curl -d), `--flag=value`, `-Xvalue` → the operand that names the file.
function normalizeOperand(text) {
  let v = text;
  if (v.startsWith('@')) v = v.slice(1);
  if (v.startsWith('--')) {
    const eq = v.indexOf('=');
    if (eq !== -1) v = v.slice(eq + 1);
  } else if (/^-[A-Za-z]./.test(v)) {
    v = v.slice(2);
  }
  return v;
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

// `-c`, or a combined short flag ending in `c` (`-lc`, `-ec`, `-euc`): mode c.
const DASH_C_RE = /^-[A-Za-z]*c$/;

const GROUPING_SEPS = new Set(['(', ')', '{', '}']);

// Command base + operands after leading `VAR=val` assignments and prefix
// wrappers (`sudo`, `env VAR=x`, …), or null when nothing but prefixes remain.
function resolveCommand(words) {
  let idx = 0;
  while (idx < words.length && ASSIGNMENT_RE.test(words[idx].text)) idx++;
  while (idx < words.length) {
    const base = lastSegment(words[idx].text).toLowerCase();
    if (!CMD_PREFIXES.has(base)) break;
    idx++;
    if (base === 'env') {
      while (idx < words.length && ASSIGNMENT_RE.test(words[idx].text)) idx++;
    }
  }
  if (idx >= words.length) return null;
  return { base: lastSegment(words[idx].text).toLowerCase(), operands: words.slice(idx + 1) };
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

// Index of git's subcommand past its global options, or -1 when an option
// outside GIT_GLOBAL_VALUE_OPTIONS / GIT_GLOBAL_FLAGS precedes it.
function gitSubcommandIndex(operands) {
  for (let k = 0; k < operands.length; k++) {
    const t = operands[k].text;
    if (!t.startsWith('-')) return k;
    if (GIT_GLOBAL_VALUE_OPTIONS.has(t)) { k++; continue; }
    if (GIT_GLOBAL_FLAGS.has(t)) continue;
    const eq = t.indexOf('=');
    const isLongValueForm = t.startsWith('--') && eq !== -1 && GIT_GLOBAL_VALUE_OPTIONS.has(t.slice(0, eq));
    if (!isLongValueForm) return -1;
  }
  return -1;
}

// #4856: the pathspec operands of a GIT_PATHSPEC_SUBCOMMANDS invocation. git
// permutes options, so one may follow a pathspec; after `--` every word is a
// pathspec. The subcommand is matched case-sensitively, as git looks it up.
function gitPathspecIndices(operands) {
  const sub = gitSubcommandIndex(operands);
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
function reconstructedProcsub(inner, ansiC) {
  const { tokens } = tokenize(inner, ansiC);
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

// Returns the offending token text, an unreadable-quote record
// (`{ code, text }`, see tokenize), or null. A command holding dollar-quoting
// is scanned under both readings (see the dollar-quoting section): the ANSI-C
// one first, then the plain one, which is the scan as it was before #5255.
// A command holding none gets one scan, which is the same under both.
function findSecretRead(command, depth) {
  if (!command.includes("$'") && !command.includes('$"')) return scanCommand(command, depth, true);
  let hit = null;
  try {
    hit = scanCommand(command, depth, true);
  } catch {
    // The ANSI-C reading decodes text the plain reading takes literally, so it
    // can reach code the plain one does not — a `bash -c $'…'` body whose
    // escaped quotes decode into thousands of nested `"$( )"` overflows the
    // stack in findParenClose. An error here must not cost the plain reading's
    // verdict, which is the one the guard gave before #5255.
  }
  if (hit !== null) return hit;
  return scanCommand(command, depth, false);
}

// One reading of `command`.
function scanCommand(command, depth, ansiC) {
  const { tokens, nested, unreadable } = tokenize(command, ansiC);

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
          else if (t.read) { const hit = wordSecret(target, false); if (hit) return hit; }
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
          const src = reconstructedProcsub(w.procsub, ansiC);
          if (src !== null) {
            const hit = findSecretRead(src, depth + 1);
            if (hit) return hit;
          }
        } else { const hit = wordSecret(w, true); if (hit) return hit; }
      }
      continue;
    }

    // xargs turns stdin file names into a sub-command's operands.
    if (base === 'xargs' && depth < MAX_NESTING_DEPTH) {
      const hit = scanXargsPipe(operands, s, bySeg, sepAfter, depth, ansiC);
      if (hit) return hit;
      // `.env` given to xargs itself (`xargs -a .env cat`) is an ordinary
      // operand — fall through to the operand check below.
    }

    if (SHELL_INTERPRETERS.has(base) && depth < MAX_NESTING_DEPTH) {
      const hit = scanShellInterpreter(operands, heredocs, hereStrings, s, bySeg, sepAfter, depth, ansiC);
      if (hit) return hit;
      // `bash .env` (file mode) is caught by the operand check below.
    }

    if (NON_READING_COMMANDS.has(base)) continue;

    const nameOnly = nameOnlyOperandIndices(base, operands);
    for (let k = 0; k < operands.length; k++) {
      if (nameOnly.has(k)) continue;
      const hit = wordSecret(operands[k], true); if (hit) return hit;
    }
  }
  // No secret read found; a `$'…'` word with no value to check still denies.
  return unreadable;
}

// A shell interpreter's script comes from `-c`, a file operand, or stdin.
function scanShellInterpreter(operands, heredocs, hereStrings, s, bySeg, sepAfter, depth, ansiC) {
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
      const src = reconstructedProcsub(fileTok.procsub, ansiC);
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
function scanXargsPipe(operands, s, bySeg, sepAfter, depth, ansiC) {
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
    const hit = scanShellInterpreter(operands.slice(subIdx + 1), [], [], s, bySeg, sepAfter, depth, ansiC);
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
    { const hit = wordSecret(w, true); if (hit) return hit; }
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
  if (code === 'ansi-c-unterminated') {
    return `Secret read guard: the $'…' quote at ${target} never closes, so the rest of this Bash ` +
      'command cannot be checked for secret-file reads. Close the quote, or use plain quotes.';
  }
  if (code === 'ansi-c-undecodable') {
    return `Secret read guard: the $'…' word at ${target} has no single value to check for a ` +
      'secret-file name: its bytes are not valid UTF-8, or it holds a NUL, which shells cut ' +
      'differently. Spell the word with plain quotes, or let the command decode the bytes itself ' +
      "(printf '\\xNN').";
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
    const hit = findSecretRead(command, 0);
    if (hit !== null && typeof hit === 'object') emitBlock(hit.code, tool, hit.text);
    if (hit !== null) emitBlock('secret-read', tool, hit);
    allow(undefined);
  } catch {
    // Fail open — never block valid tool calls due to hook errors.
    // ON_CRASH is declared ALLOW at module top (#3911).
    crash(ON_CRASH, undefined);
  }
});
