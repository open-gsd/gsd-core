"use strict";
/**
 * Plan Document Module — the single parser for a `*-PLAN.md` document BODY.
 *
 * Owns: objective extraction, the task-block grammar (`<task>` elements, with
 * the legacy `## Task N` heading fallback — including the optional `tracker-id`
 * attribute, ADR-3646 Phase 1, read verbatim and never split here), planned-file
 * extraction, and the frontmatter-derived scheduling metadata (`wave`,
 * `depends_on`, `autonomous`, `agent_hint`, `files_modified`, `gap_closure`).
 *
 * WHY THIS IS A LEAF MODULE. This logic was written inline inside
 * `cmdPhasePlanIndex` (`src/phase.cts`). Two commands in two different families
 * now need it — `phase.plan-index` and `planning.inspect` (#2790) — so leaving
 * it in `phase.cts` would force `planning` to depend on `phase`, and copying it
 * would be the *Generative Fix Divergence* class `CLAUDE.md` names. A leaf owned
 * by neither family is the seam that matches the actual usage (Conway's Law).
 *
 * NOT an ADR-3180 §7 derivation. §6 puts the document-parsing layer explicitly
 * out of that epic's scope (#2143); this module answers "what does this plan
 * document say", never "how many plans are outstanding" (that is
 * `scanPhasePlans`, §7.5) or "is this phase complete" (`isPhaseComplete`, §7.4).
 *
 * BEHAVIOUR IS PRESERVED BYTE-FOR-BEHAVIOUR from the prior inline code. In
 * particular `tasks.length` is exactly the legacy `taskCount`
 * (`xmlTasks.length || mdTasks.length`), including its known fence-blindness —
 * a `## Task 1` inside a fenced code block still counts, exactly as it does
 * today. That is a characterised limit, not an endorsement: changing it would
 * silently change `phase.plan-index`'s output for existing projects, which is a
 * Hyrum's-Law break that belongs in its own issue rather than riding along on a
 * read-only query addition.
 *
 * ADR-457 build-at-publish: source in src/plan-document.cts, compiled to
 * gsd-core/bin/lib/plan-document.cjs (gitignored).
 */
// #5026 / ADR-4910 §1 absorption: the 7 frontmatter-derived scheduling fields
// below, plus `objective` as an 8th (see `frontmatterField`'s own docblock),
// read through `planning-document.cts`'s seam
// (`readFrontmatterFieldsFromSource`) rather than calling `frontmatter.cts`'s
// `extractFrontmatter` directly. This module has no canonical `.planning/`-root
// artifact basename to gate `parsePlanningDoc` on (`*-PLAN.md` lives nested
// under `.planning/phase/*/plans/`, and two of the five real callers hold only
// in-memory content with no path at all), so it uses the entry point shaped
// for exactly that: content in hand, no filename, no other `PlanningDoc`
// capability (sections/tables/checklists) this module needs. The BULK form
// (`readFrontmatterFieldsFromSource`, not the single-key
// `readFrontmatterFieldFromSource`) is used deliberately: `parsePlanDocument`
// reads several keys off the SAME document, and the single-key entry point
// would independently re-detect the frontmatter span and re-parse the full
// YAML once per key. See both functions' docblocks in `planning-document.cts`
// for the full reasoning.
const planning_document_cjs_1 = require("./planning-document.cjs");
// ─── Frozen vocabularies ──────────────────────────────────────────────────────
/**
 * How a task row was expressed in the document. `auto` is the ordinary
 * executable task; `checkpoint` is a `<task type="checkpoint:*">` block, which
 * carries an entirely different element set (`<decision>`/`<what-built>`, no
 * `<name>`/`<files>`/`<acceptance_criteria>`). Distinguishing them is what
 * stops a checkpoint from being reported as a malformed auto task.
 */
const TASK_KIND = Object.freeze({
    AUTO: 'auto',
    CHECKPOINT: 'checkpoint',
});
// ─── Task grammar ─────────────────────────────────────────────────────────────
// The legacy counting rule, preserved verbatim from cmdPhasePlanIndex. `g` is
// required (we count every occurrence) and these are rebuilt per call rather
// than hoisted to module scope: a global regex carries mutable `lastIndex`
// state, and a shared instance is a cross-call contamination bug.
function xmlTaskOpenings(content) {
    return [...content.matchAll(/<task(?=[\s>])[^>]*>/gi)];
}
function markdownTaskHeadings(content) {
    return [...content.matchAll(/##\s*Task\s*\d+[^\n]*/gi)];
}
/** Extract the value of one attribute from a `<task ...>` opening tag. */
function tagAttribute(openTag, attr) {
    const re = new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"|\\b${attr}\\s*=\\s*'([^']*)'`, 'i');
    const m = re.exec(openTag);
    if (!m)
        return null;
    const value = (m[1] ?? m[2] ?? '').trim();
    return value.length > 0 ? value : null;
}
/**
 * Body of the first `<tag>…</tag>` inside `block`, or null. Non-greedy and
 * case-insensitive; a tag that is opened but never closed yields null rather
 * than swallowing the rest of the document.
 */
function elementBody(block, tag) {
    const re = new RegExp(`<${tag}\\s*>([\\s\\S]*?)</${tag}\\s*>`, 'i');
    const m = re.exec(block);
    return m ? m[1] : null;
}
/**
 * Split a `<files>` body into paths. Comma-separated per the shipped
 * `templates/phase-prompt.md` grammar; newline-separated forms are tolerated
 * too (Postel — liberal in what we accept), and the caller records nothing
 * special for them because a path list is a path list either way.
 */
function splitFileList(body) {
    if (body === null)
        return [];
    return body
        .split(/[,\n]/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}
/** `<acceptance_criteria>` carries `- ` bullets, one criterion per line. */
function splitCriteria(body) {
    if (body === null)
        return [];
    return body
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.replace(/^[-*]\s*/, ''))
        .filter((line) => line.length > 0);
}
function collapseWhitespace(value) {
    if (value === null)
        return null;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    return trimmed.length > 0 ? trimmed : null;
}
/**
 * Parse the `<task>` blocks. Each opening tag found by `xmlTaskOpenings` yields
 * exactly one row — the block runs from that tag to its `</task>`, or to the
 * next opening tag, or to end-of-document. Bounding on the NEXT OPENING rather
 * than only on `</task>` is what keeps an unclosed block from consuming its
 * siblings, so the row count still equals the opening count.
 */
function parseXmlTasks(content) {
    const openings = xmlTaskOpenings(content);
    return openings.map((match, i) => {
        const start = match.index ?? 0;
        const openTag = match[0];
        const nextStart = i + 1 < openings.length ? (openings[i + 1].index ?? content.length) : content.length;
        const window = content.slice(start, nextStart);
        const closeIdx = window.search(/<\/task\s*>/i);
        const block = closeIdx === -1 ? window : window.slice(0, closeIdx);
        const type = tagAttribute(openTag, 'type');
        const kind = type !== null && type.toLowerCase().startsWith('checkpoint')
            ? TASK_KIND.CHECKPOINT
            : TASK_KIND.AUTO;
        // A checkpoint block has no <name>/<files>/<acceptance_criteria>/<done> in
        // the shipped grammar. Reading them anyway would be harmless but dishonest:
        // the caller must be able to tell "this element is absent because this kind
        // of task has no such element" from "this element is missing and should not
        // be".
        if (kind === TASK_KIND.CHECKPOINT) {
            return {
                index: i + 1,
                kind,
                type,
                name: null,
                plannedFiles: [],
                acceptanceCriteria: [],
                done: null,
                trackerId: null,
                tdd: null,
            };
        }
        return {
            index: i + 1,
            kind,
            type,
            name: collapseWhitespace(elementBody(block, 'name')),
            plannedFiles: splitFileList(elementBody(block, 'files')),
            acceptanceCriteria: splitCriteria(elementBody(block, 'acceptance_criteria')),
            done: collapseWhitespace(elementBody(block, 'done')),
            trackerId: tagAttribute(openTag, 'tracker-id'),
            tdd: tagAttribute(openTag, 'tdd'),
        };
    });
}
/**
 * Legacy fallback: `## Task N` headings, used ONLY when the document carries no
 * `<task>` blocks at all. Deliberately fence-blind, matching the counting rule
 * `cmdPhasePlanIndex` has always used — see this module's header comment.
 */
function parseMarkdownTasks(content) {
    return markdownTaskHeadings(content).map((match, i) => ({
        index: i + 1,
        kind: TASK_KIND.AUTO,
        type: null,
        name: collapseWhitespace(match[0].replace(/^##\s*/, '')),
        plannedFiles: [],
        acceptanceCriteria: [],
        done: null,
        trackerId: null,
        tdd: null,
    }));
}
// ─── Objective ────────────────────────────────────────────────────────────────
/**
 * Preserved verbatim from `cmdPhasePlanIndex`: the first line following an
 * `<objective>` tag. Deliberately NOT widened to the full element body — that
 * would change `phase.plan-index`'s existing output for any multi-line
 * objective.
 */
function extractObjective(content) {
    const m = content.match(/<objective>\s*\n?\s*(.+)/);
    return m ? m[1].trim() : null;
}
// ─── Entry point ──────────────────────────────────────────────────────────────
/**
 * The plan id for a plan FILE ENTRY, exactly as `scanPhasePlans` stores it
 * (root entries bare, nested entries `plans/`-prefixed).
 *
 * This is the established derivation from `cmdPhasePlanIndex`, moved here
 * VERBATIM (#2790) so `phase.plan-index` and `planning.inspect` cannot report
 * different ids for the same plan — a consumer correlating the two surfaces
 * needs them to join. Deliberately NOT "improved": it is a display/lookup key
 * with existing callers, and changing what it returns would be a Hyrum's-Law
 * break on `phase-plan-index`.
 */
function planIdFromFile(planFile) {
    return planFile.replace('-PLAN.md', '').replace('PLAN.md', '');
}
/**
 * The frontmatter keys `parsePlanDocument` reads: the 7 scheduling fields
 * this absorption originally scoped (`wave`, `depends_on`, `autonomous`,
 * `files_modified`/`files-modified`, `files_deleted`/`files-deleted`,
 * `agent_hint`, `type` — 9 key spellings across those 7 fields), PLUS
 * `objective` as an 8th field. `objective` is read through this SAME
 * frontmatter-key-read path — not a deliberate exclusion, as an earlier
 * revision of this comment claimed — because `parsePlanDocument`'s return
 * statement below falls back to `frontmatterField(content, 'objective')`
 * whenever the `<objective>` XML tag (`extractObjective`, unrelated and
 * untouched by this absorption) is absent; it is included here simply
 * because reading it is the exact same pattern as the other seven, and the
 * migration below naturally covers it. `gap_closure` (#4924) is a 9th field,
 * absorbed onto this same bulk-read seam by this fix rather than left on the
 * removed `fm[key]` object-property read it was rebased in against.
 * `executor_runtime` (#6302) is a 10th field, read through the same seam.
 */
const FRONTMATTER_READ_KEYS = [
    'wave',
    'depends_on',
    'autonomous',
    'files_modified',
    'files-modified',
    'files_deleted',
    'files-deleted',
    'agent_hint',
    'executor_runtime',
    'type',
    'objective',
    'gap_closure',
];
/**
 * Read one top-level frontmatter key out of an already-bulk-read
 * `Record<string, NodeRead>` (`readFrontmatterFieldsFromSource`'s return
 * value, computed ONCE per `parsePlanDocument` call — see
 * `FRONTMATTER_READ_KEYS`), unwrapped to the SAME shape a direct `fm[key]`
 * object-property read would give: the field's value, or `undefined` when it
 * is absent, the document has no frontmatter, or the frontmatter is
 * unparseable — `readFrontmatterFieldsFromSource` reports all three of those
 * as an `ok: false` result per key, and `extractFrontmatter`'s own object
 * would likewise simply lack the key in every one of those cases.
 */
function frontmatterField(fields, key) {
    const read = fields[key];
    return read?.ok ? read.value : undefined;
}
/**
 * Parse one plan document.
 *
 * @param content  Raw `*-PLAN.md` text.
 * @param planPath Historically the path passed to `extractFrontmatter`'s
 *                 truncated-frontmatter diagnostic (#1882) — a stderr-only
 *                 side channel, never part of this function's return value.
 *                 #5026: the 10 frontmatter fields below (7 scheduling fields,
 *                 plus `objective`, `gap_closure` and `executor_runtime`) now read through
 *                 `readFrontmatterFieldFromSource`, which has no path
 *                 parameter, so this diagnostic's file-naming/dedup key is a
 *                 documented, accepted side-effect-only regression (falls
 *                 back to content-digest dedup, the same fallback
 *                 `extractFrontmatter` already uses for the two real callers
 *                 that never had a path to give it). Kept for call-site
 *                 signature compatibility only.
 */
function parsePlanDocument(content, _planPath = '') {
    const xmlTasks = parseXmlTasks(content);
    const tasks = xmlTasks.length > 0 ? xmlTasks : parseMarkdownTasks(content);
    // Detect the frontmatter span and parse its YAML ONCE (#5026 follow-up: the
    // prior per-key `frontmatterField(content, key)` calls each independently
    // re-detected the span and re-parsed the full YAML from scratch — 10x
    // redundant detection+parse per call). Every `frontmatterField` read below
    // shares this SAME parsed result.
    const fields = (0, planning_document_cjs_1.readFrontmatterFieldsFromSource)(content, FRONTMATTER_READ_KEYS);
    const parsedWave = parseInt(frontmatterField(fields, 'wave'), 10);
    const declaredWave = Number.isNaN(parsedWave) ? null : parsedWave;
    let dependsOn = [];
    const fmDeps = frontmatterField(fields, 'depends_on');
    if (Array.isArray(fmDeps)) {
        dependsOn = fmDeps.map(String);
    }
    else if (typeof fmDeps === 'string' && fmDeps.trim() !== '') {
        dependsOn = [fmDeps];
    }
    let autonomous = true;
    const fmAutonomous = frontmatterField(fields, 'autonomous');
    if (fmAutonomous !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue comparison
        autonomous = fmAutonomous === 'true' || String(fmAutonomous) === 'true';
    }
    let filesModified = [];
    const fmFiles = frontmatterField(fields, 'files_modified') || frontmatterField(fields, 'files-modified');
    if (fmFiles) {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue scalar-to-string
        filesModified = Array.isArray(fmFiles) ? fmFiles.map(String) : [String(fmFiles)];
    }
    let filesDeleted = [];
    const fmDeleted = frontmatterField(fields, 'files_deleted') || frontmatterField(fields, 'files-deleted');
    if (fmDeleted) {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue scalar-to-string
        filesDeleted = Array.isArray(fmDeleted) ? fmDeleted.map(String) : [String(fmDeleted)];
    }
    let agentHint = null;
    const fmAgentHint = frontmatterField(fields, 'agent_hint');
    if (fmAgentHint !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue scalar-to-string
        const hintStr = String(fmAgentHint).trim();
        agentHint = hintStr !== '' ? hintStr : null;
    }
    let executorRuntime = null;
    const fmExecutorRuntime = frontmatterField(fields, 'executor_runtime');
    // A bare `executor_runtime:` opens a nested map in the frontmatter reader, so only a scalar string counts.
    if (typeof fmExecutorRuntime === 'string') {
        const runtimeStr = fmExecutorRuntime.trim();
        executorRuntime = runtimeStr !== '' ? runtimeStr : null;
    }
    let planType = null;
    const fmType = frontmatterField(fields, 'type');
    if (fmType !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- FrontmatterValue scalar-to-string
        planType = String(fmType);
    }
    return {
        objective: extractObjective(content) || frontmatterField(fields, 'objective') || null,
        type: planType,
        declaredWave,
        dependsOn,
        autonomous,
        agentHint,
        executorRuntime,
        filesModified,
        filesDeleted,
        // extractFrontmatter yields every scalar as a string, so YAML `true` is 'true'.
        gapClosure: frontmatterField(fields, 'gap_closure') === 'true',
        tasks,
        taskCount: tasks.length,
    };
}
const planDocument = { TASK_KIND, parsePlanDocument, planIdFromFile, extractThreatRegisterIds };
/**
 * #4683 — first-cell IDs of the STRIDE register rows inside every
 * `<threat_model>` block. The register is a markdown table (the
 * `<threat_model>` template in agents/gsd-planner.md): one row per threat,
 * first cell `T-{phase}-NN` — decimal phases included — or the reserved
 * `T-{phase}-SC` supply-chain row. Only digit-suffixed IDs match: `-SC` is
 * deliberately shared by EVERY plan in a phase (planner rule "Keep
 * `T-{phase}-SC` in `<threat_model>`"), so it can never be a uniqueness
 * violation. IDs in prose or non-threat tables never count; only register
 * rows inside a threat_model block do. One entry per matched row, in document
 * order — deciding that the same ID in two plans is a collision is the
 * aggregator's question (init.cts), not the per-document parser's.
 *
 * Knowingly unmatched residual classes (#4683 review, accepted): lowercase
 * `t-47-01`, letter suffixes (`T-47-05A`), annotated first cells
 * (`| T-47-06 (revised) |`), IDs in non-first cells, and an unterminated
 * `<threat_model>` block all yield no claim. All are off-template shapes — the
 * planner template fixes the row grammar — so the residual risk is silent
 * under-detection, never a false hard-stop.
 */
const THREAT_MODEL_BLOCK_RE = /<threat_model>([\s\S]*?)<\/threat_model>/gi;
const THREAT_REGISTER_ROW_RE = /^[^\S\n]*\|[^\S\n]*(T-\d+(?:\.\d+)?-\d+)[^\S\n]*\|/;
function extractThreatRegisterIds(content) {
    // Fenced code blocks are prose, not registers (#4683 review MAJOR): a plan
    // that QUOTES an existing register — exactly what the gap-closure flow tells
    // the planner to read — must not have its quoted IDs counted as claims, or
    // the execute-phase gate would hard-stop a correct phase. Same line-toggling
    // idiom as the deferred-scope scan in phase.cts.
    const lines = [];
    let inFence = false;
    for (const line of content.split(/\r?\n/)) {
        if (/^\s*(?:```|~~~)/.test(line)) {
            inFence = !inFence;
            lines.push('');
            continue;
        }
        lines.push(inFence ? '' : line);
    }
    const ids = [];
    for (const blockMatch of lines.join('\n').matchAll(THREAT_MODEL_BLOCK_RE)) {
        for (const line of blockMatch[1].split('\n')) {
            const row = line.match(THREAT_REGISTER_ROW_RE);
            if (row)
                ids.push(row[1]);
        }
    }
    return ids;
}
module.exports = planDocument;
