'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { generateFragmentName, scaffoldFragment, parseFragment, parseArgs } = (() => {
  const newCs = require(path.join(ROOT, 'scripts', 'changeset', 'new.cjs'));
  const parse = require(path.join(ROOT, 'scripts', 'changeset', 'parse.cjs'));
  return { ...newCs, parseFragment: parse.parseFragment };
})();
const { FRAGMENT_ERROR } = require(path.join(ROOT, 'scripts', 'changeset', 'parse.cjs'));
const { cleanup } = require('./helpers.cjs');

const NEW_CJS = path.join(ROOT, 'scripts', 'changeset', 'new.cjs');

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-new-changeset-')); });
after(() => { cleanup(tmp); });

describe('changeset new: name generator + scaffold writer (#2975)', () => {
  test('generateFragmentName returns three lowercase words separated by hyphens', () => {
    const name = generateFragmentName();
    const parts = name.split('-');
    assert.equal(parts.length, 3);
    for (const p of parts) {
      assert.match(p, /^[a-z]+$/);
    }
  });

  test('scaffoldFragment writes a parseable fragment file with the supplied type and pr', () => {
    const file = scaffoldFragment({
      repo: tmp,
      type: 'Fixed',
      pr: 9999,
      body: 'this is a placeholder body that the contributor will replace.',
    });

    // Filesystem facts: file exists in .changeset/, is a regular file, is non-empty.
    const stat = fs.statSync(file);
    assert.ok(stat.isFile());
    assert.ok(stat.size > 0);
    assert.equal(path.dirname(file), path.join(tmp, '.changeset'));

    // Content fact: the file is a valid fragment per the parser. We do NOT
    // substring-match the file text; we round-trip it through parseFragment
    // and assert on the typed result.
    const src = fs.readFileSync(file, 'utf8');
    const parsed = parseFragment(src);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.fragment, {
      type: 'Fixed',
      pr: 9999,
      body: 'this is a placeholder body that the contributor will replace.',
      docsExempt: null,
    });
  });

  test('two consecutive scaffoldFragment calls in the same dir produce different filenames (no collisions in normal use)', () => {
    const a = scaffoldFragment({ repo: tmp, type: 'Added', pr: 1, body: 'aaa.' });
    const b = scaffoldFragment({ repo: tmp, type: 'Added', pr: 2, body: 'bbb.' });
    assert.notEqual(path.basename(a), path.basename(b));
  });

  test('rejects type values not on the Keep-a-Changelog allowlist (sanitization)', () => {
    // Includes the newline-injection case from the CR finding.
    for (const badType of ['Refactored', 'fixed', 'Fixed\ntype: Added', 'Fixed; rm -rf /', '']) {
      assert.throws(
        () => scaffoldFragment({ repo: tmp, type: badType, pr: 1, body: 'x.' }),
        /not one of \[Added, Changed, Deprecated, Removed, Fixed, Security\]/,
        `bad type ${JSON.stringify(badType)} should be rejected`,
      );
    }
  });

  test('parseArgs returns { ok: false, error } when --repo is missing its value', () => {
    const { parseArgs } = require(path.join(ROOT, 'scripts', 'changeset', 'new.cjs'));
    const r = parseArgs(['--type', 'Fixed', '--pr', '1', '--body', 'x.', '--repo']);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'missing value for --repo');
  });

  test('parseArgs returns { ok: false, error } when a flag value is itself another flag', () => {
    const { parseArgs } = require(path.join(ROOT, 'scripts', 'changeset', 'new.cjs'));
    const r = parseArgs(['--type', 'Fixed', '--repo', '--pr', '1', '--body', 'x.']);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'missing value for --repo');
  });

  test('parseArgs returns { ok: true, opts } on a well-formed argv', () => {
    const { parseArgs } = require(path.join(ROOT, 'scripts', 'changeset', 'new.cjs'));
    const r = parseArgs(['--type', 'Fixed', '--pr', '42', '--body', 'a body', '--repo', '/tmp/x']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.opts, { type: 'Fixed', pr: 42, body: 'a body', repo: '/tmp/x' });
  });
});

describe('changeset new: --pr 0 placeholder acceptance (bug #1224)', () => {
  // (a) The headline bug: `main()` (not just parseArgs) must ACCEPT --pr 0.
  //     We exercise the end-to-end CLI path via spawnSync so that main()'s guard
  //     is on the critical path. Old code had `if (!opts.pr)` which treated 0 as
  //     falsy and exited with code 2. Fixed code uses explicit `=== null` / isNaN
  //     guards and must exit 0 and write a fragment file with pr: 0 in frontmatter.
  test('(a) CLI main() accepts --pr 0 (exit 0) and writes a pr:0 fragment rejected at lint time', () => {
    // Use an isolated temp dir per invocation to avoid .changeset/ pollution
    // from other tests sharing `tmp`.
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-new-cs-a-'));
    try {
      const result = spawnSync(
        process.execPath,
        [NEW_CJS, '--type', 'Fixed', '--pr', '0', '--body', 'placeholder for pr-zero.', '--repo', isolatedDir],
        { encoding: 'utf8', timeout: 10000 },
      );

      // The bug: old main() did `if (!opts.pr)` → exit 2. Fixed: exit 0.
      assert.equal(result.status, 0,
        `CLI main() must exit 0 for --pr 0; got status=${result.status} stderr=${result.stderr}`);

      // A fragment file must exist under .changeset/
      const csDir = path.join(isolatedDir, '.changeset');
      const files = fs.readdirSync(csDir).filter(f => f.endsWith('.md'));
      assert.equal(files.length, 1,
        `Expected exactly one fragment file in ${csDir}, got: ${JSON.stringify(files)}`);

      // The written fragment must round-trip through parseFragment as INVALID_PR,
      // confirming pr:0 was embedded (not absent, NaN, or a positive integer).
      const src = fs.readFileSync(path.join(csDir, files[0]), 'utf8');
      const parsed = parseFragment(src);
      assert.equal(parsed.ok, false, 'parseFragment must reject a pr:0 fragment at lint time');
      assert.equal(parsed.reason, FRAGMENT_ERROR.INVALID_PR,
        `expected INVALID_PR, got: ${parsed.reason}`);
    } finally {
      cleanup(isolatedDir);
    }
  });

  // (b) missing --pr: parseArgs leaves opts.pr as null, causing main() to reject.
  test('(b) missing --pr leaves opts.pr as null (rejected by main validation)', () => {
    const r = parseArgs(['--type', 'Fixed', '--body', 'body without pr flag.', '--repo', tmp]);
    assert.equal(r.ok, true, 'parseArgs itself succeeds; rejection is in main()');
    assert.equal(r.opts.pr, null, `opts.pr should be null when --pr is omitted, got: ${r.opts.pr}`);
    // prMissing = opts.pr === null → would trigger rejection in main()
    assert.equal(r.opts.pr === null, true, 'prMissing condition must be true');
  });

  // (c) --pr abc: non-numeric input normalised to NaN by parseArgs.
  test('(c) --pr abc (non-numeric) produces NaN in opts.pr (rejected by main validation)', () => {
    const r = parseArgs(['--type', 'Fixed', '--pr', 'abc', '--body', 'body.', '--repo', tmp]);
    assert.equal(r.ok, true, 'parseArgs itself succeeds; rejection is in main()');
    assert.equal(Number.isNaN(r.opts.pr), true,
      `opts.pr should be NaN for non-numeric input, got: ${r.opts.pr}`);
  });

  // (d1) --pr "" (empty string): trimmed to "", /^\d+$/ fails → NaN.
  test('(d1) --pr "" (empty string) produces NaN in opts.pr (rejected by main validation)', () => {
    const r = parseArgs(['--type', 'Fixed', '--pr', '', '--body', 'body.', '--repo', tmp]);
    assert.equal(r.ok, true, 'parseArgs itself succeeds; rejection is in main()');
    assert.equal(Number.isNaN(r.opts.pr), true,
      `opts.pr should be NaN for empty string, got: ${r.opts.pr}`);
  });

  // (d2) --pr "   " (whitespace-only): trimmed to "", /^\d+$/ fails → NaN.
  test('(d2) --pr "   " (whitespace-only) produces NaN in opts.pr (rejected by main validation)', () => {
    const r = parseArgs(['--type', 'Fixed', '--pr', '   ', '--body', 'body.', '--repo', tmp]);
    assert.equal(r.ok, true, 'parseArgs itself succeeds; rejection is in main()');
    assert.equal(Number.isNaN(r.opts.pr), true,
      `opts.pr should be NaN for whitespace-only input, got: ${r.opts.pr}`);
  });

  // (e) parse.cjs rejects a pr:0 fragment — the merge-time lint safety net is intact.
  test('(e) parseFragment rejects a pr:0 fragment with INVALID_PR (lint safety net intact)', () => {
    const fragmentContent = `---\ntype: Fixed\npr: 0\n---\nsome body text.\n`;
    const result = parseFragment(fragmentContent);
    assert.equal(result.ok, false, 'parseFragment must reject pr:0 at lint time');
    assert.equal(result.reason, FRAGMENT_ERROR.INVALID_PR,
      `expected INVALID_PR reason, got: ${result.reason}`);
  });
});
