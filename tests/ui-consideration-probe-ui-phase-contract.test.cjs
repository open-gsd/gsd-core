// ui-phase.md Step 9.5 is the deployed workflow runtime contract under assertion; its text IS
// what the runtime loads. These checks lock the #4657 text_en wiring so the Non-English
// guidance cannot silently rot the way it did for the edge adapter before #3717 — mirroring
// tests/edge-probe-spec-phase-contract.test.cjs onto the ui-phase probe step.
// Assertions scope to the extracted Step 9.5 block to avoid false positives from incidental
// mentions elsewhere in the file.

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const UI_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'ui-phase.md');
const { proposeConsiderations } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'ui-consideration-probe.cjs'),
);

function readUiPhase() {
  // allow-test-rule: source-text-is-the-product (#4657)
  // The workflow file's text IS the deployed runtime contract; assertions below match on it.
  return fs.readFileSync(UI_PHASE_PATH, 'utf8');
}

// Slice the Step 9.5 block: from the "## 9.5." heading to the next "## " heading. Scopes
// assertions to the probe step only.
function extractStep95Block(content) {
  const startIdx = content.indexOf('## 9.5.');
  if (startIdx === -1) return '';
  const rest = content.slice(startIdx + '## 9.5.'.length);
  const nextHeading = rest.search(/\n## /);
  if (nextHeading === -1) return content.slice(startIdx);
  return content.slice(startIdx, startIdx + '## 9.5.'.length + nextHeading);
}

describe('ui-consideration-probe ui-phase contract: text_en (#4657)', () => {
  test('Step 9.5 documents the Non-English text_en remedy (mirrors spec-phase Step 5.5, #3717)', () => {
    const block = extractStep95Block(readUiPhase());
    assert.ok(block.length > 0, 'Step 9.5 block must be extractable from ui-phase.md');
    assert.match(block, /Non-English/i, 'Step 9.5 must carry the Non-English projects guidance');
    assert.match(block, /text_en/, 'Step 9.5 must name text_en — the classifier-facing translation field');
    assert.match(block, /response_language/, 'Step 9.5 must tie the remedy to response_language projects');
    assert.match(block, /every element/i, 'Step 9.5 must instruct populating text_en for EVERY element, not only UI-obvious ones');
    assert.match(block, /engine input/i, 'text_en is engine input, never user-facing output (ADR-550)');
  });

  test('Step 9.5 ELEMENTS_JSON shape comment includes the optional text_en key', () => {
    const block = extractStep95Block(readUiPhase());
    assert.match(block, /"text_en"\?/, 'the element record shape must document text_en? alongside id/text/elements');
  });

  // Property (deterministic: pinned seed, bounded runs, counterexample printed on failure):
  // for English element prose built from the classifier's own cue vocabulary, a cue-free
  // Danish rendering as `text` plus the original English as `text_en` must classify
  // identically to the English original — and the Danish rendering alone must stay
  // unclassified. Document-shaped inputs: the English words ARE cue words UI_CUES matches;
  // the Danish translations are verified cue-free by the property itself on every run.
  test('property: text_en carries classification for any cue-matching prose under a cue-free Danish rendering', () => {
    const enToDa = [
      ['form', 'formular'],
      ['input', 'indtastning'],
      ['list', 'liste'],
      ['table', 'tabel'],
      ['tabs', 'faner'],
      ['pagination', 'sideinddeling'],
      ['image', 'billede'],
      ['gallery', 'galleri'],
      ['button', 'knap'],
      ['dropdown', 'rullemenu'],
      ['heading', 'overskrift'],
      ['title', 'titel'],
    ];
    const enWords = enToDa.map(([en]) => en);
    const daOf = (w) => enToDa.find(([en]) => en === w)[1];

    fc.assert(
      fc.property(
        fc.constantFrom(...enWords),
        fc.constantFrom(...enWords),
        fc.nat(2),
        (w1, w2, extra) => {
          const english = [w1, w2, ...Array(extra).fill(w2)].join(' ');
          const danish = [w1, w2, ...Array(extra).fill(w2)].map(daOf).join(' ');
          const cats = (el) => proposeConsiderations(el).map((c) => c.category);
          assert.deepEqual(
            cats({ id: 'P', text: danish }),
            ['unclassified'],
            `the Danish rendering must be cue-free (counterexample text: ${JSON.stringify(danish)})`,
          );
          assert.deepEqual(
            cats({ id: 'P', text: danish, text_en: english }),
            cats({ id: 'P', text: english }),
            `translated element must classify as its English original (counterexample text_en: ${JSON.stringify(english)})`,
          );
        },
      ),
      { seed: 4657, numRuns: 200 },
    );
  });
});
