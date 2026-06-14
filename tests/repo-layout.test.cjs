'use strict';

/**
 * Governance tests for the gsd-core repository root layout.
 *
 * Invariant: the repository root must not contain ad-hoc AI instruction files
 * (such as AGENTS.md) that would become an untracked source of truth running
 * in parallel with the canonical CONTEXT.md and docs/adr/ records.
 *
 * Context: bin/install.js (local Copilot install path, issue #786) writes an
 * AGENTS.md to process.cwd() when `gsd install copilot` is run inside a repo
 * checkout. If that file is ever committed, editors and AI tools that auto-load
 * repo-root instruction files will silently pick up GSD's installer-generated
 * stub rather than the authoritative documentation. This test ensures that
 * artefact never lands in source control.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

test('repo-layout: root AGENTS.md is absent — no ad-hoc AI instruction file committed alongside CONTEXT.md', () => {
  const agentsMdPath = path.join(ROOT, 'AGENTS.md');
  assert.equal(
    fs.existsSync(agentsMdPath),
    false,
    [
      'root AGENTS.md must not be committed.',
      'This file is written by `gsd install copilot` (bin/install.js, local Copilot path, issue #786)',
      'when the installer runs inside a repo checkout.',
      'The repository source of truth for architecture and contributor guidance is',
      'CONTEXT.md and docs/adr/ — not an installer-generated instruction stub.',
      'Run `gsd uninstall copilot` to remove the artefact, then verify it is gitignored',
      'before re-running the install in this checkout.',
    ].join(' '),
  );
});

test('repo-layout: installer writes AGENTS.md only for local Copilot scope (not global), confirming the commit risk is scoped', () => {
  // Verify the installer source encodes the "!isGlobal" guard that restricts
  // AGENTS.md emission to local installs. If that guard were removed, the file
  // could be silently created in any directory the installer runs from,
  // including the repo root during development. This test is a static read of
  // the install source — it does not execute the installer.
  const installJs = fs.readFileSync(path.join(ROOT, 'bin', 'install.js'), 'utf8');

  // The install path must gate AGENTS.md emission behind a !isGlobal check.
  // We look for the pattern that appears immediately before the agentsMdPath
  // assignment that targets process.cwd() (the repo-root write site).
  assert.ok(
    /if\s*\(\s*!isGlobal\s*\)[\s\S]{0,200}agentsMdPath\s*=\s*path\.join\(\s*process\.cwd\(\)/.test(installJs),
    'bin/install.js must guard the repo-root AGENTS.md write site with `if (!isGlobal)`; ' +
    'removing that guard would allow a local Copilot install to silently create AGENTS.md ' +
    'in any working directory, including this repo checkout.',
  );
});
