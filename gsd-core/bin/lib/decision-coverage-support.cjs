"use strict";
/**
 * Decision-coverage support — the shared reading/matching helpers of the two decision-coverage
 * gates (#5139, epic #5056, ADR-5057 §4 first bullet, design D3/D4).
 *
 * Moved verbatim (behaviour preserved) from `check-command-router.cts`, with the raw-content
 * parsers replaced by their owning seams:
 *   - the frontmatter `must_haves` / `truths` / `objective` blocks are read through the
 *     Frontmatter Module (`frontmatterKeyBlockText`, the moved `extractYamlBlock`: raw text off
 *     the one fence owner's block, so frontmatter the YAML parser refuses is still scanned), and
 *     the SUMMARY `files_modified` list through its parsed reader (`rawFrontmatterField`), not a
 *     `files_modified:` regex;
 *   - the XML-tag body extraction lives in `markdown-sectionizer.cts` (`extractXmlTagBodies`).
 *
 * The router-facing gate modules (`gate-decision-coverage-plan.cts`,
 * `gate-decision-coverage-verify.cts`) import from here. This module imports no io module and
 * performs no direct console/stdout/stderr write (ESLint-enforced).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRACKER_RESOLVE_BUDGET_MS = void 0;
exports.decisionMentioned = decisionMentioned;
exports.phaseDirProblem = phaseDirProblem;
exports.loadPlanContents = loadPlanContents;
exports.loadSummaryContents = loadSummaryContents;
exports.loadDecisionExtraction = loadDecisionExtraction;
exports.extractPlanDesignatedSections = extractPlanDesignatedSections;
exports.resolveTrackerBodies = resolveTrackerBodies;
exports.buildPlanMessage = buildPlanMessage;
exports.buildVerifyMessage = buildVerifyMessage;
exports.phaseCommitMessages = phaseCommitMessages;
exports.readModifiedFilesContent = readModifiedFilesContent;
const node_path_1 = __importDefault(require("node:path"));
const decisions_cjs_1 = require("./decisions.cjs");
const frontmatter_fence_cjs_1 = require("./frontmatter-fence.cjs");
const markdown_sectionizer_cjs_1 = require("./markdown-sectionizer.cjs");
const security_cjs_1 = require("./security.cjs");
const gate_evidence_cjs_1 = require("./gate-evidence.cjs");
const gate_evaluation_scope_cjs_1 = require("./gate-evaluation-scope.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const frontmatterMod = require("./frontmatter.cjs");
const { rawFrontmatterField, frontmatterKeyBlockText } = frontmatterMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planScanMod = require("./plan-scan.cjs");
const { scanPhasePlans } = planScanMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planningScopeMod = require("./planning-scope.cjs");
const { SCOPE } = planningScopeMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planDocumentMod = require("./plan-document.cjs");
const { parsePlanDocument } = planDocumentMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const taskContentResolutionMod = require("./task-content-resolution.cjs");
const { resolveTaskContent, splitTrackerId, loadResolverCapabilities, isResolverFailure, contentTexts, } = taskContentResolutionMod;
// ─── Decision matching ────────────────────────────────────────────────────────
function normalizePhrase(text) {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
const SOFT_PHRASE_MIN_WORDS = 6;
function softPhrase(text) {
    const words = normalizePhrase(text).split(' ').filter(Boolean);
    if (words.length < SOFT_PHRASE_MIN_WORDS)
        return '';
    return words.slice(0, SOFT_PHRASE_MIN_WORDS).join(' ');
}
function decisionMentioned(haystack, decision) {
    if (!haystack)
        return false;
    if (new RegExp(`\\b${decision.id}\\b`).test(haystack))
        return true;
    const phrase = softPhrase(decision.text);
    return phrase ? normalizePhrase(haystack).includes(phrase) : false;
}
// ─── File reading ─────────────────────────────────────────────────────────────
// #4939: loadPlanContents answers no files for a path that is not there, and that reads
// as "no plan cites anything" — so a phase-dir argument that names no directory
// (the phase NUMBER in the phase-dir slot) must be told apart BEFORE the scan.
// Answers null for a directory, else what is wrong with the path and what to do
// about it. Like the plan gate's contextKind (#4794), the message names the real
// stat outcome: a permission or I/O failure (EACCES, ELOOP, EIO) is reported as
// unreadable, not as a missing directory. Only ENOENT/ENOTDIR mean the path is not there.
function phaseDirProblem(dirPath) {
    const passDirectory = 'Pass the phase DIRECTORY (e.g. .planning/phases/01-slug), not the phase number.';
    const st = (0, gate_evidence_cjs_1.statEvidence)(dirPath);
    if (st.kind === 'none')
        return { reason: 'phase directory not found', what: 'does not exist', hint: passDirectory, unreadable: false };
    if (st.kind === 'unreadable')
        return { reason: 'phase directory unreadable', what: `could not be read (${st.reason})`, hint: 'Check that the directory is readable.', unreadable: true };
    if (st.value.isDirectory())
        return null;
    return { reason: 'phase path is not a directory', what: st.value.isFile() ? 'is a file, not a directory' : 'is not a directory', hint: passDirectory, unreadable: false };
}
/**
 * The contents of the phase files `pick` selects (#5170, ADR-5057 §4). An ABSENT phase directory
 * is "no files" (`found []`); a directory or file that exists but cannot be read is `unreadable` —
 * a gate must not take "could not read the plan" for "the plan does not cite the decision".
 */
function readPhaseFiles(phaseDir, pick) {
    const entries = (0, gate_evidence_cjs_1.readDirEvidence)(phaseDir);
    if (entries.kind === 'none')
        return (0, gate_evidence_cjs_1.evidenceFound)([]);
    if (entries.kind === 'unreadable')
        return entries;
    const contents = [];
    // #3183 (lint-plan-count-drift): source live plan/summary files from the single
    // owner (scanPhasePlans) instead of a local readdirSync filter — picks up bare PLAN.md and
    // nested plans/, and excludes plans marked `status: superseded`.
    // Only SCOPE.COMPLETE is a real answer: an existing nested plans/ that could not be read (TRUNCATED)
    // would otherwise hand the gate a short plan set and let it conclude "no plan cites the decision".
    const scan = scanPhasePlans(phaseDir);
    if (scan.scope !== SCOPE.COMPLETE) {
        return { kind: 'unreadable', reason: `plan scan ${scan.scope}`, span: phaseDir };
    }
    for (const entry of pick(scan)) {
        const read = (0, gate_evidence_cjs_1.readTextEvidence)(node_path_1.default.join(phaseDir, entry));
        if (read.kind === 'unreadable')
            return read;
        if (read.kind === 'found')
            contents.push(read.value);
    }
    return (0, gate_evidence_cjs_1.evidenceFound)(contents);
}
function loadPlanContents(phaseDir) {
    return readPhaseFiles(phaseDir, (scan) => scan.planFiles);
}
/**
 * #3183 (lint-plan-count-drift): same single-owner sourcing as `loadPlanContents` —
 * scanPhasePlans's summaryFiles instead of a local `-SUMMARY.md` readdirSync filter.
 */
function loadSummaryContents(phaseDir) {
    return readPhaseFiles(phaseDir, (scan) => scan.summaryFiles);
}
/**
 * The decisions of `CONTEXT.md`. `none` is an absent file (the caller's legitimate "nothing to
 * check"); `unreadable` is a file that exists but could not be read — it must never be extracted as
 * empty text, which would certify "no trackable decisions".
 */
function loadDecisionExtraction(contextPath) {
    const read = (0, gate_evidence_cjs_1.readTextEvidence)(contextPath);
    if (read.kind !== 'found')
        return read;
    const extraction = (0, decisions_cjs_1.extractDecisions)(read.value);
    return (0, gate_evidence_cjs_1.evidenceFound)({
        trackable: extraction.decisions.filter((d) => d.trackable),
        outcome: extraction.outcome,
        unreadableIds: extraction.unreadableIds ?? [],
    });
}
// ─── Plan surfaces scanned for a decision citation ────────────────────────────
const DESIGNATED_HEADINGS_RE = /^#{1,6}\s+(?:must[_ ]haves?|truths?|tasks?|objective)\b/i;
function stripCommentsAndFences(text) {
    // HTML-comment stripping stays caller-side (the seam does not strip HTML comments).
    // Stop-at-next-open body (ReDoS-safe, #2128); an UNCLOSED `<!--` does not match,
    // so downstream tags are preserved (unlike a `(?:-->|$)` fallback, which would
    // wipe to EOF and fail-close the decision-coverage gate).
    const htmlStripped = text.replace(/<!--(?:(?!<!--)[\s\S])*?-->/g, ' ');
    // Fenced-code stripping: delegate to the canonical CommonMark-correct seam.
    // replaces the prior independent regex copy (```` ``` ``` ````  + `~~~ ~~~`).
    return (0, markdown_sectionizer_cjs_1.stripFencedCode)(htmlStripped).text;
}
function extractPlanDesignatedSections(planContent) {
    if (!planContent)
        return '';
    const cleaned = stripCommentsAndFences(planContent);
    // The block is the one the one fence owner finds; the body starts after the closing fence
    // line's line ending.
    const fence = (0, frontmatter_fence_cjs_1.locateFrontmatterFence)(cleaned);
    const body = fence?.closed ? cleaned.slice(fence.closingFenceEnd).replace(/^\r?\n/, '') : cleaned;
    const parts = [];
    for (const key of ['must_haves', 'truths', 'objective']) {
        const block = frontmatterKeyBlockText(cleaned, key);
        if (block)
            parts.push(block);
    }
    // Replace hand-rolled split(/\r?\n/) + heading walk with the seam's collectSections.
    // stopPredicate fires on EVERY heading (collectSections needs to start a section at
    // each heading), then we filter to designated ones — same semantics as the prior
    // inDesignated flag: emit the heading line + body only when DESIGNATED_HEADINGS_RE matches.
    const sections = (0, markdown_sectionizer_cjs_1.collectSections)(body, () => true);
    const bodyParts = [];
    for (const section of sections) {
        const headingLine = '#'.repeat(section.heading.level) + ' ' + section.heading.text;
        if (DESIGNATED_HEADINGS_RE.test(headingLine)) {
            bodyParts.push(headingLine);
            if (section.body)
                bodyParts.push(section.body);
        }
    }
    parts.push(bodyParts.join('\n'));
    parts.push((0, markdown_sectionizer_cjs_1.extractXmlTagBodies)(cleaned));
    return parts.join('\n\n');
}
/** Aggregate wall-clock budget for all resolver spawns in one gate run; registry load and each spawn's timeout are inside it (spawn timeouts are clamped to the remainder), so this is the true bound for resolver work. */
exports.TRACKER_RESOLVE_BUDGET_MS = 120_000;
const unreadable = (reason, span) => ({ kind: 'unreadable', reason, span });
/**
 * Extra scannable text per plan (same index) from tracker-resolved task content; '' for plans without `tracker-id=`.
 * `missingResolver` names the first tracker id with no installed resolver: coverage is monotone (a mention anywhere counts), so
 * that can only cause a false "uncovered" — callers go `unreadable` only when a decision would otherwise be uncovered.
 */
function resolveTrackerBodies(projectDir, planContents, deps = {}) {
    let missingResolver = null;
    let capabilities = null;
    const seen = new Map();
    const resolveFn = deps.resolveTaskContentFn ?? resolveTaskContent;
    const bodies = [];
    const now = deps.now ?? (() => performance.now());
    const startedAt = now();
    for (const raw of planContents) {
        const content = stripCommentsAndFences(raw);
        if (!/\btracker-id\s*=/i.test(content)) {
            bodies.push('');
            continue;
        }
        const parts = [];
        for (const task of parsePlanDocument(content).tasks) {
            const trackerId = task.trackerId;
            if (trackerId === null)
                continue;
            const cached = seen.get(trackerId);
            if (cached) {
                parts.push(...cached);
                continue;
            }
            if (capabilities === null) {
                try {
                    capabilities = (deps.loadCapabilities ?? loadResolverCapabilities)(projectDir);
                }
                catch (err) {
                    return unreadable(`capability registry unreadable: ${err instanceof Error ? err.message : String(err)}`, trackerId);
                }
            }
            // Floor: spawnSync rejects a fractional timeout, and a 0 timeout means unbounded, so a sub-ms remainder is a rejection.
            const remainingMs = Math.floor(exports.TRACKER_RESOLVE_BUDGET_MS - (now() - startedAt));
            if (remainingMs <= 0) {
                return unreadable(`tracker resolution exceeded the ${exports.TRACKER_RESOLVE_BUDGET_MS} ms aggregate budget`, trackerId);
            }
            try {
                const result = resolveFn({ trackerId, capabilities, timeoutOverrideMs: remainingMs });
                if (result.kind === 'no-resolver') {
                    missingResolver ??= { span: trackerId, reason: `no task-content resolver installed for tracker prefix "${splitTrackerId(trackerId)?.prefix}"` };
                }
                // Per field: an unclosed fence in one field must not swallow the rest.
                const texts = result.kind === 'resolved' ? contentTexts(result.content).map(stripCommentsAndFences) : [];
                seen.set(trackerId, texts);
                parts.push(...texts);
            }
            catch (err) {
                if (isResolverFailure(err)) {
                    return unreadable(`tracker task content unresolved: ${err.message}`, trackerId);
                }
                throw err;
            }
        }
        bodies.push(parts.join('\n'));
    }
    return (0, gate_evidence_cjs_1.evidenceFound)({ bodies, missingResolver });
}
function buildPlanMessage(uncovered) {
    if (uncovered.length === 0)
        return 'All trackable CONTEXT.md decisions are covered by plans.';
    return [
        '## Decision Coverage Gap',
        '',
        `${uncovered.length} CONTEXT.md decision(s) are not covered by any plan:`,
        '',
        ...uncovered.map((item) => `- **${item.id}** (${item.category || 'uncategorized'}): ${item.text}`),
        '',
        'Resolve by citing `D-NN:` in any of the scanned plan surfaces: front-matter',
        '`must_haves`/`truths`/`objective`, a `## must_haves`/`truths`/`tasks`/`objective`',
        'heading, or an `<objective>`/`<tasks>`/`<task>`/`<action>`/`<read_first>`/`<behavior>`/`<verify>`/`<acceptance_criteria>`/`<done>`',
        'tag body. Other locations (prose outside those headings, comments, other XML tags) are not scanned.',
        'OR move the decision to `### Claude\'s Discretion` / tag it `[informational]` if it should not be tracked.',
    ].join('\n');
}
function buildVerifyMessage(notHonored) {
    if (notHonored.length === 0)
        return 'All trackable CONTEXT.md decisions are honored by shipped artifacts.';
    return [
        '### Decision Coverage (warning)',
        '',
        `${notHonored.length} decision(s) not found in shipped artifacts:`,
        '',
        ...notHonored.map((item) => `- **${item.id}** (${item.category || 'uncategorized'}): ${item.text}`),
        '',
        'This is a soft warning - verification status is unchanged.',
    ].join('\n');
}
// ─── Shipped-artifact haystack (verify gate) ──────────────────────────────────
/**
 * The subjects and bodies of the PHASE'S OWN commits (#5164, ADR-5057 §4) — the evaluation-scope
 * resolver's commit set for `phaseDir`, not the last 200 commits of whatever branch is checked
 * out. A phase with no recorded task commits widens to the commits in its directory range (the
 * resolver says so); an unreadable phase or repository yields '' ("could not look"), and a git
 * failure on a non-git project dir writes nothing to the terminal.
 */
function phaseCommitMessages(projectDir, phaseDir) {
    const scope = (0, gate_evaluation_scope_cjs_1.resolveEvaluationScope)(projectDir, { kind: 'phase', phase: '', phaseDir }, { includeBody: true, includeFiles: false });
    return scope.commits.map((c) => `${c.subject}\n${c.body ?? ''}`).join('\n');
}
/** Cap on files read across all SUMMARYs, and on bytes read per file. */
const MODIFIED_FILES_MAX_COUNT = 50;
const MODIFIED_FILES_MAX_BYTES = 256 * 1024;
/**
 * The contents of every file the SUMMARYs list under frontmatter `files_modified`, contained to
 * `projectDir` and capped at `MODIFIED_FILES_MAX_COUNT` files / `MODIFIED_FILES_MAX_BYTES` each.
 */
function readModifiedFilesContent(projectDir, summaries) {
    const out = [];
    let total = 0;
    for (const summary of summaries) {
        if (!summary)
            continue;
        if (total >= MODIFIED_FILES_MAX_COUNT)
            break;
        const field = rawFrontmatterField(summary, 'files_modified');
        const listed = field && Array.isArray(field.value) ? field.value : [];
        for (const entry of listed) {
            if (total >= MODIFIED_FILES_MAX_COUNT)
                break;
            if (typeof entry !== 'string')
                continue;
            const file = entry.trim();
            if (!file)
                continue;
            // Migrated off the hand-rolled prefix check (ADR-4650): resolve+contain in one
            // step via the canonical realpath predicate — the eventual read below follows
            // symlinks, so containment must be decided on the resolved target, not a lexical
            // prefix. Read the value the predicate RETURNED; do not re-derive the path.
            const candidate = node_path_1.default.isAbsolute(file) ? file : node_path_1.default.join(projectDir, file);
            const contained = (0, security_cjs_1.tryWithinRoot)(candidate, projectDir, security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
            if (contained === null)
                continue;
            // An absent listed file contributes nothing readable (`''`); one that exists but cannot be
            // read is `unreadable` — the decision it may cite was never seen (#5170).
            const read = (0, gate_evidence_cjs_1.readTextEvidence)(contained);
            if (read.kind === 'unreadable')
                return read;
            const content = read.kind === 'found' ? read.value : '';
            out.push(content.length > MODIFIED_FILES_MAX_BYTES ? content.slice(0, MODIFIED_FILES_MAX_BYTES) : content);
            total++;
        }
    }
    return (0, gate_evidence_cjs_1.evidenceFound)(out.join('\n\n'));
}
