'use strict';

// The merge-queue ruleset spec for the default branch (#5605): .github/rulesets/next-queue.json is committed, not
// applied (scripts/sync-rulesets.sh creates every ruleset under .github/rulesets/ and overrides `enforcement`), so
// what is pinned is the shape that matters when a maintainer applies it: the name and target, one merge_queue rule,
// never committed as active, one Admin-role bypass actor (#5894), squash merging, all-green grouping, a valid
// timeout and coherent group sizing, and no unknown parameters. And every committed ruleset has a unique name, a
// target and a rules array. Was tests/next-queue-ruleset.test.cjs.

const QUEUE_FILE = '.github/rulesets/next-queue.json';
const PARAMETER_KEYS = [
  'check_response_timeout_minutes', 'grouping_strategy', 'max_entries_to_build', 'max_entries_to_merge',
  'merge_method', 'min_entries_to_merge', 'min_entries_to_merge_wait_minutes',
];
const MAX_CHECK_RESPONSE_MINUTES = 360;
// Deep equality of values the spec holds (arrays and plain objects), ignoring object key order as deepStrictEqual does.
const same = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => same(a[key], b[key]));
};

// The parsed spec and its merge_queue rule, or the reason there is none.
function parse(text) {
  let spec;
  try {
    spec = JSON.parse(text);
  } catch (err) {
    return { error: `not valid JSON: ${err.message}` };
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { error: 'not a JSON object' };
  const rules = Array.isArray(spec.rules) ? spec.rules : [];
  return { spec, queue: rules.find((rule) => rule && rule.type === 'merge_queue') };
}

// A check on the spec, or on its merge_queue parameters (a finding when there is no merge_queue rule or no parameters).
const onSpec = (check) => (text) => {
  const { spec, error } = parse(text);
  return error || check(spec);
};
const onParameters = (check) => (text) => {
  const { spec, queue, error } = parse(text);
  if (error) return error;
  if (!queue) return 'no merge_queue rule';
  if (!queue.parameters || typeof queue.parameters !== 'object') return 'merge_queue has no parameters';
  return check(queue.parameters, spec);
};

module.exports = {
  id: 'next-queue-ruleset',
  issue: '#5605',
  check(ctx) {
    ctx.doc(QUEUE_FILE)
      .satisfies(onSpec((spec) => {
        const ref = spec.conditions && spec.conditions.ref_name;
        return (spec.name === 'next-queue' && spec.target === 'branch' && !!ref && same(ref.include, ['~DEFAULT_BRANCH']) && same(ref.exclude, []))
          || 'expected name next-queue, target branch, include ["~DEFAULT_BRANCH"], exclude []';
      }), 'the ruleset must target the default branch and be named for sync-rulesets.sh to find')
      .satisfies(onSpec((spec) => same((Array.isArray(spec.rules) ? spec.rules : []).map((rule) => rule && rule.type), ['merge_queue']) || 'expected exactly one rule, merge_queue'),
        'the ruleset must carry exactly one rule, the merge queue')
      .satisfies(onSpec((spec) => ['disabled', 'evaluate'].includes(spec.enforcement) || `enforcement is ${JSON.stringify(spec.enforcement)}`),
        'the ruleset must never be committed as active')
      .satisfies(onSpec((spec) => {
        const actors = spec.bypass_actors;
        const [actor] = Array.isArray(actors) ? actors : [];
        return (Array.isArray(actors) && actors.length === 1 && !!actor && actor.actor_id === 5 && actor.actor_type === 'RepositoryRole'
          && actor.bypass_mode === 'always' && Object.keys(actor).length === 3) || JSON.stringify(actors);
      }), 'the ruleset must have exactly one bypass actor, the repository Admin role, so a back-merge can land as a merge commit (#5894)')
      .satisfies(onParameters((p) => p.merge_method === 'SQUASH' || `merge_method is ${JSON.stringify(p.merge_method)}`),
        'the queue must squash, so each PR stays one commit on the default branch')
      .satisfies(onParameters((p) => p.grouping_strategy === 'ALLGREEN' || `grouping_strategy is ${JSON.stringify(p.grouping_strategy)}`),
        'the queue must only merge groups whose members all passed')
      .satisfies(onParameters((p) => {
        const minutes = p.check_response_timeout_minutes;
        return (Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_CHECK_RESPONSE_MINUTES) || `got ${JSON.stringify(minutes)}`;
      }), 'check_response_timeout_minutes must be an integer within the REST range 1..360')
      .satisfies(onParameters((p) => {
        for (const key of ['max_entries_to_build', 'max_entries_to_merge', 'min_entries_to_merge', 'min_entries_to_merge_wait_minutes']) {
          if (!(Number.isInteger(p[key]) && p[key] >= 0)) return `${key} must be a non-negative integer`;
        }
        if (!(p.min_entries_to_merge >= 1)) return 'min_entries_to_merge must be at least 1';
        if (!(p.min_entries_to_merge <= p.max_entries_to_merge)) return 'min_entries_to_merge must not exceed max_entries_to_merge';
        if (!(p.max_entries_to_build >= 1)) return 'max_entries_to_build must be at least 1';
        return true;
      }), 'group sizing must be coherent (min <= max) and builds bounded')
      .satisfies(onParameters((p) => same(Object.keys(p).sort(), PARAMETER_KEYS) || `parameters: ${Object.keys(p).sort().join(', ')}`),
        'the queue must use no unknown merge_queue parameters');

    // Every committed ruleset is well-formed for sync-rulesets.sh, and the names are unique across files.
    const names = [];
    let lastRuleset = null;
    for (const rel of ctx.list('.github/rulesets', '.json', 'the committed rulesets are what sync-rulesets.sh reads')) {
      lastRuleset = ctx.doc(rel).satisfies((text) => {
        const { spec, error } = parse(text);
        if (error) return error;
        names.push(spec.name);
        if (!(typeof spec.name === 'string' && spec.name.length > 0)) return 'name must be a non-empty string';
        if (!['branch', 'tag'].includes(spec.target)) return `target is ${JSON.stringify(spec.target)}`;
        if (!(Array.isArray(spec.rules) && spec.rules.length > 0)) return 'rules must be a non-empty array';
        return true;
      }, `${rel} must have a name, a target and a rules array`);
    }
    if (lastRuleset) {
      lastRuleset.satisfies(() => new Set(names).size === names.length || `names: ${names.join(', ')}`, 'ruleset names must be unique across files');
    }
  },
};
