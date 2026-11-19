"use strict";
/**
 * Quick-Batch Core Primitives (#3675, part of epic #3344 / ADR-1239
 * "Quick-batch binding").
 *
 * Pure/state primitives and CLI-testable core operations for batching
 * several `/gsd:quick`-shaped tasks together: task-list parsing, collision-safe
 * quick-ID preallocation, `BATCH.json` schema/validation/resume, deterministic
 * dependency-DAG + file-overlap wave construction, and exactly-once STATE.md
 * completion. NO agent dispatch, NO worktree creation, NO user-facing command —
 * those are Phase 4 (#3676)'s job. This module only ADDS new call sites onto
 * four existing, unmodified primitives:
 *
 *   - `cmdInitQuick`'s quick-ID grammar (src/init.cts) — replicated here (NOT
 *     delegated to per-item, since that function's own 2-second granularity is
 *     not collision-safe under batch allocation; see `allocateQuickIds`).
 *   - `appendQuickTaskRow` (src/markdown-table.cts) — reused as-is, called at
 *     most once per quick id, gated by our own idempotency check (see
 *     `hasQuickTaskRow`) since the function itself carries no idempotency.
 *   - `withPlanningLock` (src/planning-workspace.cts) — reused as-is; every
 *     durable, cross-call collision-sensitive operation here
 *     (`createBatch`/`completeQuickItem`/`resumeBatch`) runs inside exactly
 *     ONE (never nested) `withPlanningLock` transaction.
 *   - `partitionByFileOverlap` (src/file-overlap-partitioner.cts, #3674) —
 *     reused as-is, called per dependency-DAG layer in `computeWaves`, over
 *     PRE-NORMALIZED `planned_files` (normalization happens at THIS module's
 *     boundary, never inside the Phase 2 helper — its own design lock).
 *
 * `BATCH.json` lives at `.planning/quick-batches/<batch-id>/BATCH.json` — a
 * SIBLING of `.planning/quick/`, never inside it, so `scanQuickTasks`
 * (src/audit.cts) never misreads a batch manifest as a broken quick task.
 *
 * ADR-457 build-at-publish: compiled by tsc to gsd-core/bin/lib/quick-batch.cjs.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const security_cjs_1 = require("./security.cjs");
const markdown_table_cjs_1 = require("./markdown-table.cjs");
const markdown_sectionizer_cjs_1 = require("./markdown-sectionizer.cjs");
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
const clock_cjs_1 = require("./clock.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planningWorkspace = require("./planning-workspace.cjs");
const { withPlanningLock, planningDir, planningRoot, planningPaths, quickDirFrom } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fileOverlapPartitioner = require("./file-overlap-partitioner.cjs");
const { partitionByFileOverlap } = fileOverlapPartitioner;
// ─── Quick-id grammar (replicated from cmdInitQuick, unchanged) ───────────────
const QUICK_ID_RE = /^\d{6}-[0-9a-z]{3}$/;
const MAX_TIME_BLOCK = 36 * 36 * 36 - 1; // 3-char base36 ceiling (46655)
function idFromDateAndBlock(dateStr, block) {
    return dateStr + '-' + block.toString(36).padStart(3, '0');
}
/** yyMMdd + starting time-block (floor(secondsSinceMidnight/2)) for `instant`. */
function dateAndStartBlock(instant) {
    const yy = String(instant.getFullYear()).slice(-2);
    const mm = String(instant.getMonth() + 1).padStart(2, '0');
    const dd = String(instant.getDate()).padStart(2, '0');
    const dateStr = yy + mm + dd;
    const secondsSinceMidnight = instant.getHours() * 3600 + instant.getMinutes() * 60 + instant.getSeconds();
    const startBlock = Math.floor(secondsSinceMidnight / 2);
    return { dateStr, startBlock };
}
/**
 * Generate `count` distinct `YYMMDD-xxx` ids starting at `startBlock`,
 * advancing past any id already in `used` (mutated in place with the newly
 * allocated ids too, so a second call sharing the same `used` set never
 * re-issues one of them). Throws if the day's block space is exhausted
 * (46656 ids/day — never reachable in practice, but a real fail-closed ceiling
 * rather than an infinite loop).
 */
function allocateIdsGivenUsed(dateStr, startBlock, count, used) {
    const result = [];
    let block = startBlock;
    while (result.length < count) {
        if (block > MAX_TIME_BLOCK) {
            throw new Error(`quick-batch: exhausted collision-free quick ids for ${dateStr} (advanced past block ${MAX_TIME_BLOCK})`);
        }
        const candidate = idFromDateAndBlock(dateStr, block);
        if (!used.has(candidate)) {
            used.add(candidate);
            result.push(candidate);
        }
        block++;
    }
    return result;
}
/** Existing quick ids already claimed on disk under `.planning/quick/`. */
function collectExistingQuickIds(quickDir) {
    const usedIds = new Set();
    let entries;
    try {
        entries = node_fs_1.default.readdirSync(quickDir);
    }
    catch {
        return usedIds;
    }
    for (const name of entries) {
        const m = /^(\d{6}-[0-9a-z]{3})(?:-|$)/.exec(name);
        if (m)
            usedIds.add(m[1]);
    }
    return usedIds;
}
/**
 * Existing quick ids (and batch ids) already claimed by SIBLING batches under
 * `.planning/quick-batches/*` — mutates `used` in place. This is what makes
 * two concurrent (lock-serialized) `createBatch` calls collision-free even
 * before either batch has dispatched any real `.planning/quick/<id>-<slug>`
 * directory (#3675 design lock row 8/15): the second call's allocation scan
 * sees the first call's already-PERSISTED `BATCH.json`, not just real
 * dispatched directories. A corrupt/unreadable sibling manifest is skipped,
 * never allowed to block a DIFFERENT batch's allocation.
 */
function collectExistingBatchQuickIds(cwd, used) {
    const batchesDir = node_path_1.default.join(planningDir(cwd), 'quick-batches');
    let entries;
    try {
        entries = node_fs_1.default.readdirSync(batchesDir);
    }
    catch {
        return;
    }
    for (const name of entries) {
        const manifestPath = node_path_1.default.join(batchesDir, name, 'BATCH.json');
        let raw;
        try {
            raw = node_fs_1.default.readFileSync(manifestPath, 'utf-8');
        }
        catch {
            continue;
        }
        const parsed = (0, security_cjs_1.safeJsonParse)(raw, { maxLength: 1048576, label: 'sibling BATCH.json' });
        if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object')
            continue;
        const obj = parsed.value;
        if (typeof obj.batch_id === 'string')
            used.add(obj.batch_id);
        if (Array.isArray(obj.items)) {
            for (const it of obj.items) {
                if (it && typeof it === 'object' && typeof it.quick_id === 'string') {
                    used.add(it.quick_id);
                }
            }
        }
    }
}
/**
 * Allocate `count` distinct, collision-free `YYMMDD-xxx` quick ids under
 * `withPlanningLock`, checked against on-disk `.planning/quick/` entries.
 *
 * NOTE: this primitive does NOT persist anything — it only reserves ids in
 * memory for the duration of one call. Cross-call collision-freedom (#3675
 * design lock row 8/15) is a property of `createBatch`, which allocates AND
 * durably writes `BATCH.json` inside the SAME lock transaction; two bare
 * `allocateQuickIds` calls with no intervening persistence can still overlap.
 * Exposed standalone for direct grammar-level testability (rows 7/13/14).
 */
function allocateQuickIds(cwd, count, options = {}) {
    if (!Number.isInteger(count) || count < 1) {
        return { ok: false, reason: `count must be a positive integer, got ${String(count)}` };
    }
    const clock = options.clock ?? clock_cjs_1.realClock;
    try {
        const ids = withPlanningLock(cwd, () => {
            const quickDir = quickDirFrom(planningDir(cwd));
            const used = collectExistingQuickIds(quickDir);
            collectExistingBatchQuickIds(cwd, used);
            const { dateStr, startBlock } = dateAndStartBlock(new Date(clock.now()));
            return allocateIdsGivenUsed(dateStr, startBlock, count, used);
        }, clock);
        return { ok: true, value: ids };
    }
    catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}
// ─── Task-list parsing ──────────────────────────────────────────────────────────
const BULLET_OR_NUMBER_RE = /^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/;
/**
 * Parse an inline bulleted (`-`/`*`) or numbered (`1.`/`1)`) task list.
 * Non-matching lines (blank lines, prose) are ignored. Order is preserved;
 * duplicate descriptions are preserved as distinct entries (never deduped).
 * Requires at least 2 items (#3675/#3344 AC minimum for a "batch").
 */
function parseTaskList(text) {
    if (typeof text !== 'string') {
        return { ok: false, reason: 'task list input must be a string' };
    }
    const items = [];
    for (const line of text.split(/\r?\n/)) {
        const m = BULLET_OR_NUMBER_RE.exec(line);
        if (m)
            items.push({ description: m[1] });
    }
    if (items.length < 2) {
        return { ok: false, reason: `quick-batch requires at least 2 explicit tasks, found ${items.length}` };
    }
    return { ok: true, value: items };
}
/**
 * Parse a task list from a file, strictly confined to the planning workspace
 * root (`.planning/`) — traversal, symlink escape, and non-regular-file
 * targets (directory, socket, device, FIFO) are all rejected.
 */
function parseTaskListFromFile(cwd, filePath) {
    const root = planningRoot(cwd);
    let safePath;
    try {
        safePath = (0, security_cjs_1.requireSafePath)(filePath, root, 'quick-batch --file', security_cjs_1.PathAcceptance.AbsoluteInsideRoot);
    }
    catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    let stat;
    try {
        stat = node_fs_1.default.statSync(safePath);
    }
    catch (err) {
        return { ok: false, reason: `unable to stat --file path: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!stat.isFile()) {
        return { ok: false, reason: `--file path is not a regular file: ${filePath}` };
    }
    let content;
    try {
        content = node_fs_1.default.readFileSync(safePath, 'utf-8');
    }
    catch (err) {
        return { ok: false, reason: `unable to read --file path: ${err instanceof Error ? err.message : String(err)}` };
    }
    return parseTaskList(content);
}
// ─── Dependency-DAG validation ──────────────────────────────────────────────────
function resolveDependencyIndex(ref, items) {
    if (typeof ref === 'number') {
        return Number.isInteger(ref) && ref >= 0 && ref < items.length ? ref : null;
    }
    if (typeof ref === 'string') {
        const idx = items.findIndex((it) => it.clientId === ref);
        return idx === -1 ? null : idx;
    }
    return null;
}
/**
 * Validate that every `dependsOn` reference resolves to another item WITHIN
 * this same input array (never an unknown/cross-batch reference), and that
 * the resulting dependency graph is acyclic. Fails closed before any wave is
 * built, per the #3675 design lock.
 */
function validateDag(items) {
    const adj = items.map(() => []);
    for (let i = 0; i < items.length; i++) {
        const deps = items[i].dependsOn ?? [];
        for (const ref of deps) {
            const idx = resolveDependencyIndex(ref, items);
            if (idx === null) {
                return { ok: false, reason: `item ${i} (${items[i].description}) declares an unknown dependency reference: ${JSON.stringify(ref)}` };
            }
            if (idx === i) {
                return { ok: false, reason: `item ${i} (${items[i].description}) declares a dependency on itself` };
            }
            adj[i].push(idx);
        }
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Array(items.length).fill(WHITE);
    const stack = [];
    let cycleDiagnostic = null;
    const dfs = (u) => {
        color[u] = GRAY;
        stack.push(u);
        for (const v of adj[u]) {
            if (color[v] === GRAY) {
                const idx = stack.indexOf(v);
                cycleDiagnostic = `dependency cycle detected: ${stack.slice(idx).concat(v).join(' -> ')}`;
                return true;
            }
            if (color[v] === WHITE && dfs(v))
                return true;
        }
        stack.pop();
        color[u] = BLACK;
        return false;
    };
    for (let i = 0; i < items.length; i++) {
        if (color[i] === WHITE && dfs(i)) {
            return { ok: false, reason: cycleDiagnostic ?? 'dependency cycle detected' };
        }
    }
    return { ok: true, value: adj };
}
/** Reshape persisted `QuickBatchItem`s into `computeWaves`' input shape. */
function toWaveInput(items) {
    return items.map((it) => ({ quickId: it.quick_id, dependsOn: it.depends_on, plannedFiles: it.planned_files }));
}
/**
 * Deterministic wave construction: an item's wave is strictly after every one
 * of its dependencies' waves (DAG readiness), and no two items in the same
 * wave share a (normalized) file — reusing `partitionByFileOverlap` per
 * dependency-DAG layer, over path-separator-normalized `plannedFiles`
 * (normalization happens HERE, never inside `partitionByFileOverlap` itself,
 * per Phase 2's own design lock). Same input order always yields the same
 * waves. Fails closed on an unknown dependency or a cycle.
 */
function computeWaves(items) {
    const byId = new Map(items.map((it) => [it.quickId, it]));
    for (const it of items) {
        for (const dep of it.dependsOn) {
            if (!byId.has(dep)) {
                return { ok: false, reason: `item ${it.quickId} depends on unknown item ${dep}` };
            }
        }
    }
    const layer = new Map();
    const state = new Map();
    let cycleDiagnostic = null;
    const visit = (id, pathStack) => {
        const st = state.get(id) ?? 0;
        if (st === 1) {
            const idx = pathStack.indexOf(id);
            cycleDiagnostic = `dependency cycle detected: ${pathStack.slice(idx).concat(id).join(' -> ')}`;
            return -1;
        }
        if (st === 2)
            return layer.get(id);
        state.set(id, 1);
        const it = byId.get(id);
        let maxDepLayer = -1;
        for (const dep of it.dependsOn) {
            const depLayer = visit(dep, [...pathStack, id]);
            if (depLayer === -1)
                return -1;
            if (depLayer > maxDepLayer)
                maxDepLayer = depLayer;
        }
        const l = maxDepLayer + 1;
        layer.set(id, l);
        state.set(id, 2);
        return l;
    };
    for (const it of items) {
        if (visit(it.quickId, []) === -1) {
            return { ok: false, reason: cycleDiagnostic ?? 'dependency cycle detected' };
        }
    }
    const maxLayer = items.length ? Math.max(...items.map((it) => layer.get(it.quickId))) : -1;
    const waves = [];
    for (let l = 0; l <= maxLayer; l++) {
        const layerItems = items.filter((it) => layer.get(it.quickId) === l);
        const overlapInput = layerItems.map((it) => ({
            id: it.quickId,
            files: it.plannedFiles.map(shell_command_projection_cjs_1.posixNormalize),
        }));
        const stages = partitionByFileOverlap(overlapInput);
        for (const stage of stages)
            waves.push(stage);
    }
    return { ok: true, value: waves };
}
// ─── BATCH.json creation ────────────────────────────────────────────────────────
function batchManifestPath(cwd, batchId) {
    return node_path_1.default.join(planningDir(cwd), 'quick-batches', batchId, 'BATCH.json');
}
/**
 * Create a new quick-batch: validates the dependency DAG, allocates N+1
 * collision-free quick ids (one for the batch itself, one per item) and
 * durably writes `BATCH.json` — all inside ONE `withPlanningLock` transaction,
 * so concurrent `createBatch` calls can never collide (#3675 design lock).
 * `BATCH.json` lives at `.planning/quick-batches/<batch-id>/BATCH.json`, a
 * SIBLING of `.planning/quick/` — never inside it (scanQuickTasks safety).
 */
function createBatch(cwd, itemsInput, options = {}) {
    if (!Array.isArray(itemsInput) || itemsInput.length === 0) {
        return { ok: false, reason: 'createBatch requires at least one item' };
    }
    const dagResult = validateDag(itemsInput);
    if (!dagResult.ok)
        return dagResult;
    const clock = options.clock ?? clock_cjs_1.realClock;
    try {
        return withPlanningLock(cwd, () => {
            const quickDir = quickDirFrom(planningDir(cwd));
            const used = collectExistingQuickIds(quickDir);
            collectExistingBatchQuickIds(cwd, used);
            const { dateStr, startBlock } = dateAndStartBlock(new Date(clock.now()));
            const allocated = allocateIdsGivenUsed(dateStr, startBlock, itemsInput.length + 1, used);
            const batchId = allocated[0];
            const quickIds = allocated.slice(1);
            const items = itemsInput.map((input, i) => ({
                quick_id: quickIds[i],
                client_id: input.clientId ?? null,
                description: input.description,
                status: 'pending',
                depends_on: (input.dependsOn ?? []).map((ref) => {
                    const idx = resolveDependencyIndex(ref, itemsInput);
                    return quickIds[idx];
                }),
                planned_files: (input.plannedFiles ?? []).map(shell_command_projection_cjs_1.posixNormalize),
                directory: input.directory ?? null,
                worktree: input.worktree ?? null,
                dispatched_worktree: input.dispatchedWorktree ?? null,
                dispatched_branch: input.dispatchedBranch ?? null,
                dispatched_base: input.dispatchedBase ?? null,
                wave: -1,
                commit: null,
                failure_reason: null,
            }));
            const wavesResult = computeWaves(toWaveInput(items));
            if (!wavesResult.ok)
                return wavesResult;
            const waveOf = new Map();
            wavesResult.value.forEach((wave, idx) => {
                for (const quickId of wave)
                    waveOf.set(quickId, idx);
            });
            for (const it of items)
                it.wave = waveOf.get(it.quick_id);
            const manifest = {
                schema_version: 1,
                batch_id: batchId,
                created_at: clock.nowIso(),
                options: options.batchOptions ?? {},
                base_revision: options.baseRevision ?? null,
                head_revision: null,
                items,
            };
            const manifestPath = batchManifestPath(cwd, batchId);
            (0, shell_command_projection_cjs_1.platformWriteSync)(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
            return { ok: true, value: { batchId, manifestPath, manifest } };
        }, clock);
    }
    catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}
// ─── BATCH.json loading + schema validation ─────────────────────────────────────
const VALID_STATUSES = new Set(['pending', 'complete', 'failed', 'blocked']);
const SAFE_BATCH_ID_RE = /^[0-9a-zA-Z-]+$/;
function validateBatchSchema(parsed, batchId) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: `BATCH.json for batch ${batchId} is not a JSON object` };
    }
    const obj = parsed;
    if (obj.schema_version !== 1) {
        return { ok: false, reason: `BATCH.json for batch ${batchId} has an unsupported or missing schema_version` };
    }
    if (typeof obj.batch_id !== 'string' || obj.batch_id !== batchId) {
        return { ok: false, reason: `BATCH.json for batch ${batchId} has a mismatched or missing batch_id` };
    }
    if (typeof obj.created_at !== 'string') {
        return { ok: false, reason: `BATCH.json for batch ${batchId} is missing created_at` };
    }
    if (obj.options !== undefined && (typeof obj.options !== 'object' || obj.options === null || Array.isArray(obj.options))) {
        return { ok: false, reason: `BATCH.json for batch ${batchId} has an invalid options field` };
    }
    const optionsValue = obj.options ?? {};
    if (obj.base_revision !== null && obj.base_revision !== undefined && typeof obj.base_revision !== 'string') {
        return { ok: false, reason: `BATCH.json for batch ${batchId} has an invalid base_revision field` };
    }
    const baseRevisionValue = typeof obj.base_revision === 'string' ? obj.base_revision : null;
    // #6203: optional; a manifest written before the field existed has none.
    if (obj.head_revision !== null && obj.head_revision !== undefined && typeof obj.head_revision !== 'string') {
        return { ok: false, reason: `BATCH.json for batch ${batchId} has an invalid head_revision field` };
    }
    const headRevisionValue = typeof obj.head_revision === 'string' ? obj.head_revision : null;
    if (!Array.isArray(obj.items) || obj.items.length === 0) {
        return { ok: false, reason: `BATCH.json for batch ${batchId} has no items` };
    }
    const items = [];
    const seenIds = new Set();
    for (const raw of obj.items) {
        if (!raw || typeof raw !== 'object') {
            return { ok: false, reason: `BATCH.json for batch ${batchId} has a malformed item` };
        }
        const it = raw;
        if (typeof it.quick_id !== 'string' || !QUICK_ID_RE.test(it.quick_id)) {
            return { ok: false, reason: `BATCH.json for batch ${batchId} has an item with an invalid quick_id` };
        }
        if (seenIds.has(it.quick_id)) {
            return { ok: false, reason: `BATCH.json for batch ${batchId} has a duplicate quick_id: ${it.quick_id}` };
        }
        seenIds.add(it.quick_id);
        if (typeof it.description !== 'string') {
            return { ok: false, reason: `item ${it.quick_id} is missing description` };
        }
        if (typeof it.status !== 'string' || !VALID_STATUSES.has(it.status)) {
            return { ok: false, reason: `item ${it.quick_id} has an invalid or missing status` };
        }
        if (!Array.isArray(it.depends_on) || !it.depends_on.every((d) => typeof d === 'string')) {
            return { ok: false, reason: `item ${it.quick_id} has a malformed depends_on` };
        }
        if (!Array.isArray(it.planned_files) || !it.planned_files.every((f) => typeof f === 'string')) {
            return { ok: false, reason: `item ${it.quick_id} has a malformed planned_files` };
        }
        if (it.directory !== null && it.directory !== undefined && typeof it.directory !== 'string') {
            return { ok: false, reason: `item ${it.quick_id} has an invalid directory field` };
        }
        if (it.worktree !== null && it.worktree !== undefined && typeof it.worktree !== 'string') {
            return { ok: false, reason: `item ${it.quick_id} has an invalid worktree field` };
        }
        if (typeof it.worktree === 'string' && it.worktree !== '' && !node_fs_1.default.existsSync(it.worktree)) {
            return { ok: false, reason: `item ${it.quick_id} references a worktree that does not exist on disk: ${it.worktree}` };
        }
        // #3677: dispatched_worktree/branch/base deliberately carry NO
        // existence check (unlike `worktree` above) — they must stay readable
        // after a legitimate post-merge worktree removal.
        if (it.dispatched_worktree !== null && it.dispatched_worktree !== undefined && typeof it.dispatched_worktree !== 'string') {
            return { ok: false, reason: `item ${it.quick_id} has an invalid dispatched_worktree field` };
        }
        if (it.dispatched_branch !== null && it.dispatched_branch !== undefined && typeof it.dispatched_branch !== 'string') {
            return { ok: false, reason: `item ${it.quick_id} has an invalid dispatched_branch field` };
        }
        if (it.dispatched_base !== null && it.dispatched_base !== undefined && typeof it.dispatched_base !== 'string') {
            return { ok: false, reason: `item ${it.quick_id} has an invalid dispatched_base field` };
        }
        if (it.wave !== undefined && (typeof it.wave !== 'number' || !Number.isInteger(it.wave) || it.wave < 0)) {
            return { ok: false, reason: `item ${it.quick_id} has an invalid wave field` };
        }
        if (it.commit !== null && it.commit !== undefined && typeof it.commit !== 'string') {
            return { ok: false, reason: `item ${it.quick_id} has an invalid commit field` };
        }
        if (it.failure_reason !== null && it.failure_reason !== undefined && typeof it.failure_reason !== 'string') {
            return { ok: false, reason: `item ${it.quick_id} has an invalid failure_reason field` };
        }
        items.push({
            quick_id: it.quick_id,
            client_id: typeof it.client_id === 'string' ? it.client_id : null,
            description: it.description,
            status: it.status,
            depends_on: it.depends_on,
            planned_files: it.planned_files,
            directory: typeof it.directory === 'string' ? it.directory : null,
            worktree: typeof it.worktree === 'string' ? it.worktree : null,
            dispatched_worktree: typeof it.dispatched_worktree === 'string' ? it.dispatched_worktree : null,
            dispatched_branch: typeof it.dispatched_branch === 'string' ? it.dispatched_branch : null,
            dispatched_base: typeof it.dispatched_base === 'string' ? it.dispatched_base : null,
            wave: typeof it.wave === 'number' ? it.wave : -1,
            commit: typeof it.commit === 'string' ? it.commit : null,
            failure_reason: typeof it.failure_reason === 'string' ? it.failure_reason : null,
        });
    }
    for (const it of items) {
        for (const dep of it.depends_on) {
            if (!seenIds.has(dep)) {
                return { ok: false, reason: `item ${it.quick_id} depends on ${dep}, which is not present in this batch` };
            }
        }
    }
    const cycleCheck = computeWaves(toWaveInput(items));
    if (!cycleCheck.ok)
        return cycleCheck;
    return {
        ok: true,
        value: {
            schema_version: 1,
            batch_id: batchId,
            created_at: obj.created_at,
            options: optionsValue,
            base_revision: baseRevisionValue,
            head_revision: headRevisionValue,
            items,
        },
    };
}
/**
 * Load and schema-validate `BATCH.json` for `batchId`. Fails closed —
 * never guesses partial state — on: missing file, corrupt/truncated JSON,
 * a schema violation, an out-of-batch dependency reference, a dependency
 * cycle, or an item referencing a worktree path absent from disk.
 */
function loadBatch(cwd, batchId) {
    if (typeof batchId !== 'string' || batchId === '' || !SAFE_BATCH_ID_RE.test(batchId)) {
        return { ok: false, reason: `invalid batch id: ${String(batchId)}` };
    }
    const manifestPath = batchManifestPath(cwd, batchId);
    let raw;
    try {
        raw = node_fs_1.default.readFileSync(manifestPath, 'utf-8');
    }
    catch (err) {
        const e = err;
        return {
            ok: false,
            reason: e.code === 'ENOENT'
                ? `no BATCH.json found for batch ${batchId}`
                : `unable to read BATCH.json for batch ${batchId}: ${e.message}`,
        };
    }
    const parsed = (0, security_cjs_1.safeJsonParse)(raw, { maxLength: 1048576 });
    if (!parsed.ok) {
        return { ok: false, reason: `BATCH.json for batch ${batchId} is not valid JSON: ${parsed.error ?? 'unknown parse error'}` };
    }
    return validateBatchSchema(parsed.value, batchId);
}
// ─── Exactly-once STATE.md completion ───────────────────────────────────────────
const QUICK_TASKS_HEADING_RE = /^quick tasks completed\b/i;
/**
 * Idempotency check backing exactly-once STATE completion: does a "Quick
 * Tasks Completed" table row already carry this `quickId` in its `#` column?
 * Mirrors `appendQuickTaskRow`'s own section/table resolution (heading match
 * -> parseMarkdownTable -> matchTableSchema) without modifying it, so the two
 * can never silently diverge on what counts as "the" Quick Tasks table.
 */
function hasQuickTaskRow(stateContent, quickId) {
    if (!stateContent)
        return false;
    const sections = (0, markdown_sectionizer_cjs_1.collectSections)(stateContent, (h) => QUICK_TASKS_HEADING_RE.test(h.text.trim()));
    for (const section of sections) {
        const parsed = (0, markdown_table_cjs_1.parseMarkdownTable)(section.body);
        if (!parsed.ok)
            continue;
        const match = (0, markdown_table_cjs_1.matchTableSchema)(parsed.value.columns);
        if (!match || match.id !== 'QuickTasks')
            continue;
        for (const row of parsed.value.rows) {
            if (row['#'] === quickId)
                return true;
        }
    }
    return false;
}
/**
 * Mark one batch item complete: appends exactly one STATE.md "Quick Tasks
 * Completed" row (idempotency key = `quickId`, checked via `hasQuickTaskRow`
 * BEFORE calling `appendQuickTaskRow` — that function itself has no
 * idempotency of its own), then marks the item `complete` in `BATCH.json`.
 * Both steps run inside ONE `withPlanningLock` transaction. A repeat call for
 * an already-complete item is a no-op (no re-append, no re-write).
 *
 * `warnings` passes through `appendQuickTaskRow`'s advisory warnings (#5830:
 * a description over `QUICK_TASK_DESCRIPTION_MAX_CHARS` is written in full
 * but reported), so the `quick-batch complete` JSON carries them the same way
 * `quick-tasks-append`'s does. Empty when no row was appended.
 */
function completeQuickItem(cwd, batchId, quickId, fields, options = {}) {
    const clock = options.clock ?? clock_cjs_1.realClock;
    try {
        return withPlanningLock(cwd, () => {
            const loaded = loadBatch(cwd, batchId);
            if (!loaded.ok)
                return loaded;
            const manifest = loaded.value;
            const item = manifest.items.find((it) => it.quick_id === quickId);
            if (!item)
                return { ok: false, reason: `batch ${batchId} has no item ${quickId}` };
            const statePath = planningPaths(cwd).state;
            const stateContent = node_fs_1.default.existsSync(statePath) ? node_fs_1.default.readFileSync(statePath, 'utf-8') : '';
            let appended = false;
            let warnings = [];
            if (!hasQuickTaskRow(stateContent, quickId)) {
                const appendResult = (0, markdown_table_cjs_1.appendQuickTaskRow)(stateContent, {
                    description: fields.description,
                    date: fields.date,
                    commit: fields.commit,
                    directory: fields.directory,
                    quickId,
                });
                if (!appendResult.ok)
                    return appendResult;
                (0, shell_command_projection_cjs_1.platformWriteSync)(statePath, appendResult.value.content);
                appended = true;
                warnings = appendResult.value.warnings;
            }
            if (item.status !== 'complete') {
                item.status = 'complete';
                item.commit = fields.commit;
                (0, shell_command_projection_cjs_1.platformWriteSync)(batchManifestPath(cwd, batchId), JSON.stringify(manifest, null, 2) + '\n');
            }
            return { ok: true, value: { appended, manifest, warnings } };
        }, clock);
    }
    catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}
/**
 * Persist post-planning `depends_on`/`planned_files` updates and recompute
 * `wave` for every item (Phase 4 / #3676, resolving design doc Open
 * Question 1's "no mutator exists" gap as ONE additive export on this
 * module — never a second, independent writer against the same
 * `BATCH.json`). Runs inside ONE `withPlanningLock` transaction, reusing
 * the exact `loadBatch` -> mutate -> `computeWaves` -> `platformWriteSync`
 * shape `resumeBatch`/`completeQuickItem` already use.
 *
 * Fails closed WITHOUT persisting anything when an update references an
 * unknown `quickId`, an unknown/self dependency, or the resulting graph has
 * a cycle — `computeWaves` (reused, not duplicated) is the single source of
 * truth for that validation, exactly as it is at `createBatch` time.
 */
function updateBatchItems(cwd, batchId, updates, options = {}) {
    const clock = options.clock ?? clock_cjs_1.realClock;
    try {
        return withPlanningLock(cwd, () => {
            const loaded = loadBatch(cwd, batchId);
            if (!loaded.ok)
                return loaded;
            const manifest = loaded.value;
            const byId = new Map(manifest.items.map((it) => [it.quick_id, it]));
            // #6203: the batch records the HEAD it left behind after each of its own
            // HEAD-moving steps; `resumeBatch` compares the live HEAD to it. An opaque
            // identifier this module never interprets (same as `commit`); `undefined`
            // leaves the recorded value untouched.
            if (options.headRevision !== undefined) {
                manifest.head_revision = options.headRevision;
            }
            for (const update of updates) {
                const item = byId.get(update.quickId);
                if (!item) {
                    return { ok: false, reason: `batch ${batchId} has no item ${update.quickId}` };
                }
                if (update.dependsOn !== undefined) {
                    for (const dep of update.dependsOn) {
                        if (dep === update.quickId) {
                            return { ok: false, reason: `item ${update.quickId} declares a dependency on itself` };
                        }
                        if (!byId.has(dep)) {
                            return { ok: false, reason: `item ${update.quickId} declares an unknown dependency reference: ${JSON.stringify(dep)}` };
                        }
                    }
                    item.depends_on = [...update.dependsOn];
                }
                if (update.plannedFiles !== undefined) {
                    item.planned_files = update.plannedFiles.map(shell_command_projection_cjs_1.posixNormalize);
                }
                // #3677: durable worktree-recovery fields — persisted verbatim, no
                // existence/shape validation (opaque identifiers this module never
                // interprets, same as `commit`). Explicit `null` clears a field
                // (post-merge); `undefined` leaves it untouched, same convention
                // `dependsOn`/`plannedFiles` above already use.
                if (update.dispatchedWorktree !== undefined) {
                    item.dispatched_worktree = update.dispatchedWorktree;
                }
                if (update.dispatchedBranch !== undefined) {
                    item.dispatched_branch = update.dispatchedBranch;
                }
                if (update.dispatchedBase !== undefined) {
                    item.dispatched_base = update.dispatchedBase;
                }
            }
            const wavesResult = computeWaves(toWaveInput(manifest.items));
            if (!wavesResult.ok)
                return wavesResult;
            const waveOf = new Map();
            wavesResult.value.forEach((wave, idx) => {
                for (const quickId of wave)
                    waveOf.set(quickId, idx);
            });
            for (const it of manifest.items)
                it.wave = waveOf.get(it.quick_id);
            (0, shell_command_projection_cjs_1.platformWriteSync)(batchManifestPath(cwd, batchId), JSON.stringify(manifest, null, 2) + '\n');
            return { ok: true, value: { manifest } };
        }, clock);
    }
    catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}
/**
 * Resume a batch: skips `complete` items, leaves `failed` items failed (no
 * auto-retry), leaves `blocked` items blocked unless their dependency's
 * outcome changed, and — crash-window safety — detects a STATE.md row that
 * already exists (by `quickId`, via `hasQuickTaskRow`) for a non-complete
 * item and marks it complete WITHOUT re-appending (the "STATE row written,
 * BATCH.json not yet updated" crash window). Idempotent: two calls in a row
 * on an unchanged manifest produce zero transitions the second time.
 *
 * Runs inside `withPlanningLock` — the same durable read-modify-write
 * `BATCH.json` uses — so a resume racing a concurrent `completeQuickItem` (or
 * another resume) can never lose an update.
 *
 * When `options.currentBaseRevision` is supplied and the manifest carries a
 * non-null `base_revision`, resume refuses with a recoverable diagnostic when
 * the live HEAD differs from the HEAD the batch expects: the last revision it
 * recorded for itself (`head_revision`, #6203) or, when it recorded none, the
 * one it was created against. It does not guess past the divergence (ADR-1239
 * "Quick-batch binding" § Base divergence). Reconciling the divergence — a
 * rebase, a fresh batch — is a caller (Phase 4) decision; this primitive only
 * detects and reports it. Omit the option to skip the check entirely.
 */
function resumeBatch(cwd, batchId, options = {}) {
    const clock = options.clock ?? clock_cjs_1.realClock;
    try {
        return withPlanningLock(cwd, () => {
            const loaded = loadBatch(cwd, batchId);
            if (!loaded.ok)
                return loaded;
            const manifest = loaded.value;
            // #6203: the HEAD the batch expects is the last one it recorded for itself
            // (after an executor commit, a wave merge or its final docs commit), else
            // the one it was created against. The batch's own commits therefore do not
            // read as divergence; a HEAD moved by anything the batch did not record
            // still does.
            const expectedRevision = manifest.head_revision ?? manifest.base_revision;
            if (options.currentBaseRevision !== undefined
                && manifest.base_revision !== null
                && expectedRevision !== options.currentBaseRevision) {
                return {
                    ok: false,
                    reason: `batch ${batchId} base revision diverged: created against ${manifest.base_revision}, `
                        + (manifest.head_revision !== null ? `last recorded batch head is ${manifest.head_revision}, ` : '')
                        + `current is ${options.currentBaseRevision}. `
                        + `If the commits since then are this batch's own (a step was interrupted before it recorded its head), `
                        + `record the current head with \`quick-batch update --batch ${batchId} --head-revision ${options.currentBaseRevision}\` and resume again; `
                        + `otherwise start a fresh batch.`,
                };
            }
            const statePath = planningPaths(cwd).state;
            const stateContent = node_fs_1.default.existsSync(statePath) ? node_fs_1.default.readFileSync(statePath, 'utf-8') : '';
            const transitions = [];
            const byId = new Map(manifest.items.map((it) => [it.quick_id, it]));
            // Crash-window detection: a non-complete item whose STATE row already
            // exists is completed without re-appending.
            for (const it of manifest.items) {
                if (it.status !== 'complete' && hasQuickTaskRow(stateContent, it.quick_id)) {
                    transitions.push({ quickId: it.quick_id, from: it.status, to: 'complete' });
                    it.status = 'complete';
                }
            }
            // Propagate blocked/failed along the DAG to a fixed point (bounded by
            // item count) so transitive blocking resolves in one resume call. A
            // `blocked` item whose dependency outcome improved reverts to `pending`
            // (eligible for re-evaluation); a `failed` item is never touched (no
            // auto-retry).
            let changed = true;
            let iterations = 0;
            while (changed && iterations <= manifest.items.length) {
                changed = false;
                iterations++;
                for (const it of manifest.items) {
                    if (it.status === 'complete' || it.status === 'failed')
                        continue;
                    const anyDepBad = it.depends_on.some((d) => {
                        const dep = byId.get(d);
                        return dep !== undefined && (dep.status === 'failed' || dep.status === 'blocked');
                    });
                    const nextStatus = anyDepBad ? 'blocked' : (it.status === 'blocked' ? 'pending' : it.status);
                    if (nextStatus !== it.status) {
                        transitions.push({ quickId: it.quick_id, from: it.status, to: nextStatus });
                        it.status = nextStatus;
                        changed = true;
                    }
                }
            }
            const eligible = manifest.items
                .filter((it) => it.status === 'pending' && it.depends_on.every((d) => byId.get(d)?.status === 'complete'))
                .map((it) => it.quick_id);
            if (transitions.length > 0) {
                (0, shell_command_projection_cjs_1.platformWriteSync)(batchManifestPath(cwd, batchId), JSON.stringify(manifest, null, 2) + '\n');
            }
            return { ok: true, value: { eligible, transitions, manifest } };
        }, clock);
    }
    catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}
module.exports = {
    parseTaskList,
    parseTaskListFromFile,
    allocateQuickIds,
    allocateIdsGivenUsed,
    MAX_TIME_BLOCK,
    createBatch,
    loadBatch,
    computeWaves,
    resumeBatch,
    completeQuickItem,
    hasQuickTaskRow,
    updateBatchItems,
};
