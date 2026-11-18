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
 *   inside `${...}`, a `#` that starts a word (a comment), or the word `eval` or `trap`;
 * - a marker inside a double-quoted part of the shell word that follows a `-c` option word (`sh -c "...${name}..."`,
 *   `sh -c 'a '"${name}"`, also after further option words as in `sh -c -e "..."`): the outer shell pastes the
 *   value into the script text, where shell syntax in the value would run. Option words are `-x` and `--`, found
 *   by a forward word walk over each word with its quotes and backslashes dropped (`'-c'` is `-c`), not a regex over
 *   caller text (ADR-3212 §5).
 * A shell state the walk does not read therefore cannot hide a marker.
 */
export function firstUnprovenMarker(command: string, marker: RegExp): string | undefined {
  const at = new RegExp(marker.source, 'y');
  const markerAt = (i: number): string | undefined => {
    at.lastIndex = i;
    return at.exec(command)?.[1];
  };
  let quote = '';
  let depth = 0;
  let script = false; // inside the shell word that follows a `-c` option word
  let run = false; // the option words right before this word hold a `c`
  let wordStart = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const here = markerAt(i);
    if (quote === '' && depth === 0) {
      if (/\s/.test(c)) {
        if (i > wordStart) {
          const word = command.slice(wordStart, i).replace(/['"\\]/g, ''); // the shell unquotes `'-c'` to `-c`
          run = word === '--' || /^-[A-Za-z]+$/.test(word) ? run || word.includes('c') : false;
        }
        wordStart = i + 1;
        script = false;
      } else if (i === wordStart) script = run;
    }
    if (quote === "'") {
      if (here) return here;
      if (c === "'") quote = '';
    } else if (c === '\\') {
      const escaped = markerAt(i + 1);
      if (escaped) return escaped;
      i++;
    } else if (here && (quote !== '"' || script || command[i - 1] === '$')) {
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
    }
  }
  return undefined;
}

/** A construct at `i` whose quoting `firstUnprovenMarker` does not follow: a marker after it is unprovable. */
function isUnreadConstruct(command: string, i: number, quote: string, depth: number): boolean {
  const c = command[i];
  const two = command.slice(i, i + 2);
  if (two === '$(' || two === "$'" || two === '<<' || c === '`') return true;
  if (depth > 0) return c === "'" || c === '"';
  if (quote === '' && /^(?:eval|trap)(?:\s|$)/.test(command.slice(i, i + 5)) && (i === 0 || /[\s;&|()]/.test(command[i - 1]))) return true;
  return c === '#' && quote === '' && (i === 0 || /[\s;&|()<>]/.test(command[i - 1]));
}
