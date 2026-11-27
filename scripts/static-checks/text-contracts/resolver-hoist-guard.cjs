'use strict';

// Resolver-hoist guard (#2994, matrix section G): a gated section whose own extracted body still resolves its own
// gating fact is circular and self-disabling. For every section of the shipped gsd-core/workflows/section-manifest.json
// whose `when` atom has a documented resolver (the map below), its step file must not contain that resolver call in a
// fenced code block (a prose mention is not a call). The step file path comes from the manifest, so it must be a plain
// gsd-core/workflows path of safe characters with no dot segment; anything else is a finding, never a read. The map
// must cover at least one atom the manifest uses. autonomous.md keeps its $PLAN_STRATEGY resolver (matrix row G2):
// both assignments are present and the ungated "local" consumer sits outside every state:plan-strategy-converge gated
// section. A malformed manifest is a finding, where the test threw. Was tests/resolver-hoist-guard.test.cjs.

const path = require('node:path');

const MANIFEST = 'gsd-core/workflows/section-manifest.json';
const AUTONOMOUS = 'gsd-core/workflows/autonomous.md';
const CONSUMER_TEXT = 'If `PLAN_STRATEGY=local`, run the regular planner:';
const SAFE_READ = /^gsd-core\/workflows\/(?:[A-Za-z0-9._-]{1,100}\/){0,6}[A-Za-z0-9._-]{1,100}\.md$/;

// The resolver invocation each atom's fact is hoisted FROM: a step file gated on the atom must never contain it.
const ATOM_FORBIDDEN_RESOLVER_SUBSTRINGS = {
  'state:fallow-enabled': ['code_quality.fallow.enabled'],
  'state:git-create-tag': ['git.create_tag'],
  'state:chunked-mode': ['workflow.plan_chunked'],
  'state:worktrees-enabled': ['workflow.use_worktrees'],
  'state:reviewer-instances-configured': ['review.reviewer_instances'],
  'state:phase-mvp-mode': ['phase.mvp-mode'],
  'state:ui-phase-active': ['render-hooks plan:pre'],
};

const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isDotSegment = (segment) => segment === '.' || segment === '..';

// The concatenated content of every fenced block (fence markers excluded; an unterminated block runs to the end): a live
// resolver call only ever sits in one. One linear walk that classifies each line with the sectionizer's
// matchFenceDelimiter (the one owner of the fence grammar) after its leading blanks are stripped: a delimiter that can
// open starts a fence, one that closes the open fence ends it. A list marker is stripped only from a line outside every
// fence that then is a delimiter, so a "- ```" line inside a fence stays content. A delimiter line that cannot open
// (a backtick run whose info string holds a backtick, such as a one-line triple-backtick span) is searched as content.
function fencedCodeOnly(content) {
  const { matchFenceDelimiter } = require(path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', 'markdown-sectionizer.cjs'));
  const kept = [];
  let open = null;
  for (const raw of content.split('\n')) {
    let line = raw.replace(/^[ \t]+/, '');
    if (open === null) {
      const bare = line.replace(/^(?:[-*+]|\d{1,9}[.)])[ \t]+/, '');
      if (bare !== line && matchFenceDelimiter(bare) !== null) line = bare;
    }
    const delimiter = matchFenceDelimiter(line);
    if (open === null) {
      if (delimiter !== null && delimiter.canOpen) open = delimiter;
      else if (delimiter !== null) kept.push(line);
    } else if (delimiter !== null && delimiter.closes(open)) {
      open = null;
    } else {
      kept.push(line);
    }
  }
  return kept.join('\n');
}

module.exports = {
  id: 'resolver-hoist-guard',
  issue: '#2994',
  check(ctx) {
    const manifestDoc = ctx.doc(MANIFEST);
    let manifest = null;
    manifestDoc.satisfies((text) => {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return `not valid JSON: ${err.message}`;
      }
      if (!isMapping(parsed) || !isMapping(parsed.workflows)) return 'the manifest has no workflows mapping';
      manifest = parsed;
      return true;
    }, 'the shipped section manifest must parse and list workflows');

    if (manifest !== null) {
      const usedAtoms = new Set();
      for (const [workflow, sections] of Object.entries(manifest.workflows)) {
        if (!Array.isArray(sections)) {
          ctx.fail(MANIFEST, `the sections of ${workflow} are not a list`);
          continue;
        }
        for (const section of sections) {
          if (!isMapping(section)) {
            ctx.fail(MANIFEST, `a section of ${workflow} is not a mapping`);
            continue;
          }
          usedAtoms.add(section.when);
          if (!Object.prototype.hasOwnProperty.call(ATOM_FORBIDDEN_RESOLVER_SUBSTRINGS, section.when)) continue; // no generic rule for this atom
          const forbidden = ATOM_FORBIDDEN_RESOLVER_SUBSTRINGS[section.when];
          if (typeof section.read !== 'string' || !SAFE_READ.test(section.read) || section.read.split('/').some(isDotSegment)) {
            ctx.fail(MANIFEST, `${workflow} section "${section.id}" names the step file ${JSON.stringify(section.read)}, which is not a plain gsd-core/workflows step path`);
            continue;
          }
          ctx.doc(section.read).satisfies((text) => {
            const fenced = fencedCodeOnly(text);
            const found = forbidden.filter((token) => fenced.includes(token));
            return found.length === 0 || `found forbidden substring ${found.map((token) => JSON.stringify(token)).join(', ')}`;
          }, `${section.read} (${workflow} section "${section.id}", gated on "${section.when}") must not itself call the resolver for that fact: a circular, self-disabling section`);
        }
      }
      manifestDoc.satisfies(() => Object.keys(ATOM_FORBIDDEN_RESOLVER_SUBSTRINGS).some((atom) => usedAtoms.has(atom)) || 'no atom of the map is used',
        'the forbidden-substring map must exercise at least one atom the shipped manifest actually gates a section on');
    }

    // The sections of autonomous.md (the shipped fragment parser), or the reason they cannot be read.
    const sectionsOf = (text) => {
      try {
        const { parseWorkflowSections } = require(path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', 'workflow-fragments.cjs'));
        const sections = parseWorkflowSections(text, AUTONOMOUS);
        return Array.isArray(sections) && sections.every(isMapping) ? { sections } : { error: 'the fragment parser returned no list of sections' };
      } catch (err) {
        return { error: `the fragment parser failed: ${err.message}` };
      }
    };
    const withSections = (check) => (text) => {
      const { sections, error } = sectionsOf(text);
      return error || check(sections);
    };
    const converge = (sections) => sections.filter((section) => section.explicit && section.when === 'state:plan-strategy-converge');

    ctx.doc(AUTONOMOUS)
      .has('PLAN_STRATEGY="local"', 'the default-local assignment must survive the converge-hoist')
      .has('PLAN_STRATEGY="converge"', 'the converge-branch assignment must survive the converge-hoist')
      .has(CONSUMER_TEXT, 'the ungated local-strategy consumer text must exist in the host file')
      .satisfies(withSections((sections) => converge(sections).length > 0 || 'no gated section'),
        'autonomous.md must have at least one state:plan-strategy-converge gated section')
      .satisfies(withSections((sections) => {
        const inside = converge(sections).find((section) => String(section.body).includes(CONSUMER_TEXT));
        return inside === undefined || `inside "${inside.id}"`;
      }), 'the ungated PLAN_STRATEGY=local consumer must not live inside a gated converge section: deleting that section must never remove the local-planning path')
      .satisfies(withSections((sections) => sections.filter((section) => !section.explicit).map((section) => section.body).join('').includes('PLAN_STRATEGY="local"')
        || 'not in the always-composed remainder'), 'the PLAN_STRATEGY="local" resolver must be present outside every converge-gated section')
      .satisfies(withSections((sections) => sections.filter((section) => !section.explicit).map((section) => section.body).join('').includes(CONSUMER_TEXT)
        || 'not in the always-composed remainder'), 'the PLAN_STRATEGY=local consumer must be present outside every converge-gated section');
  },
};
