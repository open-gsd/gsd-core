'use strict';

/**
 * #4779 — the OpenCode install rewrites the Claude-only forms that survive the path rewrite:
 * the project-skills locator (`.claude/skills/`) and the launcher's reinstall hint
 * (`--claude --local`), and the post-install leak scan reports the same forms on OpenCode.
 * Seams: the shared helper, both OpenCode converters (bin mirror and compiled module), the extracted
 * leak scan, the OpenCode corpus rewrite, and a real install tree. The installed corpus under
 * gsd-core/commands|agents/ is converted for OpenCode (path text only) and scanned; on runtimes that
 * keep it byte-identical (#5547) it is still skipped.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { installRuntimeFixture, INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
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

describe('#4779: the OpenCode corpus rewrite', () => {
  const PREFIXES = ['~/.config/opencode/', '/custom/cfg/', '$HOME/.config/opencode/'];
  const KINDS = ['commands', 'agents'];
  const include = '@~/.claude/gsd-core/references/project-skills-discovery.md';
  const corpusText = (content, kind, pathPrefix) =>
    conversion.rewriteOpencodeCorpusText(content, { runtime: 'opencode', pathPrefix, kind });
  // What the real install does to the same source text, per kind (prefix pass, then the converter).
  const installed = (content, kind, pathPrefix) => viaModule(
    kind === 'agents'
      ? conversion.applyAgentPathRewrites(content, 'opencode', pathPrefix)
      : conversion._rewriteOpencodeFamilyConfigDirForms(content, pathPrefix, '.opencode'),
  );

  for (const kind of KINDS) {
    test(`${kind}: rewrites an @-include, the home forms, the locator and the hint`, () => {
      const out = corpusText(
        `${include}\nsee $HOME/.claude/gsd-core/x and \`${LOC_OLD}\`\nnpx @opengsd/gsd-core@latest ${HINT_OLD}\n`,
        kind,
        '~/.config/opencode/',
      );
      assert.equal(
        out,
        `@~/.config/opencode/gsd-core/references/project-skills-discovery.md\nsee $HOME/.config/opencode/gsd-core/x and \`${LOC_NEW}\`\nnpx @opengsd/gsd-core@latest ${HINT_NEW}\n`,
      );
    });

    test(`${kind}: honors a custom config dir prefix, bare home form included`, () => {
      const out = corpusText(`${include}\nset -- "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"\n`, kind, '/custom/cfg/');
      assert.ok(out.startsWith('@/custom/cfg/gsd-core/references/project-skills-discovery.md\n'), out);
      assert.equal(out.includes('~/.claude') || out.includes('$HOME/.claude'), false, out);
      // The refresh seam: the custom dir the install chose survives a second conversion.
      assert.equal(installed(out, kind, '/custom/cfg/'), installed(`${include}\nset -- "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"\n`, kind, '/custom/cfg/'));
    });

    test(`${kind}: leaves tool names, slash spellings and frontmatter in source form`, () => {
      const source = '---\nname: gsd-x\ntools: Read, AskUserQuestion\n---\nRun /gsd:plan-phase then AskUserQuestion\n';
      assert.equal(corpusText(source, kind, '~/.config/opencode/'), source);
    });
  }

  test('property: converting the rewritten corpus equals converting the original', () => {
    const tokens = [
      include, '~/.claude/gsd-core/x', '$HOME/.claude/gsd-core/y', '${CLAUDE_CONFIG_DIR:-$HOME/.claude}',
      '${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin', LOC_OLD, `./${LOC_OLD}`, HINT_OLD, '--claude --global',
      'my.claude/skills/', 'AskUserQuestion', '/gsd:next', 'prose', '\n', ' ',
    ];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...tokens), { maxLength: 20 }),
        fc.constantFrom(...PREFIXES),
        fc.constantFrom(...KINDS),
        (parts, prefix, kind) => {
          const original = parts.join(' ');
          const corpus = corpusText(original, kind, prefix);
          assert.equal(installed(corpus, kind, prefix), installed(original, kind, prefix));
          assert.equal(corpusText(corpus, kind, prefix), corpus);
          assert.equal(/(~|\$HOME)\/\.claude\b/.test(corpus), false);
          return true;
        },
      ),
      { seed: 4779, numRuns: 300 },
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

  test('applies the same boundaries as the rewrite on opencode', (t) => {
    const dir = tree({ 'agents/a.md': 'my.claude/skills/ and --claude --local-foo and x--claude --local\n' });
    t.after(() => cleanup(dir));
    assert.deepEqual(scan(dir, 'opencode', ['agents/a.md']), []);
  });

  test('ignores the new patterns on codex and kilo', (t) => {
    const dir = tree({ 'agents/a.md': `${LOC_OLD} ${HINT_OLD}\n` });
    t.after(() => cleanup(dir));
    assert.deepEqual(scan(dir, 'codex', ['agents/a.md']), []);
    assert.deepEqual(scan(dir, 'kilo', ['agents/a.md']), []);
  });

  test('ignores the new patterns on claude', (t) => {
    const dir = tree({ 'agents/a.md': `${LOC_OLD} ${HINT_OLD}\n` });
    t.after(() => cleanup(dir));
    assert.deepEqual(scan(dir, 'claude', ['agents/a.md']), []);
  });

  test('skips the byte-identical corpus on a runtime that keeps it unconverted', (t) => {
    const dir = tree({
      'gsd-core/commands/x.md': `${LOC_OLD} ~/.claude\n`,
      'gsd-core/agents/y.md': `${HINT_OLD}\n`,
    });
    t.after(() => cleanup(dir));
    assert.deepEqual(scan(dir, 'claude', ['gsd-core/commands/x.md', 'gsd-core/agents/y.md']), []);
  });

  test('scans the corpus on opencode, which converts it', (t) => {
    const dir = tree({
      'gsd-core/commands/x.md': `${LOC_OLD} ~/.claude\n`,
      'gsd-core/agents/y.md': `${HINT_OLD}\n`,
    });
    t.after(() => cleanup(dir));
    assert.deepEqual(scan(dir, 'opencode', ['gsd-core/commands/x.md', 'gsd-core/agents/y.md']), [
      { file: 'gsd-core/commands/x.md', count: 2 },
      { file: 'gsd-core/agents/y.md', count: 1 },
    ]);
  });

  test('skips CHANGELOG and missing files', (t) => {
    const dir = tree({ 'CHANGELOG.md': `${LOC_OLD} ${HINT_OLD} ~/.claude\n` });
    t.after(() => cleanup(dir));
    assert.deepEqual(scan(dir, 'opencode', ['CHANGELOG.md', 'agents/missing.md']), []);
  });
});

describe('#4779: installed trees', () => {
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

  test('opencode install has no Claude-only residue', () => {
    const { configDir } = installRuntimeFixture({ runtime: 'opencode', scope: 'global' });
    const files = hostReadFiles(configDir);
    assert.ok(files.length > 50, `expected installed markdown, saw ${files.length}`);
    // The compact variants (workflow.compact_content) are installed text too; the walk must reach them.
    assert.ok(files.some((rel) => rel.endsWith('.compact.md')), 'expected installed .compact.md variants');
    const residue = [];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(configDir, rel), 'utf8');
      if (text.includes(HINT_OLD) || /(^|[^A-Za-z0-9_-])\.claude\/skills\//.test(text)
        || /@(~|\$HOME)\/\.claude\b/.test(text)) residue.push(rel);
    }
    assert.deepEqual(residue, []);
    // The installer's own scan, run over the installed manifest, agrees: nothing left to report.
    const manifest = JSON.parse(fs.readFileSync(path.join(configDir, 'gsd-file-manifest.json'), 'utf8'));
    assert.deepEqual(
      installer.collectInstalledClaudeLeaks({
        targetDir: configDir,
        manifestFiles: Object.keys(manifest.files),
        runtime: 'opencode',
      }),
      [],
    );
  });

  test('opencode install converts its corpus path text and keeps the corpus a valid source', () => {
    const { configDir } = installRuntimeFixture({ runtime: 'opencode', scope: 'global' });
    const corpus = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md')) corpus.push(full);
      }
    };
    walk(path.join(configDir, 'gsd-core', 'commands', 'gsd'));
    walk(path.join(configDir, 'gsd-core', 'agents'));
    assert.ok(corpus.length > 100, `expected the installed corpus, saw ${corpus.length}`);
    const residue = corpus.filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return text.includes(HINT_OLD) || /(^|[^A-Za-z0-9_-])\.claude\/skills\//.test(text)
        || /(~|\$HOME)\/\.claude\b/.test(text);
    });
    assert.deepEqual(residue, []);
    // Tool names stay in source form so a refresh still converts the corpus.
    const mapper = fs.readFileSync(path.join(configDir, 'gsd-core', 'agents', 'gsd-pattern-mapper.md'), 'utf8');
    assert.match(mapper, /^tools: Read, Bash, Glob, Grep, Write$/m);
  });

  // A configuration no shared fixture covers: a config dir that is NOT the runtime's own global home
  // (the fixtures install there). The installer runs twice into it, the second over the first.
  test('a custom --config-dir survives a reinstall: corpus and converted artifacts are stable', (t) => {
    const home = createTempDir('gsd-4779-custom-');
    t.after(() => cleanup(home));
    const configDir = path.join(home, 'custom-opencode-home');
    const run = () => {
      const result = runNode([INSTALL_SCRIPT, '--opencode', '--global', '--config-dir', configDir], {
        env: installerEnv(isolatedEnv({ home, path: process.env.PATH })),
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      assert.strictEqual(result.exitCode, 0, `installer failed\n${result.stdout}\n${result.stderr}`);
    };
    const snapshot = () => {
      const out = new Map();
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.md')) out.set(path.relative(configDir, full), fs.readFileSync(full, 'utf8'));
        }
      };
      for (const sub of ['agents', path.join('gsd-core', 'agents'), path.join('gsd-core', 'commands', 'gsd')]) {
        walk(path.join(configDir, sub));
      }
      return out;
    };
    run();
    const first = snapshot();
    const corpusRel = path.join('gsd-core', 'agents', 'gsd-pattern-mapper.md');
    const include = /^\*\*Project skills:\*\* @(\S+)$/m.exec(first.get(corpusRel));
    assert.ok(include, 'expected the corpus @-include line');
    assert.ok(include[1].includes('custom-opencode-home'), include[1]);
    assert.ok(include[1].endsWith('/gsd-core/references/project-skills-discovery.md'), include[1]);
    run();
    const second = snapshot();
    assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort());
    const drifted = [...first.keys()].filter((rel) => first.get(rel) !== second.get(rel));
    assert.deepEqual(drifted, []);
  });

  test('claude install keeps its own hint', () => {
    const { configDir } = installRuntimeFixture({ runtime: 'claude', scope: 'global' });
    const keepsHint = fs.readdirSync(path.join(configDir, 'gsd-core', 'workflows'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => fs.readFileSync(path.join(configDir, 'gsd-core', 'workflows', name), 'utf8'))
      .some((text) => text.includes(HINT_OLD));
    assert.equal(keepsHint, true);
  });
});
