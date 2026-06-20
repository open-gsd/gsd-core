// allow-test-rule: source-text-is-the-product see #1464
// Tutorial docs are the product surface users follow. Reading JSON code blocks
// from them and validating through validateCapability is behavioral, not
// source-grep — it proves the manifests work, not just that they "mention" a term.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateCapability } = require('../scripts/gen-capability-registry.cjs');

const ROOT = path.join(__dirname, '..');

// ─── Extractor ───────────────────────────────────────────────────────────────

// Required top-level fields that distinguish a complete capability manifest
// from a partial output snippet (list-entry, install-result, etc.).
// Partial output snippets have id+role but lack steps/contributions/gates/config.
const MANIFEST_REQUIRED_KEYS = new Set([
  'id', 'role', 'title', 'description', 'tier',
  'requires', 'runtimeCompat', 'skills', 'agents',
  'config', 'steps', 'contributions', 'gates',
]);

/**
 * Extract JSON code blocks from markdown that are complete capability manifests.
 * A complete manifest has ALL keys in MANIFEST_REQUIRED_KEYS.
 * Partial output snippets (list-entries, install-results) have only id+role and are skipped.
 */
function extractManifests(mdContent) {
  const manifests = [];
  const fenceRe = /```json\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = fenceRe.exec(mdContent)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = new Set(Object.keys(parsed));
      if ([...MANIFEST_REQUIRED_KEYS].every((k) => keys.has(k))) {
        manifests.push(parsed);
      }
    }
  }
  return manifests;
}

// ─── Suite 1: tutorial manifests validate ────────────────────────────────────

describe('docs tutorial manifests pass validateCapability (#1464 regression)', () => {
  test('build-your-first-capability.md: every manifest passes', () => {
    const content = fs.readFileSync(
      path.join(ROOT, 'docs', 'tutorials', 'build-your-first-capability.md'),
      'utf8',
    );
    const manifests = extractManifests(content);
    assert.ok(
      manifests.length > 0,
      'expected at least one capability manifest in build tutorial',
    );
    for (const cap of manifests) {
      const errors = validateCapability(cap, cap.id);
      assert.deepStrictEqual(
        errors,
        [],
        `build tutorial manifest id="${cap.id}" failed validateCapability:\n  ${errors.join('\n  ')}`,
      );
    }
  });

  test('install-your-first-capability.md: every manifest passes', () => {
    const content = fs.readFileSync(
      path.join(ROOT, 'docs', 'tutorials', 'install-your-first-capability.md'),
      'utf8',
    );
    const manifests = extractManifests(content);
    assert.ok(
      manifests.length > 0,
      'expected at least one capability manifest in install tutorial',
    );
    for (const cap of manifests) {
      const errors = validateCapability(cap, cap.id);
      assert.deepStrictEqual(
        errors,
        [],
        `install tutorial manifest id="${cap.id}" failed validateCapability:\n  ${errors.join('\n  ')}`,
      );
    }
  });

  test('capability-manifest.md reference example passes', () => {
    const content = fs.readFileSync(
      path.join(ROOT, 'docs', 'reference', 'capability-manifest.md'),
      'utf8',
    );
    const manifests = extractManifests(content);
    assert.ok(
      manifests.length > 0,
      'expected at least one capability manifest in reference doc',
    );
    for (const cap of manifests) {
      const errors = validateCapability(cap, cap.id);
      assert.deepStrictEqual(
        errors,
        [],
        `reference manifest id="${cap.id}" failed validateCapability:\n  ${errors.join('\n  ')}`,
      );
    }
  });
});

// ─── Suite 2: adversarial — #1464 failure modes caught ───────────────────────
//
// These are the EXACT failure shapes from issue #1464.
// They must fail validateCapability — proving this test would have caught the bug.

describe('validateCapability catches original #1464 bug shapes', () => {
  // #1464 high-1: step missing ref → validateStep rejects it
  test('step without ref fails (the original broken tutorial step)', () => {
    const cap = {
      id: 'hello-note',
      role: 'feature',
      version: '0.1.0',
      title: 'Hello Note',
      description: 'Test fixture for #1464 regression.',
      tier: 'standard',
      requires: [],
      engines: { gsd: '>=1.6.0' },
      runtimeCompat: { supported: ['*'], unsupported: [] },
      skills: [],
      agents: [],
      config: {},
      steps: [
        {
          // Missing ref — this was the #1464 high-1 bug in the original tutorial
          point: 'plan:pre',
          produces: ['HELLO.md'],
          consumes: [],
          onError: 'skip',
        },
      ],
      contributions: [],
      gates: [],
    };
    const errors = validateCapability(cap, 'hello-note');
    assert.ok(errors.length > 0, 'expected validation errors for step without ref');
    assert.ok(
      errors.some((e) => /ref/.test(e)),
      `expected an error mentioning "ref"; got: ${errors.join('; ')}`,
    );
  });

  // #1464 shape: id must match folder name (folderId contract)
  test('id not matching folderId fails', () => {
    const cap = {
      id: 'hello-note',
      role: 'feature',
      version: '0.1.0',
      title: 'Hello Note',
      description: 'Test fixture for id/folderId mismatch.',
      tier: 'standard',
      requires: [],
      runtimeCompat: { supported: ['*'], unsupported: [] },
      skills: [],
      agents: [],
      config: {},
      steps: [],
      contributions: [],
      gates: [],
    };
    const errors = validateCapability(cap, 'wrong-folder');
    assert.ok(errors.length > 0, 'expected id/folderId mismatch to fail validation');
    assert.ok(
      errors.some((e) => /folder/.test(e) || /equal/.test(e) || /id/.test(e)),
      `expected error about id/folderId mismatch; got: ${errors.join('; ')}`,
    );
  });

  // Corrected shape: contribution with fragment + into (the PR #1495 fix)
  test('contribution with fragment.path + into passes (the PR #1495 fix shape)', () => {
    const cap = {
      id: 'hello-note',
      role: 'feature',
      version: '0.1.0',
      title: 'Hello Note',
      description: 'Injects a greeting note at plan:pre and produces HELLO.md.',
      tier: 'standard',
      requires: [],
      runtimeCompat: { supported: ['*'], unsupported: [] },
      skills: [],
      agents: [],
      config: {},
      steps: [],
      contributions: [
        {
          point: 'plan:pre',
          into: 'planner',
          fragment: { path: 'fragments/plan-pre.md' },
          produces: ['HELLO.md'],
          consumes: [],
          onError: 'skip',
        },
      ],
      gates: [],
    };
    const errors = validateCapability(cap, 'hello-note');
    assert.deepStrictEqual(
      errors,
      [],
      `corrected contribution manifest has unexpected errors: ${errors.join('; ')}`,
    );
  });
});

// ─── Suite 3: extractManifests helper ────────────────────────────────────────

describe('extractManifests helper unit tests', () => {
  test('returns empty array for plain text with no JSON fences', () => {
    assert.deepStrictEqual(extractManifests('No code blocks here.'), []);
  });

  test('skips JSON blocks without all required manifest keys', () => {
    // Partial list-entry block — only has id, role, version but not steps/contributions/etc.
    const md = '```json\n{"id":"x","role":"feature","version":"1.0.0"}\n```';
    assert.deepStrictEqual(extractManifests(md), []);
  });

  function makeCompleteManifest(overrides) {
    return {
      id: 'test-cap', role: 'feature', title: 'T', description: 'D',
      tier: 'standard', requires: [], runtimeCompat: { supported: ['*'], unsupported: [] },
      skills: [], agents: [], config: {}, steps: [], contributions: [], gates: [],
      ...overrides,
    };
  }

  test('extracts a complete manifest (all required keys present)', () => {
    const cap = makeCompleteManifest({ id: 'x' });
    const md = '```json\n' + JSON.stringify(cap, null, 2) + '\n```';
    const result = extractManifests(md);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 'x');
  });

  test('skips malformed JSON blocks silently', () => {
    const complete = makeCompleteManifest({ id: 'y' });
    const md = '```json\n{bad json here\n```\n```json\n' + JSON.stringify(complete) + '\n```';
    const result = extractManifests(md);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 'y');
  });

  test('extracts multiple complete manifests from one doc', () => {
    const a = makeCompleteManifest({ id: 'cap-a' });
    const b = makeCompleteManifest({ id: 'cap-b' });
    const md = [
      '```json\n' + JSON.stringify(a) + '\n```',
      '```json\n' + JSON.stringify(b) + '\n```',
    ].join('\n');
    const result = extractManifests(md);
    assert.strictEqual(result.length, 2);
  });
});
