'use strict';

/**
 * Regression test for #1778:
 *   /gsd-thread close|resume emit the pre-1.6 positional `frontmatter set`
 *   form → status/updated write silently fails.
 *
 * Root cause: the thread workflow's CLOSE and RESUME branches called the
 * frontmatter-set query with the pre-1.6 fully-positional shape
 *   gsd_run query frontmatter.set <file> <field> <value>
 * but since 1.6 the dispatcher (gsd-tools.cjs) parses the file positionally
 * and reads field/value from the NAMED flags --field/--value via parseNamedArgs.
 * The positional form leaves field/value undefined, cmdFrontmatterSet errors
 * `file, field, and value required`, and the status/updated writes are skipped
 * — so closing a thread never marks it `status: resolved` and resuming never
 * marks it `status: in_progress`.
 *
 * This test locks the fix two ways:
 *   1. Behavioral: the 1.6 named-flag form writes the field; the positional
 *      form errors with `file, field, and value required` (proves the contract
 *      and that the bug is real).
 *   2. Workflow parity: no workflow under gsd-core/workflows/ emits the
 *      positional frontmatter.set form — every frontmatter.set invocation
 *      must use --field/--value. This is the regression guard: a future edit
 *      that reintroduces the positional form anywhere fails CI.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempProject, cleanup, runGsdTools, parseFrontmatter } = require('./helpers.cjs');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const THREAD_WORKFLOW = path.join(WORKFLOWS_DIR, 'thread.md');

describe('#1778: thread workflow uses the 1.6 named-flag frontmatter.set form', () => {
  test('behavioral: named-flag frontmatter.set writes the field; positional form errors', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));

    // Seed a thread-shaped file with frontmatter to mutate.
    fs.mkdirSync(path.join(tmpDir, '.planning', 'threads'), { recursive: true });
    const threadFile = path.join(tmpDir, '.planning', 'threads', 'auth-spike.md');
    fs.writeFileSync(
      threadFile,
      '---\nstatus: open\nupdated: "2025-01-01"\n---\n\n# thread body\n',
    );

    // 1.6 named-flag form — must succeed and write status: resolved.
    const rel = '.planning/threads/auth-spike.md';
    const good = runGsdTools(
      ['frontmatter', 'set', rel, '--field', 'status', '--value', 'resolved'],
      tmpDir,
    );
    assert.ok(good.success, `named-flag form must succeed; stderr: ${good.error}`);
    const afterGood = parseFrontmatter(fs.readFileSync(threadFile, 'utf-8'));
    assert.strictEqual(
      afterGood.status,
      'resolved',
      'named-flag form must write status: resolved into the thread file',
    );

    // Re-seed and prove the pre-1.6 positional form is the bug: it errors
    // `file, field, and value required` and does NOT write.
    fs.writeFileSync(
      threadFile,
      '---\nstatus: open\nupdated: "2025-01-01"\n---\n\n# thread body\n',
    );
    const bad = runGsdTools(
      ['frontmatter', 'set', rel, 'status', 'resolved'],
      tmpDir,
    );
    assert.ok(
      !bad.success,
      'positional form must fail (it is the bug being guarded against)',
    );
    const combined = bad.error + bad.output;
    assert.ok(
      combined.includes('file, field, and value required'),
      `positional form must error with the documented message; got:\n${combined}`,
    );
    const afterBad = parseFrontmatter(fs.readFileSync(threadFile, 'utf-8'));
    assert.strictEqual(
      afterBad.status,
      'open',
      'positional form must NOT mutate the file (the silent-failure bug)',
    );
  });

  test('workflow parity: no gsd-core/workflows/*.md emits the positional frontmatter.set form', () => {
    const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(files.length > 0, 'expected at least one workflow under gsd-core/workflows/');

    const offenders = [];
    for (const name of files) {
      const full = path.join(WORKFLOWS_DIR, name);
      const lines = fs.readFileSync(full, 'utf-8').split(/\r?\n/);
      lines.forEach((line, i) => {
        // Match any frontmatter.set invocation (dot or space form, with or
        // without the `gsd_run query` prefix).
        if (!/frontmatter[.\s]+set\b/.test(line)) return;
        // The 1.6 contract requires --field AND --value on every set call.
        // A set line missing --field is the pre-1.6 positional form.
        if (!/--field\b/.test(line) || !/--value\b/.test(line)) {
          offenders.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    assert.deepStrictEqual(
      offenders,
      [],
      `These workflow frontmatter.set invocations are missing the 1.6 --field/--value named flags (the #1778 positional-form bug):\n  ${offenders.join('\n  ')}\n\nUse: gsd_run query frontmatter.set <file> --field <field> --value <value>`,
    );
  });

  test('thread workflow CLOSE writes status: resolved and RESUME writes status: in_progress via named flags', () => {
    const src = fs.readFileSync(THREAD_WORKFLOW, 'utf-8');

    // CLOSE mode: status resolved + updated, both via named flags.
    assert.ok(
      /frontmatter\.set\s+\S*\.planning\/threads\/\{SLUG\}\.md\s+--field\s+status\s+--value\s+resolved\b/.test(src),
      'CLOSE mode must invoke: frontmatter.set .planning/threads/{SLUG}.md --field status --value resolved',
    );
    assert.ok(
      /frontmatter\.set\s+\S*\.planning\/threads\/\{SLUG\}\.md\s+--field\s+updated\s+--value\s+YYYY-MM-DD\b/.test(src),
      'CLOSE mode must invoke: frontmatter.set .planning/threads/{SLUG}.md --field updated --value YYYY-MM-DD',
    );

    // RESUME mode: status in_progress + updated, both via named flags.
    assert.ok(
      /frontmatter\.set\s+\S*\.planning\/threads\/\{SLUG\}\.md\s+--field\s+status\s+--value\s+in_progress\b/.test(src),
      'RESUME mode must invoke: frontmatter.set .planning/threads/{SLUG}.md --field status --value in_progress',
    );
  });
});
