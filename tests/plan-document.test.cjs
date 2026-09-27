'use strict';

/**
 * Unit tests for plan-document.cjs
 *
 * Module: gsd-core/bin/lib/plan-document.cjs
 *
 * Covers the `tracker-id` attribute (ADR-3646 Phase 1, #3970) added to the
 * `<task>` element grammar, plus regression coverage proving the addition
 * does not alter pre-existing task-parsing behaviour.
 *
 * Matrix rows referenced below are from
 * .gsd/phase/feat-3970-task-content-resolution-seam/50-test-matrix.md
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { parsePlanDocument } = require('../gsd-core/bin/lib/plan-document.cjs');

describe('plan-document: tracker-id attribute', () => {
  test('row 1 — no tracker-id attribute yields trackerId: null', () => {
    const doc = parsePlanDocument(`
<task type="auto">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.tasks[0].trackerId, null);
  });

  test('row 2 — tracker-id is read verbatim, never split', () => {
    const doc = parsePlanDocument(`
<task type="auto" tracker-id="beads:GSD-42">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.tasks[0].trackerId, 'beads:GSD-42');
  });

  test('row 3 — tracker-id="" (empty string) normalises to null', () => {
    const doc = parsePlanDocument(`
<task type="auto" tracker-id="">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.tasks[0].trackerId, null);
  });

  test('row 4 — checkpoint tasks never read tracker-id, even when present', () => {
    const doc = parsePlanDocument(`
<task type="checkpoint:decision" tracker-id="beads:GSD-99">
<decision>Ship it</decision>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.tasks[0].kind, 'checkpoint');
    assert.equal(doc.tasks[0].trackerId, null);
  });
});

describe('plan-document: tdd attribute (#4273)', () => {
  test('row 1 — tdd="true" is read verbatim', () => {
    const doc = parsePlanDocument(`
<task type="auto" tdd="true">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.tasks[0].tdd, 'true');
  });

  test('row 2 — no tdd attribute yields tdd: null', () => {
    const doc = parsePlanDocument(`
<task type="auto">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.tasks[0].tdd, null);
  });

  test('row 3 — tdd="" (empty string) normalises to null', () => {
    const doc = parsePlanDocument(`
<task type="auto" tdd="">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.tasks[0].tdd, null);
  });

  test('row 4 — tdd="TRUE" and tdd="1" are read verbatim, never coerced to a boolean', () => {
    const docUpper = parsePlanDocument(`
<task type="auto" tdd="TRUE">
<name>Do a thing</name>
</task>
`);
    assert.equal(docUpper.tasks[0].tdd, 'TRUE');
    assert.notEqual(docUpper.tasks[0].tdd, 'true');

    const docNumeric = parsePlanDocument(`
<task type="auto" tdd="1">
<name>Do a thing</name>
</task>
`);
    assert.equal(docNumeric.tasks[0].tdd, '1');
  });

  test('row 5 — checkpoint tasks never read tdd, even when present', () => {
    const doc = parsePlanDocument(`
<task type="checkpoint:decision" tdd="true">
<decision>Ship it</decision>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    assert.equal(doc.tasks[0].kind, 'checkpoint');
    assert.equal(doc.tasks[0].tdd, null);
  });
});

describe('plan-document: frontmatter type (#4273)', () => {
  test('row 6 — frontmatter type: tdd is read verbatim onto doc.type', () => {
    const doc = parsePlanDocument(`---
type: tdd
---
<task type="auto">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.type, 'tdd');
  });

  test('row 7 — frontmatter type: standard is read verbatim, not coerced to a boolean', () => {
    const doc = parsePlanDocument(`---
type: standard
---
<task type="auto">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.type, 'standard');
  });

  test('row 8 — no frontmatter type yields doc.type: null', () => {
    const doc = parsePlanDocument(`
<task type="auto">
<name>Do a thing</name>
</task>
`);
    assert.equal(doc.type, null);
  });
});

describe('plan-document: frontmatter gap_closure (#4924)', () => {
  test('gap_closure: true is read as gapClosure: true', () => {
    const doc = parsePlanDocument('---\nwave: 1\ngap_closure: true\n---\n<objective>Gap.</objective>\n');
    assert.equal(doc.gapClosure, true);
  });

  test('absent gap_closure yields gapClosure: false', () => {
    const doc = parsePlanDocument('---\nwave: 1\n---\n<objective>Standard.</objective>\n');
    assert.equal(doc.gapClosure, false);
  });

  test('gap_closure: false and off-contract spellings yield gapClosure: false', () => {
    for (const value of ['false', 'True', 'yes']) {
      const doc = parsePlanDocument(`---\nwave: 1\ngap_closure: ${value}\n---\n<objective>x</objective>\n`);
      assert.equal(doc.gapClosure, false, `gap_closure: ${value} must not read as a gap-closure plan`);
    }
  });
});

describe('plan-document: regression — legacy behaviour unchanged', () => {
  test('legacy `## Task N` markdown fallback still parses with trackerId: null', () => {
    const doc = parsePlanDocument(`
## Task 1: Do a thing

Some body text.

## Task 2: Do another thing
`);
    assert.equal(doc.tasks.length, 2);
    for (const t of doc.tasks) {
      assert.equal(t.kind, 'auto');
      assert.equal(t.type, null);
      assert.equal(t.trackerId, null);
      assert.deepEqual(t.plannedFiles, []);
      assert.deepEqual(t.acceptanceCriteria, []);
      assert.equal(t.done, null);
    }
    assert.equal(doc.tasks[0].name, 'Task 1: Do a thing');
    assert.equal(doc.tasks[1].name, 'Task 2: Do another thing');
  });

  test('ordinary task with name/files/acceptance_criteria still parses correctly alongside trackerId', () => {
    const doc = parsePlanDocument(`
<task type="auto" tracker-id="beads:GSD-7">
<name>Implement the seam</name>
<files>src/a.cts, src/b.cts</files>
<acceptance_criteria>
- criterion one
- criterion two
</acceptance_criteria>
<done>Merged.</done>
</task>
`);
    assert.equal(doc.tasks.length, 1);
    const t = doc.tasks[0];
    assert.equal(t.kind, 'auto');
    assert.equal(t.type, 'auto');
    assert.equal(t.name, 'Implement the seam');
    assert.deepEqual(t.plannedFiles, ['src/a.cts', 'src/b.cts']);
    assert.deepEqual(t.acceptanceCriteria, ['criterion one', 'criterion two']);
    assert.equal(t.done, 'Merged.');
    assert.equal(t.trackerId, 'beads:GSD-7');
  });
});

describe('plan-document: frontmatter field absorption (#5026) — before/after parity', () => {
  // #5026: parsePlanDocument's 7 frontmatter-derived fields (wave, depends_on,
  // autonomous, agent_hint, files_modified, files_deleted, type) migrated from
  // a direct frontmatter.cjs#extractFrontmatter call onto
  // planning-document.cjs#readFrontmatterFieldFromSource. Every expected
  // value below is the value the PRE-migration direct-extractFrontmatter call
  // produced for the same fixture (per the module's own documented field
  // semantics: dependsOn defaults `[]`, autonomous defaults `true`,
  // agentHint/type default `null`, filesModified/filesDeleted default `[]`,
  // declaredWave defaults `null` on absence or non-numeric input) — this is
  // the primary safety net proving the migration is behavior-preserving.

  test('no frontmatter at all: every field takes its documented default', () => {
    const doc = parsePlanDocument('<task type="auto"><name>x</name></task>');
    assert.equal(doc.declaredWave, null);
    assert.deepEqual(doc.dependsOn, []);
    assert.equal(doc.autonomous, true);
    assert.equal(doc.agentHint, null);
    assert.deepEqual(doc.filesModified, []);
    assert.deepEqual(doc.filesDeleted, []);
    assert.equal(doc.type, null);
  });

  test('every field present with scalar values reads verbatim/coerced per field', () => {
    const doc = parsePlanDocument(`---
wave: 2
depends_on: 01-first
autonomous: false
agent_hint: sonnet-coder
files_modified: src/a.cts
files_deleted: src/old.cts
type: standard
---
<task type="auto"><name>x</name></task>
`);
    assert.equal(doc.declaredWave, 2);
    assert.deepEqual(doc.dependsOn, ['01-first']);
    assert.equal(doc.autonomous, false);
    assert.equal(doc.agentHint, 'sonnet-coder');
    assert.deepEqual(doc.filesModified, ['src/a.cts']);
    assert.deepEqual(doc.filesDeleted, ['src/old.cts']);
    assert.equal(doc.type, 'standard');
  });

  test('array-valued depends_on / files_modified / files_deleted read as string arrays', () => {
    const doc = parsePlanDocument(`---
depends_on: [01-first, 02-second]
files_modified: [src/a.cts, src/b.cts]
files_deleted: [src/c.cts]
---
<task type="auto"><name>x</name></task>
`);
    assert.deepEqual(doc.dependsOn, ['01-first', '02-second']);
    assert.deepEqual(doc.filesModified, ['src/a.cts', 'src/b.cts']);
    assert.deepEqual(doc.filesDeleted, ['src/c.cts']);
  });

  test('hyphenated alternate keys (files-modified / files-deleted) are honored', () => {
    const doc = parsePlanDocument(`---
files-modified: src/hyphen-modified.cts
files-deleted: src/hyphen-deleted.cts
---
<task type="auto"><name>x</name></task>
`);
    assert.deepEqual(doc.filesModified, ['src/hyphen-modified.cts']);
    assert.deepEqual(doc.filesDeleted, ['src/hyphen-deleted.cts']);
  });

  test('an empty depends_on string does not produce a single empty-string entry', () => {
    const doc = parsePlanDocument(`---
depends_on: ""
---
<task type="auto"><name>x</name></task>
`);
    assert.deepEqual(doc.dependsOn, []);
  });

  test('a whitespace-only agent_hint normalizes to null', () => {
    const doc = parsePlanDocument(`---
agent_hint: "   "
---
<task type="auto"><name>x</name></task>
`);
    assert.equal(doc.agentHint, null);
  });

  test('autonomous: any non-"true" string value (not just "false") is false', () => {
    const doc = parsePlanDocument(`---
autonomous: maybe
---
<task type="auto"><name>x</name></task>
`);
    assert.equal(doc.autonomous, false);
  });

  test('a non-numeric wave value yields declaredWave: null', () => {
    const doc = parsePlanDocument(`---
wave: not-a-number
---
<task type="auto"><name>x</name></task>
`);
    assert.equal(doc.declaredWave, null);
  });

  test('malformed (unparseable) frontmatter: every field falls back to its default, exactly as absent frontmatter', () => {
    const doc = parsePlanDocument(`---
wave: [1, 2
depends_on: 01-first
---
<task type="auto"><name>x</name></task>
`);
    assert.equal(doc.declaredWave, null);
    assert.deepEqual(doc.dependsOn, []);
    assert.equal(doc.autonomous, true);
    assert.equal(doc.agentHint, null);
    assert.deepEqual(doc.filesModified, []);
    assert.deepEqual(doc.filesDeleted, []);
    assert.equal(doc.type, null);
  });

  test('objective frontmatter fallback still reads when no <objective> tag is present', () => {
    const doc = parsePlanDocument(`---
objective: Ship the thing
---
<task type="auto"><name>x</name></task>
`);
    assert.equal(doc.objective, 'Ship the thing');
  });

  test('an <objective> tag still wins over a frontmatter objective fallback', () => {
    const doc = parsePlanDocument(`---
objective: frontmatter objective
---
<objective>
tag objective wins
</objective>
<task type="auto"><name>x</name></task>
`);
    assert.equal(doc.objective, 'tag objective wins');
  });
});

describe('plan-document: extractThreatRegisterIds (#4683)', () => {
  const { extractThreatRegisterIds } = require('../gsd-core/bin/lib/plan-document.cjs');

  const register = (rows) => [
    '<threat_model>',
    '| Threat ID | Category | Component | Severity | Disposition | Mitigation |',
    '|-----------|----------|-----------|----------|-------------|------------|',
    ...rows,
    '</threat_model>',
  ].join('\n');

  test('extracts first-cell IDs in document order', () => {
    const ids = extractThreatRegisterIds(register([
      '| T-47-01 | Tampering | c | high | mitigate | fix |',
      '| T-47-02 | Repudiation | c | low | accept | rationale |',
      '| T-47-19 | DoS | c | medium | mitigate | fix |',
    ]));
    assert.deepEqual(ids, ['T-47-01', 'T-47-02', 'T-47-19']);
  });

  test('the reserved -SC supply-chain row never matches', () => {
    const ids = extractThreatRegisterIds(register([
      '| T-47-SC | Tampering | npm installs | high | mitigate | gate |',
      '| T-47-01 | Tampering | c | high | mitigate | fix |',
    ]));
    assert.deepEqual(ids, ['T-47-01']);
  });

  test('decimal phases match (T-4.1-05)', () => {
    const ids = extractThreatRegisterIds(register(['| T-4.1-05 | Tampering | c | low | accept | r |']));
    assert.deepEqual(ids, ['T-4.1-05']);
  });

  test('rows outside a threat_model block never count', () => {
    const ids = extractThreatRegisterIds([
      '# Plan',
      '',
      'See T-47-01 in SECURITY.md. | T-47-02 | not a register |',
      '',
      register(['| T-47-03 | Tampering | c | high | mitigate | fix |']),
    ].join('\n'));
    assert.deepEqual(ids, ['T-47-03']);
  });

  test('a register quoted inside a backtick fence is prose, not a claim', () => {
    const quoted = ['```markdown', register(['| T-47-01 | Tampering | c | high | mitigate | fix |']), '```'].join('\n');
    const live = register(['| T-47-02 | Repudiation | c | low | accept | r |']);
    assert.deepEqual(extractThreatRegisterIds(`${quoted}\n\n${live}`), ['T-47-02']);
  });

  test('a tilde fence is stripped the same way', () => {
    const quoted = ['~~~', register(['| T-47-01 | Tampering | c | high | mitigate | fix |']), '~~~'].join('\n');
    const live = register(['| T-47-02 | Repudiation | c | low | accept | r |']);
    assert.deepEqual(extractThreatRegisterIds(`${quoted}\n\n${live}`), ['T-47-02']);
  });

  test('an unclosed fence suppresses everything after it', () => {
    const doc = [register(['| T-47-01 | Tampering | c | high | mitigate | fix |']), '```', register(['| T-47-02 | DoS | c | low | accept | r |'])].join('\n');
    assert.deepEqual(extractThreatRegisterIds(doc), ['T-47-01']);
  });

  test('block tags are case-insensitive', () => {
    const ids = extractThreatRegisterIds([
      '<THREAT_MODEL>', '| T-47-05 | Tampering | c | high | mitigate | fix |', '</THREAT_MODEL>',
    ].join('\n'));
    assert.deepEqual(ids, ['T-47-05']);
  });

  test('multiple blocks yield IDs across both, in order', () => {
    const doc = [
      register(['| T-47-01 | Tampering | c | high | mitigate | fix |']),
      '',
      register(['| T-47-02 | Repudiation | c | low | accept | r |']),
    ].join('\n');
    assert.deepEqual(extractThreatRegisterIds(doc), ['T-47-01', 'T-47-02']);
  });

  test('CRLF rows are read the same as LF', () => {
    const ids = extractThreatRegisterIds(register(['| T-47-07 | Tampering | c | high | mitigate | fix |']).replace(/\n/g, '\r\n'));
    assert.deepEqual(ids, ['T-47-07']);
  });

  test('indented rows still match on the first cell', () => {
    const ids = extractThreatRegisterIds([
      '<threat_model>', '  | T-47-09 | Tampering | c | high | mitigate | fix |', '</threat_model>',
    ].join('\n'));
    assert.deepEqual(ids, ['T-47-09']);
  });

  test('annotated first cells are knowingly unmatched (accepted residual)', () => {
    const ids = extractThreatRegisterIds(register(['| T-47-06 (revised) | Tampering | c | high | mitigate | fix |']));
    assert.deepEqual(ids, []);
  });

  test('content without any threat_model block yields an empty list', () => {
    assert.deepEqual(extractThreatRegisterIds('# Plan\n\nDo things.\n'), []);
  });
});
