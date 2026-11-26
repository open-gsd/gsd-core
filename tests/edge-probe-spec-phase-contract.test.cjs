// The Step 5.5 prose assertions of this file are the edge-probe-spec-phase-contract text contract
// (scripts/static-checks/text-contracts/edge-probe-spec-phase-contract.cjs). What stays here executes the engine:
// translating a non-English requirement is what makes the English cue matcher apply (#2773).

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('fast-check');

const { classifyShape, applicableCategories } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'edge-probe.cjs'),
);

test('#2773: translating a non-English requirement is what makes the cue matcher apply', () => {
  // Same requirement, two languages. This is the premise the Step 5.5 instruction rests on;
  // if a future SHAPE_CUES edit breaks it, the documented advice becomes false and this fails.
  const pt = 'O sistema mescla intervalos sobrepostos em uma lista ordenada';
  const en = 'The system merges overlapping intervals in a sorted list';

  assert.deepEqual(classifyShape(pt), [], 'non-English prose matches no English cue — the silent no-op #2773 reports');
  assert.deepEqual(applicableCategories(classifyShape(pt)), [], 'zero shapes raise zero categories');

  const enShapes = classifyShape(en);
  assert.ok(enShapes.includes('collection'), 'the English rendering must classify as a collection');
  const enCategories = applicableCategories(enShapes);
  for (const expected of ['adjacency', 'empty', 'ordering']) {
    assert.ok(enCategories.includes(expected), `translated requirement must raise \`${expected}\``);
  }

  // A second shape, so the row is not a single-cue coincidence.
  const ptText = 'O nome do usuario e truncado em 50 caracteres';
  const enText = 'The user name is truncated at 50 characters';
  assert.deepEqual(classifyShape(ptText), [], 'non-English text-shape prose also matches nothing');
  assert.ok(classifyShape(enText).includes('text'), 'the English rendering must classify as text');

  // Multi-cue: a sentence carrying cues for two shapes yields the UNION, not one of them.
  const multi = 'The API request uploads a sorted list of items';
  const multiShapes = classifyShape(multi);
  assert.ok(multiShapes.includes('io'), 'multi-cue prose must include io');
  assert.ok(multiShapes.includes('collection'), 'multi-cue prose must include collection');
});

test('#2773: translation alone does not rescue genuinely zero-cue prose', () => {
  // The issue's own repro sentence classifies to [] in ENGLISH too — it carries no shape cue
  // in any language. That is the recorded recall gap (ADR-857 §98 / ADR-550 D7b), not a
  // language failure, which is why Step 5.5 must point at the `shapes` override rather than
  // promise that translation restores classification.
  const enZeroCue = 'The command exits with code 1 and prints to stderr on invalid input';
  assert.deepEqual(
    classifyShape(enZeroCue),
    [],
    'a genuinely zero-cue requirement stays unclassified even in English — the doc must not over-promise',
  );

  // The authored `shapes` override is the deterministic escape hatch for exactly this case.
  assert.deepEqual(
    applicableCategories(['stateful']),
    ['idempotency', 'concurrency'],
    'an authored `shapes` override raises categories with no dependence on prose cues',
  );
});

test('#2773 property: a cue word classifies regardless of surrounding text', () => {
  // A translated sentence carries its cue word amid arbitrary other words. The Step 5.5
  // advice is only sound if classification is robust to that surrounding context rather than
  // anchored to a fixed sentence shape.
  const cueForShape = {
    'numeric-range': 'threshold',
    collection: 'items',
    text: 'unicode',
    stateful: 'persist',
    io: 'endpoints',
  };
  const filler = fc.string({ minLength: 0, maxLength: 24 }).filter((s) => !/[A-Za-z]/.test(s));

  fc.assert(
    fc.property(
      fc.constantFrom(...Object.keys(cueForShape)),
      filler,
      filler,
      (shape, before, after) => {
        const sentence = `${before} ${cueForShape[shape]} ${after}`;
        assert.ok(
          classifyShape(sentence).includes(shape),
          `cue "${cueForShape[shape]}" must classify as ${shape} inside ${JSON.stringify(sentence)}`,
        );
      },
    ),
    { numRuns: 100, seed: 2773 },
  );
});
