"use strict";
/**
 * Phase Locator — Phase-directory search and location
 *
 * ADR-857 rollout phase 2d: extracted from core.cts (issue #881).
 * Owns active-phase discovery against the `.planning/phases/` tree
 * (`searchPhaseInDir`, `findPhaseInternal`) and archived-phase-dir
 * enumeration (`getArchivedPhaseDirs`), matching phase ids/tokens against
 * the filesystem. Also owns the silent naming projection and shared writer
 * tail (preflight, containment, directory creation, identity markers).
 * The core.cjs re-export spine
 * was retired in epic #1267; callers import phase-locator helpers directly.
 *
 * Dependencies:
 *   - node:fs / node:path (stdlib)
 *   - ./phase-id.cjs       (phaseDirectoryContext, customPhaseQuery, customPhaseDirectoryParts,
 *                           normalizePhaseName, matchPhaseDirs, phaseNumberForMatch)
 *   - ./phase-id-display.cjs (milestone numeric canonicalization)
 *   - ./core-utils.cjs     (readSubdirectories, getPhaseFileStats, extractCanonicalPlanId, toPosixPath)
 *   - ./planning-workspace.cjs (planningDir, resolvePhaseIdConvention)
 *   - ./config-loader.cjs (CONFIG_DEFAULTS, _deepMergeConfig, _getConfigValue;
 *                          silent file-selection projection; loadConfig for the
 *                          active bracket project code)
 *   - ./runtime-homes.cjs (resolveGsdHome)
 *   - ./frontmatter.cjs / ./plan-dependency-graph.cjs (plan dependency evidence)
 *   - ./roadmap-parser.cjs / ./planning-scope.cjs (milestone membership/scope)
 *   - ./io.cjs / ./shell-command-projection.cjs (typed write errors and files)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ioMod = require("./io.cjs");
const { error, ERROR_REASON } = ioMod;
const shell_command_projection_cjs_1 = require("./shell-command-projection.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const phaseIdModule = require("./phase-id.cjs");
const { BRACKET_DIR_PREFIX_SRC, CUSTOM_PHASE_ID_FILE, comparePhaseNum, customPhaseDirectoryParts, customPhaseQuery, foldBracketId, isSentinelPhaseId, matchPhaseDirs, normalizePhaseName, parsePhaseId, phaseDirectoryContext, phaseNumberForMatch, } = phaseIdModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const coreUtilsModule = require("./core-utils.cjs");
const { readSubdirectories, getPhaseFileStats, extractCanonicalPlanId, toPosixPath, findUnsummarizedPlans } = coreUtilsModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planningWorkspace = require("./planning-workspace.cjs");
const { planningDir, planningRoot, resolveEnvWorkstream, resolvePhaseIdConvention } = planningWorkspace;
// Naming readers and writers share the loader's scoped-key precedence and defaults.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const configLoaderModule = require("./config-loader.cjs");
const { CONFIG_DEFAULTS, _deepMergeConfig, _getConfigValue, loadConfig, readConfigFileBounded } = configLoaderModule;
const runtime_homes_cjs_1 = require("./runtime-homes.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const frontmatterModule = require("./frontmatter.cjs");
const { extractFrontmatter } = frontmatterModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planDependencyGraphModule = require("./plan-dependency-graph.cjs");
const { computeHaltPropagation, buildSummaryFileIndex, isSummaryFileHalted, isSummaryFileBlocked } = planDependencyGraphModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const roadmapParserModule = require("./roadmap-parser.cjs");
const { getMilestoneInfo, getMilestonePhaseFilter } = roadmapParserModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const phaseIdDisplayModule = require("./phase-id-display.cjs");
const { milestoneToken, phaseToken } = phaseIdDisplayModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planningScopeMod = require("./planning-scope.cjs");
const { SCOPE } = planningScopeMod;
// #4304: result shaping must distinguish a canonical bracket directory from a
// legacy directory that matchPhaseDirs deliberately still admits during a
// bracket migration. Derive that distinction from the exported owner grammar.
const BRACKET_DIRECTORY_PREFIX_RE = new RegExp(`^${BRACKET_DIR_PREFIX_SRC}`);
/**
 * #2830: parse a plan file's `depends_on` frontmatter. Returns [] — never
 * throws — on a missing/unreadable/malformed plan or absent field, matching
 * this primitive's existing fail-safe posture (a plan directory this
 * primitive can otherwise read must never throw here).
 */
function parsePlanDependsOn(phaseDir, planFile) {
    try {
        const planPath = node_path_1.default.join(phaseDir, planFile);
        const content = node_fs_1.default.readFileSync(planPath, 'utf-8');
        const fm = extractFrontmatter(content, planPath);
        const fmDeps = fm['depends_on'];
        if (Array.isArray(fmDeps))
            return fmDeps.map(String);
        if (typeof fmDeps === 'string' && fmDeps.trim() !== '')
            return [fmDeps];
        return [];
    }
    catch {
        return [];
    }
}
/**
 * Resolve the convention and active bracket identity once for every current-
 * checkout phase-directory lookup. A caller-provided convention takes priority
 * over config resolution. Legacy callers receive the exact historical
 * normalization and no context. A partially configured bracket repo degrades
 * to the ambiguity-safe unqualified matcher rather than inventing an identity.
 */
function resolvePhaseDirectoryLookup(cwd, phase, conventionOverride, directoryContext) {
    const legacyNormalized = normalizePhaseName(phase);
    const resolvedConvention = conventionOverride ?? resolvePhaseIdConvention(cwd);
    // Custom ids have no padding form: the id is looked up as written.
    if (directoryContext?.phaseNaming === 'custom' && resolvedConvention !== 'bracket') {
        return {
            normalized: typeof phase === 'string' ? phase : legacyNormalized,
            legacyNormalized: undefined,
            convention: undefined,
            bracketContext: undefined,
        };
    }
    if (resolvedConvention !== 'bracket') {
        return {
            normalized: legacyNormalized,
            legacyNormalized: undefined,
            convention: undefined,
            bracketContext: undefined,
        };
    }
    // The bracket writers canonicalize both numeric segments through phaseToken
    // (`1.1` -> `01.01`). Finish the convention-only query normalization at
    // this shared locator boundary while retaining normalizePhaseName's legacy
    // decimal spelling (`01.1`) as the second-pass migration fallback. Every
    // other convention and already-canonical bracket form remains single-pass.
    const normalized = phaseToken(legacyNormalized) ?? legacyNormalized;
    let bracketContext;
    try {
        const config = loadConfig(cwd);
        const project = typeof config['project_code'] === 'string' ? config['project_code'].trim() : '';
        const version = getMilestoneInfo(cwd).value?.version ?? '';
        const milestone = milestoneToken(version);
        if (project && milestone !== null)
            bracketContext = { project, milestone };
    }
    catch {
        // Read-side lookup remains non-throwing when config/milestone state is
        // incomplete; matchPhaseDirs will surface ambiguity rather than guess.
    }
    return {
        normalized,
        legacyNormalized: normalized === legacyNormalized ? undefined : legacyNormalized,
        convention: 'bracket',
        bracketContext,
    };
}
/**
 * Apply one resolved lookup to a directory set. Bracket queries try the writer-
 * canonical spelling first, then the pre-bracket `normalizePhaseName` spelling
 * only when the canonical pass finds nothing. `matchPhaseDirs` remains the
 * single selection owner for both passes, including its migration-window legacy
 * fallback and ambiguity behavior. Non-bracket lookups have no second spelling.
 */
function matchPhaseDirsForLookup(dirs, lookup, bracketContextOverride, directoryContext) {
    const bracketContext = bracketContextOverride === undefined
        ? lookup.bracketContext
        : bracketContextOverride;
    const primary = matchPhaseDirs(dirs, lookup.normalized, lookup.convention, bracketContext, directoryContext);
    if (primary.matches.length > 0 || lookup.legacyNormalized === undefined)
        return primary;
    return matchPhaseDirs(dirs, lookup.legacyNormalized, lookup.convention, bracketContext, directoryContext);
}
// ─── Phase search helpers ─────────────────────────────────────────────────────
/**
 * #2855: single source of truth for resolving and enumerating a project's
 * (or, when a workstream is active, that workstream's OWN) archived-milestone
 * directories — `<planningDir(cwd)>/milestones/vX.Y-phases/`. Both
 * `findPhaseInternal`'s archive fallback and `getArchivedPhaseDirs` used to
 * carry independent copies of this resolve-then-enumerate logic, which is
 * exactly the shape that let the original #2855 bug (hardcoded root path)
 * exist in one copy and not the other. Sharing this seam means a future
 * change to how the archive tree is located only needs to happen once.
 * Most-recent-milestone-first order, compared numerically segment-by-segment
 * on the version (e.g. `v1.10` before `v1.9`) — NOT lexicographically. A
 * lexicographic `.sort().reverse()` (the prior implementation) ranks `v1.9`
 * ahead of `v1.10` because the string `"1.9"` sorts after `"1.10"`; that is
 * deterministic but wrong for every double-digit-or-higher minor/patch
 * version, and #3458 is what first surfaces archived phases in audit output
 * where the misordering becomes user-visible.
 * Never throws: an absent/unreadable milestones/ dir yields [].
 */
function compareArchiveVersionDesc(aName, bName) {
    const aParts = (aName.match(/^v([\d.]+)-phases$/)?.[1] ?? '').split('.').map(Number);
    const bParts = (bName.match(/^v([\d.]+)-phases$/)?.[1] ?? '').split('.').map(Number);
    const len = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < len; i++) {
        const a = aParts[i] ?? 0;
        const b = bParts[i] ?? 0;
        if (a !== b)
            return b - a; // descending: newest (numerically largest) first
    }
    return 0;
}
function listArchiveVersionDirs(cwd, wsOverride) {
    // #3804: enumerate BOTH archive shapes under the CURRENT SCOPE's milestones
    // tree (planningDir — GSD_WORKSTREAM/GSD_PROJECT-aware, exactly the
    // #2855 scoping findPhaseInternal and getArchivedPhaseDirs rely on):
    //   flat:               <scope>/milestones/vX.Y-phases/<phase-dir>/
    //   workstream archive: <scope>/milestones/ws-<slug>-<date>/phases/<phase-dir>/
    // Pre-#3804 only the flat shape matched, so workstream-archived milestones
    // were invisible (the reporter's repo: 20 hidden phase artifacts). The
    // ws-* shape's phase dirs sit one level deeper (under phases/) and its dir
    // name fails ^v[\d.]+-phases$ — both the name AND the level are modeled.
    // Version labels: flat keeps the bare vX.Y; ws-* shapes carry the dir name
    // (no numeric version). Flat-newest-first (compareArchiveVersionDesc), then
    // ws dirs by name descending — deterministic. The AUDIT's cross-workstream
    // enumeration (audit.cts listAuditPhaseTargets) calls this helper once per
    // tree (root + each workstream) rather than widening this scope — the
    // #2855 no-leak contract for findPhaseInternal/getArchivedPhaseDirs is
    // preserved untouched.
    const milestonesDir = node_path_1.default.join(planningDir(cwd, wsOverride ?? undefined), 'milestones');
    const out = [];
    const seen = new Set();
    const pushVersion = (version, archivePath) => {
        const rel = toPosixPath(node_path_1.default.relative(cwd, archivePath));
        if (seen.has(rel))
            return;
        seen.add(rel);
        out.push({ version, archivePath });
    };
    let entries;
    try {
        entries = node_fs_1.default.readdirSync(milestonesDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const flat = entries
        .filter(e => e.isDirectory() && /^v[\d.]+-phases$/.test(e.name))
        .map(e => e.name)
        .sort(compareArchiveVersionDesc);
    for (const archiveName of flat) {
        pushVersion(archiveName.match(/^(v[\d.]+)-phases$/)[1], node_path_1.default.join(milestonesDir, archiveName));
    }
    const wsDirs = entries
        .filter(e => e.isDirectory() && /^ws-/.test(e.name))
        .map(e => e.name)
        .sort()
        .reverse();
    for (const wsName of wsDirs) {
        pushVersion(wsName, node_path_1.default.join(milestonesDir, wsName, 'phases'));
    }
    return out;
}
/** Effective naming is a silent projection; roadmap and marker reads are bounded. */
function phaseDirectoryOptions(cwd, config, roadmap, ws) {
    // These two flat keys have no legacy aliases and are not inherited from
    // global defaults by loadConfig. Mirror only its file-selection branches,
    // reusing its merge, value and default owners without warnings or write-back.
    // Replace this projection if the loader gains a quiet option; parity tests
    // guard workstream, project, corrupt-file and global-default precedence.
    let naming = config;
    let configError;
    if (naming === undefined) {
        const readConfig = (file) => {
            try {
                // Bounded read (#5759): null is an absent file (no configError); a FIFO/device/oversized
                // file throws and is reported through configError like any other unreadable config.
                const raw = readConfigFileBounded(file);
                if (raw === null)
                    return null;
                const value = JSON.parse(raw);
                if (value && typeof value === 'object' && !Array.isArray(value))
                    return value;
                configError = { path: file, message: 'configuration must be a JSON object' };
                return null;
            }
            catch (cause) {
                if (cause.code !== 'ENOENT')
                    configError = { path: file, message: cause.message };
                return null;
            }
        };
        const activeWs = ws === undefined ? resolveEnvWorkstream() : ws?.trim() || null;
        const root = activeWs ? readConfig(node_path_1.default.join(planningRoot(cwd), 'config.json')) : null;
        const scoped = readConfig(node_path_1.default.join(planningDir(cwd, activeWs), 'config.json'));
        // A missing/broken workstream with a usable root recurses with ws:null in
        // loadConfig, including GSD_PROJECT's own config rather than the flat root.
        const parsed = scoped ? (root ? _deepMergeConfig(root, scoped) : scoped)
            : root ? readConfig(node_path_1.default.join(planningDir(cwd, null), 'config.json')) : null;
        naming = {
            phase_naming: _getConfigValue(parsed ?? {}, 'phase_naming') ?? CONFIG_DEFAULTS.phase_naming,
            project_code: _getConfigValue(parsed ?? {}, 'project_code') ?? CONFIG_DEFAULTS.project_code,
        };
    }
    const context = phaseDirectoryContext(naming, roadmap ?? '');
    if (configError)
        context.configError = configError;
    if (context.phaseNaming !== 'custom')
        return context;
    // Load directory-owned IDs once for this scope, including archive fallback.
    // Old directories retain known heading hints. Mutations accept a unique
    // owner and refuse ambiguous candidates before any deletion or rename.
    context.directoryIdsByRoot = Object.create(null);
    const unmarkedDirectories = [];
    context.unmarkedDirectories = unmarkedDirectories;
    const roots = [node_path_1.default.join(planningDir(cwd, ws), 'phases'), ...listArchiveVersionDirs(cwd, ws).map(entry => entry.archivePath)];
    for (const root of roots) {
        const ids = Object.create(null);
        context.directoryIdsByRoot[root] = ids;
        const directories = readSubdirectories(root, true);
        for (const dir of directories) {
            let identityFd;
            try {
                const markerPath = node_path_1.default.join(root, dir, CUSTOM_PHASE_ID_FILE);
                const marker = node_fs_1.default.lstatSync(markerPath);
                if (!marker.isFile() || marker.size > 1024)
                    continue;
                // Nonblocking/no-follow open also bounds a replacement between lstat and
                // open; fstat validates the actual descriptor before reading at most 1 KiB.
                // Windows may omit these flags: lstat/fstat still require a regular file,
                // but the open is not atomically no-follow there. Adopt Windows no-follow
                // flags here if Node exposes them; no caller should weaken these checks.
                identityFd = node_fs_1.default.openSync(markerPath, node_fs_1.default.constants.O_RDONLY | node_fs_1.default.constants.O_NONBLOCK | node_fs_1.default.constants.O_NOFOLLOW | (node_fs_1.default.constants.O_NOCTTY ?? 0));
                const opened = node_fs_1.default.fstatSync(identityFd);
                if (!opened.isFile() || opened.size > 1024)
                    continue;
                const buffer = Buffer.alloc(opened.size);
                const count = node_fs_1.default.readSync(identityFd, buffer, 0, buffer.length, 0);
                const id = buffer.toString('utf8', 0, count).trim();
                if (id) {
                    phaseIdModule.phaseDirectoryName(id, '');
                    ids[dir] = id;
                }
            }
            catch { /* An absent or unusable marker supplies no ownership proof. */ }
            finally {
                if (identityFd !== undefined)
                    node_fs_1.default.closeSync(identityFd);
            }
        }
        unmarkedDirectories.push(...directories.filter(dir => ids[dir] === undefined));
    }
    // Basenames can repeat across milestones with different ID/slug boundaries.
    // Identity hints span the scope; authoritative records belong to one pool.
    context.directoryIds = context.directoryIdsByRoot[roots[0]];
    context.knownIds = [...new Set(Object.values(context.directoryIdsByRoot).flatMap(ids => Object.values(ids)))];
    if (roadmap !== undefined)
        return context;
    let fd;
    try {
        fd = node_fs_1.default.openSync(node_path_1.default.join(planningDir(cwd, ws), 'ROADMAP.md'), 'r');
        const buffer = Buffer.alloc(Math.min(node_fs_1.default.fstatSync(fd).size, 1024 * 1024));
        const count = node_fs_1.default.readSync(fd, buffer, 0, buffer.length, 0);
        return { ...context, roadmap: buffer.toString('utf8', 0, count) };
    }
    catch {
        return context;
    }
    finally {
        if (fd !== undefined)
            node_fs_1.default.closeSync(fd);
    }
}
const directoryPoolContexts = new WeakMap();
/** Select records for this physical pool, reusing its context across queries. */
function phaseDirectoryContextForRoot(context, root) {
    const ids = context.directoryIdsByRoot?.[root];
    if (!ids || ids === context.directoryIds)
        return context;
    let pools = directoryPoolContexts.get(context);
    if (!pools) {
        pools = new Map();
        directoryPoolContexts.set(context, pools);
    }
    let selected = pools.get(root);
    if (!selected) {
        selected = { ...context, directoryIds: ids };
        pools.set(root, selected);
    }
    return selected;
}
/** Usage guidance for every custom-ID writer, using the resolved naming policy. */
function customPhaseNamingUsage(cwd, context) {
    if (context.phaseNaming === 'custom')
        return null;
    if (context.configError)
        return `Cannot read phase naming from ${context.configError.path}: ${context.configError.message}. Repair the project config before using a custom ID`;
    let message = 'phase_naming is not custom for this project; configure phase_naming as "custom" before using a custom ID';
    try {
        const defaultsPath = node_path_1.default.join((0, runtime_homes_cjs_1.resolveGsdHome)(), '.gsd', 'defaults.json');
        const defaults = JSON.parse(node_fs_1.default.readFileSync(defaultsPath, 'utf8'));
        if (typeof defaults.phase_naming === 'string' && defaults.phase_naming.toLowerCase() === 'custom' && node_fs_1.default.existsSync(node_path_1.default.join(planningDir(cwd), 'config.json'))) {
            message += `; project config shadows phase_naming from ${defaultsPath}`;
        }
    }
    catch { /* Missing/unusable defaults do not change effective naming. */ }
    return message;
}
/** Preflight the complete write set, then create directories and identity records. */
function createPhaseDirectories(cwd, entries, context, gitkeep = true) {
    const phasesRoot = node_path_1.default.resolve(planningDir(cwd), 'phases');
    let prepared;
    try {
        const recorded = entries.filter(entry => entry.recordIdentity ?? context.phaseNaming === 'custom');
        if (recorded.length > 0)
            phaseIdModule.validateCustomPhaseIds(recorded.map(entry => entry.id), context);
        const pendingPaths = new Set();
        prepared = entries.map(entry => {
            // Validate the raw ID before legacy scaffold normalization can discard it.
            phaseIdModule.phaseDirectoryName(entry.id, '', context.projectCode);
            const dirName = phaseIdModule.phaseDirectoryName(entry.directoryId ?? entry.id, entry.slug, context.projectCode);
            const dirPath = node_path_1.default.resolve(phasesRoot, dirName);
            if (node_path_1.default.dirname(dirPath) !== phasesRoot)
                error('Phase directory escapes the phases directory', ERROR_REASON.USAGE);
            const recordIdentity = entry.recordIdentity ?? context.phaseNaming === 'custom';
            // An occupied target is a collision only where a custom writer would
            // record an identity into it. Numeric writers keep the idempotent
            // ensure-directory they always had.
            if (recordIdentity && (pendingPaths.has(dirPath) || node_fs_1.default.lstatSync(dirPath, { throwIfNoEntry: false }) !== undefined)) {
                throw new phaseIdModule.PhaseDirectoryNameError(`Phase directory ${dirName} already exists or is claimed by another pending entry; choose a distinct ID or title`, 'collision');
            }
            pendingPaths.add(dirPath);
            return { ...entry, dirName, dirPath, recordIdentity };
        });
    }
    catch (cause) {
        if (cause instanceof phaseIdModule.PhaseDirectoryNameError) {
            error(cause.message, cause.kind === 'collision' ? ERROR_REASON.PHASE_ID_COLLISION : ERROR_REASON.USAGE);
        }
        throw cause;
    }
    for (const entry of prepared) {
        (0, shell_command_projection_cjs_1.platformEnsureDir)(entry.dirPath);
        if (gitkeep)
            (0, shell_command_projection_cjs_1.platformWriteSync)(node_path_1.default.join(entry.dirPath, '.gitkeep'), '');
        if (entry.recordIdentity)
            (0, shell_command_projection_cjs_1.platformWriteSync)(node_path_1.default.join(entry.dirPath, CUSTOM_PHASE_ID_FILE), entry.id);
    }
    return prepared;
}
function searchPhaseInDir(baseDir, relBase, normalized, convention, bracketContext, legacyNormalized, context = phaseDirectoryContext({})) {
    context = phaseDirectoryContextForRoot(context, baseDir);
    try {
        const dirs = readSubdirectories(baseDir, true);
        // #2528: canonical two-pass selection (exact token match, then the
        // bare-integer leading-digit-run fallback) shared with the find-phase and
        // phase-plan-index scans — see phase-id.cts::matchPhaseDirs.
        // #4801: the convention is threaded (optional) so bracket-convention
        // consumers get exact token matching here too.
        const { matches, usedBareFallback } = matchPhaseDirsForLookup(dirs, {
            normalized,
            legacyNormalized,
            convention: convention === 'bracket' ? 'bracket' : undefined,
            bracketContext: bracketContext ?? undefined,
        }, bracketContext, context);
        if (matches.length === 0)
            return null;
        // #2237: fail loud when multiple directories match the same bare phase
        // number — this happens when unrelated projects share a .planning/phases/
        // tree. Silently taking the first match risks cross-project file writes.
        if (matches.length > 1) {
            return {
                found: false,
                directory: '',
                phase_number: normalized,
                phase_name: null,
                phase_slug: null,
                plans: [],
                summaries: [],
                incomplete_plans: [],
                has_research: false,
                has_context: false,
                has_verification: false,
                has_reviews: false,
                ambiguous_matches: matches,
                halted_plans: [],
                blocked_by: {},
                runnable_plans: [],
                ready_plans: [],
            };
        }
        const match = matches[0];
        const isBracketDirectory = convention === 'bracket'
            && BRACKET_DIRECTORY_PREFIX_RE.test(foldBracketId(match));
        const resultConvention = isBracketDirectory ? 'bracket' : undefined;
        const custom = convention === 'bracket' ? null : customPhaseQuery(normalized, context);
        const parts = custom ? customPhaseDirectoryParts(match, custom) : null;
        const phaseToken = parts?.id || phaseNumberForMatch(match, usedBareFallback, resultConvention);
        const phaseNumber = phaseToken || normalized;
        let afterToken;
        if (isBracketDirectory) {
            const id = parsePhaseId(match);
            const idToken = `${id.phase}${id.subphase ? `.${id.subphase}` : ''}`;
            const bracketPrefix = `${id.project}.${id.milestone}-${idToken}`;
            afterToken = match.slice(bracketPrefix.length).replace(/^-/, '');
        }
        else {
            // Exact pre-#4304 legacy shaping, including project-prefixed and bare
            // fallback matches. Bracket mode changes selection, not these bytes.
            afterToken = match.slice(phaseToken ? phaseToken.length : 0).replace(/^-/, '');
        }
        const phaseName = parts?.slug || afterToken || null;
        const phaseDir = node_path_1.default.join(baseDir, match);
        const { plans: unsortedPlans, summaries: unsortedSummaries, hasResearch, hasContext, hasVerification, hasReviews } = getPhaseFileStats(phaseDir);
        const plans = unsortedPlans.sort();
        const summaries = unsortedSummaries.sort();
        // #3183 (ADR-3180 Decision 2): the summary→plan pairing used to be a
        // bespoke rule local to this function (a third pairing rule alongside
        // scanPhasePlans's completion check and countMatchedSummaries). Routed
        // through the canonical core-utils.findUnsummarizedPlans instead, which
        // shares its `summaryCandidates` matching rule with countMatchedSummaries
        // so the count and this named list can never disagree.
        const incompletePlans = findUnsummarizedPlans(plans, summaries);
        // #2830: reverse lookup from a completed plan's id (exact or canonical) to
        // its actual summary filename. Shared builder (also used by phase.cts's
        // cmdPhasePlanIndex) so the two can never disagree about which summary
        // belongs to which plan.
        const summaryFileByPlanId = buildSummaryFileIndex(summaries, extractCanonicalPlanId);
        // #2830: this primitive previously never parsed depends_on at all — see
        // src/plan-dependency-graph.cts's file header. Build the same
        // PlanHaltNode[] shape phase.cts's cmdPhasePlanIndex builds (id resolution
        // mirrors its planMap/canonicalToId pattern) and hand it to the ONE
        // shared halt-propagation traversal so this reader and the wave-grouping
        // reader can never diverge on the halt rule again.
        const planIds = plans.map(p => p.replace('-PLAN.md', '').replace('PLAN.md', ''));
        const planIdByLower = new Map(planIds.map(id => [id.toLowerCase(), id]));
        const canonicalToPlanId = new Map(plans.map((p, i) => [extractCanonicalPlanId(p).toLowerCase(), planIds[i]]));
        // #4628: raw depends_on per plan, so readiness can fail closed on a
        // DROPPED edge (a dep token that resolves to nothing carries no evidence)
        // instead of the resolution silently shrinking the dependency list.
        const rawDeps = plans.map((p) => parsePlanDependsOn(phaseDir, p));
        // #4628: completion evidence excludes status:blocked summaries (#3345) —
        // a failure record is not completion, matching cmdPhasePlanIndex's count.
        const completionEvidence = buildSummaryFileIndex(summaries.filter((f) => !isSummaryFileBlocked(node_path_1.default.join(phaseDir, f))), extractCanonicalPlanId);
        const haltNodes = plans.map((p, i) => {
            const planId = planIds[i];
            const canonical = extractCanonicalPlanId(p);
            const summaryFile = summaryFileByPlanId.get(planId) ?? summaryFileByPlanId.get(canonical);
            const halted = summaryFile !== undefined && isSummaryFileHalted(node_path_1.default.join(phaseDir, summaryFile));
            const resolvedDependsOn = rawDeps[i]
                .map((dep) => {
                const lower = dep.toLowerCase();
                return planIdByLower.get(lower) ?? canonicalToPlanId.get(lower) ?? null;
            })
                .filter((id) => id !== null);
            return { id: planId, resolvedDependsOn, halted };
        });
        const { blockedBy } = computeHaltPropagation(haltNodes);
        const haltedPlans = plans.filter((_, i) => haltNodes[i].halted);
        const incompletePlanSet = new Set(incompletePlans);
        const blockedByFiles = {};
        const runnablePlans = [];
        const readyPlans = [];
        for (let i = 0; i < plans.length; i++) {
            const p = plans[i];
            if (!incompletePlanSet.has(p))
                continue;
            const causes = blockedBy.get(planIds[i]) ?? [];
            if (causes.length > 0) {
                blockedByFiles[p] = causes;
                continue;
            }
            runnablePlans.push(p);
            // #4628: DAG-ready on top of runnable — every dependency must have
            // completion evidence (a matching, non-blocked SUMMARY) and no dropped
            // edge: both readers of this contract fail closed identically.
            const depsComplete = rawDeps[i].length === haltNodes[i].resolvedDependsOn.length &&
                haltNodes[i].resolvedDependsOn.every((dep) => completionEvidence.has(dep));
            if (depsComplete)
                readyPlans.push(p);
        }
        return {
            found: true,
            directory: toPosixPath(node_path_1.default.join(relBase, match)),
            phase_number: phaseNumber,
            phase_name: phaseName,
            // #3883 (ADR-3473 §8.3): delegate to the canonical slug formula
            // (generateSlugInternal, core-utils.cts) rather than re-implementing
            // it. `maxLen: null` preserves this site's pre-migration untruncated
            // contract — the 60-char default would drop an on-disk phase slug's
            // reported value out of sync with the real directory name.
            phase_slug: phaseName ? coreUtilsModule.generateSlugInternal(phaseName, null) : null,
            plans,
            summaries,
            incomplete_plans: incompletePlans,
            has_research: hasResearch,
            has_context: hasContext,
            has_verification: hasVerification,
            has_reviews: hasReviews,
            halted_plans: haltedPlans,
            blocked_by: blockedByFiles,
            runnable_plans: runnablePlans,
            ready_plans: readyPlans,
        };
    }
    catch {
        return null;
    }
}
function findPhaseInternal(cwd, phase, convention, context) {
    if (!phase)
        return null;
    // Existing callers may omit context; multi-phase readers supply one reusable context.
    context ??= phaseDirectoryOptions(cwd);
    const phasesDir = node_path_1.default.join(planningDir(cwd), 'phases');
    const { normalized, legacyNormalized, convention: lookupConvention, bracketContext, } = resolvePhaseDirectoryLookup(cwd, phase, convention, context);
    const relPhasesDir = toPosixPath(node_path_1.default.relative(cwd, phasesDir));
    // #4801: convention threaded through to the matcher (see searchPhaseInDir).
    const current = searchPhaseInDir(phasesDir, relPhasesDir, normalized, lookupConvention, bracketContext, legacyNormalized, context);
    if (current)
        return current;
    // #2855: scope the archived-milestone fallback to the SAME workstream as the
    // active-phase search above (planningDir(cwd) resolves GSD_WORKSTREAM/GSD_PROJECT
    // the identical way both places), not the hardcoded project-root tree. Archived
    // phases genuinely live under a workstream's own `.planning/workstreams/<ws>/
    // milestones/` — that is where archivePhaseDirectories (milestone.cts) writes
    // them via the same planningDir(cwd) resolution. Hardcoding root here let a
    // pending workstream phase resolve to an unrelated workstream's (or a flat-mode
    // project's) archived phase that merely shares a phase number. Shared with
    // getArchivedPhaseDirs via listArchiveVersionDirs (see its doc comment).
    for (const { version, archivePath } of listArchiveVersionDirs(cwd)) {
        const relBase = toPosixPath(node_path_1.default.relative(cwd, archivePath));
        const result = searchPhaseInDir(archivePath, relBase, normalized, lookupConvention, null, legacyNormalized, context);
        if (result) {
            result.archived = version;
            return result;
        }
    }
    return null;
}
/**
 * #3185 (epic #3180 Phase 3, ADR-3180 Decision 1 row "Phase enumeration"):
 * the SINGLE canonical owner of "which phase directories belong to the current
 * milestone". Applies the milestone window AND the sentinel filter, in that
 * order, and returns the surviving directory names.
 *
 * Before this existed the derivation had four independent implementations and
 * only `cmdRoadmapAnalyze` carried both halves; `cmdProgressRender`,
 * `cmdStats` and `cmdPhasesList` each carried neither or one.
 *
 * TWO THINGS THIS GETS RIGHT THAT A HEADING-SIDE FILTER CANNOT:
 *
 * 1. The sentinel test runs against DIRECTORY NAMES and is UNCONDITIONAL.
 *    `getMilestonePhaseFilter` excludes sentinels from its ROADMAP HEADING
 *    set, but when that set is empty it degrades to a literal `() => true`
 *    pass-all predicate and never consults the heading set at all — so its
 *    own sentinel exclusion becomes unreachable exactly when it is needed,
 *    and every directory on disk (backlog included) is reported as a
 *    current-milestone phase. That degrade is the #3167 symptom path.
 *
 * 2. The sentinel predicate is the canonical `isSentinelPhaseId`
 *    (`src/phase-id.cts`, SENTINEL_RANGES [0, 999]), not a local literal.
 *    The rule had five copies and three different regexes before this phase,
 *    and they disagreed about Phase 0.
 *
 * The pass-all degrade is narrowed MINIMALLY: it stays over-inclusive for
 * non-sentinel directories, so a project whose window declares no phases
 * still sees its real phase directories. Only sentinels are refused.
 *
 * `scope` distinguishes a REAL empty from a NON-answer (ADR-3180 Decision 2):
 * an absent `phasesDir` is a real empty (a new project genuinely has no
 * phases) and inherits the window's scope, whereas a `phasesDir` that exists
 * but cannot be read is UNREADABLE.
 *
 * `opts.ws` is tri-state, matching `planningDir`'s own contract: `undefined`
 * (the default — do not pass `ws` at all) resolves the AMBIENT workstream
 * from `GSD_WORKSTREAM`; `null` FORCES the project root regardless of any
 * ambient workstream; a string forces that specific workstream.
 */
function listMilestonePhaseDirs(phasesDir, opts = {}) {
    // #3597: `ws` must default to `undefined`, NOT `null`. `undefined` means
    // "resolve the ambient workstream" (mirrors planningDir's own contract,
    // src/planning-workspace.cts:124); `null` means "force the project root".
    // Every cwd-bearing caller derives `phasesDir` ambiently (planningPaths(cwd)
    // / planningDir(cwd) with no explicit ws), so defaulting `ws` to `null` here
    // forced the milestone WINDOW to the root ROADMAP while the caller's
    // `phasesDir` stayed workstream-scoped — numerator and denominator drawn
    // from different scoped sets (ADR-3180 §7.6 rule 3 violation). That is what
    // made `--ws <name> progress` read `phase_scope: "unreadable"` and withhold
    // `percent` once `workstream create` migrated the root ROADMAP away.
    const { cwd, ws, versionOverride = null, phaseIdConvention = null } = opts;
    // Without a cwd there is nothing to scope AGAINST — the caller asked for an
    // unscoped read, which is a real answer (mirrors extractCurrentMilestoneScoped's
    // row 1). Sentinels are still refused: they are never milestone phases.
    let directoryContext;
    let inWindow = () => true;
    let scope = SCOPE.COMPLETE;
    if (cwd) {
        directoryContext = phaseDirectoryOptions(cwd, undefined, undefined, ws);
        const filter = getMilestonePhaseFilter(cwd, versionOverride, phaseIdConvention, ws, directoryContext);
        inWindow = filter;
        scope = filter.scope;
    }
    // An ABSENT phases dir is a real empty, not a failure: a freshly-created
    // project genuinely has no phase directories yet. Distinguishing this from
    // the unreadable case below is the whole point of the scope discriminator.
    if (!node_fs_1.default.existsSync(phasesDir))
        return { value: [], scope };
    let names;
    try {
        names = node_fs_1.default.readdirSync(phasesDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
    }
    catch {
        // The directory EXISTS but could not be read (EACCES/EIO). An empty list
        // here is a NON-answer and must not be reported as "this milestone has no
        // phases" — that collapse is the defect class this epic removes.
        return { value: [], scope: SCOPE.UNREADABLE };
    }
    const value = names
        .filter((name) => inWindow(name) && !isSentinelPhaseId(name, phaseIdConvention ?? undefined))
        .sort((a, b) => comparePhaseNum(a, b, directoryContext));
    return { value, scope };
}
/**
 * #3882 (ADR-3473 §8.2, issue #3882): the single owner of "the PHYSICAL set
 * of phase directories on disk, entirely un-windowed" — the OTHER axis
 * `listMilestonePhaseDirs` above deliberately does not offer. That owner
 * refuses sentinels UNCONDITIONALLY (see its own doc comment); it has no way
 * to say "physical set, sentinels included". That is exactly what an
 * archival, lookup-index, or health-sweep caller needs — e.g. a heading ->
 * directory lookup index that must resolve a directory regardless of
 * milestone window (`cmdRoadmapAnalyze`'s `_phaseDirNames`,
 * `cmdInitMilestoneOp`'s `diskPhaseDirs`) — which is why those callers used
 * to hand-roll a `readdirSync` instead of calling either owner.
 *
 * `includeSentinels` is REQUIRED, with no default value. #3882/ADR-3473 §8.2:
 * "a caller that wants sentinels asks for them explicitly" — obtaining
 * sentinel-inclusion by silent omission is exactly the defect class this
 * axis exists to close, so the call site is refused at COMPILE TIME without
 * it, not merely documented against it here.
 *
 * Mirrors `listMilestonePhaseDirs`'s own absent/unreadable handling
 * (ADR-3180 Decision 2): an ABSENT `phasesDir` is a real empty (a project
 * with no phase directories yet), `scope: SCOPE.COMPLETE`; a `phasesDir`
 * that EXISTS but cannot be read is a NON-answer, `scope: SCOPE.UNREADABLE`
 * — a caller must not treat that empty list as "this project has no
 * phases."
 */
function listAllPhaseDirs(phasesDir, opts) {
    const { includeSentinels, phaseIdConvention = null } = opts;
    if (!node_fs_1.default.existsSync(phasesDir))
        return { value: [], scope: SCOPE.COMPLETE };
    let names;
    try {
        names = node_fs_1.default.readdirSync(phasesDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
    }
    catch {
        return { value: [], scope: SCOPE.UNREADABLE };
    }
    const value = names
        .filter((name) => includeSentinels || !isSentinelPhaseId(name, phaseIdConvention ?? undefined))
        .sort((a, b) => comparePhaseNum(a, b));
    return { value, scope: SCOPE.COMPLETE };
}
function getArchivedPhaseDirs(cwd, wsOverride) {
    // #2855: same workstream-scoped resolution as findPhaseInternal above, via
    // the shared listArchiveVersionDirs helper. `phase.list --include-archived`
    // (the primary non-init consumer) must not leak a different workstream's
    // archive either.
    const results = [];
    for (const { version, archivePath } of listArchiveVersionDirs(cwd, wsOverride)) {
        const dirs = readSubdirectories(archivePath, true);
        for (const dir of dirs) {
            results.push({
                name: dir,
                milestone: version,
                basePath: toPosixPath(node_path_1.default.relative(cwd, archivePath)),
                fullPath: node_path_1.default.join(archivePath, dir),
            });
        }
    }
    return results;
}
/**
 * #3804 — the CROSS-WORKSTREAM archive enumeration the audit surfaces need.
 * getArchivedPhaseDirs above is deliberately #2855-SCOPED (an ambient
 * workstream must not leak other trees' phases to findPhaseInternal), but
 * audit-uat's charter (#2766: outstanding items do not stop mattering) is
 * cross-workstream: enumerate the project root plus every workstream's own
 * milestones tree, labeling workstream entries '<ws>/<version>' so
 * acknowledge-by-label stays unambiguous. Deduped by full path (the same
 * tree cannot be reached twice, but the guard keeps the invariant explicit).
 */
function getAllArchivedPhaseDirs(cwd) {
    const out = [];
    const seen = new Set();
    const collect = (labelPrefix, wsOverride) => {
        for (const archived of getArchivedPhaseDirs(cwd, wsOverride)) {
            const rel = toPosixPath(node_path_1.default.relative(cwd, archived.fullPath));
            if (seen.has(rel))
                continue;
            seen.add(rel);
            out.push({ ...archived, milestone: `${labelPrefix}${archived.milestone}` });
        }
    };
    collect('', null);
    const workstreamsDir = node_path_1.default.join(planningRoot(cwd), 'workstreams');
    try {
        const wsEntries = node_fs_1.default.readdirSync(workstreamsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort()
            .reverse();
        for (const ws of wsEntries) {
            collect(`${ws}/`, ws);
        }
    }
    catch {
        /* no workstreams dir — the root pass above already ran */
    }
    return out;
}
module.exports = {
    createPhaseDirectories,
    phaseDirectoryOptions,
    phaseDirectoryContextForRoot,
    customPhaseNamingUsage,
    searchPhaseInDir,
    resolvePhaseDirectoryLookup,
    matchPhaseDirsForLookup,
    findPhaseInternal,
    getArchivedPhaseDirs,
    getAllArchivedPhaseDirs,
    listMilestonePhaseDirs,
    listAllPhaseDirs,
};
