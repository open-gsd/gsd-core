'use strict';
// hooks/lib/agent-model-check.js — #5328: does the model a model-authored
// Agent()/Task() call passes match the one GSD resolved for that agent?
// Baseline is resolveModelInternal (what `init` reports and the workflow
// tells the model to pass). A fresh, session-matching `resolve-execution
// --attempt N` record (gsd-core/bin/lib/model-escalation.cjs) legitimises
// the escalated model. Never fails closed: any inability to verify is an allow.

const path = require('path');
const { resolveSentinelRoot } = require('./isolation-sentinel.js');
const { REASON_INTERPOLATION_MAX_LEN } = require('./isolation-deny-reason.js');

const ALLOW = { action: 'allow' };

// Size bound for the .planning/config.json read (64 KiB; same value as the escalation-record bound).
const CONFIG_MAX_READ_BYTES = 64 * 1024;

// Strict JSON on purpose: a config this cannot parse (comments, trailing commas) fails open.
// Runs only where the host resolves the tier aliases GSD resolves to (hostBehaviors.nativeModelAliases,
// the fact model-resolver gates on), via the one runtime chain (GSD_RUNTIME > config.runtime > marker).
// `mode` is read from the root config only, like the other hooks.* keys; the runtime comes from the same
// workstream-aware loadConfig(root) the expected-model path resolves through, so both agree on it.
function readGuardMode(root) {
  const text = require('../../gsd-core/bin/lib/capability-ledger.cjs').readSmallRegularFile(path.join(root, '.planning', 'config.json'), CONFIG_MAX_READ_BYTES);
  if (text === null) return { skip: true };
  const mode = (JSON.parse(text).hooks || {}).agent_model_guard;
  const runtime = require('../../gsd-core/bin/lib/runtime-slash.cjs').resolveActiveRuntime(require('../../gsd-core/bin/lib/config-loader.cjs').loadConfig(root, { persist: false }));
  const native = require('../../gsd-core/bin/lib/runtime-name-policy.cjs').hostBehaviorsFor(runtime).nativeModelAliases === true;
  return { mode, skip: mode === false || !native };
}

// The model GSD resolved for `type`, or null when none applies (inherit). Loads the config a second
// time (readGuardMode did too): resolveModelInternal takes loadOptions, not a loaded config, and a
// new param for this one caller is not worth the saved read.
function resolveExpected(root, type) {
  const expected = require('../../gsd-core/bin/lib/model-resolver.cjs').resolveModelInternal(root, type, { persist: false });
  return !expected || expected === 'inherit' ? null : expected;
}

// tool_input.model is model-authored and the expected model comes from repo config:
// cap both and keep only id-shaped characters before they reach additionalContext.
// `@` keeps Vertex ids (`claude-opus-4-1@20250805`) intact; anything past the cap is cut.
const sanitiseModelId = (s) => s.replace(/[^\w.:@/[\]-]/g, '?').slice(0, REASON_INTERPOLATION_MAX_LEN);

// Only a passed, wrong model is denied: the hook cannot see the orchestrator's model, so an
// omitted one (the subagent inherits it) may well match and stays a warning even under deny.
function verdict(mode, type, rawPassed, rawExpected) {
  const passed = sanitiseModelId(rawPassed);
  const expected = sanitiseModelId(rawExpected);
  return {
    action: mode === 'deny' && passed ? 'block' : 'warn',
    passed,
    expected,
    reason: `Agent model guard: subagent_type="${type}" ${passed ? `was passed model="${passed}"` : 'was passed no model'}, ` +
      `but GSD resolved model="${expected}" for it. Pass model="${expected}" (or run ` +
      `\`resolve-execution ${type} --attempt N\` first to escalate deliberately).`,
  };
}

/**
 * @returns {{action:'allow'}|{action:'warn'|'block', passed:string, expected:string, reason:string}}
 * `passed` and `expected` are the sanitised values `reason` renders ('' = no model passed).
 */
function checkAgentModel(data, { clock = Date } = {}) {
  try {
    if (!data || (data.tool_name !== 'Agent' && data.tool_name !== 'Task')) return ALLOW;
    const toolInput = data.tool_input;
    const type = toolInput && toolInput.subagent_type;
    if (typeof type !== 'string') return ALLOW;

    // #3582 seam (lint-hooks-runtime-build-seam), but never compile here: on a cold tree
    // tscScript null throws (caught below: allow) instead of running tsc inside the hook.
    require('../../gsd-core/bin/ensure-runtime-build.cjs').ensureRuntimeBuild({ tscScript: null });
    const esc = require('../../gsd-core/bin/lib/model-escalation.cjs');
    if (!esc.GUARDED_AGENT_TYPES.has(type)) return ALLOW;

    const root = resolveSentinelRoot(data.cwd || process.cwd());
    const { mode, skip } = readGuardMode(root);
    if (skip) return ALLOW;
    const expected = resolveExpected(root, type);
    if (!expected) return ALLOW;

    const passed = typeof toolInput.model === 'string' ? toolInput.model : '';
    if (passed && esc.modelFamily(passed) === esc.modelFamily(expected)) return ALLOW;
    if (passed) {
      const session = typeof data.session_id === 'string' && data.session_id ? data.session_id : undefined;
      if (esc.escalationAllows(esc.readEscalation(root, type), passed, { now: clock.now(), session })) return ALLOW;
    }
    return verdict(mode, type, passed, expected);
  } catch {
    return ALLOW;
  }
}

module.exports = { checkAgentModel };
