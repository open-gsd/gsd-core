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
const {
  parsePlanningDoc, findField, readNode, setFieldValue, hasUnreadableNodes, serialize, PLANNING_ARTIFACTS,
  readFrontmatterField, readFrontmatterFieldFromSource,
} = mod;

const artifactsMod = require(ARTIFACTS_PATH);
const { isCanonicalPlanningFile, CANONICAL_EXACT } = artifactsMod;

const FRONTMATTER_PATH = '../gsd-core/bin/lib/frontmatter.cjs';
const { extractFrontmatter } = require(FRONTMATTER_PATH);

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

// Values are deliberately widened to include the grammar's own metacharacters
// (em-dash, hyphen, `*_|[]#:`, bare \n/\r, non-ASCII letters) — this is the
// exact input space where the setFieldValue representability defects lived
// (forged sibling via \n; silent truncation on the trailing " — " separator).
// Labels stay narrow: they are a different, narrower grammar.
//
// safeValueArb feeds an INITIAL field's own literal text on ONE physical
// line of the generated document (`**label:** value`) — it excludes bare
// \n/\r because embedding a line break there would corrupt the generator's
// own one-line-per-field assumption (the field would not parse as a
// boldField at all, which is a generator bug, not a module defect). newValue
// is only ever passed AS AN ARGUMENT to setFieldValue, never spliced
// directly into document text, so it carries the full alphabet including
// \n/\r — exactly what setFieldValue must correctly refuse.
const HOSTILE_LINE_SAFE_CHARS = 'A-Za-z0-9 .,!?—\\-*_`|\\[\\]#:\\u00C0-\\u024F\\u3040-\\u30FF\\u4E00-\\u9FFF';
const HOSTILE_VALUE_CHARS = `${HOSTILE_LINE_SAFE_CHARS}\\n\\r`;
const hostileLineSafeArb = (max) => fc.stringMatching(new RegExp(`^[${HOSTILE_LINE_SAFE_CHARS}]{0,${max}}$`));
const hostileValueArb = (max) => fc.stringMatching(new RegExp(`^[${HOSTILE_VALUE_CHARS}]{0,${max}}$`));

const safeValueArb = hostileLineSafeArb(20);

const fieldArb = fc.record({ label: safeLabelArb, value: safeValueArb });

const documentPiecesArb = fc.record({
  heading: fc
    .stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,15}$/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
  fields: fc.uniqueArray(fieldArb, { minLength: 1, maxLength: 5, selector: (r) => r.label.toLowerCase() }),
  mutateIndex: fc.nat(),
  newValue: hostileValueArb(25),
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
        if (!staged.ok) return; // a representability refusal is a valid outcome, not a failure
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

// ─── Row 31: representability — every ACCEPTED value round-trips identically ───

describe('row 31: every value setFieldValue accepts round-trips identically', () => {
  test('property: every value setFieldValue ACCEPTS round-trips identically', () => {
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

        const staged = setFieldValue(doc, id, pieces.newValue);
        if (!staged.ok) return; // refusing is a PASS — the whole point of the representability check

        const outcome = serialize(staged.value);
        assert.strictEqual(outcome.ok, true);

        const reparsed = parsePlanningDoc(outcome.value, ARTIFACT);
        assert.strictEqual(reparsed.ok, true);
        const reId = findField(reparsed.value, label);
        assert.ok(reId, `expected to re-find field ${JSON.stringify(label)} after round-trip`);
        const read = readNode(reparsed.value, reId);
        assert.strictEqual(read.ok, true);
        assert.strictEqual(read.value, pieces.newValue);
      }),
      { seed: 20260921, numRuns: 300 },
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

// ─── Row 29: negative — a line-break value must not become a forged sibling ───

describe('row 29: setFieldValue refuses a value carrying a line break', () => {
  const source = [
    '---',
    'title: Fixture',
    '---',
    '',
    '**Plans:** initial value',
    '**Owner:** alice',
    '',
  ].join('\n');

  test('a value containing \\n is refused', () => {
    const doc = parseOk(source);
    const id = findField(doc, 'Plans');
    const result = setFieldValue(doc, id, '1/1\n**Owner:** mallory');
    assert.strictEqual(result.ok, false);
  });

  test('a value containing a bare \\r is refused', () => {
    const doc = parseOk(source);
    const id = findField(doc, 'Plans');
    const result = setFieldValue(doc, id, '1/1\r**Owner:** mallory');
    assert.strictEqual(result.ok, false);
  });

  test('a value containing \\r\\n is refused', () => {
    const doc = parseOk(source);
    const id = findField(doc, 'Plans');
    const result = setFieldValue(doc, id, '1/1\r\n**Owner:** mallory');
    assert.strictEqual(result.ok, false);
  });

  test('the negative proof: a refused write leaves the original document untouched', () => {
    const doc = parseOk(source);
    const id = findField(doc, 'Plans');
    const result = setFieldValue(doc, id, '1/1\n**Owner:** mallory');
    assert.strictEqual(result.ok, false);

    const outcome = serialize(doc);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.value, source);
    assert.strictEqual(outcome.value.includes('mallory'), false);
    assert.strictEqual(readNode(doc, findField(doc, 'Owner')).value, 'alice');
  });

  test('legitimate values still stage successfully: plain, empty, **, and |', () => {
    const doc = parseOk(source);
    const id = findField(doc, 'Plans');

    for (const value of ['plain value', '', '**bold marker**', 'a | b']) {
      const result = setFieldValue(doc, id, value);
      assert.strictEqual(result.ok, true);
    }
  });

  test('a full round trip with a legitimate value leaves the sibling field intact exactly once', () => {
    const doc = parseOk(source);
    const id = findField(doc, 'Plans');
    const staged = setFieldValue(doc, id, '2/2');
    assert.strictEqual(staged.ok, true);
    const outcome = serialize(staged.value);
    assert.strictEqual(outcome.ok, true);

    const ownerMatches = outcome.value.match(/\*\*Owner:\*\*/g);
    assert.strictEqual(ownerMatches.length, 1);
    const ownerId = findField(staged.value, 'Owner');
    assert.strictEqual(readNode(staged.value, ownerId).value, 'alice');
  });
});

// ─── Row 30: negative — a value carrying the trailing separator ───────────────

describe('row 30: setFieldValue refuses a value containing the trailing separator', () => {
  const source = [
    '---',
    'title: Fixture',
    '---',
    '',
    '**Plans:** initial value',
    '**Owner:** alice',
    '',
  ].join('\n');

  test('a value containing the trailing " — " separator is refused', () => {
    const doc = parseOk(source);
    const id = findField(doc, 'Plans');
    const result = setFieldValue(doc, id, `sneaky ${EM_DASH} annotation`);
    assert.strictEqual(result.ok, false);
  });

  test('after refusal, the document serializes byte-identically to the source', () => {
    const doc = parseOk(source);
    const id = findField(doc, 'Plans');
    const result = setFieldValue(doc, id, `sneaky ${EM_DASH} annotation`);
    assert.strictEqual(result.ok, false);

    const outcome = serialize(doc);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.value, source);
  });
});

// ─── Row 32: setFieldValue has NO separator-widening escape hatch (#5007) ──────
//
// #4917's review finding 2 (the round-trip check row 30 above pins) is: a
// value containing the grammar's own ` — ` separator token gets silently
// TRUNCATED on serialize, because `parseBoldFieldLine` always splits `rest`
// at the FIRST ` — ` it finds — there is no substring/position rule that can
// tell "the caller's atomic value happens to contain ` — `" apart from "the
// caller meant value + a separate trailing annotation": both are the
// identical input shape to the reader. Narrowing the round-trip check's
// regex can never fix this safely — see setFieldValue's own comment.
//
// An earlier version of #5007 added a `{ allowSeparator: true }` option that
// spliced the caller's value across the FULL rest-of-line span instead of
// just `valueSpan`, reasoning that skipping the reparse-and-split made
// finding 2's failure mode "structurally impossible". A failing-first
// reproduction proved that reasoning wrong: the option only avoided the
// refusal AT WRITE TIME. The bytes it wrote were correct, but
// `parseBoldFieldLine` splits on ` — ` unconditionally on every READ, with
// no escaping/metadata in this grammar to tell the two cases apart — so the
// NEXT fresh `parsePlanningDoc` of that exact text (not the in-memory doc
// the option's own tests checked) silently re-truncated the value via
// `findField`/`readNode`, reporting a confident `ok: true` and no error.
// That is finding 2 itself, just moved one parse cycle downstream of where
// the check could catch it. The option was removed; this seam now has
// exactly ONE write path, and it round-trips safely by refusing outright,
// not by silently mis-splitting.
describe('row 32: setFieldValue has no way to accept a separator-containing value', () => {
  test('a value containing " — " is refused (finding 2 stays fixed) — setFieldValue has no options parameter', () => {
    const source = ['**Phase:** 1', '**Owner:** alice', ''].join('\n');
    const doc = parseOk(source);
    const id = findField(doc, 'Phase');

    const result = setFieldValue(doc, id, `1 ${EM_DASH} COMPLETE`);
    assert.strictEqual(result.ok, false, 'the round-trip check must still refuse — finding 2 pin');

    // Regression pin: a 3rd "options" argument (the removed allowSeparator
    // shape) must have NO effect — proves the escape hatch cannot silently
    // be reintroduced by a caller who copies the old call shape.
    const withIgnoredOptions = setFieldValue(doc, id, `1 ${EM_DASH} COMPLETE`, { allowSeparator: true });
    assert.strictEqual(withIgnoredOptions.ok, false, 'a stray options arg must not reopen the refusal');
  });

  // ROUND-TRIP CORRUPTION PROOF (why the removed option was unsafe, kept as
  // a permanent regression pin against reintroducing it under any name):
  // this grammar has no escaping convention, so ANY line whose rest-of-line
  // text contains " — " — however it got written — is split at the FIRST
  // occurrence on every parse. There is no way for a value legitimately
  // containing that token to round-trip through parsePlanningDoc/findField/
  // readNode; the only representable-by-construction contract this seam can
  // offer is refuse-at-write, which is what setFieldValue does.
  test('a line whose rest-of-line text contains " — " is ALWAYS split on (re)parse — the grammar has no escape', () => {
    // Simulates what a full-rest-of-line write (with no reparse/refusal)
    // would have produced on disk, bypassing setFieldValue entirely to
    // isolate the parser's own behaviour from any writer.
    const written = ['**Phase:** 1 — COMPLETE', '**Owner:** alice', ''].join('\n');

    const reparsed = parseOk(written);
    const id = findField(reparsed, 'Phase');
    const read = readNode(reparsed, id);

    assert.strictEqual(read.ok, true);
    assert.notStrictEqual(
      read.value,
      '1 — COMPLETE',
      'reparsing must NOT recover the full atomic value — proves no safe round-trip exists in this grammar',
    );
    assert.strictEqual(read.value, '1', 'the grammar unconditionally truncates at the first " — "');
  });
});

// ─── #5026: readFrontmatterField / readFrontmatterFieldFromSource ──────────────
//
// ADR-4910 §1 absorption seam: a frontmatter-key reader composing
// `frontmatter.cts`'s `extractFrontmatter` rather than reimplementing YAML
// parsing. Two entry points share one lookup-and-shape helper internally
// (`lookupFrontmatterField`, not exported — its behaviour is asserted only
// through these two public functions, which is the point: one owner, two
// doors) — `readFrontmatterField` locates the frontmatter span via an
// already-parsed `PlanningDoc`'s `FrontmatterNode`; `readFrontmatterFieldFromSource`
// locates it directly off raw source text, with no `PlanningDoc`/artifact-kind
// gate, for a caller (`plan-document.cts`) with content but no canonical
// `.planning/`-root filename to gate on.

describe('#5026: readFrontmatterField — key present/absent, no-frontmatter, malformed', () => {
  const source = ['---', 'wave: 3', 'depends_on: [01-first, 02-second]', '---', '', '**Alpha:** one', ''].join('\n');

  test('frontmatter present, key present: value matches extractFrontmatter on the same source', () => {
    const doc = parseOk(source);
    const read = readFrontmatterField(doc, 'wave');
    const direct = extractFrontmatter(source);
    assert.strictEqual(read.ok, true);
    assert.deepStrictEqual(read.value, direct['wave']);
    assert.strictEqual(read.value, '3');
  });

  test('frontmatter present, an array-valued key present: value matches extractFrontmatter verbatim', () => {
    const doc = parseOk(source);
    const read = readFrontmatterField(doc, 'depends_on');
    const direct = extractFrontmatter(source);
    assert.strictEqual(read.ok, true);
    assert.deepStrictEqual(read.value, direct['depends_on']);
    assert.deepStrictEqual(read.value, ['01-first', '02-second']);
  });

  test('frontmatter present, key absent: not-found, matching extractFrontmatter\'s own absent-key contract (undefined)', () => {
    const doc = parseOk(source);
    const read = readFrontmatterField(doc, 'nonexistent');
    const direct = extractFrontmatter(source);
    assert.strictEqual(direct['nonexistent'], undefined);
    assert.strictEqual(read.ok, false);
    assert.strictEqual(read.reason, 'field-not-found');
  });

  test('no frontmatter node at all: { ok: false, reason: \'no-frontmatter\' }', () => {
    const doc = parseOk('**Alpha:** one\n');
    assert.strictEqual(doc.nodes.some((n) => n.kind === 'frontmatter'), false);
    const read = readFrontmatterField(doc, 'wave');
    assert.deepStrictEqual(read, { ok: false, reason: 'no-frontmatter', span: { start: 0, end: 0 } });
  });

  test('malformed/unparseable frontmatter: matches extractFrontmatter\'s own FRONTMATTER_UNPARSEABLE contract', () => {
    const malformed = ['---', 'wave: [1, 2', 'depends_on: 01-first', '---', '', '**Alpha:** one', ''].join('\n');
    const doc = parseOk(malformed);
    // Cross-check against frontmatter.cjs's own marker directly, proving the
    // seam's 'unparseable-frontmatter' reason is a faithful translation of it.
    const direct = extractFrontmatter(malformed);
    const { FRONTMATTER_UNPARSEABLE } = require(FRONTMATTER_PATH);
    assert.strictEqual(Object.getOwnPropertySymbols(direct).includes(FRONTMATTER_UNPARSEABLE), true);

    const read = readFrontmatterField(doc, 'wave');
    assert.strictEqual(read.ok, false);
    assert.strictEqual(read.reason, 'unparseable-frontmatter');
  });

  test('an unterminated frontmatter fence is unreachable through this function: parsePlanningDoc fails the whole document first', () => {
    const unterminated = ['---', 'wave: 3', 'depends_on: x', 'this fence is never closed', ''].join('\n');
    const result = parsePlanningDoc(unterminated, ARTIFACT);
    assert.strictEqual(result.ok, false);
  });
});

describe('#5026: readFrontmatterFieldFromSource — same contract, no PlanningDoc/artifact gate', () => {
  const source = ['---', 'wave: 3', 'depends_on: [01-first, 02-second]', '---', '', 'body text', ''].join('\n');

  test('frontmatter present, key present: value matches extractFrontmatter on the same source', () => {
    const read = readFrontmatterFieldFromSource(source, 'wave');
    const direct = extractFrontmatter(source);
    assert.strictEqual(read.ok, true);
    assert.deepStrictEqual(read.value, direct['wave']);
  });

  test('frontmatter present, key absent: field-not-found', () => {
    const read = readFrontmatterFieldFromSource(source, 'nonexistent');
    assert.strictEqual(read.ok, false);
    assert.strictEqual(read.reason, 'field-not-found');
  });

  test('no frontmatter fence at all: { ok: false, reason: \'no-frontmatter\' }', () => {
    const read = readFrontmatterFieldFromSource('just prose, no fence', 'wave');
    assert.deepStrictEqual(read, { ok: false, reason: 'no-frontmatter', span: { start: 0, end: 0 } });
  });

  test('malformed/unparseable frontmatter: unparseable-frontmatter, same as readFrontmatterField', () => {
    const malformed = ['---', 'wave: [1, 2', '---', '', 'body', ''].join('\n');
    const read = readFrontmatterFieldFromSource(malformed, 'wave');
    assert.strictEqual(read.ok, false);
    assert.strictEqual(read.reason, 'unparseable-frontmatter');
  });

  test('an OPENED-but-never-closed fence IS reachable here (unlike readFrontmatterField) and reads as field-not-found', () => {
    const unterminated = ['---', 'wave: 3', 'depends_on: x', 'this fence is never closed', ''].join('\n');
    const direct = extractFrontmatter(unterminated);
    assert.strictEqual(direct['wave'], undefined, 'extractFrontmatter itself treats an unterminated fence as no frontmatter');
    const read = readFrontmatterFieldFromSource(unterminated, 'wave');
    assert.strictEqual(read.ok, false);
    assert.strictEqual(read.reason, 'field-not-found');
  });

  test('no PlanningDoc/artifact-kind gate: a filename `parsePlanningDoc` would refuse still reads correctly', () => {
    // '01-PLAN.md' is not a canonical .planning/-root artifact (isCanonicalPlanningFile
    // returns false for it), so parsePlanningDoc(source, '01-PLAN.md') would fail at the
    // document level — this function needs no artifact name at all.
    assert.strictEqual(isCanonicalPlanningFile('01-PLAN.md'), false);
    const gated = parsePlanningDoc(source, '01-PLAN.md');
    assert.strictEqual(gated.ok, false);

    const read = readFrontmatterFieldFromSource(source, 'wave');
    assert.strictEqual(read.ok, true);
    assert.strictEqual(read.value, '3');
  });
});
