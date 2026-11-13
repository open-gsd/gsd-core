'use strict';
// hooks/lib/agent-model-check.js — #5328: does the model a model-authored
// Agent()/Task() call passes match the one GSD resolved for that agent?
// Baseline: resolveModelInternal for the workstreams `init` used, recomputed at dispatch (ADR-5328 Decision 2): each
// one an `init --ws` of this session recorded (docs/adr/5328-agent-model-guard-workstream-carry.md), and the one
// GSD_WORKSTREAM or the stored pointer selects. A carry with an expired entry cannot establish the workstream: allow.
// A fresh `resolve-execution --attempt N` record (gsd-core/bin/lib/model-escalation.cjs;
// the same session when both sides know one) legitimises the escalated model.
// Never fails closed: any inability to verify is an allow.

const { resolveSentinelRoot } = require('./isolation-sentinel.js');
const { REASON_INTERPOLATION_MAX_LEN } = require('./isolation-deny-reason.js');

const ALLOW = { action: 'allow' };

// Literal copy of model-escalation's GUARDED_AGENT_TYPES so every other subagent dispatch is
// allowed before the runtime build seam and the built artifact load; a test pins the two equal.
const GUARDED_TYPES = new Set(['gsd-executor', 'gsd-verifier', 'gsd-plan-checker', 'gsd-planner']);

// An omitted model is denied too: no stock agent pins a model in its frontmatter, so the subagent
// would inherit the orchestrator's model, which is the drift #5328 reports.
// tool_input.model is model-authored and the expected model comes from repo config: both keep only the model-id
// charset (MODEL_ID_CHARSET_BODY) plus `[` `]` for the host's `[1m]` context-window suffix, capped, before they reach
// additionalContext. (No product name here: this file installs to every runtime, tests/install.test.cjs:723.)
// `rawExpected` is every baseline's model (the recorded workstreams' and the unflagged one's): the text names each, so a
// dispatch on the root workstream is not told to use another workstream's model.
function verdict(esc, mode, type, rawPassed, rawExpected) {
  const strip = new RegExp(`[^[\\]${esc.MODEL_ID_CHARSET_BODY}]`, 'g');
  const sanitise = (s) => s.replace(strip, '?').slice(0, REASON_INTERPOLATION_MAX_LEN);
  const passed = sanitise(rawPassed);
  const models = [...new Set(rawExpected.map(sanitise))];
  const named = models.map((m) => `model="${m}"`).join(' or ');
  return {
    action: mode === 'deny' ? 'block' : 'warn',
    passed,
    expected: models.join(' or '),
    reason: `Agent model guard: subagent_type="${type}" ${passed ? `was passed model="${passed}"` : 'was passed no model'}, ` +
      `but GSD resolved ${named}. Pass ${models.length > 1 ? 'one of them' : 'it'} (or, when dynamic_routing escalates ` +
      `tiers or a quota --failure-class applies, run \`resolve-execution ${type} --attempt N\` first to escalate deliberately).`,
  };
}

// The expected model for `type` under the workstream `args` select (['--ws', name], or [] for
// GSD_WORKSTREAM > the stored pointer): `undefined` where the guard does not apply under that candidate's
// runtime (no native tier aliases there; the candidate contributes no baseline), `null` where the model is
// unresolved or `inherit` (cannot verify). The pointer is keyed by the dispatching session: the
// payload's session_id, which the host also exports to `init` as CLAUDE_CODE_SESSION_ID; the
// WORKSTREAM_SESSION_ENV_KEYS entries ranked above it are cleared for the lookup. The caller's
// environment is restored in `finally`, so every candidate starts from it.
function baselineFor(store, root, type, session, args) {
  const keys = store.WORKSTREAM_SESSION_ENV_KEYS;
  const outranking = keys.slice(0, keys.indexOf('CLAUDE_CODE_SESSION_ID'));
  const saved = Object.fromEntries(['GSD_WORKSTREAM', 'CLAUDE_CODE_SESSION_ID', ...outranking].map((k) => [k, process.env[k]]));
  try {
    if (session !== undefined) {
      for (const k of outranking) delete process.env[k];
      process.env.CLAUDE_CODE_SESSION_ID = session;
    }
    store.applyResolvedWorkstreamEnv(store.resolveActiveWorkstream(root, args, process.env, { getStored: store.peekActiveWorkstream }), process.env);
    const resolver = require('../../gsd-core/bin/lib/model-resolver.cjs');
    // Only where the guard applies under this candidate's workstream (model-escalation guardApplies, shared with `init --ws`).
    if (!require('../../gsd-core/bin/lib/model-escalation.cjs').guardApplies(root)) return undefined;
    const expected = resolver.resolveModelInternal(root, type, { persist: false });
    return expected && expected !== 'inherit' ? expected : null;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
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
    const { mode, skip } = esc.readGuardMode(root);
    if (skip || mode === false) return ALLOW;

    const store = require('../../gsd-core/bin/lib/active-workstream-store.cjs');
    const session = typeof data.session_id === 'string' && data.session_id ? data.session_id : undefined;
    // Where workstreams exist, a dispatch without a session id cannot establish the workstream `init` used: allow.
    if (session === undefined && require('../../gsd-core/bin/lib/planning-workspace.cjs').listAvailableWorkstreams(root).length > 0) return ALLOW;
    // realClock honours the GSD_TEST_MODE + GSD_NOW_MS pin in a hook subprocess (RULESET.TESTS.clock-seam).
    const now = (clock || require('../../gsd-core/bin/lib/clock.cjs').realClock).now();
    const carried = store.peekInitWorkstream(root, session, now);
    // A carry with an expired or unparseable entry: the run it stands for may still dispatch, so the workstream `init` used cannot be established, as with no session id.
    if (carried && carried.length === 0) return ALLOW;
    const expected = [];
    for (const args of [...(carried || []).map((ws) => ['--ws', ws]), []]) {
      const model = baselineFor(store, root, type, session, args);
      if (model === undefined) continue;
      if (model === null) return ALLOW;
      expected.push(model);
    }
    if (expected.length === 0) return ALLOW;

    const passed = typeof toolInput.model === 'string' ? toolInput.model : '';
    if (passed && expected.some((m) => esc.modelFamily(m) === esc.modelFamily(passed))) return ALLOW;
    if (passed) {
      if (esc.escalationAllows(esc.readEscalation(root, type), passed, { now, session })) return ALLOW;
    }
    return verdict(esc, mode, type, passed, expected);
  } catch {
    return ALLOW;
  }
}

module.exports = { checkAgentModel, GUARDED_TYPES };
