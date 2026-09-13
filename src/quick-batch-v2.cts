/* eslint-disable @typescript-eslint/ban-ts-comment,
                  @typescript-eslint/no-require-imports,
                  @typescript-eslint/no-unsafe-assignment,
                  @typescript-eslint/no-unsafe-member-access,
                  @typescript-eslint/no-unsafe-return,
                  @typescript-eslint/no-unsafe-call,
                  @typescript-eslint/no-unsafe-argument */
// @ts-nocheck -- security-reviewed durable V2 transport port
'use strict';

/* Durable journal for one parent-session/batch pair. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { withJournalLock, durableReplaceJson } = require("./journal-lock.cjs");
const { withPlanningLock } = require("./planning-workspace.cjs");
const quickBatch = require("./quick-batch.cjs");
const nativeAttestation = require("./opencode-v2-attestation.cjs");
const verificationReceipt = require("./opencode-v2-verification-receipt.cjs");
const { extractFrontmatter } = require("./frontmatter.cjs");
const scanPhasePlans = require("./plan-scan.cjs");
const { SCOPE } = require("./planning-scope.cjs");
const worktreeSafety = require("./worktree-safety.cjs");

const NATIVE_TRANSPORT = "native-tool";
const NATIVE_RUNTIME = "opencode-v2";

const PHASES = [
  "create_intent", "created", "start_intent", "started", "seal_intent",
  "sealed", "attested", "merge_intent", "merged", "teardown_pending",
  "removed", "verification_passed", "verification_failed",
  "verification_blocked", "completed",
];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const SAFE_COMMITISH = /^[A-Za-z0-9][A-Za-z0-9._/^~{}-]{0,255}$/;

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function canonicalJson(value) {
  const seen = new Set();
  function visit(current) {
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("canonical JSON rejects non-finite numbers");
      return current;
    }
    if (typeof current !== "object") throw new Error("canonical JSON rejects non-JSON values");
    if (seen.has(current)) throw new Error("canonical JSON rejects cyclic values");
    seen.add(current);
    let result;
    if (Array.isArray(current)) {
      const keys = Object.keys(current);
      if (keys.length !== current.length || keys.some((key, index) => key !== String(index))) {
        throw new Error("canonical JSON rejects sparse or decorated arrays");
      }
      result = current.map(visit);
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new Error("canonical JSON requires plain objects");
      result = {};
      for (const key of Object.keys(current).sort()) result[key] = visit(current[key]);
    }
    seen.delete(current);
    return result;
  }
  return JSON.stringify(visit(value));
}
function canonicalDigest(value) { return hash(canonicalJson(value)); }
function fail(reason) { return { ok: false, reason }; }
function ok(value) { return { ok: true, value }; }
function safe(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`invalid ${name}`);
  return hash(value);
}
function journalDir(cwd, parent, batch) {
  return path.join(cwd, ".opencode", ".runtime", "gsd-worktree-waves", safe(parent, "parent_session_id"), safe(batch, "batch_id"));
}
function indexPath(cwd, parent, batch) { return path.join(journalDir(cwd, parent, batch), "index.json"); }
function roundPath(cwd, parent, batch, round) { return path.join(journalDir(cwd, parent, batch), `round-${round}.json`); }
function manifestPath(cwd, parent, batch, round) { return path.join(journalDir(cwd, parent, batch), `manifest-${round}.json`); }
function receiptPath(cwd, parent, batch, round) { return path.join(journalDir(cwd, parent, batch), `receipt-${round}.json`); }
function read(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`corrupt or missing journal ${file}: ${error.message}`); }
}
function write(file, value) {
  durableReplaceJson(file, value);
}
function lock(cwd, parent, batch, fn) {
  return withJournalLock(journalDir(cwd, parent, batch), fn);
}
function batchJournalLock(cwd, parent, batch, fn) {
  // Lock order is global planning state first, V2 journal second. Never acquire
  // the planning lock while already holding the journal lock.
  return withPlanningLock(cwd, () => lock(cwd, parent, batch, fn));
}
function loadIndex(cwd, parent, batch) {
  const value = read(indexPath(cwd, parent, batch));
  if (!value || value.version !== 3 || value.parent_session_id !== parent || value.batch_id !== batch ||
      !Number.isSafeInteger(value.next_round) || value.next_round < 1 || !Array.isArray(value.receipts)) {
    throw new Error("invalid V2 journal index");
  }
  return value;
}
function loadRound(cwd, parent, batch, round) {
  const value = read(roundPath(cwd, parent, batch, round));
  if (!value || value.version !== 3 || value.parent_session_id !== parent || value.batch_id !== batch ||
      value.round !== round || !Number.isSafeInteger(value.revision) || !value.items || typeof value.items !== "object") {
    throw new Error("invalid V2 round journal");
  }
  return value;
}
function same(a, b) {
  try { return canonicalJson(a) === canonicalJson(b); } catch { return false; }
}
function canonical(existingPath) {
  if (typeof existingPath !== "string" || !existingPath) throw new Error("missing path");
  return fs.realpathSync(existingPath);
}
function resolved(file) { return path.resolve(file); }
function canonicalProspective(file) {
  const absolute = resolved(file);
  return path.join(canonical(path.dirname(absolute)), path.basename(absolute));
}
function isWithin(root, candidate, allowRoot = false) {
  const relative = path.relative(root, candidate);
  return (allowRoot || relative !== "") && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function validateSafeString(value, expression, name) {
  if (typeof value !== "string" || !expression.test(value)) throw new Error(`invalid ${name}`);
}
function validateIdentity(cwd, parent, batch, round, identity, orchestratorRoot, requireCreated = false) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error("invalid item identity");
  for (const key of ["wave_id", "manifest_agent_id", "directory", "branch", "expected_base", "manifest_path"]) {
    if (typeof identity[key] !== "string" || !identity[key]) throw new Error(`item identity lacks ${key}`);
  }
  validateSafeString(identity.wave_id, SAFE_ID, "wave_id");
  validateSafeString(identity.manifest_agent_id, SAFE_ID, "manifest_agent_id");
  validateSafeString(identity.branch, SAFE_BRANCH, "branch");
  if (identity.branch.includes("..") || identity.branch.endsWith(".lock")) throw new Error("invalid branch");
  validateSafeString(identity.expected_base, SAFE_COMMITISH, "expected_base");

  const directory = canonicalProspective(identity.directory);
  if (identity.directory !== directory) throw new Error("identity directory must be canonical");
  const expectedManifest = canonicalProspective(manifestPath(cwd, parent, batch, round));
  if (identity.manifest_path !== expectedManifest || canonicalProspective(identity.manifest_path) !== expectedManifest) {
    throw new Error("identity manifest_path is not the canonical helper-owned path for this round");
  }
  const root = canonical(orchestratorRoot || cwd);
  if (!isWithin(root, directory)) throw new Error("identity directory escapes orchestrator_root");
  if (!isWithin(root, expectedManifest, true)) throw new Error("helper manifest escapes orchestrator_root");
  if (requireCreated) {
    if (!fs.existsSync(directory)) throw new Error("identity directory does not exist at created");
    if (canonical(directory) !== directory || !fs.statSync(directory).isDirectory()) {
      throw new Error("identity directory is not the exact created directory");
    }
  }
  return { ...identity, directory, manifest_path: expectedManifest };
}
function emptyManifest(root, parent, batch, round) {
  return {
    orchestrator_root: root,
    transport: NATIVE_TRANSPORT,
    runtime: NATIVE_RUNTIME,
    parent_session_id: parent,
    batch_id: batch,
    round,
    worktrees: [],
  };
}
function allocation(cwd, parent, batch, round, items, root, validationRequired) {
  if (!Array.isArray(items) || !items.length) throw new Error("items must be a non-empty array");
  const seen = new Set();
  const journalItems = {};
  for (const input of items) {
    const id = input && (input.item_id || input.quick_id);
    if (typeof id !== "string" || !SAFE_ID.test(id) || seen.has(id)) throw new Error("items require unique safe item_id values");
    seen.add(id);
    const identity = input.identity == null ? null : validateIdentity(cwd, parent, batch, round, input.identity, root);
    journalItems[id] = {
      item_id: id,
      phase: null,
      identity,
      session_id: null,
      status_digest: null,
      executor_identity: null,
      created_manifest_entry_hash: null,
      outcome: null,
      verification_receipt: null,
      events: [],
    };
  }
  return {
    parent_session_id: parent,
    batch_id: batch,
    round,
    transport: NATIVE_TRANSPORT,
    runtime: NATIVE_RUNTIME,
    validation_required: validationRequired,
    items: journalItems,
    orchestrator_root: root,
  };
}
function phaseAtLeastCreated(phase) {
  return phase !== null && phase !== "create_intent";
}
function intendedDirectoryExists(state) {
  return Object.values(state.items).some((item) => item.identity && fs.existsSync(item.identity.directory));
}
function validateManifestShape(shared, expectedRoot) {
  if (!shared || typeof shared !== "object" || Array.isArray(shared) ||
      shared.orchestrator_root !== expectedRoot || shared.transport !== NATIVE_TRANSPORT ||
      shared.runtime !== NATIVE_RUNTIME || typeof shared.parent_session_id !== "string" ||
      typeof shared.batch_id !== "string" || !Number.isSafeInteger(shared.round) ||
      !Array.isArray(shared.worktrees)) {
    throw new Error("invalid shared manifest shape or orchestrator_root");
  }
}
function validateRoundState(cwd, current, parent, batch, active) {
  const seeded = active.seed.items;
  if (!current || current.version !== 3 || current.parent_session_id !== parent ||
      current.batch_id !== batch || current.round !== active.round ||
      current.orchestrator_root !== active.seed.orchestrator_root ||
      current.transport !== NATIVE_TRANSPORT || current.runtime !== NATIVE_RUNTIME ||
      typeof current.validation_required !== "boolean" ||
      !Number.isSafeInteger(current.revision) || !current.items ||
      typeof current.items !== "object" || Array.isArray(current.items) ||
      Object.keys(current.items).length !== Object.keys(seeded).length) {
    throw new Error("partial or mismatched allocated round state");
  }
  for (const id of Object.keys(seeded)) {
    const item = current.items[id];
    if (!item || item.item_id !== id || !Array.isArray(item.events) ||
        (seeded[id].identity !== null && !same(item.identity, seeded[id].identity))) {
      throw new Error("partial or mismatched allocated round state");
    }
    if (item.identity !== null) {
      const normalized = validateIdentity(
        cwd,
        parent,
        batch,
        active.round,
        item.identity,
        active.seed.orchestrator_root,
      );
      if (!same(normalized, item.identity)) throw new Error("noncanonical round item identity");
    }
  }
}
function validateManifestAgainstState(cwd, parent, batch, active, state, shared) {
  validateManifestShape(shared, active.seed.orchestrator_root);
  if (shared.parent_session_id !== parent || shared.batch_id !== batch || shared.round !== active.round) {
    throw new Error("shared manifest coordinates do not match active round");
  }
  const root = canonical(state.orchestrator_root || cwd);
  for (const item of Object.values(state.items)) {
    if (!phaseAtLeastCreated(item.phase)) continue;
    const directoryMayBeRemoved = [
      "removed",
      "verification_passed",
      "verification_failed",
      "verification_blocked",
      "completed",
    ].includes(item.phase);
    const identity = validateIdentity(
      cwd, parent, batch, active.round, item.identity, root, !directoryMayBeRemoved,
    );
    const entry = findManifestEntry(
      shared, root, identity.manifest_agent_id, identity.directory, !directoryMayBeRemoved,
    );
    const snapshot = manifestEntrySnapshot(entry, identity.directory);
    if (snapshot.branch !== identity.branch || snapshot.expected_base !== identity.expected_base) {
      throw new Error("shared manifest binding mismatch");
    }
  }
}
function initialize(cwd, parent, batch, active) {
  const stateFile = roundPath(cwd, parent, batch, active.round);
  const manifestFile = manifestPath(cwd, parent, batch, active.round);
  const expected = { version: 3, ...active.seed, revision: 0 };
  const hasState = fs.existsSync(stateFile);
  const hasManifest = fs.existsSync(manifestFile);
  const shared = hasManifest ? read(manifestFile) : null;
  const state = hasState ? read(stateFile) : expected;

  if (hasManifest) validateManifestShape(shared, active.seed.orchestrator_root);

  if (hasState) {
    validateRoundState(cwd, state, parent, batch, active);
  } else {
    const manifestHasEntries = shared && Array.isArray(shared.worktrees) && shared.worktrees.length > 0;
    if (manifestHasEntries || intendedDirectoryExists(expected)) {
      throw new Error("missing round state after worktree side effects");
    }
    write(stateFile, expected);
  }

  if (hasManifest) {
    validateManifestAgainstState(cwd, parent, batch, active, state, shared);
  } else {
    const allPreCreate = Object.values(state.items).every((item) => !phaseAtLeastCreated(item.phase));
    if (!allPreCreate || intendedDirectoryExists(state)) {
      throw new Error("missing shared manifest after worktree side effects");
    }
    write(manifestFile, emptyManifest(active.seed.orchestrator_root, parent, batch, active.round));
  }
  return state;
}
function allocateRound(cwd, parent, batch, items, options = {}) {
  try {
    return lock(cwd, parent, batch, () => {
      const file = indexPath(cwd, parent, batch);
      const index = fs.existsSync(file)
        ? loadIndex(cwd, parent, batch)
        : { version: 3, parent_session_id: parent, batch_id: batch, next_round: 1, active: null, receipts: [] };
      if (index.active) return fail(`active round ${index.active.round} must be reconciled or closed first`);
      const root = options.orchestrator_root == null ? null : canonical(options.orchestrator_root);
      if (typeof options.validation_required !== "boolean") throw new Error("validation_required must be explicit");
      const seed = allocation(cwd, parent, batch, index.next_round, items, root, options.validation_required);
      index.active = { round: index.next_round, seed };
      index.next_round++;
      // Durable allocation point: install before dependent files.
      write(file, index);
      const journal = initialize(cwd, parent, batch, index.active);
      return ok({ round: journal.round, journal, manifest_path: canonicalProspective(manifestPath(cwd, parent, batch, journal.round)) });
    });
  } catch (error) { return fail(error.message); }
}
function reconcileActiveRound(cwd, parent, batch) {
  try {
    return lock(cwd, parent, batch, () => {
      const file = indexPath(cwd, parent, batch);
      if (!fs.existsSync(file)) return ok({ active: null, initialized: false });
      const index = loadIndex(cwd, parent, batch);
      return ok(index.active ? { active: initialize(cwd, parent, batch, index.active) } : { active: null });
    });
  } catch (error) { return fail(error.message); }
}
function requireActive(index, round) {
  if (!index.active || index.active.round !== round) throw new Error("round is not the current active round");
}
function requireRevision(record, expected) {
  if (!Number.isSafeInteger(expected) || expected !== record.revision) throw new Error(`stale expected_revision (expected ${record.revision})`);
}
function createdManifestSnapshot(cwd, parent, batch, round, record, item) {
  const identity = validateIdentity(
    cwd, parent, batch, round, item.identity, record.orchestrator_root, true,
  );
  const shared = read(identity.manifest_path);
  validateManifestShape(shared, record.orchestrator_root);
  if (shared.parent_session_id !== parent || shared.batch_id !== batch || shared.round !== round) {
    throw new Error("shared manifest coordinates do not match journal");
  }
  const root = canonical(record.orchestrator_root || cwd);
  const entry = findManifestEntry(shared, root, identity.manifest_agent_id, identity.directory);
  const snapshot = manifestEntrySnapshot(entry, identity.directory);
  if (snapshot.branch !== identity.branch || snapshot.expected_base !== identity.expected_base) {
    throw new Error("shared manifest binding mismatch");
  }
  return snapshot;
}
function exactBatchItem(cwd, batch, itemId) {
  const loaded = quickBatch.loadBatch(cwd, batch);
  if (!loaded.ok) throw new Error(loaded.reason);
  const matches = loaded.value.items.filter((candidate) => candidate.quick_id === itemId);
  if (matches.length !== 1) throw new Error("BATCH must contain exactly one matching item");
  return matches[0];
}
function authoritativeBatchTransition(cwd, batch, itemId, phase) {
  const item = exactBatchItem(cwd, batch, itemId);
  const failure = item.failure_reason;
  if (phase === "verification_passed" && item.status === "pending" && failure === null) {
    return { status: "pending", outcome: "passed", failure_reason: null };
  }
  if (phase === "verification_failed" && item.status === "failed" && ["gaps_found", "merge_failed"].includes(failure)) {
    return { status: "failed", outcome: failure, failure_reason: failure };
  }
  if (phase === "verification_blocked" && item.status === "blocked" && typeof failure === "string") {
    if (failure.startsWith("human_needed:")) return { status: "blocked", outcome: "human_needed", failure_reason: failure };
    if (/^dependency_failed:[A-Za-z0-9._-]+(?:,[A-Za-z0-9._-]+)*$/.test(failure)) {
      return { status: "blocked", outcome: "dependency_failed", failure_reason: failure };
    }
  }
  if (phase === "completed" && item.status === "complete" && failure === null) {
    return { status: "complete", outcome: "complete", failure_reason: null };
  }
  throw new Error(`BATCH item state does not authorize ${phase}`);
}
function fingerprintCoversCurrentArtifacts(artifact) {
  const frontmatter = extractFrontmatter(fs.readFileSync(artifact.path, "utf8"), artifact.path);
  const coveredFiles = frontmatter.covered_files;
  const coveredDigest = frontmatter.covered_digest;
  if (coveredFiles === undefined && coveredDigest === undefined) return true;
  if (!Array.isArray(coveredFiles) || !coveredFiles.every((file) => typeof file === "string") || typeof coveredDigest !== "string") return false;
  const scan = scanPhasePlans(path.dirname(artifact.path));
  if (scan.scope !== SCOPE.COMPLETE) return false;
  return [...scan.allPlanFiles, ...scan.summaryFiles].every((file) => {
    const normalized = file.replaceAll(path.sep, "/");
    return coveredFiles.some((covered) => covered === normalized || covered.endsWith(`/${normalized}`));
  });
}
function receiptAuthorizesCurrentVerification(receiptPolicy, cwd, batch, itemId, receipt, expectedStatus) {
  if (!receiptPolicy.receiptAuthorizesVerification(quickBatch, cwd, batch, itemId, receipt, expectedStatus)) return false;
  try { return fingerprintCoversCurrentArtifacts(receiptPolicy.verificationArtifact(quickBatch, cwd, batch, itemId)); }
  catch { return false; }
}

function recordTransition(
  cwd,
  parent,
  batch,
  round,
  itemId,
  phase,
  event = {},
  expectedRevision,
  trustedAttestation = false,
) {
  try {
      const requiresBatchAuthority = ["verification_passed", "verification_failed", "verification_blocked", "completed"].includes(phase);
    const runLocked = requiresBatchAuthority ? batchJournalLock : lock;
    return runLocked(cwd, parent, batch, () => {
      const index = loadIndex(cwd, parent, batch);
      requireActive(index, round);
      if (!PHASES.includes(phase) || !event || typeof event !== "object" || Array.isArray(event)) return fail("invalid transition");
      const record = loadRound(cwd, parent, batch, round);
      const item = record.items[itemId];
      if (!item) return fail(`unknown journal item ${itemId}`);
      if (phase === "merged" || phase === "removed") {
        return fail(`${phase} must be recorded by its authorized native mutation route`);
      }
      if (["verification_passed", "verification_failed", "verification_blocked"].includes(phase)) {
        return fail("verification transitions must be recorded by v2-verify");
      }
      if (phase === "completed") {
        const authoritative = authoritativeBatchTransition(cwd, batch, itemId, phase);
        if (record.validation_required) {
          if (item.phase !== "verification_passed" ||
              !receiptAuthorizesCurrentVerification(verificationReceipt, cwd, batch, itemId, item.verification_receipt, "passed")) {
            return fail("completed requires the current trusted passed verification receipt");
          }
        } else if (item.phase !== "removed") {
          return fail("non-validated completion requires removed");
        }
        event = { authoritative_batch: authoritative };
      }
      const prior = phase === "merge_intent"
        ? item.events.findLast((candidate) => candidate.phase === phase)
        : item.events[item.events.length - 1];
      // An attestation refresh at merge_intent is append-only: the original
      // merge_intent remains immutable while item.status_digest advances. For
      // crash recovery, treat the original immutable tips plus that latest
      // digest as the effective replay value.
      const replayEvent = phase === "merge_intent" && item.phase === "merge_intent" && prior
        ? { ...prior.event, status_digest: item.status_digest }
        : prior && prior.event;
      const replay = item.phase === phase && replayEvent && same(replayEvent, event);
      if (!replay) requireRevision(record, expectedRevision);
      if (event.identity !== undefined) {
        const normalized = validateIdentity(cwd, parent, batch, round, event.identity, record.orchestrator_root);
        if (phase === "created" && item.identity === null) return fail("created requires identity set by create_intent");
        if (item.identity !== null && !same(normalized, item.identity)) return fail("immutable item identity mismatch");
        if (item.identity === null) item.identity = normalized;
      }
      if (phase === "create_intent" && item.identity === null) return fail("create_intent requires identity");
      if (phase === "created" && item.identity === null) return fail("created requires identity set by create_intent");
      if (phase === "started" && (typeof event.session_id !== "string" || !event.session_id)) {
        return fail("started requires session_id");
      }
      if (phase === "attested" && (typeof event.status_digest !== "string" || !event.status_digest)) {
        return fail("attested requires status_digest");
      }
      if (phase === "attested" && !trustedAttestation) {
        return fail("attested must be recorded by attestPlugin");
      }
      if (phase === "merge_intent" && ["branch_tip", "target_tip", "status_digest"].some(
        (key) => typeof event[key] !== "string" || !event[key],
      )) {
        return fail("merge_intent requires branch_tip, target_tip, and status_digest");
      }
      if (phase === "merge_intent" && event.status_digest !== item.status_digest) {
        return fail("merge_intent status_digest does not match fresh attestation");
      }
      if (phase === "merge_intent") {
        if (!attestationAuthorizesMutation(item, Date.now())) {
          return fail("merge_intent requires fresh native OpenCode plugin RPC provenance");
        }
      }
      if (phase === "merged") {
        if (!attestationAuthorizesMutation(item, Date.now())) {
          return fail("merged requires fresh native OpenCode plugin RPC provenance");
        }
      }
      if (replay) return ok({ idempotent: true, journal: record });
      const current = item.phase;
      const next = current === null ? "create_intent" : PHASES[PHASES.indexOf(current) + 1];
      const permitted = phase === next ||
        (current === "removed" && ["completed", "verification_failed", "verification_blocked"].includes(phase)) ||
        (current === "verification_passed" && phase === "completed");
      if (!permitted) return fail(`skipped or invalid transition ${String(current)} -> ${phase}`);
      if (phase === "created") {
        const snapshot = createdManifestSnapshot(cwd, parent, batch, round, record, item);
        item.created_manifest_entry_hash = canonicalDigest(snapshot);
      }
      if (phase === "start_intent") {
        const snapshot = createdManifestSnapshot(cwd, parent, batch, round, record, item);
        if (canonicalDigest(snapshot) !== item.created_manifest_entry_hash) {
          return fail("manifest entry changed after created and before plugin start");
        }
      }
      if (phase === "started") {
        item.session_id = event.session_id;
      }
      if (phase === "attested") {
        item.status_digest = event.status_digest;
      }
      item.phase = phase;
      item.events.push({ phase, event });
      record.revision++;
      write(roundPath(cwd, parent, batch, round), record);
      return ok({ idempotent: false, journal: record });
    });
  } catch (error) { return fail(error.message); }
}
function transition(cwd, parent, batch, round, itemId, phase, event = {}, expectedRevision) {
  return recordTransition(cwd, parent, batch, round, itemId, phase, event, expectedRevision, false);
}

// BATCH.json deliberately owns only these three dispatch recovery fields.
function bindBatchItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("missing BATCH item");
  for (const key of ["dispatched_worktree", "dispatched_branch", "dispatched_base"]) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error("BATCH item lacks dispatched snake_case fields");
  }
  return {
    worktree_path: canonical(value.dispatched_worktree),
    branch: value.dispatched_branch,
    expected_base: value.dispatched_base,
  };
}
function manifestEntrySnapshot(entry, directory) {
  return {
    agent_id: entry.agent_id,
    worktree_path: directory,
    branch: entry.branch,
    expected_base: entry.expected_base,
    files_modified: Object.hasOwn(entry, "files_modified") ? entry.files_modified : null,
    declared_deletions: Object.hasOwn(entry, "declared_deletions") ? entry.declared_deletions : null,
  };
}
function findManifestEntry(shared, root, agentId, directory, requireExisting = true) {
  if (!shared || typeof shared !== "object" || Array.isArray(shared) || !Array.isArray(shared.worktrees)) {
    throw new Error("shared manifest must contain a worktrees array");
  }
  const resolvedEntries = shared.worktrees.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { entry, invalid: true };
    try {
      const candidate = path.resolve(root || process.cwd(), entry.worktree_path);
      const worktree = requireExisting ? canonical(candidate) : canonicalProspective(candidate);
      return { entry, directory: worktree };
    } catch {
      return { entry, invalid: true };
    }
  });
  // Keep the predicates explicit: unrelated valid sibling entries are allowed.
  const exact = resolvedEntries.filter(({ entry, directory: candidate }) => entry && entry.agent_id === agentId && candidate === directory);
  if (exact.length !== 1) throw new Error("shared manifest must contain exactly one matching entry");
  if (resolvedEntries.some(({ entry, directory: candidate }) => entry && entry.agent_id === agentId && candidate !== directory)) {
    throw new Error("manifest agent identity is ambiguous across paths");
  }
  if (resolvedEntries.some(({ entry, directory: candidate }) => entry && entry.agent_id !== agentId && candidate === directory)) {
    throw new Error("manifest path identity is ambiguous across agents");
  }
  const match = exact[0];
  if (match.invalid || typeof match.entry.branch !== "string" || !match.entry.branch ||
      typeof match.entry.expected_base !== "string" || !match.entry.expected_base) {
    throw new Error("matching manifest identity is malformed");
  }
  return match.entry;
}
function exactJobIdentity(job) {
  const directory = canonical(job.directory);
  const manifest = canonical(job.manifest_path);
  if (job.directory !== directory || job.manifest_path !== manifest) throw new Error("plugin job paths must be canonical");
  return {
    session_id: job.session_id,
    directory,
    manifest_path: manifest,
    manifest_agent_id: job.manifest_agent_id,
    manifest_entry_hash: job.manifest_entry_hash,
    status: job.status,
    agent: job.agent,
    model: job.model,
  };
}
function selectJob(jobs, sessionId, label) {
  const matches = Array.isArray(jobs) ? jobs.filter((job) => job && job.session_id === sessionId) : [];
  if (matches.length !== 1) {
    throw new Error(`${label} must contain exactly one job for the item session`);
  }
  return matches[0];
}
function latestAttestationEvent(item) {
  return item.events.findLast(({ phase }) => phase === "attested" || phase === "attestation_refreshed");
}
function hasNativeProvenance(event) {
  return event?.provenance?.source === nativeAttestation.PROVENANCE &&
    event.provenance.rpc_id === nativeAttestation.RPC_ID &&
    event.provenance.rpc_method === nativeAttestation.RPC_METHOD &&
    nativeAttestation.compatibleVersion(event.provenance.service_version);
}
function exactDeny(permission) {
  return permission && typeof permission === "object" && !Array.isArray(permission) &&
    Object.keys(permission).sort().join(",") === "action,effect,resource" &&
    permission.action === "gsd_worktree_task" && permission.resource === "*" && permission.effect === "deny";
}
function hasExactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function canonicalExecutorIdentity(job, snapshot, parent) {
  const requested = job.requested_executor;
  const observed = job.observed_executor;
  if (!hasExactKeys(requested, ["session_id", "parent_session_id", "directory", "manifest_agent_id", "agent", "model", "final_permission"]) ||
      !hasExactKeys(observed, ["session_id", "parent_session_id", "directory", "agent", "model", "outcome", "final_permission"]) ||
      requested.session_id !== snapshot.sessionId || requested.parent_session_id !== parent ||
      requested.directory !== snapshot.identity.directory ||
      requested.manifest_agent_id !== snapshot.identity.manifest_agent_id ||
      requested.agent !== job.agent || !same(requested.model, job.model) || !exactDeny(requested.final_permission) ||
      observed.session_id !== requested.session_id || observed.parent_session_id !== requested.parent_session_id ||
      observed.directory !== requested.directory || observed.agent !== requested.agent ||
      !same(observed.model, requested.model) || observed.outcome !== "succeeded" || !exactDeny(observed.final_permission)) {
    throw new Error("stored-request and live-observed executor identity mismatch");
  }
  if (typeof requested.agent !== "string" || !requested.agent ||
      !hasExactKeys(requested.model, ["providerID", "id", "variant"]) ||
      !hasExactKeys(observed.model, ["providerID", "id", "variant"]) ||
      typeof requested.model.providerID !== "string" || !requested.model.providerID ||
      typeof requested.model.id !== "string" || !requested.model.id || requested.model.id.includes("/") ||
      !["medium", "high"].includes(requested.model.variant)) {
    throw new Error("plugin model/provider/bare-model/variant identity is malformed");
  }
  return {
    session_id: requested.session_id,
    parent_session_id: requested.parent_session_id,
    directory: requested.directory,
    manifest_agent_id: requested.manifest_agent_id,
    agent: requested.agent,
    provider: requested.model.providerID,
    model: requested.model.id,
    variant: requested.model.variant,
    final_permission: { action: "gsd_worktree_task", resource: "*", effect: "deny" },
  };
}
function validateWholeWaveJobs(jobs, parent, manifestPath) {
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error("attestation RPC must contain a complete job set");
  const sessions = new Set();
  const agents = new Set();
  const directories = new Set();
  for (const job of jobs) {
    const exact = exactJobIdentity(job);
    const requested = job.requested_executor;
    const observed = job.observed_executor;
    if (exact.status !== "succeeded" || typeof exact.session_id !== "string" || !exact.session_id ||
        typeof exact.manifest_agent_id !== "string" || !exact.manifest_agent_id ||
        typeof exact.manifest_entry_hash !== "string" || !exact.manifest_entry_hash ||
        exact.manifest_path !== manifestPath || typeof exact.agent !== "string" || !exact.agent ||
        !hasExactKeys(exact.model, ["providerID", "id", "variant"]) ||
        typeof exact.model.providerID !== "string" || !exact.model.providerID ||
        typeof exact.model.id !== "string" || !exact.model.id || exact.model.id.includes("/") ||
        !["medium", "high"].includes(exact.model.variant) ||
        sessions.has(exact.session_id) || agents.has(exact.manifest_agent_id) || directories.has(exact.directory)) {
      throw new Error("attestation RPC job set is incomplete or ambiguous");
    }
    sessions.add(exact.session_id);
    agents.add(exact.manifest_agent_id);
    directories.add(exact.directory);
    if (!hasExactKeys(requested, ["session_id", "parent_session_id", "directory", "manifest_agent_id", "agent", "model", "final_permission"]) ||
        !hasExactKeys(observed, ["session_id", "parent_session_id", "directory", "agent", "model", "outcome", "final_permission"]) ||
        requested.session_id !== exact.session_id || requested.parent_session_id !== parent ||
        requested.directory !== exact.directory || requested.manifest_agent_id !== exact.manifest_agent_id ||
        requested.agent !== exact.agent || !same(requested.model, exact.model) || !exactDeny(requested.final_permission) ||
        observed.session_id !== requested.session_id || observed.parent_session_id !== parent ||
        observed.directory !== requested.directory || observed.agent !== requested.agent ||
        !same(observed.model, requested.model) || observed.outcome !== "succeeded" || !exactDeny(observed.final_permission)) {
      throw new Error("attestation RPC whole-wave executor identity mismatch");
    }
    if (!job.manifest_entry || job.manifest_entry.agent_id !== exact.manifest_agent_id ||
        canonical(job.manifest_entry.worktree_path) !== exact.directory ||
        hash(JSON.stringify(manifestEntrySnapshot(job.manifest_entry, exact.directory))) !== exact.manifest_entry_hash) {
      throw new Error("attestation RPC whole-wave manifest identity mismatch");
    }
  }
}
function expectedWaveJobs(cwd, parent, batch, round, record, waveId) {
  const expected = [];
  const sessions = new Set();
  const agents = new Set();
  const directories = new Set();
  for (const item of Object.values(record.items)) {
    if (item.identity === null) continue;
    const identity = validateIdentity(
      cwd, parent, batch, round, item.identity, record.orchestrator_root,
    );
    if (identity.wave_id !== waveId) continue;
    if (typeof item.session_id !== "string" || !item.session_id ||
        sessions.has(item.session_id) || agents.has(identity.manifest_agent_id) ||
        directories.has(identity.directory)) {
      throw new Error("journal wave job set is incomplete or ambiguous");
    }
    sessions.add(item.session_id);
    agents.add(identity.manifest_agent_id);
    directories.add(identity.directory);
    expected.push({
      session_id: item.session_id,
      wave_id: identity.wave_id,
      manifest_agent_id: identity.manifest_agent_id,
      directory: identity.directory,
      manifest_path: identity.manifest_path,
      branch: identity.branch,
      expected_base: identity.expected_base,
    });
  }
  if (expected.length === 0) throw new Error("journal wave job set is empty");
  return expected;
}
function validateExpectedWaveJobSet(jobs, expected) {
  if (jobs.length !== expected.length) {
    throw new Error("attestation RPC job set does not exactly match the locked journal wave");
  }
  const expectedBySession = new Map(expected.map((job) => [job.session_id, job]));
  for (const job of jobs) {
    const exact = exactJobIdentity(job);
    const bound = expectedBySession.get(exact.session_id);
    if (!bound || exact.manifest_agent_id !== bound.manifest_agent_id ||
        exact.directory !== bound.directory || exact.manifest_path !== bound.manifest_path ||
        job.manifest_entry.branch !== bound.branch || job.manifest_entry.expected_base !== bound.expected_base) {
      throw new Error("attestation RPC job set does not exactly match the locked journal wave");
    }
  }
}
function attestationAuthorizesMutation(item, now) {
  const latest = latestAttestationEvent(item);
  return Boolean(latest && hasNativeProvenance(latest.event) &&
    latest.event.status_digest === item.status_digest &&
    Number.isSafeInteger(latest.event.checked_at) && latest.event.checked_at <= now &&
    now - latest.event.checked_at <= 30_000 && item.executor_identity &&
    same(latest.event.executor_identity, item.executor_identity));
}
function nativeReplay(record, item, expectedRevision, now) {
  const latest = item.events.at(-1);
  if (record.revision !== expectedRevision + 1 || !latest ||
      !["attested", "attestation_refreshed"].includes(latest.phase) ||
      !hasNativeProvenance(latest.event) ||
      latest.event?.provenance?.expected_revision !== expectedRevision ||
      !Number.isSafeInteger(latest.event?.checked_at) || latest.event.checked_at > now ||
      now - latest.event.checked_at > 30_000) return false;
  return true;
}
function snapshotAttestation(cwd, parent, batch, round, itemId, expectedRevision, now) {
  return lock(cwd, parent, batch, () => {
    const index = loadIndex(cwd, parent, batch);
    requireActive(index, round);
    const record = loadRound(cwd, parent, batch, round);
    const item = record.items[itemId];
    if (!item) throw new Error(`unknown journal item ${itemId}`);
    const replayCandidate = nativeReplay(record, item, expectedRevision, now);
    if (!replayCandidate) requireRevision(record, expectedRevision);
    if (!["sealed", "attested", "merge_intent"].includes(item.phase)) {
      throw new Error("item must be sealed, attested, or at merge_intent before attestation");
    }
    const identity = validateIdentity(cwd, parent, batch, round, item.identity, record.orchestrator_root);
    if (typeof item.session_id !== "string" || !item.session_id) throw new Error("journal item lacks a child session");
    const expectedJobs = expectedWaveJobs(
      cwd, parent, batch, round, record, identity.wave_id,
    );
    return {
      expectedRevision,
      casRevision: record.revision,
      replayCandidate,
      identity: structuredClone(identity),
      sessionId: item.session_id,
      expectedJobs: structuredClone(expectedJobs),
      phase: item.phase,
      orchestratorRoot: record.orchestrator_root,
    };
  });
}
function validatePluginEvidence(status, snapshot, parent, now, provenance) {
  const checkedAt = status && status.checked_at;
  if (!status || status.wave_id !== snapshot.identity.wave_id || status.parent_session_id !== parent ||
      status.sealed !== true || status.merge_ready !== true ||
      !Number.isSafeInteger(checkedAt) || checkedAt > now || now - checkedAt > 30_000 ||
      !Array.isArray(status.reasons) || status.reasons.length !== 0) {
    throw new Error("status is not fresh merge-ready plugin RPC evidence");
  }
  validateWholeWaveJobs(status.jobs, parent, snapshot.identity.manifest_path);
  validateExpectedWaveJobSet(status.jobs, snapshot.expectedJobs);
  const job = selectJob(status.jobs, snapshot.sessionId, "attestation RPC");
  const exact = exactJobIdentity(job);
  if (exact.status !== "succeeded" || exact.session_id !== snapshot.sessionId ||
      exact.directory !== snapshot.identity.directory || exact.manifest_path !== snapshot.identity.manifest_path ||
      exact.manifest_agent_id !== snapshot.identity.manifest_agent_id ||
      typeof exact.manifest_entry_hash !== "string" || !exact.manifest_entry_hash) {
    throw new Error("plugin job identity mismatch");
  }
  const startedAt = provenance?.request_started_at;
  const finishedAt = provenance?.request_finished_at;
  const tolerance = nativeAttestation.OBSERVATION_CLOCK_TOLERANCE_MS;
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(finishedAt) || finishedAt < startedAt ||
      finishedAt - startedAt > nativeAttestation.RPC_TIMEOUT_MS + tolerance ||
      checkedAt < startedAt - tolerance || checkedAt > finishedAt + tolerance) {
    throw new Error("plugin checked_at is outside the bounded RPC observation interval");
  }
  const executorIdentity = canonicalExecutorIdentity(job, snapshot, parent);
  return { checkedAt, job, exact, executorIdentity };
}
function persistAttestation(cwd, parent, batch, round, itemId, snapshot, observed, observation) {
  return batchJournalLock(cwd, parent, batch, () => {
      const index = loadIndex(cwd, parent, batch);
      requireActive(index, round);
      const record = loadRound(cwd, parent, batch, round);
      const item = record.items[itemId];
      requireRevision(record, snapshot.casRevision);
      if (!item || item.phase !== snapshot.phase || item.session_id !== snapshot.sessionId || !same(item.identity, snapshot.identity)) {
        return fail("journal attestation compare-and-swap identity mismatch");
      }
      const identity = validateIdentity(cwd, parent, batch, round, item.identity, record.orchestrator_root);
      const loadedBatch = quickBatch.loadBatch(cwd, batch);
      if (!loadedBatch.ok) return fail(loadedBatch.reason);
      const batchMatches = loadedBatch.value.items.filter((candidate) => candidate.quick_id === itemId);
      if (batchMatches.length !== 1) return fail("BATCH must contain exactly one matching item");
      const bound = bindBatchItem(batchMatches[0]);
      if (bound.worktree_path !== identity.directory || bound.branch !== identity.branch || bound.expected_base !== identity.expected_base) {
        return fail("BATCH dispatch identity mismatch");
      }
       const shared = read(identity.manifest_path);
       validateManifestShape(shared, record.orchestrator_root);
       if (shared.parent_session_id !== parent || shared.batch_id !== batch || shared.round !== round) {
         return fail("shared manifest coordinates do not match journal");
       }
      const root = canonical(record.orchestrator_root || cwd);
      if (!isWithin(root, identity.directory) || !isWithin(root, identity.manifest_path, true)) {
        return fail("manifest binding escapes orchestrator root");
      }
      const entry = findManifestEntry(shared, root, identity.manifest_agent_id, identity.directory);
      const manifestSnapshot = manifestEntrySnapshot(entry, identity.directory);
      if (manifestSnapshot.branch !== identity.branch || manifestSnapshot.expected_base !== identity.expected_base) return fail("shared manifest binding mismatch");
      if (hash(JSON.stringify(manifestSnapshot)) !== observed.exact.manifest_entry_hash) return fail("shared manifest snapshot hash mismatch");
      if (observed.job.manifest_entry !== undefined) {
        if (!observed.job.manifest_entry || observed.job.manifest_entry.agent_id !== identity.manifest_agent_id ||
            canonical(observed.job.manifest_entry.worktree_path) !== identity.directory || !same(observed.job.manifest_entry, manifestSnapshot)) {
          return fail("status manifest_entry mismatch");
        }
      }

      const statusDigest = canonicalDigest(observation.evidence);
      const attestation = {
        wave_id: identity.wave_id,
        session_id: observed.exact.session_id,
        manifest_entry_hash: observed.exact.manifest_entry_hash,
        status_digest: statusDigest,
        checked_at: observed.checkedAt,
        executor_identity: observed.executorIdentity,
        provenance: { ...observation.provenance, expected_revision: snapshot.expectedRevision },
      };
      const previousAttestation = latestAttestationEvent(item);
      if (snapshot.replayCandidate) {
        if (item.status_digest === statusDigest && previousAttestation && same(previousAttestation.event, attestation)) {
          return ok({ idempotent: true, journal: record });
        }
        return fail(`stale expected_revision (expected ${record.revision})`);
      }
      if (item.phase !== "sealed" && item.status_digest === statusDigest && previousAttestation &&
          same(previousAttestation.event, attestation)) {
        return ok({ idempotent: true, journal: record });
      }
      if (item.phase === "sealed") {
        item.phase = "attested";
        item.status_digest = statusDigest;
        item.events.push({ phase: "attested", event: attestation });
      } else {
        if (item.phase === "merge_intent") {
          const mergeIntent = item.events.findLast(({ phase }) => phase === "merge_intent");
          if (!mergeIntent || !mergeIntent.event || typeof mergeIntent.event.branch_tip !== "string" ||
              !mergeIntent.event.branch_tip || typeof mergeIntent.event.target_tip !== "string" || !mergeIntent.event.target_tip) {
            return fail("merge_intent audit event is missing immutable tips");
          }
        }
        item.status_digest = statusDigest;
        item.events.push({ phase: "attestation_refreshed", event: attestation });
      }
      item.executor_identity = observed.executorIdentity;
      record.revision++;
      write(roundPath(cwd, parent, batch, round), record);
      return ok({ idempotent: false, journal: record });
  });
}
async function attestPluginWithObserver(observer, ...coordinates) {
  try {
    if (coordinates.length !== 6) return fail("v2-attest accepts only journal coordinates and expected_revision");
    const [cwd, parent, batch, round, itemId, expectedRevision] = coordinates;
    const startedAt = Date.now();
    const snapshot = snapshotAttestation(cwd, parent, batch, round, itemId, expectedRevision, startedAt);
    // Production has exactly one observation path. Tests that need deterministic
    // evidence compile a test-only transformed module; no shipped hook exists.
    const observation = await observer({
      project: canonical(snapshot.orchestratorRoot || cwd),
      parent_session_id: parent,
      wave_id: snapshot.identity.wave_id,
      session_id: snapshot.sessionId,
    });
    if (!observation || observation.provenance?.source !== nativeAttestation.PROVENANCE ||
        observation.provenance.rpc_id !== nativeAttestation.RPC_ID ||
        observation.provenance.rpc_method !== nativeAttestation.RPC_METHOD ||
        !nativeAttestation.compatibleVersion(observation.provenance.service_version)) {
      return fail("native plugin RPC provenance is invalid");
    }
    const observed = validatePluginEvidence(observation.evidence, snapshot, parent, Date.now(), observation.provenance);
    return persistAttestation(cwd, parent, batch, round, itemId, snapshot, observed, observation);
  } catch (error) { return fail(error.message); }
}

function attestPlugin(...coordinates) {
  return attestPluginWithObserver(nativeAttestation.observe, ...coordinates);
}
function createQuickBatchV2(deps = {}) {
  if (!deps || typeof deps.observe !== "function") throw new Error("V2 dependency factory requires a trusted observer function");
  const receipt = deps.receipt ?? verificationReceipt;
  if (typeof receipt.verificationArtifact !== "function" || typeof receipt.receiptAuthorizesVerification !== "function") {
    throw new Error("V2 dependency factory requires a complete receipt policy");
  }
  // This factory is an in-process test seam only. No CLI route accepts these
  // dependencies; production exports below always bind nativeAttestation and
  // verificationReceipt.
  return {
    ...module.exports,
    attestPlugin: function (...coordinates) {
      return attestPluginWithObserver(deps.observe, ...coordinates);
    },
    recordVerification: (cwd, parent, batch, round, itemId, expectedRevision) =>
      recordVerification(cwd, parent, batch, round, itemId, expectedRevision, receipt),
  };
}

function recordVerification(cwd, parent, batch, round, itemId, expectedRevision, receiptPolicy = verificationReceipt) {
  try {
    const artifact = receiptPolicy.verificationArtifact(quickBatch, cwd, batch, itemId);
    if (!fingerprintCoversCurrentArtifacts(artifact)) return fail("verification artifact fingerprint does not cover current plan or summary inputs");
    const outcome = artifact.status;
    const replay = batchJournalLock(cwd, parent, batch, () => {
      const index = loadIndex(cwd, parent, batch);
      requireActive(index, round);
      const record = loadRound(cwd, parent, batch, round);
      const item = record.items[itemId];
      const expectedPhase = outcome === "passed" ? "verification_passed" : outcome === "human_needed" ? "verification_blocked" : "verification_failed";
      if (record.revision !== expectedRevision + 1 || !item || item.phase !== expectedPhase ||
           !receiptAuthorizesCurrentVerification(receiptPolicy, cwd, batch, itemId, item.verification_receipt, outcome)) return null;
      authoritativeBatchTransition(cwd, batch, itemId, expectedPhase);
      return ok({ idempotent: true, journal: record, verification_receipt: item.verification_receipt, pending_completion: outcome === "passed" });
    });
    if (replay) return replay;
    const before = exactBatchItem(cwd, batch, itemId);
    const matchingRetry = outcome === "gaps_found"
      ? before.status === "failed" && before.failure_reason === "gaps_found"
      : outcome === "human_needed"
        ? before.status === "blocked" && before.failure_reason === "human_needed:human_needed"
        : false;
    if ((before.status !== "pending" || before.failure_reason !== null) && !matchingRetry) {
      return fail("verification receipt requires a pending BATCH item; generic completion is not proof");
    }
    if (!matchingRetry) {
      const batchResult = quickBatch.applyV2Outcome(cwd, batch, itemId, outcome, outcome === "passed" ? undefined : outcome);
      if (!batchResult.ok) return batchResult;
    }
    return batchJournalLock(cwd, parent, batch, () => {
      const index = loadIndex(cwd, parent, batch);
      requireActive(index, round);
      const record = loadRound(cwd, parent, batch, round);
      requireRevision(record, expectedRevision);
      if (record.validation_required !== true) return fail("v2-verify is forbidden when validation is disabled");
      const item = record.items[itemId];
      if (!item || item.phase !== "removed" || item.verification_receipt !== null) {
        return fail("verification receipt requires exactly one removed journal item");
      }
      const authoritative = authoritativeBatchTransition(
        cwd,
        batch,
        itemId,
        outcome === "passed" ? "verification_passed" : outcome === "human_needed" ? "verification_blocked" : "verification_failed",
      );
      const receipt = { version: 1, ...artifact, checked_at: Date.now() };
      item.verification_receipt = receipt;
      item.outcome = authoritative.outcome;
      item.phase = outcome === "passed" ? "verification_passed" : outcome === "human_needed" ? "verification_blocked" : "verification_failed";
      item.events.push({ phase: item.phase, event: { verification_receipt: receipt, authoritative_batch: authoritative } });
      record.revision++;
      write(roundPath(cwd, parent, batch, round), record);
      return ok({ idempotent: false, journal: record, verification_receipt: receipt, pending_completion: outcome === "passed" });
    });
  } catch (error) { return fail(error.message); }
}

function exactMutationRequest(request, keys) {
  return request && typeof request === "object" && !Array.isArray(request) && hasExactKeys(request, keys);
}

function mutationIdentity(cwd, parent, batch, round, record, item, request, requireCreated = true) {
  const identity = validateIdentity(cwd, parent, batch, round, item.identity, record.orchestrator_root, requireCreated);
  if (request.manifest_path !== identity.manifest_path || request.manifest_agent_id !== identity.manifest_agent_id ||
      request.worktree_path !== identity.directory || request.branch !== identity.branch) {
    throw new Error("native mutation identity does not exactly match the journal");
  }
  const shared = read(identity.manifest_path);
  validateManifestShape(shared, record.orchestrator_root);
  if (shared.parent_session_id !== parent || shared.batch_id !== batch || shared.round !== round) {
    throw new Error("native manifest coordinates do not exactly match the journal");
  }
  findManifestEntry(shared, canonical(record.orchestrator_root || cwd), identity.manifest_agent_id, identity.directory, requireCreated);
  return { identity, shared };
}

function mergeAuthorized(cwd, parent, batch, round, itemId, expectedRevision, request) {
  try {
    if (!exactMutationRequest(request, ["manifest_path", "manifest_agent_id", "worktree_path", "branch", "expected_child_tip", "expected_target_tip", "status_digest"])) {
      return fail("v2-merge requires an exact request with no omitted or unknown fields");
    }
    return lock(cwd, parent, batch, () => {
      const index = loadIndex(cwd, parent, batch);
      requireActive(index, round);
      const record = loadRound(cwd, parent, batch, round);
      requireRevision(record, expectedRevision);
      const item = record.items[itemId];
      if (!item || item.phase !== "merge_intent") return fail("v2-merge requires current journal phase merge_intent");
      if (!attestationAuthorizesMutation(item, Date.now())) return fail("v2-merge requires fresh native OpenCode RPC provenance");
      const intent = item.events.findLast(({ phase }) => phase === "merge_intent")?.event;
      if (!intent || request.expected_child_tip !== intent.branch_tip || request.expected_target_tip !== intent.target_tip ||
          request.status_digest !== item.status_digest) {
        return fail("v2-merge expected tips or status digest do not match merge_intent");
      }
      const { identity, shared } = mutationIdentity(cwd, parent, batch, round, record, item, request);
      const latestAttestation = latestAttestationEvent(item);
      const authorizationDeadlineMs = latestAttestation.event.checked_at + 30_000;
      const authorizeBeforeTargetCas = () => {
        try {
          const current = loadRound(cwd, parent, batch, round);
          const currentItem = current.items[itemId];
          const currentIntent = currentItem?.events?.findLast(({ phase }) => phase === "merge_intent")?.event;
          return current.revision === expectedRevision && currentItem?.phase === "merge_intent" &&
            currentItem.status_digest === request.status_digest &&
            currentIntent?.branch_tip === request.expected_child_tip && currentIntent?.target_tip === request.expected_target_tip &&
            attestationAuthorizesMutation(currentItem, Date.now());
        } catch { return false; }
      };
      const merge = worktreeSafety.mergePreparedWorktree({
        manifest: JSON.stringify(shared), actualManifestAgentId: identity.manifest_agent_id,
        canonicalWorktreePath: identity.directory, branch: identity.branch,
        expectedChildTip: request.expected_child_tip, expectedTargetTip: request.expected_target_tip,
        targetRoot: canonical(record.orchestrator_root || cwd),
        worktreeRoot: path.join(canonical(record.orchestrator_root || cwd), ".claude", "worktrees"),
        authorizationDeadlineMs,
        authorizeBeforeTargetCas,
      });
      if (!["merged", "already_merged"].includes(merge.status)) return ok({ merge, journal: record });
      item.phase = "merged";
      item.events.push({ phase: "merged", event: merge });
      record.revision++;
      write(roundPath(cwd, parent, batch, round), record);
      return ok({ merge, journal: record });
    });
  } catch (error) { return fail(error.message); }
}

function teardownAuthorized(cwd, parent, batch, round, itemId, expectedRevision, request) {
  try {
    if (!exactMutationRequest(request, ["manifest_path", "manifest_agent_id", "worktree_path", "branch", "merged_child_tip"])) {
      return fail("v2-teardown requires an exact request with no omitted or unknown fields");
    }
    return lock(cwd, parent, batch, () => {
      const index = loadIndex(cwd, parent, batch);
      requireActive(index, round);
      const record = loadRound(cwd, parent, batch, round);
      const item = record.items[itemId];
      const intent = item?.events?.findLast(({ phase }) => phase === "merge_intent")?.event;
      const replayEvent = item?.events?.at(-1);
      if (record.revision === expectedRevision + 1 && item?.phase === "removed" && replayEvent?.phase === "removed") {
        if (!intent || request.merged_child_tip !== intent.branch_tip) return fail("v2-teardown replay payload conflicts with merge_intent");
        mutationIdentity(cwd, parent, batch, round, record, item, request, false);
        return ok({ idempotent: true, teardown: replayEvent.event, journal: record });
      }
      requireRevision(record, expectedRevision);
      if (!item || item.phase !== "teardown_pending") return fail("v2-teardown requires current journal phase teardown_pending");
      if (!intent || request.merged_child_tip !== intent.branch_tip) return fail("v2-teardown child tip does not match merge_intent");
      const { identity, shared } = mutationIdentity(cwd, parent, batch, round, record, item, request, false);
      const teardown = worktreeSafety.teardownMergedWorktree({
        manifest: JSON.stringify(shared), actualManifestAgentId: identity.manifest_agent_id,
        canonicalWorktreePath: identity.directory, branch: identity.branch,
        mergedChildTip: request.merged_child_tip, targetRoot: canonical(record.orchestrator_root || cwd),
        worktreeRoot: path.join(canonical(record.orchestrator_root || cwd), ".claude", "worktrees"),
      });
      if (!["removed", "already_removed"].includes(teardown.status)) return ok({ teardown, journal: record });
      item.phase = "removed";
      item.events.push({ phase: "removed", event: teardown });
      record.revision++;
      write(roundPath(cwd, parent, batch, round), record);
      return ok({ idempotent: false, teardown, journal: record });
    });
  } catch (error) { return fail(error.message); }
}

function requiresNativeAuthorization(cwd, request) {
  const prospective = (value) => {
    try { return typeof value === "string" && value ? canonicalProspective(path.resolve(cwd, value)) : null; }
    catch { return null; }
  };
  const requestedWorktree = prospective(request.worktree_path);
  const requestedManifest = prospective(request.manifest_path);
  try {
    const manifest = JSON.parse(fs.readFileSync(request.manifest_path, "utf8"));
    if (manifest?.transport === NATIVE_TRANSPORT || manifest?.runtime === NATIVE_RUNTIME) return true;
  } catch { /* the legacy primitive reports malformed or absent manifests */ }
  try {
    const base = path.join(canonical(cwd), ".opencode", ".runtime", "gsd-worktree-waves");
    if (!fs.existsSync(base)) return false;
    for (const parentDir of fs.readdirSync(base)) for (const batchDir of fs.readdirSync(path.join(base, parentDir))) {
      const indexFile = path.join(base, parentDir, batchDir, "index.json");
      if (!fs.existsSync(indexFile)) continue;
      const index = read(indexFile);
      if (!index.active) continue;
      const activeRound = read(path.join(base, parentDir, batchDir, `round-${index.active.round}.json`));
      for (const candidate of Object.values(activeRound.items || {})) {
        const identity = candidate.identity;
        if (identity && (identity.directory === requestedWorktree || identity.branch === request.branch || identity.manifest_path === requestedManifest)) return true;
      }
    }
  } catch {
    const nativeRoot = path.join(path.resolve(cwd), ".claude", "worktrees");
    return requestedWorktree !== null && isWithin(nativeRoot, requestedWorktree);
  }
  return false;
}

function cleanupManifestRequiresNativeAuthorization(cwd, manifest) {
  let parsed;
  try { parsed = typeof manifest === "string" ? JSON.parse(manifest) : manifest; }
  catch { return false; }
  if (parsed?.transport === NATIVE_TRANSPORT || parsed?.runtime === NATIVE_RUNTIME) return true;
  const entries = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.worktrees) ? parsed.worktrees : []);
  // Scan every caller entry before cleanup planning or mutation. Deliberately
  // use raw path/branch aliases so stripping native metadata or fields required
  // by the cleanup normalizer cannot bypass active journal ownership.
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const worktreePath = typeof entry.worktree_path === "string" ? entry.worktree_path : entry.path;
    if (requiresNativeAuthorization(cwd, {
      manifest_path: typeof entry.manifest_path === "string" ? entry.manifest_path : "",
      worktree_path: worktreePath,
      branch: typeof entry.branch === "string" ? entry.branch : "",
    })) return true;
  }
  return false;
}

function findActiveNativeItem(cwd, batch, itemId) {
  const base = path.join(canonical(cwd), ".opencode", ".runtime", "gsd-worktree-waves");
  if (!fs.existsSync(base)) return null;
  const matches = [];
  for (const parentDir of fs.readdirSync(base)) for (const batchDir of fs.readdirSync(path.join(base, parentDir))) {
    const indexFile = path.join(base, parentDir, batchDir, "index.json");
    if (!fs.existsSync(indexFile)) continue;
    const index = read(indexFile);
    if (!index.active || index.batch_id !== batch) continue;
    const record = read(path.join(base, parentDir, batchDir, `round-${index.active.round}.json`));
    if (record.items?.[itemId]) matches.push({ parent: index.parent_session_id, round: index.active.round, record, item: record.items[itemId] });
  }
  if (matches.length > 1) throw new Error("ambiguous active native completion ownership");
  return matches[0] || null;
}

function guardGenericCompletion(cwd, batch, itemId) {
  try {
    return findActiveNativeItem(cwd, batch, itemId)
      ? fail("active native item requires coordinate-bound quick-batch v2-complete")
      : ok({ native: false });
  } catch (error) { return fail(error.message); }
}

function completeAuthorized(cwd, parent, batch, round, itemId, expectedRevision, request) {
  try {
    if (!exactMutationRequest(request, ["description", "date", "commit", "directory"])) {
      return fail("v2-complete requires an exact completion request");
    }
    const authorize = () => lock(cwd, parent, batch, () => {
      const index = loadIndex(cwd, parent, batch);
      requireActive(index, round);
      const record = loadRound(cwd, parent, batch, round);
      const item = record.items[itemId];
      if (!item) return fail(`unknown journal item ${itemId}`);
      const last = item.events.at(-1);
      const exactIntent = last?.phase === "completion_intent" && last.event?.expected_revision === expectedRevision && same(last.event.request, request);
      if (record.revision === expectedRevision + 2 && last?.phase === "completion_written" &&
          last.event?.expected_revision === expectedRevision && same(last.event.request, request)) {
        authoritativeBatchTransition(cwd, batch, itemId, "completed");
        if (record.validation_required && !receiptAuthorizesCurrentVerification(verificationReceipt, cwd, batch, itemId, item.verification_receipt, "passed")) {
          return fail("v2-complete replay verification receipt changed");
        }
        return ok({ replay: true, journal: record, manifest: quickBatch.loadBatch(cwd, batch).value });
      }
      if (record.revision !== expectedRevision + 1 || !exactIntent) requireRevision(record, expectedRevision);
      if (record.validation_required) {
        if (item.phase !== "verification_passed" || !receiptAuthorizesCurrentVerification(verificationReceipt, cwd, batch, itemId, item.verification_receipt, "passed")) {
          return fail("v2-complete requires a current trusted passed verification receipt");
        }
      } else if (item.phase !== "removed") return fail("v2-complete requires removed when validation is disabled");
      const batchItem = exactBatchItem(cwd, batch, itemId);
      const resuming = record.revision === expectedRevision + 1 && exactIntent;
      if ((!resuming && (batchItem.status !== "pending" || batchItem.failure_reason !== null)) ||
          (resuming && !["pending", "complete"].includes(batchItem.status)) ||
          canonical(path.resolve(cwd, request.directory)) !== verificationReceipt.quickItemDirectory(quickBatch, cwd, batch, itemId)) {
        return fail("v2-complete BATCH identity or pending outcome mismatch");
      }
      if (!resuming) {
        item.events.push({ phase: "completion_intent", event: { expected_revision: expectedRevision, request } });
        record.revision++;
        write(roundPath(cwd, parent, batch, round), record);
      }
      return ok({ replay: false, journal: record });
    });
    const authorized = authorize();
    if (!authorized.ok) return authorized;
    if (authorized.value.replay) return ok({ appended: false, manifest: authorized.value.manifest, journal: authorized.value.journal, idempotent: true });
    const completed = quickBatch.completeQuickItem(cwd, batch, itemId, request);
    if (!completed.ok) return completed;
    const after = lock(cwd, parent, batch, () => {
      const record = loadRound(cwd, parent, batch, round);
      if (record.revision !== expectedRevision + 1) return fail("completion journal changed after intent");
      const item = record.items[itemId];
      const intent = item?.events?.at(-1);
      if (intent?.phase !== "completion_intent" || intent.event?.expected_revision !== expectedRevision || !same(intent.event.request, request)) {
        return fail("completion intent changed before durable outcome");
      }
      authoritativeBatchTransition(cwd, batch, itemId, "completed");
      if (record.validation_required && !receiptAuthorizesCurrentVerification(verificationReceipt, cwd, batch, itemId, item.verification_receipt, "passed")) {
        return fail("verification receipt changed during completion");
      }
      item.events.push({ phase: "completion_written", event: { expected_revision: expectedRevision, request } });
      record.revision++;
      write(roundPath(cwd, parent, batch, round), record);
      return ok({ journal: record });
    });
    if (!after.ok) return after;
    return ok({ ...completed.value, journal: after.value.journal, idempotent: false });
  } catch (error) { return fail(error.message); }
}

function closeRound(cwd, parent, batch, round, options = {}, expectedRevision) {
  try {
    return batchJournalLock(cwd, parent, batch, () => {
      const index = loadIndex(cwd, parent, batch);
      requireActive(index, round);
      const record = loadRound(cwd, parent, batch, round);
      requireRevision(record, expectedRevision);
      if (Object.values(record.items).some((item) => item.phase !== "completed")) {
        return fail("round has failed, blocked, or unfinished items; preserving active state");
      }
      for (const item of Object.values(record.items)) {
        authoritativeBatchTransition(cwd, batch, item.item_id, "completed");
        if (record.validation_required && !receiptAuthorizesCurrentVerification(verificationReceipt, cwd, batch, item.item_id, item.verification_receipt, "passed")) {
          return fail("completed item lacks a current trusted passed verification receipt");
        }
      }
      const stateFile = roundPath(cwd, parent, batch, round);
      const manifestFile = manifestPath(cwd, parent, batch, round);
      const cacheFile = receiptPath(cwd, parent, batch, round);
      const receipt = {
        version: 3,
        parent_session_id: parent,
        batch_id: batch,
        round,
        revision: record.revision,
        state_path: stateFile,
        manifest_path: manifestFile,
        receipt_path: cacheFile,
        state_hash: hash(fs.readFileSync(stateFile)),
        manifest_hash: hash(fs.readFileSync(manifestFile)),
        cleanup: { delete_state: true, delete_manifest: true, plugin_history: "preserve" },
        items: Object.values(record.items).map((item) => ({
          item_id: item.item_id,
          phase: item.phase,
          identity: item.identity,
          session_id: item.session_id,
          outcome: item.outcome,
        })),
      };
      write(cacheFile, receipt);
      index.active = null;
      // The complete immutable cleanup authorization is embedded atomically with
      // clearing active. The receipt file above is only a reconstructable cache.
      index.receipts.push(receipt);
      write(indexPath(cwd, parent, batch), index);
      return ok({ receipt, closed: true, cleanup_pending: options.cleanup === true });
    });
  } catch (error) { return fail(error.message); }
}
function validateEmbeddedReceipt(cwd, parent, batch, round, receipt) {
  if (!receipt || receipt.version !== 3 || receipt.parent_session_id !== parent || receipt.batch_id !== batch || receipt.round !== round ||
      receipt.state_path !== roundPath(cwd, parent, batch, round) ||
      receipt.manifest_path !== manifestPath(cwd, parent, batch, round) ||
      receipt.receipt_path !== receiptPath(cwd, parent, batch, round) ||
      typeof receipt.state_hash !== "string" || typeof receipt.manifest_hash !== "string" || !Array.isArray(receipt.items)) {
    throw new Error("invalid embedded receipt identity");
  }
}
function cleanupClosedRound(cwd, parent, batch, round) {
  try {
    return lock(cwd, parent, batch, () => {
      const index = loadIndex(cwd, parent, batch);
      if (index.active && index.active.round === round) return fail("cannot clean active round");
      const receipts = index.receipts.filter((receipt) => receipt && receipt.round === round);
      if (receipts.length !== 1) return fail("exactly one embedded receipt must own this round");
      const receipt = receipts[0];
      validateEmbeddedReceipt(cwd, parent, batch, round, receipt);
      const cache = receipt.receipt_path;
      if (fs.existsSync(cache) && !same(read(cache), receipt)) return fail("receipt cache mismatch");
      if (fs.existsSync(receipt.state_path) && hash(fs.readFileSync(receipt.state_path)) !== receipt.state_hash) return fail("state hash mismatch");
      if (fs.existsSync(receipt.manifest_path) && hash(fs.readFileSync(receipt.manifest_path)) !== receipt.manifest_hash) return fail("manifest hash mismatch");
      const alreadyAbsent = !fs.existsSync(receipt.state_path) && !fs.existsSync(receipt.manifest_path) && !fs.existsSync(cache);
      for (const file of [receipt.state_path, receipt.manifest_path, cache]) {
        try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      return ok({ cleaned: true, idempotent: alreadyAbsent });
    });
  } catch (error) { return fail(error.message); }
}

module.exports = {
  PHASES, hash, canonicalJson, canonicalDigest, journalDir, indexPath, roundPath, manifestPath, receiptPath,
  allocateRound, reconcileActiveRound, transition, attestPlugin, recordVerification,
  mergeAuthorized, teardownAuthorized, completeAuthorized, guardGenericCompletion,
  requiresNativeAuthorization, cleanupManifestRequiresNativeAuthorization, bindBatchItem,
  closeRound, cleanupClosedRound, createQuickBatchV2,
};
