"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { cleanup } = require("./helpers.cjs");
const { runGit, runNode } = require("./helpers/process-seam.cjs");
const { GIT_FIXTURE_TIMEOUT_MS, GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS } = require("./helpers/timeouts.cjs");

const cli = path.resolve(__dirname, "../gsd-core/bin/gsd-tools.cjs");

function git(cwd, args) {
    const result = runGit(args, { cwd, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    return { status: result.exitCode, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function mustGit(cwd, args) {
    const result = git(cwd, args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gsd-worktree-teardown-route-")));
    t.after(() => cleanup(root));
    mustGit(root, ["init", "-b", "main"]);
    mustGit(root, ["config", "user.email", "test@example.invalid"]);
    mustGit(root, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(root, "README.md"), "base\n");
    mustGit(root, ["add", "README.md"]);
    mustGit(root, ["commit", "-m", "base"]);
    const worktreeRoot = path.join(root, "worktrees");
    fs.mkdirSync(worktreeRoot);
    const worktreePath = path.join(worktreeRoot, "agent-one");
    const branch = "worktree-agent-one";
    const expectedBase = mustGit(root, ["rev-parse", "HEAD"]);
    mustGit(root, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
    fs.writeFileSync(path.join(worktreePath, "child.txt"), "child\n");
    mustGit(worktreePath, ["add", "child.txt"]);
    mustGit(worktreePath, ["commit", "-m", "child"]);
    const manifestPath = path.join(root, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ worktrees: [{
        agent_id: "agent-one",
        worktree_path: worktreePath,
        branch,
        expected_base: expectedBase,
    }] }));
    return { root, worktreeRoot, worktreePath, branch, manifestPath, childTip: mustGit(worktreePath, ["rev-parse", "HEAD"]) };
}

function teardown(f) {
    const result = runNode([cli, "query", "worktree.teardown-one",
        "--manifest-path", f.manifestPath,
        "--actual-manifest-agent-id", "agent-one",
        "--canonical-worktree-path", f.worktreePath,
        "--branch", f.branch,
        "--merged-child-tip", f.childTip,
        "--target-root", f.root,
        "--worktree-root", f.worktreeRoot,
    ], { cwd: f.root, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
    return { ...result, status: result.exitCode, payload: JSON.parse(result.stdout) };
}

function mergeChild(f) {
    mustGit(f.root, ["merge", "--no-ff", f.branch, "-m", "merge child"]);
}

test("CLI worktree.teardown-one removes an exactly matched merged worktree", (t) => {
    const f = fixture(t);
    mergeChild(f);
    const result = teardown(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.payload.status, "removed");
    assert.equal(fs.existsSync(f.worktreePath), false);
});

test("CLI worktree.teardown-one preserves primitive idempotency", (t) => {
    const f = fixture(t);
    mergeChild(f);
    assert.equal(teardown(f).payload.status, "removed");
    const repeated = teardown(f);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(repeated.payload.status, "already_removed");
});

test("CLI worktree.teardown-one rejects an unmerged child and preserves it", (t) => {
    const f = fixture(t);
    const result = teardown(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.payload.status, "blocked");
    assert.equal(result.payload.reason, "merge_not_landed");
    assert.equal(fs.existsSync(f.worktreePath), true);
    assert.equal(git(f.root, ["show-ref", "--verify", "--quiet", `refs/heads/${f.branch}`]).status, 0);
});
