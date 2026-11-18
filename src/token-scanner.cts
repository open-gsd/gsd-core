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
 * `literalDollarIndexes(command) → number[]` returns the index of every `$` that `sh` reads literally
 * (single quotes, `$'...'`, a quoted here-document body); the gate evaluator refuses a placeholder there.
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

interface HeredocOpener {
  end: number;
  delimiter: string;
  literal: boolean;
  stripTabs: boolean;
}

/** The delimiter word at `start` (after blanks): backslash pairs (a backslash-newline continues the word), closed quote spans on one line and plain characters. A quote or a backslash makes the body literal; the delimiter is the word with those removed. One pass, no backtracking. */
function readHeredocWord(command: string, start: number): Omit<HeredocOpener, 'stripTabs'> | null {
  let j = start;
  while (command[j] === ' ' || command[j] === '\t') j++;
  const from = j;
  let delimiter = '';
  let literal = false;
  while (j < command.length) {
    const c = command[j];
    if (c === '\\') {
      if (command[j + 1] !== '\n') {
        delimiter += command[j + 1];
        literal = true;
      }
      j += 2;
    } else if (c === "'" || c === '"') {
      let close = j + 1;
      while (close < command.length && command[close] !== c && command[close] !== '\n') close++;
      if (command[close] !== c) break;
      delimiter += command.slice(j + 1, close);
      literal = true;
      j = close + 1;
    } else if (/[^\s;&|<>()]/.test(c)) {
      delimiter += c;
      j++;
    } else break;
  }
  return j === from ? null : { end: j, delimiter, literal };
}

/** A here-document opener at `i`: `<<`, optional `-` (strips leading tabs of the body), then the delimiter word. `<<-` with no word opens nothing, as in `sh`. */
function readHeredocOpener(command: string, i: number): HeredocOpener | null {
  const stripTabs = command[i + 2] === '-';
  const word = readHeredocWord(command, stripTabs ? i + 3 : i + 2);
  return word && { ...word, stripTabs };
}

interface QuoteCtx {
  kind: 'none' | 'sub' | 'arith' | 'tick' | 'param' | 'double' | 'single' | 'ansi' | 'heredoc' | 'literal-heredoc';
  delimiter?: string;
  stripTabs?: boolean;
  /** Open `case` words: a `)` closes a pattern, not the enclosing `(...)`, while this is above zero. */
  cases?: number;
  /** A `${...}` inside double quotes, an unquoted here-document body or another quoted `${...}`: a single quote there is an ordinary character. */
  quoted?: boolean;
  /** A `$(...)` or `$((...))`: its closing `)` ends inside a word, so a `#` right after it is no comment. */
  expansion?: boolean;
}

// `case` or `esac` as a command word: after a separator, a newline or a compound-command keyword.
const CASE_WORD_RE = /(case|esac)(?![\w])/y;
const KEYWORD_TAIL_RE = /\W(?:then|do|else|elif|if|while|until)$/;

/** Whether the word at `i` starts a command: only whitespace back to a separator, a newline or a compound-command keyword. Linear: each call reads back over its own whitespace run and at most six more characters. */
function atCommandPosition(command: string, i: number): boolean {
  let j = i;
  while (/\s/.test(command[j - 1] ?? '')) j--;
  const gap = command.slice(j, i);
  return gap.includes('\n') || /[;&|(){]/.test(command[j - 1] ?? '') || (gap !== '' && KEYWORD_TAIL_RE.test(command.substring(j - 6, j)));
}

/** The end index of the line starting at `i` when it is the delimiter line of here-document `top`; -1 otherwise. */
function endsHeredoc(command: string, i: number, top: QuoteCtx): number {
  let end = i;
  while (end < command.length && command[end] !== '\n') end++;
  let from = i;
  if (top.stripTabs) while (command[from] === '\t') from++;
  return command.slice(from, end) === top.delimiter ? end : -1;
}

/**
 * The index of every `$` that `sh` reads literally: inside single quotes, `$'...'` and a quoted here-document
 * body (`<<'EOF'`, `<<"EOF"`, `<<\EOF`). One walk follows every shell quoting state with a stack: single and
 * double quotes, `$'...'`, backslash, `#` comments, `$(...)`, `$((...))`, `(...)`, `${...}`, backticks,
 * `case` patterns (their `)` closes no `(...)`) and here-documents.
 * A quote character pairs only inside its own state, so an apostrophe in a comment, a double-quoted string or
 * an unquoted here-document body pairs with nothing; a `<<` anywhere inside `$((...))` is a shift, not a here-document.
 */
export function literalDollarIndexes(command: string): number[] {
  const found: number[] = [];
  const stack: QuoteCtx[] = [{ kind: 'none' }];
  const pending: QuoteCtx[] = [];
  let dollarAt = -2;
  let expansionEnd = -2;
  for (let i = 0; i < command.length; i++) {
    const top = stack[stack.length - 1];
    const c = command[i];
    const prev = command[i - 1] ?? '';
    if ((top.kind === 'heredoc' || top.kind === 'literal-heredoc') && prev === '\n') {
      const end = endsHeredoc(command, i, top);
      if (end !== -1) {
        stack.pop();
        i = end - 1;
        continue;
      }
    }
    if (top.kind === 'single' || top.kind === 'ansi' || top.kind === 'literal-heredoc') {
      if (c === "'" && top.kind !== 'literal-heredoc') stack.pop();
      else if (c === '\\' && top.kind === 'ansi') i++;
      else if (c === '$') found.push(i);
    } else if (c === '\\') {
      i++;
    } else if (c === '`') {
      if (top.kind === 'tick') stack.pop();
      else stack.push({ kind: 'tick' });
    } else if (c === '$' && command[i + 1] === '(') {
      const arith = command[i + 2] === '(';
      stack.push({ kind: arith ? 'arith' : 'sub', expansion: true });
      i += arith ? 2 : 1;
    } else if (c === '$' && command[i + 1] === '{') {
      stack.push({ kind: 'param', quoted: top.kind === 'double' || top.kind === 'heredoc' || top.quoted });
    } else if (top.kind === 'double' || top.kind === 'heredoc') {
      if (c === '"' && top.kind === 'double') stack.pop();
    } else if (c === '}' && top.kind === 'param') {
      stack.pop();
    } else if ((c === 'c' || c === 'e') && (CASE_WORD_RE.lastIndex = i, CASE_WORD_RE.test(command)) && atCommandPosition(command, i)) {
      top.cases = Math.max(0, (top.cases ?? 0) + (c === 'c' ? 1 : -1));
    } else if (c === '$') {
      dollarAt = i;
    } else if (c === '#' && top.kind !== 'param' && (i === 0 || (/[\s;&|()]/.test(prev) && expansionEnd !== i - 1))) {
      const eol = command.indexOf('\n', i);
      if (eol === -1) return found;
      i = eol - 1;
    } else if (c === "'" && !top.quoted) {
      stack.push({ kind: dollarAt === i - 1 ? 'ansi' : 'single' });
    } else if (c === '"') {
      stack.push({ kind: 'double' });
    } else if (c === '(') {
      const arith = command[i + 1] === '(';
      stack.push({ kind: arith ? 'arith' : 'sub' });
      i += arith ? 1 : 0;
    } else if (c === ')') {
      if (top.kind === 'arith') {
        stack.pop();
        if (command[i + 1] === ')') i++;
        if (top.expansion) expansionEnd = i;
      } else if (top.kind === 'sub' && !top.cases) {
        stack.pop();
        if (top.expansion) expansionEnd = i;
      }
    } else if (c === '<' && command[i + 1] === '<' && prev !== '<' && !stack.some((q) => q.kind === 'arith')) {
      const opener = readHeredocOpener(command, i);
      if (opener) {
        pending.push({ kind: opener.literal ? 'literal-heredoc' : 'heredoc', delimiter: opener.delimiter, stripTabs: opener.stripTabs });
        i = opener.end - 1;
      }
    } else if (c === '\n' && pending.length > 0) {
      stack.push(pending.shift() as QuoteCtx);
    }
  }
  return found;
}
