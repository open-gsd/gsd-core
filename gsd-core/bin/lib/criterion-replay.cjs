"use strict";
/**
 * Criterion Replay Module (#4310, ADR-4310).
 *
 * Re-runs the command behind each judged `[HEAD=<v> EXPECT<op><v>]` notation
 * and compares the printed value with the recorded HEAD value. Pure; the
 * runner, clock and HEAD sha are injected, so this module does no I/O.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_REPLAY_STATUSES = exports.REPLAY_LIMITS = exports.REPLAY_STATUS = void 0;
exports.extractCriterionCommand = extractCriterionCommand;
exports.tokenizeCriterionCommand = tokenizeCriterionCommand;
exports.checkReplayQuarantine = checkReplayQuarantine;
exports.deriveObservedValue = deriveObservedValue;
exports.replayBaselineCriteria = replayBaselineCriteria;
const criterion_baseline_cjs_1 = require("./criterion-baseline.cjs");
exports.REPLAY_STATUS = Object.freeze({
    NO_COMMAND: 'no_command',
    AMBIGUOUS_COMMAND: 'ambiguous_command',
    MALFORMED_COMMAND: 'malformed_command',
    DISALLOWED: 'disallowed',
    CANNOT_RUN: 'cannot_run',
    TIMEOUT: 'timeout',
    OUTPUT_CAP: 'output_cap',
    BUDGET_EXHAUSTED: 'budget_exhausted',
    TRUNCATED: 'truncated',
    REPLAY_ERROR: 'replay_error',
});
exports.REPLAY_LIMITS = Object.freeze({
    MAX_COMMANDS: 50,
    PER_COMMAND_TIMEOUT_MS: 10000,
    TOTAL_BUDGET_MS: 60000,
    OUTPUT_CAP_BYTES: 65536,
    MAX_COMMAND_LENGTH: 1000,
    MAX_TOKENS: 64,
});
/** Most statuses a replay records; the rest collapse into the one `truncated` entry. */
exports.MAX_REPLAY_STATUSES = 50;
const ZONE_TAG_PREFIX = /^\s*(?:<(?:verify|automated|acceptance_criteria)>\s*)*/;
function extractCriterionCommand(lineText, column) {
    const prefix = lineText.slice(0, column);
    const spans = prefix.match(/`([^`\r\n]*)`/g) ?? [];
    let cmd;
    if (spans.length > 1) {
        return { status: exports.REPLAY_STATUS.AMBIGUOUS_COMMAND, detail: 'more than one backtick span precedes the notation' };
    }
    if (spans.length === 1) {
        cmd = spans[0].slice(1, -1).trim();
    }
    else {
        const trimmed = prefix.replace(/[ \t]+$/, '');
        if (!trimmed.endsWith('#')) {
            return { status: exports.REPLAY_STATUS.NO_COMMAND, detail: 'no backtick span or trailing comment names a command' };
        }
        cmd = trimmed.slice(0, -1).replace(ZONE_TAG_PREFIX, '').trim();
    }
    if (cmd.length === 0)
        return { status: exports.REPLAY_STATUS.NO_COMMAND, detail: 'the command is empty' };
    return { command: (0, criterion_baseline_cjs_1.decodeNotationEntities)(cmd) };
}
const UNQUOTED_META = new Set(['|', '&', ';', '<', '>', '(', ')', '$', '`', '*', '?', '[', '{', '}', '~']);
/** A recognizer for plain words and quotes, not a shell: anything a shell would interpret is refused. */
function tokenizeCriterionCommand(command) {
    if (command.length > exports.REPLAY_LIMITS.MAX_COMMAND_LENGTH) {
        return { status: exports.REPLAY_STATUS.DISALLOWED, detail: `command longer than ${exports.REPLAY_LIMITS.MAX_COMMAND_LENGTH} characters` };
    }
    if (/[\r\n\u0000]/.test(command)) {
        return { status: exports.REPLAY_STATUS.DISALLOWED, detail: 'command contains a line break or NUL' };
    }
    const argv = [];
    let cur = null;
    let i = 0;
    while (i < command.length) {
        const ch = command[i];
        if (ch === ' ' || ch === '\t') {
            if (cur !== null)
                argv.push(cur);
            cur = null;
            i += 1;
        }
        else if (ch === "'") {
            const close = command.indexOf("'", i + 1);
            if (close === -1)
                return { status: exports.REPLAY_STATUS.MALFORMED_COMMAND, detail: 'unterminated single quote' };
            cur = (cur ?? '') + command.slice(i + 1, close);
            i = close + 1;
        }
        else if (ch === '"') {
            let j = i + 1;
            let buf = '';
            let closed = false;
            while (j < command.length) {
                const c = command[j];
                if (c === '"') {
                    closed = true;
                    break;
                }
                if (c === '$' || c === '`') {
                    return { status: exports.REPLAY_STATUS.DISALLOWED, detail: 'expansion inside double quotes' };
                }
                if (c === '\\' && j + 1 < command.length) {
                    const next = command[j + 1];
                    buf += next === '"' || next === '\\' || next === '$' || next === '`' ? next : `\\${next}`;
                    j += 2;
                    continue;
                }
                buf += c;
                j += 1;
            }
            if (!closed)
                return { status: exports.REPLAY_STATUS.MALFORMED_COMMAND, detail: 'unterminated double quote' };
            cur = (cur ?? '') + buf;
            i = j + 1;
        }
        else if (ch === '\\') {
            if (i + 1 >= command.length)
                return { status: exports.REPLAY_STATUS.MALFORMED_COMMAND, detail: 'trailing backslash' };
            cur = (cur ?? '') + command[i + 1];
            i += 2;
        }
        else if (ch === '#' && cur === null) {
            return { status: exports.REPLAY_STATUS.DISALLOWED, detail: 'shell comment' };
        }
        else if (UNQUOTED_META.has(ch)) {
            return { status: exports.REPLAY_STATUS.DISALLOWED, detail: `unquoted shell metacharacter ${ch}` };
        }
        else {
            cur = (cur ?? '') + ch;
            i += 1;
        }
    }
    if (cur !== null)
        argv.push(cur);
    if (argv.length === 0)
        return { status: exports.REPLAY_STATUS.NO_COMMAND, detail: 'the command has no words' };
    if (argv.length > exports.REPLAY_LIMITS.MAX_TOKENS) {
        return { status: exports.REPLAY_STATUS.DISALLOWED, detail: `more than ${exports.REPLAY_LIMITS.MAX_TOKENS} tokens` };
    }
    return { argv };
}
const ALLOWED_PROGRAMS = new Set(['grep', 'git']);
const ALLOWED_GIT_SUBCOMMANDS = new Set(['grep', 'ls-files', 'rev-parse', 'rev-list']);
const words = (s) => new Set(s.split(' ').filter((w) => w.length > 0));
const chars = (s) => new Set(s);
const GREP_SPEC = {
    short: chars('civwxFEGnlLqsrhHoyI'),
    long: words('--count --ignore-case --invert-match --word-regexp --line-regexp --fixed-strings --extended-regexp --basic-regexp --quiet --silent --no-messages --recursive --no-filename --with-filename --files-with-matches --files-without-match --only-matching --line-number'),
    valued: words('--regexp --include --exclude --exclude-dir'),
    valueShort: '-e',
};
const GIT_SPECS = Object.freeze({
    grep: {
        short: chars('civwnlLhHFEGPIoq'),
        long: words('--count --ignore-case --invert-match --word-regexp --line-number --files-with-matches --name-only --files-without-match --fixed-strings --extended-regexp --basic-regexp --perl-regexp --quiet --cached --untracked --no-index --full-name --and --or --not --all-match'),
        valued: words(''),
        valueShort: '-e',
    },
    'ls-files': {
        short: words('c o d m'),
        long: words('--cached --others --deleted --modified --exclude-standard --full-name'),
        valued: words(''),
        valueShort: null,
    },
    'rev-parse': {
        short: words('q'),
        long: words('--verify --quiet --is-inside-work-tree --show-toplevel --abbrev-ref --show-prefix --short'),
        valued: words('--short'),
        valueShort: null,
    },
    'rev-list': {
        short: words(''),
        long: words('--count --all --no-merges --merges --first-parent'),
        valued: words('--max-count'),
        valueShort: '-n',
    },
});
function isOutsideRoot(candidate) {
    return /^[\\/]/.test(candidate) || /^[A-Za-z]:[\\/]/.test(candidate) || candidate.split(/[\\/]/).includes('..');
}
/** Exact-match option allowlist: an option not named here (including any abbreviation of one) is refused. */
function checkReplayQuarantine(argv, opts = {}) {
    const program = argv[0];
    if (typeof program !== 'string' || !ALLOWED_PROGRAMS.has(program)) {
        return { status: 'disallowed', detail: 'program is not on the allowlist (grep, git)' };
    }
    let spec;
    let tokens;
    if (program === 'git') {
        if (argv.length < 2 || !ALLOWED_GIT_SUBCOMMANDS.has(argv[1])) {
            return { status: 'disallowed', detail: 'git subcommand is not on the allowlist' };
        }
        spec = GIT_SPECS[argv[1]];
        tokens = argv.slice(2);
    }
    else {
        spec = GREP_SPEC;
        tokens = argv.slice(1);
    }
    const disallowed = (detail) => ({ status: 'disallowed', detail });
    const pathProblem = (candidate) => {
        if (isOutsideRoot(candidate))
            return true;
        return opts.isInsideRoot !== undefined && !opts.isInsideRoot(candidate);
    };
    let operandsOnly = false;
    let takesValueNext = false;
    for (const token of tokens) {
        if (takesValueNext) {
            takesValueNext = false;
            if (pathProblem(token))
                return disallowed('path_outside_root');
            continue;
        }
        if (operandsOnly || !token.startsWith('-') || token === '-') {
            if (pathProblem(token))
                return disallowed('path_outside_root');
            continue;
        }
        if (token === '--') {
            operandsOnly = true;
            continue;
        }
        if (token.startsWith('--')) {
            const eq = token.indexOf('=');
            const name = eq === -1 ? token : token.slice(0, eq);
            const value = eq === -1 ? undefined : token.slice(eq + 1);
            if (spec.valued.has(name)) {
                if (value === undefined) {
                    if (!spec.long.has(name))
                        return disallowed('option ' + name + ' needs =value');
                }
                else if (pathProblem(value)) {
                    return disallowed('path_outside_root');
                }
            }
            else if (spec.long.has(name)) {
                if (value !== undefined)
                    return disallowed('option ' + name + ' takes no value');
            }
            else {
                return disallowed('option ' + name + ' is not allowed');
            }
            continue;
        }
        if (spec.valueShort !== null && token === spec.valueShort) {
            takesValueNext = true;
            continue;
        }
        for (const ch of token.slice(1)) {
            if (!spec.short.has(ch))
                return disallowed('option ' + token + ' is not allowed');
        }
    }
    if (takesValueNext)
        return disallowed('malformed: option is missing its value');
    return null;
}
function deriveObservedValue(r) {
    if (r.outcome === 'timed_out')
        return { status: exports.REPLAY_STATUS.TIMEOUT, detail: 'the command timed out' };
    if (r.outcome === 'overflow')
        return { status: exports.REPLAY_STATUS.OUTPUT_CAP, detail: 'the command printed more than the output cap' };
    if (r.outcome !== 'exited')
        return { status: exports.REPLAY_STATUS.CANNOT_RUN, detail: `the command did not exit (${String(r.outcome)})` };
    const code = r.exitCode;
    if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 255) {
        return { status: exports.REPLAY_STATUS.CANNOT_RUN, detail: 'the exit code is not in 0..255' };
    }
    if (code >= 2)
        return { value: { kind: 'error', code } };
    const s = String(r.stdout ?? '').trim();
    if (/^-?\d{1,15}$/.test(s))
        return { value: { kind: 'integer', value: Number(s) } };
    return { value: code === 0 ? { kind: 'present' } : { kind: 'absent' } };
}
function lineBounds(content, index) {
    const start = Math.max(content.lastIndexOf('\n', index - 1), content.lastIndexOf('\r', index - 1)) + 1;
    const nl = content.indexOf('\n', index);
    const cr = content.indexOf('\r', index);
    const ends = [nl, cr].filter((n) => n !== -1);
    return { start, end: ends.length > 0 ? Math.min(...ends) : content.length };
}
function replayBaselineCriteria(content, deps) {
    const headSha = deps.headSha ?? null;
    const report = { head_sha: headSha, results: [], mismatch_count: 0, statuses: [], warnings: [] };
    try {
        if (typeof content !== 'string' || content.length === 0)
            return report;
        const records = (deps.scan ?? criterion_baseline_cjs_1.scanBaselineNotation)(content).notations;
        const start = deps.now();
        let ran = 0;
        let skipped = 0;
        let dropped = 0;
        const addStatus = (code, line, text, detail) => {
            if (report.statuses.length >= exports.MAX_REPLAY_STATUSES) {
                dropped += 1;
                return;
            }
            report.statuses.push({ code, line, text, detail });
        };
        for (const record of records) {
            const { start: lineStart, end: lineEnd } = lineBounds(content, record.index);
            const lineText = content.slice(lineStart, lineEnd);
            const extracted = extractCriterionCommand(lineText, record.index - lineStart);
            if ('status' in extracted) {
                addStatus(extracted.status, record.line, record.text, extracted.detail);
                continue;
            }
            const tokens = tokenizeCriterionCommand(extracted.command);
            if ('status' in tokens) {
                addStatus(tokens.status, record.line, record.text, tokens.detail);
                continue;
            }
            const refused = checkReplayQuarantine(tokens.argv, { isInsideRoot: deps.isInsideRoot });
            if (refused !== null) {
                addStatus(refused.status, record.line, record.text, refused.detail);
                continue;
            }
            if (ran >= exports.REPLAY_LIMITS.MAX_COMMANDS) {
                skipped += 1;
                continue;
            }
            const elapsed = deps.now() - start;
            if (elapsed >= exports.REPLAY_LIMITS.TOTAL_BUDGET_MS) {
                addStatus(exports.REPLAY_STATUS.BUDGET_EXHAUSTED, record.line, record.text, 'the total replay time budget is spent');
                continue;
            }
            const timeoutMs = Math.min(exports.REPLAY_LIMITS.PER_COMMAND_TIMEOUT_MS, exports.REPLAY_LIMITS.TOTAL_BUDGET_MS - elapsed);
            ran += 1;
            let raw;
            try {
                raw = deps.run(tokens.argv, { timeoutMs });
            }
            catch (e) {
                addStatus(exports.REPLAY_STATUS.CANNOT_RUN, record.line, record.text, e instanceof Error ? e.message : String(e));
                continue;
            }
            const derived = deriveObservedValue(raw);
            if ('status' in derived) {
                addStatus(derived.status, record.line, record.text, derived.detail);
                continue;
            }
            const observed = derived.value;
            const recorded = record.notation.head;
            const matched = (0, criterion_baseline_cjs_1.compareBaseline)(recorded, '==', observed) === true;
            const revDrift = record.notation.rev !== null && typeof deps.headSha === 'string' && !deps.headSha.startsWith(record.notation.rev);
            report.results.push({
                line: record.line,
                text: record.text,
                argv: tokens.argv,
                recorded,
                observed,
                outcome: matched ? 'match' : 'mismatch',
                rev_drift: revDrift,
            });
            if (!matched) {
                report.mismatch_count += 1;
                report.warnings.push(`[plan-criteria replay] line ${record.line}: recorded HEAD=${(0, criterion_baseline_cjs_1.renderBaselineValue)(recorded)}, the command printed ${(0, criterion_baseline_cjs_1.renderBaselineValue)(observed)}${revDrift ? ' (baseline pinned to another commit)' : ''}`);
            }
        }
        if (skipped > 0 || dropped > 0) {
            report.statuses.push({
                code: exports.REPLAY_STATUS.TRUNCATED,
                line: 0,
                text: '',
                detail: `${skipped} command(s) not replayed after the first ${exports.REPLAY_LIMITS.MAX_COMMANDS}; ${dropped} further status(es) omitted`,
            });
        }
        return report;
    }
    catch (e) {
        return {
            head_sha: headSha,
            results: [],
            mismatch_count: 0,
            statuses: [{ code: exports.REPLAY_STATUS.REPLAY_ERROR, line: 0, text: '', detail: e instanceof Error ? e.message : String(e) }],
            warnings: [],
        };
    }
}
