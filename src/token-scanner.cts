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
 *   `zsh`, `ash`; `find -exec` and `xargs` run them too). A `&` of a redirection (`2>&1`, `>&2`, `&>`) does not end the command. The outer shell has expanded the value into that text, so
 *   a value such as `x$(cmd)` runs. `sh -c '...' sh "$name"`, where the value is a later argument, is proven.
 * - any marker in a command line that runs `xargs` without `-0` or `-d` among its options: `xargs` splits and
 *   unquotes what it reads, and it reads pipe input, so the marker may sit before it.
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
      // A `&` that belongs to a redirection (`2>&1`, `>&2`, `&>`) does not end the command.
      const redirects = c === '&' && (/[<>]/.test(command[i - 1] ?? '') || command[i + 1] === '>');
      if (/[;&|()\n]/.test(c) && !redirects) commandStart = i + 1;
    }
  }
  return undefined;
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

/** The words of a shell text, split at blanks and command separators, with quotes and backslashes dropped (`"eval"`, `\sh`). */
function shellWords(text: string): string[] {
  return text.split(/[\s;&|()]+/).map((word) => word.replace(/['"\\]/g, ''));
}

/**
 * True when the word that starts right after `head` (the text of its command up to that word) is text a consumer
 * parses as shell again: any word after `eval` or `trap`, or the script word of `sh -c` (the word after the
 * trailing option words, one of which holds `c`).
 */
function isReparsedWord(head: string): boolean {
  const words = shellWords(head);
  if (words.includes('eval') || words.includes('trap')) return true;
  let k = words.length;
  while (k > 0) {
    if (words[k - 1] === '' || /^[-+]/.test(words[k - 1])) k--;
    else if (k > 1 && SET_OPTION_WITH_ARG.test(words[k - 2])) k -= 2;
    else break;
  }
  return words.slice(k).some(isCOption) && words.slice(0, k).some((w) => SHELL_WORD.test(w));
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

/** True when the command runs an `xargs` with no delimiter option among its option words: `xargs` then splits and unquotes its input. */
function splitsWithXargs(command: string): boolean {
  const words = shellWords(command);
  return words.some((word, i) => {
    if (!XARGS_WORD.test(word)) return false;
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
