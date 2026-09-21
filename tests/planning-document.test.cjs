/**
 * PlanningDoc seam — parse -> mutate -> serialize (ADR-4910, epic #4906 Phase 1,
 * #4917). Covers every row of `.gsd/phase/feat-4917-planning-document-seam/50-test-matrix.md`.
 *
 * All assertions are structural: either a typed Result/NodeRead/SerializeOutcome
 * shape, or a byte-range comparison computed from the node's OWN `Span` offsets
 * (never a hardcoded literal expectation of rendered prose) — per CONTRIBUTING.md
 * "Prohibited: Raw Text Matching on Test Outputs". Full-string byte-identity
 * comparisons (`assert.strictEqual(result, source)`) are used only where the
 * module's contract IS byte equality: rows 3, 15, 21, 22, 23.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const MODULE_PATH = '../gsd-core/bin/lib/planning-document.cjs';
const ARTIFACTS_PATH = '../gsd-core/bin/lib/artifacts.cjs';

let mod;
try {
  mod = require(MODULE_PATH);
} catch (err) {
  throw new Error(`Could not require ${MODULE_PATH}. Run "npm run build:lib" first. Underlying: ${err.message}`);
}
const { parsePlanningDoc, findField, readNode, setFieldValue, hasUnreadableNodes, serialize, PLANNING_ARTIFACTS } = mod;

const artifactsMod = require(ARTIFACTS_PATH);
const { isCanonicalPlanningFile, CANONICAL_EXACT } = artifactsMod;

const ARTIFACT = 'STATE.md';
const EM_DASH = '—';

/** Parse and assert success, returning the PlanningDoc value. */
function parseOk(source, artifact = ARTIFACT) {
  const result = parsePlanningDoc(source, artifact);
  assert.strictEqual(result.ok, true, `expected parse to succeed: ${JSON.stringify(result)}`);
  return result.value;
}

// ─── Row 1 / 2: happy path — byte-range preservation ───────────────────────────

describe('row 1-2: setFieldValue + serialize preserve every byte outside valueSpan', () => {
  test('setFieldValue preserves every byte outside the value span', () => {
    const source = [
      '---',
      'title: Fixture',
      '---',
      '',
      '**Plans:** initial value',
      '**Status:** pending',
      '',
    ].join('\n');

    const doc = parseOk(source);
    const id = findField(doc, 'Plans');
    assert.ok(id);
    const node = doc.nodes.find((n) => n.id === id);

    const staged = setFieldValue(doc, id, 'updated value');
    assert.strictEqual(staged.ok, true);
    const outcome = serialize(staged.value);
    assert.strictEqual(outcome.ok, true);

    const before = source.slice(0, node.valueSpan.start);
    const after = source.slice(node.valueSpan.end);
    assert.strictEqual(outcome.value.slice(0, node.valueSpan.start), before);
    assert.strictEqual(outcome.value.slice(node.valueSpan.start + 'updated value'.length), after);
  });

  test('a field write does not touch trailing prose on the same line (#4852/#4862)', () => {
    const source = [
      '---',
      'title: Fixture',
      '---',
      '',
      `**Summary:** short summary ${EM_DASH} hand-written annotation stays`,
      '',
    ].join('\n');

    const doc = parseOk(source);
    const id = findField(doc, 'Summary');
    const node = doc.nodes.find((n) => n.id === id);
    assert.strictEqual(node.kind, 'boldField');

    // The trailing annotation lives entirely past valueSpan.end.
    const trailingBefore = source.slice(node.valueSpan.end, node.trailingSpan.end);

    const staged = setFieldValue(doc, id, 'new short summary');
    const outcome = serialize(staged.value);
    assert.strictEqual(outcome.ok, true);

    const trailingAfter = outcome.value.slice(
      node.valueSpan.start + 'new short summary'.length,
      node.valueSpan.start + 'new short summary'.length + trailingBefore.length,
    );
    assert.strictEqual(trailingAfter, trailingBefore);
  });
});

// ─── Row 3/4/5: boundary — limit-1 (0 edits), limit (1 edit), limit+1 (2 edits) ─

describe('row 3-5: staged-edit count boundary', () => {
  const source = [
    '---',
    'title: Fixture',
    '---',
    '',
    '**Alpha:** one',
    '**Beta:** two',
    '',
  ].join('\n');

  test('serialize with no edits returns the original bytes (limit-1)', () => {
    const doc = parseOk(source);
    const outcome = serialize(doc);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.value, source);
  });

  test('a single staged edit splices exactly one span (limit)', () => {
    const doc = parseOk(source);
    const id = findField(doc, 'Alpha');
    const node = doc.nodes.find((n) => n.id === id);
    const staged = setFieldValue(doc, id, 'ONE');
    const outcome = serialize(staged.value);
    assert.strictEqual(outcome.ok, true);
    const expectedLength = source.length - (node.valueSpan.end - node.valueSpan.start) + 'ONE'.length;
    assert.strictEqual(outcome.value.length, expectedLength);
    assert.strictEqual(outcome.value.slice(0, node.valueSpan.start), source.slice(0, node.valueSpan.start));
    assert.strictEqual(outcome.value.slice(node.valueSpan.start + 'ONE'.length), source.slice(node.valueSpan.end));
  });

  test('two edits on different nodes both apply without offset drift (limit+1)', () => {
    const doc = parseOk(source);
    const idA = findField(doc, 'Alpha');
    const idB = findField(doc, 'Beta');
    const nodeA = doc.nodes.find((n) => n.id === idA);
    const nodeB = doc.nodes.find((n) => n.id === idB);

    const staged1 = setFieldValue(doc, idA, 'ALPHA-NEW');
    const staged2 = setFieldValue(staged1.value, idB, 'BETA-NEW');
    const outcome = serialize(staged2.value);
    assert.strictEqual(outcome.ok, true);

    // Region strictly between the two fields is untouched.
    const between = source.slice(nodeA.valueSpan.end, nodeB.valueSpan.start);
    const resultBetween = outcome.value.slice(
      nodeA.valueSpan.start + 'ALPHA-NEW'.length,
      nodeA.valueSpan.start + 'ALPHA-NEW'.length + between.length,
    );
    assert.strictEqual(resultBetween, between);

    // Tail after Beta's original span is untouched, offset by both edits' delta.
    const tailBefore = source.slice(nodeB.valueSpan.end);
    const deltaA = 'ALPHA-NEW'.length - (nodeA.valueSpan.end - nodeA.valueSpan.start);
    const deltaB = 'BETA-NEW'.length - (nodeB.valueSpan.end - nodeB.valueSpan.start);
    const tailStart = nodeB.valueSpan.end + deltaA + deltaB;
    assert.strictEqual(outcome.value.slice(tailStart), tailBefore);
  });
});

// ─── Row 6: duplicate/conflicting — same node edited twice ─────────────────────

describe('row 6: a second edit to one node replaces the first', () => {
  test('last write wins; span applied once', () => {
    const source = ['---', 'title: Fixture', '---', '', '**Alpha:** one', ''].join('\n');
    const doc = parseOk(source);
    const id = findField(doc, 'Alpha');
    const node = doc.nodes.find((n) => n.id === id);

    const staged1 = setFieldValue(doc, id, 'first');
    const staged2 = setFieldValue(staged1.value, id, 'second');

    // Staged map collapses to exactly one entry for this id.
    assert.strictEqual(staged2.value.staged.size, 1);
    assert.strictEqual(staged2.value.staged.get(id), 'second');

    const outcome = serialize(staged2.value);
    assert.strictEqual(outcome.ok, true);
    const expectedLength = source.length - (node.valueSpan.end - node.valueSpan.start) + 'second'.length;
    assert.strictEqual(outcome.value.length, expectedLength);
    assert.strictEqual(readNode(staged2.value, id).value, 'second');
  });
});

// ─── Row 7: negative — id not from this doc ────────────────────────────────────

describe('row 7: setFieldValue refuses a node id this document did not mint', () => {
  test('an id minted by a different PlanningDoc is refused', () => {
    const source = ['---', 'title: Fixture', '---', '', '**Alpha:** one', ''].join('\n');
    const docA = parseOk(source);
    const docB = parseOk(source);
    const idFromB = findField(docB, 'Alpha');

    const result = setFieldValue(docA, idFromB, 'x');
    assert.strictEqual(result.ok, false);
  });

  test('a wholly unknown id is refused', () => {
    const source = ['---', 'title: Fixture', '---', '', '**Alpha:** one', ''].join('\n');
    const doc = parseOk(source);
    const result = setFieldValue(doc, 'not-a-real-id', 'x');
    assert.strictEqual(result.ok, false);
  });
});

// ─── Row 8/9/10: ragged table — unreadable node + sibling readability ──────────

function raggedTableSource() {
  return [
    '---',
    'title: Fixture',
    '---',
    '',
    '**Before:** sibling one',
    '',
    '| A | B |',
    '|---|---|',
    '| onlyone |',
    '',
    '**After:** sibling two',
    '',
  ].join('\n');
}

describe('row 8: an unreadable node does not make its siblings unreadable', () => {
  test('the ragged table node carries an error; both bordering fields stay readable', () => {
    const doc = parseOk(raggedTableSource());
    const tableNode = doc.nodes.find((n) => n.kind === 'table');
    assert.ok(tableNode);
    assert.ok(tableNode.error);
    assert.strictEqual(hasUnreadableNodes(doc), true);

    const beforeId = findField(doc, 'Before');
    const afterId = findField(doc, 'After');
    assert.strictEqual(readNode(doc, beforeId).ok, true);
    assert.strictEqual(readNode(doc, afterId).ok, true);

    const tableRead = readNode(doc, tableNode.id);
    assert.strictEqual(tableRead.ok, false);
  });
});

describe('row 9-10: serialize refuses on any unreadable node, edit or not', () => {
  test('serialize refuses when any node is unreadable, with a staged edit', () => {
    const doc = parseOk(raggedTableSource());
    const beforeId = findField(doc, 'Before');
    const staged = setFieldValue(doc, beforeId, 'edited');
    assert.strictEqual(staged.ok, true);

    const outcome = serialize(staged.value);
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.reason, 'unreadable-nodes');
    assert.strictEqual(outcome.nodes.length, 1);
    assert.strictEqual(outcome.nodes[0].kind, 'table');
  });

  test('the refusal is about the document, not the mutation (no staged edit)', () => {
    const doc = parseOk(raggedTableSource());
    assert.strictEqual(doc.staged.size, 0);

    const outcome = serialize(doc);
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.reason, 'unreadable-nodes');
    assert.strictEqual(outcome.nodes.length, 1);
    assert.strictEqual(outcome.nodes[0].kind, 'table');
  });
});

// ─── Row 11/12: empty / whitespace-only input ──────────────────────────────────

describe('row 11-12: empty and whitespace-only documents', () => {
  test('an empty document parses to no nodes, not to could-not-parse', () => {
    const doc = parseOk('');
    assert.strictEqual(doc.nodes.length, 0);
  });

  test('a whitespace-only document is empty, not unparseable', () => {
    const doc = parseOk('   \n\t\n   \n');
    assert.strictEqual(doc.nodes.length, 0);
  });
});

// ─── Row 13/14: document-level malformed input ─────────────────────────────────

describe('row 13-14: document-level Result failure', () => {
  test('a document with no frontmatter terminator fails at the document level', () => {
    const source = ['---', 'title: Fixture', 'this fence is never closed', ''].join('\n');
    const result = parsePlanningDoc(source, ARTIFACT);
    assert.strictEqual(result.ok, false);
  });

  test('parsing a non-planning document fails at the document level', () => {
    const source = ['---', 'title: Fixture', '---', '', '**Alpha:** one', ''].join('\n');
    // The identical source parses OK under a canonical artifact name...
    const good = parsePlanningDoc(source, ARTIFACT);
    assert.strictEqual(good.ok, true);
    // ...and fails purely because of the artifact kind under a bogus one.
    const bad = parsePlanningDoc(source, 'NOT-A-PLANNING-FILE.md');
    assert.strictEqual(bad.ok, false);
  });

  test('a non-markdown canonical planning file is refused at the document level', () => {
    // config.json/state.json/milestone.lock are canonical per artifacts.cjs but
    // carry no markdown grammar — this must be a document-level refusal, never
    // a successful empty document (row 28 / design.md row 16).
    assert.ok(isCanonicalPlanningFile('config.json'));
    const result = parsePlanningDoc('{}', 'config.json');
    assert.strictEqual(result.ok, false);
  });
});

// ─── Row 15: CRLF round-trip ────────────────────────────────────────────────────

describe('row 15: CRLF documents round-trip byte-identically', () => {
  const source = ['---', 'title: Fixture', '---', '', '**Alpha:** one', '**Beta:** two', ''].join('\r\n');

  test('no-op serialize on a CRLF document is byte-identical', () => {
    const doc = parseOk(source);
    const outcome = serialize(doc);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.value, source);
  });

  test('a single edit on a CRLF document preserves every byte outside valueSpan', () => {
    const doc = parseOk(source);
    const id = findField(doc, 'Alpha');
    const node = doc.nodes.find((n) => n.id === id);
    const staged = setFieldValue(doc, id, 'ALPHA');
    const outcome = serialize(staged.value);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.value.slice(0, node.valueSpan.start), source.slice(0, node.valueSpan.start));
    assert.strictEqual(outcome.value.slice(node.valueSpan.start + 'ALPHA'.length), source.slice(node.valueSpan.end));
  });
});

// ─── Row 16: hostile field value — markdown metacharacters ─────────────────────

describe('row 16: a field value containing markdown metacharacters round-trips', () => {
  test('pipes, backticks, and bold markers read back verbatim', () => {
    const rawValue = 'a | b `code` **bold** end';
    const source = ['---', 'title: Fixture', '---', '', `**Data:** ${rawValue}`, ''].join('\n');
    const doc = parseOk(source);
    const id = findField(doc, 'Data');
    assert.strictEqual(readNode(doc, id).value, rawValue);

    const node = doc.nodes.find((n) => n.id === id);
    const staged = setFieldValue(doc, id, rawValue);
    const outcome = serialize(staged.value);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.value.slice(0, node.valueSpan.start), source.slice(0, node.valueSpan.start));
    assert.strictEqual(outcome.value.slice(node.valueSpan.start + rawValue.length), source.slice(node.valueSpan.end));
  });
});

// ─── Row 17-20: negative space ──────────────────────────────────────────────────

describe('row 17-20: negative space (looks like the target, is not)', () => {
  test('bold emphasis in prose is not a field label', () => {
    const source = [
      '---',
      'title: Fixture',
      '---',
      '',
      'This is **emphasis** in prose, not a field.',
      '**Bold statement** without a colon.',
      '',
    ].join('\n');
    const doc = parseOk(source);
    assert.strictEqual(doc.nodes.some((n) => n.kind === 'boldField'), false);
  });

  test('a field-shaped line inside a fenced block is not a node', () => {
    const source = ['---', 'title: Fixture', '---', '', '```', '**Label:** value', '```', ''].join('\n');
    const doc = parseOk(source);
    assert.strictEqual(findField(doc, 'Label'), null);
    assert.strictEqual(doc.nodes.some((n) => n.kind === 'boldField'), false);
  });

  test('a field-shaped line inside an inline code span is not a node', () => {
    const source = ['---', 'title: Fixture', '---', '', '`**Label:** value`', ''].join('\n');
    const doc = parseOk(source);
    assert.strictEqual(findField(doc, 'Label'), null);
  });

  test('a horizontal rule is not a frontmatter terminator', () => {
    const source = [
      '---',
      'title: Fixture',
      '---',
      '',
      '## Section',
      '',
      'Some text.',
      '',
      '---',
      '',
      'More text after the rule.',
    ].join('\n');
    const doc = parseOk(source);
    const frontmatterNodes = doc.nodes.filter((n) => n.kind === 'frontmatter');
    assert.strictEqual(frontmatterNodes.length, 1);
    // The frontmatter span ends at the FIRST closing fence, well before the
    // horizontal rule further down the document.
    const secondRuleOffset = source.lastIndexOf('\n---\n');
    assert.ok(frontmatterNodes[0].span.end < secondRuleOffset);
  });
});

// ─── Row 21: hostile round-trip — pre-escaped table cell ───────────────────────

describe('row 21: an untouched escaped cell is not re-escaped', () => {
  test('a pre-escaped pipe in a table cell is byte-identical with zero edits', () => {
    const source = [
      '---',
      'title: Fixture',
      '---',
      '',
      '| Col A | Col B |',
      '|---|---|',
      '| has \\| pipe | plain |',
      '',
    ].join('\n');
    const doc = parseOk(source);
    assert.strictEqual(hasUnreadableNodes(doc), false);
    const outcome = serialize(doc);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.value, source);
  });
});

// ─── Row 22/23: document-shaped fast-check properties ──────────────────────────
//
// Per CONTRIBUTING.md fixture-provenance (#2371): the generator below builds
// documents directly from arbitrary frontmatter/heading/label/value TEXT
// pieces assembled with `.join('\n')` — it never calls `serialize` (or any
// other function from the module under test) to produce its fixtures. Seeding
// from the module's own writer would make the document shape a constant and
// the property could never explore a shape the writer wouldn't itself emit.

const safeLabelArb = fc
  .stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,12}$/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const safeValueArb = fc.stringMatching(/^[A-Za-z0-9 .,!?]{0,20}$/);

const fieldArb = fc.record({ label: safeLabelArb, value: safeValueArb });

const documentPiecesArb = fc.record({
  heading: fc
    .stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,15}$/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
  fields: fc.uniqueArray(fieldArb, { minLength: 1, maxLength: 5, selector: (r) => r.label.toLowerCase() }),
  mutateIndex: fc.nat(),
  newValue: fc.stringMatching(/^[A-Za-z0-9 .,!?]{0,25}$/),
});

/** Assemble a document TEXT from arbitrary document-shaped pieces (never via
 * the module's own serializer — see the #2371 note above). */
function buildDocumentText({ heading, fields }) {
  return [
    '---',
    'title: generated fixture',
    '---',
    '',
    `## ${heading}`,
    '',
    ...fields.map((f) => `**${f.label}:** ${f.value}`),
    '',
    'Trailing prose line unrelated to any field.',
  ].join('\n');
}

describe('row 22-23: document-shaped fast-check properties', () => {
  test('property: a single node mutation leaves every other byte identical', () => {
    fc.assert(
      fc.property(documentPiecesArb, (pieces) => {
        const source = buildDocumentText(pieces);
        const parsed = parsePlanningDoc(source, ARTIFACT);
        assert.strictEqual(parsed.ok, true);
        const doc = parsed.value;

        const idx = pieces.mutateIndex % pieces.fields.length;
        const label = pieces.fields[idx].label;
        const id = findField(doc, label);
        assert.ok(id, `expected to find field ${JSON.stringify(label)}`);

        const node = doc.nodes.find((n) => n.id === id);
        const staged = setFieldValue(doc, id, pieces.newValue);
        assert.strictEqual(staged.ok, true);
        const outcome = serialize(staged.value);
        assert.strictEqual(outcome.ok, true);

        const before = source.slice(0, node.valueSpan.start);
        const after = source.slice(node.valueSpan.end);
        assert.strictEqual(outcome.value.slice(0, node.valueSpan.start), before);
        assert.strictEqual(outcome.value.slice(node.valueSpan.start + pieces.newValue.length), after);
      }),
      { seed: 20260921, numRuns: 200 },
    );
  });

  test('property: serialize with no edits is the identity function', () => {
    fc.assert(
      fc.property(documentPiecesArb, (pieces) => {
        const source = buildDocumentText(pieces);
        const parsed = parsePlanningDoc(source, ARTIFACT);
        assert.strictEqual(parsed.ok, true);
        const outcome = serialize(parsed.value);
        assert.strictEqual(outcome.ok, true);
        assert.strictEqual(outcome.value, source);
      }),
      { seed: 20260921, numRuns: 200 },
    );
  });
});

// ─── Row 24: registry parity — Generative-Fix-Divergence guard ─────────────────

describe('row 24: the artifact registry does not diverge from isCanonicalPlanningFile', () => {
  test('every PLANNING_ARTIFACTS entry is a real canonical planning file', () => {
    assert.ok(Array.isArray(PLANNING_ARTIFACTS));
    assert.ok(PLANNING_ARTIFACTS.length > 0);
    for (const name of PLANNING_ARTIFACTS) {
      assert.strictEqual(isCanonicalPlanningFile(name), true, `${name} should be canonical`);
    }
  });

  test('PLANNING_ARTIFACTS is exactly the markdown subset of CANONICAL_EXACT', () => {
    const expected = Array.from(CANONICAL_EXACT).filter((name) => name.endsWith('.md'));
    assert.deepStrictEqual(new Set(PLANNING_ARTIFACTS), new Set(expected));
  });

  test('a non-markdown canonical entry is excluded from PLANNING_ARTIFACTS', () => {
    assert.ok(CANONICAL_EXACT.has('config.json'));
    assert.strictEqual(PLANNING_ARTIFACTS.includes('config.json'), false);
  });
});

// ─── Row 25: one positive control per declared grammar ─────────────────────────

describe('row 25: every declared grammar has a positive control', () => {
  test('frontmatter, section, boldField, table, and checklist each parse to a node of that kind', () => {
    const source = [
      '---',
      'title: Fixture',
      '---',
      '',
      '## A Section',
      '',
      '**Field:** a value',
      '',
      '| Col A | Col B |',
      '|---|---|',
      '| x | y |',
      '',
      '- [ ] todo one',
      '- [x] todo two',
      '',
    ].join('\n');
    const doc = parseOk(source);
    const kinds = new Set(doc.nodes.map((n) => n.kind));
    for (const expectedKind of ['frontmatter', 'section', 'boldField', 'table', 'checklist']) {
      assert.ok(kinds.has(expectedKind), `expected a ${expectedKind} node; got kinds: ${[...kinds].join(', ')}`);
    }
  });
});

// ─── Row 26: unicode heading / label — byte-honest offsets ─────────────────────

describe('row 26: unicode labels and headings keep byte-honest offsets', () => {
  test('a unicode field label and value parse and round-trip correctly', () => {
    const source = ['---', 'title: Fixture', '---', '', '## Resume 日本語', '', '**日本語:** 値', ''].join(
      '\n',
    );
    const doc = parseOk(source);
    const id = findField(doc, '日本語');
    assert.ok(id);
    assert.strictEqual(readNode(doc, id).value, '値');

    const node = doc.nodes.find((n) => n.id === id);
    const staged = setFieldValue(doc, id, '新しい値');
    const outcome = serialize(staged.value);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.value.slice(0, node.valueSpan.start), source.slice(0, node.valueSpan.start));
    assert.strictEqual(
      outcome.value.slice(node.valueSpan.start + '新しい値'.length),
      source.slice(node.valueSpan.end),
    );
  });
});

// ─── Row 27: bounded-size — large document splices without offset corruption ───

describe('row 27: a large document splices without offset corruption', () => {
  test('a document with thousands of lines still splices exactly one span', () => {
    const lineCount = 4000;
    const lines = ['---', 'title: Large Fixture', '---', ''];
    for (let i = 0; i < lineCount; i++) {
      lines.push(`Prose line number ${i} filling out the document body.`);
    }
    lines.push('**Target:** the value to mutate');
    for (let i = 0; i < lineCount; i++) {
      lines.push(`More prose line number ${i} after the target field.`);
    }
    const source = lines.join('\n');

    const doc = parseOk(source);
    const id = findField(doc, 'Target');
    assert.ok(id);
    const node = doc.nodes.find((n) => n.id === id);

    const staged = setFieldValue(doc, id, 'MUTATED');
    const outcome = serialize(staged.value);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.value.slice(0, node.valueSpan.start), source.slice(0, node.valueSpan.start));
    assert.strictEqual(outcome.value.slice(node.valueSpan.start + 'MUTATED'.length), source.slice(node.valueSpan.end));
    assert.strictEqual(outcome.value.length, source.length - (node.valueSpan.end - node.valueSpan.start) + 'MUTATED'.length);
  });
});
