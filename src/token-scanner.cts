/**
 * token-scanner.cts — the tokenizer-first seam for stateful grammars (ADR-3212
 * §4, epic #3212 Phase 3, #3414).
 *
 * Source in src/token-scanner.cts, compiled to gsd-core/bin/lib/token-scanner.cjs
 * (gitignored), per the repo's ADR-457 build-at-publish convention.
 *
 * Generalizes the proven `hooks/lib/git-cmd.js` token-walk (#3129 — "has not
 * re-opened") into a primitive other stateful-grammar consumers can share.
 * `git-cmd.js` migrates onto `tokenizeShellLike` with zero behavior change
 * (ADR §6); its own env-prefix/flag/subcommand walk logic stays put — only
 * the character-level tokenizer moves here.
 *
 * `firstUnprovenMarker(command, marker)` is the conservative shell check the gate evaluator uses (#5482): it
 * names the first marker the walk cannot prove sits in plain double quotes.
 *
 * `indentWidth` is the primitive `src/decisions.cts`'s #3169 fix needs: a
 * decision-bullet list can NEST (a bullet elaborating on an already-open
 * decision, indented deeper than it), and a per-line regex cannot see that
 * nesting — only tracking indentation relative to the currently-open
 * decision can (ADR §4 criterion 1). See
 * .gsd/phase/chore-3414-tokenizer-first-seam/40-design.md §1.3 for the
 * disproven bold-run-content-classification alternative and why nesting
 * depth, not bullet content, is the actual distinguishing signal.
 */

/**
 * Tokenize a shell-like command string: whitespace-split, with single- and
 * double-quoted spans taken as one token each. No escape handling, no
 * brace/variable expansion — matches `hooks/lib/git-cmd.js`'s original
 * `tokenize()` exactly (parity-asserted in tests/token-scanner.test.cjs).
 */
export function tokenizeShellLike(cmd: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const len = cmd.length;

  while (i < len) {
    while (i < len && /\s/.test(cmd[i])) i++;
    if (i >= len) break;

    let token = '';
    while (i < len && !/\s/.test(cmd[i])) {
      if (cmd[i] === "'") {
        i++;
        while (i < len && cmd[i] !== "'") token += cmd[i++];
        if (i < len) i++;
      } else if (cmd[i] === '"') {
        i++;
        while (i < len && cmd[i] !== '"') token += cmd[i++];
        if (i < len) i++;
      } else {
        token += cmd[i++];
      }
    }
    if (token) tokens.push(token);
  }

  return tokens;
}

/**
 * Count a line's leading whitespace width. Tabs count as one column each
 * (not expanded) — matches `src/decisions.cts`'s existing continuation-line
 * check (`/^[ \t]/`), which never expanded tabs either; this function does
 * not introduce a new tab-width policy.
 */
export function indentWidth(line: string): number {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].length : 0;
}

/**
 * The name of the first `marker` (a `$name` or `${name`; capture group 1 is the name) that the walk cannot
 * prove `sh` expands, or `undefined` when every marker sits in plain double quotes. A conservative refusal,
 * not a shell parser (ADR-3212 §4: a quoting context needs a scanner). The walk follows only `'`, `"`, a
 * backslash and `${...}` depth. It refuses:
 * - a marker outside plain double quotes (unquoted, single-quoted, escaped by `\`, or after `$` as in `$$name`);
 * - a marker after a construct whose quoting the walk does not follow: `$(`, a backtick, `<<`, `$'`, a quote
 *   inside `${...}`, or a `#` that starts a word (a comment);
 * - a double-quoted marker in a word that a consumer parses again, in the same command (up to the last `;`, `&`,
 *   `|`, parenthesis or newline): after `eval` or `trap`, or the script word of `sh -c` (also `bash`, `dash`, `ksh`,
 *   `zsh`, `ash`; `find -exec` and `xargs` run them too). `eval` and `trap` count only as the command word: the first
 *   word that is no `NAME=value` and no reserved word (`if`, `then`, `do`, `{`, `!` ...). The outer shell has expanded the value into that text, so
 *   a value such as `x$(cmd)` runs. `sh -c '...' sh "$name"`, where the value is a later argument, is proven.
 *   A `&`, `|` or `(` of a redirection (`2>&1`, `>&2`, `&>`, `>|`, `<(`, `>(`) does not end the command, nor does the
 *   `)` that closes `<(` or `>(`.
 * - any marker in a command line that runs `xargs` (as the command word of a command) without `-0` or `-d` among its
 *   options: `xargs` splits and unquotes what it reads, and it reads pipe input, so the marker may sit before it.
 * A shell state the walk does not read therefore cannot hide a marker.
 */
export function firstUnprovenMarker(raw: string, marker: RegExp): string | undefined {
  // `sh` deletes an unescaped backslash-newline pair before it tokenizes, so `$\<nl>(` is `$(` and `$\<nl>NAME` is a marker.
  const command = raw.replace(/(?<!\\)((?:\\\\)*)\\\n/g, '$1');
  const at = new RegExp(marker.source, 'y');
  const markerAt = (i: number): string | undefined => {
    at.lastIndex = i;
    return at.exec(command)?.[1];
  };
  const splitsArgs = splitsWithXargs(command);
  let quote = '';
  let depth = 0;
  let wordStart = 0;
  let commandStart = 0;
  const isRedirectionChar = redirectionTracker();
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const here = markerAt(i);
    if (quote === "'") {
      if (here) return here;
      if (c === "'") quote = '';
    } else if (c === '\\') {
      const escaped = markerAt(i + 1);
      if (escaped) return escaped;
      i++;
    } else if (here && (quote !== '"' || command[i - 1] === '$')) {
      return here;
    } else if (here && quote === '"' && (splitsArgs || isReparsedWord(command.slice(commandStart, wordStart)))) {
      return here;
    } else if (isUnreadConstruct(command, i, quote, depth)) {
      return marker.exec(command.slice(i))?.[1];
    } else if (command.startsWith('${', i)) {
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
    } else if (quote === '"') {
      if (c === '"') quote = '';
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (depth === 0 && /[\s;&|()]/.test(c)) {
      wordStart = i + 1;
      const redirects = isRedirectionChar(command, i);
      if (/[;&|()\n]/.test(c) && !redirects) commandStart = i + 1;
    }
  }
  return undefined;
}

/**
 * A walk's test for a separator character that is part of a redirection, not the end of a command: the `&`, `|` or `(` of
 * `2>&1`, `>&2`, `&>`, `>|`, `<(`, `>(`, and the `)` that closes `<(` or `>(`. Call it for each separator of one text, in order.
 */
function redirectionTracker(): (text: string, i: number) => boolean {
  let procSubst = 0;
  return (text, i) => {
    const c = text[i];
    const prev = text[i - 1] ?? '';
    const opens = c === '(' && /[<>]/.test(prev);
    const redirects = (c === '&' && (/[<>]/.test(prev) || text[i + 1] === '>')) || (c === '|' && prev === '>') || opens || (c === ')' && procSubst > 0);
    if (opens) procSubst++;
    else if (redirects && c === ')') procSubst--;
    return redirects;
  };
}

const SHELL_WORD = /(?:^|\/)(?:ba|da|k|z|a)?sh$/;
const isAsciiLetter = (ch: string): boolean => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
/**
 * The `-c` option of a shell, alone or grouped (`-ec`, `-ce`): one dash, then letters only, at least one of them `c`.
 * The check reads the word one character at a time, so a cluster of any length (`-eeeeeeeeeeeeeeeeec`) is read the same.
 */
const isCOption = (word: string): boolean =>
  word.length > 1 && word.startsWith('-') && [...word.slice(1)].every(isAsciiLetter) && word.includes('c');
/** A shell option whose next word is its argument (`-o pipefail`, `+o errexit`, `-O extglob`). */
const SET_OPTION_WITH_ARG = /^[-+][oO]$/;
const XARGS_WORD = /(?:^|\/)xargs$/;
/** `xargs` short options whose argument is the rest of the group (`-n1`) or, when the group ends there, the next word (`-n 1`). */
const XARGS_ARG_OPTIONS = 'nPILsEa';
/** `xargs` short options whose optional argument is always attached (`-eEOF`, `-i{}`, `-l2`). */
const XARGS_ATTACHED_OPTIONS = 'eil';
/** `xargs` long options that take their argument as the next word (`--max-args 1`) unless it follows `=`. */
const XARGS_LONG_ARG_OPTIONS = new Set(['--max-args', '--max-procs', '--max-lines', '--max-chars', '--arg-file', '--process-slot-var']);

/**
 * The commands of a shell text, each as its words: split at command separators (`;`, `&`, `|`, parentheses, newline;
 * not the ones of a redirection) and at blanks outside quotes, with quotes and backslashes dropped (`"eval"`, `\sh`, `A="x y"` is the word `A=x y`).
 */
function shellCommands(text: string): string[][] {
  const commands: string[][] = [[]];
  let word = '';
  let inWord = false;
  let quote = '';
  const isRedirectionChar = redirectionTracker();
  const endWord = (): void => {
    if (inWord) commands[commands.length - 1].push(word);
    word = '';
    inWord = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'" || (c !== '\\' && quote === '"')) {
      if (c === quote) quote = '';
      else word += c;
    } else if (c === '\\') {
      word += text[++i] ?? '';
      inWord = true;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (/[\s;&|()]/.test(c) && !isRedirectionChar(text, i)) {
      endWord();
      if (c !== ' ' && c !== '\t') commands.push([]);
    } else {
      word += c;
      inWord = true;
    }
  }
  endWord();
  return commands;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that start a command without being its command word: `if true; then eval ...`, `{ trap ...; }`, `! eval ...`. */
const RESERVED_WORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '{', '!', 'time']);
/** The index of the command word of a command's words: the first word that is no `NAME=value`, no empty word and no reserved word; -1 when none. */
const commandWordIndex = (words: string[]): number => words.findIndex((w) => w !== '' && !ASSIGNMENT.test(w) && !RESERVED_WORDS.has(w));

/** A redirection word (`2>&1`, `>out`, `&>`): not an argument of the command; one that ends in its operator (`>`, `2>`, `>|`) takes the next word as its target. */
const REDIRECTION_WORD = /^(?:\d*|&)[<>]/;
/**
 * The index of the script word of a shell `-c` command (`sh -c '<script>' ...`): the first word after the first shell word
 * that is no option word (`-x`, `+x`, `-o name`, an empty word), provided a `-c` option stands before it. The script word
 * is the text the shell parses again; `bash scripts/check.sh -c "$x"` has none (the `-c` belongs to the script). Returns
 * `words.length` when the option words run to the end (the next word is the script word) and -1 when there is no `-c` shell.
 */
function scriptWordIndex(words: string[]): number {
  const shell = words.findIndex((w) => SHELL_WORD.test(w));
  if (shell < 0) return -1;
  let k = shell + 1;
  while (k < words.length && (words[k] === '' || /^[-+]/.test(words[k]) || REDIRECTION_WORD.test(words[k]))) {
    k += SET_OPTION_WITH_ARG.test(words[k]) || (REDIRECTION_WORD.test(words[k]) && /[<>|]$/.test(words[k])) ? 2 : 1;
  }
  return words.slice(shell + 1, k).some(isCOption) ? Math.min(k, words.length) : -1;
}

/**
 * True when the word that starts right after `head` (the text of its command up to that word) is text a consumer
 * parses as shell again: any word of a command whose command word is `eval` or `trap`, or the script word of `sh -c`.
 */
function isReparsedWord(head: string): boolean {
  const commands = shellCommands(head);
  const words = commands.flat();
  const commandWord = commands[0][commandWordIndex(commands[0])];
  return commandWord === 'eval' || commandWord === 'trap' || scriptWordIndex(words) === words.length;
}

/**
 * True when the xargs option word at `words[j]` (starting with `-`) sets a null or custom delimiter. `skip` is how many
 * following words the option takes as its argument, so `xargs -n 1 -0` and `xargs -0r` read as `-0` is the option.
 */
function xargsOption(words: string[], j: number): { delimited: boolean; skip: number } {
  const word = words[j];
  if (word === '--null' || word.startsWith('--delimiter')) return { delimited: true, skip: 0 };
  if (word.startsWith('--')) return { delimited: false, skip: XARGS_LONG_ARG_OPTIONS.has(word) ? 1 : 0 };
  for (let k = 1; k < word.length; k++) {
    if (word[k] === '0' || word[k] === 'd') return { delimited: true, skip: 0 };
    if (XARGS_ATTACHED_OPTIONS.includes(word[k])) return { delimited: false, skip: 0 };
    if (XARGS_ARG_OPTIONS.includes(word[k])) return { delimited: false, skip: k === word.length - 1 ? 1 : 0 };
  }
  return { delimited: false, skip: 0 };
}

/**
 * True when a command of the text runs `xargs` (as its command word) with no delimiter option among its option words:
 * `xargs` then splits and unquotes its input. The script word of a shell `-c` (`sh -c '... | xargs ls'`) is read as a text too.
 */
function splitsWithXargs(command: string): boolean {
  return shellCommands(command).some((words) => {
    const i = commandWordIndex(words);
    if (i < 0 || !XARGS_WORD.test(words[i])) {
      const script = scriptWordIndex(words);
      return script >= 0 && script < words.length && splitsWithXargs(words[script]);
    }
    let j = i + 1;
    while (j < words.length && words[j].startsWith('-') && words[j] !== '--') {
      const option = xargsOption(words, j);
      if (option.delimited) return false;
      j += 1 + option.skip;
    }
    return true;
  });
}

/** A construct at `i` whose quoting `firstUnprovenMarker` does not follow: a marker after it is unprovable. */
function isUnreadConstruct(command: string, i: number, quote: string, depth: number): boolean {
  const c = command[i];
  const two = command.slice(i, i + 2);
  if (two === '$(' || two === "$'" || two === '<<' || c === '`') return true;
  if (depth > 0) return c === "'" || c === '"';
  return c === '#' && quote === '' && (i === 0 || /[\s;&|()<>]/.test(command[i - 1]));
}
