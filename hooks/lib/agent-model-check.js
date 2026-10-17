'use strict';
// hooks/lib/agent-model-check.js — #5328: does the model a model-authored
// Agent()/Task() call passes match the one GSD resolved for that agent?
// Baseline is resolveModelInternal (what `init` records and the workflow
// tells the model to pass). A fresh `resolve-execution --attempt N` record
// (.gsd/model-escalation-<agent>.json) legitimises the escalated model.
// Never fails closed: any inability to verify is an allow.

const fs = require('fs');
const path = require('path');
const { resolveSentinelRoot, SENTINEL_STALE_MS } = require('./isolation-sentinel.js');

const GUARDED_AGENT_TYPES = new Set(['gsd-executor', 'gsd-verifier', 'gsd-plan-checker', 'gsd-planner']);
const escalationPath = (root, type) => path.join(root, '.gsd', `model-escalation-${type}.json`);

// Compare at tier-alias level: `claude-sonnet-4-6` and `sonnet` are the same.
const family = (m) => {
  const s = String(m).toLowerCase();
  return /(?:^|[^a-z0-9])(opus|sonnet|haiku|fable)(?:$|[^a-z])/.exec(s)?.[1] ?? s;
};

/**
 * @returns {{action:'allow'}|{action:'warn'|'block', reason:string}}
 */
function checkAgentModel(data, { clock = Date } = {}) {
  const ALLOW = { action: 'allow' };
  try {
    if (!data || (data.tool_name !== 'Agent' && data.tool_name !== 'Task')) return ALLOW;
    const toolInput = data.tool_input;
    const type = toolInput && toolInput.subagent_type;
    if (typeof type !== 'string' || !GUARDED_AGENT_TYPES.has(type)) return ALLOW;

    const root = resolveSentinelRoot(data.cwd || process.cwd());
    // Strict JSON on purpose: a config this cannot parse (comments, trailing commas) fails open.
    const config = JSON.parse(fs.readFileSync(path.join(root, '.planning', 'config.json'), 'utf-8'));
    const mode = config.hooks && config.hooks.agent_model_guard;
    if (mode === false) return ALLOW;
    // Cheap pre-check: a pinned non-claude runtime skips the build/resolver loads below.
    // eslint-disable-next-line local/no-runtime-name-literal
    if (config.runtime && config.runtime !== 'claude') return ALLOW;

    const { ensureRuntimeBuild } = require('../../gsd-core/bin/ensure-runtime-build.cjs');
    ensureRuntimeBuild();
    if (require('../../gsd-core/bin/lib/runtime-slash.cjs').resolveRuntime(root) !== 'claude') return ALLOW;
    const expected = require('../../gsd-core/bin/lib/model-resolver.cjs').resolveModelInternal(root, type);
    if (!expected || expected === 'inherit') return ALLOW;

    const passed = typeof toolInput.model === 'string' ? toolInput.model : '';
    if (passed && family(passed) === family(expected)) return ALLOW;

    if (passed) {
      try {
        const rec = JSON.parse(fs.readFileSync(escalationPath(root, type), 'utf-8'));
        const age = clock.now() - rec.written_at;
        if (typeof rec.model === 'string' && age > -5000 && age < SENTINEL_STALE_MS && family(rec.model) === family(passed)) return ALLOW;
      } catch { /* no usable record */ }
    }

    // tool_input.model is model-authored: cap it and keep only id-shaped characters before it reaches additionalContext.
    const shown = passed.replace(/[^\w.:[\]-]/g, '?').slice(0, 64);
    return {
      action: mode === 'deny' && passed.length > 0 ? 'block' : 'warn',
      reason: `Agent model guard: subagent_type="${type}" ${passed ? `was passed model="${shown}"` : 'was passed no model'}, ` +
        `but GSD resolved model="${expected}" for it. Pass model="${expected}" (or run ` +
        `\`resolve-execution ${type} --attempt N\` first to escalate deliberately).`,
    };
  } catch {
    return ALLOW;
  }
}

module.exports = { checkAgentModel };
