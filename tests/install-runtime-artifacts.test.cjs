// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Installer Module — Sections 6–8 + 12.
 *
 * Covers: installRuntimeArtifacts parameterised layout loop,
 * uninstallRuntimeArtifacts all runtimes, Contract 6 counter-test
 * (unknown runtime rejected), and legacy migration tests.
 *
 * Consolidates (original sources from #3758):
 *   install-uninstall-layout-loop.test.cjs
 *
 * Closes #3758
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  installRuntimeArtifacts,
  installOpencodeFamilySkills,
  parseRuntimeInput,
  allRuntimes,
} = require('../bin/install.js');

const {
  resolveRuntimeArtifactLayout,
} = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');

const {
  loadSkillsManifest,
  resolveProfile,
} = require('../gsd-core/bin/lib/install-profiles.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const MANIFEST = loadSkillsManifest(REAL_COMMANDS_DIR);
const RESOLVED_CORE = resolveProfile({ modes: ['core'], manifest: MANIFEST });

// ─── Section 6: installRuntimeArtifacts — parameterised layout loop ──────────

const SKILLS_RUNTIMES_LAYOUT = [
  'claude', 'cursor', 'codex', 'copilot', 'antigravity',
  'windsurf', 'augment', 'trae', 'qwen', 'kimi', 'codebuddy',
];

const ALL_RUNTIMES_LAYOUT = [
  'claude', 'cursor', 'gemini', 'codex', 'copilot', 'antigravity',
  'windsurf', 'augment', 'trae', 'qwen', 'hermes', 'codebuddy',
  'cline', 'kimi', 'opencode', 'kilo',
];

function countPrefixedEntries(destDir, prefix) {
  if (!fs.existsSync(destDir)) return 0;
  return fs.readdirSync(destDir).filter(n => n.startsWith(prefix)).length;
}

function writeSkillEntry(destDir, prefix, stem) {
  const entryDir = path.join(destDir, `${prefix}${stem}`);
  fs.mkdirSync(entryDir, { recursive: true });
  fs.writeFileSync(path.join(entryDir, 'SKILL.md'), `# ${stem}\n`);
}

function writeCommandEntry(destDir, prefix, stem) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, `${prefix}${stem}.md`), `# ${stem}\n`);
}

function readAllSkillMd(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return '';
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.name === 'SKILL.md') out.push(fs.readFileSync(p, 'utf8'));
    }
  }
  return out.join('\n');
}

describe('installRuntimeArtifacts — skills runtimes write gsd-prefixed skill dirs', () => {
  for (const runtime of SKILLS_RUNTIMES_LAYOUT) {
    test(`${runtime}: gsd-prefixed skill dirs in skills/`, (t) => {
      const configDir = createTempDir(`gsd-ial-${runtime}-`);
      t.after(() => cleanup(configDir));

      assert.strictEqual(typeof installRuntimeArtifacts, 'function');
      installRuntimeArtifacts(runtime, configDir, 'global', RESOLVED_CORE);

      const layout = resolveRuntimeArtifactLayout(runtime, configDir, 'global');
      const skillsKind = layout.kinds.find(k => k.kind === 'skills');
      assert.ok(skillsKind, `${runtime} must have skills kind`);

      const destDir = path.join(configDir, skillsKind.destSubpath);
      assert.ok(fs.existsSync(destDir));
      assert.ok(
        fs.existsSync(path.join(destDir, `${skillsKind.prefix}help`, 'SKILL.md')),
        `${runtime}: ${skillsKind.prefix}help/SKILL.md must exist`
      );

      if (runtime === 'kimi') {
        const newProjectSkill = path.join(destDir, 'gsd-new-project', 'SKILL.md');
        assert.ok(fs.existsSync(newProjectSkill), 'kimi: gsd-new-project/SKILL.md must exist');
        const content = fs.readFileSync(newProjectSkill, 'utf8');
        assert.match(content, /^name: gsd-new-project$/m);
        assert.match(content, /\/skill:gsd-new-project/);
        assert.doesNotMatch(content, /kimi_cli\.tools|system_prompt_path|^version: 1$/m);

        const agentsDir = path.join(configDir, 'agents');
        const rootYaml = path.join(agentsDir, 'gsd.yaml');
        const rootPrompt = path.join(agentsDir, 'gsd.md');
        const executorYaml = path.join(agentsDir, 'subagents', 'gsd-executor.yaml');
        const executorPrompt = path.join(agentsDir, 'subagents', 'gsd-executor.md');
        assert.ok(fs.existsSync(rootYaml), 'kimi: agents/gsd.yaml must exist');
        assert.ok(fs.existsSync(rootPrompt), 'kimi: agents/gsd.md must exist');
        assert.ok(fs.existsSync(executorYaml), 'kimi: agents/subagents/gsd-executor.yaml must exist');
        assert.ok(fs.existsSync(executorPrompt), 'kimi: agents/subagents/gsd-executor.md must exist');

        const rootYamlContent = fs.readFileSync(rootYaml, 'utf8');
        assert.match(rootYamlContent, /^version: 1$/m);
        assert.match(rootYamlContent, /^agent:$/m);
        assert.match(rootYamlContent, /extend: default/);
        assert.match(rootYamlContent, /system_prompt_path: \.\/gsd\.md/);
        assert.match(rootYamlContent, /tools:/);
        assert.match(rootYamlContent, /subagents:/);
        assert.match(rootYamlContent, /kimi_cli\.tools\./);
        assert.doesNotMatch(rootYamlContent, /mcp__/);

        const executorYamlContent = fs.readFileSync(executorYaml, 'utf8');
        assert.match(executorYamlContent, /system_prompt_path: \.\/gsd-executor\.md/);
        assert.match(executorYamlContent, /kimi_cli\.tools\./);
        assert.doesNotMatch(executorYamlContent, /mcp__/);
      }

      if (RESOLVED_CORE.skills !== '*') {
        const prefixedCount = countPrefixedEntries(destDir, skillsKind.prefix || 'gsd-');
        assert.strictEqual(prefixedCount, RESOLVED_CORE.skills.size,
          `${runtime}: installed skill count must match profile`);
      }
    });
  }
});

describe('installRuntimeArtifacts — hermes nested layout', () => {
  test('hermes: skills/gsd/gsd-<stem>/SKILL.md with gsd- prefix in name (#947)', (t) => {
    const configDir = createTempDir('gsd-ial-hermes-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_CORE);

    const nestedDir = path.join(configDir, 'skills', 'gsd');
    assert.ok(fs.existsSync(nestedDir));
    // #947: Hermes now uses canonical gsd- prefix — skills/gsd/gsd-<stem>/SKILL.md
    assert.ok(fs.existsSync(path.join(nestedDir, 'gsd-help', 'SKILL.md')),
      'skills/gsd/gsd-help/SKILL.md must exist (canonical gsd- prefix, #947)');
    assert.ok(!fs.existsSync(path.join(nestedDir, 'help')),
      'bare-stem skills/gsd/help/ must NOT exist (#947 fix)');
  });
});

describe('installRuntimeArtifacts — gemini commands layout', () => {
  test('gemini: commands/gsd/ created, no skills/', (t) => {
    const configDir = createTempDir('gsd-ial-gemini-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('gemini', configDir, 'global', RESOLVED_CORE);

    assert.ok(fs.existsSync(path.join(configDir, 'commands', 'gsd')));
    assert.ok(fs.existsSync(path.join(configDir, 'commands', 'gsd', 'help.md')));
    assert.ok(!fs.existsSync(path.join(configDir, 'skills')));
  });
});

describe('installRuntimeArtifacts — cursor commands layout (#785)', () => {
  test('cursor: skills/ AND commands/ both created; commands/gsd-help.md is plain markdown', (t) => {
    const configDir = createTempDir('gsd-ial-cursor-cmds-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('cursor', configDir, 'global', RESOLVED_CORE);

    // Existing skills kind still present
    const skillsDir = path.join(configDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills/ must exist');
    assert.ok(fs.existsSync(path.join(skillsDir, 'gsd-help', 'SKILL.md')),
      'skills/gsd-help/SKILL.md must exist');

    // New commands kind (#785)
    const commandsDir = path.join(configDir, 'commands');
    assert.ok(fs.existsSync(commandsDir), 'commands/ must exist (#785)');
    assert.ok(fs.existsSync(path.join(commandsDir, 'gsd-help.md')),
      'commands/gsd-help.md must exist (#785)');

    // Cursor commands are plain markdown — no YAML frontmatter
    const helpContent = fs.readFileSync(path.join(commandsDir, 'gsd-help.md'), 'utf8');
    assert.ok(!helpContent.startsWith('---'), 'cursor commands must not start with YAML frontmatter');
  });
});

describe('installRuntimeArtifacts — cline skills (#782)', () => {
  test('cline: global install writes gsd-prefixed skill dirs under skills/', (t) => {
    const configDir = createTempDir('gsd-ial-cline-');
    t.after(() => cleanup(configDir));

    assert.doesNotThrow(() => installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE));

    const skillsDir = path.join(configDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills/ must be created for global cline install');
    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-help', 'SKILL.md')),
      'gsd-help/SKILL.md must exist'
    );
  });
});

describe('installRuntimeArtifacts — opencode / kilo flat commands', () => {
  for (const runtime of ['opencode', 'kilo']) {
    test(`${runtime}: command/gsd-help.md exists`, (t) => {
      const configDir = createTempDir(`gsd-ial-${runtime}-`);
      t.after(() => cleanup(configDir));

      installRuntimeArtifacts(runtime, configDir, 'global', RESOLVED_CORE);

      const commandDir = path.join(configDir, 'command');
      assert.ok(fs.existsSync(commandDir));
      assert.ok(fs.existsSync(path.join(commandDir, 'gsd-help.md')));
    });
  }
});

// ─── #784: installOpencodeFamilySkills — skills + path rewrite + preservation ─

// Stage the raw command set the way the installer's _stageSkills() does, so the
// skills writer receives the same input as the flattened-command writer.
function stageRawCommands(runtime, configDir) {
  const layout = resolveRuntimeArtifactLayout(runtime, configDir, 'global');
  const commandsKind = layout.kinds.find((k) => k.kind === 'commands');
  return commandsKind.stage(RESOLVED_CORE);
}

describe('installOpencodeFamilySkills — emits skills/<name>/SKILL.md (#784)', () => {
  for (const runtime of ['opencode', 'kilo']) {
    test(`${runtime}: writes gsd-help/SKILL.md with name + description`, (t) => {
      const configDir = createTempDir(`gsd-ocs-${runtime}-`);
      t.after(() => cleanup(configDir));

      const raw = stageRawCommands(runtime, configDir);
      const count = installOpencodeFamilySkills(runtime, configDir, raw, `${configDir}/`);
      assert.ok(count >= 1, 'should report installed skills');

      const skillMd = path.join(configDir, 'skills', 'gsd-help', 'SKILL.md');
      assert.ok(fs.existsSync(skillMd), 'gsd-help/SKILL.md must exist');
      const content = fs.readFileSync(skillMd, 'utf8');
      assert.match(content, /^name: gsd-help$/m, 'name matches dir');
      assert.match(content, /^description: /m, 'description present');
      assert.ok(!/\/gsd:/.test(content), 'no /gsd: colon refs in body');
    });

    test(`${runtime}: rewrites body paths to the actual install target (#784 path fix)`, (t) => {
      const configDir = createTempDir(`gsd-ocp-${runtime}-`);
      t.after(() => cleanup(configDir));

      // Simulate a custom/local install: pathPrefix points at configDir, NOT the
      // runtime's default global config dir. Body refs must use pathPrefix.
      const pathPrefix = `${configDir}/`;
      installOpencodeFamilySkills(runtime, configDir, stageRawCommands(runtime, configDir), pathPrefix);

      const defaultBase = runtime === 'kilo' ? '.config/kilo' : '.config/opencode';
      const help = fs.readFileSync(path.join(configDir, 'skills', 'gsd-help', 'SKILL.md'), 'utf8');
      // gsd-help references gsd-core workflow files via @<configDir>/gsd-core/...
      assert.ok(
        help.includes(`${configDir}/gsd-core/`),
        'gsd-help body must reference the actual install target via pathPrefix',
      );
      for (const skillName of fs.readdirSync(path.join(configDir, 'skills'))) {
        const body = fs.readFileSync(path.join(configDir, 'skills', skillName, 'SKILL.md'), 'utf8');
        assert.ok(
          !body.includes(`~/${defaultBase}/`),
          `${skillName}: must not leak hardcoded ~/${defaultBase}/ — should use install target`,
        );
        // Regression guard for the prefix-overlap double-rewrite (e.g. kilo-alt-alt).
        assert.ok(
          !new RegExp(`${defaultBase.replace(/[\\.*+?^${}()|[\]]/g, '\\$&')}-[^/\\s]*-`).test(body),
          `${skillName}: must not contain a doubled config-dir suffix`,
        );
      }
    });

    test(`${runtime}: preserves user-owned gsd-dev-preferences across reinstall (#784)`, (t) => {
      const configDir = createTempDir(`gsd-ocd-${runtime}-`);
      t.after(() => cleanup(configDir));

      const userSkill = path.join(configDir, 'skills', 'gsd-dev-preferences');
      fs.mkdirSync(userSkill, { recursive: true });
      const marker = '---\nname: gsd-dev-preferences\ndescription: mine\n---\nKEEP ME\n';
      fs.writeFileSync(path.join(userSkill, 'SKILL.md'), marker);

      installOpencodeFamilySkills(runtime, configDir, stageRawCommands(runtime, configDir), `${configDir}/`);

      const after = fs.readFileSync(path.join(userSkill, 'SKILL.md'), 'utf8');
      assert.ok(after.includes('KEEP ME'), 'user-owned dev-preferences must survive reinstall');
      // GSD-managed skills should also be present.
      assert.ok(fs.existsSync(path.join(configDir, 'skills', 'gsd-help', 'SKILL.md')));
    });
  }
});

// ─── Section 7: uninstallRuntimeArtifacts — all runtimes ─────────────────────

describe('uninstallRuntimeArtifacts — removes gsd-owned entries, preserves foreign', () => {
  for (const runtime of ALL_RUNTIMES_LAYOUT) {
    test(`${runtime}: gsd entries removed, foreign preserved`, (t) => {
      const configDir = createTempDir(`gsd-ual-${runtime}-`);
      t.after(() => cleanup(configDir));

      const { uninstallRuntimeArtifacts } = require('../bin/install.js');
      assert.strictEqual(typeof uninstallRuntimeArtifacts, 'function');

      const layout = resolveRuntimeArtifactLayout(runtime, configDir, 'global');

      if (layout.kinds.length === 0) {
        const foreignDir = path.join(configDir, 'foreign-dir');
        fs.mkdirSync(foreignDir, { recursive: true });
        fs.writeFileSync(path.join(foreignDir, 'keep.md'), '# keep\n');
        assert.doesNotThrow(() => uninstallRuntimeArtifacts(runtime, configDir, 'global'));
        assert.ok(fs.existsSync(path.join(foreignDir, 'keep.md')));
        return;
      }

      if (runtime === 'hermes') {
        const kind = layout.kinds[0];
        const destDir = path.join(configDir, kind.destSubpath); // skills/gsd
        // Seed a gsd-* prefixed skill (canonical #947 layout) and a bare-stem skill (#3664 era)
        fs.mkdirSync(path.join(destDir, 'gsd-help'), { recursive: true });
        fs.writeFileSync(path.join(destDir, 'gsd-help', 'SKILL.md'), '# gsd-help\n');
        fs.mkdirSync(path.join(destDir, 'help'), { recursive: true });
        fs.writeFileSync(path.join(destDir, 'help', 'SKILL.md'), '# bare-stem help (#3664)\n');
        const siblingDir = path.join(configDir, 'skills', 'user-skill');
        fs.mkdirSync(siblingDir, { recursive: true });
        fs.writeFileSync(path.join(siblingDir, 'SKILL.md'), '# user\n');

        uninstallRuntimeArtifacts(runtime, configDir, 'global');

        // skills/gsd/ removed (gsd-* removed by _removeGsdEntries, bare-stem by legacy cleanup,
        // then DESCRIPTION.md removed, category dir removed as empty)
        assert.ok(!fs.existsSync(destDir), 'skills/gsd/ must be removed after uninstall');
        // User skill outside skills/gsd/ preserved
        assert.ok(fs.existsSync(path.join(siblingDir, 'SKILL.md')), 'user-skill must be preserved');
        return;
      }

      for (const kind of layout.kinds) {
        const destDir = path.join(configDir, kind.destSubpath);
        fs.mkdirSync(destDir, { recursive: true });
        if (kind.kind === 'skills') {
          writeSkillEntry(destDir, kind.prefix, 'help');
          writeSkillEntry(destDir, kind.prefix, 'phase');
          const foreignDir = path.join(destDir, 'user-custom-skill');
          fs.mkdirSync(foreignDir, { recursive: true });
          fs.writeFileSync(path.join(foreignDir, 'SKILL.md'), '# user\n');
        } else if (kind.kind === 'kimi-agents') {
          fs.mkdirSync(path.join(destDir, 'subagents'), { recursive: true });
          fs.writeFileSync(path.join(destDir, 'gsd.yaml'), 'version: 1\n');
          fs.writeFileSync(path.join(destDir, 'gsd.md'), '# gsd\n');
          fs.writeFileSync(path.join(destDir, 'subagents', 'gsd-executor.yaml'), 'version: 1\n');
          fs.writeFileSync(path.join(destDir, 'subagents', 'gsd-executor.md'), '# executor\n');
          fs.writeFileSync(path.join(destDir, 'user-agent.yaml'), 'version: 1\n');
          fs.writeFileSync(path.join(destDir, 'subagents', 'user-agent.yaml'), 'version: 1\n');
        } else {
          writeCommandEntry(destDir, kind.prefix, 'help');
          writeCommandEntry(destDir, kind.prefix, 'phase');
          fs.writeFileSync(path.join(destDir, 'user-custom.md'), '# user\n');
        }
      }

      uninstallRuntimeArtifacts(runtime, configDir, 'global');

      for (const kind of layout.kinds) {
        const destDir = path.join(configDir, kind.destSubpath);
        if (kind.kind === 'skills') {
          assert.ok(!fs.existsSync(path.join(destDir, `${kind.prefix}help`)));
          assert.ok(!fs.existsSync(path.join(destDir, `${kind.prefix}phase`)));
          assert.ok(fs.existsSync(path.join(destDir, 'user-custom-skill', 'SKILL.md')));
        } else if (kind.kind === 'kimi-agents') {
          assert.ok(!fs.existsSync(path.join(destDir, 'gsd.yaml')));
          assert.ok(!fs.existsSync(path.join(destDir, 'gsd.md')));
          assert.ok(!fs.existsSync(path.join(destDir, 'subagents', 'gsd-executor.yaml')));
          assert.ok(!fs.existsSync(path.join(destDir, 'subagents', 'gsd-executor.md')));
          assert.ok(fs.existsSync(path.join(destDir, 'user-agent.yaml')));
          assert.ok(fs.existsSync(path.join(destDir, 'subagents', 'user-agent.yaml')));
        } else {
          assert.ok(!fs.existsSync(path.join(destDir, `${kind.prefix}help.md`)));
          assert.ok(!fs.existsSync(path.join(destDir, `${kind.prefix}phase.md`)));
          assert.ok(fs.existsSync(path.join(destDir, 'user-custom.md')));
        }
      }
    });
  }
});

// ─── Section 8: Counter-test — unknown runtime is rejected (Contract 6) ──────

describe('Contract 6: unknown runtime is rejected', () => {
  test('resolveRuntimeArtifactLayout throws TypeError for unknown runtime', () => {
    assert.throws(
      () => resolveRuntimeArtifactLayout('unknown-runtime-xyz', '/tmp/test', 'global'),
      (err) => {
        assert.ok(err instanceof TypeError, 'must be TypeError');
        assert.ok(err.message.includes('Unknown runtime'), `message: ${err.message}`);
        return true;
      }
    );
  });

  test('parseRuntimeInput returns ["claude"] for unrecognised string (safe default)', () => {
    // parseRuntimeInput processes menu numbers, not runtime names directly;
    // an unrecognised token falls through to the default ["claude"].
    const result = parseRuntimeInput('unknown-xyz');
    assert.deepStrictEqual(result, ['claude']);
  });

  test('allRuntimes does not include any unrecognised value', () => {
    // Every entry in allRuntimes must be recognised by resolveRuntimeArtifactLayout
    for (const runtime of allRuntimes) {
      assert.doesNotThrow(
        () => resolveRuntimeArtifactLayout(runtime, '/tmp/test', 'global'),
        `${runtime} must be a recognised runtime`
      );
    }
  });
});

// ─── Section 12: Legacy migrations in installRuntimeArtifacts ────────────────

describe('installRuntimeArtifacts — legacy migrations run before layout copy', () => {
  test('claude: legacy commands/gsd/dev-preferences.md migrated AND new skills written', (t) => {
    const configDir = createTempDir('gsd-legacy-install-');
    t.after(() => cleanup(configDir));

    const legacyDir = path.join(configDir, 'commands', 'gsd');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'dev-preferences.md'), '# My dev prefs\n');

    installRuntimeArtifacts('claude', configDir, 'global', RESOLVED_CORE);

    assert.ok(!fs.existsSync(legacyDir));
    assert.ok(fs.existsSync(path.join(configDir, 'skills', 'gsd-dev-preferences', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(configDir, 'skills', 'gsd-help', 'SKILL.md')));
  });

  test('hermes: legacy flat skills/gsd-*/ migrated AND new nested skills/gsd/gsd-<stem>/ written (#947)', (t) => {
    const configDir = createTempDir('gsd-legacy-hermes-install-');
    t.after(() => cleanup(configDir));

    const legacyFlatHelp = path.join(configDir, 'skills', 'gsd-help');
    fs.mkdirSync(legacyFlatHelp, { recursive: true });
    fs.writeFileSync(path.join(legacyFlatHelp, 'SKILL.md'), '# legacy help\n');

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_CORE);

    assert.ok(!fs.existsSync(legacyFlatHelp), 'legacy flat skill must be removed');
    // #947: canonical path is skills/gsd/gsd-<stem>/ not skills/gsd/<stem>/
    assert.ok(fs.existsSync(path.join(configDir, 'skills', 'gsd', 'gsd-help', 'SKILL.md')),
      'skills/gsd/gsd-help/SKILL.md must exist after install (#947)');
  });
});

describe('uninstallRuntimeArtifacts — legacy cleanup runs before layout removal', () => {
  test('hermes: both flat and nested layouts removed (#947: bare-stem dirs cleaned on uninstall)', (t) => {
    const { uninstallRuntimeArtifacts } = require('../bin/install.js');
    const configDir = createTempDir('gsd-legacy-uninstall-hermes-');
    t.after(() => cleanup(configDir));

    const skillsDir = path.join(configDir, 'skills');
    const flatHelp = path.join(skillsDir, 'gsd-help');
    fs.mkdirSync(flatHelp, { recursive: true });
    fs.writeFileSync(path.join(flatHelp, 'SKILL.md'), '# legacy flat\n');

    const nestedGsd = path.join(skillsDir, 'gsd');
    // Seed a pre-#947 bare-stem GSD skill (no gsd- prefix, from #3664 era)
    fs.mkdirSync(path.join(nestedGsd, 'help'), { recursive: true });
    fs.writeFileSync(path.join(nestedGsd, 'help', 'SKILL.md'), '# nested help (bare-stem)\n');

    const userSkill = path.join(skillsDir, 'user-skill');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '# user\n');

    uninstallRuntimeArtifacts('hermes', configDir, 'global');

    // Pre-#2841 flat skills/gsd-help/ removed by legacy cleanup
    assert.ok(!fs.existsSync(flatHelp), 'flat gsd-help must be removed');
    // skills/gsd/ removed: bare-stem dirs cleaned + no gsd-* dirs remain → empty → removed
    assert.ok(!fs.existsSync(nestedGsd), 'skills/gsd/ must be removed after uninstall');
    // User content outside skills/gsd/ preserved
    assert.ok(fs.existsSync(path.join(userSkill, 'SKILL.md')), 'user-skill must be preserved');
  });

  test('claude: legacy commands/gsd/ cleaned AND new skills/ entries removed', (t) => {
    const { uninstallRuntimeArtifacts } = require('../bin/install.js');
    const configDir = createTempDir('gsd-legacy-uninstall-claude-');
    t.after(() => cleanup(configDir));

    const skillsDir = path.join(configDir, 'skills');
    const gsdHelp = path.join(skillsDir, 'gsd-help');
    fs.mkdirSync(gsdHelp, { recursive: true });
    fs.writeFileSync(path.join(gsdHelp, 'SKILL.md'), '# help\n');

    const legacyDir = path.join(configDir, 'commands', 'gsd');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'help.md'), '# legacy\n');

    const userSkill = path.join(skillsDir, 'user-skill');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '# user\n');

    uninstallRuntimeArtifacts('claude', configDir, 'global');

    assert.ok(!fs.existsSync(gsdHelp));
    assert.ok(!fs.existsSync(legacyDir));
    assert.ok(fs.existsSync(path.join(userSkill, 'SKILL.md')));
  });
});

describe('skills wrapper threads install scope into converter isGlobal (regression: local installs must not leak global home paths)', () => {
  // Bug: the skills wrapper in runtime-artifact-layout passed `runtime` (a truthy
  // string) as the converter's 3rd positional arg. For antigravity/copilot that
  // param was `isGlobal`, so LOCAL installs always took the GLOBAL path branch and
  // leaked ~/.gemini/antigravity or ~/.copilot instead of the workspace path.
  for (const { runtime, globalMarker, localMarker } of [
    { runtime: 'antigravity', globalMarker: '~/.gemini/antigravity', localMarker: '.agents' },
    { runtime: 'copilot', globalMarker: '~/.copilot', localMarker: '.github' },
  ]) {
    test(`${runtime}: local skill content uses workspace path, not global home`, (t) => {
      const globalDir = createTempDir(`gsd-ial-g-${runtime}-`);
      const localDir = createTempDir(`gsd-ial-l-${runtime}-`);
      t.after(() => { cleanup(globalDir); cleanup(localDir); });

      installRuntimeArtifacts(runtime, globalDir, 'global', RESOLVED_CORE);
      installRuntimeArtifacts(runtime, localDir, 'local', RESOLVED_CORE);

      const gSkills = resolveRuntimeArtifactLayout(runtime, globalDir, 'global').kinds.find(k => k.kind === 'skills');
      const lSkills = resolveRuntimeArtifactLayout(runtime, localDir, 'local').kinds.find(k => k.kind === 'skills');
      assert.ok(gSkills && lSkills, `${runtime}: must resolve a skills kind for both scopes`);

      const gCombined = readAllSkillMd(path.join(globalDir, gSkills.destSubpath));
      const lCombined = readAllSkillMd(path.join(localDir, lSkills.destSubpath));

      // Precondition (non-vacuity guard): some core skill carries a ~/.claude
      // reference, so the GLOBAL install surfaces the global home marker. If this
      // assertion ever fails, the source skills lost their path references — fix
      // the fixture/source, do not delete this test.
      assert.ok(gCombined.includes(globalMarker),
        `${runtime}: precondition — global install should contain '${globalMarker}'`);

      // The actual regression: a LOCAL install must NOT leak the global home path…
      assert.ok(!lCombined.includes(globalMarker),
        `${runtime}: local install must NOT leak global home path '${globalMarker}'`);
      // …and SHOULD reference the workspace-relative path.
      assert.ok(lCombined.includes(localMarker),
        `${runtime}: local install must reference workspace path '${localMarker}'`);
    });
  }
});
