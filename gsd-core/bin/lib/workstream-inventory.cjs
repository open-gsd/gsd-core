"use strict";
/**
 * Workstream Inventory Module
 *
 * Owns discovery and read-only projection of .planning/workstreams/* state.
 * Command handlers should render outputs from this inventory instead of
 * rescanning workstream directories directly.
 *
 * Pure projection logic lives in workstream-inventory-builder.cts.
 * This module handles I/O orchestration only.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/workstream-inventory.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const coreUtilsMod = require("./core-utils.cjs");
const { readSubdirectories } = coreUtilsMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planScan = require("./plan-scan.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planningWorkspace = require("./planning-workspace.cjs");
const { planningPaths, planningRoot, getActiveWorkstream, resolvePhaseIdConvention } = planningWorkspace;
const state_document_cjs_1 = require("./state-document.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
const frontmatterMod = require("./frontmatter.cjs");
const { extractFrontmatter, stripFrontmatter } = frontmatterMod;
const roadmap_progress_cjs_1 = require("./roadmap-progress.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verification.cjs is an export= CommonJS module
const verificationMod = require("./verification.cjs");
const { isPhaseComplete, isVerificationStatus, VERIFICATION_STATUS } = verificationMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-id.cjs is an export= CommonJS module
const phaseIdMod = require("./phase-id.cjs");
const { phaseKeyFromDir, phaseKeyFromProse, parentPhaseKey } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- roadmap-parser.cjs is an export= CommonJS module
const roadmapParserMod = require("./roadmap-parser.cjs");
const { getMilestonePhaseFilter, isMilestoneShippedInRoadmap } = roadmapParserMod;
const workstream_inventory_builder_cjs_1 = require("./workstream-inventory-builder.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const phaseLocatorMod = require("./phase-locator.cjs");
const { phaseDirectoryOptions } = phaseLocatorMod;
// ─── Implementation ───────────────────────────────────────────────────────────
function workstreamsRoot(cwd) {
    return node_path_1.default.join(planningRoot(cwd), 'workstreams');
}
/**
 * #3185 (ADR-3180 Decision 1): count the phases the CURRENT milestone
 * declares, not every `Phase` heading in the file.
 *
 * This previously matched `^#{2,4}\s+Phase\s+…` across the whole ROADMAP with
 * no milestone window and no sentinel filter, so it counted 999.* backlog and
 * Phase 0 headings and spanned every milestone the document had ever had.
 * `getMilestonePhaseFilter` already computes exactly this number for the
 * scoped window (`phaseCount`, sentinel-filtered), and `inspectWorkstream` in
 * this same file already passes a resolved `currentVersion` to it — this
 * function was the sibling copy that never got the fix.
 */
function countRoadmapPhases(roadmapPath, fallbackCount, cwd, ws, versionOverride) {
    try {
        if (!node_fs_1.default.existsSync(roadmapPath))
            return fallbackCount;
        if (!cwd)
            return fallbackCount;
        // #2761 B1 (trek-e review): `undefined`, NOT `null`. The third argument
        // discriminates "not resolved yet — resolve it from this workstream's
        // config" (`undefined`) from "resolved, and it is not bracket" (`null`).
        // This site meant the former and spelled the latter, so a workstream that
        // opted into `phase_id_convention: "bracket"` had its ROADMAP scanned with
        // the LEGACY grammar: the heading set came back empty, `phaseCount` was 0,
        // and the count silently fell back to the on-disk directory count — the
        // very degrade the #3185 rewrite of this function existed to remove.
        // Measured on a bracket workstream whose milestone declares 3 phases:
        // `null` -> 0 (fallback), `undefined` -> 3. A non-bracket workstream
        // resolves to a value that compiles the same base grammar `null` did, so
        // its count is unchanged (verified against a legacy control).
        const filter = getMilestonePhaseFilter(cwd, versionOverride ?? null, undefined, ws ?? null, phaseDirectoryOptions(cwd, undefined, undefined, ws ?? null));
        // A pass-all degrade (phaseCount 0) means the window declared no phases —
        // fall back rather than reporting a confident zero.
        return filter.phaseCount > 0 ? filter.phaseCount : fallbackCount;
    }
    catch {
        return fallbackCount;
    }
}
/**
 * #2562: parse the ROADMAP `## Progress` table into canonical phase keys with
 * their milestone attribution, e.g. `| 30. Name | v10.0 | 1/3 | … |` →
 * `{ key: '30', version: 'v10.0' }`. The table is the authoritative per-phase
 * milestone attribution and — crucially — lists phases declared but never
 * scaffolded (no directory), which a directory-only scan misses. `Plans
 * Complete` is present in BOTH RoadmapProgress variants, so this matches the
 * flat (no Milestone column → every `version` null) and milestone-grouped
 * shapes alike.
 *
 * Row keys come from `phaseKeyFromProse`, the same owner-module derivation
 * `phaseKeyFromDir` uses for directories, so a `| 01. … |` row and a `1-slug`
 * directory cannot land in different key spaces (the padding-asymmetry defect).
 */
function parseRoadmapProgressRows(content, directoryContext, convention) {
    // Milestone-ATTRIBUTING shape first. Both shapes carry `Plans Complete`, so
    // probing that column first would pick a flat table appearing earlier in the
    // document over a milestone-grouped one later — every row would come back
    // unattributed and be treated as current-milestone, silently over-including.
    // #5761: the roadmap-progress owner picks the table (heading-scoped, so a
    // decoy table elsewhere cannot be mistaken for it); this reader only supplies
    // the probe order. A table outside a table-less `## Progress` section has
    // always been read here (#5692: no behavior change), hence `sectionMiss`.
    const { rows: tableRows } = (0, roadmap_progress_cjs_1.locateRoadmapProgress)(content, {
        columns: [['Phase', 'Milestone'], ['Phase', 'Plans Complete']],
        sectionMiss: 'document',
    });
    const rows = [];
    for (const row of tableRows) {
        const key = phaseKeyFromProse(row['Phase'], directoryContext, convention);
        if (key === null)
            continue;
        const cell = (row['Milestone'] ?? '').trim();
        rows.push({ key, version: /^v\d+(?:\.\d+)+$/.test(cell) ? cell : null });
    }
    return rows;
}
/**
 * #2562: the workstream's CURRENT milestone version, read from the STATE.md
 * `milestone:` frontmatter field (the reliable per-workstream signal — the
 * ROADMAP's own in-progress markers can be stale, e.g. a lingering 🚧 on an
 * already-shipped milestone). Falls back to the ROADMAP in-progress heading
 * marker only when STATE has no field.
 */
function readCurrentMilestoneVersion(statePath, roadmapPath) {
    try {
        const m = node_fs_1.default.readFileSync(statePath, 'utf-8').match(/^milestone:\s*["']?(v\d+(?:\.\d+)+)["']?/m);
        if (m)
            return m[1];
    }
    catch {
        /* no state */
    }
    try {
        const rm = node_fs_1.default.readFileSync(roadmapPath, 'utf-8').match(/(?:🚧|🔄)\s*\*\*(v\d+(?:\.\d+)+)\b/);
        if (rm)
            return rm[1];
    }
    catch {
        /* no roadmap */
    }
    return null;
}
/**
 * #2562: does the CURRENT milestone's own ROADMAP heading carry a shipped
 * marker? Delegated to `roadmap-parser`, the module that owns milestone-heading
 * classification: heading/`<summary>` lines only (never a bullet that merely
 * names the version), version-token boundary-matched so `v2.0` does not match
 * inside `v2.0.1`, and in-progress markers win. Scoped to the current version,
 * so a prior milestone's collapsed `<details><summary>✅ … SHIPPED</summary>`
 * block can never mark the current milestone complete.
 */
function currentMilestoneHeadingShipped(roadmapPath, version) {
    try {
        return isMilestoneShippedInRoadmap(node_fs_1.default.readFileSync(roadmapPath, 'utf-8'), version);
    }
    catch {
        return false; /* no roadmap */
    }
}
/**
 * Legacy pre-#2562 shipped detection: ANY archived milestone snapshot OR a
 * SHIPPED marker anywhere in the ROADMAP. Over-broad (project-lifetime, not
 * milestone-scoped) — retained ONLY as the fallback when the current milestone
 * version cannot be determined (malformed/legacy STATE.md with no `milestone:`
 * field), so those projects keep #1913's stale-field protection.
 */
function legacyMilestoneShipped(roadmapPath, planningBase) {
    try {
        const milestonesDir = node_path_1.default.join(planningBase, 'milestones');
        for (const entry of node_fs_1.default.readdirSync(milestonesDir, { withFileTypes: true })) {
            if (entry.isFile() && /-ROADMAP\.md$/i.test(entry.name))
                return true;
        }
    }
    catch {
        /* no milestones archive dir */
    }
    try {
        if (/SHIPPED/i.test(node_fs_1.default.readFileSync(roadmapPath, 'utf-8')))
            return true;
    }
    catch {
        /* no roadmap */
    }
    return false;
}
/**
 * #2562: directory mtime, used only to break a duplicate-phase-key tie in the
 * rollup (keep the more recently touched directory — the Bug #2445 rule). 0 on
 * a stat failure, which loses the tie rather than throwing.
 */
function phaseDirMtime(phaseDir) {
    try {
        return node_fs_1.default.statSync(phaseDir).mtimeMs;
    }
    catch {
        return 0;
    }
}
function countPhaseFiles(phaseDir) {
    const scan = planScan(phaseDir);
    return { planCount: scan.planCount, summaryCount: scan.summaryCount };
}
function verificationLedgerPath(wsDir) {
    return node_path_1.default.join(wsDir, '.verification-ledger.json');
}
function readVerificationLedger(wsDir) {
    const ledgerPath = verificationLedgerPath(wsDir);
    let raw;
    try {
        raw = node_fs_1.default.readFileSync(ledgerPath, 'utf-8');
    }
    catch (err) {
        // `fs.readFileSync` FOLLOWS symlinks, so a broken symlink at this path
        // (the entry exists, its target does not) reports the EXACT SAME
        // `ENOENT` as genuine absence — `code` alone cannot distinguish
        // "nothing was ever here" from "something is here and cannot be read".
        // `fs.lstatSync` does NOT follow symlinks, so it still finds the
        // symlink entry itself even when its target is gone. Only when NEITHER
        // call finds anything is this genuinely `'absent'` (pre-adoption); a
        // present-but-broken symlink is evidence something existed and must
        // fail CLOSED like any other unreadable ledger, not fall open.
        const code = err?.code;
        if (code === 'ENOENT') {
            try {
                node_fs_1.default.lstatSync(ledgerPath);
                return { state: 'corrupt', entries: {} }; // a symlink entry exists; its target does not
            }
            catch (lstatErr) {
                // #2645 review: every OTHER failure path in this function fails
                // CLOSED — this one must too. A failed `lstatSync` is only proof of
                // absence when IT ALSO reports `ENOENT`; anything else (a raced
                // permission change, a path component that became inaccessible
                // between the two calls, …) is not evidence the file was never
                // there, and a bare `catch {}` here would silently fall OPEN exactly
                // like the two-state design this fix replaced.
                const lstatCode = lstatErr?.code;
                if (lstatCode === 'ENOENT')
                    return { state: 'absent', entries: {} }; // truly nothing at this path
                return { state: 'corrupt', entries: {} };
            }
        }
        // Any OTHER read failure (EACCES, EISDIR, …) also means the path EXISTS
        // in some form but this process cannot see its content right now — that
        // is corruption from this reader's point of view, not absence, and must
        // fail closed rather than silently falling back to the ungated
        // pre-adoption behavior.
        return { state: 'corrupt', entries: {} };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { state: 'corrupt', entries: {} };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { state: 'corrupt', entries: {} };
    }
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
        // #5118: an entry outside the closed enum (a stored `unknown` from an
        // older run) reads as absent — the phase then fails CLOSED to
        // `unrecorded`, the same posture as a corrupt ledger.
        if (isVerificationStatus(value))
            out[key] = value;
    }
    return { state: 'ok', entries: out };
}
// #2645 review: Windows can transiently hold the rename target busy (AV
// scanners, indexers) — the SAME retry shape `broken-windows.cts`'s
// `writeLedgerAtomic`/`renameWithRetry` already uses for its own ledger
// write, mirrored here rather than imported (that function is private to
// its module) so this fix does not widen its own blast radius by exporting
// a new cross-module utility.
const LEDGER_RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const LEDGER_RENAME_MAX_ATTEMPTS = 5;
const LEDGER_RENAME_BACKOFF_MS = 25;
function renameVerificationLedgerWithRetry(tmpPath, finalPath) {
    let lastErr;
    for (let attempt = 0; attempt < LEDGER_RENAME_MAX_ATTEMPTS; attempt++) {
        try {
            node_fs_1.default.renameSync(tmpPath, finalPath);
            return;
        }
        catch (err) {
            lastErr = err;
            const code = (err && typeof err === 'object' && 'code' in err) ? String(err.code) : '';
            if (code && LEDGER_RENAME_RETRY_ERRNOS.has(code) && attempt < LEDGER_RENAME_MAX_ATTEMPTS - 1) {
                // Exponential-ish backoff: 25ms, 50ms, 100ms, 200ms. Transient
                // Windows locks usually clear well inside that window.
                const delay = LEDGER_RENAME_BACKOFF_MS * Math.pow(2, attempt);
                const start = Date.now();
                while (Date.now() - start < delay) {
                    // Deliberate short busy-wait — no async/timer seam is available
                    // in this synchronous read path.
                }
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}
function writeVerificationLedger(wsDir, ledger) {
    // #2645 review: atomic write. A crash or a concurrent read mid-write
    // against `verificationLedgerPath(wsDir)` directly would leave (or briefly
    // expose) TRUNCATED JSON — and now that `'corrupt'` carries real semantic
    // weight (it fails CLOSED, holding every phase with no live report at
    // `'unrecorded'`), producing a corrupt file ourselves is a self-inflicted
    // version of the exact failure mode this fix exists to survive. Write to a
    // sibling temp file in the SAME directory (same filesystem — `rename` is
    // only atomic within one) and rename into place: a reader can only ever
    // observe the prior complete content or the new complete content.
    const finalPath = verificationLedgerPath(wsDir);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    try {
        node_fs_1.default.mkdirSync(wsDir, { recursive: true });
        node_fs_1.default.writeFileSync(tmpPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf-8');
        renameVerificationLedgerWithRetry(tmpPath, finalPath);
    }
    catch {
        // Best-effort persistence: a missing parent directory that `mkdirSync`
        // itself cannot create, a read-only filesystem, a write failure, or a
        // rename failure that exhausts its retries must not break inventory
        // reads, which are otherwise pure. Losing this observation only
        // re-opens the pre-#2645 window for THIS run; the next successful read
        // while a report is on disk repairs it. Clean up a half-written temp
        // file so repeated failures cannot accumulate orphaned
        // `.verification-ledger.json.<pid>.tmp` files.
        try {
            node_fs_1.default.unlinkSync(tmpPath);
        }
        catch { /* nothing to clean up, or cleanup itself failed — not fatal */ }
    }
}
function readStateProjection(statePath) {
    try {
        const stateContent = node_fs_1.default.readFileSync(statePath, 'utf-8');
        // #3187: route Status/Current Phase/Last Activity through the single
        // #1760 fallback-chain owner (state-document.cjs's stateFieldValue)
        // instead of a frontmatter-blind stateExtractField(stateContent, …) call,
        // mirroring cmdStateValidate/cmdStateSnapshot — a STATE.md whose fields
        // live only in frontmatter is no longer projected as absent here.
        const fm = extractFrontmatter(stateContent, statePath);
        const body = stripFrontmatter(stateContent);
        return {
            status: (0, state_document_cjs_1.stateFieldValue)(fm, body, 'status', 'Status').value || 'unknown',
            current_phase: (0, state_document_cjs_1.stateFieldValue)(fm, body, 'current_phase', 'Current Phase').value,
            last_activity: (0, state_document_cjs_1.stateFieldValue)(fm, body, 'last_activity', 'Last Activity').value,
        };
    }
    catch {
        // Read/parse failure (missing file, permission fault, etc.) degrades to
        // an all-unknown projection — unchanged. Not widened to also carry a
        // `scope` here: doing so would ripple `StateProjection`
        // (workstream-inventory-builder.cjs) and every consumer of this
        // read-only rollup — the design doc's blast-radius table rates
        // `readStateProjection` "low"/Tier-2, and this call site's migration is
        // scoped to routing the fallback chain, not to widening the return type.
        // The existing all-unknown degrade already distinguishes "could not
        // read" from any real field value; only its scope-vs-absence *reason*
        // stays uncaptured, same as before this change.
        return {
            status: 'unknown',
            current_phase: null,
            last_activity: null,
        };
    }
}
/**
 * #1913 + #2562: detect an authoritative shipped signal for a workstream's
 * CURRENT milestone, so the inventory status is never trusted from the mutable
 * STATE.md `Status` field alone (#1913) yet is never pinned to "milestone
 * complete" by a PRIOR milestone's shipped marker (#2562).
 *
 * When the current milestone version is known, the signal is scoped to it:
 * an archived snapshot `milestones/<version>-ROADMAP.md` (the canonical
 * "milestone shipped" artifact) OR the current milestone's own ROADMAP line
 * marked shipped. When the version cannot be determined, we fall back to the
 * over-broad legacy detection to preserve #1913's protection for those
 * (malformed/legacy) projects.
 *
 * Returns WHICH signal fired, not merely that one did. The two differ in how
 * much they can be trusted and therefore in how the builder cross-validates
 * them against the milestone's own artifacts — see the `shippedContradicted`
 * block in `workstream-inventory-builder.cts`. Collapsing them to a boolean is
 * what forced a single completeness check to serve two incompatible shapes.
 */
function workstreamShippedSignal(roadmapPath, planningBase, currentVersion) {
    if (!currentVersion) {
        return legacyMilestoneShipped(roadmapPath, planningBase) ? 'legacy' : null;
    }
    // Canonical shipped artifact: the archived ROADMAP snapshot of the CURRENT
    // milestone (`vX.Y-ROADMAP.md`), written at milestone close. REQUIREMENTS
    // snapshots are intentionally NOT accepted — they can be written at milestone
    // START (requirements-locked), so they do not imply shipped.
    const snapshot = node_path_1.default.join(planningBase, 'milestones', `${currentVersion}-ROADMAP.md`);
    if (node_fs_1.default.existsSync(snapshot))
        return 'snapshot';
    return currentMilestoneHeadingShipped(roadmapPath, currentVersion) ? 'heading' : null;
}
function sortWorkstreamInventories(inventories, activeWorkstreamName) {
    return [...inventories].sort((a, b) => {
        const aActive = a.name === activeWorkstreamName ? 1 : 0;
        const bActive = b.name === activeWorkstreamName ? 1 : 0;
        if (aActive !== bActive) {
            return bActive - aActive;
        }
        return a.name.localeCompare(b.name);
    });
}
function inspectWorkstream(cwd, name, options = {}) {
    const wsDir = node_path_1.default.join(workstreamsRoot(cwd), name);
    if (!node_fs_1.default.existsSync(wsDir))
        return null;
    const activeWorkstreamName = options.active === undefined ? getActiveWorkstream(cwd) : options.active;
    const writeDiagnostic = options.writeDiagnostic ?? ((message) => process.stderr.write(message));
    const p = planningPaths(cwd, name);
    const phaseDirNames = readSubdirectories(p.phases);
    let roadmap = '';
    try {
        roadmap = node_fs_1.default.readFileSync(p.roadmap, 'utf8');
    }
    catch { /* no roadmap */ }
    const directoryContext = phaseDirectoryOptions(cwd, undefined, roadmap, name);
    // #2562: scope progress to the CURRENT milestone. Membership and the
    // denominator are derived in ONE key space (`phaseKeyFromDir` /
    // `phaseKeyFromProse`, both from the phase-id owner module) so the two sides
    // of the rollup cannot disagree.
    const currentVersion = readCurrentMilestoneVersion(p.state, p.roadmap);
    const progressRows = parseRoadmapProgressRows(roadmap, directoryContext, resolvePhaseIdConvention(cwd, name));
    // Phase keys the ROADMAP attributes to the current milestone. A row whose
    // Milestone cell is blank or malformed is INCLUDED rather than dropped: a
    // phase we cannot attribute must still be visible to the rollup. Dropping it
    // from both sides was the silent-deletion defect — it let an unstarted phase
    // vanish and the percentage round to 100. Over-inclusive-never-under is the
    // degrade direction this codebase already commits to for unparseable roadmap
    // input (see the getMilestonePhaseFilter catch in roadmap-parser.cts).
    const currentMilestoneKeys = new Set();
    if (currentVersion) {
        for (const row of progressRows) {
            if (row.version === null || row.version === currentVersion)
                currentMilestoneKeys.add(row.key);
        }
    }
    // Roadmap-heading membership, from the module that OWNS milestone-phase
    // filtering. Consulted only when it is genuinely scoped to a single milestone
    // (`versionScoped`); the unversioned whole-roadmap shape spans the project's
    // lifetime and would re-admit prior-milestone phases — the very defect here.
    //
    // #2761 B1 (trek-e review): `undefined`, not `null` — same discriminator fix
    // as `countRoadmapPhases` above. This site iterates workstreams by NAME, so
    // it is exactly the caller that cannot set `GSD_WORKSTREAM`; spelling `null`
    // pinned every workstream to the legacy grammar and made `headingScoped`
    // unreachable (`phaseCount > 0` never held) on a bracket workstream.
    const headingFilter = getMilestonePhaseFilter(cwd, currentVersion, undefined, name, directoryContext);
    const headingScoped = headingFilter.versionScoped && headingFilter.phaseCount > 0;
    // Phase keys the ROADMAP attributes to some OTHER milestone. A row carrying an
    // explicit version that is not the current one is a positive claim by a prior
    // (or future) milestone — the only reliable evidence that a phase does NOT
    // belong to the current one.
    const claimedElsewhere = new Set();
    for (const row of progressRows) {
        if (row.version !== null && row.version !== currentVersion)
            claimedElsewhere.add(row.key);
    }
    // #2562: the current milestone is DECLARED but nothing attributes a phase to
    // it yet — the window right after `/gsd-new-milestone`, where STATE.md's
    // `milestone:` field updates the moment the heading lands but the Progress
    // table and phase sections have not caught up.
    //
    // Treating that as "unscoped" was a hole in the original fix: scoping switched
    // off entirely and the fallback below counted the project's ENTIRE phase
    // history as both numerator and denominator, so a workstream whose current
    // milestone had zero phases done reported 100% off its predecessors' work.
    // That is the very symptom #2562 reports, reached by a different route.
    //
    // Three independent signals witness it; ANY of them is enough, and each covers
    // a ROADMAP shape the others miss:
    //   - `versionSectionFound` — the milestone's own section exists but declares
    //     no phases (heading-only ROADMAPs, and the common `## v3.0` stub).
    //   - `missingExplicitVersion` — the ROADMAP versions its milestones but has
    //     no section for this one at all.
    //   - a Progress table that attributes every row elsewhere (`claimedElsewhere`
    //     non-empty while `currentMilestoneKeys` is empty).
    // A ROADMAP that attributes NO versions anywhere matches none of them: its
    // rows parse with `version: null`, land in `currentMilestoneKeys`, and never
    // reach here. That is deliberate — for a free-form legacy project the
    // whole-roadmap count IS the current milestone, and `readCurrentMilestoneVersion`
    // hands back a non-null version for almost every project, so keying off
    // `currentVersion` alone would regress every one of them to 0%.
    const currentMilestoneDeclaredEmpty = currentVersion !== null &&
        currentMilestoneKeys.size === 0 &&
        !headingScoped &&
        (headingFilter.versionSectionFound || headingFilter.missingExplicitVersion || claimedElsewhere.size > 0);
    // A dir-only phase joins the current milestone when the roadmap names it, or
    // when it is a sub-phase (`30.1-…`) of a phase the roadmap names — sub-phases
    // inserted mid-milestone rarely get a row of their own. Membership feeds BOTH
    // the numerator and (via `milestoneKeys` below) the denominator, so a member
    // can never exceed the denominator that counts it.
    const scoped = currentMilestoneKeys.size > 0 || headingScoped || currentMilestoneDeclaredEmpty;
    const isDirInCurrentMilestone = (dir) => {
        if (!scoped)
            return true;
        const key = phaseKeyFromDir(dir, undefined, directoryContext);
        if (currentMilestoneKeys.has(key))
            return true;
        const parent = parentPhaseKey(key);
        if (parent !== null && currentMilestoneKeys.has(parent))
            return true;
        // An empty current milestone has no roadmap declarations to match against,
        // so membership inverts: a directory belongs UNLESS another milestone claims
        // it. A phase scaffolded before the roadmap caught up would otherwise vanish
        // from both sides of the rollup — under-reporting, the direction this
        // codebase never degrades in.
        if (currentMilestoneDeclaredEmpty) {
            const parentKey = parentPhaseKey(key);
            return !claimedElsewhere.has(key) && (parentKey === null || !claimedElsewhere.has(parentKey));
        }
        return headingScoped && headingFilter(dir);
    };
    // Collect per-phase file counts (+ canonical key, milestone membership,
    // verification verdict). `phaseKey` lets the builder de-duplicate stale
    // same-numbered directories (Bug #2445's scenario) in the rollup.
    //
    // #2645 review: built from `[...phaseDirNames].sort()`, NOT the raw
    // `phaseDirNames` (unsorted `readdirSync` order — `readSubdirectories`'s
    // default). `buildWorkstreamInventory`'s own de-dup (`rollupDirByKey`,
    // workstream-inventory-builder.cts) iterates the SAME sorted order; the
    // ledger-winner tie-break below (incumbent wins unless a later entry has a
    // STRICTLY newer mtime) only agrees with the builder's winner on an exact
    // mtime tie if both walk entries in the same order. Iterating unsorted
    // input here let the two independently pick different "winning"
    // directories for one phase key on a tie — reopening the stale-duplicate-
    // clobbers-live-verdict hole criterion 4 exists to close.
    const rawPhaseEntries = [...phaseDirNames].sort().map(dir => {
        const phaseDir = node_path_1.default.join(p.phases, dir);
        const counts = countPhaseFiles(phaseDir);
        // ADR-3180 §7.4 (#3186): routed through the single canonical owner
        // (`isPhaseComplete`, src/verification.cts) instead of calling
        // `readVerificationStatus` directly and re-deriving "is this phase
        // complete" locally from its `.status`. `completionResult.value.complete`
        // is threaded down to the builder below (as `PhaseFilesCount.complete`)
        // so `buildWorkstreamInventory` — a pure, I/O-free projection that
        // cannot call the owner itself — consumes the owner's verdict rather
        // than re-deriving a second one from summary/plan counts.
        const completionResult = isPhaseComplete(phaseDir);
        const verificationResult = completionResult.value.verification;
        // #3057 B3: routing is UNCHANGED — `liveVerificationStatus` below is still
        // `.status`, exactly as before, so the ledger/rollup logic that consumes
        // it is unaffected. This only makes an indeterminate staleness check
        // visible (stderr), matching cmdGitBaseBranch's own non-blocking
        // unverified-fallback diagnostic (#3057 B4) — the closest existing idiom,
        // since `WorkstreamInventory`'s aggregate return shape carries no
        // per-phase verification detail for this to attach to.
        if ('staleCheckIndeterminate' in verificationResult && verificationResult.staleCheckIndeterminate) {
            writeDiagnostic(`⚠ workstream-inventory: verification staleness check could not complete for phase directory '${dir}' in workstream '${name}' — routed as not-stale, but this was not actually verified. See #3057.\n`, { phaseDir: dir, reason: 'staleCheckIndeterminate' });
        }
        return {
            directory: dir,
            phaseKey: phaseKeyFromDir(dir, undefined, directoryContext),
            mtimeMs: phaseDirMtime(phaseDir),
            planCount: counts.planCount,
            summaryCount: counts.summaryCount,
            inMilestone: isDirInCurrentMilestone(dir),
            liveVerificationStatus: verificationResult.status,
            // #5118: the owner's out-of-set report error, carried to the check below.
            statusError: completionResult.value.statusError,
            // ADR-3180 §7.4 (#3186): the owner's verdict, read live off disk — never
            // ledger-adjusted (see the phaseFilesCounts map below; the ledger only
            // ever substitutes a 'missing' status with a remembered one, and under
            // disk-strict 'missing' is never complete, so there is nothing for the
            // ledger to override here).
            complete: completionResult.value.complete,
        };
    });
    // #5118 (no write before the error): this inspection WRITES the ledger
    // below, so a report whose `status` is outside the closed set fails it
    // first — the owner's own error thrown as-is (like `init *`, `phase *` and
    // `state *`), which the CLI entry seam projects once into its reason and
    // message; nothing persisted.
    const firstStatusError = rawPhaseEntries.find((entry) => entry.statusError)?.statusError;
    if (firstStatusError)
        throw firstStatusError;
    // #2645: only the directory Bug #2445's de-dup rollup would actually pick
    // for a phase key may read or write that key's ledger entry. Letting every
    // same-keyed directory (including a stale leftover) write would let a
    // stale duplicate's stale verdict clobber the live directory's remembered
    // one.
    //
    // #2645 review — CORRECTED: an earlier version of this comment claimed the
    // milestone-scoping exclusion (`scoped && entry.inMilestone === false`)
    // was safe to drop here as "out of scope", and hand-wrote a scoping-free
    // tie-break rule. That was a real bug, not a scope call: in a SCOPED
    // workstream, a stale OUT-of-milestone directory sharing a phase key with
    // the live IN-milestone one can have a newer mtime (plausible after a
    // checkout/rebase resets mtimes) and would then win THIS selection while
    // the builder's own `rollupDirByKey` — which DOES apply the scoping filter
    // — picks the live directory instead. `isLedgerWinner` would then be false
    // for the live directory, so deleting ITS `*-VERIFICATION.md` would never
    // consult the ledger and would reopen #2645's exact hole for the phase
    // that actually counts toward `completed_phases` — reachable with a plain
    // `rm`, no ledger tampering required. Fixed by calling the SAME shared
    // `pickRollupWinners` the builder's `rollupDirByKey` now also calls, with
    // the identical scoping filter, rather than a second hand-written copy.
    const ledgerWinnerByKey = (0, workstream_inventory_builder_cjs_1.pickRollupWinners)(rawPhaseEntries, (entry) => entry.phaseKey, (entry) => entry.mtimeMs, (entry) => !(scoped && entry.inMilestone === false));
    const ledgerRead = readVerificationLedger(wsDir);
    // Both `'corrupt'` and `'ok'` start from whatever entries could actually be
    // trusted (empty for `'corrupt'` — nothing in an unparseable file is
    // trusted) and get REPAIRED below by any real verdict this call observes;
    // only `'absent'` skips the ledger mechanism entirely (pre-adoption).
    const verificationLedger = ledgerRead.entries;
    let ledgerDirty = false;
    for (const winner of ledgerWinnerByKey.values()) {
        const live = winner.liveVerificationStatus;
        if (live === null || live === VERIFICATION_STATUS.MISSING)
            continue;
        if (verificationLedger[winner.phaseKey] !== live) {
            verificationLedger[winner.phaseKey] = live;
            ledgerDirty = true;
        }
    }
    // A `'corrupt'` read that observes no real verdict this call has nothing to
    // repair with — writing an empty `{}` would DESTROY whatever the corrupt
    // file's bytes might still hold (a human could recover it by hand; this
    // fix must not foreclose that). Only write when there is something real to
    // persist, exactly as for `'absent'`/`'ok'`.
    if (ledgerDirty)
        writeVerificationLedger(wsDir, verificationLedger);
    const phaseFilesCounts = rawPhaseEntries.map(entry => {
        const isLedgerWinner = ledgerWinnerByKey.get(entry.phaseKey) === entry;
        // A live `missing` on the ledger winner reads the remembered verdict when
        // there is one. #5118: the former `unrecorded` state ("adopted, never
        // recorded") is deleted — its only reader, phaseStatusFromFacts, treats it
        // exactly like `missing` (only `human_needed` changes the ladder, and under
        // disk-strict neither is ever complete), so it was a dead distinction.
        let verificationStatus = entry.liveVerificationStatus;
        if (entry.liveVerificationStatus === VERIFICATION_STATUS.MISSING && isLedgerWinner) {
            const remembered = verificationLedger[entry.phaseKey];
            if (remembered !== undefined)
                verificationStatus = remembered;
        }
        return {
            directory: entry.directory,
            phaseKey: entry.phaseKey,
            mtimeMs: entry.mtimeMs,
            planCount: entry.planCount,
            summaryCount: entry.summaryCount,
            inMilestone: entry.inMilestone,
            verificationStatus,
            complete: entry.complete,
        };
    });
    // The denominator is the union of what the roadmap DECLARES for the current
    // milestone (including never-scaffolded phases) and the keys of the member
    // directories (including dir-only sub-phases). One key space, so
    // `completed_phases <= denominator` holds by construction rather than by a
    // `Math.min` cap that hid the inconsistency.
    const milestoneKeys = new Set(currentMilestoneKeys);
    for (const entry of phaseFilesCounts) {
        if (entry.inMilestone)
            milestoneKeys.add(entry.phaseKey);
    }
    const currentMilestonePhaseCount = scoped
        ? Math.max(milestoneKeys.size, headingScoped ? headingFilter.phaseCount : 0)
        : 0;
    // Unscoped fallback: the denominator must STILL count phases the ROADMAP
    // declares in its Progress table but never scaffolded — the heading-only
    // count drops them, even when other headings exist. Union the declared rows
    // with the phase directories so neither source can silently shrink it.
    let fallbackPhaseCount = countRoadmapPhases(p.roadmap, phaseDirNames.length, cwd, name, currentVersion);
    if (!scoped && progressRows.length > 0) {
        const union = new Set(progressRows.map(row => row.key));
        for (const entry of phaseFilesCounts)
            union.add(entry.phaseKey);
        fallbackPhaseCount = union.size;
    }
    return (0, workstream_inventory_builder_cjs_1.buildWorkstreamInventory)({
        name,
        projectDir: cwd,
        workstreamDir: wsDir,
        phaseDirNames,
        activeWorkstreamName: activeWorkstreamName ?? '',
        phaseFilesCounts,
        roadmapPhaseCount: fallbackPhaseCount,
        currentMilestonePhaseCount,
        // Stated, not inferred from the count: a declared-but-empty current
        // milestone is legitimately scoped AND legitimately zero-phase, and the
        // builder cannot tell those apart from `currentMilestonePhaseCount` alone.
        milestoneScoped: scoped,
        stateProjection: readStateProjection(p.state),
        filesExist: {
            roadmap: node_fs_1.default.existsSync(p.roadmap),
            state: node_fs_1.default.existsSync(p.state),
            requirements: node_fs_1.default.existsSync(p.requirements),
        },
        milestoneShippedSignal: workstreamShippedSignal(p.roadmap, p.planning, currentVersion),
    });
}
function listWorkstreamInventories(cwd) {
    const wsRoot = workstreamsRoot(cwd);
    if (!node_fs_1.default.existsSync(wsRoot)) {
        return {
            mode: 'flat',
            active: null,
            workstreams: [],
            count: 0,
            message: 'No workstreams — operating in flat mode',
        };
    }
    const active = getActiveWorkstream(cwd);
    const entries = node_fs_1.default.readdirSync(wsRoot, { withFileTypes: true });
    const workstreams = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const inventory = inspectWorkstream(cwd, entry.name, { active });
        if (inventory)
            workstreams.push(inventory);
    }
    const ordered = sortWorkstreamInventories(workstreams, active);
    return {
        mode: 'workstream',
        active,
        workstreams: ordered,
        count: ordered.length,
    };
}
function getOtherActiveWorkstreamInventories(cwd, excludeWs) {
    return listWorkstreamInventories(cwd).workstreams
        .filter(inventory => inventory.name !== excludeWs)
        .filter(inventory => !(0, workstream_inventory_builder_cjs_1.isCompletedInventory)(inventory.status));
}
module.exports = {
    countPhaseFiles,
    countRoadmapPhases,
    getOtherActiveWorkstreamInventories,
    inspectWorkstream,
    isCompletedInventory: workstream_inventory_builder_cjs_1.isCompletedInventory,
    listWorkstreamInventories,
    readCurrentMilestoneVersion,
    sortWorkstreamInventories,
    workstreamsRoot,
};
