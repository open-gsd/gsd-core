import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "gsd-core";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const CLEANUP_GRACE_MS = 250;
const BREADCRUMB_PREFIX = "[GSD] Active session:";

const TOOL_ALIASES = Object.freeze({
  read: "Read",
  grep: "Grep",
  write: "Write",
  edit: "Edit",
  patch: "MultiEdit",
  apply_patch: "MultiEdit",
  multi_edit: "MultiEdit",
  shell: "Bash",
  bash: "Bash",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  web_search: "WebSearch",
  subagent: "Task",
  task: "Task",
});

const MANDATORY_HOOKS = new Set([
  "gsd-prompt-guard.js",
  "gsd-worktree-path-guard.js",
  "gsd-write-guard.js",
  "gsd-workflow-guard.js",
  "gsd-secret-read-guard.js",
]);

function resolvePayloadRoot(packageDirectory) {
  let root = packageDirectory;
  for (;;) {
    if (["hooks", "gsd-core"].every((marker) => {
      const target = path.join(root, marker);
      return fs.existsSync(target) && fs.statSync(target).isDirectory();
    })) return root;
    const parent = path.dirname(root);
    if (parent === root) break;
    root = parent;
  }
  throw new Error(`[gsd-core] incomplete plugin payload above: ${packageDirectory}`);
}

const PACKAGE_DIRECTORY = typeof __dirname === "string"
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));

function mapToolName(tool) {
  if (typeof tool !== "string") return "";
  return TOOL_ALIASES[tool.toLowerCase()] || tool;
}

function firstDefined(object, keys) {
  if (!object || typeof object !== "object") return undefined;
  for (const key of keys) {
    if (object[key] !== undefined) return object[key];
  }
  return undefined;
}

const TARGET_ALIASES = Object.freeze(["file_path", "filePath", "path"]);

function normalizedEditedPath(value, source) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.includes("\0") || value.includes("\\") || /^[A-Za-z]:/.test(value)) {
    throw patchPathError(`${source} has no valid target path`);
  }
  // Direct V2 aliases retain an absolute spelling until linked-worktree
  // containment can resolve it against the freshly bound checkout. Patch
  // envelope paths use canonicalPatchPath and never take this branch.
  const target = value.startsWith("/") ? path.posix.normalize(value) : checkedEditedPath(value, source);
  // Use one spelling for comparison, hook payloads, and native V2 input. This
  // avoids accepting equivalent aliases while letting a later consumer choose
  // a different alias value. Forward slashes work on every supported Node
  // platform and retain spaces verbatim.
  return path.posix.normalize(target.replaceAll("\\", "/"));
}

function targetAliases(object, source, normalize = normalizedEditedPath) {
  if (!object || typeof object !== "object") return undefined;
  const values = TARGET_ALIASES
    .filter((key) => object[key] !== undefined)
    .map((key) => normalize(object[key], `${source}.${key}`));
  if (!values.length) return undefined;
  if (new Set(values).size !== 1) {
    throw patchPathError(`${source} supplies conflicting target aliases`);
  }
  return values[0];
}

function normalizeTargetAliases(object, source) {
  const target = targetAliases(object, source);
  if (target === undefined) return undefined;
  // The native V2 call receives this same canonical field after the pre-hook;
  // do not leave another accepted alias behind for it to prefer.
  for (const key of TARGET_ALIASES) delete object[key];
  object.file_path = target;
  return target;
}

function mapToolInput(input) {
  if (!input || typeof input !== "object") return {};
  const mapped = {};
  const filePath = targetAliases(input, "tool input", (value, source) => {
    if (typeof value !== "string" || !value || value.includes("\0")) throw patchPathError(`${source} has no valid target path`);
    return value;
  });
  if (filePath !== undefined) mapped.file_path = filePath;
  const content = firstDefined(input, ["content", "text"]);
  if (content !== undefined) mapped.content = content;
  const oldString = firstDefined(input, ["old_string", "oldString"]);
  if (oldString !== undefined) mapped.old_string = oldString;
  const newString = firstDefined(input, ["new_string", "newString"]);
  if (newString !== undefined) mapped.new_string = newString;
  const command = firstDefined(input, ["command", "cmd"]);
  if (command !== undefined) mapped.command = command;
  const glob = firstDefined(input, ["glob", "include"]);
  if (glob !== undefined) mapped.glob = glob;
  const url = firstDefined(input, ["url"]);
  if (url !== undefined) mapped.url = url;
  const query = firstDefined(input, ["query"]);
  if (query !== undefined) mapped.query = query;
  if (input.is_subagent !== undefined) mapped.is_subagent = input.is_subagent;
  return mapped;
}

function patchPathError(detail) {
  return new Error(`[gsd-core] MultiEdit path extraction failed: ${detail}`);
}

// Patch paths are deliberately a much smaller language than Node paths.  The
// apply-patch protocol is POSIX-shaped even on Windows; accepting a platform
// spelling here would make the pre-hook and native executor disagree.
export function canonicalPatchPath(value, source = "target") {
  if (typeof value !== "string" || !value || value !== value.trim() || value.includes("\0") || value.includes("\\")) {
    throw patchPathError(`${source} has no valid target path`);
  }
  if (value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:/.test(value)) {
    throw patchPathError(`${source} target is not a relative POSIX path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw patchPathError(`${source} target is not canonical`);
  }
  return value;
}

function checkedEditedPath(value, source) {
  return canonicalPatchPath(value, source);
}

// Only column-zero directives are structural.  The parser must not interpret
// additions/removals which happen to contain a directive-looking string.
export function classifyPatchLine(line) {
  if (line === "*** Begin Patch") return { kind: "begin" };
  if (line === "*** End Patch") return { kind: "end" };
  const primary = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
  if (primary) return { kind: "primary", operation: primary[1], path: primary[2] };
  const move = /^\*\*\* Move to: (.+)$/.exec(line);
  if (move) return { kind: "move", path: move[1] };
  if (line.startsWith("*** ")) return { kind: "unknown" };
  return { kind: "body" };
}

// OpenCode's patch tool accepts the documented apply-patch envelope.  The
// worktree hook predates that tool and accepts exactly one `file_path`, so the
// adapter must recover every file directive before dispatching the hook.  Do
// not guess: an unrecognised or empty directive would otherwise turn a
// multi-file edit into an unguarded allow.
export function extractPatchTargets(patchText) {
  if (typeof patchText !== "string" || !patchText || patchText.includes("\r") && !patchText.includes("\r\n")) {
    throw patchPathError("patchText must be a non-empty LF or CRLF string");
  }
  const normalized = patchText.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) throw patchPathError("patchText contains a lone carriage return");
  const lines = normalized.split("\n");
  // A terminal newline is protocol whitespace, not body content.
  if (lines.at(-1) === "") lines.pop();
  const targets = [];
  const seen = new Set();
  const add = (raw, directive) => {
    const target = canonicalPatchPath(raw, directive);
    if (seen.has(target)) throw patchPathError("duplicate target directive");
    seen.add(target);
    targets.push(target);
  };
  let sawBegin = false;
  let sawEnd = false;
  let block;
  const finishBlock = () => {
    if (!block) return;
    if (!block.primary) throw patchPathError("block has no primary file directive");
    if (block.primary === "Add" && block.body.some((line) => !line.startsWith("+"))) {
      throw patchPathError("Add File body may contain only + lines");
    }
    if (block.primary === "Delete" && block.body.length) throw patchPathError("Delete File has a body");
    if (block.primary === "Update" && (!block.hasUpdateChunk || !block.updateChunkHasLines)) {
      throw patchPathError("Update File has an empty hunk");
    }
    block = undefined;
  };
  for (const line of lines) {
    const directive = classifyPatchLine(line);
    if (directive.kind === "begin") {
      if (sawBegin || sawEnd || block) throw patchPathError("invalid patch envelope");
      sawBegin = true;
      continue;
    }
    if (directive.kind === "end") {
      if (!sawBegin || sawEnd) throw patchPathError("invalid patch envelope");
      finishBlock();
      sawEnd = true;
      continue;
    }
    if (!sawBegin || sawEnd) {
      throw patchPathError("unexpected content outside patch envelope");
    }
    if (directive.kind === "primary") {
      finishBlock();
      block = {
        primary: directive.operation,
        moved: false,
        canMove: directive.operation === "Update",
        body: [],
        hasUpdateChunk: false,
        updateChunkHasLines: false,
        afterEndOfFile: false,
      };
      add(directive.path, `${directive.operation} File`);
      continue;
    }
    if (directive.kind === "move") {
      if (!block || block.primary !== "Update" || block.moved || !block.canMove) {
        throw patchPathError("Move to must appear once immediately after an Update File directive");
      }
      block.moved = true;
      block.canMove = false;
      add(directive.path, "Move to");
      continue;
    }
    if (!block) throw patchPathError("patch body outside a file block");
    if (directive.kind === "unknown" && !(block.primary === "Update" && line === "*** End of File")) {
      throw patchPathError("malformed file directive");
    }
    if (block.primary === "Add" && !line.startsWith("+")) throw patchPathError("Add File body may contain only + lines");
    if (block.primary === "Update") {
      const isHunkHeader = line === "@@" || line.startsWith("@@ ");
      if (block.afterEndOfFile) {
        if (line === "") {
          block.body.push(line);
          continue;
        }
        if (!isHunkHeader) throw patchPathError("Update File has malformed hunk body");
        block.afterEndOfFile = false;
      }
      if (line === "*** End of File") {
        if (block.hasUpdateChunk) {
          if (!block.updateChunkHasLines) throw patchPathError("Update File has an empty hunk");
          block.afterEndOfFile = true;
        }
        // Native parsing permits End of File marker(s) between an Update
        // header and its optional Move to directive. They do not form a hunk.
        block.body.push(line);
        continue;
      }
      if (isHunkHeader) {
        if (block.hasUpdateChunk && !block.updateChunkHasLines) throw patchPathError("Update File has an empty hunk");
        block.hasUpdateChunk = true;
        block.updateChunkHasLines = false;
        block.canMove = false;
        block.body.push(line);
        continue;
      }
      if (line !== "" && !/^[ +\-]/.test(line)) throw patchPathError("Update File has malformed hunk body");
      if (!block.hasUpdateChunk) block.hasUpdateChunk = true;
      block.updateChunkHasLines = true;
      block.canMove = false;
    } else if (block) {
      block.canMove = false;
    }
    block.body.push(line);
  }
  if (!sawBegin || !sawEnd) throw patchPathError("expected a complete apply-patch envelope");
  if (!targets.length) throw patchPathError("patch contains no file directives");
  return targets;
}

const extractPatchPaths = extractPatchTargets;

export function selectMultiEditRepresentation(input, direct) {
  const hasEdits = input && typeof input === "object" && Object.hasOwn(input, "edits");
  const hasPatchText = input && typeof input === "object" && Object.hasOwn(input, "patchText");
  const count = Number(hasEdits) + Number(direct !== undefined) + Number(hasPatchText);
  if (count !== 1) throw patchPathError("MultiEdit requires exactly one target representation");
  return hasEdits ? "edits" : direct !== undefined ? "direct" : "patchText";
}

function editedPaths(input, claudeTool, toolInput) {
  if (claudeTool !== "MultiEdit") {
    return typeof toolInput.file_path === "string" && toolInput.file_path ? [toolInput.file_path] : [];
  }
  const direct = typeof toolInput.file_path === "string" && toolInput.file_path
    ? normalizedEditedPath(toolInput.file_path, "file_path")
    : undefined;
  // Some MultiEdit producers use one object per replacement rather than the
  // patch envelope.  Each object must carry its own path; if it does not, the
  // sole outer path is acceptable only when it unambiguously names the entire
  // batch.  Mixed named/unnamed edits fail closed.
  const representation = selectMultiEditRepresentation(input, direct);
  if (representation === "edits") {
    if (!Array.isArray(input.edits)) throw patchPathError("edits is not an array");
    if (!input.edits.length) throw patchPathError("edits contains no targets");
    const nested = input.edits.map((edit, index) => {
      if (!edit || typeof edit !== "object") throw patchPathError(`edits[${index}] is not an edit object`);
      return normalizeTargetAliases(edit, `edits[${index}]`);
    });
    if (nested.some((value) => value === undefined)) throw patchPathError("each multi-edit target must be explicit");
    // V2's object-array form has no reviewed multi-file execution contract.
    // Permit repeated replacements for one canonical target only; callers that
    // need a multi-file operation must use the fully parsed patch envelope.
    if (new Set(nested).size !== 1) throw patchPathError("edits contains conflicting targets");
    return [nested[0]];
  }
  if (direct) return [direct];
  // `patch` is the built-in OpenCode multi-file surface.  It has patchText,
  // rather than a path; all targets must be checked, in document order.
  if (representation === "patchText") {
    return extractPatchPaths(input.patchText);
  }
  throw patchPathError("MultiEdit requires file_path or patchText");
}

function safeGsdCorePath(gsdCoreDirectory, suffix) {
  const raw = String(suffix).replaceAll("\\", "/");
  const normalized = path.posix.normalize(raw);
  if (raw.startsWith("/") || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new Error("[gsd-core] legacy GSD path escapes the managed gsd-core tree");
  }
  const rawSegments = raw.split("/");
  const segments = normalized.split("/");
  if (!segments.length || rawSegments.some((segment) => segment === "..") || segments.some((segment) => segment === ".." || segment === ".")) {
    throw new Error("[gsd-core] legacy GSD path contains an unsafe traversal segment");
  }
  const root = fs.realpathSync.native(gsdCoreDirectory);
  const candidate = path.resolve(root, ...segments);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("[gsd-core] legacy GSD path escapes the managed gsd-core tree");
  }
  return candidate;
}

function rewriteReadPath(input, gsdCoreDirectory) {
  if (!input || typeof input !== "object") return;
  for (const key of TARGET_ALIASES) {
    if (typeof input[key] !== "string") continue;
    const original = input[key];
    const marker = "/.claude/gsd-core/";
    let suffix;
    if (original.startsWith("~/.claude/gsd-core/")) {
      suffix = original.slice("~/.claude/gsd-core/".length);
    } else {
      const normalized = original.replaceAll("\\", "/");
      const index = normalized.indexOf(marker);
      if (index >= 0) suffix = normalized.slice(index + marker.length);
    }
    if (suffix !== undefined) input[key] = safeGsdCorePath(gsdCoreDirectory, suffix);
  }
}

function extractText(result) {
  if (!result || typeof result !== "object") return "";
  const chunks = [];
  if (typeof result.content === "string") chunks.push(result.content);
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (part?.type === "text" && typeof part.text === "string") chunks.push(part.text);
    }
  }
  if (typeof result.output === "string") chunks.push(result.output);
  return chunks.join("\n");
}

function transformText(result, transform) {
  if (!result || typeof result !== "object") return;
  if (typeof result.content === "string") result.content = transform(result.content);
  if (Array.isArray(result.content)) {
    result.content = result.content.map((part) =>
      part?.type === "text" && typeof part.text === "string"
        ? { ...part, text: transform(part.text) }
        : part,
    );
  }
  if (typeof result.output === "string") result.output = transform(result.output);
}

function appendAdvisories(result, advisories) {
  const values = advisories.filter((value) => typeof value === "string" && value.length > 0);
  if (!values.length || !result || typeof result !== "object") return;
  const text = values.join("\n");
  if (typeof result.content === "string") {
    result.content = result.content ? `${result.content}\n${text}` : text;
  } else if (Array.isArray(result.content)) {
    result.content = [...result.content, { type: "text", text }];
  } else {
    result.content = [{ type: "text", text }];
  }
  result.metadata ||= {};
  const existing = result.metadata._gsdAdvisory;
  result.metadata._gsdAdvisory = [
    ...(Array.isArray(existing) ? existing : typeof existing === "string" ? [existing] : []),
    ...values,
  ];
}

function advisoryFrom(parsed) {
  const value = parsed?.hookSpecificOutput?.additionalContext;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isHookEnvelope(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && (typeof value.decision === "string" || (value.hookSpecificOutput && typeof value.hookSpecificOutput === "object"));
}

function parseHookStdout(stdout) {
  const text = typeof stdout === "string" ? stdout.trim() : "";
  if (!text) return { parsed: undefined };
  try {
    const parsed = JSON.parse(text);
    return { parsed: isHookEnvelope(parsed) ? parsed : undefined };
  } catch {
    // Hook helpers can write progress/log prefixes before their protocol
    // envelope, and some hooks use one JSON envelope per line. Keep the last
    // valid object: it is the terminal hook decision. Non-JSON log lines are
    // not protocol failures.
    let parsed;
    let malformedEnvelope = false;
    for (const line of text.split(/\r?\n/)) {
      const prefix = line.indexOf("{");
      if (prefix < 0) continue;
      const candidate = line.slice(prefix).trim();
      // Only a terminal object which starts like the documented hook envelope
      // is protocol. Braces in ordinary progress logs are not a malformed
      // hook response.
      const envelopeLike = /^\{\s*"(?:decision|hookSpecificOutput)"\s*:/.test(candidate);
      try {
        const value = JSON.parse(candidate);
        if (isHookEnvelope(value)) parsed = value;
      } catch {
        if (envelopeLike) malformedEnvelope = true;
      }
    }
    return parsed ? { parsed } : malformedEnvelope ? { failure: "malformed-stdout" } : { parsed: undefined };
  }
}

function parseHookResult(raw) {
  // A killed/failed child did not deliver a trustworthy hook decision, even
  // when its platform happens to report an incidental numeric exit code.
  if (raw.failure) return { kind: "infrastructure", failure: raw.failure };
  if (raw.signal) return { kind: "infrastructure", failure: `signal:${raw.signal}` };
  const decoded = parseHookStdout(raw.stdout);
  const parsed = decoded.parsed;
  if (raw.exitCode === 2) {
    return {
      kind: "block",
      reason: typeof parsed?.reason === "string"
        ? parsed.reason
        : "Blocked by GSD hook (malformed block response).",
    };
  }
  if (decoded.failure) return { kind: "infrastructure", failure: decoded.failure };
  if (parsed?.decision === "block") {
    return {
      kind: "block",
      reason: typeof parsed?.reason === "string"
        ? parsed.reason
        : "Blocked by GSD hook (no reason provided).",
    };
  }
  if (raw.exitCode !== 0) return { kind: "infrastructure", failure: `unexpected-nonzero:${raw.exitCode}` };
  return { kind: "allow", advisory: advisoryFrom(parsed) };
}

// The upstream scanner is advisory by default and blocks HIGH findings only
// after an explicit project-local opt-in. Keep policy resolution deliberately
// narrow here: absent, malformed, unreadable, or non-boolean configuration is
// advisory rather than an adapter-level denial.
export function injectionBlockingPolicy(cwd) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(cwd, ".planning", "config.json"), "utf8"));
    return config?.security?.injection_blocking === true;
  } catch {
    return false;
  }
}

function pendingKey(event) {
  return `${event.sessionID}\0${event.messageID}\0${event.id}`;
}

function canonical(value) {
  return fs.realpathSync.native(path.resolve(value));
}

export function createRuntime(ctx, dependencies = {}) {
  const payloadRoot = dependencies.payloadRoot || resolvePayloadRoot(PACKAGE_DIRECTORY);
  const hooksDirectory = path.join(payloadRoot, "hooks");
  const gsdCoreDirectory = path.join(payloadRoot, "gsd-core");
  const spawn = dependencies.spawn || nodeSpawn;
  // The managed OpenCode service may run under Bun or another host executable;
  // legacy hooks are Node scripts and must resolve their CLI from PATH instead.
  // Tests or a deliberately configured host may narrowly override this command.
  const nodeCommand = dependencies.nodeCommand || "node";
  const timeoutMs = dependencies.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = dependencies.maxOutputBytes || MAX_OUTPUT_BYTES;
  const require = createRequire(path.join(PACKAGE_DIRECTORY, "index.cjs"));
  const ownedChildren = new Map();
  const settlements = new Set();
  const timers = new Set();
  const pending = new Map();
  const registrations = [];
  const eventController = new AbortController();
  let eventPump;
  let disposed = false;
  let generation = 0;
  let namespaceConverter;

  function warn(message) {
    if (!disposed) (dependencies.warn || console.error)(`[gsd-core] ${message}`);
  }

  function active(token) {
    return !disposed && token === generation && !eventController.signal.aborted;
  }

  function rewriteContent(content) {
    let output = content
      .replaceAll("@~/.claude/", `@${payloadRoot}/`)
      .replaceAll("~/.claude/gsd-core/", `${gsdCoreDirectory}/`);
    if (namespaceConverter === undefined) {
      try {
        const converter = require(path.join(payloadRoot, "scripts", "fix-slash-commands.cjs"));
        const names = converter.readCmdNames();
        namespaceConverter = (value) => converter.transformContentToHyphen(value, names);
      } catch {
        namespaceConverter = null;
      }
    }
    if (namespaceConverter) output = namespaceConverter(output);
    return output;
  }

  function isManagedFile(filePath) {
    if (typeof filePath !== "string") return false;
    const resolved = path.resolve(filePath);
    const directories = [
      path.join(gsdCoreDirectory, "workflows"),
      path.join(gsdCoreDirectory, "references"),
      path.join(gsdCoreDirectory, "templates"),
      path.join(gsdCoreDirectory, "contexts"),
      path.join(payloadRoot, "commands"),
      path.join(payloadRoot, "agents"),
      path.join(payloadRoot, "skills"),
    ];
    return directories.some((directory) => resolved === directory || resolved.startsWith(`${directory}${path.sep}`));
  }

  async function sessionBinding(sessionID, surface, mandatory, token) {
    if (!active(token)) return undefined;
    if (typeof sessionID !== "string" || !sessionID) {
      const message = `${surface}: missing or ambiguous V2 session binding`;
      if (mandatory) throw new Error(`[gsd-core] ${message}`);
      warn(`${message}; skipping advisory surface`);
      return undefined;
    }
    try {
      const info = await ctx.session.get({ sessionID });
      if (!active(token)) return undefined;
      if (info?.id !== sessionID || typeof info?.location?.directory !== "string") {
        throw new Error("session identity or location is absent");
      }
      return { sessionID, cwd: info.location.directory, info };
    } catch (error) {
      if (!active(token)) return undefined;
      const detail = error instanceof Error ? error.message : String(error);
      if (mandatory) throw new Error(`[gsd-core] ${surface}: session binding failed: ${detail}`, { cause: error });
      warn(`${surface}: session binding failed; skipping advisory surface: ${detail}`);
      return undefined;
    }
  }

  async function runHook(hookFile, payload, cwd, token) {
    if (!active(token)) return { stdout: "", stderr: "", exitCode: null, failure: "disposed" };
    const hookPath = path.join(hooksDirectory, hookFile);
    if (!fs.existsSync(hookPath)) {
      return { stdout: "", stderr: "", exitCode: null, failure: "missing" };
    }
    let settlement;
    settlement = new Promise((resolve) => {
      let child;
      let stdout = "";
      let stderr = "";
      let settled = false;
      let outputExceeded = false;
      let timedOut = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (child) ownedChildren.delete(child);
        resolve({ stdout, stderr, ...result });
      };

      try {
        if (!active(token)) {
          finish({ exitCode: null, failure: "disposed" });
          return;
        }
        child = spawn(nodeCommand, [hookPath], {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        ownedChildren.set(child, true);
      } catch (error) {
        finish({ exitCode: null, failure: `spawn-error:${error instanceof Error ? error.message : String(error)}` });
        return;
      }

      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!active(token)) return;
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
      timer.unref?.();
      timers.add(timer);

      const collect = (target) => (chunk) => {
        if (!active(token)) return;
        const value = chunk.toString("utf8");
        if (Buffer.byteLength(target === "stdout" ? stdout : stderr) + Buffer.byteLength(value) > maxOutputBytes) {
          outputExceeded = true;
          child.kill("SIGTERM");
          return;
        }
        if (target === "stdout") stdout += value;
        else stderr += value;
      };
      child.stdout.on("data", collect("stdout"));
      child.stderr.on("data", collect("stderr"));
      child.on("error", (error) => {
        clearTimeout(timer);
        timers.delete(timer);
        finish({ exitCode: null, failure: `spawn-error:${error.message}` });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        timers.delete(timer);
        if (timedOut) finish({ exitCode: code, signal, failure: "timeout" });
        else if (outputExceeded) finish({ exitCode: code, signal, failure: "spawn-error:output-limit" });
        else finish({ exitCode: code, signal });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(payload));
    });
    settlements.add(settlement);
    settlement.finally(() => settlements.delete(settlement)).catch(() => {});
    return settlement;
  }

  // Git inspection is adapter-owned: it shares the lifecycle accounting of
  // hooks, but never passes its outcome to a legacy hook.  Every result is
  // deliberately reduced to a small category before it reaches the caller.
  async function runGit(args, cwd, token) {
    if (!active(token)) return { failure: "disposed" };
    let settlement;
    settlement = new Promise((resolve) => {
      let child;
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (child) ownedChildren.delete(child);
        resolve({ stdout, stderr, ...result });
      };
      try {
        child = (dependencies.gitSpawn || dependencies.spawn || nodeSpawn)("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        ownedChildren.set(child, true);
        child.stdin?.end();
      } catch {
        finish({ failure: "spawn" });
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        timedOut = true;
        child.kill("SIGTERM");
      }, Math.max(timeoutMs, 500));
      timer.unref?.();
      timers.add(timer);
      const collect = (stream) => (chunk) => {
        const value = chunk.toString("utf8");
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(value) > maxOutputBytes) {
          child.kill("SIGTERM");
          return;
        }
        if (stream === "stdout") stdout += value;
        else stderr += value;
      };
      child.stdout.on("data", collect("stdout"));
      child.stderr.on("data", collect("stderr"));
      child.on("error", () => {
        clearTimeout(timer);
        timers.delete(timer);
        finish({ failure: "spawn" });
      });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        timers.delete(timer);
        finish(timedOut ? { exitCode, signal, failure: "timeout" } : { exitCode, signal });
      });
    });
    settlements.add(settlement);
    settlement.finally(() => settlements.delete(settlement)).catch(() => {});
    return settlement;
  }

  function containmentError(category) {
    return new Error(`[gsd-core] linked-worktree containment failed: ${category}`);
  }

  function isInside(candidate, root) {
    return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
  }

  async function checkoutContainment(cwd, token) {
    let realCwd;
    try {
      realCwd = fs.realpathSync.native(cwd);
    } catch {
      throw containmentError("cwd-unavailable");
    }
    const inside = await runGit(["rev-parse", "--is-inside-work-tree"], realCwd, token);
    if (inside.failure || inside.signal) throw containmentError(inside.failure || "git-signal");
    if (inside.exitCode === 128) return { active: false }; // git's documented non-repository result
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") throw containmentError("git-probe");
    const probe = await runGit([
      "rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir",
    ], realCwd, token);
    if (probe.failure || probe.signal || probe.exitCode !== 0) throw containmentError(probe.failure || "git-probe");
    const values = probe.stdout.trimEnd().split("\n");
    if (values.length !== 3 || values.some((value) => !value || value.includes("\0"))) throw containmentError("git-protocol");
    let topLevel;
    let gitDir;
    let commonDir;
    try {
      [topLevel, gitDir, commonDir] = values.map((value) => fs.realpathSync.native(value));
    } catch {
      throw containmentError("git-layout");
    }
    if (!path.isAbsolute(topLevel) || !path.isAbsolute(gitDir) || !path.isAbsolute(commonDir)) throw containmentError("git-layout");
    if (gitDir === commonDir) return { active: false };
    const worktrees = path.join(commonDir, "worktrees");
    if (!isInside(gitDir, worktrees)) throw containmentError("git-layout");
    return { active: true, cwd: realCwd, topLevel };
  }

  function canonicalTargetWithin(target, containment) {
    const lexical = path.resolve(containment.cwd, target);
    if (target.split(/[\\/]/).includes(".git")) throw containmentError("target-git-admin");
    let cursor = lexical;
    const suffix = [];
    while (!fs.existsSync(cursor)) {
      const parent = path.dirname(cursor);
      if (parent === cursor) throw containmentError("target-unresolvable");
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
    let canonicalExisting;
    try {
      canonicalExisting = fs.realpathSync.native(cursor);
    } catch {
      throw containmentError("target-unresolvable");
    }
    const canonicalTarget = path.join(canonicalExisting, ...suffix);
    if (!isInside(canonicalTarget, containment.topLevel)) throw containmentError("target-symlink-escape");
    // `realpath(cwd)` can use a canonical host spelling while an absolute V2
    // input uses an equivalent mount alias (notably /var -> /private/var on
    // macOS).  Preserve the lexical boundary: accept that spelling only when
    // an existing resolved prefix is a *strict ancestor* of the canonical
    // top-level and the remaining lexical suffix exactly names this target.
    // A symlink from an external directory directly into the worktree is not
    // such an ancestor and remains an external-origin alias.
    let lexicalInside = isInside(lexical, containment.topLevel);
    if (!lexicalInside && path.isAbsolute(target)) {
      const root = path.parse(lexical).root;
      let prefix = root;
      const parts = path.relative(root, lexical).split(path.sep).filter(Boolean);
      for (const part of parts) {
        prefix = path.join(prefix, part);
        if (!fs.existsSync(prefix)) continue;
        try {
          const resolvedPrefix = fs.realpathSync.native(prefix);
          if (!isInside(containment.topLevel, resolvedPrefix)) continue;
          const actualSuffix = path.relative(prefix, lexical);
          const expectedSuffix = path.join(
            path.relative(resolvedPrefix, containment.topLevel),
            path.relative(containment.topLevel, canonicalTarget),
          );
          if (actualSuffix === expectedSuffix) lexicalInside = true;
        } catch {
          // The canonical target check above already determines the safe
          // failure category; an unreadable prefix cannot prove this alias.
        }
      }
    }
    if (!lexicalInside) throw containmentError("target-outside-top-level");
    const relative = path.relative(containment.topLevel, canonicalTarget).split(path.sep).join("/");
    try {
      return canonicalPatchPath(relative, "contained target");
    } catch {
      throw containmentError("target-invalid");
    }
  }

  function rewriteVerifiedPatch(patchText, replacements) {
    const lines = patchText.replaceAll("\r\n", "\n").split("\n");
    return lines.map((line) => {
      const directive = classifyPatchLine(line);
      if (directive.kind === "primary") return `*** ${directive.operation} File: ${replacements.get(directive.path)}`;
      if (directive.kind === "move") return `*** Move to: ${replacements.get(directive.path)}`;
      return line;
    }).join("\n");
  }

  function normalizeContainedInput(input, claudeTool, targets, containment) {
    if (!containment.active) return targets;
    const replacements = new Map(targets.map((target) => [target, canonicalTargetWithin(target, containment)]));
    const safeTargets = targets.map((target) => replacements.get(target));
    if (claudeTool === "MultiEdit" && Object.hasOwn(input, "patchText")) {
      input.patchText = rewriteVerifiedPatch(input.patchText, replacements);
    } else if (claudeTool === "MultiEdit" && Array.isArray(input.edits)) {
      for (const edit of input.edits) edit.file_path = safeTargets[0];
    } else if (input && typeof input === "object") {
      input.file_path = safeTargets[0];
    }
    return safeTargets;
  }

  async function invoke(hookFile, payload, cwd, mandatory, advisories, token) {
    if (!active(token)) return false;
    const decision = parseHookResult(await runHook(hookFile, payload, cwd, token));
    if (!active(token)) return false;
    if (decision.kind === "block") throw new Error(decision.reason);
    if (decision.kind === "infrastructure") {
      const message = `${hookFile} infrastructure failure (${decision.failure})`;
      if (mandatory) throw new Error(`[gsd-core] ${message}`);
      warn(`${message}; advisory skipped`);
      return true;
    }
    if (decision.advisory) {
      warn(decision.advisory);
      advisories?.push(decision.advisory);
    }
    return true;
  }

  function contextWarningsDisabled(cwd) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(cwd, ".planning", "config.json"), "utf8"));
      return config.hooks?.context_warnings === false;
    } catch {
      return false;
    }
  }

  async function beforeTool(event) {
    const token = generation;
    if (!active(token)) return;
    const claudeTool = mapToolName(event.tool);
    const isWriteLike = ["Write", "Edit", "MultiEdit"].includes(claudeTool);
    const mandatory = isWriteLike || ["Read", "Grep", "Bash"].includes(claudeTool);
    // Reject a legacy path traversal before session lookup or any hook can
    // observe the call.
    if (claudeTool === "Read") rewriteReadPath(event.input, gsdCoreDirectory);
    const binding = await sessionBinding(event.sessionID, "tool.execute.before", mandatory, token);
    if (!binding) return;
    const key = pendingKey(event);
    const advisories = [];
    try {
      // The before hook may alter the native V2 input. Collapse accepted
      // aliases before the guarded payload is constructed so the subsequent
      // tool execution cannot select a different spelling/value.
      if (isWriteLike && event.input && typeof event.input === "object") {
        normalizeTargetAliases(event.input, "tool input");
      }
      let toolInput = mapToolInput(event.input);
      // Resolve a patch's complete target set before any hook runs.  A malformed
      // MultiEdit is rejected here rather than being passed to the single-path
      // legacy guard as an empty input.
      let targets = isWriteLike ? editedPaths(event.input, claudeTool, toolInput) : [];
      // A linked worktree has a second, adapter-owned containment boundary.
      // Determine the complete target set first; no legacy hook is allowed to
      // observe a partial patch or an unchecked path.
      if (isWriteLike) {
        const containment = await checkoutContainment(binding.cwd, token);
        targets = normalizeContainedInput(event.input, claudeTool, targets, containment);
        toolInput = mapToolInput(event.input);
      }
      const payload = (filePath) => ({
        hook_event_name: "PreToolUse",
        tool_name: claudeTool,
        tool_input: filePath === undefined ? toolInput : { ...toolInput, file_path: filePath },
        cwd: binding.cwd,
      });
      if (["Write", "Edit"].includes(claudeTool)) {
        if (!await invoke("gsd-prompt-guard.js", payload(), binding.cwd, true, advisories, token)) return;
        if (!await invoke("gsd-read-guard.js", payload(), binding.cwd, false, advisories, token)) return;
      }
      // gsd-worktree-path-guard accepts one file_path only.  Check every patch
      // directive in source order and immediately run its workflow policy.
      // Keeping the pair together prevents a later target from reaching any
      // mandatory guard before an earlier target's full policy has passed.
      if (isWriteLike) {
        for (const target of targets) {
          if (!await invoke("gsd-worktree-path-guard.js", payload(target), binding.cwd, true, advisories, token)) return;
          if (claudeTool === "MultiEdit" && !await invoke("gsd-workflow-guard.js", payload(target), binding.cwd, true, advisories, token)) return;
        }
      }
      if (claudeTool === "Write" && !await invoke("gsd-write-guard.js", payload(), binding.cwd, true, advisories, token)) return;
      if (isWriteLike || claudeTool === "Bash") {
        if (claudeTool !== "MultiEdit" && !await invoke("gsd-workflow-guard.js", payload(targets[0]), binding.cwd, true, advisories, token)) return;
      }
      if (["Read", "Grep", "Bash"].includes(claudeTool)) {
        if (!await invoke("gsd-secret-read-guard.js", payload(), binding.cwd, true, advisories, token)) return;
      }
      if (!active(token)) return;
      if (advisories.length) pending.set(key, advisories);
      else pending.delete(key);
    } catch (error) {
      pending.delete(key);
      throw error;
    }
  }

  async function afterTool(event) {
    const token = generation;
    if (!active(token)) return;
    const key = pendingKey(event);
    if (event.status === "error") {
      pending.delete(key);
      return;
    }
    const claudeTool = mapToolName(event.tool);
    const scanSurface = ["Read", "WebFetch", "WebSearch"].includes(claudeTool);
    const binding = await sessionBinding(event.sessionID, "tool.execute.after", false, token);
    if (!binding) {
      if (!active(token)) return;
      pending.delete(key);
      return;
    }
    const policy = scanSurface && injectionBlockingPolicy(binding.cwd);
    if (!active(token)) return;
    const advisories = pending.get(key) || [];
    pending.delete(key);
    const toolInput = mapToolInput(event.input);
    if (claudeTool === "Read" && isManagedFile(toolInput.file_path)) {
      transformText(event.result, rewriteContent);
    }
    if (scanSurface) {
      await invoke(
        "gsd-read-injection-scanner.js",
        {
          hook_event_name: "PostToolUse",
          tool_name: claudeTool,
          tool_input: toolInput,
          tool_response: extractText(event.result),
          cwd: binding.cwd,
        },
        binding.cwd,
        policy === true,
        advisories,
        token,
      );
      if (!active(token)) return;
      appendAdvisories(event.result, advisories);
      return;
    }
    if (!contextWarningsDisabled(binding.cwd)) {
      if (!await invoke(
        "gsd-context-monitor.js",
        {
          hook_event_name: "PostToolUse",
          tool_name: claudeTool,
          tool_input: toolInput,
          session_id: binding.sessionID,
          cwd: binding.cwd,
        },
        binding.cwd,
        false,
        advisories,
        token,
      )) return;
    }
    if (!active(token)) return;
    appendAdvisories(event.result, advisories);
  }

  async function compactSession(event) {
    const token = generation;
    if (!active(token)) return;
    const binding = await sessionBinding(event.sessionID, "session.compaction", false, token);
    if (!binding) return;
    if (!await invoke(
      "gsd-context-monitor.js",
      { hook_event_name: "PreCompact", session_id: binding.sessionID, cwd: binding.cwd },
      binding.cwd,
      false,
      undefined,
      token,
    )) return;
    if (!active(token)) return;
    const breadcrumb = `${BREADCRUMB_PREFIX} ${binding.sessionID}. Preserve any in-flight phase/plan state.`;
    if (!event.system.some((part) => part?.type === "text" && part.text === breadcrumb)) {
      event.system.push({ type: "text", text: breadcrumb });
    }
  }

  async function handleEvent(event, token) {
    if (!active(token)) return;
    if (event.type === "session.created") {
      const sessionID = event.data?.sessionID;
      const cwd = event.data?.location?.directory || event.location?.directory;
      if (typeof sessionID !== "string" || typeof cwd !== "string") {
        warn("session.created: missing event session/location; advisory hooks skipped");
        return;
      }
      for (const hookFile of ["gsd-ensure-canonical-path.js", "gsd-check-update.js"]) {
        if (!await invoke(
          hookFile,
          { hook_event_name: "SessionStart", session_id: sessionID, cwd },
          cwd,
          false,
          undefined,
          token,
        )) return;
      }
      return;
    }
    if (event.type === "filesystem.changed") {
      const directory = event.location?.directory;
      const file = event.data?.file;
      if (typeof directory !== "string" || typeof file !== "string") {
        warn("filesystem.changed: missing location; config reload skipped");
        return;
      }
      let expected;
      let actual;
      try {
        expected = canonical(path.join(directory, ".planning", "config.json"));
        actual = canonical(file);
      } catch {
        expected = path.resolve(directory, ".planning", "config.json");
        actual = path.resolve(file);
      }
      if (actual !== expected) return;
      await invoke(
        "gsd-config-reload.js",
        {
          hook_event_name: "FileChanged",
          file_path: file,
          event: event.data.event,
          cwd: directory,
        },
        directory,
        false,
        undefined,
        token,
      );
      return;
    }
    if ([
      "session.idle",
      "permission.asked",
      "permission.replied",
      "session.execution.failed",
    ].includes(event.type)) return;
  }

  async function start() {
    const token = generation;
    if (!active(token)) return;
    const register = async (registration) => {
      const disposer = await registration;
      if (!active(token)) {
        try {
          await disposer?.dispose?.();
        } catch {
          // A registration acquired during disposal is best-effort removed.
        }
        return false;
      }
      registrations.push(disposer);
      return true;
    };
    if (!await register(ctx.shell.hook("create.before", (event) => {
      if (!active(token)) return;
      event.env ||= {};
      event.env.GSD_DIR = gsdCoreDirectory;
    }))) return;
    if (!await register(ctx.tool.hook("execute.before", beforeTool))) return;
    if (!await register(ctx.tool.hook("execute.after", afterTool))) return;
    if (!await register(ctx.session.hook("compaction", compactSession))) return;
    eventPump = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
          if (!active(token)) break;
          try {
            await handleEvent(event, token);
          } catch (error) {
            if (active(token)) warn(`event ${event?.type || "unknown"} failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } catch (error) {
        if (!eventController.signal.aborted) {
          warn(`event subscription failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();
  }

  async function cleanup() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    eventController.abort();
    for (const registration of registrations.splice(0).reverse()) {
      await registration.dispose().catch((error) => warn(`registration cleanup failed: ${error}`));
    }
    for (const child of ownedChildren.keys()) child.kill("SIGTERM");
    const wait = new Promise((resolve) => setTimeout(resolve, CLEANUP_GRACE_MS));
    await Promise.race([Promise.allSettled([...settlements]), wait]);
    for (const child of ownedChildren.keys()) child.kill("SIGKILL");
    await Promise.allSettled([...settlements]);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    ownedChildren.clear();
    pending.clear();
    await eventPump?.catch(() => {});
  }

  return { start, cleanup };
}

export async function setupCorePlugin(ctx, dependencies) {
  const runtime = createRuntime(ctx, dependencies);
  try {
    await runtime.start();
  } catch (error) {
    await runtime.cleanup();
    throw error;
  }
  return runtime.cleanup;
}

// Retain the original named seam for focused adapter tests.
export const setupPlugin = setupCorePlugin;

export const _internals = Object.freeze({
  mapToolName,
  mapToolInput,
  canonicalPatchPath,
  classifyPatchLine,
  extractPatchTargets,
  extractPatchPaths,
  selectMultiEditRepresentation,
  editedPaths,
  extractText,
  transformText,
  appendAdvisories,
  parseHookStdout,
  parseHookResult,
  injectionBlockingPolicy,
  resolvePayloadRoot,
  MANDATORY_HOOKS,
  safeGsdCorePath,
  rewriteReadPath,
});

// OpenCode V2 loads the definition object directly. The upstream Plugin.define
// helper is an identity function, so importing the full schema/effect graph
// solely for that helper would add no runtime behavior.
// The named setupCorePlugin export retains its narrow unit-test seam. The host
// entrypoint intentionally accepts only context and cannot acquire injected
// runtime dependencies from host options or configuration.
export default { id: PLUGIN_ID, setup: (ctx) => setupCorePlugin(ctx) };
