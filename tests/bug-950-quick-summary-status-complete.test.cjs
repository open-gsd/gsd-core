// allow-test-rule: source-text-is-the-product
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
 * Writer-path guard: contract assertions on quick.md + gsd-executor.md (source-text-is-the-product)
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
const QUICK_MD = path.resolve(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');
const EXECUTOR_MD = path.resolve(__dirname, '..', 'agents', 'gsd-executor.md');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bug-950-'));
}

/**
 * Extract the first YAML frontmatter block from a file's content.
 *
 * Two layouts are handled:
 *  - Leading frontmatter: file starts with `---\n…\n---` (summary-minimal/standard/complex.md)
 *  - Fenced frontmatter: frontmatter lives inside a ```markdown … ``` fence (summary.md,
 *    whose content IS a markdown example showing the template). In that case we extract
 *    the `---\n…\n---` block that sits immediately after the opening fence line.
 *
 * Returns the raw text of the YAML block (between the two `---` delimiters, exclusive),
 * or null if no frontmatter could be found.
 */
function extractFrontmatter(content) {
  // Case 1: file begins with --- (leading frontmatter)
  if (/^---\r?\n/.test(content)) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    return match ? match[1] : null;
  }

  // Case 2: frontmatter is embedded inside a fenced block (```markdown\n---\n…\n---\n)
  const fenceMatch = content.match(/```(?:markdown|md)?\r?\n(---\r?\n[\s\S]*?\r?\n---)\r?\n/);
  if (fenceMatch) {
    // Strip the outer --- delimiters to get just the YAML body
    const block = fenceMatch[1];
    const inner = block.match(/^---\r?\n([\s\S]*?)\r?\n---$/);
    return inner ? inner[1] : null;
  }

  return null;
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
  // Assertions are scoped to the actual YAML frontmatter block, not the whole file,
  // so a stray `status: complete` in prose or examples cannot produce a false green.

  test('[TEMPLATE CONTRACT] summary.md contains status: complete in frontmatter', () => {
    // summary.md is a documentation template — its frontmatter lives inside a
    // ```markdown fence. extractFrontmatter() finds and returns that block.
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, 'summary.md'), 'utf-8');
    const fm = extractFrontmatter(content);
    assert.ok(
      fm !== null,
      'gsd-core/templates/summary.md: could not locate a YAML frontmatter block (leading --- or fenced ```markdown --- block)'
    );
    assert.ok(
      /^status:\s*complete\s*$/m.test(fm),
      `gsd-core/templates/summary.md: \`status: complete\` not found in the frontmatter block.\n` +
      `Frontmatter extracted:\n${fm}`
    );
  });

  test('[TEMPLATE CONTRACT] summary-minimal.md contains status: complete in frontmatter', () => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, 'summary-minimal.md'), 'utf-8');
    const fm = extractFrontmatter(content);
    assert.ok(
      fm !== null,
      'gsd-core/templates/summary-minimal.md: could not locate a leading YAML frontmatter block'
    );
    assert.ok(
      /^status:\s*complete\s*$/m.test(fm),
      `gsd-core/templates/summary-minimal.md: \`status: complete\` not found in the frontmatter block.\n` +
      `Frontmatter extracted:\n${fm}`
    );
  });

  test('[TEMPLATE CONTRACT] summary-standard.md contains status: complete in frontmatter', () => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, 'summary-standard.md'), 'utf-8');
    const fm = extractFrontmatter(content);
    assert.ok(
      fm !== null,
      'gsd-core/templates/summary-standard.md: could not locate a leading YAML frontmatter block'
    );
    assert.ok(
      /^status:\s*complete\s*$/m.test(fm),
      `gsd-core/templates/summary-standard.md: \`status: complete\` not found in the frontmatter block.\n` +
      `Frontmatter extracted:\n${fm}`
    );
  });

  test('[TEMPLATE CONTRACT] summary-complex.md contains status: complete in frontmatter', () => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, 'summary-complex.md'), 'utf-8');
    const fm = extractFrontmatter(content);
    assert.ok(
      fm !== null,
      'gsd-core/templates/summary-complex.md: could not locate a leading YAML frontmatter block'
    );
    assert.ok(
      /^status:\s*complete\s*$/m.test(fm),
      `gsd-core/templates/summary-complex.md: \`status: complete\` not found in the frontmatter block.\n` +
      `Frontmatter extracted:\n${fm}`
    );
  });

  // ── Writer-path contract checks ───────────────────────────────────────────
  // Guards quick.md and gsd-executor.md so a future edit removing `status: complete`
  // from the SUMMARY-creation instructions would fail the suite before the bug recurs.
  // (source-text-is-the-product: the deployed .md text IS the runtime contract for agents)

  test('[WRITER-PATH] quick.md constraints require status: complete in SUMMARY frontmatter', () => {
    const content = fs.readFileSync(QUICK_MD, 'utf-8');
    assert.ok(
      /status:\s*complete/.test(content),
      'gsd-core/workflows/quick.md must instruct the executor to write `status: complete` in the SUMMARY frontmatter. ' +
      'The <constraints> block must contain the `status: complete` requirement so a future edit cannot silently drop it.'
    );
  });

  test('[WRITER-PATH] gsd-executor.md frontmatter spec requires status: complete', () => {
    const content = fs.readFileSync(EXECUTOR_MD, 'utf-8');
    assert.ok(
      /status[\s\S]{0,40}complete/.test(content),
      'agents/gsd-executor.md must document `status: complete` as a required SUMMARY frontmatter field. ' +
      'The Frontmatter section must include `status: complete` so the executor always emits it.'
    );
  });
});
