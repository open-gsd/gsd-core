"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const attestationContract = require("../gsd-core/bin/lib/opencode-v2-attestation.cjs");
const verification = require("../gsd-core/bin/lib/verification.cjs");
const quickBatch = require("../gsd-core/bin/lib/quick-batch.cjs");
const { cleanup } = require("./helpers.cjs");
const { runNode } = require("./helpers/process-seam.cjs");
const { GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS } = require("./helpers/timeouts.cjs");

const testNativeAttestation = {
  PROVENANCE: "opencode_plugin_rpc_v1",
  RPC_ID: "gsd-worktree-task.attestation.v1",
  RPC_METHOD: "status",
  RPC_TIMEOUT_MS: 10_000,
  OBSERVATION_CLOCK_TOLERANCE_MS: 1_000,
  compatibleVersion: (version) => version === "2.0.3",
  observe: async () => { throw new Error("test observation fixture is not installed"); },
};
const v2Base = require("../gsd-core/bin/lib/quick-batch-v2.cjs");
const v2 = v2Base.createQuickBatchV2({ observe: (...args) => testNativeAttestation.observe(...args) });

const parent = "sesParent_123";
const batch = "batch-a";
const item = "240101-001";

test("helper RPC definition has exact parity with the stable plugin contract", async () => {
  const pluginContract = await import(pathToFileURL(path.join(
    __dirname, "..", "src", "opencode-v2-plugin", "attestation-rpc.mjs",
  )).href);
  assert.equal(attestationContract.RPC_ID, pluginContract.ATTESTATION_RPC_ID);
  assert.equal(attestationContract.RPC_METHOD, "status");
  assert.deepEqual(
    attestationContract.RPC_DEFINITION_VALUE.methods.status.input,
    pluginContract.ATTESTATION_RPC_INPUT_SCHEMA,
  );
  assert.deepEqual(
    attestationContract.RPC_DEFINITION_VALUE.methods.status.output,
    pluginContract.ATTESTATION_RPC_OUTPUT_SCHEMA,
  );
  assert.deepEqual(
    attestationContract.RPC_DEFINITION_VALUE.methods.status.errors,
    pluginContract.ATTESTATION_RPC.methods.status.errors,
  );
});

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "qb-v2-")); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function setBatchState(cwd, status, failureReason = null) {
  const file = path.join(cwd, ".planning", "quick-batches", batch, "BATCH.json");
  const value = readJson(file);
  assert.equal(value.items.length, 1);
  value.items[0].status = status;
  value.items[0].failure_reason = failureReason;
  fs.writeFileSync(file, JSON.stringify(value));
}
function writeVerification(cwd, status) {
  const directory = path.join(cwd, ".planning", "quick", `${item}-fixture`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${item}-VERIFICATION.md`), `---\nstatus: ${status}\n---\n\n# Verification\n`);
  return directory;
}
function writeFingerprintVerification(cwd, status = "passed", coveredFiles = ["src/covered.txt"]) {
  const directory = path.join(cwd, ".planning", "quick", `${item}-fixture`);
  fs.mkdirSync(directory, { recursive: true });
  for (const file of coveredFiles) {
    const absolute = path.join(cwd, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (!fs.existsSync(absolute)) fs.writeFileSync(absolute, "current\n");
  }
  const digest = verification.computeCoveredDigest(cwd, coveredFiles);
  fs.writeFileSync(path.join(directory, `${item}-VERIFICATION.md`), [
    "---", `status: ${status}`, "covered_files:", ...coveredFiles.map((file) => `  - ${file}`),
    `covered_digest: "${digest}"`, "---", "", "# Verification", "",
  ].join("\n"));
  return directory;
}
function writeCompletionState(cwd) {
  fs.writeFileSync(path.join(cwd, ".planning", "STATE.md"), "# STATE\n\n## Quick Tasks Completed\n\n| # | Description | Date | Commit | Status | Directory |\n| --- | --- | --- | --- | --- | --- |\n");
}
function round(cwd, batchId = batch, roundId = 1) {
  return readJson(v2.roundPath(cwd, parent, batchId, roundId));
}
function allocate(cwd, items = [{ item_id: item }], batchId = batch, options = {}) {
  const result = v2.allocateRound(cwd, parent, batchId, items, { validation_required: false, ...options });
  assert.equal(result.ok, true, result.reason);
  return result.value;
}
function nativeManifest(roundId, worktrees, orchestratorRoot = null, batchId = batch) {
  return { orchestrator_root: orchestratorRoot, transport: "native-tool", runtime: "opencode-v2", parent_session_id: parent, batch_id: batchId, round: roundId, worktrees };
}
function transition(cwd, roundId, itemId, phase, event = {}, batchId = batch) {
  const revision = round(cwd, batchId, roundId).revision;
  const result = v2.transition(cwd, parent, batchId, roundId, itemId, phase, event, revision);
  assert.equal(result.ok, true, result.reason);
  return result.value;
}
function forceTrustedPhase(cwd, roundId, itemId, phase, event = {}) {
  const file = v2.roundPath(cwd, parent, batch, roundId);
  const value = readJson(file);
  value.items[itemId].phase = phase;
  value.items[itemId].events.push({ phase, event });
  value.revision++;
  fs.writeFileSync(file, JSON.stringify(value));
}
function advanceToSealed(cwd, roundId, itemId, identity, sessionId) {
  transition(cwd, roundId, itemId, "create_intent", { identity });
  transition(cwd, roundId, itemId, "created");
  transition(cwd, roundId, itemId, "start_intent");
  transition(cwd, roundId, itemId, "started", { session_id: sessionId });
  transition(cwd, roundId, itemId, "seal_intent");
  transition(cwd, roundId, itemId, "sealed");
}
async function advanceToRemoved(cwd, roundId, itemId = item) {
  const identity = makeIdentity(cwd, roundId, itemId);
  const manifest = v2.manifestPath(cwd, parent, batch, roundId);
  fs.writeFileSync(manifest, JSON.stringify(nativeManifest(roundId, [manifestEntry(identity)])));
  transition(cwd, roundId, itemId, "create_intent", { identity });
  for (const phase of ["created", "start_intent"]) transition(cwd, roundId, itemId, phase);
  transition(cwd, roundId, itemId, "started", { session_id: `ses-${itemId}` });
  for (const phase of ["seal_intent", "sealed"]) transition(cwd, roundId, itemId, phase);
  const input = evidence(identity, `ses-${itemId}`, pluginJob(identity, `ses-${itemId}`, manifestEntry(identity)));
  const attested = await attest(cwd, roundId, itemId, input);
  assert.equal(attested.ok, true, attested.reason);
  const statusDigest = round(cwd).items[itemId].status_digest;
  transition(cwd, roundId, itemId, "merge_intent", {
    branch_tip: "a",
    target_tip: "b",
    status_digest: statusDigest,
  });
  forceTrustedPhase(cwd, roundId, itemId, "merged", { status: "merged" });
  transition(cwd, roundId, itemId, "teardown_pending");
  forceTrustedPhase(cwd, roundId, itemId, "removed", { status: "removed" });
}
function makeIdentity(cwd, roundId, itemId, overrides = {}, createDirectory = true) {
  const directory = path.join(cwd, "worktrees", itemId);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  if (createDirectory) fs.mkdirSync(directory);
  const manifest = v2.manifestPath(cwd, parent, batch, roundId);
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  const canonicalManifest = path.join(fs.realpathSync(path.dirname(manifest)), path.basename(manifest));
  return {
    wave_id: "wave-1",
    manifest_agent_id: `agent-${itemId}`,
    directory: path.join(fs.realpathSync(path.dirname(directory)), path.basename(directory)),
    branch: `quick/${itemId}`,
    expected_base: "base-commit",
    manifest_path: canonicalManifest,
    ...overrides,
  };
}
function manifestEntry(identity, overrides = {}) {
  return {
    agent_id: identity.manifest_agent_id,
    worktree_path: identity.directory,
    branch: identity.branch,
    expected_base: identity.expected_base,
    files_modified: ["src/example.js"],
    declared_deletions: [],
    ...overrides,
  };
}
function snapshot(entry, directory = entry.worktree_path) {
  return {
    agent_id: entry.agent_id,
    worktree_path: directory,
    branch: entry.branch,
    expected_base: entry.expected_base,
    files_modified: Object.hasOwn(entry, "files_modified") ? entry.files_modified : null,
    declared_deletions: Object.hasOwn(entry, "declared_deletions") ? entry.declared_deletions : null,
  };
}
function entryHash(entry) {
  return crypto.createHash("sha256").update(JSON.stringify(snapshot(entry))).digest("hex");
}
function pluginJob(identity, sessionId, entry, overrides = {}) {
  const job = {
    session_id: sessionId,
    directory: identity.directory,
    manifest_path: identity.manifest_path,
    manifest_agent_id: identity.manifest_agent_id,
    manifest_entry_hash: entryHash(entry),
    status: "succeeded",
    agent: "gsd-executor",
    model: { providerID: "openai", id: "gpt-5.6-terra", variant: "high" },
    ...overrides,
  };
  return job;
}
function evidence(identity, sessionId, job, completeJobs = [job]) {
  const entries = readJson(identity.manifest_path).worktrees;
  const withSnapshot = (pluginJobValue) => ({
    ...pluginJobValue,
    manifest_entry: snapshot(entries.find((entry) => entry.agent_id === pluginJobValue.manifest_agent_id)),
  });
  const statusJobs = completeJobs.map((jobValue) => {
    const statusJob = withSnapshot(jobValue);
    const requested = {
      session_id: statusJob.session_id,
      parent_session_id: parent,
      directory: statusJob.directory,
      manifest_agent_id: statusJob.manifest_agent_id,
      agent: statusJob.agent,
      model: structuredClone(statusJob.model),
      final_permission: { action: "gsd_worktree_task", resource: "*", effect: "deny" },
    };
    statusJob.requested_executor = requested;
    statusJob.observed_executor = {
      session_id: statusJob.session_id,
      parent_session_id: parent,
      directory: statusJob.directory,
      agent: statusJob.agent,
      model: structuredClone(statusJob.model),
      outcome: "succeeded",
      final_permission: { action: "gsd_worktree_task", resource: "*", effect: "deny" },
    };
    return statusJob;
  });
  return {
    recover: {
      parent_session_id: parent,
      waves: [{ wave_id: identity.wave_id, sealed: true, jobs: [job] }],
    },
    status: {
      wave_id: identity.wave_id,
      parent_session_id: parent,
      checked_at: Date.now(),
      sealed: true,
      merge_ready: true,
      reasons: [],
      jobs: statusJobs,
    },
    batchItem: {
      dispatched_worktree: identity.directory,
      dispatched_branch: identity.branch,
      dispatched_base: identity.expected_base,
    },
  };
}
async function attest(cwd, roundId, itemId, evidenceValue) {
  return await attestAtRevision(cwd, roundId, itemId, evidenceValue, round(cwd, batch, roundId).revision);
}
async function attestAtRevision(cwd, roundId, itemId, evidenceValue, expectedRevision, provenanceOverrides = {}) {
  const batchDir = path.join(cwd, ".planning", "quick-batches", batch);
  fs.mkdirSync(batchDir, { recursive: true });
  fs.writeFileSync(path.join(batchDir, "BATCH.json"), JSON.stringify({
    schema_version: 1,
    batch_id: batch,
    created_at: new Date().toISOString(),
    options: {},
    base_revision: null,
    items: [{
      quick_id: itemId,
      client_id: null,
      description: "fixture",
      status: "pending",
      depends_on: [],
      planned_files: [],
      directory: null,
      worktree: null,
      dispatched_worktree: evidenceValue.batchItem.dispatched_worktree,
      dispatched_branch: evidenceValue.batchItem.dispatched_branch,
      dispatched_base: evidenceValue.batchItem.dispatched_base,
      wave: 0,
      commit: null,
      failure_reason: null,
    }],
  }));
  testNativeAttestation.observe = async () => ({
      evidence: evidenceValue.status,
      provenance: {
        source: "opencode_plugin_rpc_v1",
        rpc_id: "gsd-worktree-task.attestation.v1",
        rpc_method: "status",
        service_version: "2.0.3",
        request_started_at: evidenceValue.status.checked_at - 1,
        request_finished_at: evidenceValue.status.checked_at + 1,
        ...provenanceOverrides,
      },
    });
  return v2.attestPlugin(cwd, parent, batch, roundId, itemId, expectedRevision);
}
function sealedFixture() {
  const cwd = tmp();
  const identity = makeIdentity(cwd, 1, item);
  const allocation = allocate(cwd);
  const entry = manifestEntry(identity);
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [entry])));
  advanceToSealed(cwd, allocation.round, item, identity, "ses-child");
  return {
    cwd,
    identity,
    allocation,
    input: evidence(identity, "ses-child", pluginJob(identity, "ses-child", entry)),
  };
}

test("opencode-v2-transport", async () => {
  const pluginContract = await import(pathToFileURL(path.join(
    __dirname, "..", "src", "opencode-v2-plugin", "attestation-rpc.mjs",
  )).href);

  assert.equal(attestationContract.PROVENANCE, "opencode_plugin_rpc_v1");
  assert.equal(attestationContract.RPC_ID, "gsd-worktree-task.attestation.v1");
  assert.equal(attestationContract.RPC_METHOD, "status");
  assert.deepEqual(Object.keys(attestationContract.RPC_DEFINITION_VALUE.methods), ["status"]);
  assert.deepEqual(
    attestationContract.RPC_DEFINITION_VALUE.methods.status.input,
    pluginContract.ATTESTATION_RPC_INPUT_SCHEMA,
  );
  assert.deepEqual(
    attestationContract.RPC_DEFINITION_VALUE.methods.status.output,
    pluginContract.ATTESTATION_RPC_OUTPUT_SCHEMA,
  );
  assert.deepEqual(
    attestationContract.RPC_DEFINITION_VALUE.methods.status.errors,
    pluginContract.ATTESTATION_RPC.methods.status.errors,
  );
  assert.equal(testNativeAttestation.compatibleVersion("2.0.3"), true);
  assert.equal(testNativeAttestation.compatibleVersion("2.0.4"), false);

  const { cwd, allocation, input } = sealedFixture();
  const accepted = await attest(cwd, allocation.round, item, input);
  assert.equal(accepted.ok, true, accepted.reason);
  assert.equal(round(cwd).items[item].phase, "attested");

  const incomplete = structuredClone(input);
  incomplete.status.jobs = [];
  const rejected = await attest(cwd, allocation.round, item, incomplete);
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /complete job set/);
});

async function assertAttestationRejectedWithoutMutation(cwd, allocation, itemId, input) {
  const file = v2.roundPath(cwd, parent, batch, allocation.round);
  const beforeBytes = fs.readFileSync(file);
  const before = JSON.parse(beforeBytes);
  const result = await attest(cwd, allocation.round, itemId, input);
  assert.match(result.reason, /does not exactly match the locked journal wave/);
  const afterBytes = fs.readFileSync(file);
  const after = JSON.parse(afterBytes);
  assert.deepEqual(afterBytes, beforeBytes);
  assert.equal(after.revision, before.revision);
  for (const id of Object.keys(before.items)) {
    assert.equal(after.items[id].phase, before.items[id].phase);
    assert.equal(after.items[id].events.some(({ phase }) => ["attested", "attestation_refreshed"].includes(phase)), false);
  }
}

test("same parent batches are SHA-scoped and isolated", async () => {
  const cwd = tmp();
  allocate(cwd, [{ item_id: item }], "one");
  allocate(cwd, [{ item_id: item }], "two");
  assert.notEqual(v2.journalDir(cwd, parent, "one"), v2.journalDir(cwd, parent, "two"));
  assert.match(v2.journalDir(cwd, parent, "one"), /[a-f0-9]{64}$/);
});

test("first reconciliation reports no active round before allocation", async () => {
  const cwd = tmp();
  const result = v2.reconcileActiveRound(cwd, parent, batch);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.value, { active: null, initialized: false });
});

test("allocation reconstruction restores missing files only before side effects", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd);
  fs.unlinkSync(v2.roundPath(cwd, parent, batch, allocation.round));
  fs.unlinkSync(allocation.manifest_path);
  const recovered = v2.reconcileActiveRound(cwd, parent, batch);
  assert.equal(recovered.ok, true, recovered.reason);
  assert.deepEqual(readJson(allocation.manifest_path), nativeManifest(allocation.round, []));
});

test("reconciliation accepts one and then two valid created worktrees", async () => {
  const cwd = tmp();
  const root = fs.realpathSync(cwd);
  const ids = [item, "240101-002"];
  const allocation = allocate(cwd, ids.map((id) => ({ item_id: id })), batch, { orchestrator_root: cwd });
  const identities = ids.map((id) => makeIdentity(cwd, allocation.round, id));
  const entries = identities.map((identity) => manifestEntry(identity));

  transition(cwd, allocation.round, ids[0], "create_intent", { identity: identities[0] });
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [entries[0]], root)));
  transition(cwd, allocation.round, ids[0], "created");
  assert.equal(v2.reconcileActiveRound(cwd, parent, batch).ok, true);

  transition(cwd, allocation.round, ids[1], "create_intent", { identity: identities[1] });
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, entries, root)));
  transition(cwd, allocation.round, ids[1], "created");
  const reconciled = v2.reconcileActiveRound(cwd, parent, batch);
  assert.equal(reconciled.ok, true, reconciled.reason);
  assert.equal(reconciled.value.active.revision, 4);
});

test("reconciliation rejects a missing manifest after created side effects", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd);
  const identity = makeIdentity(cwd, allocation.round, item);
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [manifestEntry(identity)])));
  transition(cwd, allocation.round, item, "create_intent", { identity });
  transition(cwd, allocation.round, item, "created");
  fs.unlinkSync(allocation.manifest_path);
  assert.match(v2.reconcileActiveRound(cwd, parent, batch).reason, /missing shared manifest/);
});

test("reconciliation rejects a missing manifest when an intended directory exists", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd);
  const identity = makeIdentity(cwd, allocation.round, item, {}, false);
  transition(cwd, allocation.round, item, "create_intent", { identity });
  fs.mkdirSync(identity.directory);
  fs.unlinkSync(allocation.manifest_path);
  assert.match(v2.reconcileActiveRound(cwd, parent, batch).reason, /missing shared manifest/);
});

test("reconciliation rejects missing round state with a nonempty manifest", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd);
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [{ agent_id: "untrusted-side-effect" }])));
  fs.unlinkSync(v2.roundPath(cwd, parent, batch, allocation.round));
  assert.match(v2.reconcileActiveRound(cwd, parent, batch).reason, /missing round state/);
});

test("reconciliation rejects missing round state when an intended directory exists", async () => {
  const cwd = tmp();
  const identity = makeIdentity(cwd, 1, item, {}, false);
  const allocation = allocate(cwd, [{ item_id: item, identity }]);
  fs.mkdirSync(identity.directory);
  fs.unlinkSync(v2.roundPath(cwd, parent, batch, allocation.round));
  assert.match(v2.reconcileActiveRound(cwd, parent, batch).reason, /missing round state/);
});

test("transitions require the current active round and matching revision", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd);
  assert.equal(v2.transition(cwd, parent, batch, allocation.round, item, "create_intent", {}, 1).ok, false);
  const identity = makeIdentity(cwd, allocation.round, item, {}, false);
  transition(cwd, allocation.round, item, "create_intent", { identity });
  assert.equal(
    v2.transition(cwd, parent, batch, allocation.round, item, "create_intent", { identity }, 0).value.idempotent,
    true,
  );

  await advanceToRemoved(cwd, allocation.round);
  setBatchState(cwd, "complete");
  transition(cwd, allocation.round, item, "completed");
  assert.equal(v2.closeRound(cwd, parent, batch, allocation.round, {}, round(cwd).revision).ok, true);
  assert.match(v2.transition(cwd, parent, batch, allocation.round, item, "completed", {}, round(cwd).revision).reason, /active round/);
});

test("create_intent accepts a canonical prospective path and makes identity immutable", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd);
  const external = makeIdentity(
    cwd, allocation.round, item,
    { manifest_path: path.join(cwd, "external.json") },
    false,
  );
  assert.match(
    v2.transition(cwd, parent, batch, allocation.round, item, "create_intent", { identity: external }, 0).reason,
    /helper-owned/,
  );

  const identity = makeIdentity(cwd, allocation.round, item, {}, false);
  transition(cwd, allocation.round, item, "create_intent", { identity });
  assert.equal(fs.existsSync(identity.directory), false);
  const changed = { ...identity, branch: "quick/other" };
  assert.match(
    v2.transition(cwd, parent, batch, allocation.round, item, "created", { identity: changed }, 1).reason,
    /immutable/,
  );
});

test("created requires the intended directory and exact shared manifest entry", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd);
  const identity = makeIdentity(cwd, allocation.round, item, {}, false);
  transition(cwd, allocation.round, item, "create_intent", { identity });

  assert.match(
    v2.transition(cwd, parent, batch, allocation.round, item, "created", {}, 1).reason,
    /does not exist/,
  );
  fs.mkdirSync(identity.directory);
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [manifestEntry(identity)])));
  transition(cwd, allocation.round, item, "created");
  assert.equal(typeof round(cwd).items[item].created_manifest_entry_hash, "string");
});

test("created rejects missing identity and a switched manifest binding", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd);
  assert.match(
    v2.transition(cwd, parent, batch, allocation.round, item, "create_intent", {}, 0).reason,
    /requires identity/,
  );

  const identity = makeIdentity(cwd, allocation.round, item);
  transition(cwd, allocation.round, item, "create_intent", { identity });
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [manifestEntry(identity, { branch: "quick/switched" })])));
  assert.match(
    v2.transition(cwd, parent, batch, allocation.round, item, "created", {}, 1).reason,
    /binding mismatch/,
  );
});

test("start_intent rejects manifest switching after created", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd);
  const identity = makeIdentity(cwd, allocation.round, item);
  const entry = manifestEntry(identity);
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [entry])));
  transition(cwd, allocation.round, item, "create_intent", { identity });
  transition(cwd, allocation.round, item, "created");
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [{ ...entry, files_modified: ["src/switched.js"] }])));
  assert.match(
    v2.transition(cwd, parent, batch, allocation.round, item, "start_intent", {}, 2).reason,
    /changed after created/,
  );
});

test("started persists one session and only exact replay is idempotent", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd);
  const identity = makeIdentity(cwd, allocation.round, item);
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [manifestEntry(identity)])));
  for (const [phase, event] of [
    ["create_intent", { identity }],
    ["created", {}],
    ["start_intent", {}],
    ["started", { session_id: "ses-child" }],
  ]) transition(cwd, allocation.round, item, phase, event);

  const revision = round(cwd).revision;
  const replay = v2.transition(
    cwd, parent, batch, allocation.round, item, "started", { session_id: "ses-child" }, revision - 1,
  );
  assert.equal(replay.ok, true, replay.reason);
  assert.equal(replay.value.idempotent, true);
  assert.equal(round(cwd).items[item].session_id, "ses-child");
  assert.equal(v2.transition(
    cwd, parent, batch, allocation.round, item, "started", { session_id: "ses-other" }, revision,
  ).ok, false);
});

test("BATCH binding uses only the three persisted dispatch fields", async () => {
  const cwd = tmp();
  const worktree = path.join(cwd, "worktree");
  fs.mkdirSync(worktree);
  assert.deepEqual(v2.bindBatchItem({
    dispatched_worktree: worktree,
    dispatched_branch: "quick/item",
    dispatched_base: "base-commit",
  }), {
    worktree_path: fs.realpathSync(worktree),
    branch: "quick/item",
    expected_base: "base-commit",
  });
});

test("canonical JSON digest ignores object key order, preserves array order, and rejects unsafe values", async () => {
  assert.equal(
    v2.canonicalDigest({ z: 1, nested: { b: true, a: null }, values: [1, 2] }),
    v2.canonicalDigest({ values: [1, 2], nested: { a: null, b: true }, z: 1 }),
  );
  assert.notEqual(v2.canonicalDigest({ values: [1, 2] }), v2.canonicalDigest({ values: [2, 1] }));
  assert.throws(() => v2.canonicalJson({ unsafe: undefined }), /non-JSON/);
  const sparse = [];
  sparse[1] = "value";
  assert.throws(() => v2.canonicalJson(sparse), /sparse/);
});

test("two sibling items independently attest against the same fully validated two-job wave", async () => {
  const cwd = tmp();
  const root = fs.realpathSync(cwd);
  const ids = [item, "240101-002"];
  const identities = ids.map((id) => makeIdentity(cwd, 1, id));
  const allocation = allocate(cwd, ids.map((id) => ({ item_id: id })), batch, { orchestrator_root: cwd });
  const entries = identities.map((identity) => manifestEntry(identity));
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, entries, root)));

  ids.forEach((id, index) => advanceToSealed(cwd, allocation.round, id, identities[index], `ses-${index + 1}`));
  const jobs = identities.map((identity, index) => pluginJob(identity, `ses-${index + 1}`, entries[index]));
  for (const [index, id] of ids.entries()) {
    const result = await attest(cwd, allocation.round, id, evidence(
      identities[index], `ses-${index + 1}`, jobs[index], jobs,
    ));
    assert.equal(result.ok, true, result.reason);
    assert.equal(round(cwd).items[id].executor_identity.session_id, `ses-${index + 1}`);
  }
});

test("two-item sealed wave rejects an RPC response that omits the unrelated sibling with zero journal mutation", async () => {
  const cwd = tmp();
  const root = fs.realpathSync(cwd);
  const ids = [item, "240101-002"];
  const identities = ids.map((id) => makeIdentity(cwd, 1, id));
  const allocation = allocate(cwd, ids.map((id) => ({ item_id: id })), batch, { orchestrator_root: cwd });
  const entries = identities.map((identity) => manifestEntry(identity));
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, entries, root)));
  ids.forEach((id, index) => advanceToSealed(cwd, allocation.round, id, identities[index], `ses-${index + 1}`));
  const selected = pluginJob(identities[0], "ses-1", entries[0]);
  await assertAttestationRejectedWithoutMutation(
    cwd, allocation, ids[0], evidence(identities[0], "ses-1", selected, [selected]),
  );
});

test("two-item sealed wave rejects an extra otherwise-valid unbound sibling with zero journal mutation", async () => {
  const cwd = tmp();
  const root = fs.realpathSync(cwd);
  const ids = [item, "240101-002"];
  const identities = ids.map((id) => makeIdentity(cwd, 1, id));
  const extraIdentity = makeIdentity(cwd, 1, "240101-003");
  const allocation = allocate(cwd, ids.map((id) => ({ item_id: id })), batch, { orchestrator_root: cwd });
  const entries = [...identities, extraIdentity].map((identity) => manifestEntry(identity));
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, entries, root)));
  ids.forEach((id, index) => advanceToSealed(cwd, allocation.round, id, identities[index], `ses-${index + 1}`));
  const jobs = identities.map((identity, index) => pluginJob(identity, `ses-${index + 1}`, entries[index]));
  jobs.push(pluginJob(extraIdentity, "ses-3", entries[2]));
  await assertAttestationRejectedWithoutMutation(
    cwd, allocation, ids[0], evidence(identities[0], "ses-1", jobs[0], jobs),
  );
});

test("two-job attestation rejects a malformed unrelated sibling before item selection", async () => {
  const cwd = tmp();
  const root = fs.realpathSync(cwd);
  const ids = [item, "240101-002"];
  const identities = ids.map((id) => makeIdentity(cwd, 1, id));
  const allocation = allocate(cwd, ids.map((id) => ({ item_id: id })), batch, { orchestrator_root: cwd });
  const entries = identities.map((identity) => manifestEntry(identity));
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, entries, root)));
  ids.forEach((id, index) => advanceToSealed(cwd, allocation.round, id, identities[index], `ses-${index + 1}`));
  const jobs = identities.map((identity, index) => pluginJob(identity, `ses-${index + 1}`, entries[index]));
  const input = evidence(identities[0], "ses-1", jobs[0], jobs);
  input.status.jobs[1].requested_executor.model.providerID = "forged-provider";
  assert.match((await attest(cwd, allocation.round, ids[0], input)).reason, /whole-wave executor identity mismatch/);
  assert.equal(round(cwd).items[ids[0]].phase, "sealed");
});

test("attestation rejects non-merge-ready status", async () => {
  const cwd = tmp();
  const identity = makeIdentity(cwd, 1, item);
  const allocation = allocate(cwd);
  const entry = manifestEntry(identity);
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [entry])));
  advanceToSealed(cwd, allocation.round, item, identity, "ses-child");
  const input = evidence(identity, "ses-child", pluginJob(identity, "ses-child", entry));
  input.status.merge_ready = false;
  input.status.reasons = ["not_ready"];
  assert.match((await attest(cwd, allocation.round, item, input)).reason, /not fresh merge-ready/);
});

test("attestation rejects future and stale plugin checked_at timestamps", async (t) => {
  for (const [label, checkedAt] of [["future", Date.now() + 60_000], ["stale", Date.now() - 30_001]]) {
    await t.test(label, async () => {
      const { cwd, allocation, input } = sealedFixture();
      input.status.checked_at = checkedAt;
      assert.match((await attest(cwd, allocation.round, item, input)).reason, /not fresh merge-ready/);
    });
  }
});

test("attestation rejects unbounded or inconsistent RPC observation intervals", async (t) => {
  for (const [label, interval] of [
    ["missing start", { request_started_at: undefined }],
    ["reversed", { request_started_at: Date.now() + 1, request_finished_at: Date.now() }],
    ["too long", { request_started_at: Date.now() - 20_000, request_finished_at: Date.now() }],
    ["checked before request", { request_started_at: Date.now() + 5_000, request_finished_at: Date.now() + 5_001 }],
  ]) {
    await t.test(label, async () => {
      const { cwd, allocation, input } = sealedFixture();
      const result = await attestAtRevision(cwd, allocation.round, item, input, round(cwd).revision, interval);
      assert.match(result.reason, /bounded RPC observation interval/);
      assert.equal(round(cwd).items[item].phase, "sealed");
    });
  }
});

test("attestation releases the journal lock during RPC and rejects a raced revision by CAS", async () => {
  const cwd = tmp();
  const sibling = "240101-002";
  const allocation = allocate(cwd, [{ item_id: item }, { item_id: sibling }]);
  const identity = makeIdentity(cwd, allocation.round, item);
  const siblingIdentity = makeIdentity(cwd, allocation.round, sibling);
  const entry = manifestEntry(identity);
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [entry, manifestEntry(siblingIdentity)])));
  advanceToSealed(cwd, allocation.round, item, identity, "ses-child");
  const expectedRevision = round(cwd).revision;
  const input = evidence(identity, "ses-child", pluginJob(identity, "ses-child", entry));
  testNativeAttestation.observe = async () => {
      const raced = v2.transition(
        cwd, parent, batch, allocation.round, sibling, "create_intent",
        { identity: siblingIdentity }, expectedRevision,
      );
      assert.equal(raced.ok, true, raced.reason);
      return {
        evidence: input.status,
        provenance: {
          source: "opencode_plugin_rpc_v1",
          rpc_id: "gsd-worktree-task.attestation.v1",
          rpc_method: "status",
          service_version: "2.0.3",
          request_started_at: input.status.checked_at - 1,
          request_finished_at: input.status.checked_at + 1,
        },
      };
    };
  const result = await v2.attestPlugin(cwd, parent, batch, allocation.round, item, expectedRevision);
  assert.match(result.reason, /stale expected_revision/);
  assert.equal(round(cwd).items[item].phase, "sealed");
});

test("production attestation rejects formerly accepted caller-supplied evidence bytes", async () => {
  const cwd = tmp();
  const identity = makeIdentity(cwd, 1, item);
  const allocation = allocate(cwd);
  const entry = manifestEntry(identity);
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [entry])));
  advanceToSealed(cwd, allocation.round, item, identity, "ses-child");
  const input = evidence(identity, "ses-child", pluginJob(identity, "ses-child", entry));
  input.recover.waves[0].jobs.push({ ...input.recover.waves[0].jobs[0], session_id: "ses-extra" });
  const forged = await v2.attestPlugin(
    cwd, parent, batch, allocation.round, item,
    input.recover, input.status, input.batchItem, round(cwd).revision,
  );
  assert.match(forged.reason, /only journal coordinates/);
  assert.equal(round(cwd).items[item].phase, "sealed");
});

test("attestation rejects duplicate and missing bound sessions in a complete-wave response", async (t) => {
  const cwd = tmp();
  const identity = makeIdentity(cwd, 1, item);
  const allocation = allocate(cwd);
  const entry = manifestEntry(identity);
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [entry])));
  advanceToSealed(cwd, allocation.round, item, identity, "ses-child");
  const input = evidence(identity, "ses-child", pluginJob(identity, "ses-child", entry));
  await t.test("duplicate", async () => {
    const duplicate = structuredClone(input);
    duplicate.status.jobs.push(structuredClone(duplicate.status.jobs[0]));
    assert.equal((await attest(cwd, allocation.round, item, duplicate)).ok, false);
  });
  await t.test("missing", async () => {
    const missing = structuredClone(input);
    missing.status.jobs[0].session_id = "ses-other";
    missing.status.jobs[0].requested_executor.session_id = "ses-other";
    missing.status.jobs[0].observed_executor.session_id = "ses-other";
    assert.match(
      (await attest(cwd, allocation.round, item, missing)).reason,
      /does not exactly match the locked journal wave/,
    );
  });
});

test("attestation stores the digest of the exact fresh status", async () => {
  const cwd = tmp();
  const identity = makeIdentity(cwd, 1, item);
  const allocation = allocate(cwd);
  const entry = manifestEntry(identity);
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [entry])));
  advanceToSealed(cwd, allocation.round, item, identity, "ses-child");
  const input = evidence(identity, "ses-child", pluginJob(identity, "ses-child", entry));
  const expectedDigest = v2.canonicalDigest(input.status);
  const result = await attest(cwd, allocation.round, item, input);
  assert.equal(result.ok, true, result.reason);
  const journalItem = round(cwd).items[item];
  assert.equal(journalItem.phase, "attested");
  assert.equal(journalItem.status_digest, expectedDigest);
  assert.equal(journalItem.events.at(-1).phase, "attested");
  assert.equal(journalItem.events.at(-1).event.status_digest, expectedDigest);
});

test("attestation refresh in attested replaces the digest and appends a distinct audit event", async () => {
  const { cwd, allocation, input } = sealedFixture();
  assert.equal((await attest(cwd, allocation.round, item, input)).ok, true);
  const initial = round(cwd);
  const refreshedInput = structuredClone(input);
  refreshedInput.status.observation_id = "fresh-status-2";
  const refreshedDigest = v2.canonicalDigest(refreshedInput.status);

  const refreshed = await attest(cwd, allocation.round, item, refreshedInput);
  assert.equal(refreshed.ok, true, refreshed.reason);
  assert.equal(refreshed.value.idempotent, false);
  const journal = round(cwd);
  assert.equal(journal.revision, initial.revision + 1);
  assert.equal(journal.items[item].phase, "attested");
  assert.equal(journal.items[item].status_digest, refreshedDigest);
  assert.equal(journal.items[item].events.at(-1).phase, "attestation_refreshed");
  assert.equal(journal.items[item].events.at(-1).event.status_digest, refreshedDigest);

  const replay = await attestAtRevision(cwd, allocation.round, item, refreshedInput, initial.revision);
  assert.equal(replay.ok, true, replay.reason);
  assert.equal(replay.value.idempotent, true);
  assert.equal(round(cwd).revision, journal.revision);
});

test("attestation retry at the immediately prior revision is idempotent", async () => {
  const { cwd, allocation, input } = sealedFixture();
  assert.equal((await attest(cwd, allocation.round, item, input)).ok, true);
  const before = round(cwd);

  const result = await attestAtRevision(cwd, allocation.round, item, input, before.revision - 1);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.value.idempotent, true);
  assert.deepEqual(round(cwd), before);
});

test("attestation replay treats recursively reordered JSON object keys as equivalent", async () => {
  const { cwd, allocation, input } = sealedFixture();
  assert.equal((await attest(cwd, allocation.round, item, input)).ok, true);
  const before = round(cwd);
  const reordered = structuredClone(input);
  reordered.status = Object.fromEntries(Object.entries(reordered.status).reverse());
  reordered.status.jobs[0] = Object.fromEntries(Object.entries(reordered.status.jobs[0]).reverse());
  const replay = await attestAtRevision(cwd, allocation.round, item, reordered, before.revision - 1);
  assert.equal(replay.ok, true, replay.reason);
  assert.equal(replay.value.idempotent, true);
  assert.deepEqual(round(cwd), before);
});

test("attestation refresh revalidates merge-ready status before changing the journal", async () => {
  const { cwd, allocation, input } = sealedFixture();
  assert.equal((await attest(cwd, allocation.round, item, input)).ok, true);
  const before = round(cwd);
  const invalid = structuredClone(input);
  invalid.status.merge_ready = false;
  invalid.status.reasons = ["child_failed_after_resume"];

  assert.match((await attest(cwd, allocation.round, item, invalid)).reason, /not fresh merge-ready/);
  assert.deepEqual(round(cwd), before);
});

test("attestation refresh in merge_intent appends evidence without mutating prior audit events", async () => {
  const { cwd, allocation, input } = sealedFixture();
  assert.equal((await attest(cwd, allocation.round, item, input)).ok, true);
  const oldDigest = round(cwd).items[item].status_digest;
  transition(cwd, allocation.round, item, "merge_intent", {
    branch_tip: "immutable-branch-tip",
    target_tip: "immutable-target-tip",
    status_digest: oldDigest,
  });
  const before = round(cwd);
  const originalMergeIntent = structuredClone(before.items[item].events.find((event) => event.phase === "merge_intent"));
  const refreshedInput = structuredClone(input);
  refreshedInput.status.observation_id = "post-crash-recovery";
  const refreshedDigest = v2.canonicalDigest(refreshedInput.status);

  const refreshed = await attest(cwd, allocation.round, item, refreshedInput);
  assert.equal(refreshed.ok, true, refreshed.reason);
  const journal = round(cwd);
  const journalItem = journal.items[item];
  const mergeIntent = journalItem.events.find((event) => event.phase === "merge_intent");
  assert.equal(journal.revision, before.revision + 1);
  assert.equal(journalItem.phase, "merge_intent");
  assert.equal(journalItem.status_digest, refreshedDigest);
  assert.deepEqual(mergeIntent, originalMergeIntent);
  assert.equal(mergeIntent.event.status_digest, oldDigest);
  assert.equal(journalItem.events.at(-1).phase, "attestation_refreshed");

  assert.match(v2.transition(cwd, parent, batch, allocation.round, item, "merge_intent", {
    branch_tip: "immutable-branch-tip",
    target_tip: "immutable-target-tip",
    status_digest: oldDigest,
  }, journal.revision).reason, /does not match fresh attestation/);
  const replay = v2.transition(cwd, parent, batch, allocation.round, item, "merge_intent", {
    branch_tip: "immutable-branch-tip",
    target_tip: "immutable-target-tip",
    status_digest: refreshedDigest,
  }, journal.revision);
  assert.equal(replay.ok, true, replay.reason);
  assert.equal(replay.value.idempotent, true);
});

test("attestation refresh is forbidden after merge has been recorded", async () => {
  const { cwd, allocation, input } = sealedFixture();
  assert.equal((await attest(cwd, allocation.round, item, input)).ok, true);
  transition(cwd, allocation.round, item, "merge_intent", {
    branch_tip: "branch-tip",
    target_tip: "target-tip",
    status_digest: round(cwd).items[item].status_digest,
  });
  forceTrustedPhase(cwd, allocation.round, item, "merged", { status: "merged" });
  const before = round(cwd);
  const refreshedInput = structuredClone(input);
  refreshedInput.status.observation_id = "too-late";

  assert.match((await attest(cwd, allocation.round, item, refreshedInput)).reason, /must be sealed, attested, or at merge_intent/);
  assert.deepEqual(round(cwd), before);
});

test("generic transitions cannot forge attestation status digests", async () => {
  const cwd = tmp();
  const identity = makeIdentity(cwd, 1, item);
  const allocation = allocate(cwd);
  const entry = manifestEntry(identity);
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [entry])));
  advanceToSealed(cwd, allocation.round, item, identity, "ses-child");
  assert.match(v2.transition(
    cwd, parent, batch, allocation.round, item, "attested", { status_digest: "forged" }, round(cwd).revision,
  ).reason, /attestPlugin/);
});

test("legacy attested journal events without native provenance cannot authorize merge intent", async () => {
  const { cwd, allocation } = sealedFixture();
  const file = v2.roundPath(cwd, parent, batch, allocation.round);
  const journal = readJson(file);
  journal.items[item].phase = "attested";
  journal.items[item].status_digest = "legacy-digest";
  journal.items[item].events.push({ phase: "attested", event: { status_digest: "legacy-digest" } });
  journal.revision++;
  fs.writeFileSync(file, JSON.stringify(journal));

  const result = v2.transition(cwd, parent, batch, allocation.round, item, "merge_intent", {
    branch_tip: "branch-tip",
    target_tip: "target-tip",
    status_digest: "legacy-digest",
  }, journal.revision);
  assert.match(result.reason, /native OpenCode plugin RPC provenance/);
});

test("merge authorization rechecks native attestation freshness", async () => {
  const { cwd, allocation, input } = sealedFixture();
  assert.equal((await attest(cwd, allocation.round, item, input)).ok, true);
  const file = v2.roundPath(cwd, parent, batch, allocation.round);
  for (const checkedAt of [Date.now() - 30_001, Date.now() + 60_000]) {
    const journal = readJson(file);
    journal.items[item].events.at(-1).event.checked_at = checkedAt;
    fs.writeFileSync(file, JSON.stringify(journal));
    const result = v2.transition(cwd, parent, batch, allocation.round, item, "merge_intent", {
      branch_tip: "branch-tip",
      target_tip: "target-tip",
      status_digest: journal.items[item].status_digest,
    }, journal.revision);
    assert.match(result.reason, /fresh native/);
  }
});

test("merge_intent accepts only the status digest stored by attestation", async () => {
  const cwd = tmp();
  const identity = makeIdentity(cwd, 1, item);
  const allocation = allocate(cwd);
  const entry = manifestEntry(identity);
  fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [entry])));
  advanceToSealed(cwd, allocation.round, item, identity, "ses-child");
  const input = evidence(identity, "ses-child", pluginJob(identity, "ses-child", entry));
  assert.equal((await attest(cwd, allocation.round, item, input)).ok, true);

  const revision = round(cwd).revision;
  assert.match(v2.transition(cwd, parent, batch, allocation.round, item, "merge_intent", {
    branch_tip: "branch-tip",
    target_tip: "target-tip",
    status_digest: "arbitrary-or-stale",
  }, revision).reason, /does not match/);

  const digest = round(cwd).items[item].status_digest;
  transition(cwd, allocation.round, item, "merge_intent", {
    branch_tip: "branch-tip",
    target_tip: "target-tip",
    status_digest: digest,
  });
});

test("generic transitions cannot forge merged or removed native mutation results", async () => {
  const { cwd, allocation, input } = sealedFixture();
  assert.equal((await attest(cwd, allocation.round, item, input)).ok, true);
  transition(cwd, allocation.round, item, "merge_intent", {
    branch_tip: "branch-tip", target_tip: "target-tip", status_digest: round(cwd).items[item].status_digest,
  });
  assert.match(v2.transition(cwd, parent, batch, allocation.round, item, "merged", {}, round(cwd).revision).reason, /authorized native mutation route/);
  forceTrustedPhase(cwd, allocation.round, item, "merged", { status: "merged" });
  transition(cwd, allocation.round, item, "teardown_pending");
  assert.match(v2.transition(cwd, parent, batch, allocation.round, item, "removed", {}, round(cwd).revision).reason, /authorized native mutation route/);
});

test("validated success advances from removed through verification_passed to completed", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
  await advanceToRemoved(cwd, allocation.round);
  const verificationDirectory = writeVerification(cwd, "passed");
  const verifyRevision = round(cwd).revision;
  const verified = v2.recordVerification(cwd, parent, batch, allocation.round, item, verifyRevision);
  assert.equal(verified.ok, true, verified.reason);
  assert.equal(round(cwd).items[item].phase, "verification_passed");
  const verificationReplay = v2.recordVerification(cwd, parent, batch, allocation.round, item, verifyRevision);
  assert.equal(verificationReplay.ok, true, verificationReplay.reason);
  assert.equal(verificationReplay.value.idempotent, true);
  writeCompletionState(cwd);
  const directory = path.relative(cwd, verificationDirectory);
  const cli = path.resolve(__dirname, "../gsd-core/bin/gsd-tools.cjs");
  const completionRevision = round(cwd).revision;
  const completionArgs = [cli, "quick-batch", "v2-complete", "--parent-session", parent, "--batch", batch, "--round", String(allocation.round), "--item", item, "--expected-revision", String(completionRevision), "--description", "fixture", "--date", "2026-09-12", "--commit", "abc123", "--directory", directory];
  const completed = runNode(completionArgs, { cwd, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
  assert.equal(completed.exitCode, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).manifest.items[0].status, "complete");
  const completionReplay = runNode(completionArgs, { cwd, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
  assert.equal(completionReplay.exitCode, 0, completionReplay.stderr);
  assert.equal(JSON.parse(completionReplay.stdout).idempotent, true);
  const conflicting = v2.completeAuthorized(cwd, parent, batch, allocation.round, item, completionRevision, { description: "forged", date: "2026-09-12", commit: "abc123", directory });
  assert.equal(conflicting.ok, false);
  transition(cwd, allocation.round, item, "completed");
  assert.equal(round(cwd).items[item].phase, "completed");
});

test("model-authored outcome flags cannot authorize verification or completion", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
  await advanceToRemoved(cwd, allocation.round);
  const revision = round(cwd).revision;
  assert.match(v2.transition(cwd, parent, batch, allocation.round, item, "verification_failed", {
    batch_outcome_written: true,
    outcome: "gaps_found",
  }, revision).reason, /recorded by v2-verify/);
  assert.match(v2.transition(cwd, parent, batch, allocation.round, item, "verification_passed", {
    batch_outcome_written: true,
    outcome: "passed",
  }, revision).reason, /recorded by v2-verify/);
  assert.match(v2.transition(cwd, parent, batch, allocation.round, item, "completed", {
    batch_outcome_written: true,
    outcome: "complete",
  }, revision).reason, /BATCH item state/);
  setBatchState(cwd, "failed", "arbitrary model prose");
  assert.match(v2.transition(cwd, parent, batch, allocation.round, item, "verification_failed", {}, revision).reason, /recorded by v2-verify/);
});

test("generic completion before verification cannot mint or bypass a receipt", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
  await advanceToRemoved(cwd, allocation.round);
  writeVerification(cwd, "passed");
  assert.match(v2.guardGenericCompletion(cwd, batch, item).reason, /coordinate-bound/);
  writeCompletionState(cwd);
  const cli = path.resolve(__dirname, "../gsd-core/bin/gsd-tools.cjs");
  const direct = runNode([cli, "quick-batch", "complete", "--batch", batch, "--quick-id", item, "--description", "fixture", "--date", "2026-09-12", "--commit", "abc123", "--directory", `.planning/quick/${item}-fixture`], { cwd, timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS });
  assert.notEqual(direct.exitCode, 0);
  assert.match(direct.stderr, /coordinate-bound quick-batch v2-complete/);
  assert.equal(readJson(path.join(cwd, ".planning", "quick-batches", batch, "BATCH.json")).items[0].status, "pending");
  setBatchState(cwd, "complete");
  assert.match(v2.recordVerification(cwd, parent, batch, allocation.round, item, round(cwd).revision).reason, /generic completion is not proof/);
  assert.match(v2.transition(cwd, parent, batch, allocation.round, item, "completed", {}, round(cwd).revision).reason, /passed verification receipt/);
  assert.equal(v2.closeRound(cwd, parent, batch, allocation.round, {}, round(cwd).revision).ok, false);
});

test("verification receipt detects forged or changed artifact bytes", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
  await advanceToRemoved(cwd, allocation.round);
  const directory = writeVerification(cwd, "passed");
  assert.equal(v2.recordVerification(cwd, parent, batch, allocation.round, item, round(cwd).revision).ok, true);
  fs.appendFileSync(path.join(directory, `${item}-VERIFICATION.md`), "changed\n");
  assert.equal(v2.recordVerification(cwd, parent, batch, allocation.round, item, round(cwd).revision - 1).ok, false);
  writeCompletionState(cwd);
  const itemDirectory = path.relative(cwd, directory);
  assert.match(v2.completeAuthorized(cwd, parent, batch, allocation.round, item, round(cwd).revision, { description: "fixture", date: "2026-09-12", commit: "abc123", directory: itemDirectory }).reason, /trusted passed verification receipt/);
});

test("verification receipt reads status from the exact item artifact it hashes", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
  await advanceToRemoved(cwd, allocation.round);
  const directory = writeVerification(cwd, "gaps_found");
  fs.writeFileSync(path.join(directory, "240101-VERIFICATION.md"), "---\nstatus: passed\n---\n");

  const result = v2.recordVerification(cwd, parent, batch, allocation.round, item, round(cwd).revision);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.value.verification_receipt.status, "gaps_found");
  assert.equal(round(cwd).items[item].phase, "verification_failed");
});

test("verification receipt accepts only canonical shared-parser statuses from exact UTF-8 bytes", async () => {
  for (const [status, ending] of [["passed", "\n"], ["gaps_found", "\r\n"], ["human_needed", "\r"]]) {
    const cwd = tmp();
    const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
    await advanceToRemoved(cwd, allocation.round);
    const directory = writeVerification(cwd, status);
    const artifact = path.join(directory, `${item}-VERIFICATION.md`);
    const raw = `---${ending}status: ${status}${ending}---${ending}`;
    fs.writeFileSync(artifact, Buffer.from(raw, "utf8"));
    const result = v2.recordVerification(cwd, parent, batch, allocation.round, item, round(cwd).revision);
    assert.equal(result.ok, true, `${status}: ${result.reason}`);
    assert.equal(result.value.verification_receipt.status, status);
    assert.equal(result.value.verification_receipt.sha256, crypto.createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex"));
  }
});

test("verification receipt fails closed for malformed canonical status frontmatter", async () => {
  const invalidArtifacts = [
    "---evil\nstatus: passed\n---\n",
    "---\nstatus: passed\n---evil\n",
    "---\nstatus: passed\nstatus: passed\n---\n",
    "---\nstatus: passed\nstatus: gaps_found\n---\n",
    "---\nstatus: gaps_found\nstatus: passed\n---\n",
    "---\nstatus : passed\n---\n",
    "---\nstatus:  passed\n---\n",
    "---\nstatus: passed \n---\n",
    "---\nstatus: 'passed'\n---\n",
    "---\n  status: passed\n---\n",
    "---\nbase: &base\n  status: passed\n<<: *base\n---\n",
    "---\n\"statu\\u0073\": gaps_found\nstatus: passed\n---\n",
    "---\n!!str status: gaps_found\nstatus: passed\n---\n",
    "---\n? status\n: gaps_found\nstatus: passed\n---\n",
    "---\n{status: gaps_found}\nstatus: passed\n---\n",
    "---\nstatus: unknown\n---\n",
    Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0x73, 0x74, 0x61, 0x74, 0x75, 0x73, 0x3a, 0x20, 0xc3, 0x28, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a]),
  ];
  for (const raw of invalidArtifacts) {
    const cwd = tmp();
    const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
    await advanceToRemoved(cwd, allocation.round);
    const directory = writeVerification(cwd, "passed");
    fs.writeFileSync(path.join(directory, `${item}-VERIFICATION.md`), raw);
    const result = v2.recordVerification(cwd, parent, batch, allocation.round, item, round(cwd).revision);
    assert.equal(result.ok, false, String(raw));
  }
});

test("fingerprinted verification receipts require current complete covered inputs", async (t) => {
  await t.test("current digest", async () => {
    const cwd = tmp();
    const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
    await advanceToRemoved(cwd, allocation.round);
    writeFingerprintVerification(cwd);
    const result = v2.recordVerification(cwd, parent, batch, allocation.round, item, round(cwd).revision);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.value.verification_receipt.status, "passed");
  });

  for (const [label, mutate] of [
    ["digest mismatch", (cwd, _directory) => fs.appendFileSync(path.join(cwd, "src", "covered.txt"), "drift\n")],
    ["missing covered file", (cwd) => fs.unlinkSync(path.join(cwd, "src", "covered.txt"))],
    ["non-regular covered file", (cwd) => {
      fs.unlinkSync(path.join(cwd, "src", "covered.txt"));
      fs.mkdirSync(path.join(cwd, "src", "covered.txt"));
    }],
    ["escaping covered file", (_cwd, directory) => fs.writeFileSync(path.join(directory, `${item}-VERIFICATION.md`), "---\nstatus: passed\ncovered_files:\n  - ../../../../outside\ncovered_digest: \"v1:sha256:nope\"\n---\n")],
    ["new uncovered plan", (_cwd, directory) => fs.writeFileSync(path.join(directory, "01-PLAN.md"), "# New plan\n")],
    ["partial declaration", (_cwd, directory) => fs.writeFileSync(path.join(directory, `${item}-VERIFICATION.md`), "---\nstatus: passed\ncovered_files:\n  - src/covered.txt\n---\n")],
  ]) {
    await t.test(label, async () => {
      const cwd = tmp();
      const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
      await advanceToRemoved(cwd, allocation.round);
      const directory = writeFingerprintVerification(cwd);
      mutate(cwd, directory);
      const result = v2.recordVerification(cwd, parent, batch, allocation.round, item, round(cwd).revision);
      assert.equal(result.ok, false);
      assert.equal(round(cwd).items[item].verification_receipt, null);
      assert.equal(round(cwd).items[item].phase, "removed");
    });
  }
});


test("verification receipt rejects symlinked, missing exact-name, and escaping BATCH artifacts", async (t) => {
  await t.test("symlink", async () => {
    const cwd = tmp();
    const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
    await advanceToRemoved(cwd, allocation.round);
    const directory = writeVerification(cwd, "passed");
    const artifact = path.join(directory, `${item}-VERIFICATION.md`);
    const target = path.join(directory, "target.md");
    fs.renameSync(artifact, target);
    fs.symlinkSync(target, artifact);
    assert.equal(v2.recordVerification(cwd, parent, batch, allocation.round, item, round(cwd).revision).ok, false);
  });
  await t.test("missing exact name with sibling", async () => {
    const cwd = tmp();
    const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
    await advanceToRemoved(cwd, allocation.round);
    const directory = writeVerification(cwd, "passed");
    fs.renameSync(path.join(directory, `${item}-VERIFICATION.md`), path.join(directory, "other-VERIFICATION.md"));
    assert.equal(v2.recordVerification(cwd, parent, batch, allocation.round, item, round(cwd).revision).ok, false);
  });
  await t.test("BATCH directory escape", async () => {
    const cwd = tmp();
    const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
    await advanceToRemoved(cwd, allocation.round);
    writeVerification(cwd, "passed");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "qb-v2-outside-"));
    t.after(() => cleanup(outside));
    fs.writeFileSync(path.join(outside, `${item}-VERIFICATION.md`), "---\nstatus: passed\n---\n");
    const batchFile = path.join(cwd, ".planning", "quick-batches", batch, "BATCH.json");
    const batchValue = readJson(batchFile);
    batchValue.items[0].directory = outside;
    fs.writeFileSync(batchFile, JSON.stringify(batchValue));
    assert.match(v2.recordVerification(cwd, parent, batch, allocation.round, item, round(cwd).revision).reason, /escapes/);
  });
});

test("legacy receipt mode rejects stale reports but accepts reports newer than summaries", async (t) => {
  for (const [label, summaryNewer, expectedOk] of [["fresh", false, true], ["stale", true, false]]) {
    await t.test(label, async () => {
      const cwd = tmp();
      const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
      await advanceToRemoved(cwd, allocation.round);
      const directory = writeVerification(cwd, "passed");
      const report = path.join(directory, `${item}-VERIFICATION.md`);
      const summary = path.join(directory, "01-SUMMARY.md");
      fs.writeFileSync(summary, "# Summary\n");
      const now = Date.now() / 1000;
      fs.utimesSync(report, now, summaryNewer ? now - 10 : now);
      fs.utimesSync(summary, now, summaryNewer ? now : now - 10);
      const result = v2.recordVerification(cwd, parent, batch, allocation.round, item, round(cwd).revision);
      assert.equal(result.ok, expectedOk, result.reason);
      assert.equal(round(cwd).items[item].verification_receipt !== null, expectedOk);
    });
  }
});

test("covered-file drift revokes replay, completion, and close even when receipt bytes are unchanged", async (t) => {
  await t.test("replay and completion", async () => {
    const cwd = tmp();
    const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
    await advanceToRemoved(cwd, allocation.round);
    const directory = writeFingerprintVerification(cwd);
    const verifyRevision = round(cwd).revision;
    assert.equal(v2.recordVerification(cwd, parent, batch, allocation.round, item, verifyRevision).ok, true);
    fs.appendFileSync(path.join(cwd, "src", "covered.txt"), "drift\n");
    assert.equal(v2.recordVerification(cwd, parent, batch, allocation.round, item, verifyRevision).ok, false);
    writeCompletionState(cwd);
    assert.match(v2.completeAuthorized(cwd, parent, batch, allocation.round, item, round(cwd).revision, {
      description: "fixture", date: "2026-09-12", commit: "abc123", directory: path.relative(cwd, directory),
    }).reason, /trusted passed verification receipt/);
  });

  await t.test("close", async () => {
    const cwd = tmp();
    const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
    await advanceToRemoved(cwd, allocation.round);
    const directory = writeFingerprintVerification(cwd);
    assert.equal(v2.recordVerification(cwd, parent, batch, allocation.round, item, round(cwd).revision).ok, true);
    writeCompletionState(cwd);
    const request = { description: "fixture", date: "2026-09-12", commit: "abc123", directory: path.relative(cwd, directory) };
    assert.equal(v2.completeAuthorized(cwd, parent, batch, allocation.round, item, round(cwd).revision, request).ok, true);
    transition(cwd, allocation.round, item, "completed");
    fs.appendFileSync(path.join(cwd, "src", "covered.txt"), "drift\n");
    assert.match(v2.closeRound(cwd, parent, batch, allocation.round, {}, round(cwd).revision).reason, /verification receipt/);
  });
});

test("current non-passed receipts are non-authorizing and stale variants persist nothing", async (t) => {
  for (const status of ["gaps_found", "human_needed"]) {
    await t.test(status, async () => {
      const cwd = tmp();
      const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
      await advanceToRemoved(cwd, allocation.round);
      writeFingerprintVerification(cwd, status);
      const result = v2.recordVerification(cwd, parent, batch, allocation.round, item, round(cwd).revision);
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.value.pending_completion, false);
      assert.notEqual(round(cwd).items[item].phase, "verification_passed");
      assert.equal(v2.closeRound(cwd, parent, batch, allocation.round, {}, round(cwd).revision).ok, false);
    });
    await t.test(`${status} stale`, async () => {
      const cwd = tmp();
      const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
      await advanceToRemoved(cwd, allocation.round);
      writeFingerprintVerification(cwd, status);
      fs.appendFileSync(path.join(cwd, "src", "covered.txt"), "drift\n");
      const result = v2.recordVerification(cwd, parent, batch, allocation.round, item, round(cwd).revision);
      assert.equal(result.ok, false);
      assert.equal(round(cwd).items[item].verification_receipt, null);
    });
  }
});

test("v2-complete reconciles a crash after BATCH completion but before journal outcome", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
  await advanceToRemoved(cwd, allocation.round);
  const directory = path.relative(cwd, writeVerification(cwd, "passed"));
  const verifyRevision = round(cwd).revision;
  assert.equal(v2.recordVerification(cwd, parent, batch, allocation.round, item, verifyRevision).ok, true);
  writeCompletionState(cwd);
  const expectedRevision = round(cwd).revision;
  const request = { description: "fixture", date: "2026-09-12", commit: "abc123", directory };
  const file = v2.roundPath(cwd, parent, batch, allocation.round);
  const journal = readJson(file);
  journal.items[item].events.push({ phase: "completion_intent", event: { expected_revision: expectedRevision, request } });
  journal.revision++;
  fs.writeFileSync(file, JSON.stringify(journal));
  assert.equal(quickBatch.completeQuickItem(cwd, batch, item, request).ok, true);
  const reconciled = v2.completeAuthorized(cwd, parent, batch, allocation.round, item, expectedRevision, request);
  assert.equal(reconciled.ok, true, reconciled.reason);
  assert.equal(reconciled.value.journal.revision, expectedRevision + 2);
  assert.equal(reconciled.value.journal.items[item].events.at(-1).phase, "completion_written");
});

test("attestation fully compares status and recover immutable job identity", async (t) => {
  const mutations = [
    ["session", (job) => { job.session_id = "ses-other"; }],
    ["directory", (job, cwd) => { const other = path.join(cwd, "worktrees", "other"); fs.mkdirSync(other, { recursive: true }); job.directory = other; }],
    ["manifest path", (job, cwd) => { const other = path.join(cwd, "other.json"); fs.writeFileSync(other, "{}"); job.manifest_path = other; }],
    ["agent", (job) => { job.manifest_agent_id = "agent-other"; }],
    ["hash", (job) => { job.manifest_entry_hash = "different-hash"; }],
    ["status", (job) => { job.status = "failed"; }],
    ["observed model", (job) => { job.observed_executor.model.id = "other-model"; }],
    ["stored provider", (job) => { job.requested_executor.model.providerID = "other-provider"; }],
    ["final deny", (job) => { job.observed_executor.final_permission.effect = "allow"; }],
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async () => {
      const cwd = tmp();
      const identity = makeIdentity(cwd, 1, item);
      const allocation = allocate(cwd);
      const entry = manifestEntry(identity);
      fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [entry])));
      advanceToSealed(cwd, allocation.round, item, identity, "ses-child");
      const input = evidence(identity, "ses-child", pluginJob(identity, "ses-child", entry));
      mutate(input.status.jobs[0], cwd);
      assert.equal((await attest(cwd, allocation.round, item, input)).ok, false);
    });
  }
});

test("attestation rejects direct status manifest_entry path or agent mismatch", async (t) => {
  for (const field of ["agent_id", "worktree_path"]) {
    await t.test(field, async () => {
      const cwd = tmp();
      const identity = makeIdentity(cwd, 1, item);
      const allocation = allocate(cwd);
      const entry = manifestEntry(identity);
      fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [entry])));
      advanceToSealed(cwd, allocation.round, item, identity, "ses-child");
      const input = evidence(identity, "ses-child", pluginJob(identity, "ses-child", entry));
      if (field === "agent_id") {
        input.status.jobs[0].manifest_entry.agent_id = "agent-other";
      } else {
        const other = path.join(cwd, "worktrees", "other");
        fs.mkdirSync(other, { recursive: true });
        input.status.jobs[0].manifest_entry.worktree_path = fs.realpathSync(other);
      }
      assert.match((await attest(cwd, allocation.round, item, input)).reason, /manifest(?:_entry| identity) mismatch/);
    });
  }
});

test("attestation rejects duplicate agent/path ambiguity but permits unrelated siblings", async (t) => {
  const cases = [
    ["duplicate exact", (entry) => ({ ...entry })],
    ["same agent another path", (entry, other) => ({ ...entry, worktree_path: other })],
    ["same path another agent", (entry) => ({ ...entry, agent_id: "agent-other" })],
  ];
  for (const [label, conflictingEntry] of cases) {
    await t.test(label, async () => {
      const cwd = tmp();
      const identity = makeIdentity(cwd, 1, item);
      const allocation = allocate(cwd);
      const entry = manifestEntry(identity);
      const other = path.join(cwd, "worktrees", "other");
      fs.mkdirSync(other, { recursive: true });
      fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [entry])));
      advanceToSealed(cwd, allocation.round, item, identity, "ses-child");
      fs.writeFileSync(allocation.manifest_path, JSON.stringify(nativeManifest(allocation.round, [entry, conflictingEntry(entry, other)])));
      assert.equal((await attest(cwd, allocation.round, item, evidence(identity, "ses-child", pluginJob(identity, "ses-child", entry)))).ok, false);
    });
  }
});

test("close embeds the complete receipt and cleanup survives receipt-cache deletion", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd);
  await advanceToRemoved(cwd, allocation.round);
  setBatchState(cwd, "complete");
  transition(cwd, allocation.round, item, "completed");
  const closed = v2.closeRound(cwd, parent, batch, allocation.round, {}, round(cwd).revision);
  assert.equal(closed.ok, true, closed.reason);

  const index = readJson(v2.indexPath(cwd, parent, batch));
  assert.equal(index.active, null);
  assert.deepEqual(index.receipts[0], closed.value.receipt);
  assert.equal(index.receipts[0].items[0].item_id, item);
  fs.unlinkSync(v2.receiptPath(cwd, parent, batch, allocation.round));

  const cleanup = v2.cleanupClosedRound(cwd, parent, batch, allocation.round);
  assert.equal(cleanup.ok, true, cleanup.reason);
  assert.equal(fs.existsSync(v2.roundPath(cwd, parent, batch, allocation.round)), false);
  assert.equal(fs.existsSync(v2.manifestPath(cwd, parent, batch, allocation.round)), false);
  assert.deepEqual(readJson(v2.indexPath(cwd, parent, batch)).receipts[0], closed.value.receipt);
  assert.equal(v2.cleanupClosedRound(cwd, parent, batch, allocation.round).ok, true);
});

test("cleanup refuses modified owned state or manifest", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd);
  await advanceToRemoved(cwd, allocation.round);
  setBatchState(cwd, "complete");
  transition(cwd, allocation.round, item, "completed");
  assert.equal(v2.closeRound(cwd, parent, batch, allocation.round, {}, round(cwd).revision).ok, true);
  fs.writeFileSync(v2.manifestPath(cwd, parent, batch, allocation.round), "{}\n");
  assert.match(v2.cleanupClosedRound(cwd, parent, batch, allocation.round).reason, /manifest hash mismatch/);
});

test("failed item preserves the active journal and cannot close", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd, [{ item_id: item }], batch, { validation_required: true });
  await advanceToRemoved(cwd, allocation.round);
  writeVerification(cwd, "gaps_found");
  assert.equal(quickBatch.applyV2Outcome(cwd, batch, item, "gaps_found", "gaps_found").ok, true);
  const verified = v2.recordVerification(cwd, parent, batch, allocation.round, item, round(cwd).revision);
  assert.equal(verified.ok, true, verified.reason);
  assert.equal(round(cwd).items[item].outcome, "gaps_found");
  assert.equal(v2.closeRound(cwd, parent, batch, allocation.round, {}, round(cwd).revision).ok, false);
  assert.equal(v2.reconcileActiveRound(cwd, parent, batch).value.active.round, allocation.round);
});

test("closeRound revalidates completed items against current BATCH state", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd);
  await advanceToRemoved(cwd, allocation.round);
  setBatchState(cwd, "complete");
  transition(cwd, allocation.round, item, "completed");
  setBatchState(cwd, "pending");
  assert.match(v2.closeRound(cwd, parent, batch, allocation.round, {}, round(cwd).revision).reason, /does not authorize completed/);
});

test("reconciliation keeps validating manifest identity after the worktree is removed", async () => {
  const cwd = tmp();
  const allocation = allocate(cwd);
  await advanceToRemoved(cwd, allocation.round);
  const directory = round(cwd).items[item].identity.directory;
  fs.rmdirSync(directory);
  const reconciled = v2.reconcileActiveRound(cwd, parent, batch);
  assert.equal(reconciled.ok, true, reconciled.reason);
});
