'use strict';

/**
 * Tool-owned .gsd directory owner (#5757).
 *
 * Seam: gsd-core/bin/lib/gsd-tool-dir.cjs (built from src/gsd-tool-dir.cts)
 * Interface: ensureToolOwnedGsdDir(cwd, { marker, rules }) -> .gsd dir path | throws
 *
 * The link-refusal rows and the sentinel/probe parity case live in
 * tests/gsd-tool-dir.platform.test.cjs (they need real links and real git).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup } = require('./helpers.cjs');

const { ensureToolOwnedGsdDir } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'gsd-tool-dir.cjs'),
);

const { splitLines } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'text-lines.cjs'),
);

const MARKER = '# gsd-core test owner';
const RULES = ['/thing.json', '/thing.json.tmp-*', '/.gitignore'];
const OPTIONS = { marker: MARKER, rules: RULES };

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

describe('ensureToolOwnedGsdDir (#5757)', () => {
  test('creates .gsd with a catch-all .gitignore and returns its path', (t) => {
    const root = tmp('gsd-5757-owner-');
    t.after(() => cleanup(root));
    const dir = ensureToolOwnedGsdDir(root, OPTIONS);
    assert.strictEqual(dir, path.join(root, '.gsd'));
    assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*\n');
  });

  test('does not rewrite an ignore file that already carries the marker and every rule (case 9)', (t) => {
    const root = tmp('gsd-5757-owner-');
    t.after(() => cleanup(root));
    const ignorePath = path.join(root, '.gsd', '.gitignore');
    fs.mkdirSync(path.join(root, '.gsd'));
    const body = `user-rule\n${MARKER}\n${RULES.join('\n')}\n`;
    fs.writeFileSync(ignorePath, body);
    const before = fs.statSync(ignorePath);
    ensureToolOwnedGsdDir(root, OPTIONS);
    const after = fs.statSync(ignorePath);
    assert.strictEqual(fs.readFileSync(ignorePath, 'utf8'), body);
    assert.strictEqual(after.ino, before.ino, 'no replace-by-rename happened');
    assert.strictEqual(after.mtimeMs, before.mtimeMs);
  });

  test('appends only the missing rule when the marker is present (case 10)', (t) => {
    const root = tmp('gsd-5757-owner-');
    t.after(() => cleanup(root));
    const ignorePath = path.join(root, '.gsd', '.gitignore');
    fs.mkdirSync(path.join(root, '.gsd'));
    const body = `${MARKER}\n/thing.json\n/.gitignore\n`;
    fs.writeFileSync(ignorePath, body);
    ensureToolOwnedGsdDir(root, OPTIONS);
    assert.strictEqual(fs.readFileSync(ignorePath, 'utf8'), `${body}/thing.json.tmp-*\n`);
  });

  test('inserts a newline before the appended block when the file lacks a trailing newline (case 11)', (t) => {
    const root = tmp('gsd-5757-owner-');
    t.after(() => cleanup(root));
    const ignorePath = path.join(root, '.gsd', '.gitignore');
    fs.mkdirSync(path.join(root, '.gsd'));
    fs.writeFileSync(ignorePath, 'user-rule');
    ensureToolOwnedGsdDir(root, OPTIONS);
    assert.strictEqual(
      fs.readFileSync(ignorePath, 'utf8'),
      `user-rule\n${MARKER}\n${RULES.join('\n')}\n`,
    );
  });

  test('property: any user ignore text without a catch-all is preserved as a prefix, gains every rule, and merging is idempotent (case 12)', (t) => {
    const root = tmp('gsd-5757-owner-');
    t.after(() => cleanup(root));
    const ignorePath = path.join(root, '.gsd', '.gitignore');
    fs.mkdirSync(path.join(root, '.gsd'));
    const randomLineArb = fc.string({ maxLength: 8 }).filter((s) => !/[\r\n]/.test(s) && s !== '*');
    // Mix in the marker and rule lines themselves so partial-presence and
    // marker-present paths are reached, not only the all-missing path.
    const lineArb = fc.oneof(fc.constantFrom(MARKER, ...RULES), randomLineArb);
    const textArb = fc.tuple(fc.array(lineArb, { maxLength: 6 }), fc.boolean())
      .map(([lines, trailing]) => lines.join('\n') + (trailing && lines.length ? '\n' : ''));
    fc.assert(fc.property(textArb, (userText) => {
      fs.writeFileSync(ignorePath, userText);
      ensureToolOwnedGsdDir(root, OPTIONS);
      const once = fs.readFileSync(ignorePath, 'utf8');
      ensureToolOwnedGsdDir(root, OPTIONS);
      const twice = fs.readFileSync(ignorePath, 'utf8');
      const lines = splitLines(once);
      return once.startsWith(userText) &&
        once === twice &&
        RULES.every((rule) => lines.includes(rule));
    }));
  });

  test('boundary: a catch-all line in any position needs no additions', (t) => {
    const root = tmp('gsd-5757-owner-');
    t.after(() => cleanup(root));
    const ignorePath = path.join(root, '.gsd', '.gitignore');
    fs.mkdirSync(path.join(root, '.gsd'));
    for (const body of ['*', '*\n', 'a\n*\nb\n', '*\r\n']) {
      fs.writeFileSync(ignorePath, body);
      ensureToolOwnedGsdDir(root, OPTIONS);
      assert.strictEqual(fs.readFileSync(ignorePath, 'utf8'), body);
    }
  });
});
