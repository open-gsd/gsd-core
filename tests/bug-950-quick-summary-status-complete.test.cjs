/**
 * Regression tests for bug #950
 *
 * audit-open chronically flagged genuinely-complete quick tasks as [unknown]
 * because NO shipped summary template carried a `status:` frontmatter field —
 * so status was only emitted when the writing agent improvised it.
 *
 * The fix: add `status: complete` to all four summary templates and enforce it
 * in the executor agent + quick.md workflow. Tests here exercise the scanner
 * directly via auditOpenArtifacts() and also guard template text as a secondary
 * contract check.
 *
 * Primary guard:   behavioral audit-scanner tests (tasks read by scanQuickTasks)
 * Secondary guard: template-contract text checks (template text IS the runtime contract)
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const auditModule = require('../gsd-core/bin/lib/audit.cjs');
const { auditOpenArtifacts } = auditModule;
const { cleanup } = require('./helpers.cjs');

const TEMPLATES_DIR = path.resolve(__dirname, '..', 'gsd-core', 'templates');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bug-950-'));
}

describe('bug #950: quick-task SUMMARY must carry status: complete', () => {
  // Ensure GSD env vars do not redirect planningDir() away from our fixture.
  let prevProject, prevWorkstream;
  before(() => {
    prevProject = process.env.GSD_PROJECT;
    prevWorkstream = process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
    delete process.env.GSD_WORKSTREAM;
  });
  after(() => {
    if (prevProject !== undefined) process.env.GSD_PROJECT = prevProject;
    if (prevWorkstream !== undefined) process.env.GSD_WORKSTREAM = prevWorkstream;
  });

  // ── Behavioral: scanner recognizes complete quick tasks ───────────────────

  test('[PRIMARY] quick task SUMMARY with status: complete is NOT flagged open', () => {
    // Simulates an executor that correctly wrote the SUMMARY with status: complete
    // (as required after the fix). The scanner must report 0 open quick tasks.
    const cwd = mkTmp();
    try {
      const quickId = '260609-test-status-complete';
      const taskDir = path.join(cwd, '.planning', 'quick', quickId);
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, `${quickId}-SUMMARY.md`),
        [
          '---',
          'status: complete',
          'date: 2026-06-09',
          'slug: test-status-complete',
          '---',
          '',
          '# Quick Task Summary',
          '',
          'Task completed successfully.',
        ].join('\n'),
        'utf-8'
      );

      const result = auditOpenArtifacts(cwd);
      const realQuickTasks = result.items.quick_tasks.filter(
        i => !i.scan_error && !i._remainder_count
      );

      assert.equal(
        realQuickTasks.length,
        0,
        `quick task SUMMARY with status: complete must NOT appear as open; ` +
        `got: ${JSON.stringify(realQuickTasks)}`
      );
      assert.equal(result.counts.quick_tasks, 0);
    } finally {
      cleanup(cwd);
    }
  });

  test('[PRIMARY] quick task SUMMARY without status: field is still flagged [unknown]', () => {
    // Negative case: a SUMMARY that lacks status: still surfaces as [unknown].
    // This proves the scanner still catches real gaps — the fix must be on the writer side.
    const cwd = mkTmp();
    try {
      const quickId = '260609-test-no-status';
      const taskDir = path.join(cwd, '.planning', 'quick', quickId);
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, `${quickId}-SUMMARY.md`),
        [
          '---',
          'date: 2026-06-09',
          'slug: test-no-status',
          '---',
          '',
          '# Quick Task Summary',
          '',
          'Task done, but no status field.',
        ].join('\n'),
        'utf-8'
      );

      const result = auditOpenArtifacts(cwd);
      const realQuickTasks = result.items.quick_tasks.filter(
        i => !i.scan_error && !i._remainder_count
      );

      assert.equal(
        realQuickTasks.length,
        1,
        `quick task SUMMARY without status: must appear as open (unknown); ` +
        `got: ${JSON.stringify(realQuickTasks)}`
      );
      assert.equal(realQuickTasks[0].status, 'unknown', 'expected status to be unknown');
    } finally {
      cleanup(cwd);
    }
  });

  test('[PRIMARY] quick task without any SUMMARY is still flagged [missing]', () => {
    // Proves the missing-SUMMARY case still surfaces.
    const cwd = mkTmp();
    try {
      const quickId = '260609-test-missing-summary';
      const taskDir = path.join(cwd, '.planning', 'quick', quickId);
      fs.mkdirSync(taskDir, { recursive: true });
      // No SUMMARY file at all.

      const result = auditOpenArtifacts(cwd);
      const realQuickTasks = result.items.quick_tasks.filter(
        i => !i.scan_error && !i._remainder_count
      );

      assert.equal(realQuickTasks.length, 1, 'missing SUMMARY must still be flagged');
      assert.equal(realQuickTasks[0].status, 'missing');
    } finally {
      cleanup(cwd);
    }
  });

  test('[PRIMARY] SUMMARY with status: COMPLETE (uppercase) is also recognized', () => {
    // Scanner lowercases before comparing — verify case-insensitivity holds.
    const cwd = mkTmp();
    try {
      const quickId = '260609-test-uppercase-complete';
      const taskDir = path.join(cwd, '.planning', 'quick', quickId);
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, `${quickId}-SUMMARY.md`),
        '---\nstatus: COMPLETE\n---\n# Summary\nDone.\n',
        'utf-8'
      );

      const result = auditOpenArtifacts(cwd);
      const realQuickTasks = result.items.quick_tasks.filter(
        i => !i.scan_error && !i._remainder_count
      );

      assert.equal(
        realQuickTasks.length,
        0,
        `quick task SUMMARY with status: COMPLETE (uppercase) must not appear as open; ` +
        `got: ${JSON.stringify(realQuickTasks)}`
      );
    } finally {
      cleanup(cwd);
    }
  });

  // ── Secondary: template-contract checks ──────────────────────────────────
  // (source-text-is-the-product exemption: template text is the runtime contract)

  test('[TEMPLATE CONTRACT] summary.md contains status: complete in frontmatter', () => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, 'summary.md'), 'utf-8');
    // The field must appear inside the YAML frontmatter block of the embedded template
    // (between the ```markdown fence and the closing ```)
    assert.ok(
      /^status:\s*complete\s*$/m.test(content),
      'gsd-core/templates/summary.md must contain `status: complete` in its frontmatter template'
    );
  });

  test('[TEMPLATE CONTRACT] summary-minimal.md contains status: complete in frontmatter', () => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, 'summary-minimal.md'), 'utf-8');
    assert.ok(
      /^status:\s*complete\s*$/m.test(content),
      'gsd-core/templates/summary-minimal.md must contain `status: complete` in its frontmatter'
    );
  });

  test('[TEMPLATE CONTRACT] summary-standard.md contains status: complete in frontmatter', () => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, 'summary-standard.md'), 'utf-8');
    assert.ok(
      /^status:\s*complete\s*$/m.test(content),
      'gsd-core/templates/summary-standard.md must contain `status: complete` in its frontmatter'
    );
  });

  test('[TEMPLATE CONTRACT] summary-complex.md contains status: complete in frontmatter', () => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, 'summary-complex.md'), 'utf-8');
    assert.ok(
      /^status:\s*complete\s*$/m.test(content),
      'gsd-core/templates/summary-complex.md must contain `status: complete` in its frontmatter'
    );
  });
});
