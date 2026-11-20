'use strict';

/**
 * portability-rule-disable-ban.test.cjs
 *
 * Detection cases for scripts/static-checks/portability-rule-disable-ban.cjs
 * (ADR-1703). The scan of the real repository is no longer a test: it runs once
 * in scripts/run-static-checks.cjs (ADR-6315 item 19, #6414). These cases run
 * the check against small temporary trees, so each one fails when the check
 * stops detecting what it exists to detect.
 *
 * The disable keyword appears below only inside string data built by
 * concatenation, so this file holds no real directive.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const ban = require('../scripts/static-checks/portability-rule-disable-ban.cjs');

const KW = 'eslint-' + 'disable';
const KW_NEXT = 'eslint-' + 'disable-next-line';

/** A repository root holding the given files (relative POSIX path to text). */
function makeRoot(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-disable-ban-'));
  t.after(() => cleanup(root));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

describe('classifyComment', () => {
  test('a disable with no rule list is blanket', () => {
    assert.equal(ban.classifyComment(` ${KW} `), 'blanket');
    assert.equal(ban.classifyComment(` ${KW_NEXT} `), 'blanket');
  });

  test('a disable with only prose after the keyword is blanket', () => {
    assert.equal(ban.classifyComment(` ${KW} -- because I said so`), 'blanket');
  });

  test('a disable naming a protected rule, with or without the local/ prefix, is named', () => {
    assert.equal(ban.classifyComment(` ${KW_NEXT} local/no-hardcoded-tmp`), 'named');
    assert.equal(ban.classifyComment(` ${KW_NEXT} no-hardcoded-tmp -- reason`), 'named');
  });

  test('a disable listing a protected rule among others is named', () => {
    assert.equal(ban.classifyComment(` ${KW_NEXT} no-console, local/no-bare-npm-exec`), 'named');
  });

  test('a disable naming only a non-portability rule is allowed', () => {
    assert.equal(ban.classifyComment(` ${KW_NEXT} no-console`), null);
  });

  test('an ordinary comment is not a directive', () => {
    assert.equal(ban.classifyComment(' just a comment about disabling things'), null);
  });

  test('every protected rule is detected by name', () => {
    for (const rule of ban.PROTECTED_RULES) {
      assert.equal(ban.classifyComment(` ${KW_NEXT} local/${rule}`), 'named', rule);
    }
  });
});

describe('run: seeded violations in a temporary tree', () => {
  test('a named disable of a protected rule in a test file is reported with its line', (t) => {
    const root = makeRoot(t, {
      'tests/a.test.cjs': `'use strict';\n// ${KW_NEXT} local/no-hardcoded-tmp\nconst x = 1;\n`,
    });
    const findings = ban.run({ root, minFiles: 0 });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'tests/a.test.cjs');
    assert.equal(findings[0].line, 2);
    assert.match(findings[0].message, /protected portability rule/);
  });

  test('a blanket disable in a test file is reported', (t) => {
    const root = makeRoot(t, { 'tests/b.test.cjs': `/* ${KW} */\nconst x = 1;\n` });
    const findings = ban.run({ root, minFiles: 0 });
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /blanket disable/);
  });

  test('a named disable in a .cts source is reported (the typescript parser path)', (t) => {
    const root = makeRoot(t, {
      'src/a.cts': `// ${KW_NEXT} local/normalize-path-in-content\nexport const x: number = 1;\n`,
    });
    const findings = ban.run({ root, minFiles: 0 });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'src/a.cts');
    assert.equal(findings[0].line, 1);
    assert.match(findings[0].message, /protected portability rule/);
  });

  test('a disable in bin/install.js with a shebang is reported at its own line', (t) => {
    const root = makeRoot(t, {
      'bin/install.js': `#!/usr/bin/env node\n// ${KW_NEXT} local/require-fs-op-fallback\nconst x = 1;\n`,
    });
    const findings = ban.run({ root, minFiles: 0 });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 2);
  });

  test('a disable of a non-portability rule, and a tree with none, report nothing', (t) => {
    const root = makeRoot(t, {
      'tests/c.test.cjs': `// ${KW_NEXT} no-console\nconsole.log(1);\n`,
      'tests/d.test.cjs': 'const y = 2;\n',
    });
    assert.deepEqual(ban.run({ root, minFiles: 0 }), []);
  });

  test('every violation in every file is reported, not only the first', (t) => {
    const root = makeRoot(t, {
      'tests/e.test.cjs': `/* ${KW} */\n// ${KW_NEXT} local/no-hardcoded-tmp\n`,
      'tests/f.test.cjs': `/* ${KW} */\n`,
    });
    assert.equal(ban.run({ root, minFiles: 0 }).length, 3);
  });
});

describe('scanFile fails closed', () => {
  test('a file that holds the keyword and does not parse is a finding, not a skip', (t) => {
    const root = makeRoot(t, { 'tests/broken.test.cjs': `const = ;\n// ${KW}\n` });
    const findings = ban.run({ root, minFiles: 0 });
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /Parse error/);
  });

  test('a .cts file that holds the keyword and does not parse is a finding', (t) => {
    const root = makeRoot(t, { 'src/broken.cts': `export const : = ;\n// ${KW}\n` });
    const findings = ban.run({ root, minFiles: 0 });
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /Parse error/);
  });

  test('scanFile throws on an unreadable path', () => {
    assert.throws(() => ban.scanFile(path.join(os.tmpdir(), 'gsd-no-such-file-6414.cjs')), /Could not read/);
  });

  test('a file without the keyword is not parsed, so cannot hold a directive', (t) => {
    const root = makeRoot(t, { 'tests/plain.test.cjs': 'const = ;\n' });
    assert.deepEqual(ban.scanFile(path.join(root, 'tests', 'plain.test.cjs')), { blanket: [], named: [] });
  });
});

describe('run: the scan is not vacuous', () => {
  test('a tree with fewer files than the minimum is a finding', (t) => {
    const root = makeRoot(t, { 'tests/a.test.cjs': 'const x = 1;\n' });
    const findings = ban.run({ root, minFiles: 2 });
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /expected at least 2 files to scan, found 1/);
  });

  test('a tree with exactly the minimum is clean (limit, not limit-1)', (t) => {
    const root = makeRoot(t, { 'tests/a.test.cjs': 'const x = 1;\n', 'tests/b.test.cjs': 'const y = 2;\n' });
    assert.deepEqual(ban.run({ root, minFiles: 2 }), []);
    assert.equal(ban.run({ root, minFiles: 3 }).length, 1);
  });

  test('the default minimum is 10 files', () => {
    assert.equal(ban.MIN_FILES, 10);
  });
});

describe('collectFiles', () => {
  test('covers test files, .cts sources, bin/install.js and scripts/build-hooks.js, and nothing else', (t) => {
    const root = makeRoot(t, {
      'tests/a.test.cjs': '',
      'tests/helper.cjs': '',
      'src/a.cts': '',
      'src/b.js': '',
      'bin/install.js': '',
      'scripts/build-hooks.js': '',
      'scripts/other.cjs': '',
    });
    const rel = ban.collectFiles(root).map((abs) => path.relative(root, abs).split(path.sep).join('/')).sort();
    assert.deepEqual(rel, ['bin/install.js', 'scripts/build-hooks.js', 'src/a.cts', 'tests/a.test.cjs']);
  });
});
