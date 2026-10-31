'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, toPosixPath } = require('./helpers.cjs');
const { have, skipUnless } = require('./helpers/bash-probe.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { collectSection, scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const AGENT_PATH = path.join(__dirname, '..', 'agents', 'gsd-plan-checker.md');

function artifactBlock() {
  const agent = fs.readFileSync(AGENT_PATH, 'utf8');
  const step = collectSection(agent, (heading) => heading.text === 'Step 1: Load Context');
  assert.ok(step, 'plan-checker Step 1 must exist');
  const lines = step.body.replace(/\r\n/g, '\n').split('\n');
  const blocks = scanFencedBlocks(lines)
    .filter((block) => block.infoString === 'bash' && block.closeLineIdx !== -1)
    .map((block) => lines.slice(block.openLineIdx + 1, block.closeLineIdx).join('\n'))
    .filter((block) => /\bfor artifact in\b/.test(block));
  assert.equal(blocks.length, 1, 'Step 1 must contain one artifact-loop bash block');
  return blocks[0];
}

function runArtifactBlock(t, shell, files) {
  const dir = createTempProject('plan-checker-artifacts-5178-');
  t.after(() => cleanup(dir));
  const phaseDir = path.join(dir, '.planning', 'phases', '01-fixture phase');
  fs.mkdirSync(phaseDir, { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(phaseDir, file), '');

  // Only query execution is stubbed; query contracts are covered by agent-query-contract.test.cjs.
  const script = ['gsd_run() { :; }', 'phase_number=01', 'phase_dir="$1"', artifactBlock()].join('\n');
  const result = runHook('-c', [script, 'artifact-loop', toPosixPath(phaseDir)], {
    interpreter: shell,
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, ZDOTDIR: dir },
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  assert.equal(result.outcome, OUTCOME.EXITED, JSON.stringify(result));
  assert.equal(result.exitCode, 0, result.stderr);
  return { phaseDir, paths: result.stdout.split(/\r?\n/).filter(Boolean).sort() };
}

describe('plan-checker discovers research and summary artifacts (#5178)', {
  skip: skipUnless('bash'),
}, () => {
  // Run bash and zsh deliberately because sh would not expand the braces.
  for (const shell of ['bash', 'zsh']) {
    const skip = shell === 'zsh' && !have('zsh') ? 'zsh is not installed' : false;

    test(`${shell}: finds exactly bare and prefixed research and summary paths (#5178)`, { skip }, (t) => {
      const result = runArtifactBlock(t, shell, [
        'RESEARCH.md', '01-RESEARCH.md', 'SUMMARY.md', '01-01-SUMMARY.md',
        '01-CONTEXT.md', '01-01-PLAN.md',
      ]);
      assert.deepEqual(result.paths, [
        'RESEARCH.md', '01-RESEARCH.md', 'SUMMARY.md', '01-01-SUMMARY.md',
      ].map((file) => toPosixPath(path.join(result.phaseDir, file))).sort());
    });

    test(`${shell}: unmatched globs exit zero and print only bare research (#5178)`, { skip }, (t) => {
      const result = runArtifactBlock(t, shell, ['RESEARCH.md']);
      assert.deepEqual(result.paths, [toPosixPath(path.join(result.phaseDir, 'RESEARCH.md'))]);
    });
  }
});
