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

// A here-document opener: `<<`, optional `-`, then the delimiter word. A word that holds a quote or a backslash
// makes the body literal; the delimiter is the word with those removed.
const HEREDOC_OPEN_RE = /<<(-?)[ \t]*((?:\\[^\n]|'[^'\n]*'|"[^"\n]*"|[^\s;&|<>()'"\\])+)/y;

interface QuoteCtx {
  kind: 'none' | 'sub' | 'arith' | 'tick' | 'param' | 'double' | 'single' | 'ansi' | 'heredoc' | 'literal-heredoc';
  delimiter?: string;
  stripTabs?: boolean;
  /** Open `case` words: a `)` closes a pattern, not the enclosing `(...)`, while this is above zero. */
  cases?: number;
  /** A `${...}` inside double quotes, an unquoted here-document body or another quoted `${...}`: a single quote there is an ordinary character. */
  quoted?: boolean;
}

// `case` or `esac` as a command word: after a separator, a compound-command keyword or the start of the command.
const CASE_WORD_RE = /(case|esac)(?![\w])/y;
const COMMAND_POSITION_RE = /(?:^|[\n;&|(`{]|\b(?:then|do|else|elif|if|while|until)\s)\s*$/;

/** The end index of the line starting at `i` when it is the delimiter line of here-document `top`; -1 otherwise. */
function endsHeredoc(command: string, i: number, top: QuoteCtx): number {
  const eol = command.indexOf('\n', i);
  const end = eol === -1 ? command.length : eol;
  const line = command.slice(i, end);
  return (top.stripTabs ? line.replace(/^\t+/, '') : line) === top.delimiter ? end : -1;
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
      stack.push({ kind: arith ? 'arith' : 'sub' });
      i += arith ? 2 : 1;
    } else if (c === '$' && command[i + 1] === '{') {
      stack.push({ kind: 'param', quoted: top.kind === 'double' || top.kind === 'heredoc' || (top.kind === 'param' && top.quoted) });
      i++;
    } else if (top.kind === 'double' || top.kind === 'heredoc') {
      if (c === '"' && top.kind === 'double') stack.pop();
    } else if (c === '}' && top.kind === 'param') {
      stack.pop();
    } else if ((c === 'c' || c === 'e') && (CASE_WORD_RE.lastIndex = i, CASE_WORD_RE.test(command)) && COMMAND_POSITION_RE.test(command.slice(0, i))) {
      top.cases = Math.max(0, (top.cases ?? 0) + (c === 'c' ? 1 : -1));
      i += 3;
    } else if (c === '$') {
      dollarAt = i;
    } else if (c === '#' && (i === 0 || /[\s;&|()]/.test(prev))) {
      const eol = command.indexOf('\n', i);
      if (eol === -1) return found;
      i = eol - 1;
    } else if (c === "'" && !(top.kind === 'param' && top.quoted)) {
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
      } else if (top.kind === 'sub' && !top.cases) stack.pop();
    } else if (c === '<' && command[i + 1] === '<' && prev !== '<' && !stack.some((q) => q.kind === 'arith')) {
      HEREDOC_OPEN_RE.lastIndex = i;
      const m = HEREDOC_OPEN_RE.exec(command);
      if (m) {
        const literal = /['"\\]/.test(m[2]);
        pending.push({ kind: literal ? 'literal-heredoc' : 'heredoc', delimiter: m[2].replace(/\\([^\n])|['"]/g, '$1'), stripTabs: m[1] === '-' });
        i += m[0].length - 1;
      }
    } else if (c === '\n' && pending.length > 0) {
      stack.push(pending.shift() as QuoteCtx);
    }
  }
  return found;
}
