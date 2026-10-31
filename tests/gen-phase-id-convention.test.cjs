'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');
const gen = require('../scripts/gen-phase-id-convention.cjs');
const { cleanup } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const roots = [];
afterEach(() => roots.splice(0).forEach(root => cleanup(root)));
const descriptor = { start: gen.START, end: gen.END };
const region = `${gen.START}\nowned\n${gen.END}\n`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-region-parser-'));
  roots.push(root);
  const owner = 'gsd-core/bin/lib/phase-id-card.cjs';
  fs.mkdirSync(path.dirname(path.join(root, owner)), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', owner), path.join(root, owner));
  for (const { file } of [...gen.TARGETS, gen.REFERENCE]) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const card = file === gen.REFERENCE.file
      ? '<!-- PHASE-ID-CARD:START -->\nold\n<!-- PHASE-ID-CARD:END -->\n'
      : '';
    fs.writeFileSync(absolute, `prefix.\n${card}${region}`);
  }
  assert.equal(gen.write(root).ok, true);
  return root;
}

test('a completed top-level paragraph terminates list continuation before a region', () => {
  const text = `- Conditional list item:\n  More list content.\n\nThis paragraph closes the list.\n\n${region}`;
  assert.equal(gen.readRegion(text, descriptor, 'fixture').body, 'owned');
});

test('region placement follows the wrapper decision table (fast-check)', () => {
  const shapes = [
    { prefix: '- Conditional item:\n  Still in the item.\n\n', suffix: '', nested: true },
    { prefix: '- Conditional item:\n\nA separate paragraph.\n\n', suffix: '', nested: false },
    { prefix: 'Only if `enabled`\n\n', suffix: '\ncontinue.\n', nested: true },
    { prefix: 'An unfinished sentence\n\n', suffix: '\ncontinues.\n', nested: true },
    { prefix: '<step name="conditional">\n', suffix: '</step>\n', nested: true },
    { prefix: '<step name="complete">\nDone.\n</step>\n\n', suffix: '', nested: false },
    { prefix: '<!-- OTHER:START -->\n', suffix: '<!-- OTHER:END -->\n', nested: true },
    { prefix: '<!-- OTHER:START -->\nDone.\n<!-- OTHER:END -->\n\n', suffix: '', nested: false },
    { prefix: '---\nname: fixture.\n', suffix: '---\n', nested: true },
    { prefix: '---\nname: fixture.\n---\n\n', suffix: '', nested: false },
  ];
  fc.assert(fc.property(fc.constantFrom(...shapes), fc.integer({ min: 0, max: 4 }), (shape, blanks) => {
    const parsed = gen.readRegion(shape.prefix + '\n'.repeat(blanks) + region + shape.suffix, descriptor, 'fixture');
    if (shape.nested) assert.equal(parsed.violation?.reason, 'nested_region');
    else assert.equal(parsed.body, 'owned');
  }), { seed: 5027, numRuns: 100 });
});

test('invalid backtick info strings do not open a fence around a region', () => {
  assert.equal(gen.readRegion('```not`a`fence\n\n' + region, descriptor, 'fixture').body, 'owned');
});

test('region fence nesting uses delimiter character and minimum closer length (fast-check)', () => {
  fc.assert(fc.property(
    fc.constantFrom('`', '~'),
    fc.integer({ min: 4, max: 8 }),
    fc.integer({ min: 0, max: 3 }),
    (char, length, indent) => {
      const open = ' '.repeat(indent) + char.repeat(length) + 'markdown\n';
      for (const closer of [char.repeat(length - 1), (char === '`' ? '~' : '`').repeat(length), char.repeat(length) + 'not-a-closer']) {
        const text = open + closer + '\n' + region + char.repeat(length) + '\n';
        assert.equal(gen.readRegion(text, descriptor, 'fixture').violation?.reason, 'nested_region');
      }
      const closed = open + 'artifact\n' + char.repeat(length + 1) + '\n\n' + region;
      assert.equal(gen.readRegion(closed, descriptor, 'fixture').body, 'owned');
    },
  ), { seed: 5027, numRuns: 100 });
});

for (const char of ['`', '~']) {
  test(`template artifact evidence respects ${char} delimiter type, length, and closing boundary`, () => {
    const root = fixture();
    const file = 'gsd-core/templates/summary.md';
    const absolute = path.join(root, file);
    const original = fs.readFileSync(absolute, 'utf8');
    const artifact = [
      char.repeat(4) + 'markdown',
      char.repeat(3),
      (char === '`' ? '~' : '`').repeat(4),
      char.repeat(4) + 'not-a-closer',
      'Write .planning/phases/XX-name/{phase}-{plan}-SUMMARY.md.',
      'Always write phase headings using sequential identifiers.',
      char.repeat(5),
    ].join('\n');
    fs.writeFileSync(absolute, original + '\n' + artifact + '\n');
    assert.deepEqual(gen.checkEvidence(root).violations, []);
    const prescription = 'Always write phase headings using sequential identifiers.';
    fs.appendFileSync(absolute, prescription + '\n');
    const violations = gen.checkEvidence(root).violations;
    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.equal(violations[0].evidence, prescription);
    assert.equal(violations[0].line, splitLines(fs.readFileSync(absolute, 'utf8').trimEnd()).length);
  });
}

test('a plain tilde summary artifact does not become external convention prose', () => {
  const root = fixture();
  const absolute = path.join(root, 'gsd-core/templates/summary.md');
  fs.appendFileSync(absolute, '\n~~~markdown\nAlways write phase headings using sequential identifiers.\n~~~\n');
  assert.deepEqual(gen.checkEvidence(root).violations, []);
});

for (const payload of [
  'Write .planning/phases/XX-name/{phase}-{plan}-SUMMARY.md.',
  'Full write path: .planning/phases/XX-name/01-PLAN.md',
  '## Phase ${PHASE}: Foundation',
  '**Phase ${phase}: Foundation**',
  'Always include project_code in the directory name.',
  'Always include project_code in phase headings.',
  'Always include project_code in the checklist header.',
  '- [ ] **Phase 7: Foundation**',
]) {
  test(`independent evidence catches identity emission: ${payload}`, () => {
    const root = fixture();
    fs.appendFileSync(path.join(root, gen.TARGETS[0].file), '\n' + payload + '\n');
    assert.ok(gen.checkEvidence(root).violations.some(v => v.reason === 'external_convention_prose' && v.evidence === payload));
  });
}

test('phase ordering and wing lookup do not prescribe emitted phase identifiers', () => {
  const root = fixture();
  fs.appendFileSync(path.join(root, 'agents/gsd-roadmapper.md'), '\n## Phase Numbering\n\n**Integer phases (1, 2, 3):** Planned milestone work.\n');
  fs.appendFileSync(path.join(root, 'agents/gsd-mempalace-curator.md'), '\n- **Wing:** `mempalace.wing` if non-empty, else `project_code`, else the repo directory name. Every call you make is scoped to this one wing.\n');
  assert.deepEqual(gen.checkEvidence(root).violations, []);
  const prescription = 'Never include project_code in phase headings.';
  fs.appendFileSync(path.join(root, 'agents/gsd-mempalace-curator.md'), prescription + '\n');
  assert.ok(gen.checkEvidence(root).violations.some(v => v.evidence === prescription));
});

test('numbered internal procedure stages are not emitted project phase labels', () => {
  const root = fixture();
  fs.appendFileSync(path.join(root, gen.TARGETS[0].file), '\n**Phase 0: Check knowledge base**\n**Phase 1.25: Spectrum-based fault localization**\n');
  fs.writeFileSync(path.join(root, 'gsd-core/workflows/internal-stages.md'), '**Phase 1: Verify canonical docs (generated/updated docs)**\n');
  assert.deepEqual(gen.checkEvidence(root).violations, []);
});
