'use strict';

/**
 * no-adhoc-config-merge.allowlist.test.cjs
 *
 * The census and the demonstration for local/no-adhoc-config-merge (#6032, ADR-1411 Decision 5):
 *
 *   1. CENSUS ZERO — the real first-party tree has no ad-hoc config merge, judged by identity
 *      through scripts/lib/allowlist-ratchet.cjs, and the temporary migration section is empty.
 *   2. SHAPE — the allowlist file keeps the two exemption kinds apart and well-formed.
 *   3. WIRING — eslint.config.mjs registers the rule at error with that allowlist on every
 *      first-party surface the census covers.
 *   4. DEMONSTRATION — a deliberately reintroduced copy goes red, and its removal goes green.
 *      A guard that has never been observed red is an assumption (ADR-1411 Decision 5).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ESLint } = require('eslint');

const { assertWithinAllowlist } = require('../scripts/lib/allowlist-ratchet.cjs');
const rule = require('../eslint-rules/no-adhoc-config-merge.cjs');
const allowlist = require('../eslint-rules/no-adhoc-config-merge.allowlist.json');

const ROOT = path.join(__dirname, '..');
const RULE_ID = 'local/no-adhoc-config-merge';

function collect(dir, predicate, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // hooks/dist is the installer's staged copy of hooks/ (build output, gitignored).
      if (entry.name !== 'node_modules' && entry.name !== 'dist') collect(full, predicate, out);
    } else if (predicate(full)) out.push(full);
  }
  return out;
}

/** A compiled twin: gsd-core/bin/lib/<path>.cjs built from src/<path>.cts, at any depth. */
function isBuildOutput(file) {
  const rel = path.relative(path.join(ROOT, 'gsd-core', 'bin', 'lib'), file);
  if (rel.startsWith('..')) return false;
  return fs.existsSync(path.join(ROOT, 'src', rel.replace(/\.cjs$/, '.cts')));
}

function ruleOnlyEslint() {
  const { parser } = require('typescript-eslint');
  const options = { ...allowlist };
  const plugins = { local: { rules: { 'no-adhoc-config-merge': rule } } };
  return new ESLint({
    cwd: ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.cts'], languageOptions: { parser }, plugins, rules: { [RULE_ID]: ['error', options] } },
      {
        files: ['**/*.js', '**/*.cjs'],
        languageOptions: { sourceType: 'commonjs', ecmaVersion: 2022 },
        plugins,
        rules: { [RULE_ID]: ['error', options] },
      },
    ],
  });
}

describe('no-adhoc-config-merge allowlist: shape', () => {
  test('two exemption kinds, both arrays of repo-relative POSIX paths that exist', () => {
    assert.deepEqual(Object.keys(allowlist).sort(), ['resolverInternal', 'temporary']);
    for (const kind of ['resolverInternal', 'temporary']) {
      assert.ok(Array.isArray(allowlist[kind]), `${kind} must be an array`);
      for (const file of allowlist[kind]) {
        assert.equal(typeof file, 'string');
        assert.ok(!file.includes('\\') && !path.isAbsolute(file), `${file} must be a repo-relative POSIX path`);
        assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} must exist`);
      }
    }
  });

  test('the boundary is the resolver, the loader, the path owner, the hook-side reader and the statusline', () => {
    assert.deepEqual([...allowlist.resolverInternal].sort(), [
      'hooks/gsd-statusline.js',
      'hooks/lib/config-read.js',
      'src/config-loader.cts',
      'src/config-value-resolver.cts',
      'src/planning-workspace.cts',
    ]);
  });

  test('the temporary migration section is empty (epic #4633 done-when)', () => {
    assert.deepEqual(allowlist.temporary, []);
  });
});

describe('no-adhoc-config-merge: the first-party tree', () => {
  test('census zero: every offending file is allowlisted and every allowlisted file offends', async () => {
    // First-party source only: gsd-core/bin/lib/<name>.cjs with a src/<name>.cts twin is build output
    // (gitignored), not a surface the lint config reaches.
    const files = [
      ...collect(path.join(ROOT, 'src'), (f) => f.endsWith('.cts'), []),
      ...collect(path.join(ROOT, 'hooks'), (f) => f.endsWith('.js'), []),
      ...collect(path.join(ROOT, 'scripts'), (f) => f.endsWith('.cjs'), []),
      ...collect(path.join(ROOT, 'gsd-core', 'bin'), (f) => f.endsWith('.cjs') && !isBuildOutput(f), []),
      path.join(ROOT, 'bin', 'install.js'),
    ];
    // Without the allowlist options an offender is reported and an exempt file is not, so run the
    // rule bare and compare by identity with the temporary section.
    const { parser } = require('typescript-eslint');
    const plugins = { local: { rules: { 'no-adhoc-config-merge': rule } } };
    const eslint = new ESLint({
      cwd: ROOT,
      overrideConfigFile: true,
      overrideConfig: [
        { files: ['**/*.cts'], languageOptions: { parser }, plugins, rules: { [RULE_ID]: ['error', { resolverInternal: allowlist.resolverInternal }] } },
        {
          files: ['**/*.js', '**/*.cjs'],
          languageOptions: { sourceType: 'commonjs', ecmaVersion: 2022 },
          plugins,
          rules: { [RULE_ID]: ['error', { resolverInternal: allowlist.resolverInternal }] },
        },
      ],
    });
    const results = await eslint.lintFiles(files);
    const offenders = new Set();
    const details = [];
    for (const result of results) {
      for (const message of result.messages) {
        if (message.ruleId !== RULE_ID) continue;
        const rel = path.relative(ROOT, result.filePath).split(path.sep).join('/');
        offenders.add(rel);
        details.push(`${rel}:${message.line} ${message.messageId}`);
      }
    }
    assertWithinAllowlist({
      label: 'no-adhoc-config-merge',
      current: offenders,
      known: allowlist.temporary,
      fail: (msg) => assert.fail(`${msg}\n${details.join('\n')}`),
      pruneHint: 'migrate the site onto the resolver; never add to eslint-rules/no-adhoc-config-merge.allowlist.json',
    });
    assert.deepEqual(details, []);
    assert.ok(files.length > 200, 'the census must actually have scanned the first-party surface');
  });
});

describe('no-adhoc-config-merge: wiring in eslint.config.mjs', () => {
  const surfaces = [
    'src/anything.cts',
    'hooks/anything.js',
    'gsd-core/bin/anything.cjs',
    'scripts/anything.cjs',
    'bin/install.js',
  ];
  for (const file of surfaces) {
    test(`${file} runs the rule at error with the allowlist`, async () => {
      const eslint = new ESLint({ cwd: ROOT });
      const config = await eslint.calculateConfigForFile(path.join(ROOT, file));
      const entry = config.rules[RULE_ID];
      assert.ok(entry, `${RULE_ID} must be configured for ${file}`);
      assert.equal(entry[0], 2, 'severity must be error');
      assert.deepEqual(entry[1], allowlist);
    });
  }
});

describe('no-adhoc-config-merge: a reintroduced copy goes red', () => {
  // The shape of the four precedence copies epic #4633 deleted: read the global defaults file and
  // the project file by hand, then merge them.
  const REINTRODUCED = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const globalDefaults = JSON.parse(fs.readFileSync(path.join(home, '.gsd', 'defaults.json'), 'utf8'));",
    "const projectConfig = JSON.parse(fs.readFileSync(path.join(planningDir(cwd), 'config.json'), 'utf8'));",
    'module.exports = { ...globalDefaults, ...projectConfig };',
    '',
  ].join('\n');
  const REMOVED = "const fs = require('node:fs');\nmodule.exports = {};\n";

  test('the copy is reported on all three shapes, and removing it is green', async () => {
    const eslint = ruleOnlyEslint();
    const file = path.join(ROOT, 'src', 'reintroduced-config-merge.cts');
    const [red] = await eslint.lintText(REINTRODUCED, { filePath: file });
    const ids = red.messages.filter((m) => m.ruleId === RULE_ID).map((m) => m.messageId).sort();
    assert.deepEqual(ids, ['configSpreadMerge', 'layerPathRead', 'layerPathRead', 'layerWalk']);
    const [green] = await eslint.lintText(REMOVED, { filePath: file });
    assert.deepEqual(green.messages.filter((m) => m.ruleId === RULE_ID), []);
  });

  test('a hook-style single-layer read goes red too', async () => {
    const eslint = ruleOnlyEslint();
    const code = "const path = require('node:path');\nconst cfg = JSON.parse(read(path.join(cwd, '.planning', 'config.json')));\n";
    const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, 'hooks', 'gsd-reintroduced.js') });
    assert.deepEqual(result.messages.filter((m) => m.ruleId === RULE_ID).map((m) => m.messageId), ['layerPathRead']);
  });
});
