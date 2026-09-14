import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ClientError, OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import {
  ConflictError,
  InvalidRequestError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnauthorizedError,
} from "@opencode/protocol/errors";
import { findingSeverity, HIGH_CONFIDENCE_FINDING_THRESHOLD, scanPromptInjection } from "./injection-scanner.mjs";
import { assertAttestationRPCInput, ATTESTATION_RPC } from "./attestation-rpc.mjs";

const PLUGIN_ID = "gsd-core";
const TOOL_NAME = "gsd_worktree_task";
const STATE_VERSION = 1;
const DEFAULT_TIMEOUT_SECONDS = 3600;
const MAX_JOBS = 5;
const MAX_IMPORT_ATTEMPTS = 3;
const MAX_TERMINAL_WRITE_ATTEMPTS = 3;
const MAX_TERMINAL_WRITE_BACKOFF_MS = 1_000;
const MAX_NOTIFICATION_BACKOFF_MS = 30_000;
const OBSERVATION_REQUEST_BOUND_MS = 2_000;
const CLEANUP_DRAIN_BOUND_MS = 100;
const MAX_UINT32 = 4_294_967_295;
const SUPPORTED_OPENCODE_VERSIONS = new Set(["2.0.3"]);
// Bound the exact prompt forwarded to a child session. The limit is in Unicode
// code points, matching JSON Schema maxLength rather than UTF-16 code units.
const MAX_PROMPT_LENGTH = 65_536;
const TERMINAL = new Set(["succeeded", "failed", "interrupted", "timeout"]);
const PROCESS_STATE = Symbol.for("opengsd.gsd-worktree-task.v2.process-state");

const JOB_SCHEMA = {
  type: "object",
  properties: {
    session_id: { type: "string", pattern: "^ses" },
    directory: { type: "string", minLength: 1 },
  },
  required: ["session_id", "directory"],
  additionalProperties: false,
};

export const INPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        action: { const: "start" },
        wave_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
        directory: { type: "string", minLength: 1 },
        manifest_path: { type: "string", minLength: 1 },
        manifest_agent_id: { type: "string", minLength: 1 },
        prompt: { type: "string", minLength: 1, maxLength: MAX_PROMPT_LENGTH },
        agent: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" },
        provider: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]*$" },
        model: { type: "string", minLength: 1, maxLength: 200 },
        reasoning_effort: { enum: ["medium", "high"] },
        title: { type: "string", minLength: 1, maxLength: 300 },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 7200 },
      },
      required: [
        "action", "wave_id", "directory", "manifest_path", "manifest_agent_id", "prompt", "agent", "provider",
        "model", "reasoning_effort", "timeout_seconds",
      ],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "seal" },
        wave_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
        jobs: { type: "array", items: JOB_SCHEMA, minItems: 1, maxItems: MAX_JOBS },
      },
      required: ["action", "wave_id", "jobs"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "status" },
        wave_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
      },
      required: ["action", "wave_id"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { action: { const: "recover" } },
      required: ["action"],
      additionalProperties: false,
    },
  ],
};

function canonical(directory) {
  return fs.realpathSync.native(path.resolve(directory));
}

function waveKey(parentID, waveID) {
  return `wave/${parentID}/${waveID}`;
}

function makeSessionID() {
  return `ses_${randomBytes(16).toString("hex")}`;
}

function isConflict(error) {
  return taggedProtocolError(error, ConflictError, "ConflictError", [], ["resource"]);
}

function isNotFound(error) {
  return taggedProtocolError(error, SessionNotFoundError, "SessionNotFoundError", ["sessionID"]) || declaredStatus(error) === 404;
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, required = allowed) {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

function declaredStatus(error) {
  if (error instanceof ClientError && error.name === "ClientError" && error.reason === "UnexpectedStatus" &&
      exactKeys(error.cause, ["status"]) && Number.isInteger(error.cause.status) &&
      error.cause.status >= 400 && error.cause.status <= 599) {
    return error.cause.status;
  }
  return undefined;
}

function taggedProtocolError(error, ErrorClass, tag, requiredFields, optionalFields = []) {
  const validFields = () => requiredFields.every((field) => typeof error?.[field] === "string") &&
    optionalFields.every((field) => error?.[field] === undefined || typeof error[field] === "string") &&
    typeof error?.message === "string";
  if (error instanceof ErrorClass) {
    return error.name === tag && error._tag === tag && validFields() &&
      Object.keys(error).every((key) => ["_tag", ...requiredFields, ...optionalFields].includes(key));
  }
  return exactKeys(error, ["_tag", "message", ...requiredFields, ...optionalFields], ["_tag", "message", ...requiredFields]) &&
    error._tag === tag && validFields();
}

function supportedVersion(version) {
  return SUPPORTED_OPENCODE_VERSIONS.has(version);
}

function notificationID(parentID, waveID) {
  const digest = createHash("sha256").update(`${parentID}\0${waveID}`).digest("hex").slice(0, 24);
  return `msg_gsd_${digest}`;
}

// This transport has no dependency on a host overlay or its hook payload. It
// deliberately reads only the invoking project's literal configuration file;
// absent, malformed, inaccessible, or non-boolean values remain advisory.
export function injectionBlockingPolicy(projectRoot) {
  try {
    const root = canonical(projectRoot);
    if (path.resolve(projectRoot) !== root) return false;
    const planningPath = path.join(root, ".planning");
    const configPath = path.join(planningPath, "config.json");
    if (!fs.lstatSync(planningPath).isDirectory() || fs.lstatSync(planningPath).isSymbolicLink()) return false;
    if (!fs.lstatSync(configPath).isFile() || fs.lstatSync(configPath).isSymbolicLink()) return false;
    if (canonical(planningPath) !== planningPath || canonical(configPath) !== configPath) return false;
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return config !== null && typeof config === "object" && !Array.isArray(config) &&
      config.security !== null && typeof config.security === "object" && !Array.isArray(config.security) &&
      config.security.injection_blocking === true;
  } catch {
    return false;
  }
}

function promptInjectionWarning(findings, blocking) {
  const severity = findingSeverity(findings);
  return {
    code: "prompt_injection_detected",
    confidence: severity === "HIGH" ? "high" : "low",
    severity,
    source: "start.prompt",
    blocking,
    finding_count: findings.length,
    findings,
  };
}

function assertPromptSize(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) throw new Error("prompt must be a non-empty string");
  let codePoints = 0;
  for (let index = 0; index < prompt.length;) {
    codePoints += 1;
    if (codePoints > MAX_PROMPT_LENGTH) throw new Error(`prompt exceeds the ${MAX_PROMPT_LENGTH} character limit`);
    const codeUnit = prompt.charCodeAt(index);
    const next = prompt.charCodeAt(index + 1);
    index += codeUnit >= 0xD800 && codeUnit <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF ? 2 : 1;
  }
}

function normalizedNotificationID(parentID, waveID, notification) {
  const expected = notificationID(parentID, waveID);
  const stored = notification?.id;
  if (typeof stored !== "string" || !stored.startsWith("msg_")) return expected;
  if (stored !== expected) {
    const error = new Error("stored notification ID does not match this wave's deterministic ID");
    error.notificationIdentityMismatch = true;
    throw error;
  }
  return stored;
}

function resolveWorktreeDirectory(projectRoot, input) {
  const root = canonical(projectRoot);
  const candidate = canonical(path.resolve(root, input));
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("directory must identify a canonical child worktree inside the project root");
  }
  if (!fs.statSync(path.join(candidate, ".git")).isFile()) {
    throw new Error("directory is not a linked git worktree (.git must be a file)");
  }
  return candidate;
}

function resolveManifestPath(projectRoot, input) {
  const root = canonical(projectRoot);
  const candidate = canonical(path.resolve(root, input));
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("manifest_path must identify a canonical regular file inside the project root");
  }
  if (!fs.statSync(candidate).isFile()) {
    throw new Error("manifest_path must identify a canonical regular file inside the project root");
  }
  return candidate;
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

function hashManifestEntry(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function manifestWorktreePath(projectRoot, entry) {
  return canonical(path.resolve(canonical(projectRoot), entry.worktree_path));
}

function findManifestEntry(projectRoot, manifest, agentID, directory) {
  const entries = manifest.worktrees.filter((entry) => entry && typeof entry === "object");
  const resolved = entries.map((entry) => {
    try { return { entry, directory: manifestWorktreePath(projectRoot, entry) }; } catch { return { entry, directory: undefined }; }
  });
  const matches = resolved.filter((item) => item.entry.agent_id === agentID && item.directory === directory);
  if (matches.length === 0) return { reason: "missing" };
  if (matches.length > 1) return { reason: "duplicate" };
  if (resolved.some((item) => item.entry.agent_id === agentID && item.directory !== directory)) {
    return { reason: "agent_ambiguous" };
  }
  if (resolved.some((item) => item.entry.agent_id !== agentID && item.directory === directory)) {
    return { reason: "path_ambiguous" };
  }
  return { entry: matches[0].entry };
}

function readManifestBinding(projectRoot, manifestPathInput, agentID, directory) {
  const manifestPath = resolveManifestPath(projectRoot, manifestPathInput);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !Array.isArray(manifest.worktrees)) {
    throw new Error("manifest must be an object with a worktrees array");
  }
  const found = findManifestEntry(projectRoot, manifest, agentID, directory);
  if (found.reason === "missing") throw new Error("manifest must contain exactly one matching worktree entry (found 0)");
  if (found.reason === "duplicate") throw new Error("manifest must contain exactly one matching worktree entry (found 2)");
  if (found.reason === "agent_ambiguous") throw new Error("manifest_agent_id is ambiguous across worktree paths");
  if (found.reason === "path_ambiguous") throw new Error("manifest worktree path is ambiguous across agent IDs");
  const entry = found.entry;
  if (typeof entry.branch !== "string" || !entry.branch.trim() || typeof entry.expected_base !== "string" || !entry.expected_base.trim()) {
    throw new Error("manifest worktree entry requires non-empty branch and expected_base");
  }
  const snapshot = manifestEntrySnapshot(entry, directory);
  return {
    manifest_path: manifestPath,
    manifest_agent_id: agentID,
    manifest_entry: snapshot,
    manifest_entry_hash: hashManifestEntry(snapshot),
  };
}

function verifyManifestBinding(projectRoot, job) {
  if (!job.manifest_path || !job.manifest_agent_id || !job.manifest_entry || !job.manifest_entry_hash) {
    return "manifest_binding_missing";
  }
  let manifestPath;
  try { manifestPath = resolveManifestPath(projectRoot, job.manifest_path); } catch { return "manifest_file_missing"; }
  if (manifestPath !== job.manifest_path) return "manifest_path_mismatch";
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { return "manifest_unreadable"; }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !Array.isArray(manifest.worktrees)) {
    return "manifest_invalid";
  }
  const found = findManifestEntry(projectRoot, manifest, job.manifest_agent_id, job.directory);
  if (found.reason) return `manifest_entry_${found.reason}`;
  const entry = found.entry;
  if (typeof entry.branch !== "string" || !entry.branch.trim() || typeof entry.expected_base !== "string" || !entry.expected_base.trim()) {
    return "manifest_entry_mutated";
  }
  const snapshot = manifestEntrySnapshot(entry, job.directory);
  if (hashManifestEntry(snapshot) !== job.manifest_entry_hash || JSON.stringify(snapshot) !== JSON.stringify(job.manifest_entry)) {
    return "manifest_entry_mutated";
  }
  return undefined;
}

function sessionAttestationReasons(info, expected) {
  const reasons = [];
  if (info?.id !== expected.session_id) reasons.push("session_id_mismatch");
  if (info?.parentID !== expected.parent_session_id) reasons.push("parent_mismatch");
  try {
    if (canonical(info?.location?.directory) !== expected.directory) reasons.push("location_mismatch");
  } catch { reasons.push("location_mismatch"); }
  if (info?.agent !== expected.agent) reasons.push("agent_mismatch");
  if (info?.model?.providerID !== expected.model?.providerID) reasons.push("model_provider_mismatch");
  if (info?.model?.id !== expected.model?.id) reasons.push("model_id_mismatch");
  if (info?.model?.variant !== expected.model?.variant) reasons.push("model_variant_mismatch");
  const finalPermission = Array.isArray(info?.permissions) ? info.permissions.at(-1) : undefined;
  const exactDeny = finalPermission && Object.keys(finalPermission).length === 3 &&
    finalPermission.action === TOOL_NAME && finalPermission.resource === "*" && finalPermission.effect === "deny";
  if (!exactDeny) reasons.push("permissions_mismatch");
  return reasons;
}

const MODEL_KEYS = ["providerID", "id", "variant"];
const PERMISSION_KEYS = ["action", "resource", "effect"];
const MANIFEST_ENTRY_KEYS = ["agent_id", "worktree_path", "branch", "expected_base", "files_modified", "declared_deletions"];
const REQUESTED_EXECUTOR_KEYS = ["session_id", "parent_session_id", "directory", "manifest_agent_id", "agent", "model", "final_permission"];
const OBSERVATION_KEYS = ["episode", "cycle", "operation", "reason", "first_deferred_at", "last_deferred_at", "retry_at", "state"];
const JOB_KEYS = [
  "session_id", "directory", "status", "agent", "model", "manifest_path", "manifest_agent_id", "manifest_entry",
  "manifest_entry_hash", "requested_executor", "started_at", "deadline", "finished_at", "text", "error", "cleanup_error", "observation",
];
const WAVE_KEYS = ["version", "parent_session_id", "wave_id", "created_at", "sealed", "sealed_at", "manifest_path", "expected_session_ids", "jobs", "notification"];
const OBSERVATION_OPERATIONS = new Set(["service.discover", "health.get", "session.get", "session.wait"]);
const OBSERVATION_REASONS = new Set([
  "attempt_due", "outcome_pending", "transport", "request_cancelled", "not_found", "unavailable", "http_4xx", "http_5xx",
  "unsupported_content_type", "malformed_response", "attestation_mismatch", "unknown", "counter_exhausted",
]);
const RETRYABLE_OBSERVATION_REASONS = new Set(["attempt_due", "outcome_pending", "transport", "request_cancelled", "unavailable", "http_5xx"]);

function validModel(model) {
  return exactKeys(model, MODEL_KEYS) && MODEL_KEYS.every((key) => typeof model[key] === "string" && model[key].length > 0);
}

function validPermission(permission) {
  return exactKeys(permission, PERMISSION_KEYS) && permission.action === TOOL_NAME && permission.resource === "*" && permission.effect === "deny";
}

function validManifestEntry(entry) {
  return exactKeys(entry, MANIFEST_ENTRY_KEYS) && typeof entry.agent_id === "string" && typeof entry.worktree_path === "string" &&
    typeof entry.branch === "string" && typeof entry.expected_base === "string" &&
    [entry.files_modified, entry.declared_deletions].every((value) => value === null ||
      (Array.isArray(value) && value.every((item) => typeof item === "string")));
}

function validRequestedExecutor(requested) {
  return exactKeys(requested, REQUESTED_EXECUTOR_KEYS) && typeof requested.session_id === "string" &&
    typeof requested.parent_session_id === "string" && typeof requested.directory === "string" &&
    typeof requested.manifest_agent_id === "string" && typeof requested.agent === "string" &&
    validModel(requested.model) && validPermission(requested.final_permission);
}

function closedJobShape(job) {
  return exactKeys(job, JOB_KEYS, ["session_id", "directory", "status", "agent", "model", "manifest_path", "manifest_agent_id", "manifest_entry", "manifest_entry_hash", "requested_executor", "deadline"]) &&
    exactKeys(job.model, MODEL_KEYS) && exactKeys(job.manifest_entry, MANIFEST_ENTRY_KEYS) &&
    exactKeys(job.requested_executor, REQUESTED_EXECUTOR_KEYS) && exactKeys(job.requested_executor?.model, MODEL_KEYS) &&
    exactKeys(job.requested_executor?.final_permission, PERMISSION_KEYS);
}

function validObservation(observation, deadline) {
  if (observation === undefined) return true;
  if (!exactKeys(observation, OBSERVATION_KEYS, ["episode", "cycle", "operation", "reason", "first_deferred_at", "last_deferred_at"])) return false;
  if (!Number.isInteger(observation.episode) || observation.episode < 1 || observation.episode > MAX_UINT32 ||
      !Number.isInteger(observation.cycle) || observation.cycle < 0 || observation.cycle > MAX_UINT32 ||
      !OBSERVATION_OPERATIONS.has(observation.operation) || !OBSERVATION_REASONS.has(observation.reason) ||
      !Number.isSafeInteger(observation.first_deferred_at) || observation.first_deferred_at < 1 ||
      !Number.isSafeInteger(observation.last_deferred_at) || observation.last_deferred_at < observation.first_deferred_at) return false;
  const hasRetry = Object.hasOwn(observation, "retry_at");
  const hasState = Object.hasOwn(observation, "state");
  if (hasRetry === hasState) return false;
  if (observation.reason === "attempt_due") {
    if (observation.operation !== "service.discover") return false;
    if (!hasRetry) return observation.state === "blocked";
    return observation.cycle === 0 && observation.first_deferred_at === observation.last_deferred_at &&
      observation.retry_at === observation.last_deferred_at && observation.retry_at <= deadline;
  }
  if (observation.cycle === 0) return false;
  if (observation.reason === "outcome_pending" &&
      observation.operation !== "session.get" && observation.operation !== "session.wait") return false;
  if (observation.reason === "counter_exhausted") {
    return observation.cycle === MAX_UINT32 && observation.state === "blocked" && !hasRetry;
  }
  if (hasRetry) {
    return RETRYABLE_OBSERVATION_REASONS.has(observation.reason) && Number.isSafeInteger(observation.retry_at) &&
      observation.retry_at >= observation.last_deferred_at && observation.retry_at <= deadline;
  }
  if (observation.state !== "blocked" && observation.state !== "quarantined") return false;
  return observation.state === "blocked" || !RETRYABLE_OBSERVATION_REASONS.has(observation.reason);
}

function validOptionalJobFields(job) {
  return ["started_at", "finished_at"].every((field) => !Object.hasOwn(job, field) ||
    (Number.isSafeInteger(job[field]) && job[field] > 0)) &&
    ["text", "error", "cleanup_error"].every((field) => !Object.hasOwn(job, field) || typeof job[field] === "string");
}

function validNotification(notification) {
  if (notification === undefined) return true;
  if (!isPlainRecord(notification) || typeof notification.id !== "string" ||
      !["sending", "sent", "retrying"].includes(notification.state)) return false;
  const legacyRetry = notification.state === "retrying" && Object.hasOwn(notification, "last_error");
  const allowed = notification.state === "sending" ? ["id", "state", "attempts", "attempted_at"]
    : notification.state === "sent" ? ["id", "state", "attempts", "sent_at"]
    : legacyRetry ? ["id", "state", "attempts", "last_error", "retry_at"]
      : ["id", "state", "attempts", "retry_at"];
  if (!exactKeys(notification, allowed, ["id", "state"])) return false;
  if (legacyRetry && typeof notification.last_error !== "string") return false;
  if (Object.hasOwn(notification, "attempts") && (!Number.isSafeInteger(notification.attempts) || notification.attempts < 1)) return false;
  return ["attempted_at", "sent_at", "retry_at"].every((field) => !Object.hasOwn(notification, field) ||
    (Number.isSafeInteger(notification[field]) && notification[field] > 0));
}

function legacyRetryNotification(notification) {
  return notification?.state === "retrying" && Object.hasOwn(notification, "last_error") && validNotification(notification);
}

function validJobShape(job, parentID, waveManifestPath) {
  if (!exactKeys(job, JOB_KEYS, ["session_id", "directory", "status", "agent", "model", "manifest_path", "manifest_agent_id", "manifest_entry", "manifest_entry_hash", "requested_executor", "deadline"])) return false;
  if (typeof job.session_id !== "string" || !job.session_id.startsWith("ses") || typeof job.directory !== "string" ||
      !["provisioning", "running", "succeeded", "failed", "interrupted", "timeout"].includes(job.status) ||
      typeof job.agent !== "string" || !validModel(job.model) || job.manifest_path !== waveManifestPath ||
      typeof job.manifest_agent_id !== "string" || !validManifestEntry(job.manifest_entry) ||
      typeof job.manifest_entry_hash !== "string" || !validRequestedExecutor(job.requested_executor) ||
      !Number.isSafeInteger(job.deadline) || job.deadline < 1 || !validObservation(job.observation, job.deadline) ||
      !validOptionalJobFields(job)) return false;
  if (job.status !== "running" && job.observation !== undefined) return false;
  const requested = job.requested_executor;
  return requested.session_id === job.session_id && requested.parent_session_id === parentID && requested.directory === job.directory &&
    requested.manifest_agent_id === job.manifest_agent_id && requested.agent === job.agent &&
    JSON.stringify(requested.model) === JSON.stringify(job.model);
}

function validWaveShape(wave, parentID = wave?.parent_session_id, waveID = wave?.wave_id) {
  if (!exactKeys(wave, WAVE_KEYS, ["version", "parent_session_id", "wave_id", "sealed", "manifest_path", "jobs"]) ||
      wave.version !== STATE_VERSION || wave.parent_session_id !== parentID || wave.wave_id !== waveID ||
      typeof wave.sealed !== "boolean" || typeof wave.manifest_path !== "string" || !isPlainRecord(wave.jobs) ||
      Object.keys(wave.jobs).length > MAX_JOBS ||
      (Object.hasOwn(wave, "created_at") && (!Number.isSafeInteger(wave.created_at) || wave.created_at < 1)) ||
      (Object.hasOwn(wave, "sealed_at") && (!Number.isSafeInteger(wave.sealed_at) || wave.sealed_at < 1)) ||
      !validNotification(wave.notification)) return false;
  const jobIDs = Object.keys(wave.jobs).sort();
  if (wave.sealed) {
    if (!Array.isArray(wave.expected_session_ids) || wave.expected_session_ids.length === 0 ||
        !wave.expected_session_ids.every((id) => typeof id === "string") ||
        new Set(wave.expected_session_ids).size !== wave.expected_session_ids.length ||
        JSON.stringify([...wave.expected_session_ids].sort()) !== JSON.stringify(jobIDs)) return false;
  } else if (Object.hasOwn(wave, "expected_session_ids")) return false;
  return Object.entries(wave.jobs).every(([sessionID, job]) => sessionID === job?.session_id && validJobShape(job, parentID, wave.manifest_path));
}

function modelProjection(model) {
  return {
    providerID: typeof model?.providerID === "string" ? model.providerID : "",
    id: typeof model?.id === "string" ? model.id : "",
    variant: typeof model?.variant === "string" ? model.variant : "",
  };
}

function manifestEntryProjection(entry) {
  return {
    agent_id: typeof entry?.agent_id === "string" ? entry.agent_id : "",
    worktree_path: typeof entry?.worktree_path === "string" ? entry.worktree_path : "",
    branch: typeof entry?.branch === "string" ? entry.branch : "",
    expected_base: typeof entry?.expected_base === "string" ? entry.expected_base : "",
    files_modified: Array.isArray(entry?.files_modified) ? entry.files_modified.filter((item) => typeof item === "string") : null,
    declared_deletions: Array.isArray(entry?.declared_deletions) ? entry.declared_deletions.filter((item) => typeof item === "string") : null,
  };
}

function requestedExecutorProjection(requested) {
  return {
    session_id: typeof requested?.session_id === "string" ? requested.session_id : "",
    parent_session_id: typeof requested?.parent_session_id === "string" ? requested.parent_session_id : "",
    directory: typeof requested?.directory === "string" ? requested.directory : "",
    manifest_agent_id: typeof requested?.manifest_agent_id === "string" ? requested.manifest_agent_id : "",
    agent: typeof requested?.agent === "string" ? requested.agent : "",
    model: modelProjection(requested?.model),
    final_permission: {
      action: typeof requested?.final_permission?.action === "string" ? requested.final_permission.action : "",
      resource: typeof requested?.final_permission?.resource === "string" ? requested.final_permission.resource : "",
      effect: typeof requested?.final_permission?.effect === "string" ? requested.final_permission.effect : "",
    },
  };
}

function recoverJobProjection(job) {
  return {
    session_id: typeof job?.session_id === "string" ? job.session_id : "",
    directory: typeof job?.directory === "string" ? job.directory : "",
    manifest_path: typeof job?.manifest_path === "string" ? job.manifest_path : "",
    manifest_agent_id: typeof job?.manifest_agent_id === "string" ? job.manifest_agent_id : "",
    manifest_entry_hash: typeof job?.manifest_entry_hash === "string" ? job.manifest_entry_hash : "",
    status: ["provisioning", "running", "succeeded", "failed", "interrupted", "timeout"].includes(job?.status) ? job.status : "failed",
    ...(typeof job?.text === "string" && job.text ? { text: job.text } : {}),
    ...(typeof job?.error === "string" && job.error ? { error: job.error } : {}),
  };
}

function failedSafeJobProjection(job) {
  return {
    session_id: typeof job?.session_id === "string" && /^ses/.test(job.session_id) ? job.session_id : "",
    directory: "",
    manifest_path: "",
    manifest_agent_id: "",
    manifest_entry_hash: "",
    status: "failed",
  };
}

function failedSafeStatusJobProjection(job) {
  return {
    ...failedSafeJobProjection(job),
    agent: "",
    model: modelProjection(),
    manifest_entry: manifestEntryProjection(),
    requested_executor: requestedExecutorProjection(),
    observed_executor: null,
  };
}

function legacyRecoverJobProjection(job) {
  const allowed = ["session_id", "directory", "status", "text", "error"];
  if (!exactKeys(job, allowed, ["session_id", "directory", "status"]) ||
      typeof job.session_id !== "string" || !job.session_id.startsWith("ses") ||
      typeof job.directory !== "string" ||
      !["running", "succeeded", "failed", "interrupted", "timeout"].includes(job.status) ||
      (Object.hasOwn(job, "text") && typeof job.text !== "string") ||
      (Object.hasOwn(job, "error") && typeof job.error !== "string")) return undefined;
  return {
    session_id: job.session_id,
    directory: job.directory,
    status: job.status,
    ...(typeof job.text === "string" && job.text ? { text: job.text } : {}),
    ...(typeof job.error === "string" && job.error ? { error: job.error } : {}),
  };
}

function legacyTransportCandidate(job) {
  return job?.status === "failed" && job.error === "Transport" &&
    !Object.hasOwn(job, "cleanup_error") && !Object.hasOwn(job, "observation");
}

function pluginIsActive(plugins) {
  return plugins.some((item) => item && item.id === PLUGIN_ID && item.state?.status === "active");
}

function extractResult(info, messages) {
  const assistants = messages.filter((message) => message?.type === "assistant");
  const latest = assistants.at(-1);
  const text = latest?.content
    ?.filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim() || "";
  const error = latest?.error?.message || latest?.retry?.error?.message;
  return {
    status: info.outcome,
    ...(text ? { text } : {}),
    ...(error ? { error } : {}),
  };
}

function validContextProjection(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.every((message) => {
    if (!isPlainRecord(message) || typeof message.type !== "string") return false;
    if (message.type !== "assistant") return true;
    if (!Array.isArray(message.content) || !message.content.every((part) =>
      isPlainRecord(part) && typeof part.type === "string" && (part.type !== "text" || typeof part.text === "string"))) return false;
    const validError = (value) => value === undefined || (isPlainRecord(value) && typeof value.message === "string");
    return validError(message.error) && (message.retry === undefined ||
      (isPlainRecord(message.retry) && validError(message.retry.error)));
  });
}

function response(value) {
  return { content: JSON.stringify(value), metadata: { plugin: PLUGIN_ID } };
}

function sameJobs(left, right) {
  if (left.length !== right.length) return false;
  const normalize = (items) => items.map((item) => `${item.session_id}\0${item.directory}`).sort();
  return normalize(left).every((item, index) => item === normalize(right)[index]);
}

function statusAuthoritySnapshot(wave) {
  if (!wave || typeof wave !== "object") return JSON.stringify(wave);
  const storedNotificationID = wave.notification?.id;
  const expectedNotificationID = notificationID(wave.parent_session_id, wave.wave_id);
  return JSON.stringify({
    version: wave.version,
    parent_session_id: wave.parent_session_id,
    wave_id: wave.wave_id,
    manifest_path: wave.manifest_path,
    sealed: wave.sealed,
    expected_session_ids: wave.expected_session_ids,
    jobs: wave.jobs,
    notification_identity: typeof storedNotificationID === "string" && storedNotificationID.startsWith("msg_") &&
      storedNotificationID !== expectedNotificationID ? storedNotificationID : expectedNotificationID,
  });
}

function makeServiceClient(endpoint) {
  return OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
}

export function createRuntime(ctx, dependencies = {}) {
  const service = dependencies.service || Service;
  const makeClient = dependencies.makeClient || makeServiceClient;
  const makeID = dependencies.makeSessionID || makeSessionID;
  const now = dependencies.now || Date.now;
  const schedule = dependencies.schedule || ((callback, delay) => setTimeout(callback, delay));
  const cancelSchedule = dependencies.cancelSchedule || ((handle) => clearTimeout(handle));
  const boundSchedule = dependencies.boundSchedule || dependencies.requestSchedule || ((callback, delay) => setTimeout(callback, delay));
  const cancelBound = dependencies.cancelBound || dependencies.cancelRequestSchedule || ((handle) => clearTimeout(handle));
  const requestBoundMs = dependencies.requestBoundMs ?? dependencies.requestTimeoutMs ?? OBSERVATION_REQUEST_BOUND_MS;
  const cleanupBoundMs = dependencies.cleanupBoundMs ?? dependencies.cleanupTimeoutMs ?? CLEANUP_DRAIN_BOUND_MS;
  const sleep = dependencies.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const shared = globalThis[PROCESS_STATE] ||= {
    observers: new Map(),
    notificationTimers: new Map(),
    reobserveTimers: new Map(),
    locks: new Map(),
    waveOwners: new Map(),
  };
  shared.notificationTimers ||= new Map();
  shared.reobserveTimers ||= new Map();
  shared.waveOwners ||= new Map();
  const { observers, notificationTimers, reobserveTimers, locks, waveOwners } = shared;
  const owner = Symbol("gsd-worktree-task-runtime");
  let disposed = false;
  let disposePromise;
  const tasks = new Set();
  const operations = new Set();

  function track(promise) {
    const task = Promise.resolve(promise);
    tasks.add(task);
    task.then(
      () => tasks.delete(task),
      () => tasks.delete(task),
    );
    return task;
  }

  function activeForWave(key) {
    return !disposed && waveOwners.get(key) === owner;
  }

  function activeSlot(key, observerKey, slot) {
    return activeForWave(key) && observers.get(observerKey) === slot && slot.owner === owner;
  }

  function activeOperation(operation) {
    return !disposed && operations.has(operation) && operation.owner === owner && !operation.revoked;
  }

  function assertActiveOperation(operation) {
    if (!activeOperation(operation)) throw new Error("worktree runtime operation was revoked");
  }

  function runOperation(callback) {
    const operation = { owner, controllers: new Set(), revoked: false };
    operations.add(operation);
    return track(Promise.resolve().then(() => callback(operation)).finally(() => operations.delete(operation)));
  }

  async function withWaveLock(key, operation) {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(key) === queued) locks.delete(key);
    }
  }

  async function clientForImport(operation) {
    if (!supportedVersion(ctx.app.version)) throw new Error("unsupported OpenCode version");
    const endpoint = await bounded(operation, () => service.discover({ version: ctx.app.version }));
    assertActiveOperation(operation);
    if (!endpoint) {
      throw new Error("the current process is not a discoverable managed OpenCode service; refusing standalone or explicit-server import");
    }
    const client = makeClient(endpoint);
    assertActiveOperation(operation);
    const health = unwrap(await bounded(operation, (signal) => client.health.get({ signal })));
    assertActiveOperation(operation);
    if (health?.healthy !== true || health.pid !== process.pid || health.version !== ctx.app.version || !supportedVersion(health.version)) {
      throw new Error("discovered OpenCode service identity does not match this plugin host process and version");
    }
    return client;
  }

  async function cleanupMintedChild(client, sessionID, operation) {
    assertActiveOperation(operation);
    await bounded(operation, (signal) => client.session.interrupt({ sessionID, continue: false }, { signal })).catch(() => {});
    assertActiveOperation(operation);
    let removalClient = client;
    if (typeof removalClient.session.remove !== "function") {
      const endpoint = await bounded(operation, () => service.discover({ version: ctx.app.version }));
      assertActiveOperation(operation);
      if (!endpoint) throw new Error("cannot verify the managed service for child cleanup");
      removalClient = makeClient(endpoint);
      assertActiveOperation(operation);
      const health = unwrap(await bounded(operation, (signal) => removalClient.health.get({ signal })));
      assertActiveOperation(operation);
      if (health?.healthy !== true || health.pid !== process.pid || health.version !== ctx.app.version || !supportedVersion(health.version)) {
        throw new Error("refusing child cleanup through an unverified service");
      }
    }
    try {
      assertActiveOperation(operation);
      await bounded(operation, (signal) => removalClient.session.remove({ sessionID }, { signal }));
      assertActiveOperation(operation);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async function assertInventory(directory, operation) {
    const inventory = await bounded(operation, (signal) => ctx.worktree.list({ signal }));
    assertActiveOperation(operation);
    const found = inventory.some((item) => {
      try { return canonical(item.directory) === directory; } catch { return false; }
    });
    if (!found) throw new Error("directory is absent from the OpenCode worktree inventory");
  }

  async function assertTarget(client, directory, agent, operation) {
    const location = { directory };
    if (client.plugin.awaitActivation) {
      await bounded(operation, (signal) => client.plugin.awaitActivation({ location }, { signal }));
    }
    assertActiveOperation(operation);
    const pluginsResult = await bounded(operation, (signal) => client.plugin.list({ location }, { signal }));
    assertActiveOperation(operation);
    const plugins = Array.isArray(pluginsResult) ? pluginsResult : pluginsResult.data;
    if (!pluginIsActive(plugins || [])) {
      throw new Error(`plugin "${PLUGIN_ID}" is not active in the target worktree`);
    }
    const agentsResult = await bounded(operation, (signal) => client.agent.list({ location }, { signal }));
    assertActiveOperation(operation);
    const agents = Array.isArray(agentsResult) ? agentsResult : agentsResult.data;
    if (!(agents || []).some((item) => item?.id === agent || item?.name === agent)) {
      throw new Error(`agent "${agent}" is unavailable in the target worktree`);
    }
  }

  function unwrap(value) {
    return value && typeof value === "object" && Object.hasOwn(value, "data") ? value.data : value;
  }

  function errorReason(error) {
    if (error?.requestBoundExpired) return "request_cancelled";
    if (taggedProtocolError(error, InvalidRequestError, "InvalidRequestError", [], ["kind", "field"]) ||
        taggedProtocolError(error, UnauthorizedError, "UnauthorizedError", [])) return "http_4xx";
    if (taggedProtocolError(error, SessionNotFoundError, "SessionNotFoundError", ["sessionID"])) return "not_found";
    if (taggedProtocolError(error, ServiceUnavailableError, "ServiceUnavailableError", [], ["service"])) return "unavailable";
    if (error instanceof ClientError && error.name === "ClientError" && error.reason === "Transport") return "transport";
    if (error instanceof ClientError && error.name === "ClientError" && error.reason === "UnsupportedContentType") return "unsupported_content_type";
    if (error instanceof ClientError && error.name === "ClientError" && error.reason === "MalformedResponse") return "malformed_response";
    const status = declaredStatus(error);
    if (status === 499) return "request_cancelled";
    if (status === 404) return "not_found";
    if (status === 503) return "unavailable";
    if (status >= 400 && status < 500) return "http_4xx";
    if (status >= 500 && status < 600) return "http_5xx";
    return "unknown";
  }

  function transientReason(reason) {
    return reason === "transport" || reason === "request_cancelled" || reason === "unavailable" || reason === "http_5xx";
  }

  async function bounded(slot, operation) {
    const controller = new AbortController();
    slot.controllers.add(controller);
    let handle;
    let active = true;
    const timedOut = new Promise((_, reject) => {
      handle = boundSchedule(() => {
        if (!active) return;
        controller.abort();
        const error = new Error("request bound expired");
        error.requestBoundExpired = true;
        reject(error);
      }, requestBoundMs);
      handle?.unref?.();
    });
    const work = Promise.resolve().then(() => operation(controller.signal));
    work.catch(() => {});
    try {
      return await Promise.race([work, timedOut]);
    } catch (error) {
      if (controller.signal.aborted && !error?.requestBoundExpired) {
        const ownedAbort = new Error("owned request aborted");
        ownedAbort.ownedAbort = true;
        throw ownedAbort;
      }
      throw error;
    } finally {
      active = false;
      cancelBound(handle);
      slot.controllers.delete(controller);
    }
  }

  function requestedExecutorMatches(job, parentID) {
    const requested = job.requested_executor;
    const permission = requested?.final_permission;
    return requested && requested.session_id === job.session_id && requested.parent_session_id === parentID &&
      requested.directory === job.directory && requested.manifest_agent_id === job.manifest_agent_id &&
      requested.agent === job.agent && requested.model?.providerID === job.model?.providerID &&
      requested.model?.id === job.model?.id && requested.model?.variant === job.model?.variant &&
      permission && Object.keys(permission).length === 3 && permission.action === TOOL_NAME &&
      permission.resource === "*" && permission.effect === "deny";
  }

  function observationAttested(info, wave, job) {
    if (!requestedExecutorMatches(job, wave.parent_session_id)) return false;
    if (verifyManifestBinding(ctx.location.project.canonical || ctx.location.project.directory, job)) return false;
    return sessionAttestationReasons(info, {
      session_id: job.session_id,
      parent_session_id: wave.parent_session_id,
      directory: job.directory,
      agent: job.agent,
      model: job.model,
    }).length === 0;
  }

  function retryDelay(cycle) {
    return Math.min(cycle >= 8 ? 30_000 : 250 * (2 ** (cycle - 1)), 30_000);
  }

  async function writeDisposition(slot, operation, reason, state) {
    const { key, observerKey, sessionID, episode, cycle } = slot;
    let written;
    await withWaveLock(key, async () => {
      if (!activeSlot(key, observerKey, slot)) return;
      const wave = await ctx.storage.get(key);
      const job = wave?.jobs?.[sessionID];
      if (!job || job.status !== "running" || job.observation?.episode !== episode || job.observation?.cycle !== cycle) return;
      const nextWave = structuredClone(wave);
      const nextJob = nextWave.jobs[sessionID];
      const timestamp = Math.max(1, now(), nextJob.observation?.first_deferred_at || 1, nextJob.observation?.last_deferred_at || 1);
      const effectiveState = timestamp >= nextJob.deadline ? "blocked" : state;
      if (cycle === MAX_UINT32) {
        nextJob.observation = {
          episode, cycle, operation, reason: "counter_exhausted",
          first_deferred_at: nextJob.observation?.first_deferred_at || timestamp,
          last_deferred_at: timestamp, state: "blocked",
        };
      } else {
        const nextCycle = cycle + 1;
        const first = nextJob.observation?.reason === "attempt_due"
          ? timestamp
          : (nextJob.observation?.first_deferred_at || timestamp);
        nextJob.observation = {
          episode, cycle: nextCycle, operation, reason,
          first_deferred_at: first, last_deferred_at: timestamp,
          ...(effectiveState ? { state: effectiveState } : { retry_at: Math.min(timestamp + retryDelay(nextCycle), nextJob.deadline) }),
        };
      }
      if (!validObservation(nextJob.observation, nextJob.deadline)) return;
      await ctx.storage.set(key, nextWave);
      if (!activeSlot(key, observerKey, slot)) return;
      slot.cycle = nextJob.observation.cycle;
      written = structuredClone(nextJob.observation);
    });
    if (!written || written.state || !activeSlot(key, observerKey, slot)) return;
    await scheduleCycle(slot, written.retry_at);
  }

  async function publishTerminal(slot, result) {
    let committed = false;
    for (let attempt = 0; attempt < MAX_TERMINAL_WRITE_ATTEMPTS && !committed; attempt += 1) {
      try {
        await withWaveLock(slot.key, async () => {
          if (!activeSlot(slot.key, slot.observerKey, slot)) return;
          const wave = await ctx.storage.get(slot.key);
          const job = wave?.jobs?.[slot.sessionID];
          if (!job || job.status !== "running" || job.observation?.episode !== slot.episode || job.observation?.cycle !== slot.cycle) return;
          const terminal = { ...job, ...result, finished_at: now() };
          delete terminal.observation;
          wave.jobs[slot.sessionID] = terminal;
          if (!activeSlot(slot.key, slot.observerKey, slot)) return;
          await ctx.storage.set(slot.key, wave);
          committed = true;
        });
      } catch {
        if (attempt + 1 < MAX_TERMINAL_WRITE_ATTEMPTS) await sleep(Math.min(25 * (2 ** attempt), MAX_TERMINAL_WRITE_BACKOFF_MS));
      }
    }
    if (committed && activeForWave(slot.key)) track(maybeNotify(slot.parentID, slot.waveID));
    return committed;
  }

  async function blockSchedulingFailure(slot) {
    let blocked = false;
    await withWaveLock(slot.key, async () => {
      if (!activeSlot(slot.key, slot.observerKey, slot)) return;
      const wave = await ctx.storage.get(slot.key);
      const job = wave?.jobs?.[slot.sessionID];
      if (!job || job.status !== "running" || job.observation?.episode !== slot.episode || job.observation?.cycle !== slot.cycle) return;
      const nextWave = structuredClone(wave);
      const observation = nextWave.jobs[slot.sessionID].observation;
      nextWave.jobs[slot.sessionID].observation = {
        episode: observation.episode,
        cycle: observation.cycle,
        operation: observation.operation,
        reason: "unknown",
        first_deferred_at: observation.first_deferred_at,
        last_deferred_at: Math.max(1, now()),
        state: "blocked",
      };
      await ctx.storage.set(slot.key, nextWave);
      blocked = activeSlot(slot.key, slot.observerKey, slot);
    });
    if (!blocked || observers.get(slot.observerKey) !== slot) return;
    observers.delete(slot.observerKey);
    slot.revoked = true;
    for (const controller of slot.controllers) controller.abort();
  }

  async function scheduleCycle(slot, retryAt) {
    if (!activeSlot(slot.key, slot.observerKey, slot)) return;
    const old = reobserveTimers.get(slot.observerKey);
    if (old && old !== slot.timerSlot) return;
    const timerSlot = { owner, observer: slot, handle: undefined };
    try {
      timerSlot.handle = schedule(() => {
        if (!activeSlot(slot.key, slot.observerKey, slot) || reobserveTimers.get(slot.observerKey) !== timerSlot) return;
        reobserveTimers.delete(slot.observerKey);
        track(runCycle(slot));
      }, Math.max(0, retryAt - now()));
    } catch {
      await blockSchedulingFailure(slot);
      return;
    }
    timerSlot.handle?.unref?.();
    reobserveTimers.set(slot.observerKey, timerSlot);
    slot.timerSlot = timerSlot;
  }

  async function classifyFailure(slot, operation, error, cutoff) {
    if (!activeSlot(slot.key, slot.observerKey, slot)) return;
    if (slot.revoked || error?.ownedAbort) return;
    const reason = operation === "service.discover" ? "unavailable" : errorReason(error);
    const state = cutoff ? "blocked" : (transientReason(reason) ? undefined : "quarantined");
    await writeDisposition(slot, operation, reason, state);
  }

  async function finalizeOutcome(slot, info, client) {
    let messages = [];
    try {
      const projected = unwrap(await bounded(slot, (signal) => client.session.context({ sessionID: slot.sessionID }, { signal })));
      messages = validContextProjection(projected) ? projected : [];
    } catch {
      messages = [];
    }
    if (!activeSlot(slot.key, slot.observerKey, slot)) return;
    const result = extractResult(info, Array.isArray(messages) ? messages : []);
    if (!TERMINAL.has(result.status) || result.status === "timeout") return;
    const committed = await publishTerminal(slot, result);
    if (!committed && activeSlot(slot.key, slot.observerKey, slot)) {
      await writeDisposition(slot, "session.get", "outcome_pending");
    }
  }

  async function cleanupInterrupt(slot, client) {
    if (!activeSlot(slot.key, slot.observerKey, slot)) return;
    try {
      await bounded(slot, (signal) => client.session.interrupt({ sessionID: slot.sessionID, continue: false }, { signal }));
    } catch {
      // Timeout is already immutable; interruption is cleanup only.
    }
  }

  async function publishTimeout(slot, client) {
    const committed = await publishTerminal(slot, { status: "timeout", error: "child session exceeded its deadline" });
    if (committed && activeSlot(slot.key, slot.observerKey, slot)) track(cleanupInterrupt(slot, client));
  }

  async function settleCrossedCutoff(slot, wave, job, client) {
    let info;
    try {
      info = unwrap(await bounded(slot, (signal) => client.session.get({ sessionID: slot.sessionID }, { signal })));
    } catch (error) {
      if (!activeSlot(slot.key, slot.observerKey, slot)) return;
      await classifyFailure(slot, "session.get", error, true);
      return;
    }
    if (!activeSlot(slot.key, slot.observerKey, slot)) return;
    if (!observationAttested(info, wave, job)) {
      await writeDisposition(slot, "session.get", "attestation_mismatch", "blocked");
      return;
    }
    const recognizedOutcome = ["succeeded", "failed", "interrupted"].includes(info?.outcome);
    const validTerminalIdle = Number.isSafeInteger(info?.time?.idle) && info.time.idle > 0;
    if (recognizedOutcome && validTerminalIdle) {
      await finalizeOutcome(slot, info, client);
      return;
    }
    if (info?.outcome !== undefined) {
      await writeDisposition(slot, "session.get", "malformed_response", "blocked");
      return;
    }
    await publishTimeout(slot, client);
  }

  async function runCycle(slot) {
    if (!activeSlot(slot.key, slot.observerKey, slot)) return;
    let wave;
    let job;
    await withWaveLock(slot.key, async () => {
      if (!activeSlot(slot.key, slot.observerKey, slot)) return;
      wave = await ctx.storage.get(slot.key);
      job = wave?.jobs?.[slot.sessionID];
      if (!validWaveShape(wave, slot.parentID, slot.waveID) || !job || job.status !== "running" ||
          job.observation?.episode !== slot.episode || job.observation?.cycle !== slot.cycle) {
        wave = undefined;
      }
    });
    if (!wave || !activeSlot(slot.key, slot.observerKey, slot)) return;
    if (!supportedVersion(ctx.app.version)) return;
    if (slot.cycle === MAX_UINT32) {
      await writeDisposition(slot, job.observation.operation, "counter_exhausted", "blocked");
      return;
    }
    const cutoff = now() >= job.deadline;
    let endpoint;
    try { endpoint = await service.discover({ version: ctx.app.version }); } catch (error) {
      if (!activeSlot(slot.key, slot.observerKey, slot)) return;
      await classifyFailure(slot, "service.discover", error, now() >= job.deadline); return;
    }
    if (!activeSlot(slot.key, slot.observerKey, slot)) return;
    if (!endpoint) { await classifyFailure(slot, "service.discover", undefined, now() >= job.deadline); return; }
    let client;
    try { client = makeClient(endpoint); } catch (error) { await classifyFailure(slot, "service.discover", error, now() >= job.deadline); return; }
    if (!cutoff && now() >= job.deadline) {
      await settleCrossedCutoff(slot, wave, job, client); return;
    }
    let health;
    try { health = unwrap(await bounded(slot, (signal) => client.health.get({ signal }))); } catch (error) {
      if (!activeSlot(slot.key, slot.observerKey, slot)) return;
      if (!cutoff && now() >= job.deadline) {
        await settleCrossedCutoff(slot, wave, job, client); return;
      }
      await classifyFailure(slot, "health.get", error, now() >= job.deadline); return;
    }
    if (!activeSlot(slot.key, slot.observerKey, slot)) return;
    if (!cutoff && now() >= job.deadline) {
      await settleCrossedCutoff(slot, wave, job, client); return;
    }
    if (health?.healthy !== true) { await writeDisposition(slot, "health.get", "unavailable", now() >= job.deadline ? "blocked" : undefined); return; }
    if (health.pid !== process.pid || health.version !== ctx.app.version || !supportedVersion(health.version)) {
      await writeDisposition(slot, "health.get", "attestation_mismatch", now() >= job.deadline ? "blocked" : "quarantined"); return;
    }
    let info;
    try { info = unwrap(await bounded(slot, (signal) => client.session.get({ sessionID: slot.sessionID }, { signal }))); } catch (error) {
      if (!activeSlot(slot.key, slot.observerKey, slot)) return;
      if (!cutoff && now() >= job.deadline) {
        await settleCrossedCutoff(slot, wave, job, client); return;
      }
      await classifyFailure(slot, "session.get", error, now() >= job.deadline); return;
    }
    if (!activeSlot(slot.key, slot.observerKey, slot)) return;
    if (!observationAttested(info, wave, job)) {
      await writeDisposition(slot, "session.get", "attestation_mismatch", cutoff ? "blocked" : "quarantined"); return;
    }
    const recognizedOutcome = ["succeeded", "failed", "interrupted"].includes(info?.outcome);
    const validTerminalIdle = Number.isSafeInteger(info?.time?.idle) && info.time.idle > 0;
    if (recognizedOutcome && validTerminalIdle) {
      await finalizeOutcome(slot, info, client); return;
    }
    if (info?.outcome !== undefined && (!recognizedOutcome || !validTerminalIdle)) {
      await writeDisposition(slot, "session.get", "malformed_response", cutoff ? "blocked" : "quarantined"); return;
    }
    if (cutoff || now() >= job.deadline) {
      await publishTimeout(slot, client);
      return;
    }
    try {
      await bounded(slot, (signal) => client.session.wait({ sessionID: slot.sessionID }, { signal }));
    } catch (error) {
      if (!activeSlot(slot.key, slot.observerKey, slot)) return;
      if (now() >= job.deadline) {
        await settleCrossedCutoff(slot, wave, job, client); return;
      }
      await classifyFailure(slot, "session.wait", error, now() >= job.deadline);
      return;
    }
    if (!activeSlot(slot.key, slot.observerKey, slot)) return;
    if (now() >= job.deadline) {
      await settleCrossedCutoff(slot, wave, job, client); return;
    }
    if (job.observation?.retry_at > now()) {
      await scheduleCycle(slot, job.observation.retry_at);
      return;
    }
    await writeDisposition(slot, "session.wait", "outcome_pending");
  }

  async function claimObserver(parentID, waveID, sessionID, explicit = false) {
    const key = waveKey(parentID, waveID);
    const observerKey = `${parentID}\0${waveID}\0${sessionID}`;
    let slot;
    let retryAt;
    await withWaveLock(key, async () => {
      if (disposed || !supportedVersion(ctx.app.version)) return;
      const wave = await ctx.storage.get(key);
      const job = wave?.jobs?.[sessionID];
      if (!validWaveShape(wave, parentID, waveID) || !job || job.status !== "running") return;
      const current = job.observation;
      if (!explicit && (current?.state === "blocked" || current?.state === "quarantined")) return;
      const priorEpisode = Number.isInteger(current?.episode) ? current.episode : 0;
      if (explicit && priorEpisode === MAX_UINT32) return;
      const episode = explicit ? (priorEpisode ? priorEpisode + 1 : 1) : (priorEpisode || 1);
      const cycle = explicit ? 0 : (Number.isInteger(current?.cycle) ? current.cycle : 0);
      const previous = observers.get(observerKey);
      if (!explicit && previous?.owner === owner && activeSlot(key, observerKey, previous) &&
          previous.episode === episode && previous.cycle === cycle) return;
      const nextWave = structuredClone(wave);
      const nextJob = nextWave.jobs[sessionID];
      const timestamp = Math.max(1, now());
      if (cycle === MAX_UINT32) {
        nextJob.observation = {
          episode, cycle, operation: current?.operation || "service.discover", reason: "counter_exhausted",
          first_deferred_at: current?.first_deferred_at || timestamp, last_deferred_at: timestamp, state: "blocked",
        };
      } else if (explicit || !current) {
        const dueAt = Math.max(1, Math.min(timestamp, nextJob.deadline));
        nextJob.observation = {
          episode, cycle, operation: "service.discover", reason: "attempt_due",
          first_deferred_at: dueAt, last_deferred_at: dueAt, retry_at: dueAt,
        };
      }
      retryAt = nextJob.observation?.retry_at;
      if (JSON.stringify(nextWave) !== JSON.stringify(wave)) await ctx.storage.set(key, nextWave);
      if (disposed) return;
      previous && (previous.revoked = true);
      for (const controller of previous?.controllers || []) controller.abort();
      const oldTimer = reobserveTimers.get(observerKey);
      if (oldTimer) { reobserveTimers.delete(observerKey); cancelSchedule(oldTimer.handle); }
      waveOwners.set(key, owner);
      slot = { owner, key, observerKey, parentID, waveID, sessionID, episode, cycle, controllers: new Set(), revoked: false };
      observers.set(observerKey, slot);
    });
    if (!slot || !activeSlot(key, observerKey, slot) || retryAt === undefined) return;
    if (!explicit && retryAt > now()) await scheduleCycle(slot, retryAt);
    else if (explicit) await track(runCycle(slot));
    else track(runCycle(slot));
  }

  function observe(parentID, waveID, job) {
    return claimObserver(parentID, waveID, job.session_id, false);
  }

  function scheduleNotification(parentID, waveID, attempt) {
    const timerKey = `${parentID}\0${waveID}`;
    const key = waveKey(parentID, waveID);
    if (!activeForWave(key)) return;
    const previous = notificationTimers.get(timerKey);
    if (previous?.owner === owner) return;
    const delay = Math.min(250 * (2 ** Math.min(attempt, 7)), MAX_NOTIFICATION_BACKOFF_MS);
    const slot = { owner, handle: undefined };
    try {
      slot.handle = schedule(() => {
        if (!activeForWave(key) || notificationTimers.get(timerKey) !== slot) return;
        notificationTimers.delete(timerKey);
        track(maybeNotify(parentID, waveID));
      }, delay);
    } catch {
      return;
    }
    slot.handle?.unref?.();
    notificationTimers.set(timerKey, slot);
    if (previous && notificationTimers.get(timerKey) === slot) cancelSchedule(previous.handle);
  }

  async function maybeNotify(parentID, waveID) {
    const key = waveKey(parentID, waveID);
    if (!activeForWave(key) || !supportedVersion(ctx.app.version)) return;
    let retryAttempt = 0;
    try {
      await withWaveLock(key, async () => {
        if (!activeForWave(key)) return;
        const wave = await ctx.storage.get(key);
        if (!activeForWave(key)) return;
        if (!validWaveShape(wave, parentID, waveID)) return;
        if (wave.version === STATE_VERSION && Object.values(wave.jobs).some(legacyTransportCandidate)) return;
        if (!wave?.sealed || wave.notification?.state === "sent") return;
        const expected = wave.expected_session_ids || [];
        if (!expected.length || !expected.every((id) => TERMINAL.has(wave.jobs?.[id]?.status))) return;
        const id = normalizedNotificationID(parentID, waveID, wave.notification);
        retryAttempt = (wave.notification?.attempts || 0) + 1;
        wave.notification = { id, state: "sending", attempts: retryAttempt, attempted_at: now() };
        if (!activeForWave(key)) return;
        await ctx.storage.set(key, wave);
        const jobs = expected.map((sessionID) => wave.jobs[sessionID]);
        const content = JSON.stringify({
          type: "gsd_worktree_wave_completed",
          wave_id: waveID,
          jobs: jobs.map(({ session_id, directory, status, text, error }) => ({
            session_id, directory, status, ...(text ? { text } : {}), ...(error ? { error } : {}),
          })),
          next_action: { tool: TOOL_NAME, action: "status", wave_id: waveID },
        });
        if (!activeForWave(key)) return;
        await ctx.session.prompt({
          sessionID: parentID,
          id,
          text: content,
          delivery: "queue",
          metadata: { plugin: PLUGIN_ID, wave_id: waveID },
        });
        if (!activeForWave(key)) return;
        wave.notification = { id, state: "sent", attempts: retryAttempt, sent_at: now() };
        await ctx.storage.set(key, wave);
      });
    } catch (error) {
      if (error?.notificationIdentityMismatch) throw error;
      try {
        await withWaveLock(key, async () => {
          if (!activeForWave(key)) return;
          const wave = await ctx.storage.get(key);
          if (!activeForWave(key)) return;
          if (!validWaveShape(wave, parentID, waveID)) return;
          if (!wave || wave.notification?.state === "sent") return;
          retryAttempt = Math.max(retryAttempt, wave.notification?.attempts || 1);
          wave.notification = {
            id: normalizedNotificationID(parentID, waveID, wave.notification),
            state: "retrying",
            attempts: retryAttempt,
            retry_at: now() + Math.min(250 * (2 ** Math.min(retryAttempt, 7)), MAX_NOTIFICATION_BACKOFF_MS),
          };
          if (!activeForWave(key)) return;
          await ctx.storage.set(key, wave);
        });
      } catch {
        // A durable "sending" record already carries the deterministic ID and is retryable on recovery.
      }
      if (activeForWave(key)) scheduleNotification(parentID, waveID, retryAttempt);
    }
  }

  async function start(input, tool, operation) {
    assertActiveOperation(operation);
    if (!supportedVersion(ctx.app.version)) throw new Error("unsupported OpenCode version");
    const parentID = tool.sessionID;
    const root = ctx.location.project.canonical || ctx.location.project.directory;
    assertPromptSize(input.prompt);
    const injectionFindings = scanPromptInjection(input.prompt);
    const injectionWarning = injectionFindings.length
      ? promptInjectionWarning(injectionFindings, injectionBlockingPolicy(root) && findingSeverity(injectionFindings) === "HIGH")
      : undefined;
    if (injectionWarning?.blocking) {
      const error = new Error("prompt injection blocked by project security.injection_blocking policy");
      error.code = "prompt_injection_blocked";
      error.warning = injectionWarning;
      throw error;
    }
    const directory = resolveWorktreeDirectory(root, input.directory);
    const manifestBinding = readManifestBinding(root, input.manifest_path, input.manifest_agent_id, directory);
    await assertInventory(directory, operation);
    assertActiveOperation(operation);
    const client = await clientForImport(operation);
    assertActiveOperation(operation);
    await assertTarget(client, directory, input.agent, operation);
    assertActiveOperation(operation);
    const key = waveKey(parentID, input.wave_id);
    let job;
    await withWaveLock(key, async () => {
      if (disposed) throw new Error("worktree runtime is disposed");
      let existing = await ctx.storage.get(key);
      assertActiveOperation(operation);
      if (existing && !validWaveShape(existing, parentID, input.wave_id)) throw new Error("stored wave structure is unsupported");
      waveOwners.set(key, owner);
      if (existing?.sealed) throw new Error("cannot add a job to a sealed wave");
      const existingJobs = Object.values(existing?.jobs || {});
      if (existingJobs.length && (
        existing.manifest_path !== manifestBinding.manifest_path ||
        existingJobs.some((item) => item.manifest_path !== manifestBinding.manifest_path)
      )) {
        throw new Error("all jobs in a wave must use the same canonical manifest_path");
      }
      if (existing && !existingJobs.length) existing.manifest_path = manifestBinding.manifest_path;
      if (Object.keys(existing?.jobs || {}).length >= MAX_JOBS) throw new Error(`a wave may contain at most ${MAX_JOBS} jobs`);
      assertActiveOperation(operation);
      const parent = await bounded(operation, (signal) => ctx.session.get({ sessionID: parentID }, { signal }));
      assertActiveOperation(operation);
      const permissions = [
        ...(Array.isArray(parent.permissions) ? parent.permissions : []),
        { action: TOOL_NAME, resource: "*", effect: "deny" },
      ];
      const model = { providerID: input.provider, id: input.model, variant: input.reasoning_effort };
      for (let attempt = 1; attempt <= MAX_IMPORT_ATTEMPTS; attempt += 1) {
        const sessionID = makeID();
        const created = now();
        job = {
          session_id: sessionID,
          directory,
          status: "provisioning",
          agent: input.agent,
          model,
          ...manifestBinding,
          requested_executor: {
            session_id: sessionID,
            parent_session_id: parentID,
            directory,
            manifest_agent_id: input.manifest_agent_id,
            agent: input.agent,
            model,
            final_permission: { action: TOOL_NAME, resource: "*", effect: "deny" },
          },
          started_at: created,
          deadline: created + (input.timeout_seconds || DEFAULT_TIMEOUT_SECONDS) * 1000,
        };
        assertActiveOperation(operation);
        const wave = existing || {
          version: STATE_VERSION,
          parent_session_id: parentID,
          wave_id: input.wave_id,
          created_at: created,
          sealed: false,
          manifest_path: manifestBinding.manifest_path,
          jobs: {},
        };
        wave.jobs[sessionID] = job;
        assertActiveOperation(operation);
        await ctx.storage.set(key, wave);
        assertActiveOperation(operation);
        existing = wave;
        const removeProvisional = async () => {
          assertActiveOperation(operation);
          delete wave.jobs[sessionID];
          await ctx.storage.set(key, wave);
          assertActiveOperation(operation);
        };
        const cleanupFailedAttempt = async (error) => {
          assertActiveOperation(operation);
          try {
            await cleanupMintedChild(client, sessionID, operation);
            assertActiveOperation(operation);
            await removeProvisional();
          } catch (cleanupError) {
            job.status = "failed";
            job.error = error instanceof Error ? error.message : String(error);
            job.cleanup_error = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            job.finished_at = now();
            assertActiveOperation(operation);
            await ctx.storage.set(key, wave).catch(() => {});
            throw new AggregateError([error, cleanupError], "child launch failed and cleanup could not be verified");
          }
        };
        const info = {
          id: sessionID,
          parentID,
          projectID: parent.projectID || ctx.location.project.id,
          agent: input.agent,
          model,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created, updated: created },
          title: input.title || `GSD worktree task (${input.agent})`,
          location: { directory },
          metadata: { plugin: PLUGIN_ID, wave_id: input.wave_id },
          permissions,
        };
        try {
          assertActiveOperation(operation);
          await bounded(operation, (signal) => client.session.import({ info, messages: [], location: { directory } }, { signal }));
          assertActiveOperation(operation);
        } catch (error) {
          if (!activeOperation(operation)) throw error;
          if (isConflict(error)) {
            await removeProvisional();
            if (attempt < MAX_IMPORT_ATTEMPTS) continue;
            throw new Error(`session ID collision after ${MAX_IMPORT_ATTEMPTS} import attempts`, { cause: error });
          }
          await cleanupFailedAttempt(error);
          throw error;
        }
        try {
          assertActiveOperation(operation);
          const importedInfo = await bounded(operation, (signal) => client.session.get({ sessionID }, { signal }));
          assertActiveOperation(operation);
          const attestation = sessionAttestationReasons(importedInfo, {
            session_id: sessionID,
            parent_session_id: parentID,
            directory,
            agent: input.agent,
            model,
          });
          if (attestation.length) {
            throw new Error(`imported child session attestation failed: ${attestation.join(",")}`);
          }
          assertActiveOperation(operation);
          await bounded(operation, (signal) => client.session.prompt({ sessionID, text: input.prompt, delivery: "queue" }, { signal }));
          assertActiveOperation(operation);
          job.status = "running";
          assertActiveOperation(operation);
          await ctx.storage.set(key, wave);
          assertActiveOperation(operation);
          break;
        } catch (error) {
          if (!activeOperation(operation)) throw error;
          await cleanupFailedAttempt(error);
          throw error;
        }
      }
    });
    assertActiveOperation(operation);
    track(observe(parentID, input.wave_id, job));
    return response({
      wave_id: input.wave_id,
      session_id: job.session_id,
      directory,
      manifest_path: job.manifest_path,
      manifest_agent_id: job.manifest_agent_id,
      manifest_entry_hash: job.manifest_entry_hash,
      status: "running",
      ...(injectionWarning ? { warnings: [injectionWarning] } : {}),
    });
  }

  async function seal(input, tool) {
    if (!supportedVersion(ctx.app.version)) throw new Error("unsupported OpenCode version");
    const parentID = tool.sessionID;
    const key = waveKey(parentID, input.wave_id);
    const root = ctx.location.project.canonical || ctx.location.project.directory;
    const requested = input.jobs.map((job) => ({
      ...job,
      directory: resolveWorktreeDirectory(root, job.directory),
    }));
    if (new Set(requested.map((job) => job.session_id)).size !== requested.length) {
      throw new Error("seal jobs must contain unique session IDs");
    }
    const wave = await withWaveLock(key, async () => {
      if (disposed) throw new Error("worktree runtime is disposed");
      waveOwners.set(key, owner);
      const wave = await ctx.storage.get(key);
      if (!wave) throw new Error("cannot seal an unknown wave");
      const manifestPaths = new Set(Object.values(wave.jobs || {}).map((job) => job.manifest_path));
      if (manifestPaths.size !== 1 || manifestPaths.has(undefined) || !manifestPaths.has(wave.manifest_path)) {
        throw new Error("wave manifest identity is inconsistent");
      }
      for (const job of Object.values(wave.jobs || {})) {
        const manifestReason = verifyManifestBinding(root, job);
        if (manifestReason) throw new Error(`manifest binding verification failed for ${job.session_id}: ${manifestReason}`);
      }
      if (!validWaveShape(wave, parentID, input.wave_id)) throw new Error("stored wave structure is unsupported");
      const actual = Object.values(wave.jobs).map((job) => ({ session_id: job.session_id, directory: job.directory }));
      if (!sameJobs(requested, actual)) throw new Error("seal jobs must exactly match all started wave jobs");
      if (wave.sealed) {
        const sealed = wave.expected_session_ids.map((id) => ({ session_id: id, directory: wave.jobs[id].directory }));
        if (!sameJobs(requested, sealed)) throw new Error("wave is already sealed with a different expected set");
        return wave;
      }
      wave.sealed = true;
      wave.sealed_at = now();
      wave.expected_session_ids = requested.map((job) => job.session_id).sort();
      await ctx.storage.set(key, wave);
      return wave;
    });
    for (const job of Object.values(wave.jobs || {})) {
      if (job.status === "running") track(observe(parentID, input.wave_id, job));
    }
    track(maybeNotify(parentID, input.wave_id));
    return response({ wave_id: input.wave_id, sealed: true, jobs: requested });
  }

  async function computeStatusOwned(parentID, waveID, operation) {
    const key = waveKey(parentID, waveID);
    const wave = await withWaveLock(key, () => ctx.storage.get(key));
    assertActiveOperation(operation);
    if (!wave) throw new Error("unknown wave");
    const durableSnapshot = statusAuthoritySnapshot(wave);
    const reasons = [];
    const waveShapeValid = validWaveShape(wave, parentID, waveID);
    if (!waveShapeValid) reasons.push("wave_identity_mismatch");
    const expected = Array.isArray(wave.expected_session_ids) ? wave.expected_session_ids : [];
    const durableJobs = isPlainRecord(wave.jobs) ? wave.jobs : {};
    const jobs = expected.length ? expected.map((id) => durableJobs[id]).filter(Boolean) : Object.values(durableJobs);
    const actualIDs = Object.keys(durableJobs).sort();
    const expectedIDs = [...expected].sort();
    const root = ctx.location.project.canonical || ctx.location.project.directory;
    if (wave.parent_session_id !== parentID || wave.wave_id !== waveID) reasons.push("wave_identity_mismatch");
    if (!wave.sealed) reasons.push("wave_not_sealed");
    if (
      !expected.length ||
      new Set(expected).size !== expected.length ||
      expectedIDs.length !== actualIDs.length ||
      !expectedIDs.every((id, index) => id === actualIDs[index]) ||
      jobs.length !== expected.length
    ) {
      reasons.push("expected_job_set_incomplete");
    }
    const manifestPaths = new Set(Object.values(wave.jobs || {}).map((job) => job.manifest_path));
    if (manifestPaths.size !== 1 || manifestPaths.has(undefined) || !manifestPaths.has(wave.manifest_path)) {
      reasons.push("wave_manifest_identity_mismatch");
    }
    let client;
    const liveEligible = waveShapeValid && supportedVersion(ctx.app.version) && jobs.length > 0 && jobs.every((job) => job?.status === "succeeded");
    if (liveEligible) {
      try { client = await clientForImport(operation); } catch { reasons.push("same_service_unverified"); }
    } else if (!supportedVersion(ctx.app.version)) {
      reasons.push("same_service_unverified");
    }
    let inventory = [];
    if (waveShapeValid) {
      try {
        inventory = await bounded(operation, (signal) => ctx.worktree.list({ signal }));
        assertActiveOperation(operation);
      } catch { reasons.push("worktree_inventory_unavailable"); }
    } else {
      reasons.push("worktree_inventory_unavailable");
    }
    const inventoryPaths = new Set(inventory.flatMap((item) => {
      try { return [canonical(item.directory)]; } catch { return []; }
    }));
    const statusJobs = [];
    for (const job of jobs) {
      if (!waveShapeValid) {
        const safeSessionID = typeof job?.session_id === "string" && job.session_id.startsWith("ses") ? job.session_id : "unknown";
        reasons.push(`${safeSessionID}:requested_executor_mismatch`);
        statusJobs.push(failedSafeStatusJobProjection(job));
        continue;
      }
      const safeSessionID = typeof job?.session_id === "string" ? job.session_id : "unknown";
      const jobShapeValid = validJobShape(job, wave.parent_session_id, wave.manifest_path) && closedJobShape(job);
      if (!jobShapeValid) reasons.push(`${safeSessionID}:requested_executor_mismatch`);
      if (job.status !== "succeeded") reasons.push(`${safeSessionID}:status_${typeof job.status === "string" ? job.status : "failed"}`);
      if (job.status === "provisioning") reasons.push(`${safeSessionID}:provisioning_unresolved`);
      if (job.status === "running") {
        const observation = job.observation;
        if (observation?.episode === MAX_UINT32) reasons.push(`${safeSessionID}:observation_episode_exhausted`);
        if (observation?.state === "blocked") reasons.push(`${safeSessionID}:observation_blocked:${observation.operation}:${observation.reason}`);
        else if (observation?.state === "quarantined") reasons.push(`${safeSessionID}:observation_quarantined:${observation.operation}:${observation.reason}`);
        else if (observation?.retry_at !== undefined) reasons.push(`${safeSessionID}:observation_retry_scheduled:${observation.operation}:${observation.reason}`);
      }
      if (wave.version === STATE_VERSION && job.status === "failed" && job.error === "Transport" &&
          !Object.hasOwn(job, "cleanup_error") && !Object.hasOwn(job, "observation")) {
        reasons.push(`${safeSessionID}:legacy_transport_repair_refused:admission_provenance_unavailable`);
      }
      const manifestReason = verifyManifestBinding(root, job);
      if (manifestReason) reasons.push(`${safeSessionID}:${manifestReason}`);
      const requestedExecutor = job.requested_executor;
      const requestedPermission = requestedExecutor?.final_permission;
      if (!requestedExecutor || requestedExecutor.session_id !== job.session_id ||
          requestedExecutor.parent_session_id !== wave.parent_session_id ||
          requestedExecutor.directory !== job.directory ||
          requestedExecutor.manifest_agent_id !== job.manifest_agent_id ||
          requestedExecutor.agent !== job.agent ||
          requestedExecutor.model?.providerID !== job.model?.providerID ||
          requestedExecutor.model?.id !== job.model?.id ||
          requestedExecutor.model?.variant !== job.model?.variant ||
          !requestedPermission || Object.keys(requestedPermission).length !== 3 ||
          requestedPermission.action !== TOOL_NAME || requestedPermission.resource !== "*" || requestedPermission.effect !== "deny") {
        reasons.push(`${safeSessionID}:requested_executor_mismatch`);
      }
      let directory;
      try {
        directory = resolveWorktreeDirectory(root, job.directory);
        if (!inventoryPaths.has(directory)) reasons.push(`${safeSessionID}:worktree_missing_from_inventory`);
      } catch {
        reasons.push(`${safeSessionID}:worktree_missing`);
        continue;
      }
      let observedExecutor = null;
      if (client) {
        try {
          const info = unwrap(await bounded(operation, (signal) => client.session.get({ sessionID: job.session_id }, { signal })));
          assertActiveOperation(operation);
          const finalPermission = Array.isArray(info?.permissions) ? info.permissions.at(-1) : undefined;
          let observedDirectory = "";
          try { observedDirectory = canonical(info?.location?.directory); } catch { /* recorded by sessionAttestationReasons */ }
          observedExecutor = {
            session_id: typeof info?.id === "string" ? info.id : "",
            parent_session_id: typeof info?.parentID === "string" ? info.parentID : "",
            directory: observedDirectory,
            agent: typeof info?.agent === "string" ? info.agent : "",
            model: {
              providerID: typeof info?.model?.providerID === "string" ? info.model.providerID : "",
              id: typeof info?.model?.id === "string" ? info.model.id : "",
              variant: typeof info?.model?.variant === "string" ? info.model.variant : "",
            },
            outcome: typeof info?.outcome === "string" ? info.outcome : "",
            final_permission: {
              action: typeof finalPermission?.action === "string" ? finalPermission.action : "",
              resource: typeof finalPermission?.resource === "string" ? finalPermission.resource : "",
              effect: typeof finalPermission?.effect === "string" ? finalPermission.effect : "",
            },
          };
          for (const reason of sessionAttestationReasons(info, {
            session_id: job.session_id,
            parent_session_id: wave.parent_session_id,
            directory,
            agent: job.agent,
            model: job.model,
          })) reasons.push(`${safeSessionID}:${reason}`);
          if (info.outcome !== "succeeded") reasons.push(`${safeSessionID}:outcome_${info.outcome || "missing"}`);
        } catch {
          reasons.push(`${safeSessionID}:session_unverifiable`);
        }
      }
      statusJobs.push({
        session_id: typeof job.session_id === "string" ? job.session_id : "",
        directory: typeof job.directory === "string" ? job.directory : "",
        status: ["provisioning", "running", "succeeded", "failed", "interrupted", "timeout"].includes(job.status) ? job.status : "failed",
        agent: typeof job.agent === "string" ? job.agent : "",
        model: modelProjection(job.model),
        manifest_path: typeof job.manifest_path === "string" ? job.manifest_path : "",
        manifest_agent_id: typeof job.manifest_agent_id === "string" ? job.manifest_agent_id : "",
        manifest_entry: manifestEntryProjection(job.manifest_entry),
        manifest_entry_hash: typeof job.manifest_entry_hash === "string" ? job.manifest_entry_hash : "",
        ...(Number.isSafeInteger(job.started_at) && job.started_at > 0 ? { started_at: job.started_at } : {}),
        ...(Number.isSafeInteger(job.deadline) && job.deadline > 0 ? { deadline: job.deadline } : {}),
        ...(Number.isSafeInteger(job.finished_at) && job.finished_at > 0 ? { finished_at: job.finished_at } : {}),
        ...(typeof job.text === "string" ? { text: job.text } : {}),
        ...(typeof job.error === "string" ? { error: job.error } : {}),
        ...(typeof job.cleanup_error === "string" ? { cleanup_error: job.cleanup_error } : {}),
        requested_executor: requestedExecutorProjection(requestedExecutor),
        observed_executor: observedExecutor,
      });
    }
    const storedNotificationID = wave.notification?.id;
    if (typeof storedNotificationID === "string" && storedNotificationID.startsWith("msg_") &&
        storedNotificationID !== notificationID(parentID, waveID)) reasons.push("notification_identity_mismatch");
    if (legacyRetryNotification(wave.notification)) reasons.push("notification_legacy_retry_pending");
    const current = await withWaveLock(key, () => ctx.storage.get(key));
    assertActiveOperation(operation);
    if (statusAuthoritySnapshot(current) !== durableSnapshot) reasons.push("wave_changed_during_status");
    return {
      wave_id: waveID,
      parent_session_id: parentID,
      checked_at: now(),
      sealed: wave.sealed,
      merge_ready: reasons.length === 0,
      reasons: [...new Set(reasons)],
      jobs: statusJobs,
    };
  }

  function computeStatus(parentID, waveID) {
    return runOperation((operation) => computeStatusOwned(parentID, waveID, operation));
  }

  async function status(input, tool) {
    return response(await computeStatus(tool.sessionID, input.wave_id));
  }

  function execute(input, tool) {
    try {
      if (disposed) throw new Error("worktree runtime is disposed");
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("unsupported tool input");
      const allowed = input.action === "recover" ? ["action"]
        : input.action === "status" ? ["action", "wave_id"]
        : input.action === "seal" ? ["action", "wave_id", "jobs"]
        : input.action === "start" ? ["action", "wave_id", "directory", "manifest_path", "manifest_agent_id", "prompt", "agent", "provider", "model", "reasoning_effort", "title", "timeout_seconds"]
        : [];
      if (!allowed.length || Object.keys(input).some((key) => !allowed.includes(key))) throw new Error("unsupported action or additional input property");
      if (input.action === "start") return runOperation((operation) => start(input, tool, operation));
      if (input.action === "seal") return seal(input, tool);
      if (input.action === "status") return status(input, tool);
      if (input.action === "recover") return runOperation((operation) => recoverParent(tool.sessionID, operation));
      throw new Error(`unsupported action: ${input.action}`);
    } catch (error) {
      const rejected = Promise.reject(error);
      rejected.catch(() => {});
      return rejected;
    }
  }

  async function scanWaves(prefix, onWave) {
    let after;
    const found = [];
    do {
      const page = await ctx.storage.scan({ prefix, limit: 100, ...(after ? { after } : {}) });
      if (disposed) return found;
      for (const entry of page.entries) {
        if (disposed) return found;
        const wave = entry.value;
        if (!wave?.jobs) continue;
        found.push(wave);
        await onWave?.(wave);
      }
      after = page.next;
    } while (after);
    return found;
  }

  async function recoverParent(parentID, operation) {
    const waves = await scanWaves(`wave/${parentID}/`);
    assertActiveOperation(operation);
    for (const wave of waves.filter((item) => item.parent_session_id === parentID &&
      supportedVersion(ctx.app.version) && validWaveShape(item, parentID, item.wave_id))) {
      const key = waveKey(parentID, wave.wave_id);
      for (const job of Object.values(wave.jobs || {}).sort((left, right) => left.session_id.localeCompare(right.session_id))) {
        if (job.status === "running") await claimObserver(parentID, wave.wave_id, job.session_id, true);
        assertActiveOperation(operation);
      }
      if (legacyRetryNotification(wave.notification) && !Object.values(wave.jobs).some((job) => job.status === "running")) {
        waveOwners.set(key, owner);
        scheduleNotification(parentID, wave.wave_id, wave.notification.attempts);
      }
    }
    const latest = await scanWaves(`wave/${parentID}/`);
    assertActiveOperation(operation);
    return response({
      parent_session_id: parentID,
      waves: latest
        .filter((wave) => wave.parent_session_id === parentID)
        .map((wave) => {
          const valid = validWaveShape(wave, parentID, wave.wave_id);
          const durableJobs = Object.values(isPlainRecord(wave.jobs) ? wave.jobs : {});
          const legacyJobs = wave.version === undefined ? durableJobs.map(legacyRecoverJobProjection) : [];
          const validLegacy = wave.version === undefined && legacyJobs.every(Boolean);
          return {
            wave_id: typeof wave.wave_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(wave.wave_id) ? wave.wave_id : "",
            sealed: (valid || validLegacy) && wave.sealed === true,
            notification_state: valid && ["sending", "sent", "retrying"].includes(wave.notification?.state) ? wave.notification.state : "pending",
            jobs: valid ? durableJobs.map(recoverJobProjection)
              : validLegacy ? legacyJobs
                : durableJobs.map(failedSafeJobProjection),
          };
        }),
    });
  }

  async function recover() {
    await scanWaves("wave/", async (wave) => {
        if (disposed || !supportedVersion(ctx.app.version) || !wave.parent_session_id || !wave.wave_id ||
            !validWaveShape(wave, wave.parent_session_id, wave.wave_id)) return;
        const key = waveKey(wave.parent_session_id, wave.wave_id);
        for (const job of Object.values(wave.jobs || {}).sort((left, right) => left.session_id.localeCompare(right.session_id))) {
          if (job.status === "running") await claimObserver(wave.parent_session_id, wave.wave_id, job.session_id, false);
        }
        const hasLegacyCandidate = wave.version === STATE_VERSION && Object.values(wave.jobs || {}).some(legacyTransportCandidate);
        if (!Object.values(wave.jobs || {}).some((job) => job.status === "running")) waveOwners.set(key, owner);
        if (activeForWave(key) && !hasLegacyCandidate) {
          if (legacyRetryNotification(wave.notification)) scheduleNotification(wave.parent_session_id, wave.wave_id, wave.notification.attempts);
          else track(maybeNotify(wave.parent_session_id, wave.wave_id));
        }
    });
  }

  return {
    execute,
    computeStatus,
    recover,
    startSetupRecovery() {
      if (!disposed) track(recover());
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      for (const operation of operations) {
        operation.revoked = true;
        for (const controller of operation.controllers) controller.abort();
      }
      for (const [key, slot] of observers) {
        if (slot.owner !== owner) continue;
        observers.delete(key);
        slot.revoked = true;
        for (const controller of slot.controllers || []) controller.abort();
      }
      for (const [key, slot] of notificationTimers) {
        if (slot.owner !== owner) continue;
        notificationTimers.delete(key);
        cancelSchedule(slot.handle);
      }
      for (const [key, slot] of reobserveTimers) {
        if (slot.owner !== owner || reobserveTimers.get(key) !== slot) continue;
        reobserveTimers.delete(key);
        cancelSchedule(slot.handle);
      }
      for (const [key, currentOwner] of waveOwners) if (currentOwner === owner) waveOwners.delete(key);
      const snapshot = [...tasks];
      disposePromise = new Promise((resolve) => {
        let handle;
        const done = () => { cancelBound(handle); resolve(); };
        Promise.allSettled(snapshot).then(done);
        handle = boundSchedule(resolve, cleanupBoundMs);
        handle?.unref?.();
      });
      return disposePromise;
    },
    observers: {
      has(key) { return observers.get(key)?.owner === owner; },
      get(key) { const slot = observers.get(key); return slot?.owner === owner ? slot : undefined; },
    },
  };
}

export async function setupWorktreePlugin(ctx, dependencies) {
  const runtime = createRuntime(ctx, dependencies);
  let toolRegistration;
  let rpcRegistration;
  let cleanupPromise;

  const cleanup = () => {
    cleanupPromise ||= (async () => {
      const errors = [];
      const runtimeCleanup = runtime.dispose();
      if (rpcRegistration) {
        const registration = rpcRegistration;
        rpcRegistration = undefined;
        try { await registration.dispose(); } catch (error) { errors.push(error); }
      }
      if (toolRegistration) {
        const registration = toolRegistration;
        toolRegistration = undefined;
        try { await registration.dispose(); } catch (error) { errors.push(error); }
      }
      try { await runtimeCleanup; } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "GSD worktree task plugin cleanup failed");
    })();
    return cleanupPromise;
  };

  try {
    toolRegistration = await ctx.tool.transform((editor) => {
      editor.add({
        name: TOOL_NAME,
        description: "Start, seal, recover, and inspect durable GSD execution waves in existing linked worktrees. Recover is parent-scoped; status is the merge gate.",
        input: INPUT_SCHEMA,
        options: { codemode: true },
        execute: runtime.execute,
      });
    });
    rpcRegistration = await ctx.rpc.register(ATTESTATION_RPC, {
      async status(input, context) {
        assertAttestationRPCInput(input);
        try {
          return await runtime.computeStatus(input.parent_session_id, input.wave_id);
        } catch (error) {
          if (error instanceof Error && error.message === "unknown wave") {
            return context.error("unknown_wave", "unknown wave", {
              parent_session_id: input.parent_session_id,
              wave_id: input.wave_id,
            });
          }
          throw error;
        }
      },
    });
    runtime.startSetupRecovery();
    return cleanup;
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "GSD worktree task plugin setup failed and cleanup was incomplete");
    }
    throw error;
  }
}

// Retain the original named seam for focused worktree transport tests.
export const setupPlugin = setupWorktreePlugin;

// Keep the dependency-injection seam available only through the named export
// used by unit tests. OpenCode receives this one-argument adapter, so a future
// host options argument (or any value derived from environment/configuration)
// cannot replace the trusted Service/OpenCode production path.
const plugin = { id: PLUGIN_ID, setup: (ctx) => setupWorktreePlugin(ctx) };
export default plugin;

export const _internals = {
  extractResult,
  notificationID,
  injectionBlockingPolicy,
  scanPromptInjection,
  findingSeverity,
  HIGH_CONFIDENCE_FINDING_THRESHOLD,
  MAX_PROMPT_LENGTH,
  resolveWorktreeDirectory,
  resolveManifestPath,
  readManifestBinding,
  verifyManifestBinding,
  sessionAttestationReasons,
  sameJobs,
  waveKey,
  ATTESTATION_RPC,
};
