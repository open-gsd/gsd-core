"use strict";
/**
 * Open Artifact Audit — Cross-type unresolved state scanner
 *
 * Scans all .planning/ artifact categories for items with open/unresolved state.
 * Returns structured JSON for workflow consumption.
 * Called by: gsd-tools.cjs audit-open
 * Used by: /gsd:complete-milestone pre-close gate
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/audit.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
const markdown_sectionizer_cjs_1 = require("./markdown-sectionizer.cjs");
const text_lines_cjs_1 = require("./text-lines.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const coreUtils = require("./core-utils.cjs");
const { normalizeLineEndings } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planningWorkspace = require("./planning-workspace.cjs");
const { planningDir, quickDirFrom, debugDir, todosDir } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const frontmatter = require("./frontmatter.cjs");
// #4378 (roll-in): scanSeeds publishes the SAME canonical seed identity the
// list-seeds gate derives — one grammar, two surfaces, no drift. commands.cjs
// does not require this module, so the edge is acyclic.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const commandsModule = require("./commands.cjs");
const { extractFrontmatter, frontmatterBlock, spliceFrontmatter, isFrontmatterWriteRefusal } = frontmatter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const phaseIdMod = require("./phase-id.cjs");
const { PHASE_NUMBER_TOKEN_SOURCE, scopeToPhase } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const phaseLocator = require("./phase-locator.cjs");
const { getAllArchivedPhaseDirs } = phaseLocator;
const security_cjs_1 = require("./security.cjs");
const shell_command_projection_cjs_2 = require("./shell-command-projection.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const io = require("./io.cjs");
const { output, error: ioError } = io;
const command_arg_projection_cjs_1 = require("./command-arg-projection.cjs");
// #5118: the verification-status owner's report reader and closed enum.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const verificationMod = require("./verification.cjs");
const { reportStatusOf, VERIFICATION_STATUS, VerificationStatusError } = verificationMod;
const clock_cjs_1 = require("./clock.cjs");
// The SCOPE BOUNDARY convention's filename (`agents/gsd-executor.md`), shared
// verbatim with the #2287 phase-boundary reader in `uat.cts`.
const DEFERRED_ITEMS_FILENAME = 'deferred-items.md';
// Terminal UAT states: `complete` (legacy) and `resolved` (post-gap-closure
// per workflows/execute-phase.md). Hoisted outside scanUatGaps so the Set is
// not recreated on each loop iteration.
const TERMINAL_UAT_STATUSES = new Set(['complete', 'resolved']);
// ─── Acknowledgment marker (suppression) ──────────────────────────────────────
//
// #3458 follow-up: `query audit-open` now scans archived milestone phase dirs,
// so an item still unresolved when a milestone closed resurfaces at EVERY
// later close, forever — `[A] Acknowledge all` documented that decision to
// STATE.md but never suppressed it. This section is the suppression seam.
//
// The marker lives INSIDE the artifact it suppresses, as an
// `audit_acknowledged` frontmatter map (no ledger, no id minting — see
// `uat.cts:891-897`'s `deferred-items.md` in-place `status: resolved`
// convention, which this generalizes):
//
//   audit_acknowledged:
//     milestone: v1.0        # which milestone close acknowledged it
//     at: 2026-08-15          # ISO date
//     status: gaps_found      # snapshot of the artifact's state AT acknowledgment
//                              # (named `gap_snapshot` — status + open-scenario
//                              # count — for `uat_gaps`, and `questions_digest`
//                              # — a content hash of the question set, not just
//                              # its count — for `context_questions`; see
//                              # `isAuditItemAcknowledged`'s `snapshotKey` param
//                              # and each category's `deriveXxx` snapshot
//                              # helper for why a bare status/count was not
//                              # enough for those two — #3458 follow-up review)
//
// It is VERDICT-PRESERVING (this section never writes `status:` itself — see
// `cmdAuditAcknowledge` below) and SELF-INVALIDATING: it suppresses ONLY while
// `snapshotKey`'s recorded value still equals the artifact's CURRENT
// effective value. Edit the artifact after acknowledging it and the item
// resurfaces automatically — no separate revive/carry-forward state, and a
// stale acknowledgment can never hide a NEW problem, PROVIDED the category's
// snapshot actually captures the dimension that changed — `uat_gaps` and
// `context_questions` snapshot more than their status/count for exactly this
// reason (see above); every other category's only tracked dimension IS its
// `status:` (or, for `todos`, presence), so a bare status/presence snapshot
// is already complete for those.
//
// `isAuditItemAcknowledged` is the ONE shared predicate every scanner below
// routes through — this file has already been through the "hand-rolled the
// same check nine times" defect family twice this PR; a tenth hand-roll here
// is exactly that class. `deferred_items` is the deliberate exception: its
// suppression key lives PER-ENTRY inside `deferred-items.md`'s own
// `status:` field (see `uat.cts`'s `parseDeferredItemsWithStatus`), not in a
// file-level `audit_acknowledged` map, because a single deferred-items.md can
// carry many independently-acknowledgeable entries.
/**
 * Parse and validate an artifact's `audit_acknowledged` frontmatter marker,
 * then decide whether it suppresses the item given the artifact's CURRENT
 * effective state.
 *
 * `snapshotKey` names which sub-field of the marker map carries the snapshot
 * comparison value (`'status'` for every category except CONTEXT files, which
 * use `'question_count'`). `presenceOnly: true` (used only for `todos`, which
 * has no natural status field to snapshot) skips the snapshot comparison
 * entirely — marker PRESENCE alone suppresses.
 *
 * A marker that is not a plain object/map, or is missing a non-empty string
 * `milestone`/`at`, or — when a snapshot comparison applies — missing a
 * string at `snapshotKey`, is MALFORMED and treated as ABSENT: this function
 * returns `false` and the item surfaces. A bad marker must never suppress.
 */
function isAuditItemAcknowledged(fm, opts) {
    const raw = fm.audit_acknowledged;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return false;
    const marker = raw;
    if (typeof marker.milestone !== 'string' || !marker.milestone)
        return false;
    if (typeof marker.at !== 'string' || !marker.at)
        return false;
    if (opts.presenceOnly)
        return true;
    const snapshot = marker[opts.snapshotKey];
    if (typeof snapshot !== 'string')
        return false;
    return snapshot === opts.currentValue;
}
/**
 * Derive a THREAD file's effective status: frontmatter `status:` when
 * present, else the `## Status: OPEN|IN PROGRESS` body fallback — the same
 * two-step derivation `scanThreads` already performed inline. Extracted so
 * `cmdAuditAcknowledge` computes the CURRENT snapshot value with the exact
 * same logic the scanner used to produce the marker's recorded value,
 * instead of a second hand-derivation that could silently drift from it.
 */
function deriveThreadStatus(fm, content) {
    let status = (fm.status || '').toLowerCase().trim();
    if (!status) {
        const bodyStatusMatch = content.match(/##\s*Status:\s*(OPEN|IN PROGRESS|IN_PROGRESS)/i);
        if (bodyStatusMatch) {
            status = bodyStatusMatch[1].toLowerCase().replace(/ /g, '_');
        }
    }
    return status;
}
/**
 * Count a UAT file's still-open (`result: pending`/`[pending]`) scenarios.
 * Extracted from `scanUatGaps`'s inline logic for the same reason as
 * `deriveThreadStatus` — one derivation, shared by the scanner and
 * `cmdAuditAcknowledge`'s `deriveUatGapSnapshotValue` below.
 */
function deriveUatGapOpenScenarioCount(content) {
    return (content.match(/result:\s*(?:pending|\[pending\])/gi) || []).length;
}
/**
 * Stable snapshot value for a `uat_gaps` item (WARNING 2, #3458 follow-up
 * review). `status` alone is COUNT-blind the other direction: a UAT file can
 * stay in the SAME open status (`gaps_found`) while gaining MORE pending
 * scenarios (measured: 1→6 pending, status unchanged, item stayed
 * suppressed under the old status-only scheme). Composing `status` with the
 * open-scenario count means either dimension changing invalidates the
 * snapshot.
 */
function deriveUatGapSnapshotValue(status, content) {
    return `${status}::scenarios=${deriveUatGapOpenScenarioCount(content)}`;
}
/**
 * Derive a CONTEXT file's FULL, UNTRUNCATED open-questions list: the
 * structured `open_questions` frontmatter array when present and
 * non-empty, else EVERY qualifying line of the `## Open Questions` body
 * section. Extracted from `scanContextQuestions`'s inline logic for the same
 * reason as `deriveThreadStatus` — one derivation, shared by the scanner and
 * `cmdAuditAcknowledge`, so the acknowledged `question_count`/digest snapshot
 * can never diverge from what the scanner counts.
 *
 * F2 (#3458 follow-up review, sibling of the deferred_items span-carrying
 * fix): this used to `slice(0, 3)` the body-section list AND clamp each
 * question to 200 chars BEFORE returning — a value meant for DISPLAY reused
 * for the IDENTITY snapshot `deriveOpenQuestionsDigest` hashes. A 4th+
 * question, or anything past char 200 of an earlier one, was invisible to
 * the digest: an attacker could ship 3 innocuous questions first, then add
 * real blockers afterward with zero effect on the recorded snapshot. Every
 * caller that wants a bounded list for DISPLAY (`scanContextQuestions`'s
 * `questions` field) truncates its OWN copy at the call site; this function
 * always returns the complete, unclamped set.
 */
function deriveOpenQuestions(content, fm) {
    let questions = [];
    if (fm.open_questions) {
        if (Array.isArray(fm.open_questions) && fm.open_questions.length > 0) {
            questions = fm.open_questions.map(q => (0, security_cjs_1.sanitizeForDisplay)(String(q)));
        }
    }
    if (questions.length === 0) {
        const oqSection = (0, markdown_sectionizer_cjs_1.collectSection)(content, (h) => h.level === 2 && h.text.trim().toLowerCase().startsWith('open questions'), { levelBounded: true });
        if (oqSection) {
            const oqBody = oqSection.body.trim();
            if (oqBody && oqBody.length > 0 && !/^\s*none\s*$/i.test(oqBody)) {
                const items = oqBody.split('\n')
                    .map((l) => l.trim())
                    .filter((l) => l && l !== '-' && l !== '*')
                    .filter((l) => /^[-*\d]/.test(l) || l.includes('?'));
                questions = items.map((q) => (0, security_cjs_1.sanitizeForDisplay)(q));
            }
        }
    }
    return questions;
}
/** Bound a question's DISPLAY text (never fed into the identity digest — see `deriveOpenQuestions`'s doc comment). */
function truncateQuestionForDisplay(question) {
    return question.slice(0, 200);
}
/**
 * Stable normalized digest of a CONTEXT file's open-questions set (WARNING 2,
 * #3458 follow-up review). `question_count` alone is COUNT-only: replacing
 * every question's TEXT with brand-new ones while holding the count steady
 * left an acknowledged item permanently suppressed (measured: 2 questions
 * acknowledged, then both replaced with unrelated new blockers — still
 * `counts:0`). Hashing the full, ordered question text means ANY edit —
 * add, remove, reword, or reorder — changes the digest and the item
 * resurfaces. sha256 (not the raw joined string) keeps the marker's stored
 * value bounded regardless of question length/count.
 *
 * `questions` MUST be the untruncated, unclamped set `deriveOpenQuestions`
 * returns — never a display-sliced/-clamped copy (F2, #3458 follow-up
 * review); a truncated input reintroduces exactly the blind spot this digest
 * exists to close.
 *
 * Length-prefixed, separator-free encoding (SWEEP finding, #3458 follow-up
 * review) — NOT a plain join (the prior revision joined on a literal
 * embedded NUL byte, `questions.join('\\0')` written as a raw control
 * character in the SOURCE FILE itself — invisible in a normal diff/editor
 * and still forgeable: attacker-controlled markdown CAN contain a literal
 * NUL codepoint, since the file is read as UTF-8 text, so that scheme never
 * actually closed the boundary-collision gap it was reaching for). A bare
 * separator-joined string has no reliably unambiguous element boundary: two
 * DIFFERENT question arrays can render the identical joined string and
 * collide on the same digest — e.g. `['- Is X ready?', '- Y done?']` and
 * `['- Is X ready? - Y', 'done?']` both join to
 * `'- Is X ready? - Y done?'` under a space-join, and both could be forced to
 * collide under a NUL-join too by an attacker who embeds the separator
 * itself. Prefixing each element with its own CHARACTER LENGTH
 * (`<len>:<text>`, concatenated with no separator at all) makes the encoding
 * self-delimiting instead: decoding always consumes exactly `<len>`
 * characters after each `:` before reading the next length prefix, so no two
 * distinct arrays can ever encode to the same string — regardless of what
 * characters the questions themselves contain.
 */
function deriveOpenQuestionsDigest(questions) {
    const encoded = questions.map((q) => `${q.length}:${q}`).join('');
    return node_crypto_1.default.createHash('sha256').update(encoded).digest('hex');
}
// ─── scanDebugSessions ────────────────────────────────────────────────────────
/**
 * #4869: gsd-debugger's archive_session step appends every resolved session to
 * this file in the debug directory. It is a document, not a session: it has no
 * frontmatter, so its status would derive `unknown` and read as open forever.
 * Excluded by this fixed name only. Any other file with missing or unparseable
 * frontmatter is still an open session. Every shipped debug-directory reader
 * excludes the same name from active sessions (#5011).
 */
const DEBUG_KNOWLEDGE_BASE_FILENAME = 'knowledge-base.md';
/**
 * Scan the root-scoped .planning/debug/ directory supplied by the caller for open sessions.
 * Open = status NOT in ['resolved', 'complete'].
 * Ignores the resolved/ subdirectory and the debugger's knowledge base.
 */
function scanDebugSessions(debugPath) {
    if (!node_fs_1.default.existsSync(debugPath))
        return { items: [], acknowledged: 0 };
    const results = [];
    let acknowledged = 0;
    let files;
    try {
        files = node_fs_1.default.readdirSync(debugPath, { withFileTypes: true });
    }
    catch {
        return { items: [{ scan_error: true, slug: '', status: '', updated: '', hypothesis: '' }], acknowledged: 0 };
    }
    for (const entry of files) {
        if (!entry.isFile())
            continue;
        if (!entry.name.endsWith('.md'))
            continue;
        if (entry.name === DEBUG_KNOWLEDGE_BASE_FILENAME)
            continue;
        const filePath = node_path_1.default.join(debugPath, entry.name);
        let safeFilePath;
        try {
            safeFilePath = (0, security_cjs_1.requireSafePath)(filePath, node_path_1.default.dirname(debugPath), 'debug session file', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
        }
        catch {
            continue;
        }
        // #3078-CR MEDIUM 2 (security review follow-up): normalize a lone-CR
        // document at this read boundary, same seam as `src/uat.cts`'s
        // `readNormalizedDocument` — `platformReadSync` performs no line-ending
        // normalization itself, and extractFrontmatter/status-derivation below
        // degrade a lone-CR file's frontmatter to `unknown`, which this scan
        // reports as an open session (#4869) — so an un-normalized resolved
        // session would resurface as open.
        const rawContent = (0, shell_command_projection_cjs_1.platformReadSync)(safeFilePath);
        if (rawContent === null)
            continue;
        const content = normalizeLineEndings(rawContent);
        const fm = extractFrontmatter(content, safeFilePath);
        const status = (fm.status || 'unknown').toLowerCase();
        if (status === 'resolved' || status === 'complete')
            continue;
        if (isAuditItemAcknowledged(fm, { snapshotKey: 'status', currentValue: status })) {
            acknowledged++;
            continue;
        }
        // Extract hypothesis from "Current Focus" block if parseable
        let hypothesis = '';
        const focusSection = (0, markdown_sectionizer_cjs_1.collectSection)(content, (h) => h.level === 2 && h.text.trim().toLowerCase().startsWith('current focus'), { levelBounded: true });
        if (focusSection) {
            const focusText = focusSection.body.trim().split('\n')[0].trim();
            hypothesis = (0, security_cjs_1.sanitizeForDisplay)(focusText.slice(0, 100));
        }
        const slug = node_path_1.default.basename(entry.name, '.md');
        results.push({
            slug: (0, security_cjs_1.sanitizeLabel)(slug),
            status: (0, security_cjs_1.sanitizeForDisplay)(status),
            updated: (0, security_cjs_1.sanitizeForDisplay)(fm.updated || fm.date || ''),
            hypothesis,
        });
    }
    return { items: results, acknowledged };
}
// ─── resolveQuickTaskSummaryFile ───────────────────────────────────────────────
/**
 * Resolve a quick task's SUMMARY file, if any exists, under its own
 * directory (`taskDir`). workflows/quick.md mandates `${quick_id}-SUMMARY.md`;
 * older flows used bare `SUMMARY.md` — accept either to avoid a
 * false-positive "missing", preferring the per-task `${dirName}-SUMMARY.md`
 * form when more than one candidate exists.
 *
 * #3183 (ADR-3180 Decision 4(a) — bucket B, out of scope for the
 * scanPhasePlans migration): this scans a quick task's OWN directory
 * (`.planning/quick/<task>/`) for THAT task's single completion record —
 * "does this one quick task have a SUMMARY.md" — not a phase directory's
 * live-plan/summary counting question. scanPhasePlans is the wrong tool
 * here; there is no plan/summary PAIRING to derive, only a single filename
 * presence check local to a non-phase directory.
 *
 * Extracted (#3458 follow-up) so `scanQuickTasks` (read) and
 * `cmdAuditAcknowledge`'s quick_tasks writer share the ONE discovery rule —
 * previously the writer would have had to hand-roll this exact filter a
 * second time, which is exactly the re-derivation-drift class
 * `scripts/lint-plan-count-drift.cjs` exists to catch (see its
 * `FUNCTION_SCOPED_EXEMPTIONS` entry for this function).
 *
 * Returns `null` (never throws) on an unreadable `taskDir` or when no
 * SUMMARY-shaped file exists.
 */
function resolveQuickTaskSummaryFile(taskDir, dirName) {
    let summaryFiles;
    try {
        summaryFiles = node_fs_1.default.readdirSync(taskDir, { withFileTypes: true })
            .filter(e => e.isFile() && (e.name === 'SUMMARY.md' || e.name.endsWith('-SUMMARY.md')));
    }
    catch {
        return null;
    }
    if (summaryFiles.length === 0)
        return null;
    const preferred = summaryFiles.find(e => e.name === `${dirName}-SUMMARY.md`)
        || summaryFiles.find(e => e.name.endsWith('-SUMMARY.md'))
        || summaryFiles[0];
    return node_path_1.default.join(taskDir, preferred.name);
}
// ─── scanQuickTasks ───────────────────────────────────────────────────────────
/**
 * Scan .planning/quick/ for incomplete tasks.
 * Incomplete if SUMMARY.md missing or status !== 'complete'.
 */
function scanQuickTasks(planDir) {
    // #2142: routed through the shared quickDirFrom composer (planning-workspace.cts)
    // so `.planning/quick` has exactly ONE owner instead of two ad-hoc path.joins.
    const quickDir = quickDirFrom(planDir);
    if (!node_fs_1.default.existsSync(quickDir))
        return { items: [], acknowledged: 0 };
    let entries;
    try {
        entries = node_fs_1.default.readdirSync(quickDir, { withFileTypes: true });
    }
    catch {
        return { items: [{ scan_error: true, slug: '', date: '', status: '', description: '' }], acknowledged: 0 };
    }
    const results = [];
    let acknowledged = 0;
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const dirName = entry.name;
        const taskDir = node_path_1.default.join(quickDir, dirName);
        let safeTaskDir;
        try {
            safeTaskDir = (0, security_cjs_1.requireSafePath)(taskDir, planDir, 'quick task dir', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
        }
        catch {
            continue;
        }
        const summaryPath = resolveQuickTaskSummaryFile(safeTaskDir, dirName);
        let status = 'missing';
        const description = '';
        let fm = null;
        if (summaryPath && node_fs_1.default.existsSync(summaryPath)) {
            let safeSum;
            try {
                safeSum = (0, security_cjs_1.requireSafePath)(summaryPath, planDir, 'quick task summary', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
            }
            catch {
                continue;
            }
            // #3078-CR MEDIUM 2: same normalize-at-read-boundary fix as the other
            // scans in this module — see the comment above `scanDebugSessions`'s
            // read.
            const rawContent = (0, shell_command_projection_cjs_1.platformReadSync)(safeSum);
            if (rawContent === null) {
                status = 'unreadable';
            }
            else {
                const content = normalizeLineEndings(rawContent);
                fm = extractFrontmatter(content, safeSum);
                status = (fm.status || 'unknown').toLowerCase();
            }
        }
        if (status === 'complete')
            continue;
        // Acknowledgment marker only ever lives in the SUMMARY file's own
        // frontmatter — a task with no summary (status: 'missing') has nowhere to
        // carry one, so `fm` is null and this is skipped (never suppressed).
        if (fm && isAuditItemAcknowledged(fm, { snapshotKey: 'status', currentValue: status })) {
            acknowledged++;
            continue;
        }
        // Parse date and slug from directory name: YYYYMMDD-slug or YYYY-MM-DD-slug
        let date = '';
        let slug = (0, security_cjs_1.sanitizeLabel)(dirName);
        const dateMatch = dirName.match(/^(\d{4}-?\d{2}-?\d{2})-(.+)$/);
        if (dateMatch) {
            // dateMatch[1] is regex-constrained to `\d{4}-?\d{2}-?\d{2}` (digits and
            // literal hyphens only — the same "constrained at the source" shape as
            // `archived_milestone`), so it cannot itself carry a control byte.
            // Still routed through sanitizeLabel as defense-in-depth for
            // consistency with every other directory-name-derived field here.
            date = (0, security_cjs_1.sanitizeLabel)(dateMatch[1]);
            slug = (0, security_cjs_1.sanitizeLabel)(dateMatch[2]);
        }
        results.push({
            slug,
            date,
            status: (0, security_cjs_1.sanitizeForDisplay)(status),
            description,
        });
    }
    return { items: results, acknowledged };
}
// ─── scanThreads ──────────────────────────────────────────────────────────────
/**
 * Scan .planning/threads/ for open threads.
 * Open if status in ['open', 'in_progress', 'in progress'] (case-insensitive).
 */
function scanThreads(planDir) {
    const threadsDir = node_path_1.default.join(planDir, 'threads');
    if (!node_fs_1.default.existsSync(threadsDir))
        return { items: [], acknowledged: 0 };
    let files;
    try {
        files = node_fs_1.default.readdirSync(threadsDir, { withFileTypes: true });
    }
    catch {
        return { items: [{ scan_error: true, slug: '', status: '', updated: '', title: '' }], acknowledged: 0 };
    }
    const openStatuses = new Set(['open', 'in_progress', 'in progress']);
    const results = [];
    let acknowledged = 0;
    for (const entry of files) {
        if (!entry.isFile())
            continue;
        if (!entry.name.endsWith('.md'))
            continue;
        const filePath = node_path_1.default.join(threadsDir, entry.name);
        let safeFilePath;
        try {
            safeFilePath = (0, security_cjs_1.requireSafePath)(filePath, planDir, 'thread file', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
        }
        catch {
            continue;
        }
        // #3078-CR MEDIUM 2 (security review follow-up): normalize a lone-CR
        // document at this read boundary, same seam as `src/uat.cts`'s
        // `readNormalizedDocument` — `platformReadSync` performs no line-ending
        // normalization itself, and extractFrontmatter/status-derivation below
        // degrade a lone-CR file's frontmatter to `unknown`, which every scan
        // in this module treats as "not open" (fail-open, the permissive
        // direction) rather than a real parse gap.
        const rawContent = (0, shell_command_projection_cjs_1.platformReadSync)(safeFilePath);
        if (rawContent === null)
            continue;
        const content = normalizeLineEndings(rawContent);
        const fm = extractFrontmatter(content, safeFilePath);
        const status = deriveThreadStatus(fm, content);
        if (!openStatuses.has(status))
            continue;
        if (isAuditItemAcknowledged(fm, { snapshotKey: 'status', currentValue: status })) {
            acknowledged++;
            continue;
        }
        // Extract title from # Thread: heading or frontmatter title
        let title = (0, security_cjs_1.sanitizeForDisplay)(fm.title || '');
        if (!title) {
            const headingMatch = content.match(/^#\s*Thread:\s*(.+)$/m);
            if (headingMatch) {
                title = (0, security_cjs_1.sanitizeForDisplay)(headingMatch[1].trim().slice(0, 100));
            }
        }
        const slug = node_path_1.default.basename(entry.name, '.md');
        results.push({
            slug: (0, security_cjs_1.sanitizeLabel)(slug),
            status: (0, security_cjs_1.sanitizeForDisplay)(status),
            updated: (0, security_cjs_1.sanitizeForDisplay)(fm.updated || fm.date || ''),
            title,
        });
    }
    return { items: results, acknowledged };
}
// ─── scanTodos ────────────────────────────────────────────────────────────────
/**
 * Scan .planning/todos/pending/ for pending todos.
 * Returns array of { filename, priority, area, summary }.
 * Display limited to first 5 + count of remainder.
 *
 * #4256: takes the ROOT-scoped todos base (`todosDir(cwd)`), NOT the
 * workstream-scoped planning dir the other scans use — todos are shared
 * project state (the migrateToWorkstreams contract keeps them at
 * .planning/todos/), so the close gate must read the root or it clears
 * vacuously under a workstream. The requireSafePath boundary below moves
 * with the base.
 */
function scanTodos(todosBase) {
    const pendingDir = node_path_1.default.join(todosBase, 'pending');
    if (!node_fs_1.default.existsSync(pendingDir))
        return { items: [], acknowledged: 0 };
    let files;
    try {
        files = node_fs_1.default.readdirSync(pendingDir, { withFileTypes: true });
    }
    catch {
        return { items: [{ scan_error: true, filename: '', priority: '', area: '', summary: '' }], acknowledged: 0 };
    }
    const mdFiles = files.filter(e => e.isFile() && e.name.endsWith('.md'));
    const results = [];
    let acknowledged = 0;
    // BLOCKER 2 (#3458 follow-up review): filter acknowledged items BEFORE
    // the display cap. Capping the RAW file list to 5 first meant an
    // acknowledge of one of those 5 files simply revealed the 6th on the next
    // scan — files 6/7/... (never shown, never acknowledgeable via the CLI's
    // own remedy) permanently vanished from every later scan once 5+ items
    // existed, because `mdFiles.length` (not the post-filter open count) drove
    // both the cap and the remainder count. Read every file's acknowledgment
    // state first, THEN cap the OPEN (unacknowledged) set for display.
    const openFiles = [];
    for (const entry of mdFiles) {
        const filePath = node_path_1.default.join(pendingDir, entry.name);
        let safeFilePath;
        try {
            safeFilePath = (0, security_cjs_1.requireSafePath)(filePath, todosBase, 'todo file', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
        }
        catch {
            continue;
        }
        // #3078-CR MEDIUM 2 (security review follow-up): normalize a lone-CR
        // document at this read boundary, same seam as `src/uat.cts`'s
        // `readNormalizedDocument` — `platformReadSync` performs no line-ending
        // normalization itself, and extractFrontmatter/status-derivation below
        // degrade a lone-CR file's frontmatter to `unknown`, which every scan
        // in this module treats as "not open" (fail-open, the permissive
        // direction) rather than a real parse gap.
        const rawContent = (0, shell_command_projection_cjs_1.platformReadSync)(safeFilePath);
        if (rawContent === null)
            continue;
        const content = normalizeLineEndings(rawContent);
        const fm = extractFrontmatter(content, safeFilePath);
        // Todos carry no natural status field — presence in pending/ IS "open" by
        // definition (a resolved todo is moved out, not status-flagged). So the
        // acknowledgment check here is PRESENCE-ONLY: no snapshot to go stale, no
        // self-invalidation on edit — see `isAuditItemAcknowledged`'s doc comment.
        if (isAuditItemAcknowledged(fm, { snapshotKey: 'status', currentValue: '', presenceOnly: true })) {
            acknowledged++;
            continue;
        }
        openFiles.push({ entry, content, fm });
    }
    const displayFiles = openFiles.slice(0, 5);
    for (const { entry, content, fm } of displayFiles) {
        // Extract first line of body after frontmatter — the block `extractFrontmatter` read above
        // (the one fence owner), so a `---` inside a value cannot end it early.
        const block = frontmatterBlock(content);
        const todoBody = block ? block.rest : content;
        const firstLine = (0, text_lines_cjs_1.splitLines)(todoBody.trim())[0] || '';
        const summary = (0, security_cjs_1.sanitizeForDisplay)(firstLine.slice(0, 100));
        results.push({
            filename: (0, security_cjs_1.sanitizeLabel)(entry.name),
            priority: (0, security_cjs_1.sanitizeForDisplay)(fm.priority || ''),
            area: (0, security_cjs_1.sanitizeForDisplay)(fm.area || ''),
            summary,
        });
    }
    if (openFiles.length > 5) {
        results.push({ _remainder_count: openFiles.length - 5, filename: '', priority: '', area: '', summary: '' });
    }
    return { items: results, acknowledged };
}
// #4378 (roll-in): true when the filename is a well-formed seed name —
// `SEED-` prefix, `.md` suffix, and no control bytes anywhere in between (the
// scanSeeds admission filter passes such names through to the identity
// derivation; a name with an embedded control byte falls back to its raw
// stem exactly as the pre-canonical code did).
function seedIdMatchRawName(name) {
    return !/[\u0000-\u001f\u007f]/.test(name);
}
// ─── scanSeeds ────────────────────────────────────────────────────────────────
/**
 * Scan .planning/seeds/SEED-*.md for unimplemented seeds.
 * Unimplemented if status in ['dormant', 'active', 'triggered'].
 */
function scanSeeds(planDir) {
    const seedsDir = node_path_1.default.join(planDir, 'seeds');
    if (!node_fs_1.default.existsSync(seedsDir))
        return { items: [], acknowledged: 0 };
    let files;
    try {
        files = node_fs_1.default.readdirSync(seedsDir, { withFileTypes: true });
    }
    catch {
        return { items: [{ scan_error: true, seed_id: '', slug: '', status: '', title: '' }], acknowledged: 0 };
    }
    const unimplementedStatuses = new Set(['dormant', 'active', 'triggered']);
    const results = [];
    let acknowledged = 0;
    for (const entry of files) {
        if (!entry.isFile())
            continue;
        if (!entry.name.startsWith('SEED-') || !entry.name.endsWith('.md'))
            continue;
        const filePath = node_path_1.default.join(seedsDir, entry.name);
        let safeFilePath;
        try {
            safeFilePath = (0, security_cjs_1.requireSafePath)(filePath, planDir, 'seed file', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
        }
        catch {
            continue;
        }
        // #3078-CR MEDIUM 2 (security review follow-up): normalize a lone-CR
        // document at this read boundary, same seam as `src/uat.cts`'s
        // `readNormalizedDocument` — `platformReadSync` performs no line-ending
        // normalization itself, and extractFrontmatter/status-derivation below
        // degrade a lone-CR file's frontmatter to `unknown`, which every scan
        // in this module treats as "not open" (fail-open, the permissive
        // direction) rather than a real parse gap.
        const rawContent = (0, shell_command_projection_cjs_1.platformReadSync)(safeFilePath);
        if (rawContent === null)
            continue;
        const content = normalizeLineEndings(rawContent);
        const fm = extractFrontmatter(content, safeFilePath);
        const status = (fm.status || 'dormant').toLowerCase();
        if (!unimplementedStatuses.has(status))
            continue;
        if (isAuditItemAcknowledged(fm, { snapshotKey: 'status', currentValue: status })) {
            acknowledged++;
            continue;
        }
        // #4378 (roll-in): the canonical identity comes from the SAME derivation
        // the list-seeds surface uses — frontmatter `id:` when it matches a seed
        // grammar (legacy `SEED-NNN` or date-suffixed `SEED-YYMMDD-xxx`), else the
        // filename's id prefix, else the whole stem. The old fused
        // filename-stem id (e.g. `SEED-081-region` for `SEED-081-region.md`)
        // disagreed with list-seeds and misfiled deferrals; publishing the
        // canonical id keeps the two surfaces answering identically. The raw-
        // basename fallback for control-byte-bearing names is preserved.
        const stem = node_path_1.default.basename(entry.name, '.md');
        const derived = commandsModule.deriveSeedIdentity(stem, fm.id);
        const seed_id = seedIdMatchRawName(entry.name) ? derived.seed_id : stem;
        const slug = (0, security_cjs_1.sanitizeLabel)(derived.slug);
        let title = (0, security_cjs_1.sanitizeForDisplay)(fm.title || '');
        if (!title) {
            const headingMatch = content.match(/^#\s*(.+)$/m);
            if (headingMatch)
                title = (0, security_cjs_1.sanitizeForDisplay)(headingMatch[1].trim().slice(0, 100));
        }
        results.push({
            seed_id: (0, security_cjs_1.sanitizeLabel)(seed_id),
            slug,
            status: (0, security_cjs_1.sanitizeForDisplay)(status),
            title,
        });
    }
    return { items: results, acknowledged };
}
/**
 * Enumerate phase directories across BOTH the active `.planning/phases/` root
 * and every archived `.planning/milestones/vX.Y-phases/` root. Shared by the
 * four phase-scoped scanners below (#3458 — epic #3473 B2/F2). Previously each
 * scanner hand-rolled its own active-only `readdirSync(phasesDir)` walk and
 * bailed out entirely when the active root was missing, so items still
 * unresolved when a milestone closed and its phase dirs archived became
 * permanently invisible to every later audit.
 *
 * ACTIVE dirs: raw readdirSync + isDirectory filter + sort. The enumeration
 * walk itself (readdirSync + isDirectory filter + sort) is UNCHANGED from the
 * scanners' prior inline behavior; what IS new is that a failed read here no
 * longer aborts the whole scan the way each scanner's own inline
 * `if (!fs.existsSync) return []` / try-readdirSync-catch-return-sentinel
 * pair used to — see `activeUnreadable` below, which is how that signal is
 * now surfaced to callers instead. Deliberately NOT routed through
 * listMilestonePhaseDirs: these scanners are deliberately not
 * milestone-filtered today, and switching would silently add window/sentinel
 * filtering — a behavior change belonging to #3372, not here.
 *
 * A missing/unreadable active root does NOT short-circuit the archive walk —
 * the old `if (!fs.existsSync(phasesDir)) return []` was the whole bug in a
 * fully-archived project; it degrades to "skip the active half" only. An
 * UNREADABLE (as opposed to merely absent) active root is reported back via
 * `activeUnreadable: true` so each of the four callers can still emit the
 * `scan_error` sentinel they emitted pre-#3458 for this exact case (a real
 * I/O failure, not "verified clean") — see each scanner's own use of it.
 *
 * ARCHIVED dirs: sourced from `getArchivedPhaseDirs` (phase-locator.cjs), the
 * canonical archive-enumeration seam `uat.cts`'s `cmdAuditUat` already uses.
 * Archived dirs are deliberately NOT milestone-filtered either — see the
 * comment at src/uat.cts:107-111: listMilestonePhaseDirs derives the CURRENT
 * milestone's phase dirs (window + sentinel filtered) from ROADMAP.md, and
 * archived phases belong to past milestones by definition, so filtering them
 * discards every one and silently reinstates the bug this function fixes.
 *
 * An unreadable/unresolvable ARCHIVE root does NOT get its own sentinel.
 * Pre-#3458 there was no archived read at all, so — unlike the active root —
 * there is no prior `scan_error` contract to preserve here, and no existing
 * consumer can regress. It also degrades the same way `listArchiveVersionDirs`
 * (phase-locator.cts) already treats an absent `milestones/` dir: a real
 * empty, not a failure, matching this function's existing "skip that root"
 * idiom for the missing-active-dir case above. Adding a second sentinel path
 * would let a machine consumer conflate "no milestones archived yet" (the
 * overwhelmingly common case for an active project) with an actual read
 * failure, which is a worse signal-to-noise trade than the one this
 * function's own fix removes for the active root.
 *
 * Same-named dirs in both roots (e.g. "01-alpha" active AND archived) are
 * DISTINCT targets — no dedupe.
 */
function listAuditPhaseTargets(planDir, cwd) {
    const targets = [];
    let activeUnreadable = false;
    const phasesDir = node_path_1.default.join(planDir, 'phases');
    if (node_fs_1.default.existsSync(phasesDir)) {
        try {
            const dirs = node_fs_1.default.readdirSync(phasesDir, { withFileTypes: true })
                .filter(e => e.isDirectory())
                .map(e => e.name)
                .sort();
            for (const dir of dirs) {
                targets.push({ dir, fullPath: node_path_1.default.join(phasesDir, dir) });
            }
        }
        catch {
            // Unreadable active root: skip it, do not abort the archive walk, but
            // report it so callers can emit their pre-#3458 scan_error sentinel.
            activeUnreadable = true;
        }
    }
    // #3804: the audit is cross-workstream by design — the shared
    // getAllArchivedPhaseDirs helper (root + every workstream, distinct
    // '<ws>/<version>' labels) owns that walk.
    try {
        for (const archived of getAllArchivedPhaseDirs(cwd)) {
            targets.push({ dir: archived.name, fullPath: archived.fullPath, milestone: archived.milestone });
        }
    }
    catch {
        // Unreadable/unresolvable archive root: skip it, keep whatever active
        // targets were already collected. No sentinel — see docstring above.
    }
    return { targets, activeUnreadable };
}
// ─── scanUatGaps ──────────────────────────────────────────────────────────────
/**
 * Scan .planning/phases (active) and .planning/milestones/vX.Y-phases (archived)
 * for UAT gaps (UAT files with status != 'complete'/'resolved').
 */
function scanUatGaps(planDir, cwd) {
    const results = [];
    let acknowledged = 0;
    const { targets, activeUnreadable } = listAuditPhaseTargets(planDir, cwd);
    if (activeUnreadable) {
        results.push({ scan_error: true, phase: '', file: '', status: '', open_scenario_count: 0 });
    }
    for (const target of targets) {
        const phaseMatch = target.dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})`, 'i'));
        const phaseNum = phaseMatch ? phaseMatch[1] : target.dir;
        let files;
        try {
            files = node_fs_1.default.readdirSync(target.fullPath);
        }
        catch {
            continue;
        }
        // Scoped to THIS phase's own token (#3511) so a stray, cross-phase, or
        // ad-hoc UAT file cannot surface as this phase's gap — same fix as
        // scanVerificationGaps below.
        for (const file of scopeToPhase(files.filter(f => f.includes('-UAT') && f.endsWith('.md')), target.dir)) {
            const filePath = node_path_1.default.join(target.fullPath, file);
            let safeFilePath;
            try {
                safeFilePath = (0, security_cjs_1.requireSafePath)(filePath, planDir, 'UAT file', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
            }
            catch {
                continue;
            }
            // #3078-CR MEDIUM 2 (security review follow-up): normalize a lone-CR
            // document at this read boundary, same seam as `src/uat.cts`'s
            // `readNormalizedDocument` — `platformReadSync` performs no line-ending
            // normalization itself, and extractFrontmatter/status-derivation below
            // degrade a lone-CR file's frontmatter to `unknown`, which this scan
            // reports as an open gap unless `result: all_pass` (#4869 triage) — so
            // an un-normalized terminal UAT would resurface as open.
            const rawContent = (0, shell_command_projection_cjs_1.platformReadSync)(safeFilePath);
            if (rawContent === null)
                continue;
            const content = normalizeLineEndings(rawContent);
            const fm = extractFrontmatter(content, safeFilePath);
            const status = (fm.status || 'unknown').toLowerCase();
            const result = (fm.result || '').toLowerCase();
            // Also accept `result: all_pass` as a fallback when status is absent
            // — covers UATs that omit `status:`.
            if (TERMINAL_UAT_STATUSES.has(status))
                continue;
            if (status === 'unknown' && result === 'all_pass')
                continue;
            // Count open scenarios — computed BEFORE the acknowledged check
            // (WARNING 2) so the snapshot comparison sees it too, not just status.
            const pendingMatches = deriveUatGapOpenScenarioCount(content);
            if (isAuditItemAcknowledged(fm, { snapshotKey: 'gap_snapshot', currentValue: deriveUatGapSnapshotValue(status, content) })) {
                acknowledged++;
                continue;
            }
            const item = {
                phase: (0, security_cjs_1.sanitizeLabel)(phaseNum),
                file: (0, security_cjs_1.sanitizeLabel)(file),
                status: (0, security_cjs_1.sanitizeForDisplay)(status),
                open_scenario_count: pendingMatches,
            };
            if (target.milestone !== undefined)
                item.archived_milestone = (0, security_cjs_1.sanitizeLabel)(target.milestone);
            results.push(item);
        }
    }
    return { items: results, acknowledged };
}
// ─── scanVerificationGaps ─────────────────────────────────────────────────────
/**
 * Scan .planning/phases (active) and .planning/milestones/vX.Y-phases (archived)
 * for VERIFICATION gaps.
 */
function scanVerificationGaps(planDir, cwd) {
    const results = [];
    let acknowledged = 0;
    const { targets, activeUnreadable } = listAuditPhaseTargets(planDir, cwd);
    if (activeUnreadable) {
        results.push({ scan_error: true, phase: '', file: '', status: '' });
    }
    for (const target of targets) {
        const phaseMatch = target.dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})`, 'i'));
        const phaseNum = phaseMatch ? phaseMatch[1] : target.dir;
        let files;
        try {
            files = node_fs_1.default.readdirSync(target.fullPath);
        }
        catch {
            continue;
        }
        // Scoped to THIS phase's own token (#3511) so a stray, cross-phase, or
        // ad-hoc VERIFICATION file cannot surface as this phase's gap.
        for (const file of scopeToPhase(files.filter(f => f.includes('-VERIFICATION') && f.endsWith('.md')), target.dir)) {
            const filePath = node_path_1.default.join(target.fullPath, file);
            let safeFilePath;
            try {
                safeFilePath = (0, security_cjs_1.requireSafePath)(filePath, planDir, 'VERIFICATION file', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
            }
            catch {
                continue;
            }
            // #3078-CR MEDIUM 2 (security review follow-up): normalize a lone-CR
            // document at this read boundary, same seam as `src/uat.cts`'s
            // `readNormalizedDocument` — `platformReadSync` performs no line-ending
            // normalization itself, and extractFrontmatter/status-derivation below
            // degrade a lone-CR file's frontmatter to `unknown`, which every scan
            // in this module treats as "not open" (fail-open, the permissive
            // direction) rather than a real parse gap.
            const rawContent = (0, shell_command_projection_cjs_1.platformReadSync)(safeFilePath);
            if (rawContent === null)
                continue;
            const content = normalizeLineEndings(rawContent);
            const fm = extractFrontmatter(content, safeFilePath);
            // #5118: the owner's report reader judges `status` — exact match, no
            // case folding; an out-of-set value throws VerificationStatusError.
            const status = reportStatusOf(fm, safeFilePath);
            if (status !== VERIFICATION_STATUS.GAPS_FOUND && status !== VERIFICATION_STATUS.HUMAN_NEEDED)
                continue;
            if (isAuditItemAcknowledged(fm, { snapshotKey: 'status', currentValue: status })) {
                acknowledged++;
                continue;
            }
            const item = {
                phase: (0, security_cjs_1.sanitizeLabel)(phaseNum),
                file: (0, security_cjs_1.sanitizeLabel)(file),
                status: (0, security_cjs_1.sanitizeForDisplay)(status),
            };
            if (target.milestone !== undefined)
                item.archived_milestone = (0, security_cjs_1.sanitizeLabel)(target.milestone);
            results.push(item);
        }
    }
    return { items: results, acknowledged };
}
// ─── scanContextQuestions ─────────────────────────────────────────────────────
/**
 * Scan .planning/phases (active) and .planning/milestones/vX.Y-phases (archived)
 * for CONTEXT files with open_questions.
 */
function scanContextQuestions(planDir, cwd) {
    const results = [];
    let acknowledged = 0;
    const { targets, activeUnreadable } = listAuditPhaseTargets(planDir, cwd);
    if (activeUnreadable) {
        results.push({ scan_error: true, phase: '', file: '', question_count: 0, questions: [] });
    }
    for (const target of targets) {
        const phaseMatch = target.dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})`, 'i'));
        const phaseNum = phaseMatch ? phaseMatch[1] : target.dir;
        let files;
        try {
            files = node_fs_1.default.readdirSync(target.fullPath);
        }
        catch {
            continue;
        }
        for (const file of files.filter(f => f.includes('-CONTEXT') && f.endsWith('.md'))) {
            const filePath = node_path_1.default.join(target.fullPath, file);
            let safeFilePath;
            try {
                safeFilePath = (0, security_cjs_1.requireSafePath)(filePath, planDir, 'CONTEXT file', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
            }
            catch {
                continue;
            }
            // #3078-CR MEDIUM 2 (security review follow-up): normalize a lone-CR
            // document at this read boundary, same seam as `src/uat.cts`'s
            // `readNormalizedDocument` — `platformReadSync` performs no line-ending
            // normalization itself, and extractFrontmatter/status-derivation below
            // degrade a lone-CR file's frontmatter to `unknown`, which every scan
            // in this module treats as "not open" (fail-open, the permissive
            // direction) rather than a real parse gap.
            const rawContent = (0, shell_command_projection_cjs_1.platformReadSync)(safeFilePath);
            if (rawContent === null)
                continue;
            const content = normalizeLineEndings(rawContent);
            const fm = extractFrontmatter(content, safeFilePath);
            const questions = deriveOpenQuestions(content, fm);
            if (questions.length === 0)
                continue;
            // WARNING 2 (#3458 follow-up review): snapshot the QUESTIONS
            // THEMSELVES (a content digest), not just their count — a count-only
            // snapshot cannot see the same-count REPLACEMENT of every question
            // with brand-new ones (measured: 2 acknowledged, then both swapped for
            // unrelated new blockers, still suppressed under the old scheme).
            if (isAuditItemAcknowledged(fm, { snapshotKey: 'questions_digest', currentValue: deriveOpenQuestionsDigest(questions) })) {
                acknowledged++;
                continue;
            }
            const item = {
                phase: (0, security_cjs_1.sanitizeLabel)(phaseNum),
                file: (0, security_cjs_1.sanitizeLabel)(file),
                question_count: questions.length,
                questions: questions.slice(0, 3).map(truncateQuestionForDisplay),
            };
            if (target.milestone !== undefined)
                item.archived_milestone = (0, security_cjs_1.sanitizeLabel)(target.milestone);
            results.push(item);
        }
    }
    return { items: results, acknowledged };
}
// ─── scanDeferredItems ────────────────────────────────────────────────────────
/**
 * Scan phase directories for UNRESOLVED entries in `deferred-items.md` (#2646),
 * across both .planning/phases (active) and .planning/milestones/vX.Y-phases
 * (archived).
 *
 * The SCOPE BOUNDARY convention (`agents/gsd-executor.md`) has a phase agent
 * log an out-of-scope discovery here rather than fix it. #2287 made that file
 * readable at the PHASE boundary (`/gsd-progress` check 7, `audit-uat`); this
 * scanner closes the remaining reader gap one boundary up, so an entry still
 * unresolved at MILESTONE close surfaces in the pre-close audit alongside the
 * other eight categories and the existing `[R]/[A]/[C]` prompt applies to it.
 * Without this, phase directories archive to `milestones/vX.Y-phases/` (#1871)
 * and the entry leaves the live tree having never been triaged.
 *
 * The resolved/unresolved predicate is NOT reimplemented here: `uat.cjs`
 * already exports `parseDeferredItemsWithStatus`, which owns the parsing rule
 * (entries under a `## Deferred Items` level-2 heading, else the whole file
 * fail-safe) and — unlike `parseDeferredItems` — surfaces each entry's raw
 * `status:` field instead of filtering `resolved` internally, so THIS scanner
 * can apply the three-way split (#3458 follow-up): `resolved` (fixed for
 * real — dropped, never counted, matching pre-existing behavior exactly),
 * `acknowledged` (suppressed AND tallied — the new deferred_items marker;
 * see the module doc comment above `isAuditItemAcknowledged`), else open.
 * Duplicating either inequality is how two readers of the same file drift
 * into disagreeing about what "open" means. The require is deliberately
 * LAZY, inside the scan, to preserve `audit-command-router.cts`'s property
 * that a route never loads the module it does not need.
 */
function scanDeferredItems(planDir, cwd) {
    const { targets, activeUnreadable } = listAuditPhaseTargets(planDir, cwd);
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const uat = require('./uat.cjs');
    const results = [];
    let acknowledged = 0;
    if (activeUnreadable) {
        results.push({ scan_error: true, phase: '', file: '', text: '' });
    }
    for (const target of targets) {
        const phaseMatch = target.dir.match(new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})`, 'i'));
        const phaseNum = phaseMatch ? phaseMatch[1] : target.dir;
        const filePath = node_path_1.default.join(target.fullPath, DEFERRED_ITEMS_FILENAME);
        if (!node_fs_1.default.existsSync(filePath))
            continue;
        let safeFilePath;
        try {
            safeFilePath = (0, security_cjs_1.requireSafePath)(filePath, planDir, 'deferred items file', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
        }
        catch {
            continue;
        }
        // #3078-CR MEDIUM 2: normalize at this read boundary too —
        // `parseDeferredItemsWithStatus` performs no normalization of its own
        // (unlike `src/uat.cts`'s callers, which route through
        // `readNormalizedDocument`), so a lone-CR `deferred-items.md` was read as
        // one unbroken line and every entry in it silently vanished.
        const rawContent = (0, shell_command_projection_cjs_1.platformReadSync)(safeFilePath);
        if (rawContent === null)
            continue;
        const content = normalizeLineEndings(rawContent);
        for (const item of uat.parseDeferredItemsWithStatus(content)) {
            const rawStatus = (item.status || '').toLowerCase();
            if (rawStatus === 'resolved')
                continue; // fixed for real — never counted
            if (rawStatus === 'acknowledged') {
                acknowledged++;
                continue;
            }
            const resultItem = {
                phase: (0, security_cjs_1.sanitizeLabel)(phaseNum),
                file: (0, security_cjs_1.sanitizeLabel)(DEFERRED_ITEMS_FILENAME),
                text: (0, security_cjs_1.sanitizeForDisplay)(item.name),
            };
            if (target.milestone !== undefined)
                resultItem.archived_milestone = (0, security_cjs_1.sanitizeLabel)(target.milestone);
            results.push(resultItem);
        }
    }
    return { items: results, acknowledged };
}
// ─── auditOpenArtifacts ───────────────────────────────────────────────────────
/**
 * Main audit function. Scans all .planning/ artifact categories.
 *
 * @param cwd - Project root directory
 * @returns Structured audit result
 */
function auditOpenArtifacts(cwd) {
    const planDir = planningDir(cwd);
    const debugSessions = (() => {
        // #5042: debug sessions are shared project state; workflow writers use
        // the root .planning/debug directory even when a workstream is active.
        try {
            return scanDebugSessions(debugDir(cwd));
        }
        catch {
            return { items: [{ scan_error: true, slug: '', status: '', updated: '', hypothesis: '' }], acknowledged: 0 };
        }
    })();
    const quickTasks = (() => {
        try {
            return scanQuickTasks(planDir);
        }
        catch {
            return { items: [{ scan_error: true, slug: '', date: '', status: '', description: '' }], acknowledged: 0 };
        }
    })();
    const threads = (() => {
        try {
            return scanThreads(planDir);
        }
        catch {
            return { items: [{ scan_error: true, slug: '', status: '', updated: '', title: '' }], acknowledged: 0 };
        }
    })();
    const todos = (() => {
        // #4256: todos are shared project state, like debug sessions (#5042),
        // so the close gate reads todosDir(cwd) (the root), not the workstream-
        // scoped planDir every other scan below receives. Reading planDir here
        // made audit-open print "All artifact types clear. Safe to proceed."
        // with pending todos on disk under a workstream.
        try {
            return scanTodos(todosDir(cwd));
        }
        catch {
            return { items: [{ scan_error: true, filename: '', priority: '', area: '', summary: '' }], acknowledged: 0 };
        }
    })();
    const seeds = (() => {
        try {
            return scanSeeds(planDir);
        }
        catch {
            return { items: [{ scan_error: true, seed_id: '', slug: '', status: '', title: '' }], acknowledged: 0 };
        }
    })();
    const uatGaps = (() => {
        try {
            return scanUatGaps(planDir, cwd);
        }
        catch {
            return { items: [{ scan_error: true, phase: '', file: '', status: '', open_scenario_count: 0 }], acknowledged: 0 };
        }
    })();
    const verificationGaps = (() => {
        try {
            return scanVerificationGaps(planDir, cwd);
        }
        catch (err) {
            // #5118: an out-of-set report status is the owner's hard error, not a
            // scan failure to fold into a sentinel — let it reach the CLI seam.
            if (err instanceof VerificationStatusError)
                throw err;
            return { items: [{ scan_error: true, phase: '', file: '', status: '' }], acknowledged: 0 };
        }
    })();
    const contextQuestions = (() => {
        try {
            return scanContextQuestions(planDir, cwd);
        }
        catch {
            return { items: [{ scan_error: true, phase: '', file: '', question_count: 0, questions: [] }], acknowledged: 0 };
        }
    })();
    const deferredItems = (() => {
        try {
            return scanDeferredItems(planDir, cwd);
        }
        catch {
            return { items: [{ scan_error: true, phase: '', file: '', text: '' }], acknowledged: 0 };
        }
    })();
    // Count real items (not scan_error sentinels). #3817: a `_remainder_count`
    // marker is not a phantom — it RECORDS real items the detail list truncated
    // away for display, so its value counts toward the total. Truncation limits
    // display, never counting; only scan_error (a read failure, not an item)
    // contributes zero.
    const countReal = (arr) => arr.reduce((sum, i) => {
        if (i.scan_error)
            return sum;
        if (typeof i._remainder_count === 'number')
            return sum + i._remainder_count;
        return sum + 1;
    }, 0);
    const counts = {
        debug_sessions: countReal(debugSessions.items),
        quick_tasks: countReal(quickTasks.items),
        threads: countReal(threads.items),
        todos: countReal(todos.items),
        seeds: countReal(seeds.items),
        uat_gaps: countReal(uatGaps.items),
        verification_gaps: countReal(verificationGaps.items),
        context_questions: countReal(contextQuestions.items),
        deferred_items: countReal(deferredItems.items),
        total: 0,
    };
    counts.total = counts.debug_sessions + counts.quick_tasks + counts.threads + counts.todos + counts.seeds + counts.uat_gaps + counts.verification_gaps + counts.context_questions + counts.deferred_items;
    // #3458 follow-up (A5): mirrors `counts`'s shape exactly, so a reviewer can
    // tell "clean because fixed" apart from "clean because silenced" without a
    // second output contract to learn.
    const acknowledged = {
        debug_sessions: debugSessions.acknowledged,
        quick_tasks: quickTasks.acknowledged,
        threads: threads.acknowledged,
        todos: todos.acknowledged,
        seeds: seeds.acknowledged,
        uat_gaps: uatGaps.acknowledged,
        verification_gaps: verificationGaps.acknowledged,
        context_questions: contextQuestions.acknowledged,
        deferred_items: deferredItems.acknowledged,
        total: 0,
    };
    acknowledged.total = acknowledged.debug_sessions + acknowledged.quick_tasks + acknowledged.threads + acknowledged.todos + acknowledged.seeds + acknowledged.uat_gaps + acknowledged.verification_gaps + acknowledged.context_questions + acknowledged.deferred_items;
    return {
        scanned_at: new Date().toISOString(),
        has_open_items: counts.total > 0,
        counts,
        acknowledged,
        items: {
            debug_sessions: debugSessions.items,
            quick_tasks: quickTasks.items,
            threads: threads.items,
            todos: todos.items,
            seeds: seeds.items,
            uat_gaps: uatGaps.items,
            verification_gaps: verificationGaps.items,
            context_questions: contextQuestions.items,
            deferred_items: deferredItems.items,
        },
    };
}
// ─── formatAuditReport ────────────────────────────────────────────────────────
/**
 * Format the audit result as a human-readable report.
 *
 * @param auditResult - Result from auditOpenArtifacts()
 * @returns Formatted report
 */
function formatAuditReport(auditResult) {
    const { counts, items, has_open_items, acknowledged } = auditResult;
    const lines = [];
    lines.push('### Milestone Close: Open Artifact Audit');
    // WARNING 3 (#3458 follow-up review): the acknowledged tally previously
    // existed only in `--json` output — the human report could not tell
    // "clean because fixed" apart from "clean because silenced", which is the
    // exact distinction the acknowledged/counts split exists to preserve.
    if (!has_open_items) {
        lines.push('');
        if (acknowledged.total > 0) {
            lines.push(`All artifact types clear (${acknowledged.total} previously acknowledged item${acknowledged.total !== 1 ? 's' : ''} still suppressed).`);
        }
        else {
            lines.push('All artifact types clear. Safe to proceed.');
        }
        lines.push('');
        lines.push('---');
        return lines.join('\n');
    }
    // WARNING 3: per-category "N previously acknowledged" suffix, so the
    // human report carries the same "clean vs silenced" signal `--json`
    // already did via `acknowledged`.
    const ackSuffix = (n) => (n > 0 ? `, ${n} previously acknowledged` : '');
    // Debug sessions (blocking quality — red)
    if (counts.debug_sessions > 0) {
        lines.push('');
        lines.push(`🔴 Debug Sessions (${counts.debug_sessions} open${ackSuffix(acknowledged.debug_sessions)})`);
        for (const item of items.debug_sessions.filter(i => !i.scan_error)) {
            const hyp = item.hypothesis ? ` — ${item.hypothesis}` : '';
            lines.push(`   • ${item.slug} [${item.status}]${hyp}`);
        }
    }
    // UAT gaps (blocking quality — red)
    if (counts.uat_gaps > 0) {
        lines.push('');
        lines.push(`🔴 UAT Gaps (${counts.uat_gaps} phases with incomplete UAT${ackSuffix(acknowledged.uat_gaps)})`);
        for (const item of items.uat_gaps.filter(i => !i.scan_error)) {
            const archived = item.archived_milestone ? ` (archived ${item.archived_milestone})` : '';
            lines.push(`   • Phase ${item.phase}${archived}: ${item.file} [${item.status}] — ${item.open_scenario_count} pending scenarios`);
        }
    }
    // Verification gaps (blocking quality — red)
    if (counts.verification_gaps > 0) {
        lines.push('');
        lines.push(`🔴 Verification Gaps (${counts.verification_gaps} unresolved${ackSuffix(acknowledged.verification_gaps)})`);
        for (const item of items.verification_gaps.filter(i => !i.scan_error)) {
            const archived = item.archived_milestone ? ` (archived ${item.archived_milestone})` : '';
            lines.push(`   • Phase ${item.phase}${archived}: ${item.file} [${item.status}]`);
        }
    }
    // Quick tasks (incomplete work — yellow)
    if (counts.quick_tasks > 0) {
        lines.push('');
        lines.push(`🟡 Quick Tasks (${counts.quick_tasks} incomplete${ackSuffix(acknowledged.quick_tasks)})`);
        for (const item of items.quick_tasks.filter(i => !i.scan_error)) {
            const d = item.date ? ` (${item.date})` : '';
            lines.push(`   • ${item.slug}${d} [${item.status}]`);
        }
    }
    // Todos (incomplete work — yellow)
    if (counts.todos > 0) {
        const realTodos = items.todos.filter(i => !i.scan_error && !i._remainder_count);
        const remainder = items.todos.find(i => i._remainder_count);
        lines.push('');
        lines.push(`🟡 Pending Todos (${counts.todos} pending${ackSuffix(acknowledged.todos)})`);
        for (const item of realTodos) {
            const area = item.area ? ` [${item.area}]` : '';
            const pri = item.priority ? ` (${item.priority})` : '';
            lines.push(`   • ${item.filename}${area}${pri}`);
            if (item.summary)
                lines.push(`     ${item.summary}`);
        }
        if (remainder) {
            lines.push(`   ... and ${remainder._remainder_count} more`);
        }
    }
    // Threads (deferred decisions — blue)
    if (counts.threads > 0) {
        lines.push('');
        lines.push(`🔵 Open Threads (${counts.threads} active${ackSuffix(acknowledged.threads)})`);
        for (const item of items.threads.filter(i => !i.scan_error)) {
            const title = item.title ? ` — ${item.title}` : '';
            lines.push(`   • ${item.slug} [${item.status}]${title}`);
        }
    }
    // Seeds (deferred decisions — blue)
    if (counts.seeds > 0) {
        lines.push('');
        lines.push(`🔵 Unimplemented Seeds (${counts.seeds} pending${ackSuffix(acknowledged.seeds)})`);
        for (const item of items.seeds.filter(i => !i.scan_error)) {
            const title = item.title ? ` — ${item.title}` : '';
            lines.push(`   • ${item.seed_id} [${item.status}]${title}`);
        }
    }
    // Context questions (deferred decisions — blue)
    if (counts.context_questions > 0) {
        lines.push('');
        lines.push(`🔵 CONTEXT Open Questions (${counts.context_questions} phases with open questions${ackSuffix(acknowledged.context_questions)})`);
        for (const item of items.context_questions.filter(i => !i.scan_error)) {
            const archived = item.archived_milestone ? ` (archived ${item.archived_milestone})` : '';
            lines.push(`   • Phase ${item.phase}${archived}: ${item.file} (${item.question_count} question${item.question_count !== 1 ? 's' : ''})`);
            for (const q of item.questions) {
                lines.push(`     - ${q}`);
            }
        }
    }
    // Deferred items (deferred decisions — blue). Out-of-scope discoveries a
    // phase agent recorded rather than fixed, still unresolved at close (#2646).
    if (counts.deferred_items > 0) {
        lines.push('');
        lines.push(`🔵 Deferred Items (${counts.deferred_items} unresolved${ackSuffix(acknowledged.deferred_items)})`);
        for (const item of items.deferred_items.filter(i => !i.scan_error)) {
            const archived = item.archived_milestone ? ` (archived ${item.archived_milestone})` : '';
            lines.push(`   • Phase ${item.phase}${archived}: ${item.text}`);
        }
    }
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`**${counts.total} item${counts.total !== 1 ? 's' : ''} require decisions before close.**`);
    if (acknowledged.total > 0) {
        lines.push(`${acknowledged.total} previously acknowledged item${acknowledged.total !== 1 ? 's' : ''} also suppressed above the ${counts.total} open item${counts.total !== 1 ? 's' : ''}.`);
    }
    return lines.join('\n');
}
// ─── resolvePhaseTargetDir ─────────────────────────────────────────────────────
/**
 * Resolve ONE phase directory (active or archived) by its phase token, for
 * `cmdAuditAcknowledge`'s `--phase [--archived-milestone]` identification of
 * a uat_gaps/verification_gaps/context_questions/deferred_items item. Built
 * on `listAuditPhaseTargets` — the same enumeration the four phase-scoped
 * scanners use — so the writer can never resolve a DIFFERENT directory than
 * the one the audit actually scanned.
 *
 * `archivedMilestone` absent → matches the ACTIVE `.planning/phases/<dir>`
 * (a target with no `milestone`). Present → matches the archived target
 * whose `milestone` equals it exactly — the same disambiguator the audit
 * output's `archived_milestone` field carries.
 */
function resolvePhaseTargetDir(planDir, cwd, phase, archivedMilestone) {
    const { targets } = listAuditPhaseTargets(planDir, cwd);
    const phaseTokenRe = new RegExp(`^(${PHASE_NUMBER_TOKEN_SOURCE})`, 'i');
    for (const target of targets) {
        const phaseMatch = target.dir.match(phaseTokenRe);
        const phaseNum = phaseMatch ? phaseMatch[1] : target.dir;
        if (phaseNum !== phase)
            continue;
        if (archivedMilestone) {
            if (target.milestone === archivedMilestone)
                return target.fullPath;
        }
        else if (target.milestone === undefined) {
            return target.fullPath;
        }
    }
    return null;
}
// ─── cmdAuditAcknowledge ────────────────────────────────────────────────────────
/**
 * CLI writer for the #3458 follow-up suppression seam (design point A4). Sets
 * (or refreshes) the `audit_acknowledged` marker on ONE identified artifact,
 * snapshotting its CURRENT effective state itself so the marker is never
 * hand-authored and can never drift from what the scanners actually compute.
 *
 * `--category` selects which of the nine audit categories is being
 * acknowledged, and which OTHER flags are required to identify the artifact —
 * mirroring the fields the audit's OWN JSON output already carries per
 * category (phase/file/archived_milestone for the four phase-scoped
 * categories; slug/seed-id/dir/filename for the five flat ones), the same
 * convention `frontmatter get/set/merge/validate` uses for `--file`/`--field`.
 *
 * VERDICT-PRESERVING: this function never writes to the artifact's own
 * `status:` field (the audit's real verdict) for the 8 frontmatter-marker
 * categories — only the sibling `audit_acknowledged` map. `deferred_items` is
 * the sole, deliberate exception (see `uat.cts`'s `acknowledgeDeferredItem`):
 * there, the marker IS the entry's own `status:` field, because a
 * deferred-items.md entry carries no OTHER meaning for that field.
 *
 * Every path this function writes is routed through `requireSafePath`, so an
 * artifact identifier that resolves outside the project is refused before
 * any read or write is attempted.
 */
/**
 * #4802: splice the acknowledgement marker, surfacing `spliceFrontmatter`'s
 * write refusal (the one owner of that decision) as an `ioError` naming the
 * file — an unparseable frontmatter block is NOT an empty one, and splicing
 * over it would discard every field the author actually wrote.
 */
function spliceAcknowledgement(content, fm, fileLabel) {
    try {
        return spliceFrontmatter(content, fm);
    }
    catch (err) {
        if (!isFrontmatterWriteRefusal(err))
            throw err;
        if (err.code === 'FRONTMATTER_UNPARSEABLE') {
            ioError(`refusing to acknowledge — the frontmatter of "${fileLabel}" is not parseable YAML (splicing would discard every other frontmatter field); fix the YAML syntax error first, then re-run`);
        }
        ioError(`refusing to acknowledge "${fileLabel}" — ${err.message}`);
        throw err; // unreachable — ioError throws
    }
}
function cmdAuditAcknowledge(cwd, args, raw) {
    // args already has the family + subcommand tokens stripped by the caller
    // (audit-command-router.cts:147 passes `hubArgs.slice(2)`), so validation
    // begins at index 0 — there is no positional this handler owns itself.
    const { category, milestone, at: atFlag, phase, file, 'archived-milestone': archivedMilestone, slug, 'seed-id': seedId, dir: quickDir, filename, text, } = (0, command_arg_projection_cjs_1.parseNamedArgsOrExit)(args, {
        valueFlags: [
            'category', 'milestone', 'at',
            'phase', 'file', 'archived-milestone',
            'slug', 'seed-id', 'dir', 'filename', 'text',
        ],
        positionals: 0,
    }, ioError);
    if (!category)
        ioError('--category is required');
    if (!milestone)
        ioError('--milestone is required');
    // All declared flags above are value flags, so each resolves to `string |
    // null` at runtime; the cast narrows away the `boolean` arm of
    // ParsedNamedArgs's value type that this call site never produces.
    // #4905: without --at, the operator-facing local calendar day (#2136)
    // through the clock seam, which honors the GSD_NOW_MS pin (#474).
    const at = atFlag || clock_cjs_1.realClock.localToday();
    const planDir = planningDir(cwd);
    const markerBase = { milestone: milestone, at };
    // #3078-CR MEDIUM 2: every `fs.readFileSync` in this function (below, and
    // in the flat-category branch further down) is DELIBERATELY left raw,
    // unlike `auditOpenArtifacts`'s scan reads (which now route through
    // `normalizeLineEndings`). This function splices frontmatter into the
    // EXISTING content and writes the result back via `platformWriteSync` /
    // `uat.acknowledgeDeferredItem` — both `spliceFrontmatter` and
    // `acknowledgeDeferredItem` locate and rewrite a specific byte span
    // (frontmatter block / matched deferred-item text) in the file exactly as
    // it exists on disk. Normalizing first would rewrite the file's line
    // endings as a side effect of an unrelated acknowledge operation, and a
    // splice computed against normalized text can land at the wrong offset
    // when written back over the RAW (un-normalized) original. The snapshot
    // VALUE computed below IS normalized (on a separate in-memory copy, never
    // the spliced one) so it agrees with the scanner's frame — see the comment
    // at `normalizedContent` further down.
    // ── The four phase-scoped categories: --phase --file [--archived-milestone] ──
    const PHASE_SCOPED = new Set(['uat_gaps', 'verification_gaps', 'context_questions', 'deferred_items']);
    if (PHASE_SCOPED.has(category)) {
        if (!phase)
            ioError('--phase is required for this --category');
        if (!file)
            ioError('--file is required for this --category');
        const targetDir = resolvePhaseTargetDir(planDir, cwd, phase, archivedMilestone);
        if (!targetDir) {
            ioError(`no phase directory found for phase "${phase}"${archivedMilestone ? ` (archived-milestone "${archivedMilestone}")` : ''}`);
        }
        const filePath = node_path_1.default.join(targetDir, file);
        const safeFilePath = (0, security_cjs_1.requireSafePath)(filePath, planDir, 'audit acknowledge target', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
        if (!node_fs_1.default.existsSync(safeFilePath))
            ioError(`file not found: ${file}`);
        if (category === 'deferred_items') {
            if (!text)
                ioError('--text is required for --category deferred_items');
            // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
            const uat = require('./uat.cjs');
            const content = node_fs_1.default.readFileSync(safeFilePath, 'utf-8');
            const result = uat.acknowledgeDeferredItem(content, text);
            if (result.status === 'not_found')
                ioError(`no deferred item matched --text "${text}"`);
            if (result.status === 'ambiguous')
                ioError(`--text "${text}" matches more than one deferred item — text must be unique`);
            if (result.status === 'already_resolved')
                ioError(`deferred item is already "status: resolved" — acknowledging a resolved item is a no-op`);
            if (result.status === 'unsupported_heading_shape') {
                // #3781: heading-shaped entries are supported; the remaining refusal
                // cause is a GFM table row embedded in the entry's span (non-contiguous
                // — a write cannot be anchored safely).
                ioError('this deferred item\'s span embeds a GFM table row, so the CLI writer cannot anchor a safe write to it — edit the file directly');
            }
            if (result.status === 'match_verification_failed') {
                ioError(`internal error: matched span for --text "${text}" did not re-verify before write — refused rather than risk writing the wrong entry`);
            }
            (0, shell_command_projection_cjs_2.platformWriteSync)(safeFilePath, result.content);
            output({ acknowledged: true, category, phase, file, text }, raw, 'true');
            return;
        }
        const content = node_fs_1.default.readFileSync(safeFilePath, 'utf-8');
        const fm = extractFrontmatter(content, safeFilePath);
        // Mixed-frame fix (security review, 4th instance on this branch): the
        // splice above and below stays keyed to RAW `content` (raw byte offsets
        // must not shift), but `scanUatGaps`/`scanContextQuestions` now derive
        // their comparison values from `normalizeLineEndings`d content. Deriving
        // the snapshot here from raw `content` would make a lone-CR file's
        // stored value permanently disagree with what the scanner recomputes —
        // `audit acknowledge` would be a silent no-op for lone-CR artifacts. Feed
        // the derive functions a normalized COPY; never splice from it.
        const normalizedContent = normalizeLineEndings(content);
        let snapshotKey;
        let currentValue;
        if (category === 'uat_gaps') {
            // WARNING 2 (#3458 follow-up review): status alone can't see MORE
            // pending scenarios added under the same status — snapshot the
            // composite `deriveUatGapSnapshotValue` instead (see its doc comment).
            snapshotKey = 'gap_snapshot';
            currentValue = deriveUatGapSnapshotValue((fm.status || 'unknown').toLowerCase(), normalizedContent);
        }
        else if (category === 'verification_gaps') {
            snapshotKey = 'status';
            currentValue = (fm.status || 'unknown').toLowerCase();
        }
        else {
            // context_questions — WARNING 2: snapshot a content digest of the
            // question set, not just its count (see `deriveOpenQuestionsDigest`'s
            // doc comment).
            snapshotKey = 'questions_digest';
            currentValue = deriveOpenQuestionsDigest(deriveOpenQuestions(normalizedContent, fm));
        }
        fm.audit_acknowledged = { ...markerBase, [snapshotKey]: currentValue };
        const newContent = spliceAcknowledgement(content, fm, file);
        (0, shell_command_projection_cjs_2.platformWriteSync)(safeFilePath, newContent);
        output({ acknowledged: true, category, phase, file, [snapshotKey]: currentValue }, raw, 'true');
        return;
    }
    // ── The five flat categories: category-specific identifier flag ──
    // `status` for all five per the architecture's per-category table (`todos`
    // is presence-only and never reads `snapshotKey`, so it stays a constant).
    const snapshotKey = 'status';
    let safeFilePath;
    let currentValue;
    let createIfMissing = false;
    // Same value shape `Frontmatter`/`extractFrontmatter` use (frontmatter.cts
    // does not export the `Frontmatter` type name itself, so it is spelled out
    // structurally here) — keeps this and `extractFrontmatter`'s return type
    // unifying to the SAME type below instead of a lossy `Record<string,
    // unknown>` that `spliceFrontmatter`'s `Frontmatter` parameter would reject.
    let fmForCreate = {};
    if (category === 'debug_sessions') {
        if (!slug)
            ioError('--slug is required for --category debug_sessions');
        safeFilePath = (0, security_cjs_1.requireSafePath)(node_path_1.default.join(planDir, 'debug', `${slug}.md`), planDir, 'audit acknowledge target', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
        if (!node_fs_1.default.existsSync(safeFilePath))
            ioError(`file not found: debug/${slug}.md`);
        const content = node_fs_1.default.readFileSync(safeFilePath, 'utf-8');
        currentValue = (extractFrontmatter(content, safeFilePath).status || 'unknown').toLowerCase();
    }
    else if (category === 'threads') {
        if (!slug)
            ioError('--slug is required for --category threads');
        safeFilePath = (0, security_cjs_1.requireSafePath)(node_path_1.default.join(planDir, 'threads', `${slug}.md`), planDir, 'audit acknowledge target', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
        if (!node_fs_1.default.existsSync(safeFilePath))
            ioError(`file not found: threads/${slug}.md`);
        const content = node_fs_1.default.readFileSync(safeFilePath, 'utf-8');
        currentValue = deriveThreadStatus(extractFrontmatter(content, safeFilePath), content);
    }
    else if (category === 'seeds') {
        if (!seedId)
            ioError('--seed-id is required for --category seeds');
        // #4378 (roll-in): `--seed-id` arrives as whichever id an audit/list
        // surface published — the canonical identity (frontmatter `id:` or the
        // derived prefix, e.g. `SEED-081`, `SEED-260914-k3x`) or, for callers
        // scripted against pre-canonical output, the full filename stem. Resolve
        // by scanning the seeds directory and matching each candidate's derived
        // identity (falling back to the literal stem), then prove the winner with
        // requireSafePath exactly like every other acknowledge target. The direct
        // `seeds/<seedId>.md` build stays as the final fallback so a genuine
        // miss still reports the same "file not found" error as before.
        const seedsAckDir = node_path_1.default.join(planDir, 'seeds');
        let ackCandidate = null;
        let ackEntries = [];
        try {
            ackEntries = node_fs_1.default.readdirSync(seedsAckDir).filter((n) => n.startsWith('SEED-') && n.endsWith('.md'));
        }
        catch {
            ackEntries = [];
        }
        for (const name of ackEntries) {
            const stem = node_path_1.default.basename(name, '.md');
            let fmId;
            try {
                const rawAck = (0, shell_command_projection_cjs_1.platformReadSync)(node_path_1.default.join(seedsAckDir, name));
                if (rawAck !== null)
                    fmId = extractFrontmatter(normalizeLineEndings(rawAck), node_path_1.default.join(seedsAckDir, name)).id;
            }
            catch {
                fmId = undefined;
            }
            const { seed_id: derivedAckId } = commandsModule.deriveSeedIdentity(stem, fmId);
            if (derivedAckId === seedId || stem === seedId) {
                ackCandidate = name;
                break;
            }
        }
        if (ackCandidate !== null) {
            safeFilePath = (0, security_cjs_1.requireSafePath)(node_path_1.default.join(seedsAckDir, ackCandidate), planDir, 'audit acknowledge target', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
        }
        else {
            safeFilePath = (0, security_cjs_1.requireSafePath)(node_path_1.default.join(seedsAckDir, `${seedId}.md`), planDir, 'audit acknowledge target', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
            ioError(`file not found: seeds/${seedId}.md`);
        }
        const content = node_fs_1.default.readFileSync(safeFilePath, 'utf-8');
        currentValue = (extractFrontmatter(content, safeFilePath).status || 'dormant').toLowerCase();
    }
    else if (category === 'todos') {
        if (!filename)
            ioError('--filename is required for --category todos');
        // #4256: todos are root-scoped shared state — derive the todos base and
        // pass it as BOTH the path base and the requireSafePath boundary. The
        // old workstream-scoped planDir boundary would refuse a root todos file
        // outright, and even a path fix alone would have thrown here.
        const rootTodos = todosDir(cwd);
        safeFilePath = (0, security_cjs_1.requireSafePath)(node_path_1.default.join(rootTodos, 'pending', filename), rootTodos, 'audit acknowledge target', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
        if (!node_fs_1.default.existsSync(safeFilePath))
            ioError(`file not found: todos/pending/${filename}`);
        currentValue = ''; // presence-only — see scanTodos
    }
    else if (category === 'quick_tasks') {
        if (!quickDir)
            ioError('--dir is required for --category quick_tasks');
        const taskDir = (0, security_cjs_1.requireSafePath)(node_path_1.default.join(planDir, 'quick', quickDir), planDir, 'audit acknowledge target dir', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
        if (!node_fs_1.default.existsSync(taskDir))
            ioError(`directory not found: quick/${quickDir}`);
        // Shared with scanQuickTasks (#3458 follow-up) so the reader and this
        // writer can never disagree about which file is the task's record.
        const resolvedSummaryPath = resolveQuickTaskSummaryFile(taskDir, quickDir);
        if (resolvedSummaryPath) {
            safeFilePath = (0, security_cjs_1.requireSafePath)(resolvedSummaryPath, planDir, 'audit acknowledge target', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
            const content = node_fs_1.default.readFileSync(safeFilePath, 'utf-8');
            currentValue = (extractFrontmatter(content, safeFilePath).status || 'unknown').toLowerCase();
        }
        else {
            // No SUMMARY.md at all — the audit's own observed status is 'missing'.
            // There is nowhere to carry the marker, so create the canonical
            // `${dir}-SUMMARY.md` with ONLY `status: missing` + the marker — the
            // acknowledgment's own snapshot of "no summary exists yet", which
            // self-invalidates the moment a real SUMMARY.md is written (the
            // scanner then reads THAT file's own status instead).
            safeFilePath = (0, security_cjs_1.requireSafePath)(node_path_1.default.join(taskDir, `${quickDir}-SUMMARY.md`), planDir, 'audit acknowledge target', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
            currentValue = 'missing';
            createIfMissing = true;
            fmForCreate = { status: 'missing' };
        }
    }
    else {
        ioError(`unknown --category "${category}". Available: debug_sessions, quick_tasks, threads, todos, seeds, uat_gaps, verification_gaps, context_questions, deferred_items`);
        return; // unreachable — ioError throws — satisfies TS control-flow analysis
    }
    const presenceOnly = category === 'todos';
    const existingContent = createIfMissing ? '' : node_fs_1.default.readFileSync(safeFilePath, 'utf-8');
    const fm = createIfMissing ? fmForCreate : extractFrontmatter(existingContent, safeFilePath);
    fm.audit_acknowledged = presenceOnly ? { ...markerBase } : { ...markerBase, [snapshotKey]: currentValue };
    // #4802: createIfMissing splices into '' (no block to refuse on); an existing
    // file with broken YAML is refused by `spliceAcknowledgement`.
    const newContent = spliceAcknowledgement(existingContent, fm, safeFilePath);
    (0, shell_command_projection_cjs_2.platformWriteSync)(safeFilePath, newContent);
    output({ acknowledged: true, category, ...(presenceOnly ? {} : { [snapshotKey]: currentValue }) }, raw, 'true');
}
module.exports = {
    auditOpenArtifacts,
    formatAuditReport,
    listAuditPhaseTargets,
    cmdAuditAcknowledge,
    // #3805: exported so uat.cts's cmdAuditUat routes the SAME artifacts'
    // suppression through the ONE predicate instead of hand-rolling a tenth
    // copy outside this file's visibility (the exact defect class the
    // predicate's own header warns about). The snapshot derivations ride
    // along so the snapshotKeys cannot drift between the two consumers.
    isAuditItemAcknowledged,
    deriveUatGapSnapshotValue,
    // #2142: exported so src/milestone.cts's archiveQuickTaskDirectories README
    // index generator shares this ONE discovery rule rather than re-deriving it.
    resolveQuickTaskSummaryFile,
};
