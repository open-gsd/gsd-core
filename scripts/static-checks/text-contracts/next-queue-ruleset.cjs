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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The parsed spec and its merge_queue rule, or the reason there is none.
function parse(text) {
  let spec;
  try {
    spec = JSON.parse(text);
  } catch (err) {
    return { error: `not valid JSON: ${err.message}` };
  }
  const rules = Array.isArray(spec && spec.rules) ? spec.rules : [];
  return { spec, queue: rules.find((rule) => rule && rule.type === 'merge_queue') };
}

const onQueue = (check) => (text) => {
  const { spec, queue, error } = parse(text);
  if (error) return error;
  return check(spec, queue);
};

module.exports = {
  id: 'next-queue-ruleset',
  issue: '#5605',
  check(ctx) {
    ctx.doc(QUEUE_FILE)
      .satisfies(onQueue((spec) => (spec.name === 'next-queue' && spec.target === 'branch'
        && same(spec.conditions && spec.conditions.ref_name && spec.conditions.ref_name.include, ['~DEFAULT_BRANCH'])
        && same(spec.conditions.ref_name.exclude, [])) || 'expected name next-queue, target branch, include ["~DEFAULT_BRANCH"], exclude []'),
      'the ruleset must target the default branch and be named for sync-rulesets.sh to find')
      .satisfies(onQueue((spec) => same((spec.rules || []).map((rule) => rule.type), ['merge_queue']) || 'expected exactly one rule, merge_queue'),
        'the ruleset must carry exactly one rule, the merge queue')
      .satisfies(onQueue((spec) => (['disabled', 'evaluate'].includes(spec.enforcement)) || `enforcement is ${JSON.stringify(spec.enforcement)}`),
        'the ruleset must never be committed as active')
      .satisfies(onQueue((spec) => same(spec.bypass_actors, [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }]) || JSON.stringify(spec.bypass_actors)),
        'the ruleset must have exactly one bypass actor, the repository Admin role, so a back-merge can land as a merge commit (#5894)')
      .satisfies(onQueue((spec, queue) => (queue && queue.parameters.merge_method === 'SQUASH') || 'merge_method is not SQUASH'),
        'the queue must squash, so each PR stays one commit on the default branch')
      .satisfies(onQueue((spec, queue) => (queue && queue.parameters.grouping_strategy === 'ALLGREEN') || 'grouping_strategy is not ALLGREEN'),
        'the queue must only merge groups whose members all passed')
      .satisfies(onQueue((spec, queue) => {
        const minutes = queue && queue.parameters.check_response_timeout_minutes;
        return (Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_CHECK_RESPONSE_MINUTES) || `got ${JSON.stringify(minutes)}`;
      }), 'check_response_timeout_minutes must be an integer within the REST range 1..360')
      .satisfies(onQueue((spec, queue) => {
        const p = queue && queue.parameters;
        if (!p) return 'no merge_queue rule';
        for (const key of ['max_entries_to_build', 'max_entries_to_merge', 'min_entries_to_merge', 'min_entries_to_merge_wait_minutes']) {
          if (!(Number.isInteger(p[key]) && p[key] >= 0)) return `${key} must be a non-negative integer`;
        }
        if (!(p.min_entries_to_merge >= 1)) return 'min_entries_to_merge must be at least 1';
        if (!(p.min_entries_to_merge <= p.max_entries_to_merge)) return 'min_entries_to_merge must not exceed max_entries_to_merge';
        if (!(p.max_entries_to_build >= 1)) return 'max_entries_to_build must be at least 1';
        return true;
      }), 'group sizing must be coherent (min <= max) and builds bounded')
      .satisfies(onQueue((spec, queue) => same(Object.keys((queue && queue.parameters) || {}).sort(), PARAMETER_KEYS) || `parameters: ${Object.keys((queue && queue.parameters) || {}).sort().join(', ')}`),
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
