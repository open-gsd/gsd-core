'use strict';

// The mempalace gates treat an absent key as enabled where the capability registry declares `default: true` (#2641,
// #3479, #5173): the capture skill and command gate capture_artifacts and mirror_kg on `=== false`, the recall skill and
// command and the curator agent gate mirror_kg and diary_journal on `!== false`, none gates a default-true key on positive
// presence, the default-false master switch and cross_project_tunnels keep their positive gates, and a `!== false` gate
// is introduced by "when" or "only if", never "unless" (the double negative inverts it). Was
// tests/mempalace-capture-gate-default.test.cjs. The registry is the shipped module (gsd-core/bin/lib), so its defaults
// are not something a copied tree can change; the text cases cover every gate. The `unless` probes are linear walks.

const path = require('node:path');

const CAPTURE_SKILL = 'skills/gsd-mempalace-capture/SKILL.md';
const CAPTURE_COMMAND = 'commands/gsd/mempalace-capture.md';
const RECALL_SKILL = 'skills/gsd-mempalace-recall/SKILL.md';
const RECALL_COMMAND = 'commands/gsd/mempalace-recall.md';
const CURATOR = 'agents/gsd-mempalace-curator.md';
const CURATOR_COMPACT = 'agents/gsd-mempalace-curator.compact.md';
const LOOKBACK = 80;

// The registry's settings schema (the node holding `mempalace.mirror_kg`), found by the test's depth-first walk.
function mempalaceSettings(capabilities) {
  const stack = [capabilities.mempalace];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(node, 'mempalace.mirror_kg')) return node;
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return null;
}

const isLetter = (ch) => (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');

// The lower-cased connective before each backticked occurrence of `predicate`: the last letter-run of the 80 characters
// before it, or "only if" when the two last letter-runs are only and if.
function connectivesBefore(text, predicate) {
  const needle = `\`${predicate}\``;
  const found = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    const window = text.slice(Math.max(0, at - LOOKBACK), at);
    const words = [];
    let start = -1;
    for (let i = 0; i <= window.length; i += 1) {
      if (i < window.length && isLetter(window[i])) {
        if (start === -1) start = i;
      } else if (start !== -1) {
        words.push(window.slice(start, i));
        start = -1;
      }
    }
    const last = (words[words.length - 1] || '').toLowerCase();
    const prior = (words[words.length - 2] || '').toLowerCase();
    found.push(prior === 'only' && last === 'if' ? 'only if' : last);
  }
  return found;
}

// True when the text pairs "unless" with a backticked predicate that ends in `<operator> false` (the old
// `\bunless\s+\(?`[^`]*<operator>\s*false``), by one walk.
function hasUnlessGate(text, operator) {
  let at = text.indexOf('unless');
  while (at !== -1) {
    const wordStart = at === 0 || !/\w/.test(text[at - 1]);
    let pos = at + 'unless'.length;
    const spaceStart = pos;
    while (pos < text.length && /\s/.test(text[pos])) pos += 1;
    if (wordStart && pos > spaceStart) {
      if (text[pos] === '(') pos += 1;
      if (text[pos] === '`') {
        const close = text.indexOf('`', pos + 1);
        if (close !== -1) {
          const span = text.slice(pos + 1, close);
          const op = span.lastIndexOf(operator);
          if (op !== -1 && span.slice(op + operator.length).trimStart() === 'false') return true;
        }
      }
    }
    at = text.indexOf('unless', at + 1);
  }
  return false;
}

module.exports = {
  id: 'mempalace-capture-gate-default',
  issue: '#2641',
  check(ctx) {
    for (const rel of [CAPTURE_SKILL, CAPTURE_COMMAND]) {
      ctx.doc(rel)
        .has('capture_artifacts === false', `${rel} must use capture_artifacts === false (disabled only on explicit false) (#2641)`)
        .lacks('capture_artifacts !== true', `${rel} must not use the inverted capture_artifacts !== true check (#2641)`)
        .has('config.mempalace.mirror_kg === false', `${rel} must mirror KG facts unless config.mempalace.mirror_kg === false (#3479)`)
        .lacks('config.mempalace.mirror_kg` is true', `${rel} must not gate mirror_kg on positive presence: absent means enabled (#3479)`);
    }
    for (const rel of [RECALL_SKILL, RECALL_COMMAND]) {
      ctx.doc(rel)
        .has('config.mempalace.mirror_kg !== false', `${rel} KG-facts step must gate on config.mempalace.mirror_kg !== false (#3479)`)
        .lacks('config.mempalace.mirror_kg` is true', `${rel} must not gate mirror_kg on positive presence (#3479)`);
    }
    ctx.doc(CURATOR)
      .has('mempalace.diary_journal !== false', `${CURATOR} diary gate must run when mempalace.diary_journal !== false (#3479)`)
      .has('mempalace.mirror_kg !== false', `${CURATOR} KG-mirror gate must run when mempalace.mirror_kg !== false (#3479)`)
      .lacks('mempalace.diary_journal` is true', `${CURATOR} must not gate diary_journal on positive presence (#3479)`)
      .lacks('mempalace.mirror_kg` is true', `${CURATOR} must not gate mirror_kg on positive presence (#3479)`)
      .has('mempalace.enabled !== true', 'the curator master gate must keep treating an absent mempalace.enabled as disabled (#3479)')
      .has('mempalace.cross_project_tunnels` is true', 'cross_project_tunnels (default: false) must keep its positive-presence gate: do not over-correct (#3479)');
    ctx.doc(CAPTURE_SKILL)
      .has('config.mempalace.enabled !== true', 'the capture master gate must keep treating an absent mempalace.enabled as disabled (#3479)');

    // #5173: a `!== false` gate is introduced by "when" or "only if", never "unless".
    for (const [rel, predicate] of [[RECALL_COMMAND, 'config.mempalace.mirror_kg !== false'], [RECALL_SKILL, 'config.mempalace.mirror_kg !== false'],
      [CURATOR, 'mempalace.diary_journal !== false'], [CURATOR, 'mempalace.mirror_kg !== false']]) {
      ctx.doc(rel).satisfies((text) => {
        const connectives = connectivesBefore(text, predicate);
        if (connectives.length === 0) return `${rel} must still carry the \`${predicate}\` gate (#5173)`;
        if (connectives.includes('unless')) return `${rel} introduces \`${predicate}\` with "unless": "unless \`K !== false\`" means "only when K is false"; use "when" (#5173)`;
        return connectives.some((connective) => connective === 'when' || connective === 'only if')
          || `${rel} must introduce its \`${predicate}\` gate with "when" or "only if" (found: ${connectives.join(', ')}) (#5173)`;
      }, 'a `!== false` gate must read "when" or "only if", never "unless"');
    }
    for (const rel of [CAPTURE_SKILL, CAPTURE_COMMAND, RECALL_SKILL, RECALL_COMMAND, CURATOR, CURATOR_COMPACT]) {
      ctx.doc(rel).satisfies((text) => !hasUnlessGate(text, '!=='), `${rel} must not pair "unless" with a \`!== false\` predicate: the double negative inverts the gate (#5173)`);
    }
    for (const rel of [CAPTURE_SKILL, CAPTURE_COMMAND, CURATOR_COMPACT]) {
      ctx.doc(rel).satisfies((text) => hasUnlessGate(text, '==='), `${rel} must keep its "unless \`… === false\`" gate: it already reads correctly (#5173)`);
    }

    // The registry defaults the corrected gates depend on (the shipped module).
    const { capabilities } = require(path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', 'capability-registry.cjs'));
    const settings = mempalaceSettings(capabilities);
    if (!settings) {
      ctx.fail('gsd-core/bin/lib/capability-registry.cjs', 'the capability registry must expose a mempalace settings schema');
      return;
    }
    const defaultTrue = [];
    const defaultFalse = [];
    for (const [key, spec] of Object.entries(settings)) {
      if (!key.startsWith('mempalace.') || spec.type !== 'boolean') continue;
      (spec.default === true ? defaultTrue : defaultFalse).push(key);
    }
    for (const key of ['mempalace.capture_artifacts', 'mempalace.mirror_kg', 'mempalace.diary_journal']) {
      if (!defaultTrue.includes(key)) ctx.fail('gsd-core/bin/lib/capability-registry.cjs', `${key} must declare default: true in the capability registry`);
    }
    if (!defaultFalse.includes('mempalace.enabled')) {
      ctx.fail('gsd-core/bin/lib/capability-registry.cjs', 'mempalace.enabled must stay default: false: the master switch is opt-in');
    }
    for (const rel of [CAPTURE_SKILL, CAPTURE_COMMAND, RECALL_SKILL, RECALL_COMMAND, CURATOR]) {
      const gates = ctx.doc(rel);
      for (const key of defaultTrue) {
        for (const spelling of [`config.${key}`, key]) {
          gates.lacks(`\`${spelling}\` is true`, `${rel} gates \`${key}\` on positive presence, but the registry declares default: true: absent must mean enabled (#3479)`);
        }
      }
    }
  },
};
