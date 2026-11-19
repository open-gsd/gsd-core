"use strict";
/**
 * Task command router — is-behavior-adding subcommand handler.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/task-command-router.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const security_cjs_1 = require("./security.cjs");
const tdd_test_files_cjs_1 = require("./tdd-test-files.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ioMod = require("./io.cjs");
const { output, error, ERROR_REASON } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planDocumentMod = require("./plan-document.cjs");
const { parsePlanDocument } = planDocumentMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const taskContentResolutionMod = require("./task-content-resolution.cjs");
const { resolveTaskContent, loadResolverCapabilities, isResolverFailure, } = taskContentResolutionMod;
// ─── Implementation ───────────────────────────────────────────────────────────
function isBehaviorAddingTaskContent(content) {
    const tddTrue = /\btdd\s*=\s*["']true["']/i.test(content);
    const behaviorMatch = content.match(/<behavior>([\s\S]*?)<\/behavior>/i);
    const hasBehaviorBlock = Boolean(behaviorMatch && behaviorMatch[1].trim().length > 0);
    const filesMatch = content.match(/<files>([\s\S]*?)<\/files>/i);
    let hasSourceFiles = false;
    if (filesMatch) {
        const fileLines = filesMatch[1]
            .split(/[\n,]/)
            .map((line) => line.trim().replace(/^[-*]\s*/, ''))
            .filter(Boolean);
        hasSourceFiles = fileLines.some((file) => !/\.md$/i.test(file) &&
            !/\.json$/i.test(file) &&
            !(0, tdd_test_files_cjs_1.isTestFilePath)(file) &&
            !/\.(yml|yaml|toml|ini|cfg|conf|properties)$/i.test(file) &&
            !/(^|[\\/])\.env(\..+)?$/i.test(file));
    }
    const isBehaviorAdding = tddTrue && hasBehaviorBlock && hasSourceFiles;
    const missing = [];
    if (!tddTrue)
        missing.push('tdd="true" frontmatter absent');
    if (!hasBehaviorBlock)
        missing.push('<behavior> block missing or empty');
    if (!hasSourceFiles)
        missing.push('<files> has no non-test source file');
    return {
        is_behavior_adding: isBehaviorAdding,
        checks: {
            tdd_true: tddTrue,
            has_behavior_block: hasBehaviorBlock,
            has_source_files: hasSourceFiles,
        },
        reason: isBehaviorAdding ? null : `Not behavior-adding: ${missing.join('; ')}`,
    };
}
function parseResolveContentArgs(args) {
    let plan = null;
    let taskId = null;
    for (let i = 2; i < args.length; i++) {
        if (args[i] === '--plan') {
            plan = args[i + 1] ?? null;
            i++;
        }
        else if (args[i] === '--task-id') {
            taskId = args[i + 1] ?? null;
            i++;
        }
    }
    return { plan, taskId };
}
/**
 * `task resolve-content --plan <PLAN.md path> --task-id <tracker-id value> --raw`
 * (ADR-3646 Decision 2). Resolves one task's content from the external
 * tracker its `tracker-id` attribute names, via `task-content-resolution.cts`.
 *
 * HARD-HALT CONTRACT: a thrown resolver failure (`isResolverFailure`) from
 * `resolveTaskContent` is turned into this CLI's own non-zero exit via
 * `error()` — never swallowed into a `{resolved: false}` JSON answer. Any
 * other thrown error is not a documented resolver-error class and is allowed to propagate uncaught.
 */
function routeResolveContent({ args, cwd, raw }, deps = {}) {
    const usage = 'Usage: task resolve-content --plan <path> --task-id <tracker-id> --raw';
    const { plan, taskId } = parseResolveContentArgs(args);
    if (!plan || !taskId) {
        error(usage, ERROR_REASON.USAGE);
        return;
    }
    const projectRoot = node_path_1.default.resolve(cwd || process.cwd());
    // Lexical containment (ADR-4650): this path is validated before existence is
    // checked below, so realpath resolution is neither available nor required.
    const contained = (0, security_cjs_1.tryWithinRootLexical)(plan, projectRoot);
    if (contained === null) {
        error(`Plan file is outside project scope: ${plan}`, ERROR_REASON.USAGE);
        return;
    }
    const resolvedPlanPath = contained;
    if (!node_fs_1.default.existsSync(resolvedPlanPath)) {
        error(`Plan file not found: ${plan}`, ERROR_REASON.USAGE);
        return;
    }
    const planContent = node_fs_1.default.readFileSync(resolvedPlanPath, 'utf-8');
    const parsedPlan = parsePlanDocument(planContent, resolvedPlanPath);
    const task = (parsedPlan.tasks ?? []).find((t) => t.trackerId === taskId);
    if (!task) {
        error(`No task with tracker-id '${taskId}' found in plan: ${plan}`, ERROR_REASON.USAGE);
        return;
    }
    const loadCapabilities = deps.loadCapabilities ?? loadResolverCapabilities;
    const capabilities = loadCapabilities(projectRoot);
    const resolveFn = deps.resolveTaskContentFn ?? resolveTaskContent;
    let result;
    try {
        result = resolveFn({ trackerId: task.trackerId, capabilities });
    }
    catch (err) {
        if (isResolverFailure(err)) {
            error(err.message, ERROR_REASON.UNKNOWN);
            return;
        }
        throw err;
    }
    switch (result.kind) {
        case 'not-applicable':
            output({ resolved: false }, raw, undefined);
            return;
        case 'no-resolver':
            output({ resolved: false, reason: 'no-resolver' }, raw, undefined);
            return;
        case 'empty':
            output({ resolved: false, reason: 'empty' }, raw, undefined);
            return;
        case 'resolved':
            output({ resolved: true, content: result.content }, raw, undefined);
            return;
    }
}
function routeTaskCommand({ args, cwd, raw }) {
    const subcommand = args[1];
    if (subcommand === 'resolve-content') {
        routeResolveContent({ args, cwd, raw });
        return;
    }
    if (subcommand !== 'is-behavior-adding') {
        error('Unknown task subcommand. Available: is-behavior-adding, resolve-content', ERROR_REASON.SDK_UNKNOWN_COMMAND);
    }
    let content = null;
    if (args[2] === '--task-content') {
        content = args[3] || null;
    }
    else if (args[2]) {
        const projectRoot = node_path_1.default.resolve(cwd || process.cwd());
        const requestedPath = args[2];
        // Lexical containment (ADR-4650): validated before existence is checked below.
        // `error()` here does not return/throw (preserved from before this migration),
        // so resolvedTaskPath must still be computed identically on the rejected path.
        const contained = (0, security_cjs_1.tryWithinRootLexical)(requestedPath, projectRoot);
        if (contained === null) {
            error(`Task file is outside project scope: ${requestedPath}`, ERROR_REASON.USAGE);
        }
        const resolvedTaskPath = contained ?? node_path_1.default.resolve(projectRoot, requestedPath);
        if (!node_fs_1.default.existsSync(resolvedTaskPath)) {
            error(`Task file not found: ${requestedPath}`, ERROR_REASON.USAGE);
        }
        content = node_fs_1.default.readFileSync(resolvedTaskPath, 'utf-8');
    }
    if (!content) {
        error('Usage: task.is-behavior-adding <plan-file-path> | --task-content "<xml>"', ERROR_REASON.USAGE);
    }
    output(isBehaviorAddingTaskContent(content), raw, undefined);
}
module.exports = {
    isBehaviorAddingTaskContent,
    routeTaskCommand,
    routeResolveContent,
};
