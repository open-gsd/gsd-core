'use strict';

/**
 * #5922: release.yml's finalize job must publish the CHANGELOG section as the
 * GitHub Release body, not `--generate-notes` (empty for a hotfix of
 * cherry-picks). The step's own `run` script is executed against a fake `gh`
 * and a fixture CHANGELOG; the assertions are on what `gh` was handed.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const CREATE_STEP = 'Create GitHub Release';
const BUILD_STEP = 'Build GitHub Release notes';
const NOTES_PATH = '${RUNNER_TEMP}/release-notes.md';

function loadSteps(jobName) {
  const wf = yaml.load(fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8'));
  return (wf.jobs[jobName] && wf.jobs[jobName].steps) || [];
}

function loadStep(jobName, stepName) {
  return loadSteps(jobName).find((s) => s.name === stepName);
}

const indexOfStep = (steps, name) => steps.findIndex((s) => s.name === name);

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [1.20.1] - 2026-11-05',
  '',
  '### Fixed',
  '',
  '- **A hotfix fix** — cherry-picked with a new sha. (#5757) (#5908)',
  '',
  '## [1.20.0] - 2026-11-03',
  '',
  '### Added',
  '',
  '- **A feature** — shipped. (#1) (#2)',
  '',
].join('\n');

describe('release.yml finalize "Create GitHub Release" (#5922)', () => {
  const finalizeStep = loadStep('finalize', CREATE_STEP);
  const buildStep = loadStep('finalize', BUILD_STEP);

  test('the step exists and is no longer fed by --generate-notes', () => {
    assert.ok(finalizeStep, 'finalize must have a "Create GitHub Release" step');
    assert.equal(typeof finalizeStep.run, 'string');
    assert.equal(finalizeStep.run.includes('--generate-notes'), false);
    assert.equal(finalizeStep.run.includes('format-github-release-notes'), false);
  });

  test('the notes are built before the irreversible tag/publish steps, unconditionally, and consumed from the same path', () => {
    const steps = loadSteps('finalize');
    const build = indexOfStep(steps, BUILD_STEP);
    assert.ok(build > -1, 'finalize must have a "Build GitHub Release notes" step');
    assert.ok(build < indexOfStep(steps, 'Tag and push'), 'built before Tag and push');
    assert.ok(build < indexOfStep(steps, 'Publish to npm (latest)'), 'built before npm publish');
    assert.ok(build > indexOfStep(steps, 'Verify CHANGELOG promoted'), 'built from the promoted CHANGELOG');
    assert.equal(buildStep.if, undefined, 'no dry_run guard: a dry run validates the builder too');
    assert.ok(buildStep.run.includes(NOTES_PATH));
    assert.ok(finalizeStep.run.includes(`--notes-file "${NOTES_PATH}"`));
    assert.equal(finalizeStep.run.includes('changelog-release-notes'), false, 'create step only publishes');
  });

  // release.yml:72 rejects an rc for hotfix versions ("Hotfix (patch) releases
  // skip the rc action"), so rc only runs for X.Y.0 cut from next, whose
  // commits are the original PR merge commits: GitHub's generated list is
  // correct there and the pre-release keeps it.
  test('the rc job (X.Y.0 only, hotfix rcs are rejected) keeps GitHub-generated notes', () => {
    const rcStep = loadStep('rc', 'Create GitHub pre-release');
    assert.ok(rcStep, 'rc job has a "Create GitHub pre-release" step');
    assert.ok(rcStep.run.includes('--generate-notes'));
  });

  test('executing the step publishes a non-empty What\'s Changed from the promoted CHANGELOG', {
    skip: process.platform === 'win32' ? 'bash step body' : false,
  }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5922-wf-'));
    try {
      const work = path.join(dir, 'work');
      const bin = path.join(dir, 'bin');
      const tmp = path.join(dir, 'runner-temp');
      for (const d of [work, bin, tmp]) fs.mkdirSync(d);
      fs.symlinkSync(path.join(REPO_ROOT, 'scripts'), path.join(work, 'scripts'));
      fs.writeFileSync(path.join(work, 'CHANGELOG.md'), CHANGELOG);

      const record = path.join(dir, 'gh-call.json');
      const fakeGh = path.join(bin, 'gh');
      fs.writeFileSync(
        fakeGh,
        [
          '#!/usr/bin/env node',
          "const fs = require('fs');",
          'const args = process.argv.slice(2);',
          "const i = args.indexOf('--notes-file');",
          "const notes = i === -1 ? null : fs.readFileSync(args[i + 1], 'utf8');",
          `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, notes }));`,
        ].join('\n'),
        { mode: 0o755 },
      );

      const res = spawnSync('bash', ['-e', '-c', `${buildStep.run}\n${finalizeStep.run}`], {
        cwd: work,
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, VERSION: '1.20.1', RUNNER_TEMP: tmp },
      });
      assert.equal(res.status, 0, res.stderr);

      const call = JSON.parse(fs.readFileSync(record, 'utf8'));
      assert.deepEqual(call.args.slice(0, 2), ['release', 'create']);
      assert.equal(call.args[2], 'v1.20.1');
      assert.equal(call.args.includes('--generate-notes'), false);
      assert.ok(call.args.includes('--latest'));
      assert.equal(typeof call.notes, 'string');
      assert.ok(call.notes.includes("## What's Changed\n\n### Fixed\n\n- **A hotfix fix**"), 'Fixed bullets are in the body');
      assert.equal(call.notes.includes('A feature'), false, 'only the requested version');
      assert.ok(call.notes.includes('compare/v1.20.0...v1.20.1'));
    } finally {
      cleanup(dir);
    }
  });

  test('a version with no CHANGELOG section fails the build step and writes no notes file', {
    skip: process.platform === 'win32' ? 'bash step body' : false,
  }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5922-wf-'));
    try {
      const work = path.join(dir, 'work');
      const bin = path.join(dir, 'bin');
      const tmp = path.join(dir, 'runner-temp');
      for (const d of [work, bin, tmp]) fs.mkdirSync(d);
      fs.symlinkSync(path.join(REPO_ROOT, 'scripts'), path.join(work, 'scripts'));
      fs.writeFileSync(path.join(work, 'CHANGELOG.md'), CHANGELOG);
      const called = path.join(dir, 'gh-called');
      fs.writeFileSync(
        path.join(bin, 'gh'),
        `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(called)}, 'x');\n`,
        { mode: 0o755 },
      );
      const res = spawnSync('bash', ['-e', '-c', buildStep.run], {
        cwd: work,
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, VERSION: '9.9.9', RUNNER_TEMP: tmp },
      });
      assert.notEqual(res.status, 0);
      assert.equal(fs.existsSync(called), false);
      assert.equal(fs.existsSync(path.join(tmp, 'release-notes.md')), false, 'no empty body file');
    } finally {
      cleanup(dir);
    }
  });
});
