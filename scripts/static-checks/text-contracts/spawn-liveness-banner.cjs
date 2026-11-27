'use strict';

// Every GSD workflow that spawns a subagent carries the liveness phrase "runs in a subagent" (#558, canonical text in
// gsd-core/references/ui-brand.md, Spawning Indicators). Two assertions: (1) any diamond display line naming the word
// spawn or spawning carries the phrase, in every .md under gsd-core/workflows (steps and modes included); (2) every
// HOST workflow (top-level gsd-core/workflows/*.md, read together with its workflows/<name>/steps/*.md fragments,
// #2994) that names `subagent_type` carries the phrase somewhere. Was tests/spawn-liveness-banner.test.cjs.

const WORKFLOWS = 'gsd-core/workflows';
const LIVENESS_PHRASE = 'runs in a subagent';
const DIAMOND = String.fromCharCode(0x25c6); // '◆';
const SPAWN_WORD = /\bspawn(?:ing)?\b/i;

// Lines with a diamond followed, before any carriage return, by the word spawn or spawning, and no liveness phrase.
function bannerViolations(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes(LIVENESS_PHRASE)) return;
    for (let at = line.indexOf(DIAMOND); at !== -1; at = line.indexOf(DIAMOND, at + 1)) {
      const rest = line.slice(at + 1).split('\r')[0];
      if (SPAWN_WORD.test(rest)) {
        out.push(`line ${i + 1}: ${line.trim()}`);
        return;
      }
    }
  });
  return out;
}

module.exports = {
  id: 'spawn-liveness-banner',
  issue: '#558',
  check(ctx) {
    const files = ctx.list(WORKFLOWS, '.md', 'the workflows are what the spawn banners are checked in');
    const texts = new Map();
    for (const rel of files) {
      ctx.doc(rel).satisfies((text) => {
        texts.set(rel, text);
        const violations = bannerViolations(text);
        return violations.length === 0 || violations.join('; ');
      }, 'every diamond spawn announcement line must carry the liveness phrase "runs in a subagent": silence during a subagent run is expected, so users must not kill a healthy agent');
    }

    for (const host of files.filter((rel) => rel.split('/').length === 3)) {
      const name = host.slice(WORKFLOWS.length + 1, -'.md'.length);
      const fragments = files
        .filter((rel) => rel.startsWith(`${WORKFLOWS}/${name}/steps/`) && rel.split('/').length === 5) // allow-handrolled-containment: groups a workflow's step fragments by path prefix, not a containment decision
        .sort();
      ctx.doc(host).satisfies((hostText) => {
        const combined = [hostText, ...fragments.map((rel) => texts.get(rel) || '')].join('\n');
        return !(combined.includes('subagent_type') && !combined.includes(LIVENESS_PHRASE)) || 'it contains "subagent_type" but never the liveness phrase';
      }, 'a workflow that dispatches a subagent must carry the liveness phrase "runs in a subagent" somewhere in the workflow (host plus its steps fragments)');
    }
  },
};
