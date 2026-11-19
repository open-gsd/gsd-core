"use strict";
/**
 * Complexity-triggered refactor extension point — analyzer, evaluator, and
 * baseline persistence (issue #1953).
 *
 * LEAF MODULE — imports ONLY: node:fs, node:path, and the zero-import leaf
 * frontmatter-fence.cjs (the one frontmatter fence owner, read by parseProposal). No other
 * src/ imports.
 *
 * Pipeline: analyzeSource (decision-point complexity per function, via
 * stripLiterals to blank comments/string/regex content while preserving
 * length and line numbers) -> evaluateCandidates (threshold/jump-delta
 * scoring against a stable per-function baseline anchor) -> nextBaseline /
 * reanchorBaseline (anchor bookkeeping; the anchor never advances on a
 * plain evaluate — only an explicit disposition moves it, via
 * reanchorBaseline) -> renderProposal / parseProposal (the on-disk
 * `-REFACTOR.md` artifact) -> readBaseline / writeBaseline (I/O, atomic
 * temp-then-rename, never throws).
 *
 * Authoritative surface: .gsd/phase/feat-1953-complexity-triggered-refactor/41-api-contract.md
 * Executable spec: tests/complexity-trigger.test.cjs
 *
 * Out of scope for this module: git invocation, config reads,
 * capability-activation checks, CLI arg parsing, and the ship-gate query —
 * those live in their own modules (command router / ship gate, not this
 * leaf module).
 *
 * Exports:
 *   Constants: BASELINE_FILE_NAME, PROPOSAL_SUFFIX, SCHEMA_VERSION,
 *              DEFAULTS, ANALYZABLE_EXTENSIONS, VERDICT, REASON (includes
 *              REFACTOR_FILE_UNREADABLE for an unreadable/confined-escape file)
 *   Pure:      stripLiterals, analyzeSource, isAnalyzablePath,
 *              evaluateCandidates, nextBaseline, reanchorBaseline,
 *              renderProposal, parseProposal
 *   I/O:       readBaseline, writeBaseline
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.REASON = exports.VERDICT = exports.ANALYZABLE_EXTENSIONS = exports.DEFAULTS = exports.SCHEMA_VERSION = exports.PROPOSAL_SUFFIX = exports.BASELINE_FILE_NAME = void 0;
exports.stripLiterals = stripLiterals;
exports.analyzeSource = analyzeSource;
exports.isAnalyzablePath = isAnalyzablePath;
exports.evaluateCandidates = evaluateCandidates;
exports.nextBaseline = nextBaseline;
exports.reanchorBaseline = reanchorBaseline;
exports.renderProposal = renderProposal;
exports.parseProposal = parseProposal;
exports.readBaseline = readBaseline;
exports.writeBaseline = writeBaseline;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const frontmatter_fence_cjs_1 = require("./frontmatter-fence.cjs");
// ─── Constants ─────────────────────────────────────────────────────────────
exports.BASELINE_FILE_NAME = 'complexity-baseline.json'; // under .planning/
exports.PROPOSAL_SUFFIX = '-REFACTOR.md'; // ${PHASE_DIR}/${PADDED}-REFACTOR.md
exports.SCHEMA_VERSION = 1;
exports.DEFAULTS = Object.freeze({ threshold: 15, jumpDelta: 5 });
exports.ANALYZABLE_EXTENSIONS = Object.freeze(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts']);
exports.VERDICT = Object.freeze({
    TRIGGERED: 'triggered',
    BELOW_THRESHOLD: 'below_threshold',
    SKIPPED: 'skipped',
});
/**
 * Frozen reason enum. Adding a code = three coordinated changes: this enum,
 * the emitting call site, and the Object.keys(REASON).sort() lock test.
 */
exports.REASON = Object.freeze({
    REFACTOR_OK: 'refactor_ok',
    REFACTOR_DISABLED: 'refactor_disabled',
    REFACTOR_NO_TOUCHED_FILES: 'refactor_no_touched_files',
    REFACTOR_GIT_UNAVAILABLE: 'refactor_git_unavailable',
    REFACTOR_ANALYZER_UNSUPPORTED: 'refactor_analyzer_unsupported',
    REFACTOR_ANALYZER_UNPARSEABLE: 'refactor_analyzer_unparseable',
    REFACTOR_FILE_UNREADABLE: 'refactor_file_unreadable',
    REFACTOR_BASELINE_MALFORMED: 'refactor_baseline_malformed',
    REFACTOR_BASELINE_WRITE_FAILED: 'refactor_baseline_write_failed',
    REFACTOR_STRICT_NOT_ENFORCING: 'refactor_strict_not_enforcing',
    REFACTOR_ARTIFACT_NOT_FOUND: 'refactor_artifact_not_found',
    REFACTOR_ALREADY_DISPOSITIONED: 'refactor_already_dispositioned',
    REFACTOR_DECLINE_REASON_EMPTY: 'refactor_decline_reason_empty',
    REFACTOR_INVALID_PHASE: 'refactor_invalid_phase',
    REFACTOR_USAGE: 'refactor_usage',
});
// ─── stripLiterals ──────────────────────────────────────────────────────────
/**
 * Words after which a following `/` must be interpreted as the start of an
 * expression (so a `/` there is a regex literal, never division).
 */
const REGEX_KEYWORD_CONTEXT_WORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'throw', 'case', 'do', 'else', 'yield', 'await', 'default',
]);
function blankChar(ch) {
    return ch === '\n' ? '\n' : ' ';
}
/**
 * Replaces comment and literal *content* with spaces, preserving length and
 * every newline so line numbers survive. Handles `//`, `/* *\/`, `'`, `"`,
 * backtick templates (`${...}` interpolations are kept as code), regex
 * literals (disambiguated from division by the preceding significant
 * token), and backslash escapes. Unterminated string / template / block
 * comment => { ok:false, reason: REFACTOR_ANALYZER_UNPARSEABLE }.
 */
function stripLiterals(source) {
    const len = source.length;
    const out = new Array(len);
    let i = 0;
    let lastTokenIsValue = false;
    const templateStack = [];
    while (i < len) {
        const top = templateStack[templateStack.length - 1];
        if (top && top.state === 'literal') {
            const ch = source[i];
            if (ch === '\\') {
                out[i] = blankChar(ch);
                i++;
                if (i < len) {
                    out[i] = blankChar(source[i]);
                    i++;
                }
                continue;
            }
            if (ch === '`') {
                out[i] = ' ';
                templateStack.pop();
                i++;
                lastTokenIsValue = true;
                continue;
            }
            if (ch === '$' && source[i + 1] === '{') {
                out[i] = '$';
                out[i + 1] = '{';
                top.state = 'interp';
                top.braceDepth = 0;
                i += 2;
                lastTokenIsValue = false;
                continue;
            }
            out[i] = blankChar(ch);
            i++;
            continue;
        }
        const ch = source[i];
        // Line comment.
        if (ch === '/' && source[i + 1] === '/') {
            while (i < len && source[i] !== '\n') {
                out[i] = ' ';
                i++;
            }
            continue;
        }
        // Block comment.
        if (ch === '/' && source[i + 1] === '*') {
            out[i] = ' ';
            out[i + 1] = ' ';
            i += 2;
            let closed = false;
            while (i < len) {
                if (source[i] === '*' && source[i + 1] === '/') {
                    out[i] = ' ';
                    out[i + 1] = ' ';
                    i += 2;
                    closed = true;
                    break;
                }
                out[i] = blankChar(source[i]);
                i++;
            }
            if (!closed)
                return { ok: false, reason: exports.REASON.REFACTOR_ANALYZER_UNPARSEABLE };
            lastTokenIsValue = false;
            continue;
        }
        // Single/double-quoted string. A raw (unescaped) newline before the
        // closing quote is treated as unterminated (matches real JS syntax).
        if (ch === '\'' || ch === '"') {
            const quote = ch;
            out[i] = ' ';
            i++;
            let closed = false;
            while (i < len) {
                const c = source[i];
                if (c === '\n')
                    break;
                if (c === '\\') {
                    out[i] = ' ';
                    i++;
                    if (i < len && source[i] !== '\n') {
                        out[i] = ' ';
                        i++;
                    }
                    continue;
                }
                if (c === quote) {
                    out[i] = ' ';
                    i++;
                    closed = true;
                    break;
                }
                out[i] = ' ';
                i++;
            }
            if (!closed)
                return { ok: false, reason: exports.REASON.REFACTOR_ANALYZER_UNPARSEABLE };
            lastTokenIsValue = true;
            continue;
        }
        // Template literal open.
        if (ch === '`') {
            out[i] = ' ';
            templateStack.push({ state: 'literal', braceDepth: 0 });
            i++;
            continue;
        }
        // Regex literal candidate — only when the preceding significant token
        // indicates an expression context (never after a value-producing token).
        if (ch === '/' && !lastTokenIsValue) {
            const start = i;
            out[i] = ' ';
            i++;
            let inClass = false;
            let closed = false;
            while (i < len) {
                const c = source[i];
                if (c === '\n')
                    break;
                if (c === '\\') {
                    out[i] = ' ';
                    i++;
                    if (i < len && source[i] !== '\n') {
                        out[i] = ' ';
                        i++;
                    }
                    continue;
                }
                if (c === '[') {
                    inClass = true;
                    out[i] = ' ';
                    i++;
                    continue;
                }
                if (c === ']') {
                    inClass = false;
                    out[i] = ' ';
                    i++;
                    continue;
                }
                if (c === '/' && !inClass) {
                    out[i] = ' ';
                    i++;
                    closed = true;
                    break;
                }
                out[i] = ' ';
                i++;
            }
            if (closed) {
                while (i < len && /[a-zA-Z]/.test(source[i])) {
                    out[i] = ' ';
                    i++;
                }
                lastTokenIsValue = true;
                continue;
            }
            // Not actually a regex literal (never closed) — fall back to
            // treating the '/' as division and re-scan normally from there.
            i = start;
            out[i] = source[i];
            i++;
            lastTokenIsValue = false;
            continue;
        }
        // Template interpolation brace tracking (real code inside ${...}).
        if (top && top.state === 'interp') {
            if (ch === '{') {
                top.braceDepth++;
                out[i] = ch;
                i++;
                lastTokenIsValue = false;
                continue;
            }
            if (ch === '}') {
                if (top.braceDepth === 0) {
                    out[i] = '}';
                    top.state = 'literal';
                    i++;
                    lastTokenIsValue = false;
                    continue;
                }
                top.braceDepth--;
                out[i] = ch;
                i++;
                lastTokenIsValue = true;
                continue;
            }
        }
        // Identifier / keyword.
        if (/[A-Za-z_$]/.test(ch)) {
            let j = i;
            while (j < len && /[A-Za-z0-9_$]/.test(source[j]))
                j++;
            const word = source.slice(i, j);
            for (let k = i; k < j; k++)
                out[k] = source[k];
            lastTokenIsValue = !REGEX_KEYWORD_CONTEXT_WORDS.has(word);
            i = j;
            continue;
        }
        // Numeric literal.
        if (/[0-9]/.test(ch)) {
            let j = i;
            while (j < len && /[0-9a-fA-FxXoObB.]/.test(source[j]))
                j++;
            for (let k = i; k < j; k++)
                out[k] = source[k];
            lastTokenIsValue = true;
            i = j;
            continue;
        }
        if (ch === ')' || ch === ']') {
            out[i] = ch;
            i++;
            lastTokenIsValue = true;
            continue;
        }
        if (ch === '\n') {
            out[i] = '\n';
            i++;
            continue;
        }
        out[i] = ch;
        i++;
        if (!/\s/.test(ch))
            lastTokenIsValue = false;
    }
    if (templateStack.length > 0) {
        return { ok: false, reason: exports.REASON.REFACTOR_ANALYZER_UNPARSEABLE };
    }
    return { ok: true, stripped: out.join('') };
}
// ─── analyzeSource ──────────────────────────────────────────────────────────
const DECISION_KEYWORDS = new Set(['if', 'for', 'while', 'do', 'case', 'catch']);
// Words that can textually precede `(...) {` without being a method/function
// definition — must be excluded from the method-shorthand heuristic so
// `if (x) {` / `switch (x) {` etc. are never mistaken for a function.
const NON_METHOD_WORDS = new Set([...DECISION_KEYWORDS, 'switch', 'with']);
function findMatchingParen(s, openIdx) {
    let depth = 0;
    for (let k = openIdx; k < s.length; k++) {
        if (s[k] === '(')
            depth++;
        else if (s[k] === ')') {
            depth--;
            if (depth === 0)
                return k;
        }
    }
    return -1;
}
/**
 * Attempts to skip a generic type-parameter list starting at `s[idx] === '<'`
 * (e.g. `<T>`, `<T extends X>`, `<T = Y>`, `<T, U>`, nested `<T extends
 * Record<string, X>>`). Returns the index just past the matching top-level
 * `>`, or -1 when the content is not shaped like one — either the brackets
 * never balance, or an operator token that never appears inside a type
 * parameter list (`&&`, `||`, `==`, `<=`, `>=`, arithmetic, a bare `?`)
 * shows up first. This — plus the caller only ever committing to the skip
 * when a `(` immediately follows the close — is what keeps a `<` used as a
 * less-than comparison from being mistaken for generics: a real comparison
 * either fails to balance before an unrelated bracket closes, contains one
 * of the disallowed operator tokens, or is not immediately followed by a
 * parameter list.
 */
function skipGenericParamList(s, idx) {
    const len = s.length;
    let i = idx + 1;
    const stack = ['>'];
    while (i < len) {
        const ch = s[i];
        const next = s[i + 1];
        if (ch === '=' && next === '>') {
            i += 2;
            continue;
        } // nested function-type arrow (e.g. a default's `(a:X)=>Y`)
        if ((ch === '=' && next === '=')
            || (ch === '<' && next === '=')
            || (ch === '>' && next === '=')
            || (ch === '&' && next === '&')
            || (ch === '|' && next === '|')
            || ch === '+' || ch === '*' || ch === '%' || ch === '!'
            || ch === '?' || ch === ';' || ch === '/' || ch === '-')
            return -1;
        if (ch === '<') {
            stack.push('>');
            i++;
            continue;
        }
        if (ch === '(') {
            stack.push(')');
            i++;
            continue;
        }
        if (ch === '[') {
            stack.push(']');
            i++;
            continue;
        }
        if (ch === '{') {
            stack.push('}');
            i++;
            continue;
        }
        if (ch === '>' || ch === ')' || ch === ']' || ch === '}') {
            if (stack.length === 0 || stack[stack.length - 1] !== ch)
                return -1;
            stack.pop();
            i++;
            if (stack.length === 0)
                return i;
            continue;
        }
        i++;
    }
    return -1;
}
/**
 * Attempts to skip a return-type / type-predicate annotation starting at
 * `s[idx] === ':'` (e.g. `: Promise<void>`, `: Record<string, X>`, `: A |
 * B`, `: { a: number }`, `: string[]`, `: x is Foo`). Returns the index of
 * the terminator that follows — a function-body `{`, an arrow `=>`, or a
 * statement-ending `;` — never consuming the terminator itself, or -1 when
 * the content is not shaped like a type. `expectStart` tracks whether a
 * fresh type token may begin here so an object-type literal's own `{`/`}`
 * (`: { a: number }`) is never mistaken for the function body, and an
 * unexpected/unmatched closing bracket (e.g. the real end of an enclosing
 * `switch`/ternary this `:` was actually a member of, not a return type)
 * aborts rather than guesses.
 */
function skipTypeExpr(s, idx) {
    const len = s.length;
    let i = idx + 1;
    const stack = [];
    let expectStart = true;
    while (i < len) {
        const ch = s[i];
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        const next = s[i + 1];
        if (stack.length === 0) {
            if (ch === ';')
                return i;
            if (ch === '=' && next === '>')
                return i;
            if (ch === '{' && !expectStart)
                return i;
            if (ch === ',' && !expectStart)
                return i;
            if (ch === '?')
                return -1; // a bare top-level '?' means this was a ternary, not a return type
        }
        if (ch === '=' && next === '>') {
            i += 2;
            expectStart = true;
            continue;
        } // nested function-type arrow
        if ((ch === '=' && next === '=')
            || (ch === '<' && next === '=')
            || (ch === '>' && next === '=')
            || (ch === '&' && next === '&')
            || (ch === '|' && next === '|')
            || ch === '+' || ch === '*' || ch === '%' || ch === '!')
            return -1;
        if (ch === '<') {
            stack.push('>');
            i++;
            expectStart = true;
            continue;
        }
        if (ch === '(') {
            stack.push(')');
            i++;
            expectStart = true;
            continue;
        }
        if (ch === '[') {
            stack.push(']');
            i++;
            expectStart = true;
            continue;
        }
        if (ch === '{') {
            stack.push('}');
            i++;
            expectStart = true;
            continue;
        }
        if (ch === '>' || ch === ')' || ch === ']' || ch === '}') {
            if (stack.length === 0 || stack[stack.length - 1] !== ch)
                return -1;
            stack.pop();
            i++;
            expectStart = false;
            continue;
        }
        if (ch === '|' || ch === '&' || ch === ',' || ch === '.' || ch === ':') {
            i++;
            expectStart = true;
            continue;
        }
        if (/[A-Za-z0-9_$]/.test(ch)) {
            let j = i;
            while (j < len && /[A-Za-z0-9_$]/.test(s[j]))
                j++;
            i = j;
            expectStart = false;
            continue;
        }
        i++;
    }
    return -1;
}
function newlinesBetween(s, from, to) {
    let n = 0;
    for (let k = from; k < to; k++)
        if (s[k] === '\n')
            n++;
    return n;
}
/** Best-effort name inference for an arrow function from `NAME = ` or `NAME: ` immediately preceding it. */
function inferArrowName(s, pos) {
    let j = pos - 1;
    while (j >= 0 && /\s/.test(s[j]))
        j--;
    const isPlainEquals = j >= 0 && s[j] === '='
        && s[j - 1] !== '=' && s[j - 1] !== '!' && s[j - 1] !== '<' && s[j - 1] !== '>';
    const isPropColon = j >= 0 && s[j] === ':';
    if (!isPlainEquals && !isPropColon)
        return '';
    j--;
    while (j >= 0 && /\s/.test(s[j]))
        j--;
    const end = j + 1;
    while (j >= 0 && /[A-Za-z0-9_$]/.test(s[j]))
        j--;
    return s.slice(j + 1, end);
}
function scanFunctions(stripped) {
    const len = stripped.length;
    let i = 0;
    let line = 1;
    let depth = 0;
    const stack = [];
    const results = [];
    function currentFunctionFrame() {
        for (let k = stack.length - 1; k >= 0; k--) {
            const f = stack[k];
            if (f.kind === 'function')
                return f;
        }
        return null;
    }
    function bump() {
        const f = currentFunctionFrame();
        if (f)
            f.score += 1;
    }
    function closeExprFramesIfNeeded(atDepth) {
        for (;;) {
            const top = stack[stack.length - 1];
            if (top && top.kind === 'function' && top.mode === 'expr' && top.entryDepth === atDepth) {
                stack.pop();
                results.push({ name: top.name, startLine: top.startLine, endLine: line, score: top.score });
            }
            else {
                break;
            }
        }
    }
    while (i < len) {
        const ch = stripped[i];
        if (ch === '\n') {
            line++;
            i++;
            continue;
        }
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        if (ch === '&' && stripped[i + 1] === '&') {
            bump();
            i += 2;
            continue;
        }
        if (ch === '|' && stripped[i + 1] === '|') {
            bump();
            i += 2;
            continue;
        }
        if (ch === '?') {
            if (stripped[i + 1] === '.') {
                i += 2;
                continue;
            }
            if (stripped[i + 1] === '?') {
                i += 2;
                continue;
            }
            bump();
            i += 1;
            continue;
        }
        if (ch === '(') {
            const closeIdx = findMatchingParen(stripped, i);
            if (closeIdx !== -1) {
                let k = closeIdx + 1;
                while (k < len && /\s/.test(stripped[k]))
                    k++;
                if (stripped[k] === ':') {
                    const afterType = skipTypeExpr(stripped, k);
                    if (afterType !== -1) {
                        k = afterType;
                        while (k < len && /\s/.test(stripped[k]))
                            k++;
                    }
                }
                if (stripped[k] === '=' && stripped[k + 1] === '>') {
                    const name = inferArrowName(stripped, i);
                    const startLine = line;
                    let bodyStart = k + 2;
                    while (bodyStart < len && /\s/.test(stripped[bodyStart]))
                        bodyStart++;
                    const nl = newlinesBetween(stripped, i, bodyStart);
                    if (stripped[bodyStart] === '{') {
                        line += nl;
                        stack.push({ kind: 'function', name, startLine, score: 1, mode: 'brace' });
                        depth++;
                        i = bodyStart + 1;
                        continue;
                    }
                    line += nl;
                    stack.push({ kind: 'function', name, startLine, score: 1, mode: 'expr', entryDepth: depth });
                    i = bodyStart;
                    continue;
                }
            }
            depth++;
            i++;
            continue;
        }
        if (ch === '[') {
            depth++;
            i++;
            continue;
        }
        if (ch === ')' || ch === ']') {
            closeExprFramesIfNeeded(depth);
            depth--;
            i++;
            continue;
        }
        if (ch === '{') {
            stack.push({ kind: 'block' });
            depth++;
            i++;
            continue;
        }
        if (ch === '}') {
            closeExprFramesIfNeeded(depth);
            depth--;
            const top = stack.pop();
            if (top && top.kind === 'function' && top.mode === 'brace') {
                results.push({ name: top.name, startLine: top.startLine, endLine: line, score: top.score });
            }
            i++;
            continue;
        }
        if (ch === ';' || ch === ',') {
            closeExprFramesIfNeeded(depth);
            i++;
            continue;
        }
        if (/[A-Za-z_$]/.test(ch)) {
            let j = i;
            while (j < len && /[A-Za-z0-9_$]/.test(stripped[j]))
                j++;
            const word = stripped.slice(i, j);
            const wordLine = line;
            if (word === 'function') {
                let k = j;
                while (k < len && /\s/.test(stripped[k]))
                    k++;
                if (stripped[k] === '*') {
                    k++;
                    while (k < len && /\s/.test(stripped[k]))
                        k++;
                }
                let name = '';
                if (k < len && /[A-Za-z_$]/.test(stripped[k])) {
                    let m = k;
                    while (m < len && /[A-Za-z0-9_$]/.test(stripped[m]))
                        m++;
                    name = stripped.slice(k, m);
                    k = m;
                    while (k < len && /\s/.test(stripped[k]))
                        k++;
                }
                if (stripped[k] === '<') {
                    const afterGenerics = skipGenericParamList(stripped, k);
                    if (afterGenerics !== -1) {
                        let kk = afterGenerics;
                        while (kk < len && /\s/.test(stripped[kk]))
                            kk++;
                        if (stripped[kk] === '(')
                            k = kk; // only commit if genuinely followed by params
                    }
                }
                if (stripped[k] === '(') {
                    const closeIdx = findMatchingParen(stripped, k);
                    if (closeIdx !== -1) {
                        let p = closeIdx + 1;
                        while (p < len && /\s/.test(stripped[p]))
                            p++;
                        if (stripped[p] === ':') {
                            const afterType = skipTypeExpr(stripped, p);
                            if (afterType !== -1) {
                                p = afterType;
                                while (p < len && /\s/.test(stripped[p]))
                                    p++;
                            }
                        }
                        if (stripped[p] === '{') {
                            line += newlinesBetween(stripped, i, p);
                            stack.push({ kind: 'function', name, startLine: wordLine, score: 1, mode: 'brace' });
                            depth++;
                            i = p + 1;
                            continue;
                        }
                    }
                }
                i = j;
                continue;
            }
            if (NON_METHOD_WORDS.has(word)) {
                if (DECISION_KEYWORDS.has(word))
                    bump();
                i = j;
                continue;
            }
            {
                let k = j;
                while (k < len && /\s/.test(stripped[k]))
                    k++;
                if (stripped[k] === '<') {
                    const afterGenerics = skipGenericParamList(stripped, k);
                    if (afterGenerics !== -1) {
                        let kk = afterGenerics;
                        while (kk < len && /\s/.test(stripped[kk]))
                            kk++;
                        if (stripped[kk] === '(')
                            k = kk; // only commit if genuinely followed by params
                    }
                }
                if (stripped[k] === '(') {
                    const closeIdx = findMatchingParen(stripped, k);
                    if (closeIdx !== -1) {
                        let p = closeIdx + 1;
                        while (p < len && /\s/.test(stripped[p]))
                            p++;
                        if (stripped[p] === ':') {
                            const afterType = skipTypeExpr(stripped, p);
                            if (afterType !== -1) {
                                p = afterType;
                                while (p < len && /\s/.test(stripped[p]))
                                    p++;
                            }
                        }
                        if (stripped[p] === '{') {
                            line += newlinesBetween(stripped, i, p);
                            stack.push({ kind: 'function', name: word, startLine: wordLine, score: 1, mode: 'brace' });
                            depth++;
                            i = p + 1;
                            continue;
                        }
                    }
                }
                else if (stripped[k] === '=' && stripped[k + 1] === '>') {
                    const name = inferArrowName(stripped, i);
                    let bodyStart = k + 2;
                    while (bodyStart < len && /\s/.test(stripped[bodyStart]))
                        bodyStart++;
                    const nl = newlinesBetween(stripped, i, bodyStart);
                    if (stripped[bodyStart] === '{') {
                        line += nl;
                        stack.push({ kind: 'function', name, startLine: wordLine, score: 1, mode: 'brace' });
                        depth++;
                        i = bodyStart + 1;
                        continue;
                    }
                    line += nl;
                    stack.push({ kind: 'function', name, startLine: wordLine, score: 1, mode: 'expr', entryDepth: depth });
                    i = bodyStart;
                    continue;
                }
            }
            i = j;
            continue;
        }
        i++;
    }
    closeExprFramesIfNeeded(depth);
    return results;
}
/**
 * Normalizes CRLF -> LF *before* analysis so scores and line numbers are
 * identical either way. Base score 1 per function, +1 for each of: if,
 * else-if (the if, not the else), for, for..of, for..in, while, do, case
 * (not default), catch, &&, ||, ?:. Word-boundary matched. Not counted:
 * ?., ??, bare else, default:. Decision points are attributed to the
 * innermost enclosing function; top-level code belongs to no function.
 */
function analyzeSource(source) {
    const normalized = source.replace(/\r\n/g, '\n');
    const stripped = stripLiterals(normalized);
    if (!stripped.ok)
        return { ok: false, reason: stripped.reason };
    return { ok: true, method: 'decision-points', functions: scanFunctions(stripped.stripped) };
}
// ─── isAnalyzablePath ───────────────────────────────────────────────────────
/**
 * Normalizes separators unconditionally (never via path.sep). True iff the
 * extension is analyzable and the path is not under tests/ or
 * gsd-core/bin/lib/.
 */
function isAnalyzablePath(relPath) {
    const normalized = relPath.replace(/\\/g, '/');
    const ext = node_path_1.default.posix.extname(normalized);
    if (!exports.ANALYZABLE_EXTENSIONS.includes(ext))
        return false;
    if (normalized === 'tests' || normalized.startsWith('tests/'))
        return false;
    if (normalized === 'gsd-core/bin/lib' || normalized.startsWith('gsd-core/bin/lib/'))
        return false;
    return true;
}
// ─── evaluateCandidates ─────────────────────────────────────────────────────
function coercePositiveNumber(v, fallback) {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
function evaluateCandidates(input) {
    const thresholdUsed = coercePositiveNumber(input.threshold, exports.DEFAULTS.threshold);
    const jumpDeltaUsed = coercePositiveNumber(input.jumpDelta, exports.DEFAULTS.jumpDelta);
    const candidates = [];
    const skipped = [];
    for (const entry of input.analyzed) {
        if (!entry.ok) {
            skipped.push({ file: entry.file, reason: entry.reason });
            continue;
        }
        for (const fn of entry.functions) {
            const key = `${entry.file}::${fn.name}`;
            const baselineEntry = input.baseline[key];
            const baselineScore = baselineEntry ? baselineEntry.score : null;
            const reasons = [];
            if (fn.score > thresholdUsed)
                reasons.push('threshold');
            let delta = null;
            if (baselineScore !== null) {
                delta = fn.score - baselineScore;
                if (delta > jumpDeltaUsed)
                    reasons.push('jump');
            }
            if (reasons.length > 0) {
                candidates.push({
                    file: entry.file,
                    name: fn.name,
                    startLine: fn.startLine,
                    score: fn.score,
                    baseline: baselineScore,
                    delta,
                    reasons,
                });
            }
        }
    }
    candidates.sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        const ad = a.delta === null ? -Infinity : a.delta;
        const bd = b.delta === null ? -Infinity : b.delta;
        if (bd !== ad)
            return bd - ad;
        if (a.file !== b.file)
            return a.file < b.file ? -1 : 1;
        if (a.name !== b.name)
            return a.name < b.name ? -1 : 1;
        return a.startLine - b.startLine;
    });
    return {
        verdict: candidates.length > 0 ? exports.VERDICT.TRIGGERED : exports.VERDICT.BELOW_THRESHOLD,
        candidates,
        target: candidates[0] ?? null,
        skipped,
        thresholdUsed,
        jumpDeltaUsed,
    };
}
// ─── Baseline anchor bookkeeping ────────────────────────────────────────────
/**
 * Anchor semantics (see 41-api-contract.md "Anchor semantics" — corrected
 * 2026-08-09): for each successfully analyzed function, no prior entry
 * inserts an anchor at the current score (first observation); a prior
 * entry carries forward UNCHANGED. The anchor never advances on a plain
 * evaluate, whether or not the function triggered — only reanchorBaseline
 * (called by an explicit disposition) moves it.
 */
function nextBaseline(prev, analyzed, opts = {}) {
    const next = {};
    const seenKeys = new Set();
    for (const entry of analyzed) {
        if (!entry.ok)
            continue;
        for (const fn of entry.functions) {
            const key = `${entry.file}::${fn.name}`;
            seenKeys.add(key);
            const existing = prev[key];
            if (existing) {
                next[key] = existing;
            }
            else {
                next[key] = opts.phase ? { score: fn.score, phase: opts.phase } : { score: fn.score };
            }
        }
    }
    const analyzedFileSet = new Set(opts.analyzedFiles ?? []);
    for (const [key, entry] of Object.entries(prev)) {
        if (seenKeys.has(key))
            continue;
        const file = key.slice(0, key.lastIndexOf('::'));
        if (analyzedFileSet.has(file))
            continue; // function no longer exists -> prune
        next[key] = entry; // file untouched this run -> never prune
    }
    return next;
}
/** Moves the anchor for `key` to `score` — accept re-anchors to the post-refactor score, decline re-anchors to the current (higher) score. */
function reanchorBaseline(prev, key, score, opts = {}) {
    return {
        ...prev,
        [key]: opts.phase ? { score, phase: opts.phase } : { score },
    };
}
// ─── Proposal render/parse ──────────────────────────────────────────────────
const PROPOSAL_JSON_FENCE_OPEN = '````json';
const PROPOSAL_JSON_FENCE_CLOSE = '````';
// Reader-side fence tolerance (#3657 — same defect class as the WINDOWS.md
// ledger): CommonMark formatters (Prettier et al.) narrow the written
// 4-backtick fence to the shortest legal width (3) whenever the body holds no
// backtick run, and a canonical-JSON candidates array never does. Locate the
// block by a line-anchored 3+ fence and close on a run at least as wide
// (CommonMark: a shorter run does not close). The writer above is unchanged.
// This module is a leaf (CONTEXT.md — imports only node:fs/node:path), so the
// span logic is local rather than imported from broken-windows.
const PROPOSAL_FENCE_OPEN_RE = /^(`{3,})json[ \t]*\r?$/m;
function locateProposalJsonBlock(text) {
    const open = text.match(PROPOSAL_FENCE_OPEN_RE);
    if (!open || open.index === undefined)
        return null;
    const width = open[1].length;
    const bodyStart = open.index + open[0].length;
    for (const close of text.slice(bodyStart).matchAll(/^(`{3,})[ \t]*\r?$/gm)) {
        if (close[1].length < width)
            continue;
        const bodyEnd = close.index ?? 0;
        return { jsonText: text.slice(bodyStart, bodyStart + bodyEnd).trim() };
    }
    return null;
}
function renderProposal(p) {
    const fm = [
        '---',
        `schema_version: ${p.schema_version}`,
        `status: ${p.status}`,
        `phase: ${p.phase}`,
        `target_file: ${p.target_file}`,
        `target_function: ${p.target_function}`,
        `score: ${p.score}`,
        `baseline: ${p.baseline === null ? 'null' : p.baseline}`,
        `delta: ${p.delta === null ? 'null' : p.delta}`,
        `metric: ${p.metric}`,
        `recorded_at: ${p.recorded_at}`,
        `resolved_at: ${p.resolved_at === null ? 'null' : p.resolved_at}`,
        `reason: ${JSON.stringify(p.reason)}`,
        '---',
        '',
    ].join('\n');
    const header = [
        `# Refactor proposal: ${p.target_file}::${p.target_function}`,
        '',
        `Score ${p.score}${p.baseline !== null ? ` (baseline ${p.baseline}, delta ${p.delta})` : ''} — status: ${p.status}.`,
        '',
    ].join('\n');
    const jsonBlock = [
        PROPOSAL_JSON_FENCE_OPEN,
        JSON.stringify(p.candidates, null, 2),
        PROPOSAL_JSON_FENCE_CLOSE,
        '',
    ].join('\n');
    return [fm, header, jsonBlock].join('\n');
}
/**
 * Parses a rendered proposal back into its IR. Frontmatter is the fast
 * scalar path; the JSON block is authoritative for candidates. Fails
 * closed (returns null) on any structural drift rather than guessing.
 */
function parseProposal(text) {
    try {
        // The block is the one the one fence owner finds (`locateFrontmatterFence`).
        const fence = (0, frontmatter_fence_cjs_1.locateFrontmatterFence)(text);
        if (!fence?.closed)
            return null;
        const yamlBody = text.slice(fence.openEnd, fence.bodyEnd);
        const fm = {};
        for (const rawLine of yamlBody.split(/\r?\n/)) {
            const line = rawLine.replace(/\r$/, '');
            if (line.trim() === '')
                continue;
            const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
            if (!m)
                return null;
            fm[m[1]] = m[2].trim();
        }
        const span = locateProposalJsonBlock(text);
        if (span === null)
            return null;
        const jsonText = span.jsonText;
        let candidates;
        try {
            candidates = JSON.parse(jsonText);
        }
        catch {
            return null;
        }
        if (!Array.isArray(candidates))
            return null;
        const status = fm.status;
        if (status !== 'proposed' && status !== 'accepted' && status !== 'declined')
            return null;
        const schemaVersion = Number(fm.schema_version);
        if (!Number.isInteger(schemaVersion))
            return null;
        const score = Number(fm.score);
        if (!Number.isFinite(score))
            return null;
        const baseline = fm.baseline === 'null' ? null : Number(fm.baseline);
        if (baseline !== null && !Number.isFinite(baseline))
            return null;
        const delta = fm.delta === 'null' ? null : Number(fm.delta);
        if (delta !== null && !Number.isFinite(delta))
            return null;
        const resolvedAt = fm.resolved_at === 'null' || fm.resolved_at === undefined ? null : fm.resolved_at;
        let reason = '';
        try {
            const parsedReason = JSON.parse(fm.reason ?? '""');
            reason = typeof parsedReason === 'string' ? parsedReason : (fm.reason ?? '');
        }
        catch {
            reason = fm.reason ?? '';
        }
        return {
            schema_version: schemaVersion,
            status,
            phase: fm.phase ?? '',
            target_file: fm.target_file ?? '',
            target_function: fm.target_function ?? '',
            score,
            baseline,
            delta,
            metric: 'decision-points',
            recorded_at: fm.recorded_at ?? '',
            resolved_at: resolvedAt,
            reason,
            candidates: candidates,
        };
    }
    catch {
        return null;
    }
}
function baselinePath(planningDir) {
    return node_path_1.default.join(planningDir, exports.BASELINE_FILE_NAME);
}
const RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_MAX_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 25;
function renameWithRetry(fsImpl, tmp, target) {
    let lastErr;
    for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt++) {
        try {
            fsImpl.renameSync(tmp, target);
            return;
        }
        catch (err) {
            lastErr = err;
            const code = (err && typeof err === 'object' && 'code' in err)
                ? String(err.code)
                : '';
            if (code && RENAME_RETRY_ERRNOS.has(code) && attempt < RENAME_MAX_ATTEMPTS - 1) {
                const delay = RENAME_BACKOFF_MS * Math.pow(2, attempt);
                const start = Date.now();
                while (Date.now() - start < delay) {
                    // Busy-wait a very short time — transient locks usually clear quickly.
                }
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}
/**
 * Degrades to { ok:false, baseline:{}, reason: REFACTOR_BASELINE_MALFORMED }
 * on absent-but-unreadable, bad JSON, or a non-plain-object root — and
 * never rewrites the file on a failed read. Missing file is
 * { ok:true, baseline:{} } with no reason. Never throws.
 */
function readBaseline(planningDir, deps = {}) {
    const fsImpl = deps.fs ?? node_fs_1.default;
    const p = baselinePath(planningDir);
    let raw;
    try {
        raw = fsImpl.readFileSync(p, 'utf8');
    }
    catch (e) {
        const code = (e && typeof e === 'object' && 'code' in e)
            ? String(e.code)
            : '';
        if (code === 'ENOENT')
            return { ok: true, baseline: {} };
        return { ok: false, baseline: {}, reason: exports.REASON.REFACTOR_BASELINE_MALFORMED };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { ok: false, baseline: {}, reason: exports.REASON.REFACTOR_BASELINE_MALFORMED };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, baseline: {}, reason: exports.REASON.REFACTOR_BASELINE_MALFORMED };
    }
    return { ok: true, baseline: parsed };
}
/**
 * Writes `<name>.<pid>.tmp` then renames; on any failure unlinks the temp
 * file and returns { ok:false, reason: REFACTOR_BASELINE_WRITE_FAILED }.
 * Never throws.
 */
function writeBaseline(planningDir, baseline, deps = {}) {
    const fsImpl = deps.fs ?? node_fs_1.default;
    const p = baselinePath(planningDir);
    const tmp = `${p}.${process.pid}.tmp`;
    try {
        if (!fsImpl.existsSync(planningDir)) {
            fsImpl.mkdirSync(planningDir, { recursive: true });
        }
        fsImpl.writeFileSync(tmp, JSON.stringify(baseline, null, 2), 'utf8');
    }
    catch {
        try {
            fsImpl.unlinkSync(tmp);
        }
        catch { /* best-effort cleanup */ }
        return { ok: false, reason: exports.REASON.REFACTOR_BASELINE_WRITE_FAILED };
    }
    try {
        renameWithRetry(fsImpl, tmp, p);
    }
    catch {
        try {
            fsImpl.unlinkSync(tmp);
        }
        catch { /* best-effort cleanup */ }
        return { ok: false, reason: exports.REASON.REFACTOR_BASELINE_WRITE_FAILED };
    }
    return { ok: true };
}
