"use strict";
/**
 * Workstream — CRUD operations for workstream namespacing
 *
 * Workstreams enable parallel milestones by scoping ROADMAP.md, STATE.md,
 * REQUIREMENTS.md, and phases/ into .planning/workstreams/{name}/ directories.
 *
 * When no workstreams/ directory exists, GSD operates in "flat mode" with
 * everything at .planning/ — backward compatible with pre-workstream installs.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/workstream.cjs collapsed
 * to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only strict types are added.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const clock_cjs_1 = require("./clock.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const io = require("./io.cjs");
const { output, error } = io;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const coreUtils = require("./core-utils.cjs");
const { toPosixPath, generateSlugInternal } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const roadmapParser = require("./roadmap-parser.cjs");
const { getMilestoneInfo } = roadmapParser;
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planningWorkspace = require("./planning-workspace.cjs");
const { planningRoot, setActiveWorkstream, getActiveWorkstream } = planningWorkspace;
const workstream_name_policy_cjs_1 = require("./workstream-name-policy.cjs");
const runtime_slash_cjs_1 = require("./runtime-slash.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const workstreamInventory = require("./workstream-inventory.cjs");
const { getOtherActiveWorkstreamInventories, inspectWorkstream, listWorkstreamInventories, } = workstreamInventory;
// ─── Migration ───────────────────────────────────────────────────────────────
/**
 * Migrate flat .planning/ layout to workstream mode.
 * Moves per-workstream files (ROADMAP.md, STATE.md, REQUIREMENTS.md, phases/)
 * into .planning/workstreams/{name}/. Shared files (PROJECT.md, config.json,
 * milestones/, research/, codebase/, todos/) stay in place.
 */
function migrateToWorkstreams(cwd, workstreamName) {
    try {
        (0, workstream_name_policy_cjs_1.assertValidActiveWorkstreamName)(workstreamName, 'Invalid workstream name for migration');
    }
    catch {
        throw new Error('Invalid workstream name for migration');
    }
    if ((0, workstream_name_policy_cjs_1.isReservedWorkstreamName)(workstreamName)) {
        throw new Error((0, workstream_name_policy_cjs_1.reservedWorkstreamNameMessage)(workstreamName));
    }
    const baseDir = planningRoot(cwd);
    const wsDir = node_path_1.default.join(baseDir, 'workstreams', workstreamName);
    if (node_fs_1.default.existsSync(node_path_1.default.join(baseDir, 'workstreams'))) {
        throw new Error('Already in workstream mode — .planning/workstreams/ exists');
    }
    const toMove = [
        { name: 'ROADMAP.md', type: 'file' },
        { name: 'STATE.md', type: 'file' },
        { name: 'REQUIREMENTS.md', type: 'file' },
        { name: 'phases', type: 'dir' },
    ];
    (0, shell_command_projection_cjs_1.platformEnsureDir)(wsDir);
    const filesMoved = [];
    try {
        for (const item of toMove) {
            const src = node_path_1.default.join(baseDir, item.name);
            if (node_fs_1.default.existsSync(src)) {
                const dest = node_path_1.default.join(wsDir, item.name);
                (0, shell_command_projection_cjs_1.retryRenameSync)(src, dest);
                filesMoved.push(item.name);
            }
        }
    }
    catch (err) {
        for (const name of filesMoved) {
            try {
                (0, shell_command_projection_cjs_1.retryRenameSync)(node_path_1.default.join(wsDir, name), node_path_1.default.join(baseDir, name));
            }
            catch { /* ignore */ }
        }
        try {
            node_fs_1.default.rmSync(wsDir, { recursive: true });
        }
        catch { /* ignore */ }
        try {
            node_fs_1.default.rmdirSync(node_path_1.default.join(baseDir, 'workstreams'));
        }
        catch { /* ignore */ }
        throw err;
    }
    return { migrated: true, workstream: workstreamName, files_moved: filesMoved };
}
// ─── CRUD Commands ────────────────────────────────────────────────────────────
function cmdWorkstreamCreate(cwd, name, options, raw) {
    if (!name) {
        error('workstream name required. Usage: workstream create <name>');
    }
    const slug = (0, workstream_name_policy_cjs_1.toWorkstreamSlug)(name);
    if (!slug) {
        error('Invalid workstream name — must contain at least one alphanumeric character');
    }
    if ((0, workstream_name_policy_cjs_1.isReservedWorkstreamName)(slug)) {
        error((0, workstream_name_policy_cjs_1.reservedWorkstreamNameMessage)(slug));
    }
    const baseDir = planningRoot(cwd);
    if (!node_fs_1.default.existsSync(baseDir)) {
        error(`.planning/ directory not found — run ${(0, runtime_slash_cjs_1.formatGsdSlash)('new-project', (0, runtime_slash_cjs_1.resolveRuntime)(cwd))} first`);
    }
    const wsRoot = node_path_1.default.join(baseDir, 'workstreams');
    const wsDir = node_path_1.default.join(wsRoot, slug);
    if (node_fs_1.default.existsSync(wsDir) && node_fs_1.default.existsSync(node_path_1.default.join(wsDir, 'STATE.md'))) {
        output({ created: false, error: 'already_exists', workstream: slug, path: toPosixPath(node_path_1.default.relative(cwd, wsDir)) }, raw, undefined);
        return;
    }
    const isFlatMode = !node_fs_1.default.existsSync(wsRoot);
    let migration = null;
    if (isFlatMode && options.migrate !== false) {
        const hasExistingWork = node_fs_1.default.existsSync(node_path_1.default.join(baseDir, 'ROADMAP.md')) ||
            node_fs_1.default.existsSync(node_path_1.default.join(baseDir, 'STATE.md')) ||
            node_fs_1.default.existsSync(node_path_1.default.join(baseDir, 'phases'));
        if (hasExistingWork) {
            const migrateName = options.migrateName || null;
            let existingWsName;
            if (migrateName) {
                const slugged = (0, workstream_name_policy_cjs_1.toWorkstreamSlug)(migrateName);
                if (!slugged) {
                    output({
                        created: false,
                        error: 'migration_failed',
                        message: 'Invalid migrate-name — must contain at least one alphanumeric character',
                    }, raw, undefined);
                    return;
                }
                existingWsName = slugged;
            }
            else {
                try {
                    const milestone = getMilestoneInfo(cwd).value;
                    existingWsName = generateSlugInternal(milestone?.name ?? null) || 'default';
                }
                catch {
                    existingWsName = 'default';
                }
            }
            try {
                migration = migrateToWorkstreams(cwd, existingWsName);
            }
            catch (e) {
                output({ created: false, error: 'migration_failed', message: e.message }, raw, undefined);
                return;
            }
        }
        else {
            (0, shell_command_projection_cjs_1.platformEnsureDir)(wsRoot);
        }
    }
    (0, shell_command_projection_cjs_1.platformEnsureDir)(wsDir);
    (0, shell_command_projection_cjs_1.platformEnsureDir)(node_path_1.default.join(wsDir, 'phases'));
    const today = clock_cjs_1.realClock.localToday();
    const stateContent = [
        '---',
        `workstream: ${slug}`,
        `created: ${today}`,
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '**Status:** Not started',
        '**Current Phase:** None',
        `**Last Activity:** ${today}`,
        '**Last Activity Description:** Workstream created',
        '',
        '## Progress',
        '**Phases Complete:** 0',
        '**Current Plan:** N/A',
        '',
        '## Session Continuity',
        '**Stopped At:** N/A',
        '**Resume File:** None',
        '',
    ].join('\n');
    const statePath = node_path_1.default.join(wsDir, 'STATE.md');
    if (!node_fs_1.default.existsSync(statePath)) {
        (0, shell_command_projection_cjs_1.platformWriteSync)(statePath, stateContent);
    }
    setActiveWorkstream(cwd, slug);
    const relPath = toPosixPath(node_path_1.default.relative(cwd, wsDir));
    output({
        created: true,
        workstream: slug,
        path: relPath,
        state_path: relPath + '/STATE.md',
        phases_path: relPath + '/phases',
        migration: migration || null,
        active: true,
    }, raw, undefined);
}
function cmdWorkstreamList(cwd, raw) {
    const inventory = listWorkstreamInventories(cwd);
    if (inventory.mode === 'flat') {
        output({ mode: 'flat', workstreams: [], message: inventory.message }, raw, undefined);
        return;
    }
    const workstreams = inventory.workstreams.map(ws => ({
        name: ws.name,
        path: ws.path,
        has_roadmap: ws.files.roadmap,
        has_state: ws.files.state,
        status: ws.status,
        // #2562: a refused shipped marker must reach the surface. Projecting
        // `status` without it renders the refusal invisible at the CLI, which is
        // the silent-collapse defect this issue is about.
        milestone_shipped_unverified: ws.milestone_shipped_unverified,
        current_phase: ws.current_phase,
        phase_count: ws.phase_count,
        completed_phases: ws.completed_phases,
    }));
    output({ mode: 'workstream', workstreams, count: workstreams.length }, raw, undefined);
}
function cmdWorkstreamStatus(cwd, name, raw) {
    if (!name)
        error('workstream name required. Usage: workstream status <name>');
    try {
        (0, workstream_name_policy_cjs_1.assertValidActiveWorkstreamName)(name, workstream_name_policy_cjs_1.INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE);
    }
    catch {
        error(workstream_name_policy_cjs_1.INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE);
    }
    const wsDir = node_path_1.default.join(planningRoot(cwd), 'workstreams', name);
    if (!node_fs_1.default.existsSync(wsDir)) {
        output({ found: false, workstream: name }, raw, undefined);
        return;
    }
    const inv = inspectWorkstream(cwd, name);
    if (!inv) {
        output({ found: false, workstream: name }, raw, undefined);
        return;
    }
    output({
        found: true,
        workstream: name,
        path: inv.path,
        files: inv.files,
        phases: inv.phases,
        phase_count: inv.phase_count,
        completed_phases: inv.completed_phases,
        status: inv.status,
        milestone_shipped_unverified: inv.milestone_shipped_unverified,
        current_phase: inv.current_phase,
        last_activity: inv.last_activity,
    }, raw, undefined);
}
function cmdWorkstreamComplete(cwd, name, options, raw) {
    if (!name)
        error('workstream name required. Usage: workstream complete <name>');
    try {
        (0, workstream_name_policy_cjs_1.assertValidActiveWorkstreamName)(name, workstream_name_policy_cjs_1.INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE);
    }
    catch {
        error(workstream_name_policy_cjs_1.INVALID_ACTIVE_WORKSTREAM_NAME_MESSAGE);
    }
    const root = planningRoot(cwd);
    const wsRoot = node_path_1.default.join(root, 'workstreams');
    const wsDir = node_path_1.default.join(wsRoot, name);
    if (!node_fs_1.default.existsSync(wsDir)) {
        output({ completed: false, error: 'not_found', workstream: name }, raw, undefined);
        return;
    }
    const active = getActiveWorkstream(cwd);
    if (active === name)
        setActiveWorkstream(cwd, null);
    const archiveDir = node_path_1.default.join(root, 'milestones');
    const today = clock_cjs_1.realClock.localToday();
    let archivePath = node_path_1.default.join(archiveDir, `ws-${name}-${today}`);
    let suffix = 1;
    while (node_fs_1.default.existsSync(archivePath)) {
        archivePath = node_path_1.default.join(archiveDir, `ws-${name}-${today}-${suffix++}`);
    }
    (0, shell_command_projection_cjs_1.platformEnsureDir)(archivePath);
    const filesMoved = [];
    try {
        const entries = node_fs_1.default.readdirSync(wsDir, { withFileTypes: true });
        for (const entry of entries) {
            (0, shell_command_projection_cjs_1.retryRenameSync)(node_path_1.default.join(wsDir, entry.name), node_path_1.default.join(archivePath, entry.name));
            filesMoved.push(entry.name);
        }
    }
    catch (err) {
        for (const fname of filesMoved) {
            try {
                (0, shell_command_projection_cjs_1.retryRenameSync)(node_path_1.default.join(archivePath, fname), node_path_1.default.join(wsDir, fname));
            }
            catch { /* ignore */ }
        }
        try {
            node_fs_1.default.rmSync(archivePath, { recursive: true });
        }
        catch { /* ignore */ }
        if (active === name)
            setActiveWorkstream(cwd, name);
        output({ completed: false, error: 'archive_failed', message: err.message, workstream: name }, raw, undefined);
        return;
    }
    try {
        node_fs_1.default.rmdirSync(wsDir);
    }
    catch { /* ignore */ }
    let remainingWs = 0;
    try {
        remainingWs = node_fs_1.default.readdirSync(wsRoot, { withFileTypes: true }).filter(e => e.isDirectory()).length;
        if (remainingWs === 0)
            node_fs_1.default.rmdirSync(wsRoot);
    }
    catch { /* ignore */ }
    output({
        completed: true,
        workstream: name,
        archived_to: toPosixPath(node_path_1.default.relative(cwd, archivePath)),
        remaining_workstreams: remainingWs,
        reverted_to_flat: remainingWs === 0,
    }, raw, undefined);
}
// ─── Active Workstream Commands ───────────────────────────────────────────────
function cmdWorkstreamSet(cwd, name, raw) {
    if (!name || name === '--clear') {
        if (name !== '--clear') {
            error('Workstream name required. Usage: workstream set <name> (or workstream set --clear to unset)');
        }
        const previous = getActiveWorkstream(cwd);
        setActiveWorkstream(cwd, null);
        output({ active: null, cleared: true, previous: previous || null }, raw, undefined);
        return;
    }
    if (!(0, workstream_name_policy_cjs_1.isValidActiveWorkstreamName)(name) || (0, workstream_name_policy_cjs_1.isReservedWorkstreamName)(name)) {
        const message = (0, workstream_name_policy_cjs_1.isReservedWorkstreamName)(name)
            ? (0, workstream_name_policy_cjs_1.reservedWorkstreamNameMessage)(name)
            : 'Workstream name must be alphanumeric, hyphens, underscores, or dots';
        output({ active: null, error: 'invalid_name', message }, raw, undefined);
        return;
    }
    const wsDir = node_path_1.default.join(planningRoot(cwd), 'workstreams', name);
    if (!node_fs_1.default.existsSync(wsDir)) {
        output({ active: null, error: 'not_found', workstream: name }, raw, undefined);
        return;
    }
    setActiveWorkstream(cwd, name);
    output({ active: name, set: true }, raw, name);
}
function cmdWorkstreamGet(cwd, raw) {
    const active = getActiveWorkstream(cwd);
    const wsRoot = node_path_1.default.join(planningRoot(cwd), 'workstreams');
    output({ active, mode: node_fs_1.default.existsSync(wsRoot) ? 'workstream' : 'flat' }, raw, active || 'none');
}
function cmdWorkstreamProgress(cwd, raw) {
    const inventory = listWorkstreamInventories(cwd);
    if (inventory.mode === 'flat') {
        output({ mode: 'flat', workstreams: [], message: inventory.message }, raw, undefined);
        return;
    }
    const workstreams = inventory.workstreams.map(ws => ({
        name: ws.name,
        active: ws.active,
        status: ws.status,
        milestone_shipped_unverified: ws.milestone_shipped_unverified,
        current_phase: ws.current_phase ?? null,
        phases: `${ws.completed_phases}/${ws.roadmap_phase_count}`,
        plans: `${ws.completed_plans}/${ws.total_plans}`,
        progress_percent: ws.progress_percent,
    }));
    output({ mode: 'workstream', active: inventory.active, workstreams, count: workstreams.length }, raw, undefined);
}
// ─── Collision Detection ──────────────────────────────────────────────────────
/**
 * Return other workstreams that are NOT complete.
 * Used to detect whether the milestone has active parallel work
 * when a workstream finishes its last phase.
 */
function getOtherActiveWorkstreams(cwd, excludeWs) {
    return getOtherActiveWorkstreamInventories(cwd, excludeWs).map(ws => ({
        name: ws.name,
        status: ws.status,
        current_phase: ws.current_phase ?? null,
        phases: `${ws.completed_phases}/${ws.phase_count}`,
    }));
}
module.exports = {
    migrateToWorkstreams,
    cmdWorkstreamCreate,
    cmdWorkstreamList,
    cmdWorkstreamStatus,
    cmdWorkstreamComplete,
    cmdWorkstreamSet,
    cmdWorkstreamGet,
    cmdWorkstreamProgress,
    getOtherActiveWorkstreams,
};
