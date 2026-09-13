import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { findingSeverity, HIGH_CONFIDENCE_FINDING_THRESHOLD, scanPromptInjection } from "./injection-scanner.mjs";
import { assertAttestationRPCInput, ATTESTATION_RPC } from "./attestation-rpc.mjs";

const PLUGIN_ID = "gsd-core";
const TOOL_NAME = "gsd_worktree_task";
const STATE_VERSION = 1;
const DEFAULT_TIMEOUT_SECONDS = 3600;
const MAX_JOBS = 5;
const MAX_IMPORT_ATTEMPTS = 3;
const MAX_ADMISSION_CHECKS = 3;
const MAX_TERMINAL_WRITE_ATTEMPTS = 3;
const MAX_TERMINAL_WRITE_BACKOFF_MS = 1_000;
const MAX_NOTIFICATION_BACKOFF_MS = 30_000;
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
  return error?.status === 409 ||
    error?.response?.status === 409 ||
    error?.cause?.status === 409 ||
    error?._tag === "ConflictError" ||
    error?.data?._tag === "ConflictError";
}

function isNotFound(error) {
  return error?.status === 404 ||
    error?.response?.status === 404 ||
    error?.cause?.status === 404 ||
    /NotFoundError$/.test(error?._tag || error?.data?._tag || "");
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
    status: info.outcome || "failed",
    text,
    ...(error ? { error } : {}),
  };
}

function response(value) {
  return { content: JSON.stringify(value), metadata: { plugin: PLUGIN_ID } };
}

function sameJobs(left, right) {
  if (left.length !== right.length) return false;
  const normalize = (items) => items.map((item) => `${item.session_id}\0${item.directory}`).sort();
  return normalize(left).every((item, index) => item === normalize(right)[index]);
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
  const sleep = dependencies.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const shared = globalThis[PROCESS_STATE] ||= {
    observers: new Map(),
    notificationTimers: new Map(),
    reobserveTimers: new Map(),
    locks: new Map(),
  };
  shared.notificationTimers ||= new Map();
  shared.reobserveTimers ||= new Map();
  const { observers, notificationTimers, reobserveTimers, locks } = shared;
  const owner = Symbol("gsd-worktree-task-runtime");
  let disposed = false;

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

  async function clientForImport() {
    const endpoint = await service.discover({ version: ctx.app.version });
    if (!endpoint) {
      throw new Error("the current process is not a discoverable managed OpenCode service; refusing standalone or explicit-server import");
    }
    const client = makeClient(endpoint);
    const health = await client.health.get();
    if (health?.healthy !== true || health.pid !== process.pid || health.version !== ctx.app.version) {
      throw new Error("discovered OpenCode service identity does not match this plugin host process and version");
    }
    return client;
  }

  async function cleanupMintedChild(client, sessionID) {
    await client.session.interrupt({ sessionID, continue: false }).catch(() => {});
    let removalClient = client;
    if (typeof removalClient.session.remove !== "function") {
      const endpoint = await service.discover({ version: ctx.app.version });
      if (!endpoint) throw new Error("cannot verify the managed service for child cleanup");
      removalClient = makeClient(endpoint);
      const health = await removalClient.health.get();
      if (health?.healthy !== true || health.pid !== process.pid || health.version !== ctx.app.version) {
        throw new Error("refusing child cleanup through an unverified service");
      }
    }
    try {
      await removalClient.session.remove({ sessionID });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async function assertInventory(directory) {
    const inventory = await ctx.worktree.list();
    const found = inventory.some((item) => {
      try { return canonical(item.directory) === directory; } catch { return false; }
    });
    if (!found) throw new Error("directory is absent from the OpenCode worktree inventory");
  }

  async function assertTarget(client, directory, agent) {
    const location = { directory };
    await client.plugin.awaitActivation?.({ location });
    const pluginsResult = await client.plugin.list({ location });
    const plugins = Array.isArray(pluginsResult) ? pluginsResult : pluginsResult.data;
    if (!pluginIsActive(plugins || [])) {
      throw new Error(`plugin "${PLUGIN_ID}" is not active in the target worktree`);
    }
    const agentsResult = await client.agent.list({ location });
    const agents = Array.isArray(agentsResult) ? agentsResult : agentsResult.data;
    if (!(agents || []).some((item) => item?.id === agent || item?.name === agent)) {
      throw new Error(`agent "${agent}" is unavailable in the target worktree`);
    }
  }

  async function updateJob(parentID, waveID, sessionID, update) {
    const key = waveKey(parentID, waveID);
    let lastError;
    for (let attempt = 0; attempt < MAX_TERMINAL_WRITE_ATTEMPTS; attempt += 1) {
      try {
        await withWaveLock(key, async () => {
          const wave = await ctx.storage.get(key);
          if (!wave?.jobs?.[sessionID] || TERMINAL.has(wave.jobs[sessionID].status)) return;
          wave.jobs[sessionID] = { ...wave.jobs[sessionID], ...update, finished_at: now() };
          await ctx.storage.set(key, wave);
        });
        void maybeNotify(parentID, waveID).catch(() => {});
        return;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < MAX_TERMINAL_WRITE_ATTEMPTS) {
          await sleep(Math.min(25 * (2 ** attempt), MAX_TERMINAL_WRITE_BACKOFF_MS));
        }
      }
    }
    const error = new Error(`terminal job update could not be stored: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    error.terminalWriteFailure = true;
    throw error;
  }

  function scheduleReobserve(parentID, waveID, job) {
    if (disposed) return;
    const observerKey = `${parentID}\0${waveID}\0${job.session_id}`;
    if (observers.get(observerKey)?.owner !== owner) return;
    const previous = reobserveTimers.get(observerKey);
    if (previous?.owner === owner) return;
    const slot = { owner, handle: undefined };
    try {
      slot.handle = schedule(() => {
        if (reobserveTimers.get(observerKey) !== slot) return;
        reobserveTimers.delete(observerKey);
        if (!disposed) observe(parentID, waveID, job);
      }, 100);
    } catch {
      return;
    }
    slot.handle?.unref?.();
    reobserveTimers.set(observerKey, slot);
    if (previous && reobserveTimers.get(observerKey) === slot) clearTimeout(previous.handle);
  }

  function observe(parentID, waveID, job, suppliedClient) {
    const observerKey = `${parentID}\0${waveID}\0${job.session_id}`;
    if (disposed || TERMINAL.has(job.status)) return;
    const controller = new AbortController();
    const slot = { controller, owner, promise: undefined };
    const previous = observers.get(observerKey);
    if (previous?.owner === owner) return;
    observers.set(observerKey, slot);
    previous?.controller.abort();
    const retry = reobserveTimers.get(observerKey);
    if (retry && retry.owner !== owner && reobserveTimers.get(observerKey) === retry) {
      reobserveTimers.delete(observerKey);
      clearTimeout(retry.handle);
    }
    slot.promise = (async () => {
      let client = suppliedClient;
      let timer;
      try {
        client ||= await clientForImport();
        const remaining = job.deadline - now();
        if (remaining <= 0) {
          await client.session.interrupt({ sessionID: job.session_id, continue: false }).catch(() => {});
          await updateJob(parentID, waveID, job.session_id, { status: "timeout", error: "child session exceeded its deadline" });
          return;
        }
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve("timeout"), remaining);
          timer.unref?.();
        });
        let info;
        let messages;
        for (let admissionCheck = 0; admissionCheck < MAX_ADMISSION_CHECKS; admissionCheck += 1) {
          const waited = client.session.wait(
            { sessionID: job.session_id },
            { signal: controller.signal },
          ).then(() => "terminal");
          const result = await Promise.race([waited, timeout]);
          if (result === "timeout") {
            controller.abort();
            await client.session.interrupt({ sessionID: job.session_id, continue: false }).catch(() => {});
            await updateJob(parentID, waveID, job.session_id, { status: "timeout", error: "child session exceeded its deadline" });
            return;
          }
          [info, messages] = await Promise.all([
            client.session.get({ sessionID: job.session_id }),
            client.session.context({ sessionID: job.session_id }),
          ]);
          if (info.outcome) break;
          if (job.status !== "running") break;
          const [inbox, active] = await Promise.all([
            client.session.inbox?.list?.({ sessionID: job.session_id }).catch(() => []),
            client.session.active?.().catch(() => ({})),
          ]);
          if (admissionCheck > 0 && !(inbox?.length || active?.[job.session_id])) break;
          await Promise.resolve();
        }
        clearTimeout(timer);
        const resultInfo = extractResult(info, messages);
        await updateJob(parentID, waveID, job.session_id, resultInfo);
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        if (error?.terminalWriteFailure) {
          scheduleReobserve(parentID, waveID, job);
          return;
        }
        await updateJob(parentID, waveID, job.session_id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => scheduleReobserve(parentID, waveID, job));
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      if (observers.get(observerKey) === slot) observers.delete(observerKey);
    });
  }

  function scheduleNotification(parentID, waveID, attempt) {
    const timerKey = `${parentID}\0${waveID}`;
    if (disposed) return;
    const previous = notificationTimers.get(timerKey);
    if (previous?.owner === owner) return;
    const delay = Math.min(250 * (2 ** Math.min(attempt, 7)), MAX_NOTIFICATION_BACKOFF_MS);
    const slot = { owner, handle: undefined };
    try {
      slot.handle = schedule(() => {
        if (notificationTimers.get(timerKey) !== slot) return;
        notificationTimers.delete(timerKey);
        void maybeNotify(parentID, waveID).catch(() => {});
      }, delay);
    } catch {
      return;
    }
    slot.handle?.unref?.();
    notificationTimers.set(timerKey, slot);
    if (previous && notificationTimers.get(timerKey) === slot) clearTimeout(previous.handle);
  }

  async function maybeNotify(parentID, waveID) {
    const key = waveKey(parentID, waveID);
    let retryAttempt = 0;
    try {
      await withWaveLock(key, async () => {
        const wave = await ctx.storage.get(key);
        if (!wave?.sealed || wave.notification?.state === "sent") return;
        const expected = wave.expected_session_ids || [];
        if (!expected.length || !expected.every((id) => TERMINAL.has(wave.jobs?.[id]?.status))) return;
        const id = normalizedNotificationID(parentID, waveID, wave.notification);
        retryAttempt = (wave.notification?.attempts || 0) + 1;
        wave.notification = { id, state: "sending", attempts: retryAttempt, attempted_at: now() };
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
        await ctx.session.prompt({
          sessionID: parentID,
          id,
          text: content,
          delivery: "queue",
          metadata: { plugin: PLUGIN_ID, wave_id: waveID },
        });
        wave.notification = { id, state: "sent", attempts: retryAttempt, sent_at: now() };
        await ctx.storage.set(key, wave);
      });
    } catch (error) {
      if (error?.notificationIdentityMismatch) throw error;
      try {
        await withWaveLock(key, async () => {
          const wave = await ctx.storage.get(key);
          if (!wave || wave.notification?.state === "sent") return;
          retryAttempt = Math.max(retryAttempt, wave.notification?.attempts || 1);
          wave.notification = {
            id: normalizedNotificationID(parentID, waveID, wave.notification),
            state: "retrying",
            attempts: retryAttempt,
            last_error: error instanceof Error ? error.message : String(error),
            retry_at: now() + Math.min(250 * (2 ** Math.min(retryAttempt, 7)), MAX_NOTIFICATION_BACKOFF_MS),
          };
          await ctx.storage.set(key, wave);
        });
      } catch {
        // A durable "sending" record already carries the deterministic ID and is retryable on recovery.
      }
      scheduleNotification(parentID, waveID, retryAttempt);
    }
  }

  async function start(input, tool) {
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
    await assertInventory(directory);
    const client = await clientForImport();
    await assertTarget(client, directory, input.agent);
    const key = waveKey(parentID, input.wave_id);
    let job;
    await withWaveLock(key, async () => {
      let existing = await ctx.storage.get(key);
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
      const parent = await ctx.session.get({ sessionID: parentID });
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
        await ctx.storage.set(key, wave);
        existing = wave;
        const removeProvisional = async () => {
          delete wave.jobs[sessionID];
          await ctx.storage.set(key, wave);
        };
        const cleanupFailedAttempt = async (error) => {
          try {
            await cleanupMintedChild(client, sessionID);
            await removeProvisional();
          } catch (cleanupError) {
            job.status = "failed";
            job.error = error instanceof Error ? error.message : String(error);
            job.cleanup_error = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            job.finished_at = now();
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
          await client.session.import({ info, messages: [], location: { directory } });
        } catch (error) {
          if (isConflict(error)) {
            await removeProvisional();
            if (attempt < MAX_IMPORT_ATTEMPTS) continue;
            throw new Error(`session ID collision after ${MAX_IMPORT_ATTEMPTS} import attempts`, { cause: error });
          }
          await cleanupFailedAttempt(error);
          throw error;
        }
        try {
          const importedInfo = await client.session.get({ sessionID });
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
          await client.session.prompt({ sessionID, text: input.prompt, delivery: "queue" });
          job.status = "running";
          await ctx.storage.set(key, wave);
          break;
        } catch (error) {
          await cleanupFailedAttempt(error);
          throw error;
        }
      }
    });
    void observe(parentID, input.wave_id, job, client);
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
      if (!TERMINAL.has(job.status)) void observe(parentID, input.wave_id, job);
    }
    void maybeNotify(parentID, input.wave_id).catch(() => {});
    return response({ wave_id: input.wave_id, sealed: true, jobs: requested });
  }

  async function computeStatus(parentID, waveID) {
    const key = waveKey(parentID, waveID);
    const wave = await ctx.storage.get(key);
    if (!wave) throw new Error("unknown wave");
    const reasons = [];
    const expected = wave.expected_session_ids || [];
    const jobs = expected.length ? expected.map((id) => wave.jobs?.[id]).filter(Boolean) : Object.values(wave.jobs || {});
    const actualIDs = Object.keys(wave.jobs || {}).sort();
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
    try { client = await clientForImport(); } catch { reasons.push("same_service_unverified"); }
    let inventory = [];
    try { inventory = await ctx.worktree.list(); } catch { reasons.push("worktree_inventory_unavailable"); }
    const inventoryPaths = new Set(inventory.flatMap((item) => {
      try { return [canonical(item.directory)]; } catch { return []; }
    }));
    const statusJobs = [];
    for (const job of jobs) {
      if (job.status !== "succeeded") reasons.push(`${job.session_id}:status_${job.status}`);
      const manifestReason = verifyManifestBinding(root, job);
      if (manifestReason) reasons.push(`${job.session_id}:${manifestReason}`);
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
        reasons.push(`${job.session_id}:requested_executor_mismatch`);
      }
      let directory;
      try {
        directory = resolveWorktreeDirectory(root, job.directory);
        if (!inventoryPaths.has(directory)) reasons.push(`${job.session_id}:worktree_missing_from_inventory`);
      } catch {
        reasons.push(`${job.session_id}:worktree_missing`);
        continue;
      }
      let observedExecutor = null;
      if (client) {
        try {
          const info = await client.session.get({ sessionID: job.session_id });
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
          })) reasons.push(`${job.session_id}:${reason}`);
          if (info.outcome !== "succeeded") reasons.push(`${job.session_id}:outcome_${info.outcome || "missing"}`);
        } catch {
          reasons.push(`${job.session_id}:session_unverifiable`);
        }
      }
      statusJobs.push({
        session_id: job.session_id,
        directory: job.directory,
        status: job.status,
        agent: job.agent,
        model: job.model,
        manifest_path: job.manifest_path,
        manifest_agent_id: job.manifest_agent_id,
        manifest_entry: job.manifest_entry,
        manifest_entry_hash: job.manifest_entry_hash,
        ...(job.started_at !== undefined ? { started_at: job.started_at } : {}),
        ...(job.deadline !== undefined ? { deadline: job.deadline } : {}),
        ...(job.finished_at !== undefined ? { finished_at: job.finished_at } : {}),
        ...(job.text !== undefined ? { text: job.text } : {}),
        ...(job.error !== undefined ? { error: job.error } : {}),
        ...(job.cleanup_error !== undefined ? { cleanup_error: job.cleanup_error } : {}),
        requested_executor: requestedExecutor,
        observed_executor: observedExecutor,
      });
    }
    void maybeNotify(parentID, waveID).catch(() => {});
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

  async function status(input, tool) {
    return response(await computeStatus(tool.sessionID, input.wave_id));
  }

  async function execute(input, tool) {
    if (input.action === "start") return start(input, tool);
    if (input.action === "seal") return seal(input, tool);
    if (input.action === "status") return status(input, tool);
    if (input.action === "recover") return recoverParent(tool.sessionID);
    throw new Error(`unsupported action: ${input.action}`);
  }

  async function scanWaves(prefix, onWave) {
    let after;
    const found = [];
    do {
      const page = await ctx.storage.scan({ prefix, limit: 100, ...(after ? { after } : {}) });
      for (const entry of page.entries) {
        const wave = entry.value;
        if (!wave?.jobs) continue;
        found.push(wave);
        await onWave?.(wave);
      }
      after = page.next;
    } while (after);
    return found;
  }

  async function recoverParent(parentID) {
    const waves = await scanWaves(`wave/${parentID}/`, async (wave) => {
      if (wave.parent_session_id !== parentID) return;
      for (const job of Object.values(wave.jobs)) {
        if (!TERMINAL.has(job.status)) void observe(parentID, wave.wave_id, job);
      }
      void maybeNotify(parentID, wave.wave_id).catch(() => {});
    });
    return response({
      parent_session_id: parentID,
      waves: waves
        .filter((wave) => wave.parent_session_id === parentID)
        .map((wave) => ({
          wave_id: wave.wave_id,
          sealed: wave.sealed === true,
          notification_state: wave.notification?.state || "pending",
          jobs: Object.values(wave.jobs).map(({ session_id, directory, manifest_path, manifest_agent_id, manifest_entry_hash, status, text, error }) => ({
            session_id, directory, manifest_path, manifest_agent_id, manifest_entry_hash, status,
            ...(text ? { text } : {}), ...(error ? { error } : {}),
          })),
        })),
    });
  }

  async function recover() {
    await scanWaves("wave/", async (wave) => {
        for (const job of Object.values(wave.jobs || {})) {
          if (!TERMINAL.has(job.status)) void observe(wave.parent_session_id, wave.wave_id, job);
        }
        void maybeNotify(wave.parent_session_id, wave.wave_id).catch(() => {});
    });
  }

  return {
    execute,
    computeStatus,
    recover,
    dispose() {
      disposed = true;
      for (const [key, slot] of observers) {
        if (slot.owner !== owner) continue;
        observers.delete(key);
        slot.controller.abort();
      }
      for (const [key, slot] of notificationTimers) {
        if (slot.owner !== owner) continue;
        notificationTimers.delete(key);
        clearTimeout(slot.handle);
      }
      for (const [key, slot] of reobserveTimers) {
        if (slot.owner !== owner || reobserveTimers.get(key) !== slot) continue;
        reobserveTimers.delete(key);
        clearTimeout(slot.handle);
      }
    },
    observers,
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
      if (rpcRegistration) {
        const registration = rpcRegistration;
        rpcRegistration = undefined;
        try { await registration.dispose(); } catch (error) { errors.push(error); }
      }
      runtime.dispose();
      if (toolRegistration) {
        const registration = toolRegistration;
        toolRegistration = undefined;
        try { await registration.dispose(); } catch (error) { errors.push(error); }
      }
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
    await runtime.recover();
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
