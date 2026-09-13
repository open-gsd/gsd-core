"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { cleanup } = require("./helpers.cjs");
const { runGit, runNode, runHook } = require("./helpers/process-seam.cjs");
const { GIT_FIXTURE_TIMEOUT_MS, GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS } = require("./helpers/timeouts.cjs");
const { mergePreparedWorktree, teardownMergedWorktree } = require("../gsd-core/bin/lib/worktree-safety.cjs");
const quickBatchV2 = require("../gsd-core/bin/lib/quick-batch-v2.cjs");

function git(cwd, args, env) {
    const result = runGit(args, { cwd, env: env === undefined ? undefined : { ...process.env, ...env }, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    return {
        exitCode: result.exitCode === null ? 1 : result.exitCode,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        timedOut: result.timedOut,
    };
}

function gitExec(args, options) {
    return git(options.cwd, args, options.env);
}

function mustGit(cwd, args) {
    const result = git(cwd, args);
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.trim();
}

function fixture(t, manifestOverrides = {}, options = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gsd-worktree-merge-one-")));
    t.after(() => cleanup(root));
    mustGit(root, ["init", "-b", "main"]);
    mustGit(root, ["config", "user.email", "test@example.invalid"]);
    mustGit(root, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(root, "README.md"), "base\n");
    mustGit(root, ["add", "README.md"]);
    mustGit(root, ["commit", "-m", "base"]);
    const expectedBase = mustGit(root, ["rev-parse", "HEAD"]);
    const worktreeRoot = options.native ? path.join(root, ".claude", "worktrees") : path.join(root, "worktrees");
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const worktreePath = path.join(worktreeRoot, "agent-one");
    const branch = "worktree-agent-one";
    mustGit(root, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
    fs.writeFileSync(path.join(worktreePath, "child.txt"), "child\n");
    mustGit(worktreePath, ["add", "child.txt"]);
    mustGit(worktreePath, ["commit", "-m", "child"]);
    const childTip = mustGit(worktreePath, ["rev-parse", "HEAD"]);
    const entry = {
        agent_id: "agent-one",
        worktree_path: worktreePath,
        branch,
        expected_base: expectedBase,
        files_modified: ["child.txt"],
        ...manifestOverrides,
    };
    return { root, expectedBase, worktreeRoot, worktreePath, branch, childTip, manifest: { worktrees: [entry] } };
}

function installNativeJournal(f, overrides = {}) {
    const parent = "ses-parent";
    const batch = "batch-native";
    const round = 1;
    const item = "260101-abc";
    const manifestPath = quickBatchV2.manifestPath(f.root, parent, batch, round);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const identity = { wave_id: "wave-1", manifest_agent_id: "agent-one", directory: f.worktreePath, branch: f.branch, expected_base: f.expectedBase, manifest_path: manifestPath };
    const digest = "trusted-status-digest";
    const targetTip = overrides.targetTip ?? f.expectedBase;
    const executor = { session_id: "ses-child", parent_session_id: parent, directory: f.worktreePath, manifest_agent_id: "agent-one", agent: "gsd-executor", provider: "openai", model: "gpt-5.6-sol", variant: "high", final_permission: { action: "gsd_worktree_task", resource: "*", effect: "deny" } };
    const checkedAt = overrides.checkedAt ?? Date.now();
    const journalItem = { item_id: item, phase: "merge_intent", identity, session_id: "ses-child", status_digest: digest, executor_identity: executor, created_manifest_entry_hash: "created", outcome: null, verification_receipt: null, events: [
        { phase: "attested", event: { wave_id: "wave-1", session_id: "ses-child", manifest_entry_hash: "entry", status_digest: digest, checked_at: checkedAt, executor_identity: executor, provenance: { source: overrides.provenanceSource ?? "opencode_plugin_rpc_v1", rpc_id: "gsd-worktree-task.attestation.v1", rpc_method: "status", service_version: "2.0.3", expected_revision: 6 } } },
        { phase: "merge_intent", event: { branch_tip: f.childTip, target_tip: targetTip, status_digest: digest } },
    ] };
    const seed = { parent_session_id: parent, batch_id: batch, round, transport: "native-tool", runtime: "opencode-v2", validation_required: false, items: { [item]: journalItem }, orchestrator_root: f.root };
    fs.writeFileSync(quickBatchV2.indexPath(f.root, parent, batch), JSON.stringify({ version: 3, parent_session_id: parent, batch_id: batch, next_round: 2, active: { round, seed }, receipts: [] }));
    fs.writeFileSync(quickBatchV2.roundPath(f.root, parent, batch, round), JSON.stringify({ version: 3, ...seed, revision: 7 }));
    fs.writeFileSync(manifestPath, JSON.stringify({ orchestrator_root: f.root, transport: "native-tool", runtime: "opencode-v2", parent_session_id: parent, batch_id: batch, round, worktrees: f.manifest.worktrees }));
    return { parent, batch, round, item, manifestPath, digest, targetTip, revision: 7 };
}

function input(f, overrides = {}) {
    return {
        manifest: f.manifest,
        actualManifestAgentId: "agent-one",
        canonicalWorktreePath: f.worktreePath,
        branch: f.branch,
        targetRoot: f.root,
        worktreeRoot: f.worktreeRoot,
        ...overrides,
    };
}

test("prepare returns immutable tips without mutation", (t) => {
    const f = fixture(t);
    const before = mustGit(f.root, ["rev-parse", "HEAD"]);
    const result = mergePreparedWorktree(input(f, { prepare: true }), { execGit: gitExec });
    assert.equal(result.status, "prepared");
    assert.equal(result.child_tip, f.childTip);
    assert.equal(result.target_tip, before);
    assert.equal(mustGit(f.root, ["rev-parse", "HEAD"]), before);
    assert.equal(fs.existsSync(f.worktreePath), true);
});

test("native authorization that is 29s old cannot mutate after slow preflight crosses its deadline", (t) => {
    const f = fixture(t);
    let now = 29_000;
    const calls = [];
    const result = mergePreparedWorktree(input(f, {
        expectedChildTip: f.childTip,
        expectedTargetTip: f.expectedBase,
        authorizationDeadlineMs: 30_000,
        authorizeBeforeTargetCas: () => true,
    }), {
        execGit(args, options) { calls.push(args); return gitExec(args, options); },
        now: () => now,
        beforeMerge: () => { now = 30_001; },
    });
    assert.equal(result.reason, "authorization_expired");
    assert.equal(result.recoverable, true);
    assert.equal(calls.some((args) => args[0] === "update-ref" && args.length === 4), false);
    assert.equal(mustGit(f.root, ["rev-parse", "HEAD"]), f.expectedBase);
    assert.equal(fs.existsSync(f.worktreePath), true);
});

test("merge preserves worktree and branch, then teardown-one removes them", (t) => {
    const f = fixture(t);
    const result = mergePreparedWorktree(input(f, { expectedChildTip: f.childTip, expectedTargetTip: f.expectedBase }), { execGit: gitExec });
    assert.equal(result.status, "merged");
    assert.notEqual(result.merge_tip, result.target_tip);
    assert.equal(fs.existsSync(f.worktreePath), true);
    assert.equal(git(f.root, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`]).exitCode, 0);
    const teardownCalls = [];
    const teardown = teardownMergedWorktree({
        ...input(f),
        mergedChildTip: f.childTip,
    }, { execGit(args, options) { teardownCalls.push(args); return gitExec(args, options); } });
    assert.equal(teardown.status, "removed");
    assert.equal(fs.existsSync(f.worktreePath), false);
    assert.ok(teardownCalls.some((args) => JSON.stringify(args) === JSON.stringify(["worktree", "remove", f.worktreePath])));
    assert.equal(teardownCalls.some((args) => args[0] === "worktree" && args[1] === "remove" && args.includes("--force")), false);
    assert.ok(teardownCalls.some((args) => JSON.stringify(args) === JSON.stringify([
        "update-ref", "-d", `refs/heads/${f.branch}`, f.childTip,
    ])));
});

test("rejects a branch tip changed after prepare", (t) => {
    const f = fixture(t);
    const prepared = mergePreparedWorktree(input(f, { prepare: true }), { execGit: gitExec });
    fs.writeFileSync(path.join(f.worktreePath, "later.txt"), "later\n");
    mustGit(f.worktreePath, ["add", "later.txt"]);
    mustGit(f.worktreePath, ["commit", "-m", "later"]);
    const result = mergePreparedWorktree(input(f, { expectedChildTip: prepared.child_tip, expectedTargetTip: prepared.target_tip }), { execGit: gitExec });
    assert.equal(result.reason, "child_tip_mismatch");
    assert.equal(mustGit(f.root, ["rev-parse", "HEAD"]), prepared.target_tip);
});

test("merges the immutable expected child SHA when the branch moves before target CAS", (t) => {
    const f = fixture(t);
    let movedTip;
    const result = mergePreparedWorktree(input(f, {
        expectedChildTip: f.childTip,
        expectedTargetTip: f.expectedBase,
    }), {
        execGit: gitExec,
        beforeMerge() {
            const tree = mustGit(f.root, ["rev-parse", `${f.childTip}^{tree}`]);
            movedTip = mustGit(f.root, ["commit-tree", tree, "-p", f.childTip, "-m", "racing branch move"]);
            mustGit(f.root, ["update-ref", `refs/heads/${f.branch}`, movedTip, f.childTip]);
        },
    });
    assert.equal(result.status, "merged", result.stderr);
    assert.equal(mustGit(f.root, ["merge-base", "--is-ancestor", f.childTip, "HEAD"]), "");
    assert.notEqual(mustGit(f.root, ["rev-parse", "HEAD^2"]), movedTip);
    assert.equal(mustGit(f.root, ["rev-parse", "HEAD^2"]), f.childTip);
});

test("teardown preserves a branch that advanced beyond the recorded merged child", (t) => {
    const f = fixture(t);
    const merged = mergePreparedWorktree(input(f, { expectedChildTip: f.childTip, expectedTargetTip: f.expectedBase }), { execGit: gitExec });
    assert.equal(merged.status, "merged");
    fs.writeFileSync(path.join(f.worktreePath, "later.txt"), "later\n");
    mustGit(f.worktreePath, ["add", "later.txt"]);
    mustGit(f.worktreePath, ["commit", "-m", "later unmerged work"]);

    const teardown = teardownMergedWorktree({ ...input(f), mergedChildTip: f.childTip }, { execGit: gitExec });
    assert.equal(teardown.reason, "child_tip_mismatch");
    assert.equal(fs.existsSync(f.worktreePath), true);
    assert.equal(git(f.root, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`]).exitCode, 0);
});

test("already merged retry is idempotent and ignores the obsolete base gate", (t) => {
    const f = fixture(t);
    const first = mergePreparedWorktree(input(f, { expectedChildTip: f.childTip, expectedTargetTip: f.expectedBase }), { execGit: gitExec });
    f.manifest.worktrees[0].expected_base = "0000000000000000000000000000000000000000";
    f.manifest.worktrees[0].allowed_bases = [f.manifest.worktrees[0].expected_base];
    const repeated = mergePreparedWorktree(input(f, { expectedChildTip: f.childTip, expectedTargetTip: first.target_tip }), { execGit: gitExec });
    assert.equal(repeated.status, "already_merged", `${repeated.reason}: ${repeated.stderr}`);
    assert.equal(repeated.merge_tip, first.merge_tip);
    assert.equal(fs.existsSync(f.worktreePath), true);
});

test("blocks scope, base, and dirty worktrees", (t) => {
    const scope = fixture(t, { files_modified: ["other.txt"] });
    assert.equal(mergePreparedWorktree(input(scope, { prepare: true }), { execGit: gitExec }).reason, "scope_out_of_declared");

    const base = fixture(t, { expected_base: "0000000000000000000000000000000000000000", allowed_bases: [] });
    assert.equal(mergePreparedWorktree(input(base, { prepare: true }), { execGit: gitExec }).reason, "base_mismatch");

    const dirty = fixture(t);
    fs.writeFileSync(path.join(dirty.worktreePath, "dirty.txt"), "dirty\n");
    assert.equal(mergePreparedWorktree(input(dirty, { prepare: true }), { execGit: gitExec }).reason, "worktree_dirty");
});

test("blocks undeclared deletions", (t) => {
    const f = fixture(t, { files_modified: ["child.txt", "README.md"] });
    fs.unlinkSync(path.join(f.worktreePath, "README.md"));
    mustGit(f.worktreePath, ["add", "README.md"]);
    mustGit(f.worktreePath, ["commit", "-m", "delete undeclared file"]);
    const result = mergePreparedWorktree(input(f, { prepare: true }), { execGit: gitExec });
    assert.equal(result.reason, "branch_contains_deletions");
    assert.equal(fs.existsSync(f.worktreePath), true);
});

test("failed merge aborts target merge state and preserves worktree and branch", (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, "child.txt"), "target conflict\n");
    mustGit(f.root, ["add", "child.txt"]);
    mustGit(f.root, ["commit", "-m", "conflicting target change"]);
    const targetTip = mustGit(f.root, ["rev-parse", "HEAD"]);
    const result = mergePreparedWorktree(input(f, { expectedChildTip: f.childTip, expectedTargetTip: targetTip }), { execGit: gitExec });
    assert.equal(result.reason, "merge_failed");
    assert.equal(mustGit(f.root, ["rev-parse", "HEAD"]), targetTip);
    assert.notEqual(git(f.root, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]).exitCode, 0);
    assert.equal(fs.existsSync(f.worktreePath), true);
    assert.equal(git(f.root, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`]).exitCode, 0);
});

test("requires exact manifest agent and canonical path binding", (t) => {
    const f = fixture(t);
    assert.equal(mergePreparedWorktree(input(f, { prepare: true, actualManifestAgentId: "other" }), { execGit: gitExec }).reason, "manifest_identity_mismatch");
    assert.equal(mergePreparedWorktree(input(f, { prepare: true, canonicalWorktreePath: path.join(f.worktreeRoot, "other") }), { execGit: gitExec }).reason, "manifest_entry_ambiguous");
    assert.equal(mergePreparedWorktree(input(f, { prepare: true, canonicalWorktreePath: path.relative(f.root, f.worktreePath) }), { execGit: gitExec }).reason, "worktree_path_not_canonical");

    const aliasRoot = path.join(f.root, "worktrees-alias");
    try {
        fs.symlinkSync(f.worktreeRoot, aliasRoot, "dir");
    } catch (error) {
        if (error && (error.code === "EPERM" || error.code === "EACCES")) return;
        throw error;
    }
    const aliasPath = path.join(aliasRoot, "agent-one");
    const aliasManifest = structuredClone(f.manifest);
    aliasManifest.worktrees[0].worktree_path = aliasPath;
    const result = mergePreparedWorktree(input(f, {
        prepare: true,
        manifest: aliasManifest,
        canonicalWorktreePath: aliasPath,
        worktreeRoot: aliasRoot,
    }), { execGit: gitExec });
    assert.equal(result.reason, "worktree_path_not_canonical");
});

test("CLI prepare and merge require exact flags and preserve resources", (t) => {
    const f = fixture(t);
    const manifestPath = path.join(f.root, ".git", "merge-one-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(f.manifest));
    const cli = path.resolve(__dirname, "../gsd-core/bin/gsd-tools.cjs");
    const common = [
        cli, "query", "worktree.merge-one",
        "--manifest-path", manifestPath,
        "--actual-manifest-agent-id", "agent-one",
        "--canonical-worktree-path", f.worktreePath,
        "--branch", f.branch,
        "--target-root", f.root,
        "--worktree-root", f.worktreeRoot,
    ];
    const prepared = runNode([...common, "--prepare"], { cwd: f.root, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
    assert.equal(prepared.exitCode, 0, prepared.stderr);
    const preparedPayload = JSON.parse(prepared.stdout);
    assert.equal(preparedPayload.status, "prepared");
    const merged = runNode([...common,
        "--expected-child-tip", preparedPayload.child_tip,
        "--expected-target-tip", preparedPayload.target_tip,
    ], { cwd: f.root, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
    assert.equal(merged.exitCode, 0, merged.stderr);
    assert.equal(JSON.parse(merged.stdout).status, "merged");
    assert.equal(fs.existsSync(f.worktreePath), true);

    const duplicate = runNode([...common, "--prepare", "--prepare"], { cwd: f.root, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
    assert.notEqual(duplicate.exitCode, 0);
    const missingTips = runNode(common, { cwd: f.root, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
    assert.notEqual(missingTips.exitCode, 0);
    const missingTarget = runNode([...common, "--expected-child-tip", preparedPayload.child_tip], {
        cwd: f.root,
        timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS,
    });
    assert.notEqual(missingTarget.exitCode, 0);
});

test("native CLI mutation requires fresh journal authorization and records merge plus teardown", (t) => {
    const f = fixture(t, {}, { native: true });
    assert.equal(f.worktreeRoot, path.join(f.root, ".claude", "worktrees"));
    const native = installNativeJournal(f);
    const cli = path.resolve(__dirname, "../gsd-core/bin/gsd-tools.cjs");
    const legacy = runNode([cli, "query", "worktree.merge-one", "--manifest-path", native.manifestPath, "--actual-manifest-agent-id", "agent-one", "--canonical-worktree-path", f.worktreePath, "--branch", f.branch, "--target-root", f.root, "--worktree-root", f.worktreeRoot, "--expected-child-tip", f.childTip, "--expected-target-tip", f.expectedBase], { cwd: f.root, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
    assert.notEqual(legacy.exitCode, 0);
    assert.match(legacy.stderr, /requires quick-batch v2-merge journal authorization/);
    assert.equal(mustGit(f.root, ["rev-parse", "HEAD"]), f.expectedBase);
    const copiedManifest = path.join(f.root, "copied-without-native-metadata.json");
    fs.writeFileSync(copiedManifest, JSON.stringify(f.manifest));
    const stripped = runNode([cli, "query", "worktree.merge-one", "--manifest-path", copiedManifest, "--actual-manifest-agent-id", "agent-one", "--canonical-worktree-path", f.worktreePath, "--branch", f.branch, "--target-root", f.root, "--worktree-root", f.worktreeRoot, "--expected-child-tip", f.childTip, "--expected-target-tip", f.expectedBase], { cwd: f.root, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
    assert.notEqual(stripped.exitCode, 0);
    assert.match(stripped.stderr, /requires quick-batch v2-merge journal authorization/);

    const merged = runNode([cli, "quick-batch", "v2-merge", "--parent-session", native.parent, "--batch", native.batch, "--round", String(native.round), "--item", native.item, "--expected-revision", String(native.revision), "--manifest-path", native.manifestPath, "--manifest-agent-id", "agent-one", "--worktree-path", f.worktreePath, "--branch", f.branch, "--expected-child-tip", f.childTip, "--expected-target-tip", f.expectedBase, "--status-digest", native.digest], { cwd: f.root, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
    assert.equal(merged.exitCode, 0, merged.stderr);
    const mergePayload = JSON.parse(merged.stdout);
    assert.equal(mergePayload.merge.status, "merged", mergePayload.merge.reason);
    assert.equal(mergePayload.journal.items[native.item].phase, "merged");

    const intent = quickBatchV2.transition(f.root, native.parent, native.batch, native.round, native.item, "teardown_pending", {}, mergePayload.journal.revision);
    assert.equal(intent.ok, true, intent.reason);
    const teardown = runNode([cli, "quick-batch", "v2-teardown", "--parent-session", native.parent, "--batch", native.batch, "--round", String(native.round), "--item", native.item, "--expected-revision", String(intent.value.journal.revision), "--manifest-path", native.manifestPath, "--manifest-agent-id", "agent-one", "--worktree-path", f.worktreePath, "--branch", f.branch, "--merged-child-tip", f.childTip], { cwd: f.root, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
    assert.equal(teardown.exitCode, 0, teardown.stderr);
    const teardownPayload = JSON.parse(teardown.stdout);
    assert.equal(teardownPayload.teardown.status, "removed");
    assert.equal(teardownPayload.journal.items[native.item].phase, "removed");
    const replay = runNode([cli, "quick-batch", "v2-teardown", "--parent-session", native.parent, "--batch", native.batch, "--round", String(native.round), "--item", native.item, "--expected-revision", String(intent.value.journal.revision), "--manifest-path", native.manifestPath, "--manifest-agent-id", "agent-one", "--worktree-path", f.worktreePath, "--branch", f.branch, "--merged-child-tip", f.childTip], { cwd: f.root, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
    assert.equal(replay.exitCode, 0, replay.stderr);
    assert.equal(JSON.parse(replay.stdout).idempotent, true);
    const conflict = quickBatchV2.teardownAuthorized(f.root, native.parent, native.batch, native.round, native.item, intent.value.journal.revision, {
        manifest_path: native.manifestPath, manifest_agent_id: "agent-one", worktree_path: f.worktreePath, branch: f.branch, merged_child_tip: f.expectedBase,
    });
    assert.equal(conflict.ok, false);
});

test("v2-teardown reconciles a crash after external removal but before journal transition", (t) => {
    const f = fixture(t, {}, { native: true });
    const native = installNativeJournal(f);
    const merged = quickBatchV2.mergeAuthorized(f.root, native.parent, native.batch, native.round, native.item, native.revision, {
        manifest_path: native.manifestPath, manifest_agent_id: "agent-one", worktree_path: f.worktreePath, branch: f.branch,
        expected_child_tip: f.childTip, expected_target_tip: f.expectedBase, status_digest: native.digest,
    });
    assert.equal(merged.ok, true, merged.reason);
    const pending = quickBatchV2.transition(f.root, native.parent, native.batch, native.round, native.item, "teardown_pending", {}, merged.value.journal.revision);
    assert.equal(pending.ok, true, pending.reason);
    const removed = teardownMergedWorktree({ ...input(f), manifest: JSON.parse(fs.readFileSync(native.manifestPath, "utf8")), mergedChildTip: f.childTip }, { execGit: gitExec });
    assert.equal(removed.status, "removed");
    const reconciled = quickBatchV2.teardownAuthorized(f.root, native.parent, native.batch, native.round, native.item, pending.value.journal.revision, {
        manifest_path: native.manifestPath, manifest_agent_id: "agent-one", worktree_path: f.worktreePath, branch: f.branch, merged_child_tip: f.childTip,
    });
    assert.equal(reconciled.ok, true, reconciled.reason);
    assert.equal(reconciled.value.teardown.status, "already_removed");
    assert.equal(reconciled.value.journal.items[native.item].phase, "removed");
});

test("legacy cleanup-wave pre-scans a stripped mixed manifest and performs zero mutation when any entry is native", (t) => {
    const f = fixture(t, {}, { native: true });
    installNativeJournal(f);
    const processRoot = path.join(f.root, "worktrees");
    fs.mkdirSync(processRoot);
    const processPath = path.join(processRoot, "process-one");
    const processBranch = "worktree-agent-process-one";
    mustGit(f.root, ["worktree", "add", "-b", processBranch, processPath, f.expectedBase]);
    fs.writeFileSync(path.join(processPath, "process.txt"), "process\n");
    mustGit(processPath, ["add", "process.txt"]);
    mustGit(processPath, ["commit", "-m", "process child"]);
    const callerManifest = path.join(f.root, "stripped-mixed-cleanup.json");
    fs.writeFileSync(callerManifest, JSON.stringify({ worktrees: [
        { agent_id: "process-one", worktree_path: processPath, branch: processBranch, expected_base: f.expectedBase },
        { agent_id: "agent-one", worktree_path: f.worktreePath, branch: f.branch, expected_base: f.expectedBase },
    ] }));
    const before = mustGit(f.root, ["rev-parse", "HEAD"]);
    const cli = path.resolve(__dirname, "../gsd-core/bin/gsd-tools.cjs");
    const result = runNode([cli, "query", "worktree.cleanup-wave", "--manifest", callerManifest], { cwd: f.root, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /requires per-item quick-batch v2 journal authorization/);
    assert.equal(mustGit(f.root, ["rev-parse", "HEAD"]), before);
    for (const [worktreePath, branch] of [[processPath, processBranch], [f.worktreePath, f.branch]]) {
        assert.equal(fs.existsSync(worktreePath), true);
        assert.equal(git(f.root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode, 0);
    }
});

test("legacy cleanup-wave keeps process-only manifest behavior", (t) => {
    const f = fixture(t);
    const manifestPath = path.join(f.root, "process-cleanup.json");
    fs.writeFileSync(manifestPath, JSON.stringify(f.manifest));
    const cli = path.resolve(__dirname, "../gsd-core/bin/gsd-tools.cjs");
    const result = runNode([cli, "query", "worktree.cleanup-wave", "--manifest", manifestPath], { cwd: f.root, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.notEqual(mustGit(f.root, ["rev-parse", "HEAD"]), f.expectedBase);
    assert.equal(fs.existsSync(f.worktreePath), false);
    assert.equal(git(f.root, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`]).exitCode, 1);
});

test("native CLI mutation rejects stale, unprovenanced, forged, and old authorization before touching refs", async (t) => {
    for (const [label, journalOverrides, argvOverrides, reason] of [
        ["stale", { checkedAt: Date.now() - 31_000 }, {}, /fresh native OpenCode RPC provenance/],
        ["no provenance", { provenanceSource: "caller_json" }, {}, /fresh native OpenCode RPC provenance/],
        ["forged digest", {}, { digest: "forged" }, /tips or status digest/],
        ["old revision", {}, { revision: "6" }, /stale expected_revision/],
    ]) await t.test(label, () => {
        const f = fixture(t, {}, { native: true });
        const native = installNativeJournal(f, journalOverrides);
        const cli = path.resolve(__dirname, "../gsd-core/bin/gsd-tools.cjs");
        const result = runNode([cli, "quick-batch", "v2-merge", "--parent-session", native.parent, "--batch", native.batch, "--round", "1", "--item", native.item, "--expected-revision", argvOverrides.revision ?? "7", "--manifest-path", native.manifestPath, "--manifest-agent-id", "agent-one", "--worktree-path", f.worktreePath, "--branch", f.branch, "--expected-child-tip", f.childTip, "--expected-target-tip", f.expectedBase, "--status-digest", argvOverrides.digest ?? native.digest], { cwd: f.root, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
        assert.notEqual(result.exitCode, 0);
        assert.match(result.stderr, reason);
        assert.equal(mustGit(f.root, ["rev-parse", "HEAD"]), f.expectedBase);
        assert.equal(fs.existsSync(f.worktreePath), true);
    });
});

test("authorized native route maps a real merge conflict without consuming refs or journal intent", (t) => {
    const f = fixture(t, {}, { native: true });
    fs.writeFileSync(path.join(f.root, "child.txt"), "target conflict\n");
    mustGit(f.root, ["add", "child.txt"]);
    mustGit(f.root, ["commit", "-m", "conflicting target"]);
    const targetTip = mustGit(f.root, ["rev-parse", "HEAD"]);
    const native = installNativeJournal(f, { targetTip });
    const cli = path.resolve(__dirname, "../gsd-core/bin/gsd-tools.cjs");
    const result = runNode([cli, "quick-batch", "v2-merge", "--parent-session", native.parent, "--batch", native.batch, "--round", "1", "--item", native.item, "--expected-revision", "7", "--manifest-path", native.manifestPath, "--manifest-agent-id", "agent-one", "--worktree-path", f.worktreePath, "--branch", f.branch, "--expected-child-tip", f.childTip, "--expected-target-tip", targetTip, "--status-digest", native.digest], { cwd: f.root, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.merge.reason, "merge_failed");
    assert.equal(payload.journal.items[native.item].phase, "merge_intent");
    assert.equal(mustGit(f.root, ["rev-parse", "HEAD"]), targetTip);
    assert.equal(fs.existsSync(f.worktreePath), true);
    assert.equal(git(f.root, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`]).exitCode, 0);
});

test("authorized native route keeps unsupported signed policy recoverable and nonterminal", (t) => {
    const f = fixture(t, {}, { native: true });
    mustGit(f.root, ["config", "commit.gpgSign", "true"]);
    const native = installNativeJournal(f);
    const cli = path.resolve(__dirname, "../gsd-core/bin/gsd-tools.cjs");
    const result = runNode([cli, "quick-batch", "v2-merge", "--parent-session", native.parent, "--batch", native.batch, "--round", "1", "--item", native.item, "--expected-revision", "7", "--manifest-path", native.manifestPath, "--manifest-agent-id", "agent-one", "--worktree-path", f.worktreePath, "--branch", f.branch, "--expected-child-tip", f.childTip, "--expected-target-tip", f.expectedBase, "--status-digest", native.digest], { cwd: f.root, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.merge.reason, "unsupported_policy");
    assert.equal(payload.merge.recoverable, true);
    assert.equal(payload.journal.items[native.item].phase, "merge_intent");
    assert.equal(mustGit(f.root, ["rev-parse", "HEAD"]), f.expectedBase);
    assert.equal(fs.existsSync(f.worktreePath), true);
});

test("rejects deterministic target movement immediately before merge", (t) => {
    const f = fixture(t);
    const prepared = mergePreparedWorktree(input(f, { prepare: true }), { execGit: gitExec });
    let movedTarget;
    const result = mergePreparedWorktree(input(f, {
        expectedChildTip: prepared.child_tip,
        expectedTargetTip: prepared.target_tip,
    }), {
        execGit: gitExec,
        beforeMerge() {
            fs.writeFileSync(path.join(f.root, "target-race.txt"), "target moved\n");
            mustGit(f.root, ["add", "target-race.txt"]);
            mustGit(f.root, ["commit", "-m", "deterministic target race"]);
            movedTarget = mustGit(f.root, ["rev-parse", "HEAD"]);
        },
    });

    assert.equal(result.reason, "target_tip_mismatch");
    assert.equal(mustGit(f.root, ["rev-parse", "HEAD"]), movedTarget);
    assert.notEqual(git(f.root, ["merge-base", "--is-ancestor", f.childTip, "HEAD"]).exitCode, 0);
});

test("preserves concurrent target dirt after CAS and reconciles safely on retry", (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, ".git", "info", "exclude"), "child.txt\n");
    const prepared = mergePreparedWorktree(input(f, { prepare: true }), { execGit: gitExec });
    const racedFile = path.join(f.root, "child.txt");
    const pending = mergePreparedWorktree(input(f, {
        expectedChildTip: prepared.child_tip,
        expectedTargetTip: prepared.target_tip,
    }), {
        execGit: gitExec,
        afterMergeCas() { fs.writeFileSync(racedFile, "local data\n"); },
    });
    assert.equal(pending.status, "merged_sync_pending");
    assert.equal(pending.recoverable, true);
    assert.equal(fs.readFileSync(racedFile, "utf8"), "local data\n");
    assert.equal(mustGit(f.root, ["rev-parse", "HEAD"]), pending.merge_tip);

    fs.unlinkSync(racedFile);
    const reconciled = mergePreparedWorktree(input(f, {
        expectedChildTip: prepared.child_tip,
        expectedTargetTip: prepared.target_tip,
    }), { execGit: gitExec });
    assert.equal(reconciled.status, "already_merged", `${reconciled.reason}: ${reconciled.stderr}`);
    assert.equal(git(f.root, ["diff", "--quiet", "HEAD"]).exitCode, 0);
    assert.equal(fs.readFileSync(path.join(f.root, "child.txt"), "utf8"), "child\n");
});

test("blocks an existing ignored path that the merge would start tracking", (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, ".git", "info", "exclude"), "child.txt\n");
    const local = path.join(f.root, "child.txt");
    fs.writeFileSync(local, "ignored local content\n");
    const prepared = mergePreparedWorktree(input(f, { prepare: true }), { execGit: gitExec });
    assert.equal(prepared.status, "prepared", prepared.reason);

    const result = mergePreparedWorktree(input(f, {
        expectedChildTip: prepared.child_tip,
        expectedTargetTip: prepared.target_tip,
    }), { execGit: gitExec });
    assert.equal(result.reason, "target_local_collision");
    assert.equal(result.collision_path, "child.txt");
    assert.equal(fs.readFileSync(local, "utf8"), "ignored local content\n");
    assert.equal(mustGit(f.root, ["rev-parse", "HEAD"]), prepared.target_tip);
});

test("prepare behaviorally rejects Git without two-argument merge-tree write-tree", (t) => {
    const f = fixture(t);
    let casAttempted = false;
    const result = mergePreparedWorktree(input(f, { prepare: true }), {
        execGit(args, options) {
            if (args[0] === "update-ref") casAttempted = true;
            if (args[0] === "merge-tree" && args[1] === "--write-tree" && args[2] === args[3]) {
                return { exitCode: 129, stdout: "", stderr: "unknown option: --write-tree", timedOut: false };
            }
            return gitExec(args, options);
        },
    });
    assert.equal(result.reason, "unsupported_git_capability");
    assert.equal(casAttempted, false);
    assert.equal(mustGit(f.root, ["rev-parse", "HEAD"]), f.expectedBase);
});

test("prepare rejects only hooks invoked by porcelain non-FF merge", async (t) => {
    for (const hook of ["pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-merge"]) {
        await t.test(hook, () => {
            const f = fixture(t);
            const hookPath = path.join(f.root, ".git", "hooks", hook);
            fs.writeFileSync(hookPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
            const result = mergePreparedWorktree(input(f, { prepare: true }), { execGit: gitExec });
            assert.equal(result.reason, "unsupported_policy");
            assert.match(result.stderr, new RegExp(hook));
        });
    }
    await t.test("core.hooksPath", () => {
        const f = fixture(t);
        const hooks = path.join(f.root, "custom-hooks");
        fs.mkdirSync(hooks);
        fs.writeFileSync(path.join(hooks, "commit-msg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        mustGit(f.root, ["config", "core.hooksPath", hooks]);
        assert.equal(mergePreparedWorktree(input(f, { prepare: true }), { execGit: gitExec }).reason, "unsupported_policy");
    });
    await t.test("executable directory is blocked without opening it", () => {
        const f = fixture(t);
        const hookPath = path.join(f.root, ".git", "hooks", "commit-msg");
        fs.mkdirSync(hookPath, { mode: 0o755 });
        const result = mergePreparedWorktree(input(f, { prepare: true }), { execGit: gitExec });
        assert.equal(result.reason, "unsupported_policy");
        assert.equal(result.recoverable, true);
    });
    await t.test("executable FIFO is blocked without opening it", () => {
        const f = fixture(t);
        const hookPath = path.join(f.root, ".git", "hooks", "post-merge");
        const created = runHook(hookPath, [], { interpreter: "mkfifo", cwd: f.root, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
        if (created.exitCode !== 0) return t.skip("mkfifo is unavailable for special-object regression");
        fs.chmodSync(hookPath, 0o755);
        const result = mergePreparedWorktree(input(f, { prepare: true }), { execGit: gitExec });
        assert.equal(result.reason, "unsupported_policy");
        assert.equal(result.recoverable, true);
    });
    for (const hook of ["pre-commit", "post-commit"]) {
        await t.test(`${hook} does not block merge plumbing`, () => {
            const f = fixture(t);
            const hookPath = path.join(f.root, ".git", "hooks", hook);
            fs.writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
            assert.equal(mergePreparedWorktree(input(f, { prepare: true }), { execGit: gitExec }).status, "prepared");
        });
    }
});

test("raw NUL path inventory preserves whitespace, newline, Unicode, and rename destinations", (t) => {
    const f = fixture(t);
    const unusual = "  renamed\n雪  ";
    mustGit(f.worktreePath, ["mv", "README.md", unusual]);
    mustGit(f.worktreePath, ["commit", "-m", "rename to unusual path"]);
    f.childTip = mustGit(f.worktreePath, ["rev-parse", "HEAD"]);
    f.manifest.worktrees[0].files_modified = ["child.txt", "README.md", unusual];
    f.manifest.worktrees[0].declared_deletions = ["README.md"];
    fs.writeFileSync(path.join(f.root, ".git", "info", "exclude"), "*\n");
    fs.writeFileSync(path.join(f.root, unusual), "ignored local bytes\n");
    let casAttempted = false;
    const result = mergePreparedWorktree(input(f, {
        expectedChildTip: f.childTip,
        expectedTargetTip: f.expectedBase,
    }), {
        execGit(args, options) {
            if (args[0] === "update-ref" && args[1] === "refs/heads/main") casAttempted = true;
            return gitExec(args, options);
        },
    });
    assert.equal(result.reason, "target_local_collision");
    assert.equal(result.collision_path, unusual);
    assert.equal(casAttempted, false);
    assert.equal(fs.readFileSync(path.join(f.root, unusual), "utf8"), "ignored local bytes\n");
});

test("signed merge policy is unsupported after effective mergeOptions ordering", async (t) => {
    await t.test("merge.gpgSign is not a Git merge policy", () => {
        const f = fixture(t);
        mustGit(f.root, ["config", "merge.gpgSign", "true"]);
        mustGit(f.root, ["config", "commit.gpgSign", "false"]);
        const result = mergePreparedWorktree(input(f, { expectedChildTip: f.childTip, expectedTargetTip: f.expectedBase }), { execGit: gitExec });
        assert.equal(result.status, "merged", `${result.reason}: ${result.stderr}`);
        assert.doesNotMatch(mustGit(f.root, ["cat-file", "-p", result.merge_tip]), /^gpgsig /m);
    });
    await t.test("last --no-gpg-sign disables commit.gpgSign", () => {
        const f = fixture(t);
        mustGit(f.root, ["config", "commit.gpgSign", "true"]);
        mustGit(f.root, ["config", "branch.main.mergeOptions", "-S --no-gpg-sign"]);
        const result = mergePreparedWorktree(input(f, { expectedChildTip: f.childTip, expectedTargetTip: f.expectedBase }), { execGit: gitExec });
        assert.equal(result.status, "merged", `${result.reason}: ${result.stderr}`);
        assert.doesNotMatch(mustGit(f.root, ["cat-file", "-p", result.merge_tip]), /^gpgsig /m);
    });
    await t.test("last -S blocks during prepare", () => {
        const f = fixture(t);
        mustGit(f.root, ["config", "commit.gpgSign", "false"]);
        mustGit(f.root, ["config", "branch.main.mergeOptions", "--no-gpg-sign -S"]);
        const prepared = mergePreparedWorktree(input(f, { prepare: true }), { execGit: gitExec });
        assert.equal(prepared.reason, "unsupported_policy");
        assert.equal(prepared.recoverable, true);
    });
    await t.test("--gpg-sign key is also unsupported", () => {
        const f = fixture(t);
        const key = "0123456789ABCDEF";
        mustGit(f.root, ["config", "commit.gpgSign", "false"]);
        mustGit(f.root, ["config", "branch.main.mergeOptions", `--no-gpg-sign --gpg-sign=${key}`]);
        const result = mergePreparedWorktree(input(f, { prepare: true }), { execGit: gitExec });
        assert.equal(result.reason, "unsupported_policy");
        assert.equal(result.recoverable, true);
    });
    await t.test("unsupported option and shell syntax fail closed without execution", () => {
        const f = fixture(t);
        const marker = path.join(f.root, "must-not-exist");
        mustGit(f.root, ["config", "branch.main.mergeOptions", `--strategy=ours;touch ${marker}`]);
        const result = mergePreparedWorktree(input(f, { prepare: true }), { execGit: gitExec });
        assert.equal(result.reason, "unsupported_policy");
        assert.equal(fs.existsSync(marker), false);
    });
});

test("commit.gpgSign blocks before intent and no signing command is attempted", (t) => {
    const f = fixture(t);
    mustGit(f.root, ["config", "commit.gpgSign", "true"]);
    let commitAttempted = false;
    const result = mergePreparedWorktree(input(f, { prepare: true }), {
        execGit(args, options) {
            if (args[0] === "commit-tree") commitAttempted = true;
            return gitExec(args, options);
        },
    });
    assert.equal(result.reason, "unsupported_policy");
    assert.equal(result.recoverable, true);
    assert.equal(commitAttempted, false);
    assert.equal(mustGit(f.root, ["rev-parse", "HEAD"]), f.expectedBase);
});

test("signing policy introduced after prepare remains recoverable after intent", (t) => {
    const f = fixture(t);
    const prepared = mergePreparedWorktree(input(f, { prepare: true }), { execGit: gitExec });
    assert.equal(prepared.status, "prepared");
    mustGit(f.root, ["config", "commit.gpgSign", "true"]);
    let casAttempted = false;
    const result = mergePreparedWorktree(input(f, {
        expectedChildTip: prepared.child_tip,
        expectedTargetTip: prepared.target_tip,
    }), {
        execGit(args, options) {
            if (args[0] === "update-ref" && args[1] === "refs/heads/main") casAttempted = true;
            return gitExec(args, options);
        },
    });
    assert.equal(result.reason, "unsupported_policy");
    assert.equal(result.recoverable, true);
    assert.equal(casAttempted, false);
    assert.equal(mustGit(f.root, ["rev-parse", "HEAD"]), prepared.target_tip);
});

test("lost CAS response and retry accept only the exact regenerated merge OID", (t) => {
    const f = fixture(t);
    let publishedTip;
    let loseResponse = true;
    const execWithLostResponse = (args, options) => {
        if (args[0] === "update-ref" && args[1] === "refs/heads/main") {
            if (!loseResponse) return gitExec(args, options);
            loseResponse = false;
            publishedTip = args[2];
            const published = gitExec(args, options);
            assert.equal(published.exitCode, 0, published.stderr);
            return { exitCode: 1, stdout: "", stderr: "simulated lost CAS response", timedOut: false };
        }
        return gitExec(args, options);
    };

    const first = mergePreparedWorktree(input(f, {
        expectedChildTip: f.childTip,
        expectedTargetTip: f.expectedBase,
    }), { execGit: execWithLostResponse });
    assert.equal(first.status, "already_merged", `${first.reason}: ${first.stderr}`);
    assert.equal(first.merge_tip, publishedTip);

    const retried = mergePreparedWorktree(input(f, {
        expectedChildTip: f.childTip,
        expectedTargetTip: f.expectedBase,
    }), { execGit: execWithLostResponse });
    assert.equal(retried.status, "already_merged", `${retried.reason}: ${retried.stderr}`);
    assert.equal(retried.merge_tip, publishedTip);
});

test("retry rejects an ancestor-based merge with non-exact semantics", (t) => {
    const f = fixture(t);
    const tree = mustGit(f.root, ["merge-tree", "--write-tree", f.expectedBase, f.childTip]);
    const wrong = mustGit(f.root, ["commit-tree", tree, "-p", f.expectedBase, "-p", f.childTip, "-m", "wrong message"]);
    mustGit(f.root, ["update-ref", "refs/heads/main", wrong, f.expectedBase]);
    const result = mergePreparedWorktree(input(f, {
        expectedChildTip: f.childTip,
        expectedTargetTip: f.expectedBase,
    }), { execGit: gitExec });
    assert.equal(result.reason, "target_tip_mismatch");
    assert.equal(mustGit(f.root, ["rev-parse", "HEAD"]), wrong);
});

test("concurrent already-deleted child ref is idempotent teardown success", (t) => {
    const f = fixture(t);
    const merged = mergePreparedWorktree(input(f, {
        expectedChildTip: f.childTip,
        expectedTargetTip: f.expectedBase,
    }), { execGit: gitExec });
    assert.equal(merged.status, "merged");
    let injected = false;
    const result = teardownMergedWorktree({ ...input(f), mergedChildTip: f.childTip }, {
        execGit(args, options) {
            if (!injected && JSON.stringify(args) === JSON.stringify([
                "update-ref", "-d", `refs/heads/${f.branch}`, f.childTip,
            ])) {
                injected = true;
                mustGit(f.root, ["update-ref", "-d", `refs/heads/${f.branch}`, f.childTip]);
                return { exitCode: 1, stdout: "", stderr: "simulated lost delete race", timedOut: false };
            }
            return gitExec(args, options);
        },
    });
    assert.equal(injected, true);
    assert.equal(result.ok, true);
    assert.equal(result.status, "removed");
    assert.notEqual(git(f.root, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`]).exitCode, 0);
});

test("teardown rechecks cleanliness after the deterministic removal race hook", (t) => {
    const f = fixture(t);
    const merged = mergePreparedWorktree(input(f, {
        expectedChildTip: f.childTip,
        expectedTargetTip: f.expectedBase,
    }), { execGit: gitExec });
    assert.equal(merged.status, "merged");

    const result = teardownMergedWorktree({ ...input(f), mergedChildTip: f.childTip }, {
        execGit: gitExec,
        beforeWorktreeRemove() {
            fs.writeFileSync(path.join(f.worktreePath, "raced-untracked.txt"), "preserve me\n");
        },
    });
    assert.equal(result.reason, "worktree_dirty");
    assert.equal(fs.existsSync(path.join(f.worktreePath, "raced-untracked.txt")), true);
    assert.equal(git(f.root, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`]).exitCode, 0);
});

test("atomic compare-and-delete preserves a concurrently moved branch", (t) => {
    const f = fixture(t);
    const merged = mergePreparedWorktree(input(f, {
        expectedChildTip: f.childTip,
        expectedTargetTip: f.expectedBase,
    }), { execGit: gitExec });
    assert.equal(merged.status, "merged");
    let movedTip;

    const result = teardownMergedWorktree({ ...input(f), mergedChildTip: f.childTip }, {
        execGit: gitExec,
        beforeBranchDelete() {
            const tree = mustGit(f.root, ["rev-parse", `${f.childTip}^{tree}`]);
            movedTip = mustGit(f.root, ["commit-tree", tree, "-p", f.childTip, "-m", "branch delete race"]);
            mustGit(f.root, ["update-ref", `refs/heads/${f.branch}`, movedTip, f.childTip]);
        },
    });
    assert.equal(result.reason, "child_tip_mismatch");
    assert.equal(mustGit(f.root, ["rev-parse", `refs/heads/${f.branch}`]), movedTip);
});

test('public wrappers delegate to an isolated V2 mutation module without an import cycle', () => {
    const sharedSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'worktree-safety.cts'), 'utf8');
    const mutationSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'opencode-v2-worktree-mutation.cts'), 'utf8');
    assert.match(sharedSource, /opencode-v2-worktree-mutation/);
    assert.doesNotMatch(mutationSource, /worktree-safety(?:\\.cjs)?/);
});
