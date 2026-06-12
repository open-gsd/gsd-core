#!/usr/bin/env node
'use strict';

/**
 * gen-capability-registry.cjs — generates gsd-core/bin/lib/capability-registry.cjs
 * from every capabilities/<id>/capability.json declaration.
 *
 * Usage:
 *   node scripts/gen-capability-registry.cjs              # print to stdout
 *   node scripts/gen-capability-registry.cjs --write      # write capability-registry.cjs
 *   node scripts/gen-capability-registry.cjs --check      # exit 1 if committed registry is stale
 *
 * ADR-894 phase 3a-impl. Validates each capability against the schema, enforces
 * cross-capability invariants, materializes hook ordering, and emits a role-
 * partitioned CommonJS registry module.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const CAPABILITIES_DIR = path.join(ROOT, 'capabilities');
const REGISTRY_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs');
const CONFIG_SCHEMA_PATH = path.join(ROOT, 'gsd-core', 'bin', 'shared', 'config-schema.manifest.json');

const SCHEMA_VERSION = '1';

// ─── Loop Host Contract ───────────────────────────────────────────────────────
//
// Generated from workflow markers by scripts/gen-loop-host-contract.cjs (ADR-894 §3).
// Require the committed gsd-core/bin/lib/loop-host-contract.cjs artifact so the
// registry generator and the loop-host-contract generator share one source of truth.
const { LOOP_HOST_CONTRACT } = require('../gsd-core/bin/lib/loop-host-contract.cjs');

// Canonical point order — explicit constant (do NOT rely on Set insertion order).
// Used for point-ordering semantics in consumes-satisfiability validation and topo-sort.
const POINT_ORDER = [
  'discuss:pre',
  'discuss:post',
  'plan:pre',
  'plan:post',
  'execute:pre',
  'execute:wave:pre',
  'execute:wave:post',
  'execute:post',
  'verify:pre',
  'verify:post',
  'ship:pre',
  'ship:post',
];

// C1: Artifact availability — host-produced artifacts become available at their step's :post
// point. Build a map: artifact → earliest POINT_ORDER index at which it is available.
// (discuss produces CONTEXT.md → discuss:post = index 1;
//  plan produces PLAN.md → plan:post = index 3;
//  execute produces SUMMARY.md → execute:post = index 7;
//  verify produces UAT.md → verify:post = index 9)
//
// NOTE: this map covers ONLY host artifacts. Hook-produced artifacts are handled per-run
// during consumes-satisfiability validation (C2 global pass).
const HOST_ARTIFACT_EARLIEST_POINT_IDX = (() => {
  const m = Object.create(null);
  for (const entry of LOOP_HOST_CONTRACT) {
    // The :post point is the last point in each step's points array.
    const postPoint = entry.points[entry.points.length - 1];
    const postIdx = POINT_ORDER.indexOf(postPoint);
    for (const artifact of entry.coreArtifacts.produces) {
      // Only record the earliest (should be unique, but take min to be safe).
      if (m[artifact] === undefined || postIdx < m[artifact]) {
        m[artifact] = postIdx;
      }
    }
  }
  return m;
})();

// Flatten all valid loop points into a Set for O(1) validation
const VALID_LOOP_POINTS = new Set(POINT_ORDER);

// Map point → step contract (agentRoles + coreArtifacts)
const POINT_TO_CONTRACT = new Map();
for (const entry of LOOP_HOST_CONTRACT) {
  for (const point of entry.points) {
    POINT_TO_CONTRACT.set(point, entry);
  }
}

// ─── Central config-schema loader ────────────────────────────────────────────

/**
 * Loads the set of keys from the central config-schema manifest.
 * Returns a Set<string>. Used for collision detection.
 *
 * Contract:
 *   - ENOENT (file not found): returns empty Set silently — legitimate absent case.
 *   - Any other read error OR JSON parse error: writes a prominent warning to stderr
 *     naming the schema path and the underlying error, then throws ExitError(1).
 *     A parse error clearly states the schema is broken (not merely absent).
 *
 * @param {string} [schemaPath]  Path to the config-schema manifest. Defaults to
 *                               CONFIG_SCHEMA_PATH (the real production path).
 *                               Overridable for unit testing with fixture paths.
 * @returns {Set<string>}
 */
function loadCentralConfigKeys(schemaPath = CONFIG_SCHEMA_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(schemaPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return new Set();
    }
    process.stderr.write(
      '  ERROR  Failed to read config-schema manifest at ' + schemaPath + ': ' + err.message + '\n',
    );
    throw new ExitError(1, 'could not read config-schema manifest');
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      '  ERROR  Config-schema manifest at ' + schemaPath + ' is broken (JSON parse error): ' + err.message + '\n',
    );
    throw new ExitError(1, 'config-schema manifest JSON is malformed');
  }

  return new Set(Array.isArray(manifest.validKeys) ? manifest.validKeys : []);
}

// ─── Config-slice validation ──────────────────────────────────────────────────

const VALID_CONFIG_SLICE_TYPES = new Set(['boolean', 'string', 'number', 'enum']);

/**
 * Validate a single config-slice entry (one key's { type, default, description }).
 * Returns an array of error strings. Empty = valid.
 *
 * @param {string} capId     Capability id (for error messages)
 * @param {string} key       Config key (for error messages)
 * @param {object} slice     The slice object from cap.config[key]
 * @returns {string[]}
 */
function validateConfigSliceEntry(capId, key, slice) {
  const errors = [];

  if (typeof slice !== 'object' || slice === null || Array.isArray(slice)) {
    errors.push('capability "' + capId + '" config["' + key + '"]: slice must be a non-null object');
    return errors;
  }

  // type must be one of the allowed set
  if (!VALID_CONFIG_SLICE_TYPES.has(slice.type)) {
    errors.push(
      'capability "' + capId + '" config["' + key + '"]: type must be one of ' +
      [...VALID_CONFIG_SLICE_TYPES].join(', ') + ' (got: ' + JSON.stringify(slice.type) + ')',
    );
  }

  // default must be present
  if (!Object.prototype.hasOwnProperty.call(slice, 'default')) {
    errors.push(
      'capability "' + capId + '" config["' + key + '"]: default is required',
    );
  } else {
    // type-consistency check
    const def = slice.default;
    if (slice.type === 'boolean') {
      if (typeof def !== 'boolean') {
        errors.push(
          'capability "' + capId + '" config["' + key + '"]: default must be a boolean for type:"boolean" (got: ' + typeof def + ')',
        );
      }
    } else if (slice.type === 'string') {
      if (typeof def !== 'string') {
        errors.push(
          'capability "' + capId + '" config["' + key + '"]: default must be a string for type:"string" (got: ' + typeof def + ')',
        );
      }
    } else if (slice.type === 'number') {
      if (typeof def !== 'number') {
        errors.push(
          'capability "' + capId + '" config["' + key + '"]: default must be a number for type:"number" (got: ' + typeof def + ')',
        );
      } else if (!Number.isFinite(def)) {
        // FIX 6a: Reject NaN and non-finite number defaults
        errors.push(
          'capability "' + capId + '" config["' + key + '"]: default for type:"number" must be a finite number (got: ' + String(def) + ')',
        );
      }
    } else if (slice.type === 'enum') {
      // FIX 5a: enum REQUIRES a non-empty values array (all strings), and default must be in it
      if (!Array.isArray(slice.values) || slice.values.length === 0) {
        errors.push(
          'capability "' + capId + '" config["' + key + '"]: type:"enum" requires a non-empty "values" array of strings',
        );
      } else if (!slice.values.every((v) => typeof v === 'string')) {
        errors.push(
          'capability "' + capId + '" config["' + key + '"]: type:"enum" values array must contain only strings',
        );
      }
      if (typeof def !== 'string') {
        errors.push(
          'capability "' + capId + '" config["' + key + '"]: default must be a string for type:"enum" (got: ' + typeof def + ')',
        );
      } else if (Array.isArray(slice.values) && slice.values.length > 0 && !slice.values.includes(def)) {
        errors.push(
          'capability "' + capId + '" config["' + key + '"]: default "' + def +
          '" is not one of the declared enum values [' + slice.values.join(', ') + ']',
        );
      }
    }
  }

  // description must be a non-empty string
  if (typeof slice.description !== 'string' || slice.description.length === 0) {
    errors.push(
      'capability "' + capId + '" config["' + key + '"]: description must be a non-empty string (got: ' + JSON.stringify(slice.description) + ')',
    );
  }

  return errors;
}

// ─── Per-capability validation ────────────────────────────────────────────────

const KEBAB_RE = /^[a-z][a-z0-9-]*$/;
const VALID_ROLES = new Set(['feature', 'runtime']);
const VALID_TIERS = new Set(['core', 'standard', 'full']);
const VALID_ON_ERROR = new Set(['skip', 'halt']);

/**
 * Validate a single capability declaration.
 *
 * @param {object} cap        The parsed JSON object.
 * @param {string} folderId   The folder name (must equal cap.id).
 * @returns {string[]}        Array of error strings; empty = valid.
 */
function validateCapability(cap, folderId) {
  const errors = [];

  if (typeof cap !== 'object' || cap === null || Array.isArray(cap)) {
    return ['capability must be a JSON object'];
  }

  // ── Common envelope ────────────────────────────────────────────────────────

  if (typeof cap.id !== 'string' || !KEBAB_RE.test(cap.id)) {
    errors.push('id must be a kebab-case string');
  } else if (cap.id !== folderId) {
    errors.push('id "' + cap.id + '" must equal the folder name "' + folderId + '"');
  }

  if (!VALID_ROLES.has(cap.role)) {
    errors.push('role must be one of: feature, runtime (got: ' + cap.role + ')');
  }

  if (typeof cap.title !== 'string' || cap.title.length === 0) {
    errors.push('title must be a non-empty string');
  }

  // C4: description is required
  if (typeof cap.description !== 'string' || cap.description.length === 0) {
    errors.push('description must be a non-empty string');
  }

  if (!VALID_TIERS.has(cap.tier)) {
    errors.push('tier must be one of: core, standard, full (got: ' + cap.tier + ')');
  }

  if (!Array.isArray(cap.requires)) {
    errors.push('requires must be an array of capability ids');
  } else {
    for (const req of cap.requires) {
      if (typeof req !== 'string') {
        errors.push('requires entries must be strings (got: ' + JSON.stringify(req) + ')');
      }
    }
  }

  // ── Role-specific body ────────────────────────────────────────────────────

  if (cap.role === 'feature') {
    errors.push(...validateFeatureBody(cap));
  } else if (cap.role === 'runtime') {
    errors.push(...validateRuntimeBody(cap));
  }

  return errors;
}

/**
 * ADR-959: Validate a single commands[] entry on a feature-role capability.
 * { family: string, module: string, router: string, subcommands?: string[] }
 *
 * - family: non-empty string, no reserved names
 * - module: non-empty string, no path traversal, no absolute paths, no "/"
 *   segments other than a bare basename (expected form: "foo.cjs")
 * - router: non-empty string
 * - subcommands: optional array of strings (doc/introspection only)
 *
 * @param {string} capId     Capability id (for error messages)
 * @param {*}      entry     The entry to validate
 * @param {string} prefix    Path prefix (e.g. "commands[0]")
 * @returns {string[]}       Array of error strings; empty = valid.
 */
function validateCommandEntry(capId, entry, prefix) {
  const errors = [];
  const ctx = 'capability "' + capId + '" ' + prefix;

  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    errors.push(ctx + ' must be an object with family, module, and router');
    return errors;
  }

  // family: non-empty string, no reserved names
  if (typeof entry.family !== 'string' || entry.family.length === 0) {
    errors.push(ctx + '.family must be a non-empty string');
  } else if (entry.family === '__proto__' || entry.family === 'constructor' || entry.family === 'prototype') {
    // S2a: inline literal reserved-name guard (CodeQL barrier)
    errors.push(ctx + '.family "' + entry.family + '" is a reserved name');
  }

  // module: must be a safe bare basename matching /^[A-Za-z0-9._-]+\.cjs$/ —
  // no path separators, no "..", no NUL bytes, no absolute paths, ends in .cjs.
  // This conservative pattern subsumes all earlier traversal/absolute/separator checks.
  if (typeof entry.module !== 'string' || entry.module.length === 0) {
    errors.push(ctx + '.module must be a non-empty string');
  } else {
    const mod = entry.module;
    const SAFE_BASENAME = /^[A-Za-z0-9._-]+\.cjs$/;
    if (!SAFE_BASENAME.test(mod)) {
      errors.push(
        ctx + '.module must be a safe bare basename (pattern: /^[A-Za-z0-9._-]+\\.cjs$/, no path separators, no "..", no NUL bytes, must end in ".cjs"); got: ' +
        JSON.stringify(mod),
      );
    }
  }

  // router: non-empty string
  if (typeof entry.router !== 'string' || entry.router.length === 0) {
    errors.push(ctx + '.router must be a non-empty string');
  }

  // subcommands: optional array of non-empty strings (doc/introspection only)
  if (entry.subcommands !== undefined) {
    if (!Array.isArray(entry.subcommands)) {
      errors.push(ctx + '.subcommands must be an array of strings if present');
    } else {
      for (let i = 0; i < entry.subcommands.length; i++) {
        if (typeof entry.subcommands[i] !== 'string') {
          errors.push(ctx + '.subcommands[' + i + '] must be a string');
        } else if (entry.subcommands[i].length === 0) {
          errors.push(ctx + '.subcommands[' + i + '] must be a non-empty string');
        }
      }
    }
  }

  return errors;
}

function validateFeatureBody(cap) {
  const errors = [];

  if (!Array.isArray(cap.skills)) {
    errors.push('skills must be an array of strings');
  } else {
    for (const s of cap.skills) {
      if (typeof s !== 'string') {
        errors.push('skills entries must be strings');
      } else if (s === '__proto__' || s === 'constructor' || s === 'prototype') {
        // S2a: inline literal reserved-name guard (CodeQL barrier)
        errors.push('skills entry "' + s + '" is a reserved name');
      }
    }
  }

  // ADR-959: optional commands array
  if (cap.commands !== undefined) {
    if (!Array.isArray(cap.commands)) {
      errors.push('commands must be an array of {family, module, router} objects');
    } else {
      for (let i = 0; i < cap.commands.length; i++) {
        errors.push(...validateCommandEntry(cap.id || cap.role, cap.commands[i], 'commands[' + i + ']'));
      }
    }
  }

  if (!Array.isArray(cap.agents)) {
    errors.push('agents must be an array of strings');
  } else {
    for (const a of cap.agents) {
      if (typeof a !== 'string') {
        errors.push('agents entries must be strings');
      } else if (a === '__proto__' || a === 'constructor' || a === 'prototype') {
        // S2a: inline literal reserved-name guard (CodeQL barrier)
        errors.push('agents entry "' + a + '" is a reserved name');
      }
    }
  }

  if (typeof cap.config !== 'object' || cap.config === null || Array.isArray(cap.config)) {
    errors.push('config must be an object');
  } else {
    // C5: validate config key names and value shapes
    for (const key of Object.keys(cap.config)) {
      if (key === '' ) {
        errors.push('config keys must be non-empty strings');
      } else if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        // S2a: inline literal reserved-name guard (CodeQL barrier)
        errors.push('config key "' + key + '" is a reserved name');
      }
      const val = cap.config[key];
      if (val === null || typeof val !== 'object' || Array.isArray(val)) {
        errors.push('config["' + key + '"] must be an object (got: ' + (val === null ? 'null' : typeof val) + ')');
      } else if (typeof val.type !== 'string' || val.type.length === 0) {
        errors.push('config["' + key + '"] must have a string "type" field (e.g. "boolean", "string", "number", "enum")');
      }
    }
  }

  // C4: hooks, when present, must be an array of {event: string, script: string}
  if (cap.hooks !== undefined) {
    if (!Array.isArray(cap.hooks)) {
      errors.push('hooks must be an array of {event, script} objects');
    } else {
      for (let i = 0; i < cap.hooks.length; i++) {
        const h = cap.hooks[i];
        if (typeof h !== 'object' || h === null || Array.isArray(h)) {
          errors.push('hooks[' + i + '] must be an object with event and script keys');
        } else {
          if (typeof h.event !== 'string' || h.event.length === 0) {
            errors.push('hooks[' + i + '].event must be a non-empty string');
          }
          if (typeof h.script !== 'string' || h.script.length === 0) {
            errors.push('hooks[' + i + '].script must be a non-empty string');
          }
        }
      }
    }
  }

  // Build the declared skill/agent sets for ref membership checks (used in validateStep).
  // Only build these if the arrays are valid (already validated above).
  const declaredSkills = Array.isArray(cap.skills) ? new Set(cap.skills.filter((s) => typeof s === 'string')) : null;
  const declaredAgents = Array.isArray(cap.agents) ? new Set(cap.agents.filter((a) => typeof a === 'string')) : null;

  if (!Array.isArray(cap.steps)) {
    errors.push('steps must be an array');
  } else {
    for (let i = 0; i < cap.steps.length; i++) {
      errors.push(...validateStep(cap.steps[i], 'steps[' + i + ']', declaredSkills, declaredAgents));
    }
  }

  if (!Array.isArray(cap.contributions)) {
    errors.push('contributions must be an array');
  } else {
    for (let i = 0; i < cap.contributions.length; i++) {
      errors.push(...validateContribution(cap.contributions[i], 'contributions[' + i + ']'));
    }
  }

  if (!Array.isArray(cap.gates)) {
    errors.push('gates must be an array');
  } else {
    for (let i = 0; i < cap.gates.length; i++) {
      errors.push(...validateGate(cap.gates[i], 'gates[' + i + ']'));
    }
  }

  return errors;
}

// ADR-857 phase 5e: Closed ConverterName enum — complete set used across 16 runtime descriptors,
// all exported by bin/install.js. Any ArtifactKind with a non-null converter must use one of these.
const VALID_CONVERTER_NAMES = new Set([
  'convertClaudeCommandToAntigravitySkill',
  'convertClaudeCommandToAugmentSkill',
  'convertClaudeCommandToClineSkill',
  'convertClaudeCommandToClaudeSkill',
  'convertClaudeCommandToCodebuddyCommand',
  'convertClaudeCommandToCodebuddySkill',
  'convertClaudeCommandToCodexSkill',
  'convertClaudeCommandToCopilotSkill',
  'convertClaudeCommandToCursorCommand',
  'convertClaudeCommandToCursorSkill',
  'convertClaudeCommandToKiloSkill',
  'convertClaudeCommandToKimiSkill',
  'convertClaudeCommandToOpencodeSkill',
  'convertClaudeCommandToTraeSkill',
  'convertClaudeCommandToWindsurfSkill',
]);

// C3: Validate role:runtime body
const VALID_CONFIG_FORMATS = new Set(['settings-json', 'toml', 'markdown', 'markdown-dir', 'none']);
const VALID_CONFIG_HOME_KINDS = new Set(['dot-home', 'dot-home-nested', 'xdg', 'generic-agents-root']);
const VALID_COMMAND_STYLES = new Set(['slash-hyphen', 'shell-var']);
const VALID_HOOKS_SURFACES = new Set(['settings-json', 'codex-hooks-json', 'cursor-hooks-json', 'copilot-inline', 'cline-rules', 'none']);
const VALID_HOOK_EVENTS = new Set(['claude', 'gemini', 'opencode-subset']);
const VALID_SANDBOX_TIERS = new Set(['none', 'codex-agent-sandbox']);
const VALID_ARTIFACT_KIND_NAMES = new Set(['commands', 'agents', 'skills', 'kimi-agents']);
const VALID_ARTIFACT_NESTINGS = new Set(['flat', 'nested']);
const FEATURE_FIELDS_FORBIDDEN_ON_RUNTIME = ['skills', 'agents', 'steps', 'contributions', 'gates', 'hooks'];
const VALID_INSTALL_SURFACES = new Set(['settings-json', 'codex-toml', 'copilot-instructions', 'cline-rules', 'cursor-hooks-json', 'profile-marker-only']);
const VALID_PERMISSION_WRITERS = new Set(['opencode', 'kilo']);
const VALID_EXTENDED_HOOK_EVENTS = new Set(['SubagentStop', 'Stop', 'PreCompact', 'FileChanged', 'BeforeAgent', 'AfterAgent', 'BeforeModel']);

// GATE A: installSurface → allowed hooksSurface values (DEFECT.GENERATIVE-FIX: parity invariant)
// Derived from the actual pairings in the 16 real runtime descriptors.
const INSTALL_SURFACE_TO_ALLOWED_HOOKS_SURFACES = new Map([
  ['settings-json',        new Set(['settings-json', 'none'])],
  ['codex-toml',           new Set(['codex-hooks-json'])],
  ['copilot-instructions', new Set(['copilot-inline'])],
  ['cline-rules',          new Set(['cline-rules'])],
  ['cursor-hooks-json',    new Set(['cursor-hooks-json'])],
  ['profile-marker-only',  new Set(['none'])],
]);

// GATE B: extended hook event families → required hookEvents value
// Gemini agent-events require hookEvents='gemini'; Claude-family events require hookEvents='claude'.
const GEMINI_AGENT_EVENTS = new Set(['BeforeAgent', 'AfterAgent', 'BeforeModel']);
const CLAUDE_FAMILY_EVENTS = new Set(['SubagentStop', 'Stop', 'PreCompact', 'FileChanged']);

/**
 * Validate a runtime.configHome object per ADR-1016 Decision 1.
 * Returns an array of error strings.
 *
 * @param {string} capId  Capability id (for error messages)
 * @param {*}      ch     The configHome value
 * @returns {string[]}
 */
function validateConfigHome(capId, ch) {
  const errors = [];
  const ctx = 'capability "' + capId + '" runtime.configHome';

  if (typeof ch !== 'object' || ch === null || Array.isArray(ch)) {
    errors.push(ctx + ' must be an object (got: ' + (ch === null ? 'null' : typeof ch) + ')');
    return errors;
  }

  // kind — must be in closed vocab; inline literal guard (CodeQL barrier)
  if (ch.kind === '__proto__' || ch.kind === 'constructor' || ch.kind === 'prototype') {
    errors.push(ctx + '.kind "' + ch.kind + '" is a reserved name');
  } else if (!VALID_CONFIG_HOME_KINDS.has(ch.kind)) {
    errors.push(
      ctx + '.kind must be one of: ' + [...VALID_CONFIG_HOME_KINDS].join(', ') +
      ' (got: ' + JSON.stringify(ch.kind) + ')',
    );
  }

  // name — required string
  if (typeof ch.name !== 'string' || ch.name.length === 0) {
    errors.push(ctx + '.name must be a non-empty string');
  }

  // parent — required when kind == dot-home-nested
  if (ch.kind === 'dot-home-nested') {
    if (typeof ch.parent !== 'string' || ch.parent.length === 0) {
      errors.push(ctx + '.parent must be a non-empty string when kind is "dot-home-nested"');
    }
  }

  // env — required; must be an array of strings (every runtime has ≥0 env overrides)
  if (!Array.isArray(ch.env)) {
    errors.push(ctx + '.env is required and must be an array of strings (got: ' + JSON.stringify(ch.env) + ')');
  } else {
    for (let i = 0; i < ch.env.length; i++) {
      if (typeof ch.env[i] !== 'string') {
        errors.push(ctx + '.env[' + i + '] must be a string');
      }
    }
  }

  // probe — optional; if present must be an array of strings
  if (ch.probe !== undefined) {
    if (!Array.isArray(ch.probe)) {
      errors.push(ctx + '.probe must be an array of strings if present');
    } else {
      for (let i = 0; i < ch.probe.length; i++) {
        if (typeof ch.probe[i] !== 'string') {
          errors.push(ctx + '.probe[' + i + '] must be a string');
        }
      }
    }
  }

  // probeExists — optional; if present must be a non-empty string (sub-path existence check for probe)
  if (ch.probeExists !== undefined) {
    if (typeof ch.probeExists !== 'string' || ch.probeExists.length === 0) {
      errors.push(ctx + '.probeExists must be a non-empty string if present (got: ' + JSON.stringify(ch.probeExists) + ')');
    }
  }

  // skillsHome — optional; if present must be a full valid configHome object (recursive validation)
  if (ch.skillsHome !== undefined) {
    // Recursive call: validate skillsHome as a nested configHome.
    // Use a synthetic capId to surface the sub-path in error messages.
    const skillsHomeErrors = validateConfigHome(capId + '.skillsHome', ch.skillsHome);
    // Rewrite the inner ctx prefix so errors read as "...runtime.configHome.skillsHome..."
    for (const e of skillsHomeErrors) {
      errors.push(e.replace(
        'capability "' + capId + '.skillsHome" runtime.configHome',
        ctx + '.skillsHome',
      ));
    }
  }

  return errors;
}

/**
 * Validate a single ArtifactKind entry per ADR-1016 Decision 3.
 * Returns an array of error strings.
 *
 * @param {string} capId   Capability id (for error messages)
 * @param {*}      entry   The ArtifactKind object
 * @param {string} prefix  Path prefix for error messages (e.g. "artifactLayout.global[0]")
 * @returns {string[]}
 */
function validateArtifactKindEntry(capId, entry, prefix) {
  const errors = [];
  const ctx = 'capability "' + capId + '" runtime.' + prefix;

  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    errors.push(ctx + ' must be an object');
    return errors;
  }

  // kind — must be in closed vocab; inline literal guard (CodeQL barrier)
  if (entry.kind === '__proto__' || entry.kind === 'constructor' || entry.kind === 'prototype') {
    errors.push(ctx + '.kind "' + entry.kind + '" is a reserved name');
  } else if (!VALID_ARTIFACT_KIND_NAMES.has(entry.kind)) {
    errors.push(
      ctx + '.kind must be one of: ' + [...VALID_ARTIFACT_KIND_NAMES].join(', ') +
      ' (got: ' + JSON.stringify(entry.kind) + ')',
    );
  }

  // destSubpath — required non-empty string
  if (typeof entry.destSubpath !== 'string' || entry.destSubpath.length === 0) {
    errors.push(ctx + '.destSubpath must be a non-empty string');
  }

  // nesting — required; must be in closed vocab (ADR-857 §5d: now drives install)
  if (entry.nesting === undefined || entry.nesting === null) {
    errors.push(ctx + '.nesting is required and must be one of: ' + [...VALID_ARTIFACT_NESTINGS].join(', '));
  } else if (!VALID_ARTIFACT_NESTINGS.has(entry.nesting)) {
    errors.push(
      ctx + '.nesting must be one of: ' + [...VALID_ARTIFACT_NESTINGS].join(', ') +
      ' (got: ' + JSON.stringify(entry.nesting) + ')',
    );
  }

  // prefix — required; must be a string (may be empty string '')
  if (entry.prefix === undefined || entry.prefix === null) {
    errors.push(ctx + '.prefix is required (must be a string, may be empty)');
  } else if (typeof entry.prefix !== 'string') {
    errors.push(ctx + '.prefix must be a string (got: ' + typeof entry.prefix + ')');
  }

  // recursive — optional; if present must be a boolean
  if (entry.recursive !== undefined) {
    if (typeof entry.recursive !== 'boolean') {
      errors.push(ctx + '.recursive must be a boolean if present (got: ' + typeof entry.recursive + ')');
    }
  }

  // converter — required; must be a string or null (closed ConverterName enum — now enforced in phase 5e)
  if (!Object.prototype.hasOwnProperty.call(entry, 'converter')) {
    errors.push(ctx + '.converter is required (must be a string or null)');
  } else if (entry.converter !== null && typeof entry.converter !== 'string') {
    errors.push(ctx + '.converter must be a string or null (got: ' + typeof entry.converter + ')');
  } else if (entry.converter !== null && typeof entry.converter === 'string' &&
             !VALID_CONVERTER_NAMES.has(entry.converter)) {
    // Closed ConverterName enum (ADR-857 phase 5e): reject unknown converter names
    errors.push(ctx + '.converter "' + entry.converter + '" is not a known ConverterName');
  }

  return errors;
}

/**
 * Validate runtime.artifactLayout per ADR-1016 Decision 3.
 * Accepts the structured { global, local } shape.
 * Returns an array of error strings.
 *
 * @param {string} capId  Capability id (for error messages)
 * @param {*}      layout The artifactLayout value
 * @returns {string[]}
 */
function validateArtifactLayout(capId, layout) {
  const errors = [];
  const ctx = 'capability "' + capId + '" runtime.artifactLayout';

  if (typeof layout !== 'object' || layout === null || Array.isArray(layout)) {
    errors.push(ctx + ' must be an object with "global" and "local" arrays');
    return errors;
  }

  for (const scope of ['global', 'local']) {
    const arr = layout[scope];
    if (!Array.isArray(arr)) {
      errors.push(ctx + '.' + scope + ' must be an array');
    } else {
      for (let i = 0; i < arr.length; i++) {
        errors.push(...validateArtifactKindEntry(capId, arr[i], 'artifactLayout.' + scope + '[' + i + ']'));
      }
    }
  }

  return errors;
}

function validateRuntimeBody(cap) {
  const errors = [];

  // C3: feature-only fields must NOT appear on a runtime cap
  for (const field of FEATURE_FIELDS_FORBIDDEN_ON_RUNTIME) {
    if (cap[field] !== undefined) {
      errors.push('role:runtime capability must not have "' + field + '" (feature-only field)');
    }
  }

  // C3: require a runtime object
  if (typeof cap.runtime !== 'object' || cap.runtime === null || Array.isArray(cap.runtime)) {
    errors.push('role:runtime capability must have a "runtime" object');
    return errors; // can't validate further without the object
  }

  const r = cap.runtime;

  // configHome — must be a structured object (ADR-1016 Decision 1)
  errors.push(...validateConfigHome(cap.id || '(unknown)', r.configHome));

  // configFormat — closed 5-enum (unchanged)
  if (!VALID_CONFIG_FORMATS.has(r.configFormat)) {
    errors.push('runtime.configFormat must be one of: ' + [...VALID_CONFIG_FORMATS].join(', ') + ' (got: ' + r.configFormat + ')');
  }

  // artifactLayout — structured { global, local } per ADR-1016 Decision 3
  errors.push(...validateArtifactLayout(cap.id || '(unknown)', r.artifactLayout));

  // commandStyle — closed 2-enum (ADR-1016 Decision 4); inline literal guard (CodeQL barrier)
  if (r.commandStyle === '__proto__' || r.commandStyle === 'constructor' || r.commandStyle === 'prototype') {
    errors.push('runtime.commandStyle "' + r.commandStyle + '" is a reserved name');
  } else if (!VALID_COMMAND_STYLES.has(r.commandStyle)) {
    errors.push(
      'runtime.commandStyle must be one of: ' + [...VALID_COMMAND_STYLES].join(', ') +
      ' (got: ' + JSON.stringify(r.commandStyle) + ')',
    );
  }

  // hooksSurface — closed 6-enum (ADR-1016 Decision 5); inline literal guard (CodeQL barrier)
  if (r.hooksSurface === '__proto__' || r.hooksSurface === 'constructor' || r.hooksSurface === 'prototype') {
    errors.push('runtime.hooksSurface "' + r.hooksSurface + '" is a reserved name');
  } else if (!VALID_HOOKS_SURFACES.has(r.hooksSurface)) {
    errors.push(
      'runtime.hooksSurface must be one of: ' + [...VALID_HOOKS_SURFACES].join(', ') +
      ' (got: ' + JSON.stringify(r.hooksSurface) + ')',
    );
  }

  // hookEvents — optional; if present must be in closed 3-enum (ADR-1016 Decision 5)
  if (r.hookEvents !== undefined) {
    if (r.hookEvents === '__proto__' || r.hookEvents === 'constructor' || r.hookEvents === 'prototype') {
      errors.push('runtime.hookEvents "' + r.hookEvents + '" is a reserved name');
    } else if (!VALID_HOOK_EVENTS.has(r.hookEvents)) {
      errors.push(
        'runtime.hookEvents must be one of: ' + [...VALID_HOOK_EVENTS].join(', ') +
        ' (got: ' + JSON.stringify(r.hookEvents) + ')',
      );
    }
  }

  // sandboxTier — closed 2-enum (ADR-1016 Decision 6); inline literal guard (CodeQL barrier)
  if (r.sandboxTier === '__proto__' || r.sandboxTier === 'constructor' || r.sandboxTier === 'prototype') {
    errors.push('runtime.sandboxTier "' + r.sandboxTier + '" is a reserved name');
  } else if (!VALID_SANDBOX_TIERS.has(r.sandboxTier)) {
    errors.push(
      'runtime.sandboxTier must be one of: ' + [...VALID_SANDBOX_TIERS].join(', ') +
      ' (got: ' + JSON.stringify(r.sandboxTier) + ')',
    );
  }

  // supportTier — 1 or 2 (unchanged)
  if (r.supportTier !== 1 && r.supportTier !== 2) {
    errors.push('runtime.supportTier must be 1 or 2 (got: ' + r.supportTier + ')');
  }

  // installSurface — required string in closed enum
  if (!VALID_INSTALL_SURFACES.has(r.installSurface)) {
    errors.push(
      'runtime.installSurface must be one of: ' + [...VALID_INSTALL_SURFACES].join(', ') +
      ' (got: ' + JSON.stringify(r.installSurface) + ')',
    );
  }

  // writesSharedSettings — required boolean
  if (typeof r.writesSharedSettings !== 'boolean') {
    errors.push(
      'runtime.writesSharedSettings must be a boolean (got: ' + JSON.stringify(r.writesSharedSettings) + ')',
    );
  }

  // permissionWriter — required key; value must be null or a string in VALID_PERMISSION_WRITERS
  if (!Object.prototype.hasOwnProperty.call(r, 'permissionWriter')) {
    errors.push('runtime.permissionWriter is required (must be null or one of: ' + [...VALID_PERMISSION_WRITERS].join(', ') + ')');
  } else if (r.permissionWriter !== null && !VALID_PERMISSION_WRITERS.has(r.permissionWriter)) {
    errors.push(
      'runtime.permissionWriter must be null or one of: ' + [...VALID_PERMISSION_WRITERS].join(', ') +
      ' (got: ' + JSON.stringify(r.permissionWriter) + ')',
    );
  }

  // extendedHookEvents — required array; every element must be in closed enum
  if (!Array.isArray(r.extendedHookEvents)) {
    errors.push(
      'runtime.extendedHookEvents must be an array (got: ' + JSON.stringify(r.extendedHookEvents) + ')',
    );
  } else {
    for (let i = 0; i < r.extendedHookEvents.length; i++) {
      const ev = r.extendedHookEvents[i];
      if (typeof ev !== 'string' || !VALID_EXTENDED_HOOK_EVENTS.has(ev)) {
        errors.push(
          'runtime.extendedHookEvents[' + i + '] must be one of: ' + [...VALID_EXTENDED_HOOK_EVENTS].join(', ') +
          ' (got: ' + JSON.stringify(ev) + ')',
        );
      }
    }
  }

  // GATE A: installSurface ↔ hooksSurface consistency (DEFECT.GENERATIVE-FIX)
  // Only check if both fields are valid strings (individual field validators above report type errors).
  if (typeof r.installSurface === 'string' && typeof r.hooksSurface === 'string') {
    const allowedHooksSurfaces = INSTALL_SURFACE_TO_ALLOWED_HOOKS_SURFACES.get(r.installSurface);
    if (allowedHooksSurfaces !== undefined && !allowedHooksSurfaces.has(r.hooksSurface)) {
      errors.push(
        'runtime.hooksSurface "' + r.hooksSurface + '" is not valid for installSurface "' + r.installSurface + '"' +
        ' — allowed: ' + [...allowedHooksSurfaces].join(', ') +
        ' (src: INSTALL_SURFACE_TO_ALLOWED_HOOKS_SURFACES in scripts/gen-capability-registry.cjs)',
      );
    }
  }

  // GATE B: extendedHookEvents ↔ hookEvents consistency (DEFECT.GENERATIVE-FIX)
  // If extendedHookEvents contains Gemini agent-events, hookEvents must be 'gemini'.
  // If it contains Claude-family events, hookEvents must be 'claude'.
  // Empty extendedHookEvents imposes no constraint.
  if (Array.isArray(r.extendedHookEvents) && r.extendedHookEvents.length > 0) {
    const hasGeminiEvents = r.extendedHookEvents.some((ev) => GEMINI_AGENT_EVENTS.has(ev));
    const hasClaudeEvents = r.extendedHookEvents.some((ev) => CLAUDE_FAMILY_EVENTS.has(ev));
    if (hasGeminiEvents && r.hookEvents !== 'gemini') {
      errors.push(
        'runtime.extendedHookEvents contains Gemini agent-events (' +
        r.extendedHookEvents.filter((ev) => GEMINI_AGENT_EVENTS.has(ev)).join(', ') +
        ') but runtime.hookEvents is "' + r.hookEvents + '" — must be "gemini"',
      );
    }
    if (hasClaudeEvents && r.hookEvents !== 'claude') {
      errors.push(
        'runtime.extendedHookEvents contains Claude-family events (' +
        r.extendedHookEvents.filter((ev) => CLAUDE_FAMILY_EVENTS.has(ev)).join(', ') +
        ') but runtime.hookEvents is "' + r.hookEvents + '" — must be "claude"',
      );
    }
  }

  return errors;
}

/**
 * Validate a single step entry.
 *
 * @param {object}   step            The step to validate.
 * @param {string}   prefix          Path prefix for error messages (e.g. "steps[0]").
 * @param {Set|null} declaredSkills  Set of skill stems declared in this capability's skills array,
 *                                   or null if the skills array was not valid (skip membership check).
 * @param {Set|null} declaredAgents  Set of agent names declared in this capability's agents array,
 *                                   or null if the agents array was not valid (skip membership check).
 * @returns {string[]}
 */
function validateStep(step, prefix, declaredSkills, declaredAgents) {
  const errors = [];

  if (!VALID_LOOP_POINTS.has(step.point)) {
    errors.push(prefix + '.point "' + step.point + '" is not a valid loop point');
  }

  if (typeof step.ref !== 'object' || step.ref === null) {
    errors.push(prefix + '.ref must be an object with skill or agent key');
  } else {
    const hasSkill = Object.prototype.hasOwnProperty.call(step.ref, 'skill');
    const hasAgent = Object.prototype.hasOwnProperty.call(step.ref, 'agent');
    if (!hasSkill && !hasAgent) {
      errors.push(prefix + '.ref must have a "skill" or "agent" key');
    } else if (hasSkill && hasAgent) {
      // Fix #4: ref must be exclusive {skill} XOR {agent}
      errors.push(prefix + '.ref must have exactly one of "skill" or "agent", not both');
    }
    if (hasSkill && typeof step.ref.skill !== 'string') {
      errors.push(prefix + '.ref.skill must be a string');
    } else if (hasSkill && typeof step.ref.skill === 'string' && step.ref.skill.startsWith('gsd-')) {
      // Double-prefix guard: ref.skill is an unprefixed stem (e.g. "ui-review").
      // Workflow dispatch prepends "gsd-" at runtime → "gsd-ui-review".
      // A stem that already starts with "gsd-" would produce "gsd-gsd-..." at dispatch.
      errors.push(
        prefix + '.ref.skill "' + step.ref.skill + '" must not start with "gsd-" ' +
        '(it is an unprefixed stem; the workflow prepends "gsd-" at dispatch — ' +
        'starting with "gsd-" would produce "gsd-' + step.ref.skill + '")',
      );
    } else if (hasSkill && typeof step.ref.skill === 'string' && declaredSkills !== null && !declaredSkills.has(step.ref.skill)) {
      // Membership check: ref.skill must be declared in this capability's skills array.
      // This catches typos and ensures every dispatched skill is owned by this capability.
      errors.push(
        prefix + '.ref.skill "' + step.ref.skill + '" is not declared in this capability\'s skills: [' +
        [...declaredSkills].join(', ') + ']',
      );
    }
    if (hasAgent && typeof step.ref.agent !== 'string') {
      errors.push(prefix + '.ref.agent must be a string');
    } else if (hasAgent && typeof step.ref.agent === 'string' && declaredAgents !== null && !declaredAgents.has(step.ref.agent)) {
      // Membership check: ref.agent must be declared in this capability's agents array.
      errors.push(
        prefix + '.ref.agent "' + step.ref.agent + '" is not declared in this capability\'s agents: [' +
        [...declaredAgents].join(', ') + ']',
      );
    }
  }

  if (!Array.isArray(step.produces)) {
    errors.push(prefix + '.produces must be an array');
  } else {
    for (const p of step.produces) {
      if (typeof p !== 'string') errors.push(prefix + '.produces entries must be strings');
    }
  }

  if (!Array.isArray(step.consumes)) {
    errors.push(prefix + '.consumes must be an array');
  } else {
    for (const c of step.consumes) {
      if (typeof c !== 'string') errors.push(prefix + '.consumes entries must be strings');
    }
  }

  if (step.when !== undefined && typeof step.when !== 'string') {
    errors.push(prefix + '.when must be a string if present');
  }

  if (!VALID_ON_ERROR.has(step.onError)) {
    errors.push(prefix + '.onError must be "skip" or "halt" (got: ' + step.onError + ')');
  }

  return errors;
}

function validateContribution(contrib, prefix) {
  const errors = [];

  if (!VALID_LOOP_POINTS.has(contrib.point)) {
    errors.push(prefix + '.point "' + contrib.point + '" is not a valid loop point');
  }

  if (typeof contrib.into !== 'string') {
    errors.push(prefix + '.into must be a string (agent role name)');
  }

  if (typeof contrib.fragment !== 'object' || contrib.fragment === null) {
    errors.push(prefix + '.fragment must be an object with path or inline key');
  } else {
    const hasPath = Object.prototype.hasOwnProperty.call(contrib.fragment, 'path');
    const hasInline = Object.prototype.hasOwnProperty.call(contrib.fragment, 'inline');
    if (!hasPath && !hasInline) {
      errors.push(prefix + '.fragment must have a "path" or "inline" key');
    }
    // S1: fragment.path traversal guard — must be a relative path with no ".." segments
    if (hasPath) {
      const p = contrib.fragment.path;
      if (typeof p !== 'string' || p === '' || path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) {
        errors.push(prefix + '.fragment.path must be a relative path with no ".." segments');
      }
    }
  }

  if (contrib.when !== undefined && typeof contrib.when !== 'string') {
    errors.push(prefix + '.when must be a string if present');
  }

  if (contrib.onError !== undefined && !VALID_ON_ERROR.has(contrib.onError)) {
    errors.push(prefix + '.onError must be "skip" or "halt" if present');
  }

  return errors;
}

function validateGate(gate, prefix) {
  const errors = [];

  if (!VALID_LOOP_POINTS.has(gate.point)) {
    errors.push(prefix + '.point "' + gate.point + '" is not a valid loop point');
  }

  if (typeof gate.check !== 'object' || gate.check === null) {
    errors.push(prefix + '.check must be an object');
  } else {
    const hasQuery = Object.prototype.hasOwnProperty.call(gate.check, 'query');
    const hasPredicate = Object.prototype.hasOwnProperty.call(gate.check, 'predicate');
    const hasAgentVerdict = Object.prototype.hasOwnProperty.call(gate.check, 'agentVerdict');
    const count = [hasQuery, hasPredicate, hasAgentVerdict].filter(Boolean).length;
    if (count !== 1) {
      errors.push(prefix + '.check must have exactly one of: query, predicate, agentVerdict');
    }
    // agentVerdict forces blocking: false (advisory only)
    if (hasAgentVerdict && gate.blocking === true) {
      errors.push(
        prefix + '.check.agentVerdict forces blocking: false (non-deterministic checks may not halt the loop)',
      );
    }
  }

  if (gate.when !== undefined && typeof gate.when !== 'string') {
    errors.push(prefix + '.when must be a string if present');
  }

  if (typeof gate.blocking !== 'boolean') {
    errors.push(prefix + '.blocking must be a boolean');
  }

  if (!VALID_ON_ERROR.has(gate.onError)) {
    errors.push(prefix + '.onError must be "skip" or "halt" (got: ' + gate.onError + ')');
  }

  return errors;
}

// ─── Contract validation ──────────────────────────────────────────────────────

/**
 * Validate per-capability contract constraints against the Loop Host Contract.
 * This covers:
 *   - contribution.into ∈ step's agentRoles
 *   - when references a config key in cap.config
 *
 * NOTE: step.consumes satisfiability is NOT checked here — it requires the full
 * set of validated capabilities (cross-capability produces). It runs in
 * validateConsumesGlobal() after loadAndValidate builds capMap.
 *
 * @param {object} cap         Validated capability object
 * @param {string} capId       Capability id (for error messages)
 */
function validateAgainstContract(cap, capId) {
  if (cap.role !== 'feature') return [];
  const errors = [];
  const prefix = 'capability "' + capId + '"';

  // contribution.into must be in the step's agentRoles
  for (const contrib of cap.contributions) {
    if (!VALID_LOOP_POINTS.has(contrib.point)) continue; // already reported
    const contract = POINT_TO_CONTRACT.get(contrib.point);
    if (contract && !contract.agentRoles.includes(contrib.into)) {
      errors.push(
        prefix + ' contribution.into "' + contrib.into + '" at point "' + contrib.point +
        '" is not in the step\'s agentRoles [' + contract.agentRoles.join(', ') + ']',
      );
    }
  }

  // when references a plausibly-valid config key (string — we require it's in cap.config)
  for (const step of cap.steps) {
    if (step.when !== undefined) {
      if (typeof step.when !== 'string') continue; // already reported above
      if (
        typeof cap.config === 'object' &&
        cap.config !== null &&
        !Object.prototype.hasOwnProperty.call(cap.config, step.when)
      ) {
        errors.push(
          prefix + ' step.when "' + step.when + '" is not defined in capability config keys',
        );
      }
    }
  }

  for (const contrib of cap.contributions) {
    if (contrib.when !== undefined) {
      if (typeof contrib.when !== 'string') continue;
      if (
        typeof cap.config === 'object' &&
        cap.config !== null &&
        !Object.prototype.hasOwnProperty.call(cap.config, contrib.when)
      ) {
        errors.push(
          prefix + ' contribution.when "' + contrib.when + '" is not defined in capability config keys',
        );
      }
    }
  }

  for (const gate of cap.gates) {
    if (gate.when !== undefined) {
      if (typeof gate.when !== 'string') continue;
      if (
        typeof cap.config === 'object' &&
        cap.config !== null &&
        !Object.prototype.hasOwnProperty.call(cap.config, gate.when)
      ) {
        errors.push(
          prefix + ' gate.when "' + gate.when + '" is not defined in capability config keys',
        );
      }
    }
  }

  return errors;
}

/**
 * C1+C2: Global consumes-satisfiability validation.
 *
 * A hook at point P consuming artifact A is satisfiable iff:
 *   - A is a host-produced artifact available from its step's :post point (C1), and
 *     that :post point's POINT_ORDER index ≤ P's index; OR
 *   - A is produced by any capability hook step at a point whose POINT_ORDER index ≤ P's index
 *     (same-point is OK — topoSortSteps enforces intra-point order); OR
 *   - A is never produced anywhere → rejected.
 *
 * Runs after capMap is fully built so cross-capability produces are visible.
 *
 * @param {Map<string, object>} capMap  Fully-validated capability map.
 * @returns {string[]}                  Array of error strings.
 */
function validateConsumesGlobal(capMap) {
  const errors = [];

  // Build producedAtPoint: artifact → earliest POINT_ORDER index at which it is produced.
  // Seed with host artifacts (C1: available from their step's :post point).
  // Host-artifact entries are tagged {pointIdx, isHost:true} so they are never excluded by
  // the self-consume check.
  const producedAtPoint = Object.create(null);
  for (const [artifact, postIdx] of Object.entries(HOST_ARTIFACT_EARLIEST_POINT_IDX)) {
    if (artifact === '__proto__' || artifact === 'constructor' || artifact === 'prototype') continue;
    producedAtPoint[artifact] = postIdx;
  }

  // Build a richer per-artifact producer list for the self-consume check.
  // Each entry: { pointIdx, capId, stepIdx } — identifies which cap+step produced the artifact.
  // Host artifacts are seeded separately (no capId) and always satisfy the consume check.
  // capHookProducers[artifact] = [{pointIdx, capId, stepIdx}, ...]
  const capHookProducers = Object.create(null);

  // Add hook-produced artifacts from all capabilities.
  for (const [capId, cap] of capMap) {
    if (cap.role !== 'feature') continue;
    for (let si = 0; si < (cap.steps || []).length; si++) {
      const step = cap.steps[si];
      if (!VALID_LOOP_POINTS.has(step.point)) continue;
      const pointIdx = POINT_ORDER.indexOf(step.point);
      for (const artifact of (step.produces || [])) {
        if (typeof artifact !== 'string') continue;
        if (artifact === '__proto__' || artifact === 'constructor' || artifact === 'prototype') continue;
        if (producedAtPoint[artifact] === undefined || pointIdx < producedAtPoint[artifact]) {
          producedAtPoint[artifact] = pointIdx;
        }
        if (!capHookProducers[artifact]) capHookProducers[artifact] = [];
        capHookProducers[artifact].push({ pointIdx, capId, stepIdx: si });
      }
    }
  }

  // Duplicate-producer invariant: two capability steps may not produce the same artifact
  // at the same Loop Extension Point. Same-point dual production makes data-flow resolution
  // ambiguous and is rejected at gen time (Decision #6).
  for (const artifact of Object.keys(capHookProducers)) {
    if (artifact === '__proto__' || artifact === 'constructor' || artifact === 'prototype') continue;
    const producers = capHookProducers[artifact];
    // Group by pointIdx
    const byPoint = Object.create(null);
    for (const entry of producers) {
      if (!byPoint[entry.pointIdx]) byPoint[entry.pointIdx] = [];
      byPoint[entry.pointIdx].push(entry);
    }
    for (const pointIdxStr of Object.keys(byPoint)) {
      const group = byPoint[pointIdxStr];
      // Count distinct (capId, stepIdx) producer steps — a single step listing the same
      // artifact twice in its produces array pushes duplicate entries but represents only
      // ONE producer step and must not false-positive the cross-step gate.
      const distinctProducers = new Set(group.map((e) => e.capId + ' ' + e.stepIdx));
      if (distinctProducers.size >= 2) {
        const pointIdx = Number(pointIdxStr);
        const pointName = POINT_ORDER[pointIdx];
        const capIds = [...new Set(group.map((e) => e.capId))].sort().join(', ');
        throw new Error(
          'duplicate-producer invariant violated: artifact "' + artifact + '" is produced by ' +
          'two or more capability steps at the same Loop Extension Point "' + pointName + '" ' +
          '(capabilities: ' + capIds + '). ' +
          'Two capability steps producing the same artifact at the same Loop Extension Point ' +
          'makes data-flow resolution ambiguous and is rejected at gen time.',
        );
      }
    }
  }

  // Now check every hook step's consumes.
  // Self-consume rule: a step H cannot satisfy its own consumes[A] from its own produces[A].
  // A is satisfiable for H iff:
  //   (a) A is a host artifact with pointIdx <= stepPointIdx, OR
  //   (b) A is produced by a DIFFERENT cap/step at pointIdx <= stepPointIdx.
  // "Different" means capId != H.capId OR stepIdx != H.stepIdx.
  for (const [capId, cap] of capMap) {
    if (cap.role !== 'feature') continue;
    const prefix = 'capability "' + capId + '"';
    for (let si = 0; si < (cap.steps || []).length; si++) {
      const step = cap.steps[si];
      if (!VALID_LOOP_POINTS.has(step.point)) continue;
      const stepPointIdx = POINT_ORDER.indexOf(step.point);
      for (const artifact of (step.consumes || [])) {
        if (typeof artifact !== 'string') continue;

        // Check host-artifact satisfaction first (never excluded by self-consume).
        const hostIdx = HOST_ARTIFACT_EARLIEST_POINT_IDX[artifact];
        const hostSatisfied = hostIdx !== undefined && hostIdx <= stepPointIdx;
        if (hostSatisfied) continue;  // fast-path: host artifact is available

        // Check cap-hook producers, excluding this step itself.
        const producers = capHookProducers[artifact];
        if (!producers || producers.length === 0) {
          // Not a host artifact and never produced by any hook.
          errors.push(
            prefix + ' step at point "' + step.point + '" consumes "' + artifact +
            '" which is never produced by any host artifact or capability hook',
          );
          continue;
        }

        // Find any non-self producer at pointIdx <= stepPointIdx.
        const otherEarliestIdx = producers.reduce((best, p) => {
          const isSelf = p.capId === capId && p.stepIdx === si;
          if (isSelf) return best;
          return (best === undefined || p.pointIdx < best) ? p.pointIdx : best;
        }, undefined);

        if (otherEarliestIdx === undefined) {
          // Only producer is this step itself — self-consume violation.
          errors.push(
            prefix + ' step at point "' + step.point + '" consumes "' + artifact +
            '" which is only produced by this step itself (a step cannot consume its own output)',
          );
        } else if (otherEarliestIdx > stepPointIdx) {
          errors.push(
            prefix + ' step at point "' + step.point + '" consumes "' + artifact +
            '" which is only produced after this point (earliest available at POINT_ORDER index ' +
            otherEarliestIdx + ' = "' + POINT_ORDER[otherEarliestIdx] + '")',
          );
        }
        // else: satisfied by another cap/step at an earlier-or-same point — OK.
      }
    }
  }

  return errors;
}

// ─── Cross-capability invariants ──────────────────────────────────────────────

const TIER_RANK = { core: 0, standard: 1, full: 2 };

/**
 * Enforce cross-capability invariants.
 *
 * @param {Map<string, object>} capMap     id → validated capability object
 * @param {Set<string>}         centralKeys  Set of keys in the central config-schema
 * @returns {string[]}          Array of error strings; empty = all pass.
 */
function validateCrossCapability(capMap, centralKeys) {
  const errors = [];

  // Ownership: one owner per skill stem + agent name
  const skillOwner = new Map(); // skill → capId
  const agentOwner = new Map(); // agent → capId
  const familyOwner = new Map(); // command family → capId (ADR-959)
  for (const [capId, cap] of capMap) {
    if (cap.role !== 'feature') continue;
    for (const skill of cap.skills) {
      if (skillOwner.has(skill)) {
        errors.push(
          'skill "' + skill + '" is owned by both "' + skillOwner.get(skill) + '" and "' + capId + '"',
        );
      } else {
        skillOwner.set(skill, capId);
      }
    }
    for (const agent of cap.agents) {
      if (agentOwner.has(agent)) {
        errors.push(
          'agent "' + agent + '" is owned by both "' + agentOwner.get(agent) + '" and "' + capId + '"',
        );
      } else {
        agentOwner.set(agent, capId);
      }
    }
    // ADR-959: single family ownership across the whole registry
    if (Array.isArray(cap.commands)) {
      for (const cmd of cap.commands) {
        if (typeof cmd.family !== 'string' || cmd.family.length === 0) continue; // already reported
        if (cmd.family === '__proto__' || cmd.family === 'constructor' || cmd.family === 'prototype') continue;
        if (familyOwner.has(cmd.family)) {
          errors.push(
            'command family "' + cmd.family + '" is owned by both "' + familyOwner.get(cmd.family) + '" and "' + capId + '"',
          );
        } else {
          familyOwner.set(cmd.family, capId);
        }
      }
    }
  }

  // Config key ownership: exclusive AND absent from central schema
  const configKeyOwner = new Map(); // key → capId
  for (const [capId, cap] of capMap) {
    if (cap.role !== 'feature' || typeof cap.config !== 'object' || cap.config === null) continue;
    for (const key of Object.keys(cap.config)) {
      if (configKeyOwner.has(key)) {
        errors.push(
          'config key "' + key + '" is owned by both "' + configKeyOwner.get(key) + '" and "' + capId + '"',
        );
      } else {
        configKeyOwner.set(key, capId);
      }
      if (centralKeys.has(key)) {
        errors.push(
          'config key "' + key + '" is declared in capability "' + capId +
          '" AND exists in the central config-schema — migration mid-flight: ' +
          'remove from central config-schema before adding to the capability',
        );
      }
    }
  }

  // requires: all ids exist
  for (const [capId, cap] of capMap) {
    if (!Array.isArray(cap.requires)) continue;
    for (const req of cap.requires) {
      if (!capMap.has(req)) {
        errors.push(
          'capability "' + capId + '" requires "' + req + '" which does not exist',
        );
      }
    }
  }

  // requires: acyclic
  const cycleErrors = detectRequiresCycles(capMap);
  errors.push(...cycleErrors);

  // requires: tier-monotone (core may not require standard/full; standard may not require full)
  for (const [capId, cap] of capMap) {
    if (!Array.isArray(cap.requires) || !VALID_TIERS.has(cap.tier)) continue;
    const myRank = TIER_RANK[cap.tier];
    for (const req of cap.requires) {
      const reqCap = capMap.get(req);
      if (!reqCap || !VALID_TIERS.has(reqCap.tier)) continue;
      const reqRank = TIER_RANK[reqCap.tier];
      if (reqRank > myRank) {
        errors.push(
          'tier-monotone violation: capability "' + capId + '" (tier: ' + cap.tier +
          ') requires "' + req + '" (tier: ' + reqCap.tier +
          ') — a capability may not require a higher-tier capability',
        );
      }
    }
  }

  return errors;
}

/**
 * Detect cycles in the requires graph using DFS.
 */
function detectRequiresCycles(capMap) {
  const errors = [];
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...capMap.keys()].map((k) => [k, WHITE]));

  function dfs(id, stack) {
    if (color.get(id) === GRAY) {
      const cycleStr = [...stack, id].join(' → ');
      errors.push('requires cycle detected: ' + cycleStr);
      return;
    }
    if (color.get(id) === BLACK) return;
    color.set(id, GRAY);
    stack.push(id);
    const cap = capMap.get(id);
    if (cap && Array.isArray(cap.requires)) {
      for (const req of cap.requires) {
        if (capMap.has(req)) dfs(req, stack);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  }

  for (const id of capMap.keys()) {
    if (color.get(id) === WHITE) dfs(id, []);
  }

  return errors;
}

// ─── requiresClosure ─────────────────────────────────────────────────────────

/**
 * Compute the transitive requires closure for a capability id.
 * Returns a Set<string> of all transitively required capability ids.
 *
 * @param {string}              id
 * @param {Map<string, object>} capMap
 */
function computeRequiresClosure(id, capMap) {
  const visited = new Set();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift();
    const cap = capMap.get(current);
    if (!cap || !Array.isArray(cap.requires)) continue;
    for (const req of cap.requires) {
      if (!visited.has(req)) {
        visited.add(req);
        queue.push(req);
      }
    }
  }
  return visited;
}

// ─── Topological ordering ─────────────────────────────────────────────────────

/**
 * Topologically sort steps at a given point by produces/consumes.
 * Capability-id tiebreak for determinism.
 *
 * @param {{ capId: string, step: object }[]} entries
 * @returns {{ capId: string, step: object }[]}
 */
function topoSortSteps(entries) {
  if (entries.length <= 1) return entries;

  // Build adjacency: entry A must come before entry B if B consumes something A produces
  const n = entries.length;
  const inDegree = new Array(n).fill(0);
  const adj = Array.from({ length: n }, () => []);

  for (let i = 0; i < n; i++) {
    const producesI = new Set(entries[i].step.produces || []);
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const consumesJ = entries[j].step.consumes || [];
      for (const artifact of consumesJ) {
        if (producesI.has(artifact)) {
          adj[i].push(j);
          inDegree[j]++;
          break;
        }
      }
    }
  }

  // Kahn's algorithm with stable tiebreak on capId
  const queue = [];
  for (let i = 0; i < n; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }
  // Sort queue by capId for determinism
  queue.sort((a, b) => entries[a].capId.localeCompare(entries[b].capId));

  const result = [];
  while (queue.length > 0) {
    // Take the first (sorted) ready node
    const idx = queue.shift();
    result.push(entries[idx]);
    const newReady = [];
    for (const neighbor of adj[idx]) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) newReady.push(neighbor);
    }
    newReady.sort((a, b) => entries[a].capId.localeCompare(entries[b].capId));
    queue.push(...newReady);
  }

  // Fix #2: if result.length < n, Kahn's could not complete — there is a produces/consumes
  // cycle. Do NOT silently fall back to declaration order; throw a clear error.
  if (result.length < n) {
    const sortedIds = entries.map((e) => e.capId).join(', ');
    throw new Error(
      'produces/consumes cycle detected in steps at point "' +
      (entries[0] && entries[0].step ? entries[0].step.point : '?') +
      '" among capabilities [' + sortedIds + ']: ' +
      'a cycle in hook produces/consumes prevents deterministic ordering',
    );
  }
  return result;
}

// ─── ADR-857 Phase 4a: Derived views ─────────────────────────────────────────

// FIX 5 (lazy requires): paths are declared at top level but the actual require()
// calls are deferred into lazy accessor functions so importing this generator for
// its other exports does NOT fail at module-load time on a fresh/unbuilt worktree.
const INSTALL_PROFILES_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'install-profiles.cjs');
const CLUSTERS_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'clusters.cjs');

let _installProfilesMod = null;
let _clustersMod = null;

function getInstallProfiles() {
  if (!_installProfilesMod) _installProfilesMod = require(INSTALL_PROFILES_PATH);
  return _installProfilesMod;
}

function getClusters() {
  if (!_clustersMod) _clustersMod = require(CLUSTERS_PATH);
  return _clustersMod;
}

/**
 * Derive capabilityClusters: { <capId>: [<skill stems>] }
 * Each capability's own skills array, sorted for determinism.
 *
 * FIX 3: scope rule = "capabilities that own skills" (non-empty skills array).
 * Both capabilityClusters and profileMembership use this same predicate so a
 * future non-feature role carrying skills is treated identically in both, and a
 * feature cap with no skills appears in neither.
 *
 * @param {Map<string, object>} capMap
 * @returns {object}  Object.create(null) — prototype-pollution safe
 */
function deriveCapabilityClusters(capMap) {
  const result = Object.create(null);
  for (const [capId, cap] of capMap) {
    // S2b: inline literal guard at each write site (CodeQL barrier)
    if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
    // FIX 3: include any cap that owns skills (non-empty skills array), regardless of role
    if (!Array.isArray(cap.skills) || cap.skills.length === 0) continue;
    // Sort for determinism
    const sorted = [...cap.skills].sort();
    result[capId] = sorted;
  }
  return result;
}

/**
 * Derive profileMembership: { <capId>: { tier: <t>, profiles: [<names>] } }
 * profiles = suffix of PROFILE_RANK starting at the capability's tier index.
 *   tier 'core'     → ['core', 'standard', 'full']
 *   tier 'standard' → ['standard', 'full']
 *   tier 'full'     → ['full']
 *
 * FIX 3: scope rule = "capabilities that own skills" (non-empty skills array),
 * consistent with deriveCapabilityClusters. Both derived views cover the same set.
 *
 * FIX 5: tierIdx === -1 means VALID_TIERS and PROFILE_RANK have drifted; throw
 * loudly instead of silently producing ['full'] for the affected capability.
 *
 * @param {Map<string, object>} capMap
 * @returns {object}  Object.create(null) — prototype-pollution safe
 */
function deriveProfileMembership(capMap) {
  const { PROFILE_RANK } = getInstallProfiles();
  const result = Object.create(null);
  for (const [capId, cap] of capMap) {
    // S2b: inline literal guard at each write site (CodeQL barrier)
    if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
    if (!VALID_TIERS.has(cap.tier)) continue;
    // FIX 3: consistent scope — only capabilities that own skills (non-empty skills array)
    if (!Array.isArray(cap.skills) || cap.skills.length === 0) continue;
    const tierIdx = PROFILE_RANK.indexOf(cap.tier);
    // FIX 5: throw loudly on VALID_TIERS/PROFILE_RANK drift (was silent continue)
    if (tierIdx === -1) {
      throw new Error(
        'deriveProfileMembership: capability "' + capId + '" tier "' + cap.tier +
        '" is in VALID_TIERS but not in PROFILE_RANK — VALID_TIERS/PROFILE_RANK drift detected',
      );
    }
    const profiles = PROFILE_RANK.slice(tierIdx);
    result[capId] = { tier: cap.tier, profiles: [...profiles] };
  }
  return result;
}

/**
 * Run consistency gates:
 * - HARD: for each capId that matches a CLUSTERS key, derived skills must match
 *   the hand-authored CLUSTERS[capId] set (order-insensitive). Throws on mismatch.
 * - SOFT: for each capability, for each skill not yet in all non-full profiles it
 *   belongs to (closure-resolved), emit ONE pending-reconciliation warning listing
 *   the missing profiles together. Warnings are collected and returned — NOT thrown.
 *
 * FIX 1: load the REAL skills manifest (same as bin/install.js) so resolveProfile
 * expands requires:-closure. Loaded once and reused across all capabilities.
 *
 * FIX 3: iterate capabilityClusters (which already covers "capabilities that own
 * skills") rather than profileMembership, so both derived views share one scope.
 *
 * FIX 4: one warning per (capability, skill) gap, listing all missing non-full
 * profiles together, instead of one warning per (capability, skill, profile).
 *
 * @param {object} capabilityClusters   From deriveCapabilityClusters()
 * @param {object} profileMembership    From deriveProfileMembership()
 * @param {Map<string, object>} capMap  Original capMap for skill lists
 * @returns {string[]}  Array of pending-reconciliation warning strings
 */
function runConsistencyGate(capabilityClusters, profileMembership, capMap) {
  const { CLUSTERS: clustersObj } = getClusters();
  const { resolveProfile, loadSkillsManifest } = getInstallProfiles();

  // ── HARD gate: cluster set comparison ──────────────────────────────────────
  for (const capId of Object.keys(capabilityClusters)) {
    // S2b: inline literal guard (CodeQL barrier)
    if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
    // Only check if a CLUSTERS entry with the same name exists
    if (!Object.prototype.hasOwnProperty.call(clustersObj, capId)) continue;
    const derivedSet = new Set(capabilityClusters[capId]);
    const handAuthored = clustersObj[capId];
    const handAuthoredSet = new Set(handAuthored);
    // Compare sets (order-insensitive)
    let mismatch = derivedSet.size !== handAuthoredSet.size;
    if (!mismatch) {
      for (const s of derivedSet) {
        if (!handAuthoredSet.has(s)) { mismatch = true; break; }
      }
    }
    if (mismatch) {
      throw new Error(
        'capability-cluster consistency gate FAILED for capId "' + capId + '":\n' +
        '  derived set:      [' + [...derivedSet].sort().join(', ') + ']\n' +
        '  hand-authored set: [' + [...handAuthoredSet].sort().join(', ') + ']\n' +
        'The capability\'s skills array must match the hand-authored CLUSTERS["' + capId + '"] at cutover.',
      );
    }
  }

  // ── SOFT gate: profile reconciliation warnings ─────────────────────────────

  // FIX 1: load the REAL skills manifest once (same path as bin/install.js uses),
  // so resolveProfile expands requires:-closure and the effective set is accurate.
  const commandsGsdDir = path.join(ROOT, 'commands', 'gsd');
  const skillsManifest = loadSkillsManifest(commandsGsdDir);

  // FIX 1: resolve each profile's effective set once and cache — don't reload per-capability.
  const profileEffectiveSetCache = Object.create(null);
  function getEffectiveSet(profileName) {
    if (profileName in profileEffectiveSetCache) return profileEffectiveSetCache[profileName];
    const resolved = resolveProfile({ modes: [profileName], manifest: skillsManifest });
    const effectiveSet = resolved.skills === '*' ? null : resolved.skills;
    profileEffectiveSetCache[profileName] = effectiveSet;
    return effectiveSet;
  }

  const warnings = [];

  // FIX 3: iterate capabilityClusters (same set as profileMembership after FIX 3 scoping).
  for (const capId of Object.keys(capabilityClusters)) {
    // S2b: inline literal guard (CodeQL barrier)
    if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
    const membership = profileMembership[capId];
    if (!membership) continue; // no profile membership (e.g. cap has skills but invalid tier)
    const cap = capMap.get(capId);
    if (!cap || !Array.isArray(cap.skills)) continue;

    // Collect the non-full profiles for this capability
    const nonFullProfiles = membership.profiles.filter((p) => p !== 'full');

    // FIX 4: one warning per (capability, skill) gap — list all missing profiles together
    for (const skill of cap.skills) {
      // S2b: inline literal guard (CodeQL barrier)
      if (skill === '__proto__' || skill === 'constructor' || skill === 'prototype') continue;

      const missingProfiles = [];
      for (const profileName of nonFullProfiles) {
        const effectiveSet = getEffectiveSet(profileName);
        if (effectiveSet === null) continue; // profile resolved to full (unexpected but safe)
        if (!effectiveSet.has(skill)) {
          missingProfiles.push(profileName);
        }
      }

      if (missingProfiles.length > 0) {
        warnings.push(
          '⚠ pending-reconciliation: capability \'' + capId + '\' (tier ' + membership.tier + ')' +
          ' skill \'' + skill + '\' not yet in hand-authored profile(s): <' + missingProfiles.join(', ') +
          '>; add at cutover',
        );
      }
    }
  }

  return warnings;
}

// ─── ADR-857 phase 5e: configFormat ↔ installSurface parity gate ─────────────

// Map: installSurface → expected configFormat
// Derived from the pairing of capability.json descriptors (installSurface)
// and capability.json descriptors (configFormat). DEFECT.GENERATIVE-FIX: this map
// is the single parity contract between the two generated surfaces.
// NOTE: both values come from the descriptor bodies in capMap — no dependency on
// runtime-config-adapter-registry.cjs, which now requires capability-registry.cjs
// (the file this gen-script produces), and thus must not be required here.
const INSTALL_SURFACE_TO_CONFIG_FORMAT = new Map([
  ['settings-json',        'settings-json'],
  ['codex-toml',           'toml'],
  ['copilot-instructions', 'markdown'],
  ['cline-rules',          'markdown-dir'],
  ['cursor-hooks-json',    'none'],
  ['profile-marker-only',  'none'],
]);

/**
 * ADR-857 phase 5e: configFormat ↔ installSurface parity gate.
 *
 * For each runtime capability that has an installSurface in its descriptor,
 * assert that its configFormat matches the expected value derived from its
 * installSurface.  Both values are read directly from the capMap descriptor
 * bodies — no dependency on runtime-config-adapter-registry.cjs.
 *
 * HARD gate — throws on mismatch (DEFECT.GENERATIVE-FIX: this invariant is
 * derived from two parallel generated surfaces and must fail loudly).
 *
 * @param {Map<string, object>} capMap  Fully-validated capability map.
 * @returns {void}  Throws on mismatch; returns normally on success.
 */
function runConfigFormatParityGate(capMap) {
  // Read installSurface directly from the descriptor bodies already loaded into
  // capMap — eliminates the require cycle introduced when adapter-registry was
  // changed to require capability-registry.cjs (ADR-857 phase 5g drive 2).
  for (const [capId, cap] of capMap) {
    if (cap.role !== 'runtime') continue;

    const r = cap.runtime;
    if (!r || typeof r.configFormat !== 'string') continue; // already validated above

    // Only check runtimes that have an installSurface (i.e. are config-adapter runtimes)
    if (typeof r.installSurface !== 'string') continue; // grok etc. excluded — no installSurface

    const installSurface = r.installSurface;
    const expectedConfigFormat = INSTALL_SURFACE_TO_CONFIG_FORMAT.get(installSurface);

    if (expectedConfigFormat === undefined) {
      // Unknown installSurface — the mapping needs to be updated
      throw new Error(
        'configFormat parity gate: runtime "' + capId + '" has installSurface "' + installSurface +
        '" which is not in the INSTALL_SURFACE_TO_CONFIG_FORMAT mapping — ' +
        'update the mapping in scripts/gen-capability-registry.cjs',
      );
    }

    if (r.configFormat !== expectedConfigFormat) {
      throw new Error(
        'configFormat parity gate FAILED for runtime "' + capId + '":\n' +
        '  installSurface:       ' + installSurface + '\n' +
        '  expected configFormat: ' + expectedConfigFormat + '\n' +
        '  actual configFormat:   ' + r.configFormat + '\n' +
        'The capability.json configFormat must match the value derived from installSurface ' +
        '(src: scripts/gen-capability-registry.cjs INSTALL_SURFACE_TO_CONFIG_FORMAT)',
      );
    }
  }
}

// ─── Registry builder ─────────────────────────────────────────────────────────

/**
 * Read + validate all capabilities/<id>/capability.json files.
 * Returns { capMap, errors } where capMap is Map<id, cap>.
 *
 * @param {Set<string>} [centralKeys]   Keys in central config-schema for collision detection.
 *   If omitted, reads from disk. Pass new Set() to skip central-collision checks
 *   (used during 3a-impl while migration is in-progress).
 * @param {string} [capabilitiesDir]    Override capabilities dir (for testing with fixtures).
 */
function loadAndValidate(centralKeys, capabilitiesDir) {
  const resolvedCentralKeys = centralKeys !== undefined ? centralKeys : loadCentralConfigKeys();
  const resolvedCapDir = capabilitiesDir !== undefined ? capabilitiesDir : CAPABILITIES_DIR;
  const errors = [];
  const capMap = new Map();

  if (!fs.existsSync(resolvedCapDir)) {
    return { capMap, errors };
  }

  const folderEntries = fs.readdirSync(resolvedCapDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const folderId of folderEntries) {
    const capPath = path.join(resolvedCapDir, folderId, 'capability.json');
    if (!fs.existsSync(capPath)) continue;

    let cap;
    try {
      cap = JSON.parse(fs.readFileSync(capPath, 'utf8'));
    } catch (err) {
      errors.push(folderId + '/capability.json: JSON parse error: ' + String(err.message));
      continue;
    }

    const capErrors = validateCapability(cap, folderId);
    if (capErrors.length > 0) {
      for (const e of capErrors) errors.push(folderId + '/capability.json: ' + e);
      continue; // skip cross-validation if basic schema fails
    }

    const contractErrors = validateAgainstContract(cap, cap.id);
    if (contractErrors.length > 0) {
      for (const e of contractErrors) errors.push(folderId + '/capability.json: ' + e);
      // Fix #6: do NOT add contract-invalid caps to capMap — validateCrossCapability should
      // only see fully-valid capabilities so its invariants are meaningful.
      continue;
    }

    capMap.set(cap.id, cap);
  }

  // Cross-capability invariants — capMap contains only fully-valid capabilities at this point.
  const crossErrors = validateCrossCapability(capMap, resolvedCentralKeys);
  errors.push(...crossErrors);

  // C2: Global consumes-satisfiability — runs after capMap is fully built so cross-capability
  // produces are visible. A capability with consumes errors is kept in capMap (it passed per-cap
  // validation) but the errors are surfaced so the build fails.
  const consumesErrors = validateConsumesGlobal(capMap);
  errors.push(...consumesErrors);

  return { capMap, errors };
}

/**
 * Build the registry object from a validated capMap.
 *
 * @param {Map<string, object>} capMap
 */
function buildRegistry(capMap) {
  // S2b: Use Object.create(null) for all accumulator maps so prototype-pollution
  // can't touch Object.prototype even if a reserved name slips through validation.
  const capabilities = Object.create(null);
  const bySkill = Object.create(null);
  const byAgent = Object.create(null);
  const byLoopPoint = Object.create(null);
  const configKeys = Object.create(null);
  const configSchema = Object.create(null);
  const runtimes = Object.create(null);

  // Initialize byLoopPoint for all valid points
  for (const point of VALID_LOOP_POINTS) {
    byLoopPoint[point] = { steps: [], contributions: [], gates: [] };
  }

  // Phase 1: collect per-point entries grouped by point
  const pointSteps = new Map(); // point → [{ capId, step }]
  const pointContribs = new Map(); // point → [{ capId, contrib }]
  const pointGates = new Map(); // point → [{ capId, gate }]

  for (const point of VALID_LOOP_POINTS) {
    pointSteps.set(point, []);
    pointContribs.set(point, []);
    pointGates.set(point, []);
  }

  for (const [capId, cap] of capMap) {
    // S2b: inline literal guard at each write site (CodeQL barrier)
    if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
    capabilities[capId] = cap;

    if (cap.role === 'feature') {
      for (const skill of (cap.skills || [])) {
        // S2b: inline literal guard at each write site (CodeQL barrier)
        if (skill === '__proto__' || skill === 'constructor' || skill === 'prototype') continue;
        bySkill[skill] = capId;
      }
      for (const agent of (cap.agents || [])) {
        // S2b: inline literal guard at each write site (CodeQL barrier)
        if (agent === '__proto__' || agent === 'constructor' || agent === 'prototype') continue;
        byAgent[agent] = capId;
      }
      for (const key of Object.keys(cap.config || {})) {
        // S2b: inline literal guard at each write site (CodeQL barrier)
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        configKeys[key] = capId;

        // Build configSchema entry — validate the slice first (throw on violation)
        const slice = (cap.config || {})[key];
        const sliceErrors = validateConfigSliceEntry(capId, key, slice);
        if (sliceErrors.length > 0) {
          throw new Error(
            'configSchema validation failed during registry build:\n' +
            sliceErrors.map((e) => '  ' + e).join('\n'),
          );
        }
        // S2b: inline literal guard for configSchema write site
        if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
          configSchema[key] = {
            owner: capId,
            type: slice.type,
            default: slice.default,
            description: slice.description,
          };
          // Preserve values array for enum types if present
          if (slice.type === 'enum' && Array.isArray(slice.values)) {
            configSchema[key].values = slice.values;
          }
        }
      }

      for (const step of (cap.steps || [])) {
        if (VALID_LOOP_POINTS.has(step.point)) {
          pointSteps.get(step.point).push({ capId, step });
        }
      }
      for (const contrib of (cap.contributions || [])) {
        if (VALID_LOOP_POINTS.has(contrib.point)) {
          // Group contributions by into, then cap-id order
          pointContribs.get(contrib.point).push({ capId, contrib });
        }
      }
      for (const gate of (cap.gates || [])) {
        if (VALID_LOOP_POINTS.has(gate.point)) {
          pointGates.get(gate.point).push({ capId, gate });
        }
      }
    } else if (cap.role === 'runtime') {
      // S2b: inline literal guard at each write site (CodeQL barrier) — capId already guarded above
      runtimes[capId] = cap;
    }
  }

  // Phase 2: materialize ordering
  for (const point of VALID_LOOP_POINTS) {
    // Steps: topological sort by produces/consumes, cap-id tiebreak
    const sortedSteps = topoSortSteps(pointSteps.get(point));
    byLoopPoint[point].steps = sortedSteps.map((e) => ({
      capId: e.capId,
      ...e.step,
    }));

    // Contributions: group by into, then capability-id order within group
    const contribs = pointContribs.get(point);
    contribs.sort((a, b) => {
      const intoCompare = a.contrib.into.localeCompare(b.contrib.into);
      if (intoCompare !== 0) return intoCompare;
      return a.capId.localeCompare(b.capId);
    });
    byLoopPoint[point].contributions = contribs.map((e) => ({
      capId: e.capId,
      ...e.contrib,
    }));

    // Gates: as declared (stable by capId order)
    const gates = pointGates.get(point);
    gates.sort((a, b) => a.capId.localeCompare(b.capId));
    byLoopPoint[point].gates = gates.map((e) => ({
      capId: e.capId,
      ...e.gate,
    }));
  }

  // ── ADR-959: commandFamilies index ─────────────────────────────────────────
  // family → { capId, module, router }
  // Built from all feature capabilities' commands arrays.
  const commandFamilies = Object.create(null);
  for (const [capId, cap] of capMap) {
    // S2b: inline literal guard at each write site (CodeQL barrier)
    if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
    if (cap.role !== 'feature' || !Array.isArray(cap.commands)) continue;
    for (const cmd of cap.commands) {
      if (typeof cmd.family !== 'string' || cmd.family.length === 0) continue;
      // S2b: inline literal guard at family key write site (CodeQL barrier)
      if (cmd.family === '__proto__' || cmd.family === 'constructor' || cmd.family === 'prototype') continue;
      if (typeof cmd.module !== 'string' || cmd.module.length === 0) continue;
      if (typeof cmd.router !== 'string' || cmd.router.length === 0) continue;
      commandFamilies[cmd.family] = { capId, module: cmd.module, router: cmd.router };
    }
  }

  // ── ADR-857 phase 4a: derived views ────────────────────────────────────────
  const capabilityClusters = deriveCapabilityClusters(capMap);
  const profileMembership = deriveProfileMembership(capMap);
  // runConsistencyGate: hard gate throws on mismatch; returns soft warning strings.
  // Warnings are returned in the registry object so callers can emit them to stderr
  // without affecting the serialized file content (determinism gate stays clean).
  const reconciliationWarnings = runConsistencyGate(capabilityClusters, profileMembership, capMap);

  // ADR-857 phase 5e: configFormat ↔ installSurface parity gate.
  // HARD gate — throws on mismatch; SOFT skip if adapter module not loadable.
  runConfigFormatParityGate(capMap);

  return {
    version: SCHEMA_VERSION,
    capabilities,
    bySkill,
    byAgent,
    byLoopPoint,
    configKeys,
    configSchema,
    runtimes,
    commandFamilies,
    capabilityClusters,
    profileMembership,
    // warnings are NOT serialized — returned only for caller consumption via stderr
    _reconciliationWarnings: reconciliationWarnings,
  };
}

// ─── Registry serialization ───────────────────────────────────────────────────

/**
 * Serialize the registry to a CommonJS module string.
 *
 * @param {object} registry   The registry object from buildRegistry()
 * @param {Map<string, object>} capMap  Used for requiresClosure()
 */
function serializeRegistry(registry, capMap) {
  const lines = [];

  lines.push("'use strict';");
  lines.push('');
  lines.push('/**');
  lines.push(' * capability-registry.cjs — generated by scripts/gen-capability-registry.cjs');
  lines.push(' * DO NOT EDIT BY HAND. Run: node scripts/gen-capability-registry.cjs --write');
  lines.push(' * ADR-894 §5 — role-partitioned Capability Registry.');
  lines.push(' */');
  lines.push('');

  // Serialize each section as a variable to keep the file readable
  lines.push('const capabilities = ' + JSON.stringify(registry.capabilities, null, 2) + ';');
  lines.push('');
  lines.push('const bySkill = ' + JSON.stringify(registry.bySkill, null, 2) + ';');
  lines.push('');
  lines.push('const byAgent = ' + JSON.stringify(registry.byAgent, null, 2) + ';');
  lines.push('');
  lines.push('const byLoopPoint = ' + JSON.stringify(registry.byLoopPoint, null, 2) + ';');
  lines.push('');
  lines.push('const configKeys = ' + JSON.stringify(registry.configKeys, null, 2) + ';');
  lines.push('');
  lines.push('const configSchema = ' + JSON.stringify(registry.configSchema, null, 2) + ';');
  lines.push('');
  lines.push('const runtimes = ' + JSON.stringify(registry.runtimes, null, 2) + ';');
  lines.push('');

  // ADR-959: commandFamilies index — sort family keys for determinism.
  const sortedCommandFamilies = Object.create(null);
  const commandFamilyKeys = Object.keys(registry.commandFamilies || {}).sort();
  for (const family of commandFamilyKeys) {
    // S2b: inline literal guard at write site (CodeQL barrier)
    if (family === '__proto__' || family === 'constructor' || family === 'prototype') continue;
    sortedCommandFamilies[family] = registry.commandFamilies[family];
  }
  lines.push('const commandFamilies = ' + JSON.stringify(sortedCommandFamilies, null, 2) + ';');
  lines.push('');

  // ADR-857 phase 4a: derived views — globally sorted capIds for determinism.
  // FIX 2: collect ALL capIds across both views and sort globally so feature + runtime
  // capIds interleave correctly when both are present (phase 5 readiness).
  const allClusterCapIds = new Set(Object.keys(registry.capabilityClusters));
  const allProfileCapIds = new Set(Object.keys(registry.profileMembership));
  const allCapIds = new Set([...allClusterCapIds, ...allProfileCapIds]);
  // FIX 5: inline literal guard at write sites (CodeQL barrier)
  allCapIds.delete('__proto__');
  allCapIds.delete('constructor');
  allCapIds.delete('prototype');
  const globalSortedCapIds = [...allCapIds].sort();

  const sortedCapabilityClusters = Object.create(null);
  for (const capId of globalSortedCapIds) {
    // S2b: inline literal guard at each write site (CodeQL barrier)
    if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
    if (registry.capabilityClusters[capId] !== undefined) {
      sortedCapabilityClusters[capId] = registry.capabilityClusters[capId];
    }
  }
  lines.push('const capabilityClusters = ' + JSON.stringify(sortedCapabilityClusters, null, 2) + ';');
  lines.push('');

  const sortedProfileMembership = Object.create(null);
  for (const capId of globalSortedCapIds) {
    // S2b: inline literal guard at each write site (CodeQL barrier)
    if (capId === '__proto__' || capId === 'constructor' || capId === 'prototype') continue;
    if (registry.profileMembership[capId] !== undefined) {
      sortedProfileMembership[capId] = registry.profileMembership[capId];
    }
  }
  lines.push('const profileMembership = ' + JSON.stringify(sortedProfileMembership, null, 2) + ';');
  lines.push('');

  // Inline the requires graph so requiresClosure() works without re-reading files
  const requiresGraph = {};
  for (const [id, cap] of capMap) {
    requiresGraph[id] = Array.isArray(cap.requires) ? cap.requires : [];
  }
  lines.push('const _requiresGraph = ' + JSON.stringify(requiresGraph, null, 2) + ';');
  lines.push('');

  // requiresClosure function
  lines.push('function requiresClosure(id) {');
  lines.push('  const visited = new Set();');
  lines.push('  const queue = [id];');
  lines.push('  while (queue.length > 0) {');
  lines.push('    const current = queue.shift();');
  lines.push('    const reqs = _requiresGraph[current] || [];');
  lines.push('    for (const req of reqs) {');
  lines.push('      if (!visited.has(req)) {');
  lines.push('        visited.add(req);');
  lines.push('        queue.push(req);');
  lines.push('      }');
  lines.push('    }');
  lines.push('  }');
  lines.push('  return visited;');
  lines.push('}');
  lines.push('');

  lines.push('module.exports = {');
  lines.push("  version: '" + registry.version + "',");
  lines.push('  capabilities,');
  lines.push('  bySkill,');
  lines.push('  byAgent,');
  lines.push('  byLoopPoint,');
  lines.push('  configKeys,');
  lines.push('  configSchema,');
  lines.push('  runtimes,');
  lines.push('  commandFamilies,');
  lines.push('  capabilityClusters,');
  lines.push('  profileMembership,');
  lines.push('  requiresClosure,');
  lines.push('};');
  lines.push('');

  return lines.join('\n');
}

// ─── --check diff helper ──────────────────────────────────────────────────────

/**
 * Compare committed registry with live registry (for --check).
 * Strips the generated comment line for comparison.
 */
function stripGeneratedComment(content) {
  return content
    .split('\n')
    .filter((line) => !line.includes('generated by scripts/gen-capability-registry.cjs'))
    .join('\n');
}

/**
 * Normalize line endings to LF.
 * The generator always writes LF, but Windows git (autocrlf) checks out committed files with
 * CRLF. The --check comparison must be line-ending-agnostic so it only fails on REAL content
 * differences, not on checkout-introduced whitespace differences.
 *
 * @param {string} content
 * @returns {string}
 */
function normalizeLineEndings(content) {
  return content.replace(/\r/g, '');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Fix #3: Emit pending-migration WARNINGs for config keys that collide with the central
 * config-schema. Per ADR-894 staged cutover, a collision during the registry-only phase is
 * NOT a hard error — the capability pipeline is being established before the atomic cutover
 * PR for each feature. The registry still generates; the warning tells the maintainer which
 * keys need to be moved out of the central schema at cutover time.
 *
 * A NEW unexpected collision (a key that shouldn't be in both) is also surfaced — the
 * maintainer sees it in build output rather than it being silently swallowed.
 *
 * Reference: ADR-894 §4 "config-key ownership exclusive AND complete — presence in both =
 * collision = a mid-flight migration; finish the move."
 *
 * @param {string[]} crossErrors   Errors from validateCrossCapability (may include collision msgs)
 * @param {Map<string, object>} capMap
 * @returns {{ hardErrors: string[], pendingMigrationWarnings: string[] }}
 */
function classifyCrossErrors(crossErrors) {
  const hardErrors = [];
  const pendingMigrationWarnings = [];
  const collisionRe = /config key "([^"]+)" is declared in capability "([^"]+)" AND exists in the central config-schema/;

  for (const e of crossErrors) {
    const m = collisionRe.exec(e);
    if (m) {
      // Collision = pending-migration warning, not a hard error during 3a-impl staged cutover
      pendingMigrationWarnings.push(
        '⚠ pending-migration: capability \'' + m[2] + '\' declares config key \'' + m[1] +
        '\' still present in central config-schema; finish the move at cutover',
      );
    } else {
      hardErrors.push(e);
    }
  }
  return { hardErrors, pendingMigrationWarnings };
}

function main() {
  const flag = process.argv[2];

  if (flag === '--check') {
    // Fix #3: read the REAL central config keys so collision detection fires and is visible.
    const centralKeys = loadCentralConfigKeys();
    const { capMap, errors } = loadAndValidate(centralKeys);

    // Separate pending-migration warnings from hard errors
    const { hardErrors, pendingMigrationWarnings } = classifyCrossErrors(errors);
    for (const w of pendingMigrationWarnings) process.stderr.write(w + '\n');
    if (hardErrors.length > 0) {
      for (const e of hardErrors) process.stderr.write('  ERROR  ' + e + '\n');
      throw new ExitError(1, 'capability validation failed (' + hardErrors.length + ' error(s))');
    }

    const registry = buildRegistry(capMap);
    // ADR-857 phase 4a: emit pending-reconciliation warnings to stderr only
    // (they do NOT affect the generated file content, so --check stays clean)
    for (const w of (registry._reconciliationWarnings || [])) process.stderr.write(w + '\n');
    const live = serializeRegistry(registry, capMap);

    if (!fs.existsSync(REGISTRY_PATH)) {
      process.stderr.write(
        'gsd-core/bin/lib/capability-registry.cjs does not exist. Run:\n' +
        '  node scripts/gen-capability-registry.cjs --write\n',
      );
      throw new ExitError(1);
    }

    const committed = fs.readFileSync(REGISTRY_PATH, 'utf8');
    if (normalizeLineEndings(stripGeneratedComment(committed)) !== normalizeLineEndings(stripGeneratedComment(live))) {
      process.stderr.write(
        'gsd-core/bin/lib/capability-registry.cjs is stale. Run:\n' +
        '  node scripts/gen-capability-registry.cjs --write\n',
      );
      throw new ExitError(1);
    }

    process.stdout.write('gsd-core/bin/lib/capability-registry.cjs is up to date.\n');
  } else if (flag === '--write') {
    // Fix #3: read the REAL central config keys so collision detection fires and is visible.
    const centralKeys = loadCentralConfigKeys();
    const { capMap, errors } = loadAndValidate(centralKeys);

    // Separate pending-migration warnings from hard errors
    const { hardErrors, pendingMigrationWarnings } = classifyCrossErrors(errors);
    for (const w of pendingMigrationWarnings) process.stderr.write(w + '\n');
    if (hardErrors.length > 0) {
      for (const e of hardErrors) process.stderr.write('  ERROR  ' + e + '\n');
      throw new ExitError(1, 'capability validation failed — registry not written');
    }

    const registry = buildRegistry(capMap);
    // ADR-857 phase 4a: emit pending-reconciliation warnings to stderr only
    for (const w of (registry._reconciliationWarnings || [])) process.stderr.write(w + '\n');
    const content = serializeRegistry(registry, capMap);
    // Fix #5: mkdir-p before writing so --write doesn't ENOENT in a fresh worktree.
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(REGISTRY_PATH, content, 'utf8');
    process.stdout.write('Wrote ' + REGISTRY_PATH + '\n');
  } else {
    // Default: print to stdout — use real central keys for visibility
    const centralKeys = loadCentralConfigKeys();
    const { capMap, errors } = loadAndValidate(centralKeys);

    const { hardErrors, pendingMigrationWarnings } = classifyCrossErrors(errors);
    for (const w of pendingMigrationWarnings) process.stderr.write(w + '\n');
    if (hardErrors.length > 0) {
      for (const e of hardErrors) process.stderr.write('  ERROR  ' + e + '\n');
      throw new ExitError(1, 'capability validation failed');
    }
    const registry = buildRegistry(capMap);
    // ADR-857 phase 4a: emit pending-reconciliation warnings to stderr only
    for (const w of (registry._reconciliationWarnings || [])) process.stderr.write(w + '\n');
    process.stdout.write(serializeRegistry(registry, capMap) + '\n');
  }
}

// ─── Exports (for tests) ──────────────────────────────────────────────────────

module.exports = {
  validateCapability,
  validateAgainstContract,
  validateConsumesGlobal,
  validateCrossCapability,
  classifyCrossErrors,
  loadCentralConfigKeys,
  loadAndValidate,
  buildRegistry,
  serializeRegistry,
  computeRequiresClosure,
  topoSortSteps,
  normalizeLineEndings,
  validateConfigSliceEntry,
  VALID_CONFIG_SLICE_TYPES,
  LOOP_HOST_CONTRACT,
  VALID_LOOP_POINTS,
  POINT_ORDER,
  POINT_TO_CONTRACT,
  HOST_ARTIFACT_EARLIEST_POINT_IDX,
  SCHEMA_VERSION,
  // ADR-857 phase 4a: derived views + gates
  deriveCapabilityClusters,
  deriveProfileMembership,
  runConsistencyGate,
  // ADR-959: command entry validation
  validateCommandEntry,
  // ADR-1016 phase 5a: runtime body validators + closed-vocab sets
  validateConfigHome,
  validateArtifactLayout,
  validateArtifactKindEntry,
  VALID_CONFIG_HOME_KINDS,
  VALID_COMMAND_STYLES,
  VALID_HOOKS_SURFACES,
  VALID_HOOK_EVENTS,
  VALID_SANDBOX_TIERS,
  VALID_ARTIFACT_KIND_NAMES,
  VALID_ARTIFACT_NESTINGS,
  // ADR-857 phase 5e: closed ConverterName enum
  VALID_CONVERTER_NAMES,
  // ADR-857 phase 5e: configFormat ↔ installSurface parity gate
  runConfigFormatParityGate,
  INSTALL_SURFACE_TO_CONFIG_FORMAT,
  // ADR-857 phase 5f: cross-field consistency gates
  INSTALL_SURFACE_TO_ALLOWED_HOOKS_SURFACES,
  VALID_INSTALL_SURFACES,
  VALID_EXTENDED_HOOK_EVENTS,
  VALID_PERMISSION_WRITERS,
  validateRuntimeBody,
  // FIX 5 (lazy): PROFILE_RANK and CLUSTERS are loaded on first access via getters
  // so importing the generator on a fresh/unbuilt worktree doesn't fail at module load.
  get PROFILE_RANK() { return getInstallProfiles().PROFILE_RANK; },
  get CLUSTERS() { return getClusters().CLUSTERS; },
};

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  runMain(main);
}
