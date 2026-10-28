/**
 * Cross-reader agreement on the phase-entry grammar (#5763, Phase 3 of #5692).
 *
 * Generates phase-list entries in every accepted form (marker x gap x box
 * state/case x bold token x indent) and asserts every migrated reader reaches
 * the same verdict: whether the phase exists and whether it is ticked. A
 * reader with a divergent private pattern is shown red by the positive control.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { buildRoadmapPhaseVariants, buildNotStartedPhaseVariants } = require('../gsd-core/bin/lib/validate.cjs');
const { hasPhaseEntries } = require('../gsd-core/bin/lib/roadmap-parser.cjs');
const { checklistEntrySrc } = require('../gsd-core/bin/lib/roadmap.cjs');
const { isPhaseEntryChecked } = require('../gsd-core/bin/lib/phase-entry-grammar.cjs');
const { parsePhaseChecklistLine } = require('../gsd-core/bin/lib/phase-id.cjs');

const SEED = 5763;

const formArb = fc.record({
  indent: fc.constantFrom('', '  ', '\t'),
  marker: fc.constantFrom('-', '*'),
  gap1: fc.constantFrom('', ' ', '  '),
  state: fc.constantFrom(' ', 'x', 'X'),
  gap2: fc.constantFrom('', ' '),
  bold: fc.constantFrom('**', '__', ''),
});

/** `Phase <id>: Name`, bold-wrapped when the form carries a bold token. */
function render(form, id = '1') {
  const label = `Phase ${id}: Name`;
  const wrapped = form.bold ? `${form.bold}${label}${form.bold}` : label;
  return `${form.indent}${form.marker}${form.gap1}[${form.state}]${form.gap2}${wrapped}`;
}

const isTicked = (form) => form.state !== ' ';

/**
 * A reader: `read(form)` -> verdict `{ found, ticked }`, or null when the form
 * is outside what that reader is meant to see (a bold-required reader skips
 * the bold-less forms).
 */
function pureReaders() {
  return [
    {
      name: 'validate.buildRoadmapPhaseVariants',
      read: (form) => ({
        found: buildRoadmapPhaseVariants(`# Roadmap\n\n${render(form)}\n`).roadmapPhases.has('1'),
        ticked: null,
      }),
    },
    {
      name: 'validate.buildNotStartedPhaseVariants',
      read: (form) => {
        const notStarted = buildNotStartedPhaseVariants(`# Roadmap\n\n${render(form)}\n`).has('1');
        // "not started" is the unchecked half: found-and-unchecked <=> state ' '.
        return { found: true, ticked: !notStarted };
      },
    },
    {
      name: 'phase-id.parsePhaseChecklistLine',
      read: (form) => {
        const parsed = parsePhaseChecklistLine(render(form), null);
        return { found: parsed !== null && parsed.phaseToken === '1', ticked: parsed ? parsed.checked : null };
      },
    },
    {
      name: 'roadmap.checklistEntrySrc',
      read: (form) => {
        if (!form.bold) return null; // bold-required reader
        const text = `# Roadmap\n\n${render(form)}\n`;
        const m = new RegExp(checklistEntrySrc(null), 'im').exec(text);
        return { found: m !== null, ticked: m ? isPhaseEntryChecked(m[0]) : null };
      },
    },
    {
      name: 'roadmap-parser.hasPhaseEntries',
      read: (form) => {
        if (!form.bold) return null; // bold-required reader
        return { found: hasPhaseEntries(`# Roadmap\n\n${render(form)}\n`), ticked: null };
      },
    },
  ];
}

/** Verdicts every reader must share for one form; returns the disagreements. */
function disagreements(form, readers) {
  const out = [];
  for (const reader of readers) {
    const verdict = reader.read(form);
    if (verdict === null) continue;
    if (!verdict.found) out.push(`${reader.name}: did not find ${JSON.stringify(render(form))}`);
    else if (verdict.ticked !== null && verdict.ticked !== isTicked(form)) {
      out.push(`${reader.name}: read ticked=${verdict.ticked} for ${JSON.stringify(render(form))}`);
    }
  }
  return out;
}

describe('phase-entry readers agree on the accepted grammar (#5763)', () => {
  test('every pure-string reader agrees on every accepted form', () => {
    fc.assert(
      fc.property(formArb, (form) => {
        assert.deepEqual(disagreements(form, pureReaders()), []);
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  test('positive control: a reader with a divergent private pattern is red', () => {
    const divergent = {
      // The pre-#5763 shape: hyphen only, lowercase x only, bold required.
      name: 'divergent-reader',
      read: (form) => {
        const m = /-\s*\[([ x])\]\s*\*\*Phase\s+1:/i.exec(render(form));
        return { found: m !== null, ticked: m ? m[1] === 'x' : null };
      },
    };
    const readers = [...pureReaders(), divergent];
    const reds = [];
    for (const marker of ['-', '*']) {
      for (const bold of ['**', '__']) {
        reds.push(...disagreements({ indent: '', marker, gap1: ' ', state: 'X', gap2: ' ', bold }, readers));
      }
    }
    assert.ok(reds.some((r) => r.startsWith('divergent-reader')), 'the divergent reader must be reported');
    assert.ok(!reds.some((r) => !r.startsWith('divergent-reader')), `real readers stay green: ${reds.join('; ')}`);
  });
});

describe('CLI readers agree on the accepted grammar (#5763)', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempProject();
  });
  afterEach(() => cleanup(tmpDir));

  function writeRoadmap(entries, details = '') {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Milestone: v1.0\n\n${entries.join('\n')}\n\n${details}`,
    );
  }

  test('roadmap analyze: roadmap_record and roadmap_complete follow the tick for every form', () => {
    fc.assert(
      fc.property(formArb.filter((f) => f.bold !== ''), (form) => {
        writeRoadmap([render(form)], '### Phase 1: Name\n\n**Goal**: g\n');
        const result = runGsdTools('roadmap analyze', tmpDir);
        assert.ok(result.success, result.error);
        const out = JSON.parse(result.output);
        assert.equal(out.roadmap_record['1'], isTicked(form), `roadmap_record for ${JSON.stringify(render(form))}`);
        assert.equal(out.phases[0].roadmap_complete, isTicked(form), `roadmap_complete for ${JSON.stringify(render(form))}`);
      }),
      { seed: SEED, numRuns: 30 },
    );
  });

  test('phase next-decimal sees a checklist sibling in every accepted form', () => {
    fc.assert(
      fc.property(formArb, (form) => {
        writeRoadmap([render(form, '1'), render(form, '1.1')], '### Phase 1: Name\n\n**Goal**: g\n');
        const result = runGsdTools('phase next-decimal 1 --raw', tmpDir);
        assert.ok(result.success, result.error);
        assert.match(result.output.trim(), /1\.2$/, `next decimal after ${JSON.stringify(render(form, '1.1'))}`);
      }),
      { seed: SEED, numRuns: 30 },
    );
  });
});
