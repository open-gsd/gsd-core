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
// Inline constant — hardcoded from ADR-894 §3 (12 points + per-step agentRoles +
// coreArtifacts). This represents the host contract that will be generated from
// workflow markers once the workflow-marker infrastructure is in place.
//
// TODO 3a-impl-2: replace this constant with the generated-from-workflows host
// contract (ADR-894 §3). The workflow markers (<loop-point>, <agent-role>,
// <loop-artifact>) must be authored in each of the five step workflows; the
// gen-loop-host-contract.cjs generator will parse them and produce this object.
const LOOP_HOST_CONTRACT = [
  {
    step: 'discuss',
    points: ['discuss:pre', 'discuss:post'],
    agentRoles: ['orchestrator'],
    coreArtifacts: {
      produces: ['CONTEXT.md'],
      consumes: [],
    },
  },
  {
    step: 'plan',
    points: ['plan:pre', 'plan:post'],
    agentRoles: ['researcher', 'planner', 'checker'],
    coreArtifacts: {
      produces: ['PLAN.md'],
      consumes: ['CONTEXT.md'],
    },
  },
  {
    step: 'execute',
    points: ['execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post'],
    agentRoles: ['executor', 'verifier'],
    coreArtifacts: {
      produces: ['SUMMARY.md'],
      consumes: ['PLAN.md'],
    },
  },
  {
    step: 'verify',
    points: ['verify:pre', 'verify:post'],
    agentRoles: ['orchestrator'],
    coreArtifacts: {
      produces: ['UAT.md'],
      consumes: ['SUMMARY.md'],
    },
  },
  {
    step: 'ship',
    points: ['ship:pre', 'ship:post'],
    agentRoles: ['orchestrator'],
    coreArtifacts: {
      produces: [],
      consumes: ['UAT.md'],
    },
  },
];

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
 * TODO: distinguish file-not-found (ok, return empty Set) from JSON-parse-error
 * (should warn — a parse error means the schema is broken, not just absent).
 */
function loadCentralConfigKeys() {
  try {
    const manifest = JSON.parse(fs.readFileSync(CONFIG_SCHEMA_PATH, 'utf8'));
    return new Set(Array.isArray(manifest.validKeys) ? manifest.validKeys : []);
  } catch (_) {
    return new Set();
  }
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

  if (!Array.isArray(cap.steps)) {
    errors.push('steps must be an array');
  } else {
    for (let i = 0; i < cap.steps.length; i++) {
      errors.push(...validateStep(cap.steps[i], 'steps[' + i + ']'));
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

// C3: Validate role:runtime body
const VALID_CONFIG_FORMATS = new Set(['settings-json', 'toml', 'markdown', 'markdown-dir', 'none']);
const FEATURE_FIELDS_FORBIDDEN_ON_RUNTIME = ['skills', 'agents', 'steps', 'contributions', 'gates', 'hooks'];

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
  if (typeof r.configHome !== 'string' || r.configHome.length === 0) {
    errors.push('runtime.configHome must be a non-empty string');
  }
  if (!VALID_CONFIG_FORMATS.has(r.configFormat)) {
    errors.push('runtime.configFormat must be one of: ' + [...VALID_CONFIG_FORMATS].join(', ') + ' (got: ' + r.configFormat + ')');
  }
  if (!Array.isArray(r.artifactLayout)) {
    errors.push('runtime.artifactLayout must be an array');
  }
  if (typeof r.commandStyle !== 'string' || r.commandStyle.length === 0) {
    errors.push('runtime.commandStyle must be a non-empty string');
  }
  if (typeof r.hooksSurface !== 'string' || r.hooksSurface.length === 0) {
    errors.push('runtime.hooksSurface must be a non-empty string');
  }
  if (typeof r.sandboxTier !== 'string' || r.sandboxTier.length === 0) {
    errors.push('runtime.sandboxTier must be a non-empty string');
  }
  if (r.supportTier !== 1 && r.supportTier !== 2) {
    errors.push('runtime.supportTier must be 1 or 2 (got: ' + r.supportTier + ')');
  }

  return errors;
}

function validateStep(step, prefix) {
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
    }
    if (hasAgent && typeof step.ref.agent !== 'string') {
      errors.push(prefix + '.ref.agent must be a string');
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

  // TODO: duplicate-producer invariant — if two capability steps produce the same artifact
  // at the same point, that's ambiguous. Detect and reject as a follow-up.

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

  return {
    version: SCHEMA_VERSION,
    capabilities,
    bySkill,
    byAgent,
    byLoopPoint,
    configKeys,
    runtimes,
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
  lines.push('const runtimes = ' + JSON.stringify(registry.runtimes, null, 2) + ';');
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
  lines.push('  runtimes,');
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
    const live = serializeRegistry(registry, capMap);

    if (!fs.existsSync(REGISTRY_PATH)) {
      process.stderr.write(
        'gsd-core/bin/lib/capability-registry.cjs does not exist. Run:\n' +
        '  node scripts/gen-capability-registry.cjs --write\n',
      );
      throw new ExitError(1);
    }

    const committed = fs.readFileSync(REGISTRY_PATH, 'utf8');
    if (stripGeneratedComment(committed) !== stripGeneratedComment(live)) {
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
  loadAndValidate,
  buildRegistry,
  serializeRegistry,
  computeRequiresClosure,
  topoSortSteps,
  LOOP_HOST_CONTRACT,
  VALID_LOOP_POINTS,
  POINT_ORDER,
  POINT_TO_CONTRACT,
  HOST_ARTIFACT_EARLIEST_POINT_IDX,
  SCHEMA_VERSION,
};

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  runMain(main);
}
