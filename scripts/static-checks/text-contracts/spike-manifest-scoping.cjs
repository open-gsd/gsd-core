'use strict';

// #1700: the spike MANIFEST.md keeps an idea-keyed structure. spike.md (create_manifest, build_spikes README
// frontmatter, reground, frontier mode, success criteria) introduces an explicit idea key, a `## Ideas` section with one
// `### {idea-key}` subsection per idea, an append-not-overwrite rule, an in-place migration of the old flat shape, an Idea
// column in the Spikes table and an `idea:` field in the README frontmatter; spike-wrap-up.md resolves each spike's idea
// key and unions only the owning ideas' requirements; artifact-types.md labels MANIFEST.md a per-project index; sketch.md
// reads the per-idea sections. Was tests/spike-manifest-scoping.test.cjs. The old patterns' unbounded `\s*` between tokens
// is a linear walk (any run of whitespace, line breaks included); the bounded `[\s\S]{0,N}?` windows keep their bound.

const WORKFLOWS = 'gsd-core/workflows';
const SPIKE = `${WORKFLOWS}/spike.md`;
const WRAP_UP = `${WORKFLOWS}/spike-wrap-up.md`;
const SKETCH = `${WORKFLOWS}/sketch.md`;
const ARTIFACT_TYPES = 'gsd-core/references/artifact-types.md';

const WS = Symbol('whitespace run');

// The literal parts in order, with any run of whitespace (WS) between them where the old pattern had `\s*`; `wordEnd`
// asks for a non-word character (or the end) after the last part, the old `\b`.
function hasPatternWalk(text, parts, wordEnd = false) {
  let start = text.indexOf(parts[0]);
  while (start !== -1) {
    let at = start;
    let ok = true;
    for (const part of parts) {
      if (part === WS) {
        while (at < text.length && /\s/.test(text[at])) at += 1;
      } else if (text.startsWith(part, at)) {
        at += part.length;
      } else {
        ok = false;
        break;
      }
    }
    if (ok && (!wordEnd || at >= text.length || !/\w/.test(text[at]))) return true;
    start = text.indexOf(parts[0], start + 1);
  }
  return false;
}

const SPIKES_TABLE_HEADER = ['|', WS, '#', WS, '|', WS, 'Idea', WS, '|', WS, 'Name', WS, '|', WS, 'Type', WS, '|', WS, 'Validates', WS, '|', WS, 'Verdict', WS, '|', WS, 'Tags', WS, '|'];

module.exports = {
  id: 'spike-manifest-scoping',
  issue: '#1700',
  hasPatternWalk,
  WS,
  SPIKES_TABLE_HEADER,
  check(ctx) {
    ctx.doc(SPIKE)
      .has(/idea key/i, 'create_manifest must introduce an explicit "idea key" concept: without one the write side cannot tell a continuation of the current idea from an unrelated new idea')
      .satisfies((text) => hasPatternWalk(text, ['##', WS, 'Ideas'], true), 'the MANIFEST.md template must have a `## Ideas` section (plural) that can hold more than one idea')
      .satisfies((text) => hasPatternWalk(text, ['###', WS, '{idea-key}']), 'the MANIFEST.md template must scope each idea under its own `### {idea-key}` subsection')
      .has(/new idea key[\s\S]{0,200}?append/i, 'a new idea must append a new idea section rather than overwrite or merge into an existing one')
      .has(/[Nn]ever touch[\s\S]{0,80}?(?:another|other) idea/i, 'the workflow must forbid touching another idea\'s section when adding to the current one')
      .has(/old flat[\s\S]{0,40}?shape/i, 'create_manifest must migrate a pre-#1700 flat-shape MANIFEST.md in place instead of discarding it')
      .satisfies((text) => hasPatternWalk(text, SPIKES_TABLE_HEADER), 'the `## Spikes` table header must include an Idea column between # and Name')
      .satisfies((text) => hasPatternWalk(text, ['spike:', WS, 'NNN', '\nidea:', WS, '{idea-key}']), 'the build_spikes README frontmatter template must record the owning idea key on the spike')
      .has(/current idea's[\s\S]{0,80}?Requirements/i, 'reground must scope its established-requirements check to the idea being spiked')
      .has(/every idea section/i, 'frontier mode\'s MANIFEST.md load step must read every idea\'s scoped section')
      .has(/scoped to the idea key/, 'the spike.md success criteria must call out that Requirements are tracked per idea key');

    ctx.doc(WRAP_UP)
      .has(/idea key/i, 'spike-wrap-up.md must resolve an idea key per spike before it scopes which Requirements apply')
      .has('ONLY from the Requirements list of the idea key', 'the synthesize step must pull Requirements only from the idea key(s) that own the spikes in the group')
      .has(/[Nn]ever include a requirement from an idea key that has no spike in this group/, 'the synthesize step must forbid leaking an unrelated idea\'s requirement into a feature-area reference')
      .has(/never the whole MANIFEST\.md/, 'the write_skill requirements block must be built from only the wrapped idea keys')
      .has(/never blended with an unrelated idea/, 'the spike-wrap-up.md success criteria must forbid blending requirements across idea keys');

    ctx.doc(ARTIFACT_TYPES)
      .lacks(/MANIFEST\.md \(per-spike/, 'artifact-types.md must not describe the project-level MANIFEST.md as "per-spike"')
      .has(/MANIFEST\.md \(per-project index/, 'artifact-types.md must label MANIFEST.md as the per-project durable index')
      .has(/via \/gsd:spike/, 'the legacy /gsd:spike colon form is outside this fix (#2903) and must stay');

    ctx.doc(SKETCH).has(/separate `### \{idea-key\}` sections/, 'sketch.md must read the per-idea requirement sections of spikes/MANIFEST.md');
  },
};
