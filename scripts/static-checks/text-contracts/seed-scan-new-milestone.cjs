'use strict';

// Seed scanning in new-milestone (#2169) and the one-shot seed capture of plant-seed (#3236): new-milestone.md scans
// .planning/seeds/ for SEED-*.md files, skips silently when none exist and auto-selects all matching seeds under --auto;
// plant-seed.md still promises auto-surfacing during new-milestone, has a write-seed step, writes the seed before any
// Trigger / Why / Scope question, documents defaults for trigger_when and scope, and keeps an optional enrichment path.
// Was tests/seed-scan-new-milestone.test.cjs (with the folded bug-3236 cases). The old `.*` patterns match within one
// line (a dot excludes CR, LF, U+2028 and U+2029): they are one linear walk per line, the parts in order, any case.

const { asciiLower } = require('./lib/ascii-lower.cjs');

const NEW_MILESTONE = 'gsd-core/workflows/new-milestone.md';
const PLANT_SEED = 'gsd-core/workflows/plant-seed.md';

// True when one line holds every part in order (the old `a.*b.*c`), without regard to case.
function lineHasInOrder(text, parts) {
  for (const line of text.split(/\r|\n|\u2028|\u2029/)) {
    const lower = asciiLower(line);
    let from = 0;
    let all = true;
    for (const part of parts) {
      const at = lower.indexOf(part, from);
      if (at === -1) {
        all = false;
        break;
      }
      from = at + part.length;
    }
    if (all) return true;
  }
  return false;
}

// The names of the `<step name="…">` tags in document order, as the old extraction read them (a name has at least one
// character and ends at the next double quote).
function stepNames(text) {
  const names = [];
  const open = '<step name="';
  let at = text.indexOf(open);
  while (at !== -1) {
    const from = at + open.length;
    const close = text.indexOf('"', from);
    if (close > from) {
      names.push(text.slice(from, close));
      at = text.indexOf(open, close + 1);
    } else {
      at = text.indexOf(open, at + 1);
    }
  }
  return names;
}

module.exports = {
  id: 'seed-scan-new-milestone',
  issue: '#2169',
  lineHasInOrder,
  stepNames,
  check(ctx) {
    ctx.doc(NEW_MILESTONE)
      .has('.planning/seeds/', 'new-milestone.md must contain instructions about scanning .planning/seeds/')
      .has('SEED-*.md', 'new-milestone.md must reference the SEED-*.md file pattern')
      .satisfies((text) => lineHasInOrder(text, ['no seed files exist', 'skip']), 'new-milestone.md must mention skipping when no seed files exist')
      .has('--auto', 'new-milestone.md must mention --auto mode in the seed scanning step')
      .satisfies((text) => lineHasInOrder(text, ['auto', 'select', 'all', 'matching', 'seed']), 'new-milestone.md must instruct auto-selecting all matching seeds in --auto mode');

    ctx.doc(PLANT_SEED)
      .has('new-milestone', 'plant-seed.md must reference new-milestone as the surfacing mechanism for seeds')
      .satisfies((text) => /auto.surface/i.test(text) || /auto.present/i.test(text),
        'plant-seed.md must describe seeds as auto-surfacing or auto-presenting')
      .satisfies((text) => stepNames(text).includes('write-seed'), 'plant-seed.md must contain a <step name="write-seed"> (hyphens, not underscores)')
      .satisfies((text) => {
        const writeAt = text.indexOf('<step name="write-seed"');
        if (writeAt === -1) return true; // the missing step is reported by the assertion above
        // Every misplaced question is named: the old test asserted the three headers one by one.
        const misplaced = [];
        for (const header of ['Trigger', 'Why', 'Scope']) {
          const questionAt = text.indexOf(`header: "${header}"`);
          if (questionAt !== -1 && !(writeAt < questionAt)) misplaced.push(`write-seed (offset ${writeAt}) must precede the ${header} question (offset ${questionAt})`);
        }
        return misplaced.length === 0 || misplaced.join('; ');
      }, 'the seed must be written before any Trigger / Why / Scope question (capture first, enrich later)')
      .satisfies((text) => lineHasInOrder(text, ['trigger_when', 'default']) || lineHasInOrder(text, ['default', 'trigger'])
        || /when relevant|when scope matches|unspecified/i.test(text), 'plant-seed.md must document a default for trigger_when when the user provides no Trigger')
      .satisfies((text) => lineHasInOrder(text, ['scope', 'default']) || lineHasInOrder(text, ['default', 'scope'])
        || /unknown|unspecified/i.test(text), 'plant-seed.md must document a default for scope when the user provides no Scope')
      .satisfies((text) => {
        const names = stepNames(text);
        const writeIdx = names.findIndex((name) => name === 'write-seed' || name === 'write_seed');
        const gatherIdx = names.findIndex((name) => name === 'gather-context' || name === 'gather_context' || name === 'enrich-seed' || name === 'enrich_seed');
        if (gatherIdx === -1 || writeIdx === -1) return true;
        return writeIdx < gatherIdx || `write-seed (step index ${writeIdx}) must appear before gather/enrich (index ${gatherIdx})`;
      }, 'the write-seed step must precede the enrich/gather step in step order: capture first, enrich later')
      .satisfies((text) => /enrich|gather.context|gather_context/i.test(text) || text.includes('header: "Trigger"'),
        'plant-seed.md must preserve an optional enrichment path (an enrich step or the Trigger / Why / Scope questions)');
  },
};
