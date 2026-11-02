'use strict';
// hooks/lib/agent-model-check.js — #5328: does the model a model-authored
// Agent()/Task() call passes match the one GSD resolved for that agent?
// Baseline is resolveModelInternal over the workstream the hook resolves at dispatch: GSD_WORKSTREAM > stored pointer,
// as `init` does without --ws. A workstream selected only with --ws is not visible to the hook (ADR-5328 Decision 2).
// A fresh `resolve-execution --attempt N` record (gsd-core/bin/lib/model-escalation.cjs; the same session when both sides know one) legitimises the escalated model.
// Never fails closed: any inability to verify is an allow.

const path = require('path');
const { resolveSentinelRoot } = require('./isolation-sentinel.js');
const { REASON_INTERPOLATION_MAX_LEN } = require('./isolation-deny-reason.js');

const ALLOW = { action: 'allow' };

// Literal copy of model-escalation's GUARDED_AGENT_TYPES so every other subagent dispatch is
// allowed before the runtime build seam and the built artifact load; a test pins the two equal.
const GUARDED_TYPES = new Set(['gsd-executor', 'gsd-verifier', 'gsd-plan-checker', 'gsd-planner']);

// `hooks.agent_model_guard`, from the root config only and parsed as strict JSON, like the other hooks.* keys.
// A config this cannot read is an inability to verify, which allows (ADR-5328 Decision 2).
function readGuardMode(root, maxBytes) {
  const text = require('../../gsd-core/bin/lib/capability-ledger.cjs').readSmallRegularFile(path.join(root, '.planning', 'config.json'), maxBytes);
  return text === null ? { skip: true } : { mode: (JSON.parse(text).hooks || {}).agent_model_guard };
}

// An omitted model is denied too: no stock agent pins a model in its frontmatter, so the subagent
// would inherit the orchestrator's model, which is the drift #5328 reports.
// tool_input.model is model-authored and the expected model comes from repo config: both keep only the model-id
// charset (MODEL_ID_CHARSET_BODY) plus `[` `]` for the host's `[1m]` context-window suffix, capped, before they reach
// additionalContext. (No product name here: this file installs to every runtime, tests/install.test.cjs:723.)
function verdict(esc, mode, type, rawPassed, rawExpected) {
  const strip = new RegExp(`[^[\\]${esc.MODEL_ID_CHARSET_BODY}]`, 'g');
  const sanitise = (s) => s.replace(strip, '?').slice(0, REASON_INTERPOLATION_MAX_LEN);
  const passed = sanitise(rawPassed);
  const expected = sanitise(rawExpected);
  return {
    action: mode === 'deny' ? 'block' : 'warn',
    passed,
    expected,
    reason: `Agent model guard: subagent_type="${type}" ${passed ? `was passed model="${passed}"` : 'was passed no model'}, ` +
      `but GSD resolved model="${expected}" for it. Pass model="${expected}" (or, when dynamic_routing escalates ` +
      `tiers or a quota --failure-class applies, run \`resolve-execution ${type} --attempt N\` first to escalate deliberately).`,
  };
}

/**
 * @returns {{action:'allow'}|{action:'warn'|'block', passed:string, expected:string, reason:string}}
 * `passed` and `expected` are the sanitised values `reason` renders ('' = no model passed).
 */
function checkAgentModel(data, { clock } = {}) {
  try {
    if (!data || (data.tool_name !== 'Agent' && data.tool_name !== 'Task')) return ALLOW;
    const toolInput = data.tool_input;
    const type = toolInput && toolInput.subagent_type;
    if (typeof type !== 'string' || !GUARDED_TYPES.has(type)) return ALLOW;

    // #3582 seam (lint-hooks-runtime-build-seam), but never compile here: on a cold tree
    // tscScript null throws (caught below: allow) instead of running tsc inside the hook.
    require('../../gsd-core/bin/ensure-runtime-build.cjs').ensureRuntimeBuild({ tscScript: null });
    const esc = require('../../gsd-core/bin/lib/model-escalation.cjs');

    const root = resolveSentinelRoot(data.cwd || process.cwd());
    const { mode, skip } = readGuardMode(root, esc.MAX_READ_BYTES);
    if (skip || mode === false) return ALLOW;

    // The workstream `init` resolves without --ws (GSD_WORKSTREAM > stored pointer, read-only peek, as the
    // gsd-tools dispatcher and gsd-statusline do), carried in GSD_WORKSTREAM into loadConfig and planningDir.
    // The pointer is keyed by the dispatching session: the payload's session_id, which the host also exports to
    // `init` as CLAUDE_CODE_SESSION_ID; the WORKSTREAM_SESSION_ENV_KEYS entries ranked above it are cleared for the
    // lookup. The caller's environment is restored in `finally`.
    const store = require('../../gsd-core/bin/lib/active-workstream-store.cjs');
    const session = typeof data.session_id === 'string' && data.session_id ? data.session_id : undefined;
    const keys = store.WORKSTREAM_SESSION_ENV_KEYS;
    const outranking = keys.slice(0, keys.indexOf('CLAUDE_CODE_SESSION_ID'));
    const saved = Object.fromEntries(['GSD_WORKSTREAM', 'CLAUDE_CODE_SESSION_ID', ...outranking].map((k) => [k, process.env[k]]));
    try {
      if (session !== undefined) {
        for (const k of outranking) delete process.env[k];
        process.env.CLAUDE_CODE_SESSION_ID = session;
      }
      store.applyResolvedWorkstreamEnv(store.resolveActiveWorkstream(root, [], process.env, { getStored: store.peekActiveWorkstream }), process.env);
      const resolver = require('../../gsd-core/bin/lib/model-resolver.cjs');
      const config = require('../../gsd-core/bin/lib/config-loader.cjs').loadConfig(root, { persist: false });
      // Only where the host resolves the tier aliases GSD resolves to, over the one runtime chain
      // (GSD_RUNTIME > config.runtime > marker), from the config the expected model resolves through.
      if (!resolver.hasNativeModelAliases(require('../../gsd-core/bin/lib/runtime-slash.cjs').resolveActiveRuntime(config))) return ALLOW;
      const expected = resolver.resolveModelInternal(root, type, { persist: false });
      if (!expected || expected === 'inherit') return ALLOW;

      const passed = typeof toolInput.model === 'string' ? toolInput.model : '';
      if (passed && esc.modelFamily(passed) === esc.modelFamily(expected)) return ALLOW;
      if (passed) {
        // realClock honours the GSD_TEST_MODE + GSD_NOW_MS pin in a hook subprocess (RULESET.TESTS.clock-seam).
        const now = (clock || require('../../gsd-core/bin/lib/clock.cjs').realClock).now();
        if (esc.escalationAllows(esc.readEscalation(root, type), passed, { now, session })) return ALLOW;
      }
      return verdict(esc, mode, type, passed, expected);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  } catch {
    return ALLOW;
  }
}

module.exports = { checkAgentModel, GUARDED_TYPES };
