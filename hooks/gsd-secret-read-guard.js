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
//
// Triggers on: Read, Grep, Bash tool calls (Kimi: ReadFile, Grep, Shell)
// Action: BLOCK (decision: 'block', exit 2) — codes secret-read |
//         glob-too-complex | command-too-large
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

// Index just past the newline at `i`. A heredoc opened inside a nested `$( )`
// that closed before its body began is an orphan: bash reads its body from
// the lines after the next newline, wherever that newline falls — in the span
// around it, a sibling span or a quoted string. Every reader below steps over
// a newline through here, so those lines are passed over by whichever one
// reaches them. `ctx.orphans` is that list, shared by the nested readers of
// one findParenClose call. It is only ever appended to, or replaced here by a
// new empty one, which is what lets a read-ahead be undone by truncating.
function afterNewline(str, i, ctx) {
  if (ctx.orphans.length === 0) return i + 1;
  const end = heredocBodiesEnd(str, i + 1, ctx.orphans);
  ctx.orphans = [];
  return end;
}

// Index just past the quoted span that starts at `i` — a backslash pair, a
// '…' or "…" string (the `$( )` and backtick bodies inside "…" skipped whole)
// or a backtick span — or -1 when `str[i]` starts none.
function skipQuoted(str, i, ctx) {
  const ch = str[i];
  if (ch === '\\') return i + 2;
  if (ch === "'" || ch === '`') {
    i++;
    while (i < str.length && str[i] !== ch) {
      // A backslash escapes inside backticks, never inside '…'.
      if (ch === '`' && str[i] === '\\') { i += 2; continue; }
      i = str[i] === '\n' ? afterNewline(str, i, ctx) : i + 1;
    }
    return i + 1;
  }
  if (ch === '"') {
    i++;
    while (i < str.length && str[i] !== '"') {
      if (str[i] === '\\') { i += 2; continue; }
      if (str[i] === '$' && str[pastContinuations(str, i + 1, ctx)] === '(') {
        i = findParenClose(str, pastContinuations(str, i + 1, ctx) + 1, ctx) + 1;
        continue;
      }
      if (str[i] === '`') { i = skipQuoted(str, i, ctx); continue; }
      i = str[i] === '\n' ? afterNewline(str, i, ctx) : i + 1;
    }
    return i + 1;
  }
  return -1;
}

// Index of the `}` closing a `${` opened just before `i`, or str.length when
// unterminated. The first unquoted `}` closes it; a nested `${` or `$(` is
// skipped whole.
function findBraceClose(str, i, ctx) {
  while (i < str.length) {
    const q = skipQuoted(str, i, ctx);
    if (q !== -1) { i = q; continue; }
    const next = pastContinuations(str, i + 1, ctx);
    if (str[i] === '$' && str[next] === '(') { i = findParenClose(str, next + 1, ctx) + 1; continue; }
    if (str[i] === '$' && str[next] === '{') { i = findBraceClose(str, next + 1, ctx) + 1; continue; }
    if (str[i] === '}') return i;
    i = str[i] === '\n' ? afterNewline(str, i, ctx) : i + 1;
  }
  return str.length;
}

// Index of the `)` matching a `(` opened just before `i` by counting parens
// alone, or str.length when unterminated: the reading bash gives text that is
// not a command list — an arithmetic expression, an extended-glob group, or
// an array literal (`words` set: its elements are shell words, so a `#`
// starts a comment, `<( )` is a span of its own, and a newline starts the body
// of a heredoc the span around it has waiting, `pending`). Quoted spans,
// `${ }` and `$( )` are skipped whole.
function findPlainParenClose(str, i, words, ctx, pending) {
  let depth = 1;
  let wordStart = true;
  while (i < str.length) {
    if (str[i] === '\\' && str[i + 1] === '\n') { i = pastContinuation(str, i, ctx); continue; }
    const q = skipQuoted(str, i, ctx);
    if (q !== -1) { i = q; wordStart = false; continue; }
    const ch = str[i];
    const next = pastContinuations(str, i + 1, ctx);
    if (ch === '$' && str[next] === '(') { i = findParenClose(str, next + 1, ctx) + 1; wordStart = false; continue; }
    if (ch === '$' && str[next] === '{') { i = findBraceClose(str, next + 1, ctx) + 1; wordStart = false; continue; }
    if (words && (ch === '<' || ch === '>') && str[next] === '(') { i = findParenClose(str, next + 1, ctx) + 1; wordStart = false; continue; }
    if (words && ch === '#' && wordStart) {
      const j = str.indexOf('\n', i);
      i = j === -1 ? str.length : j;
      continue;
    }
    if (ch === '\n') {
      i = afterNewline(str, i, ctx);
      if (pending && pending.length) {
        i = heredocBodiesEnd(str, i, pending);
        pending.length = 0;
      }
      wordStart = true;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    wordStart = ch === ' ' || ch === '\t' || ch === '(';
    i++;
  }
  return str.length;
}

// Tokens after which a command can start, so a `case` read there is the
// keyword; anywhere else it is an ordinary word. This is bash's rule for where
// a word is reserved, less the places its grammar then rejects a new command.
// Reserved words are named by their own text. `word` is any other word,
// `redir` a redirection operator, `arith` a `(( ))` command, `pat)` the paren
// that ends a case pattern, `fn()` the parens of a function definition, and
// `sub)` the paren that closes a subshell.
const RESERVED_WORD_FOLLOWS = new Set([
  'start', '\n', ';', '&', '&&', '|', '|&', '||', '(', 'pat)', 'fn()', '{', '}', '!', ']]', 'arith',
  'if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'esac',
  'time', 'time -p', 'time --', 'coproc',
]);
// After a subshell closes, only a word that continues the construct around it
// is reserved: `if (a) then`, `while (a) do`, `{ (a) }`. A command cannot start
// there, so `(a) case x in y` holds no `case` command.
const SUBSHELL_FOLLOWS = new Set(['then', 'do', 'done', 'fi', 'esac', 'elif', 'else', '}']);
// `time` is reserved only where a pipeline can start, so not after `|`.
const TIME_FOLLOWS = new Set([
  '&', '&&', '||', '(', 'pat)', '{', '!', 'if', 'then', 'else', 'elif', 'while', 'until', 'do',
  'time', 'time -p', 'time --',
]);
// Reserved words that need no handling beyond being recorded as the last token.
const PLAIN_RESERVED = new Set(['!', 'if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'for', 'select', 'function', 'coproc']);

// Deciding whether `((` opens an arithmetic command reads ahead over text the
// scan then reads again. This caps the total, and no read-ahead starts inside
// another, so neither a run of `((` nor a nest of them can make one command
// quadratic; where it does not read ahead, `((` is read as two subshells.
let probeBudget = MAX_COMMAND_LENGTH;

// Which bash runs the command decides where a span closes, and the hook
// cannot know which one will. bash 5 closes it where its grammar does, so a
// `case` pattern's `)` closes nothing. bash 3.2, still the /bin/bash macOS
// ships, counts parens: it ends `"$(case x in y)"; cat .env` at the pattern
// and runs the `cat`, a line bash 5 rejects whole. findSecretReadEitherClose
// therefore scans a command under both; `closeByCount` selects the second
// reading, and `spanSeen` records that a span was met at all, since only
// then can the two differ.
let closeByCount = false;
let spanSeen = false;

// Index of the `)` closing a `$(` / `<(` / `>(` opened just before `i`, or
// str.length when unterminated: the `)` bash 5 closes the span at, or under
// `closeByCount` the one paren counting does. To bash 5 a `)` is not that one
// when it sits in a quoted string, a heredoc body, a comment, a `${ }`, or
// ends a `case` pattern — `$(case x in x) cat .env;; esac)` runs to its last
// `)` (#5267). `ctx` is passed only by the readers above and below, for a
// span nested in the one they are reading.
function findParenClose(str, i, ctx) {
  if (ctx) return readParenClose(str, i, ctx);
  spanSeen = true;
  if (closeByCount) return countParenClose(str, i);
  try {
    return readParenClose(str, i, { orphans: [] });
  } catch (err) {
    // The readers recurse once per nested span, so a command that nests
    // thousands deep exhausts the stack. Left uncaught that ends in the
    // fail-open exit (ON_CRASH) and allows a command this hook used to deny.
    // The rest of the command is closed by count too: the counter can end
    // such a span early and leave the next `$(` to start the same climb, once
    // per level, which is quadratic.
    if (!(err instanceof RangeError)) throw err;
    closeByCount = true;
    return countParenClose(str, i);
  }
}

function readParenClose(str, i, ctx) {
  // `$((` / `<((`: bash finds this close by counting parens alone, whether the
  // text turns out to be arithmetic or a subshell.
  if (str[pastContinuations(str, i, ctx)] === '(') return findPlainParenClose(str, i, false, ctx);
  return scanCommandParenClose(str, i, ctx);
}

// Paren counting alone, quote- and heredoc-aware, with no reading of the
// commands: the span finder this file had before #5267, and the `closeByCount`
// reading. It walks unquoted nesting in a loop where the readers above
// recurse, which is why findParenClose also falls back to it for a command
// nested too deep for them.
function countParenClose(str, i) {
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
        if (str[i] === '$' && str[i + 1] === '(') { i = countParenClose(str, i + 2) + 1; continue; }
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

// findParenClose over a command list. It follows bash's rule for where a word
// is reserved far enough to know when a `case` is open, because only there is
// a `)` not a closing paren. One frame per open `case`: st 'subj' (its word is
// next), 'in' (`in` is next), 'pat' (a pattern list; pd = depth of
// extended-glob parens, start = nothing read yet) or 'body'. Only the top
// frame acts, and only at its own paren depth. Text that is not a command
// list (a comment, an array literal, arithmetic, an extended-glob group,
// `[[ ]]`) is passed over without reading keywords in it: a phantom `case`
// there would swallow the real `)` and hide what follows.
function scanCommandParenClose(str, i, ctx) {
  let depth = 1;
  // Heredocs this span's own commands opened. Their bodies start at this
  // span's next newline; a span nested here never reads them, and any still
  // waiting when the span closes become orphans (see afterNewline).
  const heredocTags = [];
  const frames = [];
  const close = (at) => {
    for (const tag of heredocTags) ctx.orphans.push(tag);
    return at;
  };
  let last = 'start';  // the last token read, and the one before it
  let prev = 'start';
  let braces = 0;      // open `{` groups: `}` is reserved only inside one
  let cond = 0;        // paren depth of an open `[[`, else 0
  let word = null;     // the word being read: { raw, quoted, lit, first }

  const token = (t) => { prev = last; last = t; };
  const reservedOk = (kw) => RESERVED_WORD_FOLLOWS.has(last) ||
    (last === 'sub)' && SUBSHELL_FOLLOWS.has(kw)) ||
    (last === 'word' && (prev === 'coproc' || prev === 'function'));
  const active = () => {
    const f = frames[frames.length - 1];
    return f && f.depth === depth ? f : null;
  };
  // A word part. `quoted`: a quoted, escaped or expanded part, which keeps the
  // word from being a keyword.
  const wordPart = (quoted) => {
    if (word === null) {
      const f = active();
      word = { raw: '', tail: '', quoted: false, lit: false, first: !!(f && f.st === 'pat' && f.start) };
      if (f && f.st === 'pat') f.start = false;
    }
    if (quoted) word.quoted = true;
    word.lit = !quoted;
  };
  const endWord = () => {
    if (word === null) return;
    const kw = word.quoted ? '' : word.raw;
    const first = word.first;
    word = null;
    if (cond) {
      if (kw === ']]' && depth === cond) { cond = 0; token(']]'); }
      return;
    }
    let f = active();
    if (f && f.st === 'subj') { f.st = 'in'; token('word'); return; }
    if (f && f.st === 'in') {
      if (kw === 'in') { f.st = 'pat'; f.start = true; f.pd = 0; token('in'); return; }
      frames.pop(); // bash rejects this; read on by paren counting
      f = active();
    }
    if (f && f.st === 'pat') {
      if (first && kw === 'esac') { frames.pop(); token('esac'); }
      return;
    }
    if (kw === '-p' && last === 'time') { token('time -p'); return; }
    if (kw === '--' && (last === 'time' || last === 'time -p')) { token('time --'); return; }
    if (last === 'word' && (prev === 'for' || prev === 'select') && (kw === 'in' || kw === 'do')) { token(kw); return; }
    if (!reservedOk(kw)) { token('word'); return; }
    if (kw === 'case') { frames.push({ depth, st: 'subj', pd: 0, start: false }); token('case'); return; }
    if (kw === 'esac') {
      if (f && f.st === 'body') frames.pop();
      token('esac');
      return;
    }
    if (kw === '[[') { cond = depth; token('[['); return; }
    if (kw === 'time') {
      const pipelineStart = last === 'start' || last === ';' || last === '\n' ? prev !== '|' : TIME_FOLLOWS.has(last);
      token(pipelineStart ? 'time' : 'word');
      return;
    }
    if (kw === '{') { braces++; token('{'); return; }
    if (kw === '}' && braces > 0) { braces--; token('}'); return; }
    token(PLAIN_RESERVED.has(kw) ? kw : 'word');
  };

  while (i < str.length) {
    const ch = str[i];
    if (ch === '\\' && str[i + 1] === '\n') { i = pastContinuation(str, i, ctx); continue; }
    const q = skipQuoted(str, i, ctx);
    if (q !== -1) { wordPart(true); i = q; continue; }
    // The next character bash reads: a line continuation between two
    // characters of an operator does not split it.
    const next = pastContinuations(str, i + 1, ctx);
    if (ch === '$' && str[next] === '(') { wordPart(true); i = findParenClose(str, next + 1, ctx) + 1; continue; }
    if (ch === '$' && str[next] === '{') { wordPart(true); i = findBraceClose(str, next + 1, ctx) + 1; continue; }
    // A process substitution is a part of the word it touches (`x<(a)` is one
    // word), in a command, a case subject or a pattern; inside `[[ ]]` a `<`
    // compares.
    if ((ch === '<' || ch === '>') && str[next] === '(' && !cond) {
      wordPart(true);
      i = findParenClose(str, next + 1, ctx) + 1;
      continue;
    }
    const top = active();
    const inGlobPattern = !!(top && top.st === 'pat' && top.pd > 0);
    if (ch === '#' && word === null && !inGlobPattern) {
      const j = str.indexOf('\n', i);
      i = j === -1 ? str.length : j;
      continue;
    }
    // Space and tab only. A carriage return is a word character to bash, so
    // `\rcase` is an ordinary word and must not open a pattern list.
    const blank = ch === ' ' || ch === '\t';
    if (!blank && ch !== '\n' && !';&|()<>'.includes(ch)) {
      wordPart(false);
      word.raw += ch;
      word.tail = ch; // read in place of word.raw's last character, which would flatten it
      i++;
      continue;
    }

    // A delimiter. Two `(` belong to the word before them and do not end it.
    if (ch === '(' && word !== null && !(top && top.st === 'pat')) {
      // `!(` where a command can start is `!` and a subshell with extglob
      // off, and an extended-glob word with it on. The two can close at
      // different parens and neither can be preferred without reading the
      // other mode wrong, so this one group is closed by the counter this
      // file had before, exactly as it was.
      if (word.raw === '!' && !word.quoted && !cond && reservedOk('!')) {
        word.quoted = true;
        i = countParenClose(str, i + 1) + 1;
        continue;
      }
      // An extended-glob group: `?(` `*(` `+(` `@(` `!(` inside a word.
      if (word.lit && '?*+@!'.includes(word.tail)) {
        word.quoted = true;
        i = findPlainParenClose(str, i + 1, false, ctx) + 1;
        continue;
      }
      // An array literal: `NAME=(` / `NAME+=(`.
      if (!cond && !word.quoted && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(word.raw)) {
        endWord();
        i = findPlainParenClose(str, i + 1, true, ctx, heredocTags) + 1;
        continue;
      }
    }
    endWord();
    if (blank) { i++; continue; }

    if (cond) {
      // Inside `[[ ]]` a paren groups, `<` / `>` compare, and no word is reserved.
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return close(i);
        if (depth < cond) cond = 0;
      }
      i = ch === '\n' ? afterNewline(str, i, ctx) : i + 1;
      continue;
    }

    let f = active();
    if (f && (f.st === 'subj' || f.st === 'in')) {
      if (ch === '\n' && f.st === 'in') { i = afterNewline(str, i, ctx); continue; }
      frames.pop(); // bash rejects this; read on by paren counting
      f = active();
    }
    if (f && f.st === 'pat') {
      if (f.pd > 0) {
        if (ch === '(') f.pd++;
        else if (ch === ')') f.pd--;
        i = ch === '\n' ? afterNewline(str, i, ctx) : i + 1;
        continue;
      }
      if (ch === '\n') { i = afterNewline(str, i, ctx); continue; }
      if (ch === '|') { i++; continue; }
      if (ch === '(') {
        if (f.start) f.start = false; // the optional paren before a pattern list
        else f.pd++;
        i++;
        continue;
      }
      if (ch === ')') { f.st = 'body'; token('pat)'); i++; continue; } // ends the pattern, not the span
      frames.pop(); // bash rejects this; read on by paren counting
      f = active();
    }
    if (f && f.st === 'body' && ch === ';' && (str[next] === ';' || str[next] === '&')) {
      f.st = 'pat';
      f.start = true;
      f.pd = 0;
      token(';;');
      const third = pastContinuations(str, next + 1, ctx);
      i = str[next] === ';' && str[third] === '&' ? third + 1 : next + 1;
      continue;
    }

    if (ch === '\n') {
      token('\n');
      i = afterNewline(str, i, ctx); // orphan bodies come first in the input
      if (heredocTags.length) {
        i = heredocBodiesEnd(str, i, heredocTags);
        heredocTags.length = 0;
      }
      continue;
    }
    if (ch === '<' || ch === '>') {
      token('redir');
      if (ch === '<' && str[next] === '<') {
        const third = pastContinuations(str, next + 1, ctx);
        if (str[third] === '<') { i = third + 1; continue; } // a here-string, not a heredoc
        const tag = readHeredocTagContinued(str, third, ctx);
        heredocTags.push(tag);
        token('word');
        i = tag.end;
        continue;
      }
      i = str[next] === '&' || str[next] === '>' || (ch === '>' && str[next] === '|') ? next + 1 : i + 1;
      continue;
    }
    if (ch === '&' && str[next] === '>') {
      token('redir');
      const third = pastContinuations(str, next + 1, ctx);
      i = str[third] === '>' ? third + 1 : next + 1;
      continue;
    }
    if (ch === ';') { token(';'); i++; continue; }
    if (ch === '&') {
      const two = str[next] === '&';
      token(two ? '&&' : '&');
      i = two ? next + 1 : i + 1;
      continue;
    }
    if (ch === '|') {
      const op = str[next] === '|' ? '||' : str[next] === '&' ? '|&' : '|';
      token(op);
      i = op === '|' ? i + 1 : next + 1;
      continue;
    }
    if (ch === '(') {
      if (last === 'word') {
        // `name()` / `name ( )`: the parens of a function definition.
        let j = i + 1;
        for (;;) {
          if (str[j] === ' ' || str[j] === '\t') j++;
          else if (str[j] === '\\' && str[j + 1] === '\n') j += 2;
          else break;
        }
        if (str[j] === ')') { token('fn()'); i = j + 1; continue; }
      }
      if (str[next] === '(' && (last === 'for' || reservedOk('((')) && probeBudget > 0) {
        // `((`: arithmetic when the inner paren's match is followed by `)`,
        // otherwise two subshells — bash decides it the same way.
        // The read-ahead shares the orphan list, and what it did to the list
        // is kept only if the text is arithmetic and the scan resumes past
        // it; otherwise its appends are dropped and the text is read again.
        const orphans = ctx.orphans;
        const waiting = orphans.length;
        const probe = { orphans };
        const budget = probeBudget;
        probeBudget = 0; // none inside this one: each would re-read its text
        const e = findPlainParenClose(str, next + 1, false, probe);
        probeBudget = budget - (e - i);
        if (e >= str.length) return close(str.length);
        const after = pastContinuations(str, e + 1, ctx);
        if (str[after] === ')') {
          ctx.orphans = probe.orphans;
          token('arith');
          i = after + 1;
          continue;
        }
        orphans.length = waiting;
      }
      depth++;
      token('(');
      i++;
      continue;
    }
    // ch === ')'
    depth--;
    if (depth === 0) return close(i);
    while (frames.length && frames[frames.length - 1].depth > depth) frames.pop();
    token('sub)');
    i++;
  }
  return close(str.length);
}

// Index of the first character at or after `i` that is not a line
// continuation. bash removes a backslash-newline before it reads a token, so
// an operator split by one is still that operator: `;\` newline `;` is `;;`.
// Not while an orphan heredoc waits (see afterNewline): bash starts its body
// at the next newline in the text, a continuation's included, so the reader
// stops there and pastContinuation reads the body.
function pastContinuations(str, i, ctx) {
  while (str[i] === '\\' && str[i + 1] === '\n' && !(ctx && ctx.orphans.length)) i += 2;
  return i;
}

// Index past the line continuation at `i`, and past any orphan heredoc bodies
// that start at its newline.
function pastContinuation(str, i, ctx) {
  return ctx.orphans.length ? afterNewline(str, i + 1, ctx) : i + 2;
}

// readHeredocTag for the readers above: the same tag, with the line
// continuations bash removes from an unquoted word removed from it, so
// `<<EO\` newline `F` waits for `EOF`. Inside quotes they stay.
function readHeredocTagContinued(str, i, ctx) {
  let stripTabs = false;
  i = pastContinuations(str, i, ctx);
  if (str[i] === '-') { stripTabs = true; i = pastContinuations(str, i + 1, ctx); }
  while (str[i] === ' ' || str[i] === '\t') i = pastContinuations(str, i + 1, ctx);
  if (str[i] === "'" || str[i] === '"') return { ...readHeredocTag(str, i), stripTabs };
  const ends = (c) => /[\s;&|<>()]/.test(c);
  let quoted = false;
  let tag = '';
  // A backslash quotes the character after it, which is then never the
  // start of a line continuation.
  if (str[i] === '\\') {
    quoted = true;
    i++;
    if (i < str.length && !ends(str[i])) tag += str[i++];
  }
  for (;;) {
    i = pastContinuations(str, i, ctx);
    if (i >= str.length || ends(str[i])) break;
    if (str[i] === '\\' && i + 1 < str.length && !ends(str[i + 1])) { tag += str[i] + str[i + 1]; i += 2; continue; }
    tag += str[i++];
  }
  return { tag, quoted, stripTabs, end: i };
}

// consumeHeredocBodies for the readers above, which need only where the
// bodies end. An unquoted body is read with its line continuations removed,
// as bash reads it, so a terminator line split by one still ends the body and
// a line that ends in one joins the next.
function heredocBodiesEnd(str, i, tags) {
  for (const t of tags) {
    let terminated = false;
    while (i < str.length) {
      let line = '';
      for (;;) {
        const nl = str.indexOf('\n', i);
        const part = str.slice(i, nl === -1 ? str.length : nl);
        i = nl === -1 ? str.length : nl + 1;
        if (!t.quoted && nl !== -1 && /(^|[^\\])(\\\\)*\\$/.test(part)) { line += part.slice(0, -1); continue; }
        line += part;
        break;
      }
      const probe = t.stripTabs ? line.replace(/^\t+/, '') : line;
      if (probe === t.tag) { terminated = true; break; }
    }
    if (!terminated) break;
  }
  return i;
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
function collectSubstitutions(body, nested) {
  let i = 0;
  while (i < body.length) {
    if (body[i] === '$' && body[i + 1] === '(') {
      const e = findParenClose(body, i + 2);
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
// target). Nested command strings are collected separately.
function tokenize(str) {
  const tokens = [];
  const nested = [];
  let buf = '';
  let quoted = 'none';
  let hasWord = false;
  let seg = 0;
  let heredocs = [];
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
      if (heredocs.length) {
        const r = consumeHeredocBodies(str, i, heredocs);
        for (const b of r.bodies) {
          // Emit a heredoc token per body (quoted included) — the body is the
          // stdin script only a shell interpreter runs. Kept out of `words`.
          tokens.push({ kind: 'heredoc', text: b.body, quoted: b.quoted, seg: b.seg });
          if (!b.quoted) collectSubstitutions(b.body, nested); // bash expands $( ) here
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
  return { tokens, nested };
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

// findSecretRead under each reading of where a span closes (see closeByCount):
// a read found in a command position under either reading is reported. The
// second scan is the one this hook made before #5267, so nothing it denied is
// allowed now. A command with no span reads the same both ways and is scanned
// once.
function findSecretReadEitherClose(command) {
  closeByCount = false;
  spanSeen = false;
  const hit = findSecretRead(command, 0);
  if (hit !== null || !spanSeen) return hit;
  closeByCount = true;
  return findSecretRead(command, 0);
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
        } else if (namesSecret(normalizeOperand(w.text))) return w.text;
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

    if (NON_READING_COMMANDS.has(base)) continue;

    const nameOnly = nameOnlyOperandIndices(base, operands);
    for (let k = 0; k < operands.length; k++) {
      if (nameOnly.has(k)) continue;
      if (namesSecret(normalizeOperand(operands[k].text))) return operands[k].text;
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
    if (namesSecret(normalizeOperand(w.text))) return w.text;
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
    const hit = findSecretReadEitherClose(command);
    if (hit !== null) emitBlock('secret-read', tool, hit);
    allow(undefined);
  } catch {
    // Fail open — never block valid tool calls due to hook errors.
    // ON_CRASH is declared ALLOW at module top (#3911).
    crash(ON_CRASH, undefined);
  }
});
