'use strict';

/**
 * #4779 — the OpenCode install rewrites the Claude-only forms that survive the path rewrite:
 * the project-skills locator (`.claude/skills/`) and the launcher's reinstall hint
 * (`--claude --local`), and the post-install leak scan reports the same forms on OpenCode.
 * Matrix: .gsd/phase/feat-4779-opencode-claude-only-rewrites/50-test-matrix.md.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const installer = require('../bin/install.js');
const conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

const HINT_OLD = '--claude --local';
const HINT_NEW = '--opencode --global';
const LOC_OLD = '.claude/skills/';
const LOC_NEW = '.opencode/skills/';

const rewrite = (content) => conversion.rewriteOpencodeClaudeOnlyForms(content);
const viaBin = (content, opts) => installer.convertClaudeToOpencodeFrontmatter(content, opts);
const viaModule = (content, opts) => conversion.convertClaudeToOpencodeFrontmatter(content, opts);

describe('#4779: rewriteOpencodeClaudeOnlyForms', () => {
  test('rewrites the project-skills locator', () => {
    assert.equal(
      rewrite('check for `.claude/skills/` or `.agents/skills/`'),
      'check for `.opencode/skills/` or `.agents/skills/`',
    );
  });

  test('rewrites the dot-slash locator', () => {
    assert.equal(rewrite('see ./.claude/skills/gsd-x/SKILL.md'), 'see ./.opencode/skills/gsd-x/SKILL.md');
  });

  test('rewrites the launcher hint', () => {
    assert.equal(
      rewrite('Run: npx -y @opengsd/gsd-core@latest --claude --local'),
      'Run: npx -y @opengsd/gsd-core@latest --opencode --global',
    );
  });

  test('leaves other claude flags alone', () => {
    for (const text of ['--claude --global', 'use --claude here', '--claude --local-foo', 'x--claude --local']) {
      assert.equal(rewrite(text), text, text);
    }
  });

  test('keeps the multi-runtime fallback chain', () => {
    const chain = '"${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/gsd-tools.cjs" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/gsd-tools.cjs" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
    assert.equal(rewrite(chain), chain);
  });

  test('matches the exact segment only', () => {
    for (const text of ['.claude/skills', '.claude/skills-x/', 'my.claude/skills/', 'a-.claude/skills/']) {
      assert.equal(rewrite(text), text, text);
    }
  });

  for (const count of [0, 1, 2]) {
    test(`rewrites every occurrence (${count} of each)`, () => {
      const text = Array.from({ length: count }, () => `${LOC_OLD} then ${HINT_OLD}`).join(' | ');
      const out = rewrite(text);
      assert.equal(out.includes(LOC_OLD), false);
      assert.equal(out.includes(HINT_OLD), false);
      assert.equal(out.split(LOC_NEW).length - 1, count);
      assert.equal(out.split(HINT_NEW).length - 1, count);
    });
  }

  test('handles CRLF text', () => {
    assert.equal(rewrite(`a ${LOC_OLD}\r\nb ${HINT_OLD}\r\n`), `a ${LOC_NEW}\r\nb ${HINT_NEW}\r\n`);
  });

  test('is idempotent', () => {
    const once = rewrite(`${LOC_OLD} ${HINT_OLD}`);
    assert.equal(rewrite(once), once);
  });

  test('passes non-string input through', () => {
    for (const value of [undefined, null, 0, 7]) {
      assert.equal(rewrite(value), value);
    }
  });
});

describe('#4779: both OpenCode converters apply the rewrites', () => {
  const body = `Read \`${LOC_OLD}\`.\nRun: npx -y @opengsd/gsd-core@latest ${HINT_OLD}\n`;
  const expectedBody = `Read \`${LOC_NEW}\`.\nRun: npx -y @opengsd/gsd-core@latest ${HINT_NEW}\n`;
  const agent = `---\nname: gsd-x\ndescription: x\ntools: Read\n---\n${body}`;

  for (const [label, convert] of [['bin/install.js', viaBin], ['conversion module', viaModule]]) {
    test(`${label}: rewrites body-only content`, () => {
      assert.equal(convert(body), expectedBody);
    });
    test(`${label}: rewrites an agent body`, () => {
      const out = convert(agent, { isAgent: true });
      assert.ok(out.includes(expectedBody), out);
      assert.equal(out.includes(LOC_OLD), false);
      assert.equal(out.includes(HINT_OLD), false);
    });
  }

  test('bin and module converters agree', () => {
    assert.equal(viaBin(body), viaModule(body));
    assert.equal(viaBin(agent, { isAgent: true }), viaModule(agent, { isAgent: true }));
  });

  test('property: parity, no residue, negative-space tokens survive', () => {
    const tokens = [
      LOC_OLD, `./${LOC_OLD}`, HINT_OLD, '--claude --global', '.claude/skills', 'my.claude/skills/',
      '${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin', '.codex/gsd-core/bin', 'prose', '\n', '\r\n', ' ', '`',
    ];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...tokens), { maxLength: 24 }), (parts) => {
        const input = parts.join(' ');
        const out = viaModule(input);
        assert.equal(viaBin(input), out);
        assert.equal(out.includes(HINT_OLD), false);
        assert.equal(/(^|[^A-Za-z0-9_-])\.claude\/skills\//.test(out), false);
        for (const kept of ['--claude --global', '${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin', 'my.claude/skills/']) {
          assert.equal(out.split(kept).length, input.split(kept).length, kept);
        }
        return true;
      }),
      { seed: 4779, numRuns: 200 },
    );
  });
});

describe('#4779: collectInstalledClaudeLeaks', () => {
  function tree(files) {
    const dir = createTempDir('gsd-4779-scan-');
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
  }
  const scan = (dir, runtime, rels) =>
    installer.collectInstalledClaudeLeaks({ targetDir: dir, manifestFiles: rels, runtime });

  test('reports the locator on opencode', (t) => {
    const dir = tree({ 'agents/a.md': `see ${LOC_OLD}\n` });
    t.after(() => cleanup(dir));
    assert.deepEqual(scan(dir, 'opencode', ['agents/a.md']), [{ file: 'agents/a.md', count: 1 }]);
  });

  test('counts hint occurrences', (t) => {
    const dir = tree({ 'agents/a.md': `${HINT_OLD} and ${HINT_OLD}\n` });
    t.after(() => cleanup(dir));
    assert.deepEqual(scan(dir, 'opencode', ['agents/a.md']), [{ file: 'agents/a.md', count: 2 }]);
  });

  test('still reports ~/.claude', (t) => {
    const dir = tree({ 'agents/a.md': 'path ~/.claude/x and $HOME/.claude\n' });
    t.after(() => cleanup(dir));
    assert.deepEqual(scan(dir, 'opencode', ['agents/a.md']), [{ file: 'agents/a.md', count: 2 }]);
  });

  test('ignores the new patterns on claude', (t) => {
    const dir = tree({ 'agents/a.md': `${LOC_OLD} ${HINT_OLD}\n` });
    t.after(() => cleanup(dir));
    assert.deepEqual(scan(dir, 'claude', ['agents/a.md']), []);
  });

  test('skips the byte-identical corpus', (t) => {
    const dir = tree({
      'gsd-core/commands/x.md': `${LOC_OLD} ~/.claude\n`,
      'gsd-core/agents/y.md': `${HINT_OLD}\n`,
    });
    t.after(() => cleanup(dir));
    assert.deepEqual(scan(dir, 'opencode', ['gsd-core/commands/x.md', 'gsd-core/agents/y.md']), []);
  });

  test('skips CHANGELOG and missing files', (t) => {
    const dir = tree({ 'CHANGELOG.md': `${LOC_OLD} ${HINT_OLD} ~/.claude\n` });
    t.after(() => cleanup(dir));
    assert.deepEqual(scan(dir, 'opencode', ['CHANGELOG.md', 'agents/missing.md']), []);
  });
});

describe('#4779: installed trees', () => {
  function install(t, runtimeFlag) {
    const home = createTempDir('gsd-4779-home-');
    t.after(() => cleanup(home));
    const configDir = path.join(home, 'cfg');
    const result = runNode([INSTALL_SCRIPT, runtimeFlag, '--global', '--config-dir', configDir], {
      env: installerEnv(isolatedEnv({ home, path: process.env.PATH })),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    assert.strictEqual(result.exitCode, 0, `installer failed\n${result.stdout}\n${result.stderr}`);
    return { configDir, stdout: result.stdout, stderr: result.stderr };
  }

  function hostReadFiles(root) {
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (!rel.endsWith('.md') || rel.endsWith('CHANGELOG.md')) continue;
        if (rel.startsWith('gsd-core/commands/') || rel.startsWith('gsd-core/agents/')) continue;
        out.push(rel);
      }
    };
    walk(root);
    return out;
  }

  test('opencode install has no Claude-only residue', (t) => {
    const { configDir, stdout, stderr } = install(t, '--opencode');
    const files = hostReadFiles(configDir);
    assert.ok(files.length > 50, `expected installed markdown, saw ${files.length}`);
    const residue = [];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(configDir, rel), 'utf8');
      if (text.includes(HINT_OLD) || /(^|[^A-Za-z0-9_-])\.claude\/skills\//.test(text)
        || /@(~|\$HOME)\/\.claude\b/.test(text)) residue.push(rel);
    }
    assert.deepEqual(residue, []);
    assert.doesNotMatch(`${stdout}\n${stderr}`, /unreplaced \.claude/);
  });

  test('claude install keeps its own hint', (t) => {
    const { configDir } = install(t, '--claude');
    const launcher = fs.readdirSync(path.join(configDir, 'gsd-core', 'workflows'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => fs.readFileSync(path.join(configDir, 'gsd-core', 'workflows', name), 'utf8'))
      .some((text) => text.includes(HINT_OLD));
    assert.equal(launcher, true);
  });
});
