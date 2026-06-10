'use strict';

/**
 * Policy test: docs-required.yml and changeset-required.yml must use
 * fetch-depth: 50 (NOT fetch-depth: 0) in their checkout steps.
 *
 * Rationale: both workflows run a lint script that performs a three-dot git diff
 * (`git diff --name-only origin/${base}...HEAD`). A full-history clone
 * (fetch-depth: 0) is wasteful — depth 50 covers >99% of PRs and is far faster.
 * The explicit base-ref fetch step ensures the merge-base is present for the
 * three-dot diff. The workflow FAILS CLOSED (lint errors) if the merge-base is
 * deeper than 50, which is intentional.
 *
 * Note: security-scan.yml legitimately uses fetch-depth: 0 and is NOT covered
 * by this test (see tests/security-scan.security.test.cjs).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..');

const WORKFLOWS = {
  'docs-required.yml': path.join(PROJECT_ROOT, '.github', 'workflows', 'docs-required.yml'),
  'changeset-required.yml': path.join(
    PROJECT_ROOT,
    '.github',
    'workflows',
    'changeset-required.yml',
  ),
};

for (const [name, workflowPath] of Object.entries(WORKFLOWS)) {
  describe(`${name} shallow-checkout policy`, () => {
    let content;

    test('workflow file exists', () => {
      assert.ok(fs.existsSync(workflowPath), `Missing workflow: ${workflowPath}`);
      content = fs.readFileSync(workflowPath, 'utf-8');
    });

    test('checkout uses fetch-depth: 50 (not 0)', () => {
      if (!content) content = fs.readFileSync(workflowPath, 'utf-8');
      assert.ok(
        content.includes('fetch-depth: 50'),
        `${name}: checkout must use fetch-depth: 50 (got full-history clone with fetch-depth: 0 or missing)`,
      );
      assert.ok(
        !content.includes('fetch-depth: 0'),
        `${name}: fetch-depth: 0 (full-history clone) must be replaced with fetch-depth: 50`,
      );
    });

    test('has explicit base-ref fetch step for three-dot diff merge-base', () => {
      if (!content) content = fs.readFileSync(workflowPath, 'utf-8');
      assert.ok(
        content.includes('Fetch base ref for diff'),
        `${name}: must have an explicit "Fetch base ref for diff" step so the three-dot diff has its merge-base`,
      );
    });
  });
}
