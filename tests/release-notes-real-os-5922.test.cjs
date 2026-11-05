'use strict';

/**
 * #5922: tests that need a real OS rather than the Linux-only lane: the
 * release.yml step bodies run under a real bash against a fake `gh`, and the
 * `--output` symlink guards (symlink semantics differ per OS). The remaining
 * release-notes tests are platform-free and live in
 * changelog-release-notes.test.cjs and release-finalize-notes-5922.test.cjs.
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

const {
  ChangelogNotesError,
  CHANGELOG_NOTES_ERROR,
  resolveOutputPath,
  writeOutput,
} = require('../scripts/release-notes/changelog-release-notes.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'release-notes', 'changelog-release-notes.cjs');
const CREATE_STEP = 'Create GitHub Release';
const BUILD_STEP = 'Build GitHub Release notes';

function loadStep(jobName, stepName) {
  const wf = yaml.load(fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8'));
  return ((wf.jobs[jobName] && wf.jobs[jobName].steps) || []).find((s) => s.name === stepName);
}

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

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ChangelogNotesError, `expected ChangelogNotesError, got ${err && err.stack}`);
    return err.code;
  }
  assert.fail('expected the function to throw');
  return null;
}

describe('release.yml finalize step bodies under a real bash (#5922)', () => {
  const finalizeStep = loadStep('finalize', CREATE_STEP);
  const buildStep = loadStep('finalize', BUILD_STEP);

  // The build step reads the repo-relative CHANGELOG.md; point it at the fixture
  // and run from the repo root (the step's `scripts/...` path is relative).
  function stepBody(step, workDir) {
    const body = step.run.replace('--changelog CHANGELOG.md', `--changelog "${path.join(workDir, 'CHANGELOG.md')}"`);
    assert.notEqual(body, step.run, 'the step passes --changelog CHANGELOG.md');
    return body;
  }

  test('executing the step publishes a non-empty What\'s Changed from the promoted CHANGELOG', {
    skip: process.platform === 'win32' ? 'bash step body' : false,
  }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5922-wf-'));
    try {
      const work = path.join(dir, 'work');
      const bin = path.join(dir, 'bin');
      const tmp = path.join(dir, 'runner-temp');
      for (const d of [work, bin, tmp]) fs.mkdirSync(d);
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

      const res = spawnSync('bash', ['-e', '-c', `${stepBody(buildStep, work)}\n${finalizeStep.run}`], {
        cwd: REPO_ROOT,
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
      fs.writeFileSync(path.join(work, 'CHANGELOG.md'), CHANGELOG);
      const called = path.join(dir, 'gh-called');
      fs.writeFileSync(
        path.join(bin, 'gh'),
        `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(called)}, 'x');\n`,
        { mode: 0o755 },
      );
      const res = spawnSync('bash', ['-e', '-c', stepBody(buildStep, work)], {
        cwd: REPO_ROOT,
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

describe('changelog-release-notes --output symlink guards (#5922)', () => {
  function tmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-5922-out-'));
  }

  test('an existing symlink as the final component is refused, and the CLI does not write through it', () => {
    const root = tmp();
    const outside = path.join(root, 'outside.md');
    const cwd = path.join(root, 'work');
    fs.mkdirSync(cwd);
    fs.writeFileSync(outside, 'untouched');
    try {
      fs.symlinkSync(outside, path.join(cwd, 'notes.md'));
    } catch (_e) {
      cleanup(root);
      return; // symlink creation unsupported here
    }
    try {
      assert.equal(
        codeOf(() => resolveOutputPath('notes.md', { cwd, tmpdir: '/nonexistent-5922', runnerTemp: null })),
        CHANGELOG_NOTES_ERROR.OUTPUT_NOT_ALLOWED,
      );
      const changelog = path.join(root, 'CHANGELOG.md');
      fs.writeFileSync(changelog, CHANGELOG);
      const res = spawnSync(process.execPath, [SCRIPT, '--version', '1.20.1', '--changelog', changelog, '--output', 'notes.md'], {
        cwd,
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
      });
      assert.notEqual(res.status, 0);
      assert.ok(res.stderr.includes('error[output-not-allowed]'), res.stderr);
      assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
    } finally {
      cleanup(root);
    }
  });

  test('writeOutput refuses a final-component symlink (ELOOP) and leaves its target unchanged', {
    skip: fs.constants.O_NOFOLLOW === undefined ? 'O_NOFOLLOW unavailable' : false,
  }, () => {
    const root = tmp();
    const outside = path.join(root, 'outside.md');
    const link = path.join(root, 'link.md');
    fs.writeFileSync(outside, 'untouched');
    try {
      try {
        fs.symlinkSync(outside, link);
      } catch (_e) {
        return; // symlink creation unsupported here
      }
      assert.equal(codeOf(() => writeOutput(link, 'body')), CHANGELOG_NOTES_ERROR.OUTPUT_NOT_ALLOWED);
      assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
      const plain = path.join(root, 'plain.md');
      writeOutput(plain, 'body');
      assert.equal(fs.readFileSync(plain, 'utf8'), 'body');
    } finally {
      cleanup(root);
    }
  });

  test('a symlinked parent that escapes the allowed root is rejected', () => {
    const root = tmp();
    const outside = path.join(root, 'outside');
    const cwd = path.join(root, 'work');
    fs.mkdirSync(outside);
    fs.mkdirSync(cwd);
    fs.symlinkSync(outside, path.join(cwd, 'link'));
    try {
      assert.equal(
        codeOf(() => resolveOutputPath(path.join('link', 'n.md'), { cwd, tmpdir: '/nonexistent-5922', runnerTemp: null })),
        CHANGELOG_NOTES_ERROR.OUTPUT_NOT_ALLOWED,
      );
    } finally {
      cleanup(root);
    }
  });
});
