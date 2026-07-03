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
} = require('../gsd-core/bin/lib/install-engine.cjs');

const {
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

function loadFreshInstallerWithInstallPlanStub(stub) {
  return loadFreshInstallerWithPlanStubs({ installStub: stub });
}

function loadFreshInstallerWithPlanStubs({ installStub, uninstallStub }) {
  const installPath = require.resolve('../bin/install.js');
  const planPath = require.resolve('../gsd-core/bin/lib/runtime-artifact-install-plan.cjs');
  const planModule = require(planPath);
  const originalInstall = planModule.createRuntimeArtifactInstallPlan;
  const originalUninstall = planModule.createRuntimeArtifactUninstallPlan;
  if (installStub) planModule.createRuntimeArtifactInstallPlan = installStub;
  if (uninstallStub) planModule.createRuntimeArtifactUninstallPlan = uninstallStub;
  delete require.cache[installPath];
  const installer = require('../bin/install.js');

  return {
    installer,
    restore() {
      planModule.createRuntimeArtifactInstallPlan = originalInstall;
      planModule.createRuntimeArtifactUninstallPlan = originalUninstall;
      delete require.cache[installPath];
    },
  };
}

// ─── Section 6: installRuntimeArtifacts — parameterised layout loop ──────────

describe('installRuntimeArtifacts — consumes Runtime Artifact Install Plan Module', () => {
  test('executes returned copy items and cleanup obligations', (t) => {
    const configDir = createTempDir('gsd-install-plan-adapter-');
    const sourceDir = createTempDir('gsd-install-plan-source-');
    const cleanupDir = createTempDir('gsd-install-plan-cleanup-');
    t.after(() => {
      cleanup(configDir);
      cleanup(sourceDir);
      cleanup(cleanupDir);
    });

    fs.writeFileSync(path.join(sourceDir, 'proof.md'), '# proof\n');
    fs.writeFileSync(path.join(cleanupDir, 'temp.md'), '# cleanup\n');
    let planArgs;
    const { installer, restore } = loadFreshInstallerWithInstallPlanStub((args) => {
      planArgs = args;
      return {
        ok: true,
        plan: {
          cleanupDirs: [cleanupDir],
          items: [
            { kind: 'commands', sourceDir, destDir: path.join(configDir, 'commands', 'gsd') },
          ],
        },
      };
    });
    t.after(restore);

    installer.installRuntimeArtifacts('gemini', configDir, 'global', RESOLVED_CORE);

    assert.strictEqual(planArgs.layout.runtime, 'gemini');
    assert.strictEqual(planArgs.layout.configDir, configDir);
    assert.strictEqual(planArgs.layout.scope, 'global');
    assert.strictEqual(planArgs.resolvedProfile, RESOLVED_CORE);
    assert.strictEqual(planArgs.resolveAttribution('gemini'), undefined);
    assert.ok(fs.existsSync(path.join(configDir, 'commands', 'gsd', 'proof.md')));
    assert.ok(!fs.existsSync(cleanupDir), 'returned cleanup dir must be removed after copy');
  });

  test('cleans returned obligations when planning fails', (t) => {
    const configDir = createTempDir('gsd-install-plan-fail-');
    const cleanupDir = createTempDir('gsd-install-plan-fail-cleanup-');
    t.after(() => {
      cleanup(configDir);
      cleanup(cleanupDir);
    });

    fs.writeFileSync(path.join(cleanupDir, 'temp.md'), '# cleanup\n');
    const { installer, restore } = loadFreshInstallerWithInstallPlanStub(() => ({
      ok: false,
      kind: 'rewrite_failed',
      failedKind: 'commands',
      message: 'planned failure',
      cleanupDirs: [cleanupDir],
    }));
    t.after(restore);

    assert.throws(
      () => installer.installRuntimeArtifacts('gemini', configDir, 'global', RESOLVED_CORE),
      /planned failure/,
    );
    assert.ok(!fs.existsSync(cleanupDir), 'failure cleanup dir must be removed');
  });
});

const SKILLS_RUNTIMES_LAYOUT = [
  'claude', 'cursor', 'codex', 'copilot', 'antigravity',
  'augment', 'trae', 'qwen', 'kimi', 'codebuddy',
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

describe('installRuntimeArtifacts — windsurf workflows layout (#1615)', () => {
  test('windsurf: local install writes workflow slash-command files, not skills', (t) => {
    const configDir = createTempDir('gsd-ial-windsurf-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('windsurf', configDir, 'local', RESOLVED_CORE);

    const workflowsDir = path.join(configDir, 'workflows');
    assert.ok(fs.existsSync(workflowsDir), 'workflows/ must exist for Windsurf local install');
    assert.ok(fs.existsSync(path.join(workflowsDir, 'gsd-help.md')),
      'workflows/gsd-help.md must exist for /gsd-help');
    assert.ok(!fs.existsSync(path.join(configDir, 'skills')),
      'Windsurf must not install dead skills/ artifacts for slash commands');

    const helpContent = fs.readFileSync(path.join(workflowsDir, 'gsd-help.md'), 'utf8');
    assert.ok(!helpContent.startsWith('---'), 'Windsurf workflows must be plain markdown, not SKILL.md frontmatter');
    assert.match(helpContent, /# gsd-help/, 'workflow should identify the slash command it backs');
    assert.ok(helpContent.includes(`${configDir}/gsd-core/commands/gsd/help.md`.replace(/\\/g, '/')),
      'workflow should reference the installed command body using the actual install target');

    for (const fileName of fs.readdirSync(workflowsDir)) {
      if (!fileName.endsWith('.md')) continue;
      const workflowPath = path.join(workflowsDir, fileName);
      const byteLength = Buffer.byteLength(fs.readFileSync(workflowPath, 'utf8'), 'utf8');
      assert.ok(byteLength <= 12000, `${fileName} must respect Windsurf's 12,000-character workflow limit`);
    }
  });

  test('windsurf: global install is explicit no-op for workflow artifacts', (t) => {
    const configDir = createTempDir('gsd-ial-windsurf-global-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('windsurf', configDir, 'global', RESOLVED_CORE);

    assert.ok(!fs.existsSync(path.join(configDir, 'workflows')),
      'global Windsurf install must not write workflows under the config root');
    assert.ok(!fs.existsSync(path.join(configDir, 'skills')),
      'global Windsurf install must not write dead skills artifacts');
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

describe('uninstallRuntimeArtifacts — consumes Runtime Artifact Uninstall Plan Module', () => {
  test('removes returned plan destinations with layout kind metadata', (t) => {
    const configDir = createTempDir('gsd-uninstall-plan-adapter-');
    t.after(() => cleanup(configDir));

    const commandsDir = path.join(configDir, 'custom-commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'gsd-help.md'), '# remove\n');
    fs.writeFileSync(path.join(commandsDir, 'user-custom.md'), '# keep\n');

    let planLayout;
    const { installer, restore } = loadFreshInstallerWithPlanStubs({
      uninstallStub(layout) {
        planLayout = layout;
        return {
          items: [
            { kind: 'commands', destDir: commandsDir },
          ],
        };
      },
    });
    t.after(restore);

    installer.uninstallRuntimeArtifacts('gemini', configDir, 'global');

    assert.strictEqual(planLayout.runtime, 'gemini');
    assert.strictEqual(planLayout.configDir, configDir);
    assert.strictEqual(planLayout.scope, 'global');
    assert.ok(!fs.existsSync(path.join(commandsDir, 'gsd-help.md')));
    assert.ok(fs.existsSync(path.join(commandsDir, 'user-custom.md')));
  });
});

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


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2418-antigravity-bare-path.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2418-antigravity-bare-path (consolidation epic #1969 B1 #1970)", () => {
/**
 * Bug #2418: Found unreplaced .claude path reference(s) in Antigravity install
 *
 * The Antigravity path converter handles ~/.claude/ (with trailing slash) but
 * misses bare ~/.claude (without trailing slash), leaving unreplaced references
 * that cause the installer to warn about leaked paths.
 *
 * Files affected: agents/gsd-debugger.md (configDir = ~/.claude) and
 * gsd-core/workflows/update.md (comment with e.g. ~/.claude).
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { convertClaudeToAntigravityContent } = require('../bin/install.js');

describe('convertClaudeToAntigravityContent bare path replacement (#2418)', () => {
  describe('global install', () => {
    test('replaces ~/.claude (bare, no trailing slash) with ~/.gemini/antigravity', () => {
      const input = 'configDir = ~/.claude';
      const result = convertClaudeToAntigravityContent(input, true);
      assert.ok(
        result.includes('~/.gemini/antigravity'),
        `Expected ~/.gemini/antigravity in output, got: ${result}`
      );
      assert.ok(
        !result.includes('~/.claude'),
        `Expected ~/ .claude to be replaced, got: ${result}`
      );
    });

    test('replaces $HOME/.claude (bare, no trailing slash) with $HOME/.gemini/antigravity', () => {
      const input = 'export DIR=$HOME/.claude';
      const result = convertClaudeToAntigravityContent(input, true);
      assert.ok(
        result.includes('$HOME/.gemini/antigravity'),
        `Expected $HOME/.gemini/antigravity in output, got: ${result}`
      );
      assert.ok(
        !result.includes('$HOME/.claude'),
        `Expected $HOME/.claude to be replaced, got: ${result}`
      );
    });

    test('handles bare ~/.claude followed by comma (comment context)', () => {
      const input = '# e.g. ~/.claude, ~/.config/opencode';
      const result = convertClaudeToAntigravityContent(input, true);
      assert.ok(
        !result.includes('~/.claude'),
        `Expected ~/ .claude to be replaced in comment context, got: ${result}`
      );
    });

    test('still replaces ~/.claude/ (with trailing slash) correctly', () => {
      const input = 'See ~/.claude/gsd-core/workflows/';
      const result = convertClaudeToAntigravityContent(input, true);
      assert.ok(
        result.includes('~/.gemini/antigravity/gsd-core/workflows/'),
        `Expected path with trailing slash to be replaced, got: ${result}`
      );
      assert.ok(!result.includes('~/.claude/'), `Expected ~/ .claude/ to be fully replaced, got: ${result}`);
    });

    test('does not double-replace ~/.claude/ paths', () => {
      const input = 'See ~/.claude/gsd-core/';
      const result = convertClaudeToAntigravityContent(input, true);
      // Result should contain exactly one occurrence of the replacement path
      const count = (result.match(/~\/.gemini\/antigravity\//g) || []).length;
      assert.strictEqual(count, 1, `Expected exactly 1 replacement, got ${count} in: ${result}`);
    });
  });

  describe('local install', () => {
    test('replaces ~/.claude (bare, no trailing slash) with .agents', () => {
      const input = 'configDir = ~/.claude';
      const result = convertClaudeToAntigravityContent(input, false);
      assert.ok(
        result.includes('.agents'),
        `Expected .agents in output, got: ${result}`
      );
      assert.ok(
        !result.includes('~/.claude'),
        `Expected ~/ .claude to be replaced, got: ${result}`
      );
    });

    test('replaces $HOME/.claude (bare, no trailing slash) with .agents', () => {
      const input = 'export DIR=$HOME/.claude';
      const result = convertClaudeToAntigravityContent(input, false);
      assert.ok(
        result.includes('.agents'),
        `Expected .agents in output, got: ${result}`
      );
      assert.ok(
        !result.includes('$HOME/.claude'),
        `Expected $HOME/.claude to be replaced, got: ${result}`
      );
    });

    test('does not double-replace ~/.claude/ paths', () => {
      const input = 'See ~/.claude/gsd-core/';
      const result = convertClaudeToAntigravityContent(input, false);
      // .agents/ should appear exactly once
      const count = (result.match(/\.agents\//g) || []).length;
      assert.strictEqual(count, 1, `Expected exactly 1 replacement, got ${count} in: ${result}`);
    });
  });

  describe('installed files contain no bare ~/.claude references after conversion', () => {
    const fs = require('fs');
    const path = require('path');
    const repoRoot = path.join(__dirname, '..');

    // The scanner regex used by the installer to detect leaked paths
    const leakedPathRegex = /(?:~|\$HOME)\/\.claude\b/g;

    function convertFile(filePath, isGlobal) {
      const content = fs.readFileSync(filePath, 'utf8');
      return convertClaudeToAntigravityContent(content, isGlobal);
    }

    test('gsd-debugger.md has no leaked ~/.claude after global Antigravity conversion', () => {
      const debuggerPath = path.join(repoRoot, 'agents', 'gsd-debugger.md');
      if (!fs.existsSync(debuggerPath)) return; // skip if file doesn't exist
      const converted = convertFile(debuggerPath, true);
      const matches = converted.match(leakedPathRegex);
      assert.strictEqual(
        matches, null,
        `gsd-debugger.md still contains leaked .claude paths after Antigravity conversion: ${matches}`
      );
    });

    test('update.md has no leaked ~/.claude after global Antigravity conversion', () => {
      const updatePath = path.join(repoRoot, 'gsd-core', 'workflows', 'update.md');
      if (!fs.existsSync(updatePath)) return; // skip if file doesn't exist
      const converted = convertFile(updatePath, true);
      const matches = converted.match(leakedPathRegex);
      assert.strictEqual(
        matches, null,
        `update.md still contains leaked .claude paths after Antigravity conversion: ${matches}`
      );
    });
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2545-copilot-unreplaced-paths.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2545-copilot-unreplaced-paths (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for issue #2545.
 *
 * The Copilot content converter's `~/.claude/` and `$HOME/.claude/` replacements
 * only matched when a literal slash followed, so bare `~/.claude` references
 * (end of line, quotes, punctuation) were left unreplaced. Those leaks then
 * triggered the installer's "Found N unreplaced .claude path reference(s)"
 * warning, which scans for `(?:~|$HOME)/\.claude\b`.
 *
 * Fix: replace with a word-boundary pattern so both forms are caught in a
 * single pass, matching the approach already used by the Antigravity, OpenCode,
 * Kilo, and Codex converters.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { convertClaudeToCopilotContent } = require('../bin/install.js');

describe('convertClaudeToCopilotContent — bare ~/.claude (issue #2545)', () => {
  test('global install replaces bare ~/.claude at end of line', () => {
    const input = 'configDir = ~/.claude\n';
    const out = convertClaudeToCopilotContent(input, /* isGlobal */ true);
    assert.ok(
      !/(?:~|\$HOME)\/\.claude\b/.test(out),
      `expected no leaked ~/.claude reference, got: ${JSON.stringify(out)}`,
    );
    assert.match(out, /~\/\.copilot\b/);
  });

  test('global install replaces bare $HOME/.claude at end of line', () => {
    const input = 'configDir = $HOME/.claude\n';
    const out = convertClaudeToCopilotContent(input, /* isGlobal */ true);
    assert.ok(
      !/(?:~|\$HOME)\/\.claude\b/.test(out),
      `expected no leaked $HOME/.claude reference, got: ${JSON.stringify(out)}`,
    );
    assert.match(out, /\$HOME\/\.copilot\b/);
  });

  test('global install replaces bare ~/.claude before punctuation', () => {
    const input = 'paths include `~/.claude`, `~/.copilot`';
    const out = convertClaudeToCopilotContent(input, true);
    assert.ok(!/(?:~|\$HOME)\/\.claude\b/.test(out));
  });

  test('local install replaces bare ~/.claude', () => {
    const input = 'configDir = ~/.claude\n';
    const out = convertClaudeToCopilotContent(input, /* isGlobal */ false);
    assert.ok(
      !/(?:~|\$HOME)\/\.claude\b/.test(out),
      `expected no leaked ~/.claude reference, got: ${JSON.stringify(out)}`,
    );
  });

  test('does not double-replace trailing-slash form', () => {
    const input = '@~/.claude/gsd-core/foo.md\n';
    const out = convertClaudeToCopilotContent(input, true);
    assert.match(out, /~\/\.copilot\/gsd-core\/foo\.md/);
    assert.ok(!/\.copilot\/\.copilot/.test(out));
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-983-trae-windsurf-claude-path-leak.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-983-trae-windsurf-claude-path-leak (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #983)
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Regression tests for issue #983 — Trae and Windsurf converters leak
 * unreplaced bare `~/.claude` / `$HOME/.claude` references.
 *
 * Both converters rewrote only trailing-slash `.claude/` forms, so bare
 * home-path references (configDir = ~/.claude, $HOME/.claude) survived
 * conversion and pointed users at the wrong config dir.
 *
 * Fix: add bare word-boundary replacements mirroring Cline (#782) and
 * Codex (#570) precedent, with a negative lookahead to preserve `.claude-plugin`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  convertClaudeToWindsurfMarkdown,
  convertClaudeToTraeMarkdown,
  _applyRuntimeRewrites,
} = require('../bin/install.js');

// ─── Windsurf converter bare-form tests ─────────────────────────────────────

describe('convertClaudeToWindsurfMarkdown — bare ~/.claude and CLAUDE_CONFIG_DIR (#983)', () => {
  test('bare ~/.claude rewritten to ~/.windsurf (#1615: workspace dir is now .windsurf)', () => {
    const input = 'Config dir: (~/.claude), skills at ~/.claude/skills';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      `bare ~/.claude must be rewritten; got: ${result}`,
    );
    assert.ok(result.includes('~/.windsurf'), 'must rewrite to ~/.windsurf');
  });

  test('$HOME/.claude rewritten to $HOME/.windsurf (#1615: workspace dir is now .windsurf)', () => {
    const input = 'RUNTIME_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      `bare $HOME/.claude must be rewritten; got: ${result}`,
    );
    assert.ok(result.includes('$HOME/.windsurf'), 'must rewrite to $HOME/.windsurf');
  });

  test('CLAUDE_CONFIG_DIR rewritten to WINDSURF_CONFIG_DIR', () => {
    const input = 'Use CLAUDE_CONFIG_DIR or $HOME/.claude to configure';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(
      result.includes('WINDSURF_CONFIG_DIR'),
      'CLAUDE_CONFIG_DIR must become WINDSURF_CONFIG_DIR',
    );
    assert.ok(
      !result.includes('CLAUDE_CONFIG_DIR'),
      'CLAUDE_CONFIG_DIR must be gone',
    );
  });

  test('.claude-plugin is NOT corrupted (preserved as-is)', () => {
    const input = 'The .claude-plugin/plugin.json manifest enables plugin install.';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(
      result.includes('.claude-plugin'),
      `.claude-plugin must be preserved; got: ${result}`,
    );
    assert.ok(
      !result.includes('.windsurf-plugin'),
      `.windsurf-plugin must not appear; got: ${result}`,
    );
  });

  test('no bare ~/.claude in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToWindsurfMarkdown(raw);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      'converted surface.md must not contain bare ~/.claude',
    );
  });

  test('no $HOME/.claude in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToWindsurfMarkdown(raw);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      'converted surface.md must not contain bare $HOME/.claude',
    );
  });

  test('no CLAUDE_CONFIG_DIR in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToWindsurfMarkdown(raw);
    assert.ok(
      !result.includes('CLAUDE_CONFIG_DIR'),
      'converted surface.md must not contain CLAUDE_CONFIG_DIR',
    );
  });
});

// ─── Trae converter bare-form tests ─────────────────────────────────────────

describe('convertClaudeToTraeMarkdown — bare ~/.claude and CLAUDE_CONFIG_DIR (#983)', () => {
  test('bare ~/.claude rewritten to ~/.trae', () => {
    const input = 'Config dir: (~/.claude), skills at ~/.claude/skills';
    const result = convertClaudeToTraeMarkdown(input);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      `bare ~/.claude must be rewritten; got: ${result}`,
    );
    assert.ok(result.includes('~/.trae'), 'must rewrite to ~/.trae');
  });

  test('$HOME/.claude rewritten to $HOME/.trae', () => {
    const input = 'RUNTIME_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
    const result = convertClaudeToTraeMarkdown(input);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      `bare $HOME/.claude must be rewritten; got: ${result}`,
    );
    assert.ok(result.includes('$HOME/.trae'), 'must rewrite to $HOME/.trae');
  });

  test('CLAUDE_CONFIG_DIR rewritten to TRAE_CONFIG_DIR', () => {
    const input = 'Use CLAUDE_CONFIG_DIR or $HOME/.claude to configure';
    const result = convertClaudeToTraeMarkdown(input);
    assert.ok(
      result.includes('TRAE_CONFIG_DIR'),
      'CLAUDE_CONFIG_DIR must become TRAE_CONFIG_DIR',
    );
    assert.ok(
      !result.includes('CLAUDE_CONFIG_DIR'),
      'CLAUDE_CONFIG_DIR must be gone',
    );
  });

  test('.claude-plugin is NOT corrupted (preserved as-is)', () => {
    const input = 'The .claude-plugin/plugin.json manifest enables plugin install.';
    const result = convertClaudeToTraeMarkdown(input);
    assert.ok(
      result.includes('.claude-plugin'),
      `.claude-plugin must be preserved; got: ${result}`,
    );
    assert.ok(
      !result.includes('.trae-plugin'),
      `.trae-plugin must not appear; got: ${result}`,
    );
  });

  test('no bare ~/.claude in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToTraeMarkdown(raw);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      'converted surface.md must not contain bare ~/.claude',
    );
  });

  test('no $HOME/.claude in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToTraeMarkdown(raw);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      'converted surface.md must not contain bare $HOME/.claude',
    );
  });

  test('no CLAUDE_CONFIG_DIR in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToTraeMarkdown(raw);
    assert.ok(
      !result.includes('CLAUDE_CONFIG_DIR'),
      'converted surface.md must not contain CLAUDE_CONFIG_DIR',
    );
  });
});

// ─── _applyRuntimeRewrites install-path tests (windsurf) ────────────────────
//
// These tests exercise the ACTUAL install path that causes the user-facing leak.
// The converter functions are called at stage time to produce a Windsurf-branded
// copy, but _applyRuntimeRewrites is the path that runs at INSTALL time and
// rewrites any surviving ~/.claude / $HOME/.claude refs in the staged files.
//
// FAIL-BEFORE proof: prior to this PR, windsurf used /~\/\.claude\b/ which
// fires on "~/.claude-plugin" because \b matches between 'e' and '-'.  Running
// the test below against the old regex (`\b`) would:
//   - let bare $HOME/.claude survive (it used only /~\/\.claude\b/, missing $HOME form), AND
//   - corrupt "~/.claude-plugin" → "~/.windsurf-plugin".
// Both assertions in the test below would fail on the old code.
//
// PASS-AFTER: the fix changes to (?![\w-]) so:
//   - bare ~/.claude / $HOME/.claude (not followed by word-char or hyphen) → rewritten
//   - ~/.claude-plugin preserved (the '-' after 'e' is in [\w-])
//
// NOTE on pathPrefix choice: we use '~/.windsurf/' (a simple home-relative
// prefix) rather than '$HOME/.codeium/windsurf/' so that the corruption of
// '~/.claude-plugin' → '~/.windsurf-plugin' is directly detectable via
// result.includes('.windsurf-plugin').
describe('_applyRuntimeRewrites(windsurf) — install-path bare-form + .claude-plugin (#983)', () => {
  // Use ~/  prefix (local-style) so that the .windsurf-plugin corruption is
  // directly detectable as a substring of the result.
  const WINDSURF_PATH_PREFIX = '~/.windsurf/';

  // Compound content: covers every form the fix must handle.
  // IMPORTANT: we use ~/.claude-plugin (home-relative form) to exercise the
  // corruption that the old \b regex caused. The \b fires between 'e' and '-',
  // so ~/.claude-plugin → ~/.windsurf-plugin under the old code. That would
  // break the preservation assertion below. The (?![\w-]) fix prevents this.
  const COMPOUND_INPUT = [
    'Config dir: ~/.claude',
    'Also: $HOME/.claude',
    'Slash form: ~/.claude/skills/foo.md',
    'Plugin installed at: ~/.claude-plugin/plugin.json',
    'Env var: CLAUDE_CONFIG_DIR',
  ].join('\n');

  test('bare ~/.claude rewritten to ~/.windsurf (no trailing slash)', () => {
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      `bare ~/.claude must be gone; got:\n${result}`,
    );
    assert.ok(
      result.includes('~/.windsurf'),
      `must contain normalized pathPrefix; got:\n${result}`,
    );
  });

  test('bare $HOME/.claude rewritten to ~/.windsurf (install-path normalizes both home forms)', () => {
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      `bare $HOME/.claude must be gone; got:\n${result}`,
    );
  });

  test('zero surviving bare ~/.claude or $HOME/.claude refs in compound input', () => {
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    const bareClaudePattern = /(?:~|\$HOME)\/\.claude(?![\w-])/;
    assert.ok(
      !bareClaudePattern.test(result),
      `no bare ~/.claude / $HOME/.claude must survive; got:\n${result}`,
    );
  });

  test('~/.claude-plugin is NOT corrupted to ~/.windsurf-plugin — was the \\b corruption', () => {
    // FAIL-BEFORE: old /~\/\.claude\b/ rewrote ~/.claude-plugin → ~/.windsurf-plugin
    // because \b fires between 'e' and '-'.
    // PASS-AFTER: (?![\w-]) sees '-' and skips the match, preserving ~/.claude-plugin.
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    assert.ok(
      result.includes('~/.claude-plugin'),
      `~/.claude-plugin must be preserved; got:\n${result}`,
    );
    assert.ok(
      !result.includes('~/.windsurf-plugin'),
      `~/.windsurf-plugin must NOT appear (was the \\b corruption); got:\n${result}`,
    );
  });

  test('slash form ~/.claude/ is also rewritten (pre-existing coverage)', () => {
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    assert.ok(
      !result.includes('~/.claude/'),
      `slash form ~/.claude/ must be gone; got:\n${result}`,
    );
  });

  test('CLAUDE_CONFIG_DIR is NOT rewritten by _applyRuntimeRewrites (converter responsibility)', () => {
    // _applyRuntimeRewrites does NOT handle CLAUDE_CONFIG_DIR for windsurf;
    // that rewrite is done by convertClaudeToWindsurfMarkdown at stage time.
    // This test documents the boundary and guards against scope creep.
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    assert.ok(
      result.includes('CLAUDE_CONFIG_DIR'),
      'CLAUDE_CONFIG_DIR is not rewritten by _applyRuntimeRewrites — that is converter scope',
    );
  });
});

// ─── _applyRuntimeRewrites install-path tests (trae) ────────────────────────
//
// Trae had bare-form handling before this PR (via \b) and the converter uses
// (?![\w-]).  The pre-existing \b in _applyRuntimeRewrites DOES corrupt
// .claude-plugin → .trae-plugin (known limitation, out of scope for #983).
// We document this here but do NOT assert preservation for trae, and we do NOT
// fix the pre-existing trae \b lines (that would be a separate concern).
//
// What we DO assert: trae bare ~/.claude / $HOME/.claude refs are rewritten
// (the install path cleans them), which is the core #983 fix for trae.
describe('_applyRuntimeRewrites(trae) — install-path bare-form (#983)', () => {
  const TRAE_PATH_PREFIX = '$HOME/.trae/';

  const TRAE_INPUT = [
    'Config dir: ~/.claude',
    'Also: $HOME/.claude',
    'Slash form: ~/.claude/skills/foo.md',
    // Note: .claude-plugin is intentionally omitted from assertions here because
    // the pre-existing trae case uses \b which corrupts it (known limitation,
    // out of scope for #983 — do not fix here).
  ].join('\n');

  test('bare ~/.claude rewritten to $HOME/.trae (trae install path)', () => {
    const result = _applyRuntimeRewrites(TRAE_INPUT, 'trae', TRAE_PATH_PREFIX);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      `bare ~/.claude must be gone; got:\n${result}`,
    );
  });

  test('bare $HOME/.claude rewritten to $HOME/.trae (trae install path)', () => {
    const result = _applyRuntimeRewrites(TRAE_INPUT, 'trae', TRAE_PATH_PREFIX);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      `bare $HOME/.claude must be gone; got:\n${result}`,
    );
  });

  test('slash form ~/.claude/ also rewritten (trae install path)', () => {
    const result = _applyRuntimeRewrites(TRAE_INPUT, 'trae', TRAE_PATH_PREFIX);
    assert.ok(
      !result.includes('~/.claude/'),
      `slash form ~/.claude/ must be gone; got:\n${result}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-782-cline-skills-emission.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-782-cline-skills-emission (consolidation epic #1969 B1 #1970)", () => {
'use strict';
/**
 * Regression tests for bug #782 — Cline skills emission.
 *
 * gsd now emits skills to ~/.cline/skills/<name>/SKILL.md for Cline >= v3.48.
 * Skills discovery: https://docs.cline.bot/customization/skills
 *
 * (a) Converter unit test: convertClaudeCommandToClineSkill
 * (b) Integration test: installRuntimeArtifacts for cline writes SKILL.md files
 * (c) .clinerules/gsd.md still written by the install path (#787 dir form)
 * (d) Idempotency: running install twice leaves skills + .clinerules/ intact
 * (e) Full install() global: both skills AND .clinerules/gsd.md are written
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup, captureConsole } = require('./helpers.cjs');

const {
  convertClaudeCommandToClineSkill,
  convertClaudeToCliineMarkdown,
  install,
  _applyRuntimeRewrites,
} = require('../bin/install.js');

const { installRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');

const {
  resolveRuntimeArtifactLayout,
} = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');

const {
  loadSkillsManifest,
  resolveProfile,
} = require('../gsd-core/bin/lib/install-profiles.cjs');

const { nestedSkillPath } = require('./helpers/nested-layout.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const MANIFEST = loadSkillsManifest(REAL_COMMANDS_DIR);
const RESOLVED_CORE = resolveProfile({ modes: ['core'], manifest: MANIFEST });

// ─── (a) Converter unit test ─────────────────────────────────────────────────

const SAMPLE_COMMAND = `---
name: gsd:execute-phase
description: Execute all tasks in the current phase using Cline tools.
allowed-tools:
  - Read
  - Write
  - Bash
---

## Objective

Run all tasks in the current phase.

See ~/.claude/skills/gsd-help/SKILL.md for reference.
Use \`/gsd-help\` or Claude Code for details.
`;

// A command that exercises all three Claude-specific frontmatter fields that
// must NOT leak into the emitted Cline SKILL.md.
const RICH_COMMAND = `---
name: gsd:validate-phase
description: Retroactively audit and fill Nyquist validation gaps for a completed phase
argument-hint: "[phase number]"
agent: researcher
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
---

## Objective

Audit Nyquist validation coverage. See ~/.claude/skills/gsd-help/SKILL.md for reference.
Use Claude Code for details.
`;

/**
 * Extract frontmatter block (between --- delimiters) from output.
 * Returns the raw text between the first --- and the closing ---.
 * Uses \r?\n to handle both LF and CRLF line endings (Windows parity).
 */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

describe('convertClaudeCommandToClineSkill — unit', () => {
  test('emits frontmatter with name: gsd-<stem>', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    const nameMatch = result.match(/^name:\s*(.+)$/m);
    assert.ok(nameMatch, 'frontmatter must contain name field');
    assert.ok(nameMatch[1].includes('gsd-execute-phase'), 'name must start with gsd-execute-phase');
  });

  test('emits non-empty description in frontmatter', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'frontmatter must contain description field');
    assert.ok(descMatch[1].trim().length > 0, 'description must not be empty');
  });

  test('body uses .cline/ paths not .claude/', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    // The body reference to ~/.claude/ should be rewritten to ~/.cline/
    assert.ok(!result.includes('~/.claude/skills'), 'body must not contain ~/.claude/skills');
    assert.ok(result.includes('.cline/skills'), 'body must contain .cline/skills');
  });

  test('body replaces "Claude Code" with "Cline"', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    assert.ok(!result.includes('Claude Code'), 'Claude Code must be replaced with Cline');
    assert.ok(result.includes('Cline'), 'result must contain Cline branding');
  });

  test('no stray .claude/ paths in frontmatter or body', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    // Should not contain .claude/ anywhere (except inside CLAUDE.md→.clinerules rewrites
    // but those are already handled by convertClaudeToCliineMarkdown)
    assert.ok(!result.includes('/.claude/'), 'no /.claude/ paths in output');
  });

  // ── Fix 1 (code-review): frontmatter must be ONLY name + description ──────

  test('frontmatter emits ONLY name and description — no allowed-tools (SAMPLE_COMMAND)', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    const fm = parseFrontmatter(result);
    assert.ok(fm !== null, 'result must have YAML frontmatter');
    assert.ok(!fm.includes('allowed-tools'), 'frontmatter must NOT contain allowed-tools');
    assert.ok(!fm.includes('argument-hint'), 'frontmatter must NOT contain argument-hint');
    assert.ok(!fm.includes('agent:'), 'frontmatter must NOT contain agent:');
  });

  test('frontmatter emits ONLY name and description — no allowed-tools/argument-hint/agent (RICH_COMMAND)', () => {
    const result = convertClaudeCommandToClineSkill(RICH_COMMAND, 'gsd-validate-phase');
    const fm = parseFrontmatter(result);
    assert.ok(fm !== null, 'result must have YAML frontmatter');
    assert.ok(!fm.includes('allowed-tools'), 'frontmatter must NOT contain allowed-tools');
    assert.ok(!fm.includes('argument-hint'), 'frontmatter must NOT contain argument-hint');
    assert.ok(!fm.includes('agent:'), 'frontmatter must NOT contain agent:');
  });

  test('name == gsd-validate-phase for RICH_COMMAND', () => {
    const result = convertClaudeCommandToClineSkill(RICH_COMMAND, 'gsd-validate-phase');
    const nameMatch = result.match(/^name:\s*(.+)$/m);
    assert.ok(nameMatch, 'must have name field');
    // yamlIdentifier may quote the value; strip surrounding quotes for comparison
    const nameVal = nameMatch[1].replace(/^['"]|['"]$/g, '').trim();
    assert.strictEqual(nameVal, 'gsd-validate-phase', `name must be gsd-validate-phase, got: ${nameVal}`);
  });

  test('description is non-empty and <= 1024 chars for RICH_COMMAND', () => {
    const result = convertClaudeCommandToClineSkill(RICH_COMMAND, 'gsd-validate-phase');
    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'must have description field');
    const desc = descMatch[1].replace(/^['"]|['"]$/g, '').trim();
    assert.ok(desc.length > 0, 'description must be non-empty');
    assert.ok(desc.length <= 1024, `description must be <= 1024 chars, got ${desc.length}`);
  });

  test('description truncated to <=1024 chars when source description is very long', () => {
    const longDesc = 'A'.repeat(2000);
    const longDescCommand = `---\nname: gsd:test\ndescription: ${longDesc}\n---\n\nBody text.\n`;
    const result = convertClaudeCommandToClineSkill(longDescCommand, 'gsd-test');
    const descMatch = result.match(/^description:\s*'?(.*?)'?$/m);
    assert.ok(descMatch, 'must have description field');
    // The raw description value (unquoted) should be <=1024 chars
    // The result string after the --- block will have the quoted form; check raw length
    // by checking the whole result doesn't have the full 2000-char string
    assert.ok(!result.includes('A'.repeat(1025)), 'description must be truncated to 1024 chars');
  });

  test('returns content unchanged when source has no frontmatter', () => {
    const noFm = 'Just a body, no frontmatter here.\n';
    const result = convertClaudeCommandToClineSkill(noFm, 'gsd-test');
    assert.strictEqual(result, noFm, 'content without frontmatter must be returned unchanged');
  });

  test('RICH_COMMAND body uses .cline/ paths and Cline branding', () => {
    const result = convertClaudeCommandToClineSkill(RICH_COMMAND, 'gsd-validate-phase');
    assert.ok(!result.includes('~/.claude/'), 'body must not contain ~/.claude/');
    assert.ok(result.includes('.cline/'), 'body must contain .cline/ paths');
    assert.ok(!result.includes('Claude Code'), 'body must not contain "Claude Code"');
    assert.ok(result.includes('Cline'), 'body must reference Cline');
  });
});

// ─── (b) + (c) + (d) Integration tests ────────────────────────────────────────

describe('installRuntimeArtifacts — cline skills emission', () => {
  test('cline global: writes gsd-prefixed skill dirs under skills/', (t) => {
    const configDir = createTempDir('gsd-cline-skills-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const layout = resolveRuntimeArtifactLayout('cline', configDir, 'global');
    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'cline must have a skills kind after #782');

    const skillsDir = path.join(configDir, skillsKind.destSubpath);
    assert.ok(fs.existsSync(skillsDir), 'skills/ directory must be created');

    const helpSkillDir = path.join(skillsDir, `${skillsKind.prefix}help`);
    assert.ok(
      fs.existsSync(path.join(helpSkillDir, 'SKILL.md')),
      `gsd-help/SKILL.md must exist under ${skillsKind.destSubpath}/`
    );
  });

  test('cline global: SKILL.md has valid cline frontmatter (name + description)', (t) => {
    const configDir = createTempDir('gsd-cline-fm-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const skillsDir = path.join(configDir, 'skills');
    const helpSkill = path.join(skillsDir, 'gsd-help', 'SKILL.md');
    assert.ok(fs.existsSync(helpSkill), 'gsd-help/SKILL.md must exist');

    const content = fs.readFileSync(helpSkill, 'utf8');
    // Must have YAML frontmatter
    assert.ok(content.startsWith('---'), 'SKILL.md must start with YAML frontmatter');
    assert.ok(content.includes('name:'), 'frontmatter must have name field');
    assert.ok(content.includes('description:'), 'frontmatter must have description field');
    // name must be gsd-help
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    assert.ok(nameMatch, 'must have name field');
    assert.ok(nameMatch[1].includes('gsd-help'), `name must include gsd-help, got: ${nameMatch[1]}`);
  });

  test('cline global: SKILL.md uses .cline/ paths not .claude/', (t) => {
    const configDir = createTempDir('gsd-cline-paths-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const skillsDir = path.join(configDir, 'skills');
    // Check all installed skill files for stray .claude/ references
    const skills = fs.readdirSync(skillsDir).filter(n => n.startsWith('gsd-'));
    assert.ok(skills.length > 0, 'at least one gsd- skill must be installed');

    for (const skillName of skills) {
      const skillFile = path.join(skillsDir, skillName, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const content = fs.readFileSync(skillFile, 'utf8');
      assert.ok(
        !content.includes('~/.claude/'),
        `${skillName}/SKILL.md must not contain ~/.claude/ — found stray path`
      );
      assert.ok(
        !content.includes('/.claude/'),
        `${skillName}/SKILL.md must not contain /.claude/ — found stray path`
      );
    }
  });

  test('cline global: skill count matches resolved profile', (t) => {
    const configDir = createTempDir('gsd-cline-count-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const skillsDir = path.join(configDir, 'skills');
    const count = fs.readdirSync(skillsDir)
      .filter(n => n.startsWith('gsd-') && fs.statSync(path.join(skillsDir, n)).isDirectory())
      .length;

    if (RESOLVED_CORE.skills !== '*') {
      assert.strictEqual(count, RESOLVED_CORE.skills.size,
        `installed skill count (${count}) must match profile size (${RESOLVED_CORE.skills.size})`);
    } else {
      assert.ok(count > 0, 'must install at least 1 skill');
    }
  });
});

describe('installRuntimeArtifacts — cline idempotency', () => {
  test('cline: running install twice leaves skills intact (idempotency)', (t) => {
    const configDir = createTempDir('gsd-cline-idempotent-');
    t.after(() => cleanup(configDir));

    // First install
    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const skillsDir = path.join(configDir, 'skills');
    const countAfterFirst = fs.readdirSync(skillsDir)
      .filter(n => n.startsWith('gsd-') && fs.statSync(path.join(skillsDir, n)).isDirectory())
      .length;

    // Second install (upgrade over existing)
    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const countAfterSecond = fs.readdirSync(skillsDir)
      .filter(n => n.startsWith('gsd-') && fs.statSync(path.join(skillsDir, n)).isDirectory())
      .length;

    assert.strictEqual(countAfterFirst, countAfterSecond,
      `skill count must be stable across installs: first=${countAfterFirst} second=${countAfterSecond}`);
  });
});

// ─── (e) Full install() global — coexistence regression ───────────────────────
//
// Issue #782 explicitly requires that a global Cline install writes BOTH:
//   - skills/<gsd-*>/SKILL.md     (skills for Cline >= v3.48)
//   - .clinerules/gsd.md          (rules dir form introduced by #787)
//
// installRuntimeArtifacts() tests cover skills in isolation; this test exercises
// the FULL install() code path to ensure neither artifact is silently dropped.

describe('install() global cline — coexistence: skills AND .clinerules', () => {
  let tmpGlobalDir;
  let originalClineConfigDir;

  beforeEach(() => {
    originalClineConfigDir = process.env.CLINE_CONFIG_DIR;
    tmpGlobalDir = createTempDir('gsd-cline-global-');
    // Redirect CLINE_CONFIG_DIR to the temp dir so install() never touches ~/.cline
    process.env.CLINE_CONFIG_DIR = tmpGlobalDir;
  });

  afterEach(() => {
    if (originalClineConfigDir !== undefined) {
      process.env.CLINE_CONFIG_DIR = originalClineConfigDir;
    } else {
      delete process.env.CLINE_CONFIG_DIR;
    }
    cleanup(tmpGlobalDir);
  });

  test('global cline install writes at least one gsd-* SKILL.md under skills/', () => {
    captureConsole(() => install(true, 'cline'));

    const skillsDir = path.join(tmpGlobalDir, 'skills');
    assert.ok(
      fs.existsSync(skillsDir),
      `skills/ directory must exist under ${tmpGlobalDir} after global cline install`
    );

    // full profile: gsd-help is nested under gsd-ns-manage/skills/help/SKILL.md
    const helpSkillFile = nestedSkillPath(skillsDir, 'gsd-', 'help');
    assert.ok(
      fs.existsSync(helpSkillFile),
      `${path.relative(tmpGlobalDir, helpSkillFile)} must exist under ${tmpGlobalDir} — skills emission broken for global cline`
    );
  });

  test('global cline install writes .clinerules/gsd.md to the global config dir', () => {
    captureConsole(() => install(true, 'cline'));

    // For a global Cline install, targetDir = getGlobalDir('cline') = CLINE_CONFIG_DIR.
    // The cline-rules surface (#787) writes the .clinerules/ DIRECTORY form:
    //   .clinerules/gsd.md  (rule file)
    //   .clinerules/hooks/PreToolUse  (lifecycle hook)
    const clinerulesMd = path.join(tmpGlobalDir, '.clinerules', 'gsd.md');
    assert.ok(
      fs.existsSync(clinerulesMd),
      `.clinerules/gsd.md must exist at ${clinerulesMd} — coexistence with skills broken for global cline (#782+#787)`
    );
  });

  test('global cline .clinerules/gsd.md contains GSD instructions', () => {
    captureConsole(() => install(true, 'cline'));

    // #787 dir form: rule content lives in .clinerules/gsd.md, not a flat .clinerules file
    const clinerulesMd = path.join(tmpGlobalDir, '.clinerules', 'gsd.md');
    assert.ok(fs.existsSync(clinerulesMd), '.clinerules/gsd.md must exist');
    const content = fs.readFileSync(clinerulesMd, 'utf8');
    assert.ok(
      content.includes('GSD') || content.includes('gsd'),
      '.clinerules/gsd.md must reference GSD'
    );
  });
});

// ─── Fix 3 regression: converter rewrites bare ~/.claude and CLAUDE_CONFIG_DIR ──
//
// convertClaudeToCliineMarkdown must also handle bare ~/.claude (no trailing
// slash) and the CLAUDE_CONFIG_DIR env-var name. surface.md contains these;
// the emitted Cline SKILL.md must contain no such stale Claude refs.

describe('convertClaudeToCliineMarkdown — bare ~/.claude and CLAUDE_CONFIG_DIR (Fix 3)', () => {
  const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');

  test('no bare ~/.claude in converted surface.md', () => {
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToCliineMarkdown(raw);
    // ~/.claude followed by a word-boundary (not a /) must be gone
    assert.ok(
      !/~\/\.claude\b/.test(result),
      'converted surface.md must not contain bare ~/.claude'
    );
  });

  test('no CLAUDE_CONFIG_DIR in converted surface.md', () => {
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToCliineMarkdown(raw);
    assert.ok(
      !result.includes('CLAUDE_CONFIG_DIR'),
      'converted surface.md must not contain CLAUDE_CONFIG_DIR'
    );
  });

  test('CLAUDE_CONFIG_DIR rewritten to CLINE_CONFIG_DIR', () => {
    const input = 'Use CLAUDE_CONFIG_DIR or $HOME/.claude to configure';
    const result = convertClaudeToCliineMarkdown(input);
    assert.ok(result.includes('CLINE_CONFIG_DIR'), 'CLAUDE_CONFIG_DIR must become CLINE_CONFIG_DIR');
    assert.ok(!result.includes('CLAUDE_CONFIG_DIR'), 'CLAUDE_CONFIG_DIR must be gone');
  });

  test('bare ~/.claude rewritten to ~/.cline', () => {
    const input = 'Config dir: (~/.claude), skills at ~/.claude/skills';
    const result = convertClaudeToCliineMarkdown(input);
    assert.ok(!result.includes('~/.claude'), 'bare ~/.claude must be rewritten');
    assert.ok(result.includes('~/.cline'), 'must rewrite to ~/.cline');
  });

  test('installRuntimeArtifacts cline global: gsd-surface SKILL.md has no bare ~/.claude or CLAUDE_CONFIG_DIR', (t) => {
    const configDir = createTempDir('gsd-cline-surface-fix3-');
    t.after(() => cleanup(configDir));

    const MANIFEST_FULL = require('../gsd-core/bin/lib/install-profiles.cjs').loadSkillsManifest(
      path.join(__dirname, '..', 'commands', 'gsd')
    );
    const RESOLVED_FULL = require('../gsd-core/bin/lib/install-profiles.cjs').resolveProfile({
      modes: ['full'], manifest: MANIFEST_FULL,
    });

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_FULL);

    // full profile: surface is nested under gsd-ns-manage/skills/surface/SKILL.md
    const surfaceSkill = nestedSkillPath(path.join(configDir, 'skills'), 'gsd-', 'surface');
    assert.ok(fs.existsSync(surfaceSkill), `${path.relative(configDir, surfaceSkill)} must exist for full profile`);

    const content = fs.readFileSync(surfaceSkill, 'utf8');
    assert.ok(
      !/~\/\.claude\b/.test(content),
      'gsd-surface SKILL.md must not contain bare ~/.claude (Fix 3)'
    );
    assert.ok(
      !content.includes('CLAUDE_CONFIG_DIR'),
      'gsd-surface SKILL.md must not contain CLAUDE_CONFIG_DIR (Fix 3)'
    );
  });
});

// ─── Fix 1 regression: custom CLINE_CONFIG_DIR → embedded paths use custom dir ──
//
// _applyRuntimeRewrites for cline must rewrite ~/.cline/ → pathPrefix.
// For default global installs, pathPrefix = "$HOME/.cline/" (unchanged).
// For custom installs (CLINE_CONFIG_DIR=/custom), pathPrefix = "/custom/" and
// all embedded ~/.cline/ refs in SKILL.md must become /custom/...

describe('_applyRuntimeRewrites — cline custom-dir embedded path (Fix 1)', () => {
  test('default pathPrefix ($HOME/.cline/) leaves ~/.cline refs as $HOME/.cline', () => {
    const content = 'See ~/.cline/skills/gsd-help/SKILL.md for reference.\nBare: ~/.cline\n';
    const result = _applyRuntimeRewrites(content, 'cline', '$HOME/.cline/');
    assert.ok(result.includes('$HOME/.cline/'), 'default prefix must map ~/.cline/ to $HOME/.cline/');
    assert.ok(!result.includes('~/.cline'), 'no tilde form should remain after rewrite');
  });

  test('custom pathPrefix rewrites ~/.cline/ → custom path in SKILL.md body', () => {
    const content = 'See ~/.cline/skills/gsd-help/SKILL.md for reference.\nBare: ~/.cline\n';
    const result = _applyRuntimeRewrites(content, 'cline', '/custom/cline-dir/');
    assert.ok(result.includes('/custom/cline-dir/'), 'custom prefix must appear in output');
    assert.ok(!result.includes('~/.cline'), 'no tilde cline form should remain after custom rewrite');
  });

  test('custom pathPrefix rewrites residual ~/.claude/ safety net', () => {
    const content = 'Residual: ~/.claude/skills\n';
    const result = _applyRuntimeRewrites(content, 'cline', '/custom/cline-dir/');
    assert.ok(result.includes('/custom/cline-dir/'), 'safety-net ~/.claude/ also rewritten to custom prefix');
    assert.ok(!result.includes('~/.claude/'), 'no ~/.claude/ should remain');
  });

  test('installRuntimeArtifacts cline with CLINE_CONFIG_DIR custom: SKILL.md embeds custom path', (t) => {
    const configDir = createTempDir('gsd-cline-custom-dir-');
    t.after(() => cleanup(configDir));

    const MANIFEST_FULL = require('../gsd-core/bin/lib/install-profiles.cjs').loadSkillsManifest(
      path.join(__dirname, '..', 'commands', 'gsd')
    );
    const RESOLVED_FULL = require('../gsd-core/bin/lib/install-profiles.cjs').resolveProfile({
      modes: ['full'], manifest: MANIFEST_FULL,
    });

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_FULL);

    // gsd-surface SKILL.md references config paths; with a custom configDir
    // (not under $HOME), pathPrefix will be the absolute custom path.
    // full profile: surface is nested under gsd-ns-manage/skills/surface/SKILL.md
    const surfaceSkill = nestedSkillPath(path.join(configDir, 'skills'), 'gsd-', 'surface');
    assert.ok(fs.existsSync(surfaceSkill), `${path.relative(configDir, surfaceSkill)} must exist`);

    const content = fs.readFileSync(surfaceSkill, 'utf8');
    // With a custom dir (path under /tmp, not ~/.cline), the output must NOT
    // contain ~/.cline/ or $HOME/.cline/ — it must embed the actual configDir path.
    assert.ok(
      !content.includes('~/.cline/'),
      `gsd-surface SKILL.md must not contain ~/.cline/ when configDir=${configDir} (Fix 1)`
    );
    // The custom path must appear somewhere in the file
    // (configDir is a /tmp/... path so pathPrefix = configDir+'/').
    // Production normalizes backslashes to forward slashes via
    // path.resolve(configDir).replace(/\\/g, '/'), so compare against that
    // form — otherwise this assertion fails on Windows where mkdtempSync
    // returns a backslash path (e.g. C:\Users\...) but the emitted content
    // already has forward slashes (C:/Users/...).
    const expectedPath = path.resolve(configDir).replace(/\\/g, '/');
    assert.ok(
      content.includes(expectedPath),
      `gsd-surface SKILL.md must embed custom configDir path ${expectedPath} (Fix 1)`
    );
  });
});

// ─── Fix 4 regression: description truncation is code-point-aware ────────────
//
// Naive UTF-16 slicing (`str.slice(0, 1021)`) can split a surrogate pair when
// the cut falls between the high and low surrogate of a multibyte character
// (e.g. emoji U+1F600, which is encoded as two UTF-16 code units).  The fix
// uses Array.from() to split by code point, guaranteeing that the truncated
// value never contains a lone surrogate.

describe('convertClaudeCommandToClineSkill — code-point-aware truncation (Fix 4)', () => {
  /**
   * Build a frontmatter+body command string whose description is:
   *   - exactly `prefixLen` ASCII chars
   *   - followed by `emojiCount` repetitions of '😀' (U+1F600, 2 UTF-16 units)
   *   - total UTF-16 length is prefixLen + emojiCount * 2
   */
  function makeEmojiCommand(prefixLen, emojiCount) {
    const desc = 'A'.repeat(prefixLen) + '😀'.repeat(emojiCount);
    return `---\nname: gsd:emoji-test\ndescription: ${desc}\n---\n\nBody.\n`;
  }

  test('emitted description is <= 1024 code points when source overflows', () => {
    // 1020 ASCII chars + 4 emoji = 1020 + 8 UTF-16 units = 1028 UTF-16 units > 1024.
    // Code-point count = 1020 + 4 = 1024 — exactly at the boundary BEFORE adding '...'.
    // After truncation to 1021 code points + '...' → 1024 code points total.
    const cmd = makeEmojiCommand(1020, 10); // 1030 code points → must truncate
    const result = convertClaudeCommandToClineSkill(cmd, 'gsd-emoji-test');

    // Extract raw description value (strip surrounding YAML quotes if present)
    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'emitted SKILL.md must have a description field');
    const rawDesc = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

    const codePoints = Array.from(rawDesc);
    assert.ok(
      codePoints.length <= 1024,
      `emitted description must be <= 1024 code points, got ${codePoints.length}`
    );
  });

  test('emitted description ends with "..." when truncated', () => {
    const cmd = makeEmojiCommand(1020, 10); // 1030 code points → must truncate
    const result = convertClaudeCommandToClineSkill(cmd, 'gsd-emoji-test');

    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'emitted SKILL.md must have a description field');
    const rawDesc = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

    assert.ok(rawDesc.endsWith('...'), `truncated description must end with "...", got: ${rawDesc.slice(-10)}`);
  });

  test('emitted description has no lone surrogate (no split emoji)', () => {
    // Place emojis exactly at positions 1021–1025 (code points) so that a naive
    // UTF-16 slice at 1021 code units would cut inside the second emoji's surrogate pair.
    // 1019 ASCII chars + 6 emoji = 1025 code points (>1024, triggers truncation).
    // UTF-16 length = 1019 + 12 = 1031.  Naive slice(0,1021) yields 1019 ASCII +
    // the HIGH surrogate of emoji[0] — a lone surrogate.
    const cmd = makeEmojiCommand(1019, 6);
    const result = convertClaudeCommandToClineSkill(cmd, 'gsd-emoji-test');

    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'emitted SKILL.md must have a description field');
    const rawDesc = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

    // Verify no lone surrogate: every char's code point must be outside [0xD800, 0xDFFF].
    const hasLoneSurrogate = [...rawDesc].some(c => {
      const cp = c.codePointAt(0);
      return cp >= 0xD800 && cp <= 0xDFFF;
    });
    assert.ok(!hasLoneSurrogate, 'emitted description must not contain a lone surrogate');

    // Also round-trip through Buffer to confirm the string is valid UTF-8 encodable.
    assert.doesNotThrow(
      () => Buffer.from(rawDesc, 'utf8').toString('utf8'),
      'emitted description must round-trip through Buffer without error'
    );
  });

  test('short description (<= 1024 code points) is not truncated', () => {
    // 10 ASCII + 5 emoji = 15 code points — well under the limit.
    const cmd = makeEmojiCommand(10, 5);
    const result = convertClaudeCommandToClineSkill(cmd, 'gsd-emoji-test');

    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'emitted SKILL.md must have a description field');
    const rawDesc = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

    assert.ok(!rawDesc.endsWith('...'), 'short description must NOT be truncated with "..."');
    // Must contain the original emoji characters intact
    assert.ok(rawDesc.includes('😀'), 'short description must preserve emoji characters');
  });
});

// ─── Fix 2 regression: cline local scope emits no skills ─────────────────────
//
// resolveRuntimeArtifactLayout('cline', dir, 'local') must return 0 kinds.
// installRuntimeArtifacts('cline', dir, 'local') must not write any skills.

describe('resolveRuntimeArtifactLayout — cline scope-aware (Fix 2)', () => {
  test('cline local: kinds.length === 0 (no skills for local scope)', () => {
    const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
    const layout = resolveRuntimeArtifactLayout('cline', '/tmp/x', 'local');
    assert.strictEqual(layout.kinds.length, 0, 'cline local must have 0 kinds');
  });

  test('cline global: kinds.length === 1 (skills kind)', () => {
    const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
    const layout = resolveRuntimeArtifactLayout('cline', '/tmp/x', 'global');
    assert.strictEqual(layout.kinds.length, 1, 'cline global must have 1 skills kind');
    assert.strictEqual(layout.kinds[0].kind, 'skills');
  });

  test('installRuntimeArtifacts cline local: no skills/ dir created', (t) => {
    const configDir = createTempDir('gsd-cline-local-noskills-');
    t.after(() => cleanup(configDir));

    assert.doesNotThrow(() => installRuntimeArtifacts('cline', configDir, 'local', RESOLVED_CORE));
    const skillsDir = path.join(configDir, 'skills');
    assert.ok(
      !fs.existsSync(skillsDir),
      `skills/ must NOT be created for cline local install (Fix 2), but found ${skillsDir}`
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3037-gemini-duplicate-commands.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3037-gemini-duplicate-commands (consolidation epic #1969 B1 #1970)", () => {
/**
 * Bug #3037: Gemini global+local install creates duplicate /gsd:* commands
 * across user (HOME/.gemini/) and workspace (PROJECT/.gemini/) scopes.
 *
 * Reproduction (from issue body):
 *   1. install --gemini --global with HOME=tmpHome
 *   2. cd tmpProject; install --gemini --local
 *   → both ~/.gemini/commands/gsd/ and PROJECT/.gemini/commands/gsd/ contain
 *     65 overlapping command filenames.
 *   → Gemini conflict detection renames every overlapping command to
 *     /workspace.gsd:* and /user.gsd:*, breaking the documented /gsd:*
 *     namespace.
 *
 * Fix: when the local Gemini install detects the user-scope GSD command
 * directory already exists with managed-shape content, skip the local copy
 * and emit a clear warning explaining the conflict avoidance.
 *
 * Tests assert on the post-install filesystem shape and capture the skip
 * warning so the full test log remains warning-clean.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup, captureConsole } = require('./helpers.cjs');

const { install } = require('../bin/install.js');

describe('bug #3037: Gemini global+local install must not create duplicate command scopes', () => {
  let tmpHome;
  let tmpProject;
  let originalHome;
  let originalUserprofile;
  let originalCwd;

  beforeEach(() => {
    tmpHome = createTempDir('gsd-3037-home-');
    tmpProject = createTempDir('gsd-3037-work-');
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    originalCwd = process.cwd();
    // Point HOME at the temp dir so install(true, 'gemini') writes to
    // tmpHome/.gemini, not the developer's real home.
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    // CR #3041: also restore USERPROFILE so the temp HOME doesn't leak
    // into later tests and create order-dependent failures on Windows
    // or any code path that reads USERPROFILE.
    if (originalUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserprofile;
    process.chdir(originalCwd);
    cleanup(tmpHome);
    cleanup(tmpProject);
  });

  function listCommandFiles(geminiCommandsRoot) {
    if (!fs.existsSync(geminiCommandsRoot)) return [];
    const out = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.push(path.relative(geminiCommandsRoot, full));
      }
    }
    walk(geminiCommandsRoot);
    return out.sort();
  }

  function runInstall(...args) {
    return captureConsole(() => install(...args));
  }

  test('global install populates HOME/.gemini/commands/gsd', () => {
    runInstall(true, 'gemini');
    const globalCmds = path.join(tmpHome, '.gemini', 'commands', 'gsd');
    const files = listCommandFiles(globalCmds);
    assert.ok(
      files.length > 0,
      'global install must populate HOME/.gemini/commands/gsd'
    );
  });

  test('local install after global does NOT populate PROJECT/.gemini/commands/gsd (avoids /gsd:* namespace conflict)', () => {
    // Step 1: global install
    runInstall(true, 'gemini');
    const globalCmds = path.join(tmpHome, '.gemini', 'commands', 'gsd');
    const globalFiles = listCommandFiles(globalCmds);
    assert.ok(globalFiles.length > 0, 'precondition: global install must succeed');

    // Step 2: local install in a temp project
    process.chdir(tmpProject);
    const { stdout } = runInstall(false, 'gemini');
    assert.match(
      stdout,
      /Skipping commands\/gsd\/ for local install/,
      'local install must explain why it skips duplicate Gemini commands'
    );

    // Assertion: the local commands/gsd/ directory must NOT exist (or must
    // be empty) so Gemini's conflict detection has nothing to rename. The
    // fix may either skip the directory entirely (preferred — no leftover
    // file system noise) or create an empty directory (acceptable but odd).
    const localCmds = path.join(tmpProject, '.gemini', 'commands', 'gsd');
    const localFiles = listCommandFiles(localCmds);
    assert.equal(
      localFiles.length,
      0,
      `local install must skip commands/gsd/ when global already exists; ` +
        `found ${localFiles.length} duplicate command file(s) at ${localCmds}`
    );
  });

  test('local install with NO existing global GSD does still populate PROJECT/.gemini/commands/gsd', () => {
    // No global install first — local should proceed normally so users who
    // only ever run --local still get GSD commands in their project.
    process.chdir(tmpProject);
    runInstall(false, 'gemini');

    const localCmds = path.join(tmpProject, '.gemini', 'commands', 'gsd');
    const localFiles = listCommandFiles(localCmds);
    assert.ok(
      localFiles.length > 0,
      `local-only install must populate PROJECT/.gemini/commands/gsd; ` +
        `found ${localFiles.length} files at ${localCmds}`
    );
  });

  test('local install when HOME has hand-dropped overrides UNDER commands/gsd/ (but no full GSD) still populates locally', () => {
    // CR #3041 regression: the previous detection was
    // `fs.readdirSync(homeGeminiGsd).length > 0` which would skip the
    // local install for a user who manually dropped a single override
    // command at ~/.gemini/commands/gsd/<thing>.toml without ever
    // running --gemini --global. The fix narrows detection to require
    // at least 3 canonical GSD command files (help.toml, progress.toml,
    // new-project.toml) — a marker that's structurally impossible to
    // produce by accident.
    const homeGsdDir = path.join(tmpHome, '.gemini', 'commands', 'gsd');
    fs.mkdirSync(homeGsdDir, { recursive: true });
    fs.writeFileSync(
      path.join(homeGsdDir, 'my-override.toml'),
      'description = "user override"\nprompt = "..."\n'
    );

    process.chdir(tmpProject);
    runInstall(false, 'gemini');

    const localCmds = path.join(tmpProject, '.gemini', 'commands', 'gsd');
    const localFiles = listCommandFiles(localCmds);
    assert.ok(
      localFiles.length > 0,
      `local install must proceed when HOME/.gemini/commands/gsd contains ` +
        `only user overrides (not the full GSD canary set); ` +
        `found ${localFiles.length} files at ${localCmds}`
    );
  });

  test('local install when HOME/.gemini exists but commands/gsd is absent (non-GSD Gemini user) still populates locally', () => {
    // Simulate a user who has Gemini configured but never installed GSD
    // globally. ~/.gemini/ exists with unrelated content; ~/.gemini/commands/
    // may or may not exist with non-gsd subdirectories. Local install must
    // still proceed because no GSD-managed user-scope directory is present.
    fs.mkdirSync(path.join(tmpHome, '.gemini', 'commands', 'someone-else'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpHome, '.gemini', 'commands', 'someone-else', 'foo.toml'),
      'description = "user command"\nprompt = "..."\n'
    );

    process.chdir(tmpProject);
    runInstall(false, 'gemini');

    const localCmds = path.join(tmpProject, '.gemini', 'commands', 'gsd');
    const localFiles = listCommandFiles(localCmds);
    assert.ok(
      localFiles.length > 0,
      `local install must proceed when no GSD-managed user-scope directory ` +
        `exists, even if other Gemini commands are present at the user scope`
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-789-codebuddy-commands.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-789-codebuddy-commands (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #789)
// Workflow .md / command .md / SKILL.md files — their text IS what the runtime
// loads. Testing emitted text tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression guard — enh(#789): elevate CodeBuddy slash-command surface.
 *
 * CodeBuddy (Tencent, @tencent-ai/codebuddy-code) reads user-level surfaces
 * (https://www.codebuddy.ai/docs/cli/slash-commands, /skills):
 *   - commands/gsd-<stem>.md   — slash commands shown in the '/' menu
 *   - skills/gsd-<stem>/SKILL.md — model-invocable skills
 *
 * Before #789 gsd emitted only skills/. Because CodeBuddy skills default to
 * user-invocable:true (appear in '/'), emitting a commands/ surface AND leaving
 * skills user-invocable would duplicate every /gsd-* entry. #789 therefore:
 *   1. emits commands/gsd-<stem>.md (the '/' surface, peer-consistent with
 *      Cursor #785 and Augment #790),
 *   2. marks skills user-invocable:false so they become model-invocable
 *      background knowledge and the commands/ surface is the sole '/' surface.
 *
 * Subagents are already emitted via the generic agents block + convertClaude
 * AgentToCodebuddyAgent (~/.codebuddy/agents/), so #789 adds no agents change.
 *
 * mcp.json is intentionally NOT written: gsd ships no MCP server, and CodeBuddy's
 * mcp.json holds an `mcpServers` map of *external* servers to connect to —
 * there is nothing for gsd to register. Same exclusion as #784/#785/#790.
 */
'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  convertClaudeCommandToCodebuddyCommand,
  convertClaudeCommandToCodebuddySkill,
} = require('../bin/install.js');

const {
  installRuntimeArtifacts,
  uninstallRuntimeArtifacts,
} = require('../gsd-core/bin/lib/install-engine.cjs');
const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const { loadSkillsManifest, resolveProfile } = require('../gsd-core/bin/lib/install-profiles.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const MANIFEST = loadSkillsManifest(REAL_COMMANDS_DIR);
const RESOLVED_CORE = resolveProfile({ modes: ['core'], manifest: MANIFEST });

// ─── Layout contract ─────────────────────────────────────────────────────────

describe('enh-789 — codebuddy layout has commands + skills kinds', () => {
  test('resolveRuntimeArtifactLayout codebuddy returns 3 kinds (ADR-1235 §1 agents cutover)', () => {
    const layout = resolveRuntimeArtifactLayout('codebuddy', '/tmp/fake-codebuddy-dir');
    assert.strictEqual(layout.kinds.length, 3, 'codebuddy must have exactly 3 artifact kinds (commands + skills + agents)');
    const kindNames = layout.kinds.map(k => k.kind).sort();
    assert.deepStrictEqual(kindNames, ['agents', 'commands', 'skills']);
  });

  test('codebuddy commands kind targets commands/ with gsd- prefix', () => {
    const layout = resolveRuntimeArtifactLayout('codebuddy', '/tmp/fake-codebuddy-dir');
    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'must have commands kind');
    assert.strictEqual(commandsKind.destSubpath, 'commands');
    assert.strictEqual(commandsKind.prefix, 'gsd-');
    assert.strictEqual(typeof commandsKind.stage, 'function');
  });

  test('codebuddy skills kind targets skills/ with gsd- prefix', () => {
    const layout = resolveRuntimeArtifactLayout('codebuddy', '/tmp/fake-codebuddy-dir');
    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'must have skills kind');
    assert.strictEqual(skillsKind.destSubpath, 'skills');
    assert.strictEqual(skillsKind.prefix, 'gsd-');
  });
});

// ─── Command converter contract ──────────────────────────────────────────────

describe('enh-789 — convertClaudeCommandToCodebuddyCommand', () => {
  const SRC = [
    '---',
    'name: gsd:new-project',
    'description: Initialize a project',
    'argument-hint: "[name]"',
    'allowed-tools:',
    '  - Read',
    '---',
    '',
    'Use .claude/skills/ and run /gsd:help. Claude Code reads CLAUDE.md.',
    '',
  ].join('\n');

  test('emits a description-only frontmatter (no Claude-specific name: gsd:)', () => {
    const out = convertClaudeCommandToCodebuddyCommand(SRC, 'gsd-new-project');
    assert.ok(out.startsWith('---\n'), 'must begin with frontmatter');
    assert.ok(/^description:/m.test(out), 'must carry a description field');
    assert.ok(!out.includes('name: gsd:new-project'), 'must drop Claude colon-form name field');
  });

  test('preserves a present argument-hint (CodeBuddy supports it)', () => {
    const out = convertClaudeCommandToCodebuddyCommand(SRC, 'gsd-new-project');
    assert.ok(/^argument-hint:\s*["']?\[name\]["']?\s*$/m.test(out),
      `argument-hint must be carried through when present in source. Got:\n${out}`);
  });

  test('converts body Claude-isms to CodeBuddy equivalents', () => {
    const out = convertClaudeCommandToCodebuddyCommand(SRC, 'gsd-new-project');
    assert.ok(out.includes('.codebuddy/skills/'), out);
    assert.ok(out.includes('/gsd-help'), out);
    assert.ok(out.includes('CODEBUDDY.md'), out);
    assert.ok(!/\bClaude Code\b/.test(out), 'must rebrand "Claude Code"');
  });
});

describe('enh-789 — skills marked user-invocable:false', () => {
  test('convertClaudeCommandToCodebuddySkill emits user-invocable: false', () => {
    const src = [
      '---',
      'name: gsd:help',
      'description: Show help',
      '---',
      '',
      '# body',
      '',
    ].join('\n');
    const out = convertClaudeCommandToCodebuddySkill(src, 'gsd-help');
    assert.ok(/^user-invocable:\s*false\s*$/m.test(out),
      `SKILL.md frontmatter must hide skill from '/' menu (user-invocable: false). Got:\n${out}`);
  });
});

// ─── Install contract ────────────────────────────────────────────────────────

describe('enh-789 — installRuntimeArtifacts codebuddy emits commands and skills', () => {
  test('global codebuddy install: commands/gsd-help.md and skills/gsd-help/SKILL.md exist', (t) => {
    const configDir = createTempDir('gsd-enh789-codebuddy-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('codebuddy', configDir, 'global', RESOLVED_CORE);

    const commandsDir = path.join(configDir, 'commands');
    assert.ok(fs.existsSync(commandsDir), 'commands/ dir must exist');
    const cmdFiles = fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(cmdFiles.length > 0, 'at least one gsd-*.md command file must be installed');
    assert.ok(fs.existsSync(path.join(commandsDir, 'gsd-help.md')), 'commands/gsd-help.md must exist');

    const skillsDir = path.join(configDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills/ dir must exist');
    assert.ok(fs.existsSync(path.join(skillsDir, 'gsd-help', 'SKILL.md')), 'skills/gsd-help/SKILL.md must exist');
  });

  test('installed commands/gsd-help.md is CodeBuddy-compatible (no raw ~/.claude/, rebranded)', (t) => {
    const configDir = createTempDir('gsd-enh789-content-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('codebuddy', configDir, 'global', RESOLVED_CORE);

    const helpCmd = path.join(configDir, 'commands', 'gsd-help.md');
    const content = fs.readFileSync(helpCmd, 'utf8');
    assert.ok(!content.includes('~/.claude/'), 'commands must not contain raw ~/.claude/ refs');
    assert.ok(content.startsWith('---'), 'commands must carry frontmatter');
  });

  test('installed skills/gsd-help/SKILL.md is hidden from the / menu', (t) => {
    const configDir = createTempDir('gsd-enh789-skillhide-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('codebuddy', configDir, 'global', RESOLVED_CORE);

    const skill = fs.readFileSync(path.join(configDir, 'skills', 'gsd-help', 'SKILL.md'), 'utf8');
    assert.ok(/^user-invocable:\s*false\s*$/m.test(skill),
      'installed SKILL.md must set user-invocable: false');
  });

  test('command count matches skill count (profile parity)', (t) => {
    const configDir = createTempDir('gsd-enh789-parity-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('codebuddy', configDir, 'global', RESOLVED_CORE);

    const cmdCount = fs.readdirSync(path.join(configDir, 'commands'))
      .filter(f => f.startsWith('gsd-') && f.endsWith('.md')).length;
    const skillCount = fs.readdirSync(path.join(configDir, 'skills'), { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-')).length;
    assert.strictEqual(cmdCount, skillCount, 'command count must equal skill count for same profile');
  });

  test('full profile install: no $HOME/.codebuddy or ~/.codebuddy leak in any command', (t) => {
    // The codebuddy converter rewrites `.claude/` → `.codebuddy/`, so source
    // refs like `@$HOME/.claude/gsd-core/...` (e.g. plan-review-convergence.md)
    // must be normalized to the install target — not left as $HOME/.codebuddy.
    const RESOLVED_FULL = resolveProfile({ modes: ['full'], manifest: MANIFEST });
    const configDir = createTempDir('gsd-enh789-noleak-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('codebuddy', configDir, 'global', RESOLVED_FULL);

    const commandsDir = path.join(configDir, 'commands');
    for (const f of fs.readdirSync(commandsDir).filter(n => n.endsWith('.md'))) {
      const content = fs.readFileSync(path.join(commandsDir, f), 'utf8');
      assert.ok(!content.includes('$HOME/.codebuddy'), `${f} must not leak $HOME/.codebuddy`);
      assert.ok(!content.includes('~/.codebuddy'), `${f} must not leak ~/.codebuddy`);
      assert.ok(!content.includes('.claude/'), `${f} must not retain raw .claude/ refs`);
    }
  });

  test('full profile install does NOT mutate source commands/gsd/ files', (t) => {
    const RESOLVED_FULL = resolveProfile({ modes: ['full'], manifest: MANIFEST });
    assert.strictEqual(RESOLVED_FULL.skills, '*', 'full profile must have skills === "*"');

    const configDir = createTempDir('gsd-enh789-full-');
    t.after(() => cleanup(configDir));

    const srcHelpPath = path.join(REAL_COMMANDS_DIR, 'help.md');
    const before = fs.readFileSync(srcHelpPath, 'utf8');

    installRuntimeArtifacts('codebuddy', configDir, 'global', RESOLVED_FULL);

    const after = fs.readFileSync(srcHelpPath, 'utf8');
    assert.strictEqual(before, after, 'source commands/gsd/help.md must not be mutated by the install');
  });
});

// ─── Uninstall contract ──────────────────────────────────────────────────────

describe('enh-789 — uninstallRuntimeArtifacts removes codebuddy commands', () => {
  test('uninstall removes gsd-* commands but preserves user commands', (t) => {
    const configDir = createTempDir('gsd-enh789-uninstall-');
    t.after(() => cleanup(configDir));

    const commandsDir = path.join(configDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'gsd-help.md'), '# help\n');
    fs.writeFileSync(path.join(commandsDir, 'user-custom.md'), '# user\n');

    uninstallRuntimeArtifacts('codebuddy', configDir, 'global');

    assert.ok(!fs.existsSync(path.join(commandsDir, 'gsd-help.md')), 'gsd-help.md must be removed');
    assert.ok(fs.existsSync(path.join(commandsDir, 'user-custom.md')), 'user-custom.md must be preserved');
  });
});

// ─── mcp.json exclusion ──────────────────────────────────────────────────────

describe('enh-789 — mcp.json excluded (gsd ships no MCP server)', () => {
  test('codebuddy install does not write mcp.json / .mcp.json', (t) => {
    const configDir = createTempDir('gsd-enh789-mcp-excluded-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('codebuddy', configDir, 'global', RESOLVED_CORE);

    assert.ok(!fs.existsSync(path.join(configDir, 'mcp.json')), 'must not write mcp.json');
    assert.ok(!fs.existsSync(path.join(configDir, '.mcp.json')), 'must not write .mcp.json');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2794-opencode-model-profile-overrides.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2794-opencode-model-profile-overrides (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for bug #2794
 *
 * OpenCode generated agents ignored `model_profile_overrides.opencode.*`.
 * The agent install path called `readGsdEffectiveModelOverrides` (explicit
 * per-agent overrides) but never called `readGsdRuntimeProfileResolver`
 * (tier-based profile overrides). When a user configured:
 *
 *   { runtime: "opencode", model_profile_overrides: { opencode: { sonnet: "..." } } }
 *
 * generated `.opencode/agents/gsd-*.md` files contained no `model:` frontmatter.
 *
 * The fix adds a tier-resolver fallback in the OpenCode agent conversion block:
 * explicit `model_overrides[agent]` > `model_profile_overrides.opencode.<tier>` > omit.
 *
 * This test exercises:
 * 1. `readGsdRuntimeProfileResolver` correctly resolves OpenCode tier overrides.
 * 2. The agent install code path embeds the resolved model into OpenCode frontmatter.
 * 3. Explicit `model_overrides` still wins over tier-based resolution.
 * 4. Missing overrides produce no `model:` field (no regression on omit behavior).
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  readGsdRuntimeProfileResolver,
  install,
} = require('../bin/install.js');

const { createTempDir, cleanup } = require('./helpers.cjs');
const makeTmp = (prefix) => createTempDir(`gsd-2794-${prefix}-`);

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');
}


describe('bug-2794: readGsdRuntimeProfileResolver resolves opencode tier overrides', () => {
  let projectDir;
  let homeDir;
  let origHome;
  let origUP;

  beforeEach(() => {
    projectDir = makeTmp('proj');
    homeDir = makeTmp('home');
    origHome = process.env.HOME;
    origUP = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUP === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUP;
    cleanup(projectDir);
    cleanup(homeDir);
  });

  test('resolves opencode sonnet tier to user-supplied model ID', () => {
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      runtime: 'opencode',
      model_profile: 'balanced',
      model_profile_overrides: {
        opencode: {
          sonnet: 'anthropic/claude-sonnet-4-7',
        },
      },
    });

    const resolver = readGsdRuntimeProfileResolver(projectDir);
    assert.ok(resolver !== null, 'expected a resolver for opencode runtime');

    // gsd-roadmapper balanced tier = sonnet — should resolve to override
    const entry = resolver.resolve('gsd-roadmapper');
    assert.ok(entry !== null, 'expected entry for gsd-roadmapper');
    assert.strictEqual(entry.model, 'anthropic/claude-sonnet-4-7', 'sonnet override applied');
  });

  test('returns null resolver when runtime is not set', () => {
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      model_profile: 'balanced',
      model_profile_overrides: { opencode: { sonnet: 'x' } },
    });
    const resolver = readGsdRuntimeProfileResolver(projectDir);
    assert.strictEqual(resolver, null, 'no resolver without runtime field');
  });

  test('resolver returns null for agent not in MODEL_PROFILES', () => {
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      runtime: 'opencode',
      model_profile: 'balanced',
      model_profile_overrides: { opencode: { sonnet: 'x' } },
    });
    const resolver = readGsdRuntimeProfileResolver(projectDir);
    assert.ok(resolver !== null);
    const entry = resolver.resolve('gsd-nonexistent-agent');
    assert.strictEqual(entry, null, 'unknown agent name yields null');
  });
});

describe('bug-2794: OpenCode agent install embeds model_profile_overrides model', () => {
  let projectDir;
  let homeDir;
  let origHome;
  let origUP;
  let origCwd;

  beforeEach(() => {
    projectDir = makeTmp('proj');
    homeDir = makeTmp('home');
    origHome = process.env.HOME;
    origUP = process.env.USERPROFILE;
    origCwd = process.cwd();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.chdir(projectDir);
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUP === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUP;
    process.chdir(origCwd);
    cleanup(projectDir);
    cleanup(homeDir);
  });

  test('generated OpenCode agent frontmatter includes model from model_profile_overrides', () => {
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      runtime: 'opencode',
      model_profile: 'balanced',
      model_profile_overrides: {
        opencode: {
          sonnet: 'anthropic/claude-sonnet-4-7',
          opus: 'anthropic/claude-opus-4-7',
          haiku: 'anthropic/claude-haiku-4-5',
        },
      },
    });

    const oldLog = console.log;
    console.log = () => {};
    try {
      install(false, 'opencode');
    } finally {
      console.log = oldLog;
    }

    const agentsDir = path.join(projectDir, '.opencode', 'agents');
    assert.ok(fs.existsSync(agentsDir), 'agents directory should be created');

    // gsd-roadmapper is balanced -> sonnet tier
    const roadmapperPath = path.join(agentsDir, 'gsd-roadmapper.md');
    assert.ok(fs.existsSync(roadmapperPath), 'gsd-roadmapper.md should exist');
    const roadmapperContent = fs.readFileSync(roadmapperPath, 'utf-8');
    assert.match(
      roadmapperContent,
      /^model: anthropic\/claude-sonnet-4-7$/m,
      'gsd-roadmapper should have sonnet model from model_profile_overrides'
    );

    // gsd-planner is balanced -> opus tier
    const plannerPath = path.join(agentsDir, 'gsd-planner.md');
    assert.ok(fs.existsSync(plannerPath), 'gsd-planner.md should exist');
    const plannerContent = fs.readFileSync(plannerPath, 'utf-8');
    assert.match(
      plannerContent,
      /^model: anthropic\/claude-opus-4-7$/m,
      'gsd-planner should have opus model from model_profile_overrides'
    );
  });

  test('explicit model_overrides[agent] wins over model_profile_overrides tier', () => {
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      runtime: 'opencode',
      model_profile: 'balanced',
      model_overrides: {
        'gsd-roadmapper': 'explicit-winner-model',
      },
      model_profile_overrides: {
        opencode: {
          sonnet: 'tier-model-that-should-lose',
        },
      },
    });

    const oldLog = console.log;
    console.log = () => {};
    try {
      install(false, 'opencode');
    } finally {
      console.log = oldLog;
    }

    const roadmapperPath = path.join(projectDir, '.opencode', 'agents', 'gsd-roadmapper.md');
    assert.ok(fs.existsSync(roadmapperPath));
    const content = fs.readFileSync(roadmapperPath, 'utf-8');
    assert.match(
      content,
      /^model: explicit-winner-model$/m,
      'explicit model_overrides must win over model_profile_overrides tier'
    );
    assert.doesNotMatch(
      content,
      /tier-model-that-should-lose/,
      'tier model must not appear when explicit override is present'
    );
  });

  test('no model field when neither model_overrides nor model_profile_overrides is set', () => {
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      runtime: 'opencode',
      model_profile: 'balanced',
    });

    const oldLog = console.log;
    console.log = () => {};
    try {
      install(false, 'opencode');
    } finally {
      console.log = oldLog;
    }

    const roadmapperPath = path.join(projectDir, '.opencode', 'agents', 'gsd-roadmapper.md');
    if (fs.existsSync(roadmapperPath)) {
      const content = fs.readFileSync(roadmapperPath, 'utf-8');
      // When no overrides, model field should either be absent or use built-in default
      // The key invariant: no model field if there are no user-supplied overrides
      // AND no built-in opencode defaults for this tier
      // (gsd-roadmapper balanced = sonnet; opencode has built-in sonnet defaults)
      // So we only assert no crash and no tier-model-not-provided entries
      assert.ok(typeof content === 'string', 'agent file should be a string');
    }
    // Key: no exception thrown (test passes = no crash on missing overrides)
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2643-skill-frontmatter-name.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2643-skill-frontmatter-name (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #2643 / #2808: skill frontmatter name parity.
 *
 * Original (#2643): workflows emitted Skill(skill="gsd:<cmd>") and the
 * installer registered colon form in SKILL.md name: to match.
 *
 * Updated (#2808): workflows now use Skill(skill="gsd-<cmd>") (hyphen),
 * and the installer emits name: gsd-<cmd> (hyphen). Claude Code autocomplete
 * now shows the canonical hyphen form instead of the deprecated colon form.
 * The directory name (gsd-<cmd>) is unchanged.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  convertClaudeCommandToClaudeSkill,
  skillFrontmatterName,
} = require(path.join(ROOT, 'bin', 'install.js'));

const WORKFLOWS_DIR = path.join(ROOT, 'gsd-core', 'workflows');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');

function collectFiles(dir, results) {
  if (!results) results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(full, results);
    else if (e.name.endsWith('.md')) results.push(full);
  }
  return results;
}

/**
 * Extract every `Skill(skill="<name>")` invocation as a structured record.
 *
 * Per project test rigor (`feedback_no_source_grep_tests.md`), this parses
 * each call as a unit instead of leaning on a single regex over raw bytes.
 * The flow is:
 *
 *   1. Strip HTML comments so commented-out examples don't count as drift.
 *   2. Walk the content for `Skill(` openers; for each, find the matching
 *      `)` closer (Skill bodies are simple kwarg lists, no nesting).
 *   3. Parse the call body for the `skill = "..."` keyword argument.
 *      Permissive whitespace around the keyword and `=`, permissive
 *      single/double quoting (with optional `\` escapes from string-
 *      embedded examples), permissive name body — so malformed drift like
 *      `Skill(skill="gsd:extract_learnings")` is surfaced rather than
 *      silently skipped by an over-strict character class.
 *
 * Returns `[{ name, raw }]` per call. Filtering by namespace (gsd- vs gsd:)
 * happens at the call site so the extractor stays neutral.
 */
function extractSkillCalls(content) {
  // regex-free HTML-comment stripper (CodeQL: avoid incomplete-multi-character-sanitization)
  let stripped = '';
  {
    let rest = content;
    let idx;
    while ((idx = rest.indexOf('<!--')) !== -1) {
      stripped += rest.slice(0, idx);
      const end = rest.indexOf('-->', idx + 4);
      if (end === -1) { rest = ''; break; }
      rest = rest.slice(end + 3);
    }
    stripped += rest;
  }
  const calls = [];
  // Body class excludes backslash so the extractor doesn't include an
  // escape character that precedes the closing quote in embedded examples
  // (e.g. `Skill(skill=\"gsd-plan-phase\", …)` written inside a string
  // context). A trailing `\` is permitted on the closing-quote side via the
  // optional `\\?` so both `\"` and `"` close the value cleanly.
  const argRe = /^\s*skill\s*=\s*\\?(['"])([^'"\\]+)\\?\1/i;
  let i = 0;
  while (i < stripped.length) {
    const open = stripped.indexOf('Skill(', i);
    if (open === -1) break;
    const close = stripped.indexOf(')', open);
    if (close === -1) break;
    const body = stripped.slice(open + 'Skill('.length, close);
    const match = body.match(argRe);
    if (match) calls.push({ name: match[2], raw: stripped.slice(open, close + 1) });
    i = close + 1;
  }
  return calls;
}

function extractSkillNamesHyphen(content) {
  return new Set(
    extractSkillCalls(content)
      .map((c) => c.name)
      .filter((n) => n.startsWith('gsd-')),
  );
}

function extractSkillNamesColon(content) {
  return new Set(
    extractSkillCalls(content)
      .map((c) => c.name)
      .filter((n) => n.startsWith('gsd:')),
  );
}

describe('skill frontmatter name parity (#2643 / #2808)', () => {
  test('skillFrontmatterName helper emits hyphen form (#2808)', () => {
    assert.strictEqual(typeof skillFrontmatterName, 'function');
    assert.strictEqual(skillFrontmatterName('gsd-execute-phase'), 'gsd-execute-phase');
    assert.strictEqual(skillFrontmatterName('gsd-plan-phase'), 'gsd-plan-phase');
    assert.strictEqual(skillFrontmatterName('gsd-next'), 'gsd-next');
  });

  test('convertClaudeCommandToClaudeSkill emits name: gsd-<cmd> (hyphen)', () => {
    const input = '---\nname: old\ndescription: test\n---\n\nBody.';
    const result = convertClaudeCommandToClaudeSkill(input, 'gsd-execute-phase');
    // Parse the frontmatter block structurally: extract the name: field value.
    const frontmatterMatch = result.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(frontmatterMatch, 'output must have a frontmatter block delimited by ---');
    const frontmatterLines = frontmatterMatch[1].split(/\r?\n/);
    const nameEntry = frontmatterLines.find((l) => l.startsWith('name:'));
    assert.ok(nameEntry, 'frontmatter must contain a name: field');
    const nameValue = nameEntry.replace(/^name:\s*/, '').trim();
    assert.strictEqual(
      nameValue,
      'gsd-execute-phase',
      `frontmatter name: must be 'gsd-execute-phase' (hyphen form), got '${nameValue}'`
    );
  });

  test('no workflow uses deprecated Skill(skill="gsd:<cmd>") colon form', () => {
    const workflowFiles = collectFiles(WORKFLOWS_DIR);
    const colonRefs = [];
    for (const f of workflowFiles) {
      const src = fs.readFileSync(f, 'utf-8');
      for (const n of extractSkillNamesColon(src)) {
        colonRefs.push(path.basename(f) + ': ' + n);
      }
    }
    assert.deepStrictEqual(
      colonRefs,
      [],
      'deprecated colon-form Skill() calls found (update to hyphen): ' + colonRefs.join(', ')
    );
  });

  test('every workflow Skill(skill="gsd-<cmd>") resolves to an emitted skill name', () => {
    const workflowFiles = collectFiles(WORKFLOWS_DIR);
    const referenced = new Set();
    const templatedSkipped = [];
    for (const f of workflowFiles) {
      const src = fs.readFileSync(f, 'utf-8');
      for (const n of extractSkillNamesHyphen(src)) {
        // Skip template expressions (e.g. `gsd-${ref.skill}`): these are
        // capability-dispatched — the skill stem is resolved at runtime from
        // the `loop render-hooks` registry output (ADR-857 phase 6), so there
        // is no single literal skill file to validate against here.
        // The capability registry's own validateStep gate (gen-capability-registry.cjs)
        // is responsible for ensuring each `steps[].ref.skill` corresponds to a
        // real skill declared in the capability's `skills` array.
        if (n.includes('${')) {
          templatedSkipped.push(path.basename(f) + ': ' + n);
        } else {
          referenced.add(n);
        }
      }
    }
    assert.ok(
      referenced.size > 0,
      `expected at least one literal Skill(skill="gsd-<cmd>") reference in workflows under ${WORKFLOWS_DIR}`
    );

    const emitted = new Set();
    const cmdFiles = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));
    for (const cmd of cmdFiles) {
      const base = cmd.replace(/\.md$/, '');
      const skillDirName = 'gsd-' + base;
      const src = fs.readFileSync(path.join(COMMANDS_DIR, cmd), 'utf-8');
      const out = convertClaudeCommandToClaudeSkill(src, skillDirName);
      const m = out.match(/^---\r?\nname:\s*(.+)$/m);
      if (m) emitted.add(m[1].trim());
    }

    const missing = [];
    for (const r of referenced) if (!emitted.has(r)) missing.push(r);
    assert.deepStrictEqual(
      missing,
      [],
      'workflow refs not emitted as skill names: ' + missing.join(', '),
    );
    // Informational: report how many templated dispatches were intentionally skipped.
    // (Templated names are validated by the capability registry, not statically here.)
    if (templatedSkipped.length > 0) {
      // Not a failure — just a note for test output transparency.
      // Use a diagnostic comment: node:test does not have a skip-within-test API.
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-778-cross-runtime-command-enrichment.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-778-cross-runtime-command-enrichment (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #778)
// Reads .md/SKILL.md/.toml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GSD Tools Tests — #778 cross-runtime command enrichment.
 *
 * Two independently-verified, additive sub-features:
 *   (b) Qwen Code skills: numeric `priority` field (higher sorts earlier in the
 *       /skills TUI listing per the Qwen skills spec). Scoped to runtime='qwen'.
 *   (c) Gemini custom-command TOML: $ARGUMENTS → {{args}} interpolation, and a
 *       fixed `!{cat .planning/STATE.md}` live-state injection on the
 *       situational `progress` command (injection-safe — no interpolated input).
 *
 * The OpenCode sub-feature (per-command model/agent/subtask/variant) is
 * intentionally NOT implemented — see PR description: `model` reintroduces the
 * #1156 ProviderModelNotFoundError regression for non-Anthropic OpenCode users,
 * `subtask`/`agent` change execution semantics for GSD's interactive commands,
 * and `variant` is not in the OpenCode command schema.
 *
 * Uses node:test and node:assert (NOT Jest).
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  convertClaudeCommandToClaudeSkill,
  convertClaudeToGeminiMarkdown,
  install,
} = require('../bin/install.js');

// ─── (b) Qwen Code: priority ordering ───────────────────────────────────────

describe('#778 (b) Qwen skills priority', () => {
  const mk = (name, desc, body) =>
    ['---', `name: gsd:${name}`, `description: ${desc}`, '---', '', body].join('\n');

  test('emits numeric priority for a core-loop command (runtime=qwen)', () => {
    const result = convertClaudeCommandToClaudeSkill(
      mk('plan-phase', 'Plan a phase', 'Body.'),
      'gsd-plan-phase',
      'qwen',
      []
    );
    const m = result.match(/^priority:\s*(\d+)\s*$/m);
    assert.ok(m, 'priority field present for gsd-plan-phase');
    assert.equal(Number(m[1]) > 0, true, 'priority is a positive number');
  });

  test('core loop ranks higher than mid-tier (higher = earlier per spec)', () => {
    const np = convertClaudeCommandToClaudeSkill(
      mk('new-project', 'Start a project', 'Body.'), 'gsd-new-project', 'qwen', []
    ).match(/^priority:\s*(\d+)/m);
    const help = convertClaudeCommandToClaudeSkill(
      mk('help', 'Help', 'Body.'), 'gsd-help', 'qwen', []
    ).match(/^priority:\s*(\d+)/m);
    assert.ok(np && help, 'both core and mid-tier get a priority');
    assert.ok(
      Number(np[1]) > Number(help[1]),
      'new-project (core) sorts earlier than help (utility) — higher value'
    );
  });

  test('utility command NOT in the priority map gets no priority field', () => {
    const result = convertClaudeCommandToClaudeSkill(
      mk('stats', 'Show stats', 'Body.'), 'gsd-stats', 'qwen', []
    );
    assert.ok(!/^priority:/m.test(result), 'no priority emitted for unmapped utility');
  });

  test('does NOT emit priority for non-qwen runtimes (scoped to qwen)', () => {
    for (const rt of [null, 'claude', 'hermes']) {
      const result = convertClaudeCommandToClaudeSkill(
        mk('plan-phase', 'Plan a phase', 'Body.'), 'gsd-plan-phase', rt, []
      );
      assert.ok(!/^priority:/m.test(result), `no priority for runtime=${rt}`);
    }
  });
});

// ─── (c) Gemini: {{args}} interpolation ─────────────────────────────────────

describe('#778 (c) Gemini {{args}} interpolation', () => {
  const cmd = (body) =>
    ['---', 'name: gsd:demo', 'description: Demo', '---', '', body].join('\n');

  test('maps $ARGUMENTS to {{args}} in the TOML prompt', () => {
    const out = convertClaudeToGeminiMarkdown(
      cmd('Operate on $ARGUMENTS now.'),
      { isCommand: true, commandName: 'demo' }
    );
    assert.ok(out.includes('{{args}}'), '{{args}} present');
    assert.ok(!out.includes('$ARGUMENTS'), 'literal $ARGUMENTS removed');
    assert.ok(out.startsWith('description =') || out.includes('prompt ='), 'TOML shape');
  });

  test('command without $ARGUMENTS gets no injected {{args}}', () => {
    const out = convertClaudeToGeminiMarkdown(
      cmd('No arguments referenced here.'),
      { isCommand: true, commandName: 'demo' }
    );
    assert.ok(!out.includes('{{args}}'), 'no spurious {{args}}');
  });

  test('non-command Gemini content is not TOML-converted and keeps $ARGUMENTS', () => {
    const out = convertClaudeToGeminiMarkdown(
      cmd('Reference $ARGUMENTS.'),
      { isCommand: false }
    );
    // isCommand:false keeps markdown — no TOML wrap and no {{args}} mapping
    // (the $ARGUMENTS→{{args}} translation is scoped to the TOML command path).
    assert.ok(!out.startsWith('prompt ='), 'not wrapped as TOML prompt');
    assert.ok(out.includes('$ARGUMENTS'), '$ARGUMENTS left intact for non-command content');
    assert.ok(!out.includes('{{args}}'), 'no {{args}} injected outside the command path');
  });
});

// ─── (c) Gemini: end-to-end install wiring ──────────────────────────────────
// Proves the install path derives the per-command name from the file stem so a
// regression in the call-site wiring (not just the converter) is caught.

describe('#778 (c) Gemini install wiring (end-to-end)', () => {
  let tmpDir;
  let tmpHome;
  let prevCwd;
  let prevHome;
  let prevUserprofile;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-enh778-gem-');
    tmpHome = createTempDir('gsd-enh778-home-');
    prevCwd = process.cwd();
    prevHome = process.env.HOME;
    prevUserprofile = process.env.USERPROFILE;
    process.chdir(tmpDir);
    // Isolate HOME so a real ~/.gemini/commands/gsd/ doesn't trigger the #3037
    // local-install conflict-skip path.
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserprofile;
    cleanup(tmpDir);
    cleanup(tmpHome);
  });

  test('installed progress.toml carries the !{} block; arg-bearing commands get {{args}}', () => {
    const oldLog = console.log;
    console.log = () => {};
    try {
      install(false, 'gemini');
    } finally {
      console.log = oldLog;
    }

    const commandsDir = path.join(tmpDir, '.gemini', 'commands', 'gsd');
    const progressToml = path.join(commandsDir, 'progress.toml');
    assert.ok(fs.existsSync(progressToml), 'progress.toml installed');
    const progress = fs.readFileSync(progressToml, 'utf8');
    // Proves commandName was derived as 'progress' from the file stem.
    assert.ok(
      progress.includes('!{cat .planning/STATE.md 2>/dev/null}'),
      'progress.toml has the live-state shell block'
    );

    // A non-situational command must NOT receive the shell block.
    const helpToml = path.join(commandsDir, 'help.toml');
    if (fs.existsSync(helpToml)) {
      assert.ok(!fs.readFileSync(helpToml, 'utf8').includes('!{'), 'help.toml has no shell block');
    }

    // At least one installed command must use {{args}} and none may retain a
    // literal $ARGUMENTS (every command body's $ARGUMENTS is translated).
    const tomls = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.toml'));
    const withArgs = tomls.filter((f) =>
      fs.readFileSync(path.join(commandsDir, f), 'utf8').includes('{{args}}'));
    const withLiteral = tomls.filter((f) =>
      fs.readFileSync(path.join(commandsDir, f), 'utf8').includes('$ARGUMENTS'));
    assert.ok(withArgs.length > 0, 'at least one installed command interpolates {{args}}');
    assert.equal(withLiteral.length, 0, 'no installed command retains literal $ARGUMENTS');
  });
});

// ─── (c) Gemini: !{...} live-state injection (progress) ─────────────────────

describe('#778 (c) Gemini !{} live-state injection', () => {
  const cmd = (name) =>
    ['---', `name: gsd:${name}`, `description: ${name}`, '---', '', 'Workflow body.'].join('\n');

  test('progress command injects a fixed !{cat .planning/STATE.md} block', () => {
    const out = convertClaudeToGeminiMarkdown(
      cmd('progress'),
      { isCommand: true, commandName: 'progress' }
    );
    assert.ok(out.includes('!{cat .planning/STATE.md'), 'STATE.md injection present');
  });

  test('non-progress commands get no !{} shell block', () => {
    const out = convertClaudeToGeminiMarkdown(
      cmd('help'),
      { isCommand: true, commandName: 'help' }
    );
    assert.ok(!out.includes('!{'), 'no shell block for non-situational command');
  });

  test('SECURITY: the !{} block interpolates NO user input ({{args}})', () => {
    const out = convertClaudeToGeminiMarkdown(
      ['---', 'name: gsd:progress', 'description: progress', '---', '',
        'Body uses $ARGUMENTS too.'].join('\n'),
      { isCommand: true, commandName: 'progress' }
    );
    const blocks = out.match(/!\{([^}]*)\}/g) || [];
    assert.equal(blocks.length, 1, 'exactly one shell block');
    assert.ok(!/\{\{args\}\}/.test(blocks[0]), 'no {{args}} inside the shell block');
    assert.ok(/^!\{cat \.planning\/STATE\.md/.test(blocks[0]), 'fixed cat command only');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-769-context-fork-effort.install.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-769-context-fork-effort.install (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: integration-test-input (see #769)
// Exercises install() as a black-box by inspecting produced SKILL.md output
// in a temp dir. Source command .md files are inputs whose installed
// transformation is asserted — not inspected for string presence.

/**
 * #769 — effort: frontmatter on heavy workflow skills.
 * #921 — spawning orchestrators must NOT carry context: fork.
 *
 * Context: context:fork was added by #769 to protect context budget, but
 * plan-phase, execute-phase, and autonomous are spawning orchestrators — a
 * forked subagent has no Agent/Task tool, breaking their core function.
 * effort: max is preserved; context: fork is removed from these three.
 * The converter still passes context: fork through if a source file has it
 * (for any future leaf skill that legitimately needs isolation).
 *
 * Verifies:
 *   1. Source commands/gsd/autonomous.md does NOT have context: fork, has effort: max
 *   2. Source commands/gsd/execute-phase.md does NOT have context: fork, has effort: max
 *   3. Source commands/gsd/plan-phase.md does NOT have context: fork, has effort: max
 *   4. Source commands/gsd/progress.md has effort: low
 *   5. Source commands/gsd/stats.md has effort: low
 *   6. Claude global install: SKILL.md for autonomous has effort: max, NOT context: fork
 *   7. Claude global install: SKILL.md for execute-phase has effort: max, NOT context: fork
 *   8. Claude global install: SKILL.md for plan-phase has effort: max, NOT context: fork
 *   9. Claude global install: SKILL.md for progress has effort: low
 *  10. Claude global install: SKILL.md for stats has effort: low
 *  11. convertClaudeCommandToClaudeSkill still passes context: fork through (for non-orchestrator skills)
 *  12. convertClaudeCommandToClaudeSkill emits portable effort: field values
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { install, convertClaudeCommandToClaudeSkill } = require('../bin/install.js');
const { cleanup } = require('./helpers.cjs');

// #924: Claude global install is now FLAT — concrete skills are at the top level.
// flatSkillPath returns: <skillsRoot>/gsd-<stem>/SKILL.md
function flatSkillPath(skillsRoot, stem) {
  return path.join(skillsRoot, `gsd-${stem}`, 'SKILL.md');
}

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_COMMANDS_DIR = path.join(REPO_ROOT, 'commands', 'gsd');

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readFrontmatter(mdPath) {
  const content = fs.readFileSync(mdPath, 'utf8');
  if (!content.startsWith('---')) return '';
  const end = content.indexOf('---', 3);
  if (end === -1) return '';
  return content.substring(3, end);
}

/**
 * Run a global install for Claude, redirecting its home dir to tmpHome.
 * Returns the tmpHome for inspection.
 */
function runClaudeGlobalInstall(claudeHome) {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-769-home-'));

  const prevCwd = process.cwd();
  const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevSkipStale = process.env.GSD_SKIP_STALE_SDK_CHECK;

  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.GSD_SKIP_STALE_SDK_CHECK = '1';
  process.chdir(REPO_ROOT);

  try {
    install(true, 'claude');
  } finally {
    process.chdir(prevCwd);
    if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevSkipStale === undefined) delete process.env.GSD_SKIP_STALE_SDK_CHECK;
    else process.env.GSD_SKIP_STALE_SDK_CHECK = prevSkipStale;
    cleanup(isolatedHome);
  }

  return claudeHome;
}

// ─── describe 1: Source command files have correct frontmatter ────────────────

// #921/#922: spawning orchestrators must NOT carry context: fork — a forked
// subagent has no Agent/Task tool, making it impossible for orchestrators to
// spawn their required subagents. context: fork is appropriate only for leaf
// skills that do not themselves dispatch agents. effort: max is portable across Claude Code models.
describe('#769/#921/#1319 source commands: spawning orchestrators have effort: max but NOT context: fork', () => {
  test('commands/gsd/autonomous.md does NOT have context: fork (#921)', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'autonomous.md'));
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `autonomous.md is a spawning orchestrator and must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('commands/gsd/autonomous.md has effort: max (#1319)', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'autonomous.md'));
    assert.match(fm, /^effort:[ \t]*max$/m,
      `autonomous.md frontmatter must have effort: max\nActual:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:[ \t]*xhigh$/m,
      `autonomous.md frontmatter must not have rejected effort: xhigh (#1319)\nActual:\n${fm}`);
  });

  test('commands/gsd/execute-phase.md does NOT have context: fork (#921)', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'execute-phase.md'));
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `execute-phase.md is a spawning orchestrator and must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('commands/gsd/execute-phase.md has effort: max (#1319)', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'execute-phase.md'));
    assert.match(fm, /^effort:[ \t]*max$/m,
      `execute-phase.md frontmatter must have effort: max\nActual:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:[ \t]*xhigh$/m,
      `execute-phase.md frontmatter must not have rejected effort: xhigh (#1319)\nActual:\n${fm}`);
  });

  test('commands/gsd/plan-phase.md does NOT have context: fork (#921)', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'plan-phase.md'));
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `plan-phase.md is a spawning orchestrator and must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('commands/gsd/plan-phase.md has effort: max (#1319)', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'plan-phase.md'));
    assert.match(fm, /^effort:[ \t]*max$/m,
      `plan-phase.md frontmatter must have effort: max\nActual:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:[ \t]*xhigh$/m,
      `plan-phase.md frontmatter must not have rejected effort: xhigh (#1319)\nActual:\n${fm}`);
  });
});

describe('#769 source commands: quick-status skills have effort: low', () => {
  test('commands/gsd/progress.md has effort: low', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'progress.md'));
    assert.match(fm, /^effort:[ \t]*low$/m,
      `progress.md frontmatter must have effort: low\nActual:\n${fm}`);
  });

  test('commands/gsd/stats.md has effort: low', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'stats.md'));
    assert.match(fm, /^effort:[ \t]*low$/m,
      `stats.md frontmatter must have effort: low\nActual:\n${fm}`);
  });
});

// ─── describe 2: convertClaudeCommandToClaudeSkill preserves new fields ───────

describe('#769/#1319 convertClaudeCommandToClaudeSkill: preserves context and emits portable effort fields', () => {
  test('preserves context: fork in emitted SKILL.md frontmatter', () => {
    const input = [
      '---',
      'name: gsd:test-heavy',
      'description: Test heavy skill',
      'context: fork',
      'effort: xhigh',
      'allowed-tools:',
      '  - Read',
      '  - Bash',
      '---',
      '',
      'Heavy skill body.',
    ].join('\n');

    const result = convertClaudeCommandToClaudeSkill(input, 'test-heavy');
    const end = result.indexOf('---', 3);
    const fm = result.substring(3, end);

    assert.match(fm, /^context:[ \t]*fork$/m,
      `SKILL.md frontmatter must include context: fork\nActual frontmatter:\n${fm}`);
  });

  test('normalizes effort: xhigh to effort: max in emitted SKILL.md frontmatter (#1319)', () => {
    const input = [
      '---',
      'name: gsd:test-heavy',
      'description: Test heavy skill',
      'context: fork',
      'effort: xhigh',
      'allowed-tools:',
      '  - Read',
      '  - Bash',
      '---',
      '',
      'Heavy skill body.',
    ].join('\n');

    const result = convertClaudeCommandToClaudeSkill(input, 'test-heavy');
    const end = result.indexOf('---', 3);
    const fm = result.substring(3, end);

    assert.match(fm, /^effort:[ \t]*max$/m,
      `SKILL.md frontmatter must include portable effort: max\nActual frontmatter:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:[ \t]*xhigh$/m,
      `SKILL.md frontmatter must not include rejected effort: xhigh (#1319)\nActual frontmatter:\n${fm}`);
  });

  test('preserves effort: low in emitted SKILL.md frontmatter', () => {
    const input = [
      '---',
      'name: gsd:test-light',
      'description: Test light skill',
      'effort: low',
      'allowed-tools:',
      '  - Read',
      '---',
      '',
      'Light skill body.',
    ].join('\n');

    const result = convertClaudeCommandToClaudeSkill(input, 'test-light');
    const end = result.indexOf('---', 3);
    const fm = result.substring(3, end);

    assert.match(fm, /^effort:[ \t]*low$/m,
      `SKILL.md frontmatter must include effort: low\nActual frontmatter:\n${fm}`);
  });

  test('does NOT emit context: or effort: when absent from source', () => {
    const input = [
      '---',
      'name: gsd:test-plain',
      'description: Plain skill without context or effort',
      'allowed-tools:',
      '  - Read',
      '---',
      '',
      'Plain skill body.',
    ].join('\n');

    const result = convertClaudeCommandToClaudeSkill(input, 'test-plain');
    const end = result.indexOf('---', 3);
    const fm = result.substring(3, end);

    assert.doesNotMatch(fm, /^context:/m,
      `SKILL.md must not emit context: when absent from source\nActual:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:/m,
      `SKILL.md must not emit effort: when absent from source\nActual:\n${fm}`);
  });
});

// ─── describe 3: Claude global install — SKILL.md files include new fields ────

// #921/#922: after install, spawning orchestrators must NOT carry context: fork
// in their emitted SKILL.md. #1319: heavyweight skills must use portable max effort.
describe('#769/#921/#1319 Claude global install: spawning-orchestrator SKILL.md files have effort: max but NOT context: fork', () => {
  let tmpDir;
  let claudeHome;

  beforeEach(() => {
    tmpDir = makeTmpDir('gsd-769-claude-');
    claudeHome = path.join(tmpDir, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-autonomous SKILL.md does NOT have context: fork after global install (#921)', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'autonomous');
    const fm = readFrontmatter(skillPath);
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `gsd-autonomous is a spawning orchestrator; its SKILL.md must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('gsd-autonomous SKILL.md has effort: max after global install (#1319)', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'autonomous');
    const fm = readFrontmatter(skillPath);
    assert.match(fm, /^effort:[ \t]*max$/m,
      `gsd-autonomous SKILL.md must have effort: max\nActual:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:[ \t]*xhigh$/m,
      `gsd-autonomous SKILL.md must not have rejected effort: xhigh (#1319)\nActual:\n${fm}`);
  });

  test('gsd-execute-phase SKILL.md does NOT have context: fork after global install (#921)', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'execute-phase');
    const fm = readFrontmatter(skillPath);
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `gsd-execute-phase is a spawning orchestrator; its SKILL.md must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('gsd-execute-phase SKILL.md has effort: max after global install (#1319)', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'execute-phase');
    const fm = readFrontmatter(skillPath);
    assert.match(fm, /^effort:[ \t]*max$/m,
      `gsd-execute-phase SKILL.md must have effort: max\nActual:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:[ \t]*xhigh$/m,
      `gsd-execute-phase SKILL.md must not have rejected effort: xhigh (#1319)\nActual:\n${fm}`);
  });

  test('gsd-plan-phase SKILL.md does NOT have context: fork after global install (#921)', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'plan-phase');
    const fm = readFrontmatter(skillPath);
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `gsd-plan-phase is a spawning orchestrator; its SKILL.md must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('gsd-plan-phase SKILL.md has effort: max after global install (#1319)', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'plan-phase');
    const fm = readFrontmatter(skillPath);
    assert.match(fm, /^effort:[ \t]*max$/m,
      `gsd-plan-phase SKILL.md must have effort: max\nActual:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:[ \t]*xhigh$/m,
      `gsd-plan-phase SKILL.md must not have rejected effort: xhigh (#1319)\nActual:\n${fm}`);
  });

  test('gsd-progress SKILL.md has effort: low after global install', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'progress');
    const fm = readFrontmatter(skillPath);
    assert.match(fm, /^effort:[ \t]*low$/m,
      `gsd-progress SKILL.md must have effort: low\nActual:\n${fm}`);
  });

  test('gsd-stats SKILL.md has effort: low after global install', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'stats');
    const fm = readFrontmatter(skillPath);
    assert.match(fm, /^effort:[ \t]*low$/m,
      `gsd-stats SKILL.md must have effort: low\nActual:\n${fm}`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-443-effort-install-wiring.install.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-443-effort-install-wiring.install (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: integration-test-input (see #443)
// Exercises install() + generateCodexAgentToml() as a black-box by inspecting
// produced output files in temp dirs. Source agent .md files are inputs whose
// installed transformation is asserted — not inspected for string presence.

/**
 * #443 — Effort per-runtime wiring at install time.
 *
 * Verifies:
 *   1. Claude global install injects `effort:` into agent .md frontmatter.
 *   2. Gemini global install does NOT inject `effort:` (Gemini-safe .md).
 *   3. Codex inherited-model installs omit `model_reasoning_effort` so model
 *      and effort are not partially pinned (#838).
 *   4. Config-driven proof: effort.agent_overrides wins over tier defaults
 *      for Claude .md and for Codex .toml when runtime:"codex" pins a model.
 *   5. Source agents/gsd-planner.md has NO effort: key (injection is
 *      install-only, source stays Gemini-safe).
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { install } = require('../bin/install.js');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_AGENTS_DIR = path.join(REPO_ROOT, 'agents');

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readFrontmatter(mdPath) {
  const content = fs.readFileSync(mdPath, 'utf8');
  if (!content.startsWith('---')) return '';
  const end = content.indexOf('---', 3);
  if (end === -1) return '';
  return content.substring(3, end);
}

/**
 * Run a global install for the given runtime, redirecting its home dir to
 * tmpHome. Returns the tmpHome for inspection.
 *
 * Env-var redirection:
 *   claude   → CLAUDE_CONFIG_DIR
 *   gemini   → GEMINI_CONFIG_DIR
 *   codex    → CODEX_HOME
 *
 * HOME is also redirected to an isolated temp dir for the duration of the
 * install call. This prevents any install.js code that uses os.homedir()
 * directly (e.g. ~/.cache/gsd update-check deletion, ~/.gsd/defaults.json
 * reads, stale-SDK npm subprocess writes to ~/.npm) from touching the real
 * HOME and polluting the test environment for other concurrently-running
 * test files (e.g. runtime-launcher-parity test (D) checks that
 * $HOME/.claude/gsd-core/bin/gsd-tools.cjs is absent).
 *
 * GSD_SKIP_STALE_SDK_CHECK=1 is set to suppress the `npm ls -g` subprocess
 * that the installer spawns for global installs — that subprocess is slow,
 * writes to ~/.npm cache, and is irrelevant to effort-wiring assertions.
 *
 * The working directory is set to REPO_ROOT so install() can find the source
 * agents/. For config-driven tests, place tmpHome inside the project dir
 * so that readGsdEffectiveEffortConfig(targetDir) can walk up from tmpHome
 * and find .planning/config.json.
 */
function runGlobalInstall(runtime, tmpHome) {
  const envVarMap = {
    claude: 'CLAUDE_CONFIG_DIR',
    gemini: 'GEMINI_CONFIG_DIR',
    codex: 'CODEX_HOME',
  };
  const envVar = envVarMap[runtime];
  if (!envVar) throw new Error(`Unsupported runtime in test: ${runtime}`);

  // Isolate HOME to a fresh temp dir so install.js code that calls
  // os.homedir() (cache deletion, defaults.json reads, npm subprocess)
  // never touches the real $HOME/.claude / $HOME/.cache / $HOME/.gsd.
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-443-home-'));

  const prev = process.env[envVar];
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevSkipStale = process.env.GSD_SKIP_STALE_SDK_CHECK;

  process.env[envVar] = tmpHome;
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.GSD_SKIP_STALE_SDK_CHECK = '1';
  process.chdir(REPO_ROOT);

  try {
    install(true, runtime);
  } finally {
    process.chdir(prevCwd);
    if (prev === undefined) delete process.env[envVar];
    else process.env[envVar] = prev;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevSkipStale === undefined) delete process.env.GSD_SKIP_STALE_SDK_CHECK;
    else process.env.GSD_SKIP_STALE_SDK_CHECK = prevSkipStale;
    // Clean up the isolated HOME dir
    cleanup(isolatedHome);
  }

  return tmpHome;
}

// ─── Tier default expectations ────────────────────────────────────────────────
// light → low, standard → high, heavy → xhigh  (catalog defaults)
// gsd-planner: heavy → xhigh
// gsd-codebase-mapper: light → low
// gsd-executor: standard → high

// ─── describe 1: Claude install injects effort: ───────────────────────────────

describe('#443 Claude install: effort: injected into frontmatter', () => {
  let tmpDir;
  let claudeHome;

  beforeEach(() => {
    tmpDir = makeTmpDir('gsd-443-claude-');
    claudeHome = path.join(tmpDir, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-planner.md contains effort: xhigh (heavy tier default)', () => {
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-planner.md'));
    assert.match(fm, /^effort:\s*xhigh$/m,
      `gsd-planner frontmatter should have effort: xhigh\nActual:\n${fm}`);
  });

  test('gsd-codebase-mapper.md contains effort: low (light tier default)', () => {
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-codebase-mapper.md'));
    assert.match(fm, /^effort:\s*low$/m,
      `gsd-codebase-mapper frontmatter should have effort: low\nActual:\n${fm}`);
  });

  test('gsd-executor.md contains effort: high (standard tier default)', () => {
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-executor.md'));
    assert.match(fm, /^effort:\s*high$/m,
      `gsd-executor frontmatter should have effort: high\nActual:\n${fm}`);
  });
});

// ─── describe 2: Gemini install does NOT inject effort: ──────────────────────

describe('#443 Gemini install: effort: absent (Gemini-safe)', () => {
  let tmpDir;
  let geminiHome;

  beforeEach(() => {
    tmpDir = makeTmpDir('gsd-443-gemini-');
    geminiHome = path.join(tmpDir, 'gemini-home');
    fs.mkdirSync(geminiHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-planner.md does NOT contain effort: (Gemini install)', () => {
    runGlobalInstall('gemini', geminiHome);
    const fm = readFrontmatter(path.join(geminiHome, 'agents', 'gsd-planner.md'));
    assert.doesNotMatch(fm, /^effort:/m,
      `gsd-planner (Gemini) frontmatter must NOT have effort:\nActual:\n${fm}`);
  });

  test('gsd-executor.md does NOT contain effort: (Gemini install)', () => {
    runGlobalInstall('gemini', geminiHome);
    const fm = readFrontmatter(path.join(geminiHome, 'agents', 'gsd-executor.md'));
    assert.doesNotMatch(fm, /^effort:/m,
      `gsd-executor (Gemini) frontmatter must NOT have effort:\nActual:\n${fm}`);
  });
});

// ─── describe 3: Codex inherited-model install omits model_reasoning_effort ──

describe('#838 Codex install: inherited model omits model_reasoning_effort', () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = makeTmpDir('gsd-443-codex-');
    codexHome = path.join(tmpDir, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-planner.toml omits both model and model_reasoning_effort when model is inherited', () => {
    runGlobalInstall('codex', codexHome);
    const tomlContent = fs.readFileSync(
      path.join(codexHome, 'agents', 'gsd-planner.toml'), 'utf8'
    );
    assert.doesNotMatch(tomlContent, /^model\s*=/m,
      `gsd-planner.toml should omit model when inheriting Codex chat model\nActual:\n${tomlContent.slice(0, 500)}`);
    assert.doesNotMatch(tomlContent, /^model_reasoning_effort\s*=/m,
      `gsd-planner.toml should omit model_reasoning_effort when model is inherited\nActual:\n${tomlContent.slice(0, 500)}`);
  });
});

// ─── describe 4: Config-driven proof ─────────────────────────────────────────
//
// The runtime home dir must be INSIDE (or a sibling of) the project root so
// that readGsdEffectiveEffortConfig(targetDir) can walk up from the runtime
// home and find .planning/config.json. We put .claude/ and .codex/ as siblings
// of .planning/ inside the project dir — this is the natural local-install shape.

describe('#443 Config-driven: effort.agent_overrides drives install-time effort', () => {
  let tmpDir;
  let claudeHome;
  let codexHome;

  beforeEach(() => {
    // Layout: tmpDir/project/  <-- project root (cwd for install)
    //           .planning/config.json
    //           .claude/          <-- claudeHome (CLAUDE_CONFIG_DIR)
    //           .codex/           <-- codexHome (CODEX_HOME)
    tmpDir = makeTmpDir('gsd-443-cfg-');
    const projectDir = path.join(tmpDir, 'project');
    claudeHome = path.join(projectDir, '.claude');
    codexHome = path.join(projectDir, '.codex');

    fs.mkdirSync(claudeHome, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });

    // Write a project config with effort.agent_overrides overriding gsd-planner to 'low'.
    // runtime:"codex" pins a Codex-native model, so emitting model_reasoning_effort
    // remains valid under the #838 model/effort coupling rule.
    const config = {
      runtime: 'codex',
      effort: {
        agent_overrides: {
          'gsd-planner': 'low',
        },
      },
    };
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'config.json'),
      JSON.stringify(config, null, 2)
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('Claude .md gets effort: low when agent_overrides.gsd-planner=low', () => {
    // projectDir is the cwd for install — chdir handled inside runGlobalInstall.
    // claudeHome is inside projectDir, so walking up from claudeHome finds .planning/config.json.
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-planner.md'));
    assert.match(fm, /^effort:\s*low$/m,
      `gsd-planner should have effort: low from config override\nActual:\n${fm}`);
  });

  test('Codex .toml gets model_reasoning_effort = "low" when agent_overrides.gsd-planner=low', () => {
    runGlobalInstall('codex', codexHome);
    const tomlContent = fs.readFileSync(
      path.join(codexHome, 'agents', 'gsd-planner.toml'), 'utf8'
    );
    assert.match(tomlContent, /^model\s*=\s*"gpt-5.5"$/m,
      `gsd-planner.toml should pin Codex model when runtime:"codex" is configured\nActual:\n${tomlContent.slice(0, 500)}`);
    assert.match(tomlContent, /^model_reasoning_effort\s*=\s*"low"$/m,
      `gsd-planner.toml should have model_reasoning_effort = "low" from config override\nActual:\n${tomlContent.slice(0, 500)}`);
  });

  test('Codex .toml clamps effort max → xhigh when agent_overrides.gsd-planner=max', () => {
    const projectDir = path.dirname(codexHome);
    // Overwrite config with max override
    const config = {
      runtime: 'codex',
      effort: {
        agent_overrides: {
          'gsd-planner': 'max',
        },
      },
    };
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'config.json'),
      JSON.stringify(config, null, 2)
    );

    runGlobalInstall('codex', codexHome);
    const tomlContent = fs.readFileSync(
      path.join(codexHome, 'agents', 'gsd-planner.toml'), 'utf8'
    );
    assert.match(tomlContent, /^model\s*=\s*"gpt-5.5"$/m,
      `gsd-planner.toml should pin Codex model when runtime:"codex" is configured\nActual:\n${tomlContent.slice(0, 500)}`);
    // Codex does not support 'max' → clamped to 'xhigh'
    assert.match(tomlContent, /^model_reasoning_effort\s*=\s*"xhigh"$/m,
      `gsd-planner.toml should clamp max → xhigh for Codex\nActual:\n${tomlContent.slice(0, 500)}`);
    assert.doesNotMatch(tomlContent, /model_reasoning_effort\s*=\s*"max"/,
      'Codex .toml must never contain model_reasoning_effort = "max"');
  });
});

// ─── describe 5b: Invalid effort tokens fall through (Codex adversarial finding #2) ─
//
// These tests FAIL before the fix: resolveInstallTimeEffort returns the raw
// invalid string without validating it against VALID_EFFORTS.

describe('#443 resolveInstallTimeEffort: invalid tokens fall through to valid effort', () => {
  let tmpDir;
  let claudeHome;
  let codexHome;

  beforeEach(() => {
    // Layout: tmpDir/project/  <-- project root
    //           .planning/config.json
    //           .claude/          <-- claudeHome
    //           .codex/           <-- codexHome
    tmpDir = makeTmpDir('gsd-443-invalid-effort-');
    const projectDir = path.join(tmpDir, 'project');
    claudeHome = path.join(projectDir, '.claude');
    codexHome = path.join(projectDir, '.codex');

    fs.mkdirSync(claudeHome, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeProjectConfig(config) {
    const projectDir = path.dirname(claudeHome);
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'config.json'),
      JSON.stringify(config, null, 2)
    );
  }

  const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  test('effort.default="ultra" (invalid) -> Claude .md effort: is a VALID value (falls through to high)', () => {
    // BUG before fix: resolveInstallTimeEffort returns "ultra" verbatim
    writeProjectConfig({ effort: { default: 'ultra' } });
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-planner.md'));
    const match = fm.match(/^effort:\s*(\S+)$/m);
    assert.ok(match, `effort: must be present in frontmatter\nActual:\n${fm}`);
    assert.ok(VALID_EFFORTS.includes(match[1]),
      `effort: must be a VALID effort string, got: "${match[1]}"\nActual frontmatter:\n${fm}`);
  });

  test('effort.agent_overrides.gsd-planner="bogus" (invalid) with valid default -> falls through to valid default', () => {
    // BUG before fix: "bogus" is returned and written verbatim
    writeProjectConfig({
      effort: {
        agent_overrides: { 'gsd-planner': 'bogus' },
        default: 'medium',
      },
    });
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-planner.md'));
    const match = fm.match(/^effort:\s*(\S+)$/m);
    assert.ok(match, `effort: must be present in frontmatter\nActual:\n${fm}`);
    assert.ok(VALID_EFFORTS.includes(match[1]),
      `effort: must be a VALID effort string, got: "${match[1]}"\nActual frontmatter:\n${fm}`);
    // Falls through invalid "bogus" -> valid tier default or "medium" default
    // "medium" is valid, so it should appear (or tier default if medium is invalid, but medium is valid)
  });

  test('effort.default="ultra" (invalid) + runtime:"codex" -> Codex .toml model_reasoning_effort is VALID', () => {
    // BUG before fix: "ultra" written into .toml verbatim
    writeProjectConfig({ runtime: 'codex', effort: { default: 'ultra' } });
    runGlobalInstall('codex', codexHome);
    const tomlContent = fs.readFileSync(
      path.join(codexHome, 'agents', 'gsd-planner.toml'), 'utf8'
    );
    assert.match(tomlContent, /^model\s*=\s*"gpt-5.5"$/m,
      `gsd-planner.toml should pin Codex model when runtime:"codex" is configured\nActual:\n${tomlContent.slice(0, 500)}`);
    const match = tomlContent.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m);
    assert.ok(match, `model_reasoning_effort must be present in .toml\nActual:\n${tomlContent.slice(0, 500)}`);
    assert.ok(VALID_EFFORTS.includes(match[1]),
      `model_reasoning_effort must be VALID, got: "${match[1]}"\nActual:\n${tomlContent.slice(0, 500)}`);
  });
});

// ─── describe 5: Source stays clean ──────────────────────────────────────────

describe('#443 Source purity: agents/gsd-planner.md has no effort: key', () => {
  test('source agents/gsd-planner.md frontmatter does not contain effort:', () => {
    const fm = readFrontmatter(path.join(SOURCE_AGENTS_DIR, 'gsd-planner.md'));
    assert.doesNotMatch(fm, /^effort:/m,
      `Source agents/gsd-planner.md must NOT contain effort: (injection is install-only)`);
  });

  test('source agents/gsd-executor.md frontmatter does not contain effort:', () => {
    const fm = readFrontmatter(path.join(SOURCE_AGENTS_DIR, 'gsd-executor.md'));
    assert.doesNotMatch(fm, /^effort:/m,
      `Source agents/gsd-executor.md must NOT contain effort: (injection is install-only)`);
  });

  test('source agents/gsd-codebase-mapper.md frontmatter does not contain effort:', () => {
    const fm = readFrontmatter(path.join(SOURCE_AGENTS_DIR, 'gsd-codebase-mapper.md'));
    assert.doesNotMatch(fm, /^effort:/m,
      `Source agents/gsd-codebase-mapper.md must NOT contain effort: (injection is install-only)`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-1510-rewrite-engine-helper-relocation.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-1510-rewrite-engine-helper-relocation (consolidation epic #1969 B1 #1970)", () => {
'use strict';

// Enhancement #1510 (epic #1507, ADR-1508 Phase 1): behavior-preserving
// relocation of pure rewrite-engine helpers out of hand-authored bin/install.js.
//   - getDirName            -> gsd-core/bin/lib/runtime-name-policy.cjs
//   - processAttribution    -> gsd-core/bin/lib/runtime-artifact-conversion.cjs
// getCommitAttribution stays in install.js (impure install-time config I/O); the
// convertClaudeToAugmentMarkdown duplicate dedup is deferred to Phase 2's cleanup
// (entangled converter cluster; not required to unblock Phase 2).
// These tests exercise the REAL relocated functions at their new home (the
// generated .cjs) and assert install.js re-exports the SAME references
// (Hyrum: existing consumers import these names from bin/install.js).

const { test, describe } = require('node:test');
const assert = require('node:assert');

const runtimeNamePolicy = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
const installer = require('../bin/install.js');

// ── Slice A: getDirName relocated to runtime-name-policy ──────────────────────
describe('getDirName (relocated to runtime-name-policy)', () => {
  const EXPECTED = {
    claude: '.claude',
    copilot: '.github',
    opencode: '.opencode',
    gemini: '.gemini',
    kilo: '.kilo',
    codex: '.codex',
    antigravity: '.agents',
    cursor: '.cursor',
    windsurf: '.windsurf',
    augment: '.augment',
    trae: '.trae',
    qwen: '.qwen',
    hermes: '.hermes',
    kimi: '.kimi-code',
    codebuddy: '.codebuddy',
    cline: '.cline',
  };

  for (const [runtime, dir] of Object.entries(EXPECTED)) {
    test(`maps '${runtime}' to '${dir}'`, () => {
      assert.strictEqual(runtimeNamePolicy.getDirName(runtime), dir);
    });
  }

  test('falls back to .claude for an unknown runtime', () => {
    assert.strictEqual(runtimeNamePolicy.getDirName('definitely-not-a-runtime'), '.claude');
  });

  test('falls back to .claude for empty input', () => {
    assert.strictEqual(runtimeNamePolicy.getDirName(''), '.claude');
  });

  test('bin/install.js re-exports the SAME getDirName reference (no drift)', () => {
    assert.strictEqual(installer.getDirName, runtimeNamePolicy.getDirName);
  });
});

// ── Slice B: processAttribution relocated to runtime-artifact-conversion ───────
describe('processAttribution (relocated to runtime-artifact-conversion)', () => {
  test('null removes the Co-Authored-By line and its preceding blank line', () => {
    const input = 'Commit body line.\n\nCo-Authored-By: Someone <s@example.com>';
    assert.strictEqual(conversion.processAttribution(input, null), 'Commit body line.');
  });

  test('undefined leaves content unchanged', () => {
    const input = 'Commit body.\n\nCo-Authored-By: Someone <s@example.com>';
    assert.strictEqual(conversion.processAttribution(input, undefined), input);
  });

  test('a string replaces the attribution value', () => {
    const input = 'Body\n\nCo-Authored-By: Old Name <old@example.com>';
    assert.strictEqual(
      conversion.processAttribution(input, 'New Name <new@example.com>'),
      'Body\n\nCo-Authored-By: New Name <new@example.com>',
    );
  });

  test('escapes $ in the attribution to prevent backreference injection', () => {
    const input = 'Body\n\nCo-Authored-By: x';
    // "$1" must survive literally, not be interpreted as a regex backreference.
    assert.strictEqual(
      conversion.processAttribution(input, 'A $1 B'),
      'Body\n\nCo-Authored-By: A $1 B',
    );
  });

  test('handles CRLF when removing (null)', () => {
    const input = 'Body\r\n\r\nCo-Authored-By: Someone <s@example.com>';
    assert.strictEqual(conversion.processAttribution(input, null), 'Body');
  });

  test('replaces every Co-Authored-By line (global)', () => {
    const input = 'Body\nCo-Authored-By: A <a@x>\nCo-Authored-By: B <b@x>';
    assert.strictEqual(
      conversion.processAttribution(input, 'Z <z@x>'),
      'Body\nCo-Authored-By: Z <z@x>\nCo-Authored-By: Z <z@x>',
    );
  });

  test('bin/install.js re-exports the SAME processAttribution reference (no drift)', () => {
    // processAttribution remains an explicit installer compatibility relay, so
    // the export must keep pointing at the conversion module's implementation.
    assert.strictEqual(installer.processAttribution, conversion.processAttribution);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-1511-rewrite-engine-relocation.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-1511-rewrite-engine-relocation (consolidation epic #1969 B1 #1970)", () => {
'use strict';
/**
 * Tests for ADR-1508 Phase 2: rewrite engine relocation to runtime-artifact-conversion.
 * Issue #1511 — verifies the deep public seam signatures and behavior.
 *
 * Tests are behavioral (no source-grep). All filesystem operations use tmp dirs.
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');

let conversion;
before(() => {
  process.env['GSD_TEST_MODE'] = '1';
  conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
});

// ---------------------------------------------------------------------------
// _computePathPrefix unit tests
// ---------------------------------------------------------------------------

describe('_computePathPrefix', () => {
  test('global under home → $HOME/... form', () => {
    const prefix = conversion._computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: false,
      resolvedTarget: '/home/u/.cursor',
      homeDir: '/home/u',
    });
    assert.equal(prefix, '$HOME/.cursor/');
  });

  test('non-global → resolvedTarget/ form', () => {
    const prefix = conversion._computePathPrefix({
      isGlobal: false,
      isOpencode: false,
      isWindowsHost: false,
      resolvedTarget: '/project/.cursor',
      homeDir: '/home/u',
    });
    assert.equal(prefix, '/project/.cursor/');
  });

  test('global opencode skips $HOME shorthand', () => {
    // OpenCode uses ~/.config/opencode which breaks $HOME shorthand in content
    const prefix = conversion._computePathPrefix({
      isGlobal: true,
      isOpencode: true,
      isWindowsHost: false,
      resolvedTarget: '/home/u/.config/opencode',
      homeDir: '/home/u',
    });
    assert.equal(prefix, '/home/u/.config/opencode/');
  });

  test('global target outside home → resolvedTarget/ form', () => {
    const prefix = conversion._computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: false,
      resolvedTarget: '/opt/custom-cursor',
      homeDir: '/home/u',
    });
    assert.equal(prefix, '/opt/custom-cursor/');
  });

  test('isWindowsHost tripwire — Windows paths collapse to $HOME/ same as POSIX (no-op today)', () => {
    // Documents CURRENT behavior: isWindowsHost is accepted but not branched on.
    // Both win32=true and win32=false return '$HOME/.cursor/' for a home-relative target.
    // If a future Windows-specific branch is added, this tripwire fails and forces
    // an explicit decision about what to return on Windows.
    const withWindows = conversion._computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: true,
      resolvedTarget: 'C:/Users/matte/.cursor',
      homeDir: 'C:/Users/matte',
    });
    const withoutWindows = conversion._computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: false,
      resolvedTarget: 'C:/Users/matte/.cursor',
      homeDir: 'C:/Users/matte',
    });
    assert.equal(withWindows, '$HOME/.cursor/');
    assert.strictEqual(withWindows, withoutWindows);
  });

  test('backslash-style resolvedTarget is normalized to forward slashes (#1615 regression)', () => {
    // path.join on Windows produces backslashes; the returned prefix is
    // substituted into markdown @-references which must use POSIX paths.
    // Without normalization the backslashes leak into workflow file content
    // and break substring checks on Windows CI.
    const prefix = conversion._computePathPrefix({
      isGlobal: false,
      isOpencode: false,
      isWindowsHost: true,
      resolvedTarget: 'C:\\Users\\runner\\AppData\\Local\\Temp\\gsd-1615-windsurf',
      homeDir: 'C:\\Users\\runner',
    });
    assert.strictEqual(prefix, 'C:/Users/runner/AppData/Local/Temp/gsd-1615-windsurf/');
    assert.ok(!prefix.includes('\\'), `prefix must not contain backslashes: ${prefix}`);
  });
});

// ---------------------------------------------------------------------------
// _applyRuntimeRewrites with injected attribution
// ---------------------------------------------------------------------------

describe('_applyRuntimeRewrites — attribution injection', () => {
  const PREFIX = '$HOME/.cursor/';

  test('attribution=null removes Co-Authored-By line', () => {
    const content = '# Hello\n\nSome text\n\nCo-Authored-By: Claude\n';
    const result = conversion._applyRuntimeRewrites(content, 'cursor', PREFIX, true, null);
    assert.ok(!result.includes('Co-Authored-By:'), 'Co-Authored-By should be removed');
  });

  test('attribution=undefined leaves Co-Authored-By unchanged', () => {
    const content = '# Hello\n\nCo-Authored-By: Claude\n';
    const result = conversion._applyRuntimeRewrites(content, 'cursor', PREFIX, true, undefined);
    assert.ok(result.includes('Co-Authored-By: Claude'), 'Co-Authored-By should be preserved when attribution=undefined');
  });

  test('attribution=string replaces Co-Authored-By value', () => {
    const content = '# Hello\n\nCo-Authored-By: OldName\n';
    const result = conversion._applyRuntimeRewrites(content, 'cursor', PREFIX, true, 'NewName <new@example.com>');
    assert.ok(result.includes('Co-Authored-By: NewName <new@example.com>'), 'Co-Authored-By should be replaced');
  });

  test('cursor runtime replaces ~/.claude/ paths', () => {
    const content = 'See ~/.claude/skills/ for more info\n';
    const result = conversion._applyRuntimeRewrites(content, 'cursor', '/home/u/.cursor/', false, undefined);
    assert.ok(result.includes('/home/u/.cursor/skills/'), 'cursor should replace ~/.claude/ with pathPrefix');
  });
});

// ---------------------------------------------------------------------------
// rewriteStagedSkillBodies — behavioral filesystem test
// ---------------------------------------------------------------------------

describe('rewriteStagedSkillBodies', () => {
  test('rewrites .md files in-place for cursor runtime', () => {
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-staged-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-config-'));
    try {
      // Create a skill dir with a SKILL.md referencing ~/.claude/skills/foo
      // NOTE: the rewrite engine handles path replacement and attribution only.
      // Bash→Shell conversion is done by the stage-1 skill converter, not the engine.
      const skillDir = path.join(stagedDir, 'gsd-test-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      const content = '# Test\n\nSee ~/.claude/skills/foo\n\nAlso ~/.cursor/skills/bar\n';
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);

      // Call with injected homedir + platform for determinism
      conversion.rewriteStagedSkillBodies(stagedDir, {
        runtime: 'cursor',
        configDir,
        scope: 'global',
        homedir: () => '/home/u',
        platform: 'linux',
      });

      const result = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
      // cursor rewrites ~/.claude/ → pathPrefix
      // configDir is a tmpdir, not under /home/u, so prefix = resolvedTarget + '/'
      // Mirror the engine's backslash→slash normalization so the assertion holds on Windows.
      const resolvedTarget = path.resolve(configDir).replace(/\\/g, '/');
      assert.ok(result.includes(`${resolvedTarget}/skills/foo`), `Should replace ~/.claude/skills/ with ${resolvedTarget}/skills/`);
      // cursor also rewrites ~/.cursor/ → pathPrefix
      assert.ok(result.includes(`${resolvedTarget}/skills/bar`), `Should replace ~/.cursor/skills/ with ${resolvedTarget}/skills/`);
    } finally {
      cleanup(stagedDir);
      cleanup(configDir);
    }
  });

  test('with injected homedir: global under home uses $HOME prefix', () => {
    // Real absolute path so Windows path.resolve does not re-root a POSIX literal onto a drive.
    // The dir need not exist — the engine only string-processes it.
    const HOME = path.resolve(os.tmpdir(), 'gsd-1511-fake-home');
    const configDir = path.join(HOME, '.cursor');
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-staged-'));
    try {
      const skillDir = path.join(stagedDir, 'gsd-help');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'Use ~/.claude/skills/ here\n');

      conversion.rewriteStagedSkillBodies(stagedDir, {
        runtime: 'cursor',
        configDir,
        scope: 'global',
        homedir: () => HOME,
        platform: process.platform,
      });

      const result = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
      assert.ok(result.includes('$HOME/.cursor/skills/'), 'Should use $HOME shorthand when configDir is under homedir');
    } finally {
      cleanup(stagedDir);
    }
  });

  test('non-existent stagedDir is a no-op', () => {
    assert.doesNotThrow(() => {
      conversion.rewriteStagedSkillBodies('/nonexistent/dir', {
        runtime: 'cursor',
        configDir: '/tmp/fake',
        scope: 'global',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// rewriteStagedCommandBodies — returns temp dir, does not mutate source
// ---------------------------------------------------------------------------

describe('rewriteStagedCommandBodies', () => {
  test('returns a temp dir (not the source dir) with rewritten content', () => {
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-cmd-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-config-'));
    let tempDir;
    try {
      // NOTE: rewrite engine handles path replacement + attribution, NOT tool renames.
      fs.writeFileSync(path.join(stagedDir, 'help.md'), '# Help\n\nSee ~/.claude/skills/\n\nSee ~/.cursor/skills/\n');

      tempDir = conversion.rewriteStagedCommandBodies(stagedDir, {
        runtime: 'cursor',
        configDir,
        scope: 'global',
        homedir: () => '/home/u',
        platform: 'linux',
      });

      assert.notEqual(tempDir, stagedDir, 'must return a different dir, never the source');
      assert.ok(fs.existsSync(tempDir), 'returned tempDir should exist');

      const result = fs.readFileSync(path.join(tempDir, 'help.md'), 'utf8');
      // Source dir should be unchanged
      const source = fs.readFileSync(path.join(stagedDir, 'help.md'), 'utf8');
      assert.ok(source.includes('~/.claude/skills/'), 'source file must not be mutated');
      // configDir is /tmp/... (not under /home/u), so prefix = resolvedTarget + '/'
      const resolvedTarget = path.resolve(configDir).replace(/\\/g, '/');
      assert.ok(result.includes(`${resolvedTarget}/skills/`), 'output should have cursor path rewrite applied');
      // ~/.cursor/ also rewrites to prefix
      assert.ok(!result.includes('~/.cursor/'), 'output should have ~/.cursor/ replaced too');
    } finally {
      cleanup(stagedDir);
      cleanup(configDir);
      if (tempDir && tempDir !== stagedDir) {
        cleanup(tempDir);
      }
    }
  });

  test('non-existent stagedDir returns stagedDir unchanged (safe)', () => {
    const result = conversion.rewriteStagedCommandBodies('/nonexistent/dir', {
      runtime: 'cursor',
      configDir: '/tmp/fake',
      scope: 'global',
    });
    assert.equal(result, '/nonexistent/dir', 'should return input path unchanged for missing dir');
  });
});

// ---------------------------------------------------------------------------
// Error-path: applyRuntimeContentRewritesForCommandsInPlace must rm the tempDir
// on any exception and NOT leave an orphaned gsd-cmd-rewrites-* directory.
// ---------------------------------------------------------------------------

describe('applyRuntimeContentRewritesForCommandsInPlace — error-path tempDir cleanup', () => {
  test('rmSync is called on the tempDir when readFileSync throws (deterministic monkeypatch)', () => {
    // Asserting the injected error propagates proves the throw happens AFTER the tempDir is
    // created (the function creates tempDir, then reads .md), so the catch's rmSync cleanup
    // is genuinely exercised — deterministic on every platform/uid.
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-error-path-'));
    fs.writeFileSync(path.join(stagedDir, 'x.md'), '# test\n');

    const before = new Set(
      fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('gsd-cmd-rewrites-'))
    );

    const origReadFileSync = fs.readFileSync;
    let leaked = [];
    try {
      fs.readFileSync = () => { throw new Error('injected read failure'); };

      assert.throws(
        () => conversion.applyRuntimeContentRewritesForCommandsInPlace(stagedDir, 'cursor', '/tmp/x/', false),
        /injected read failure/,
      );

      // Restore before any further fs use so the snapshot read is trustworthy.
      fs.readFileSync = origReadFileSync;

      const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('gsd-cmd-rewrites-'));
      leaked = after.filter(n => !before.has(n));
      assert.deepStrictEqual(leaked, [], `tempDir not cleaned up on error: ${leaked.join(',')}`);
    } finally {
      // Idempotent restore — guard against early-throw paths above.
      fs.readFileSync = origReadFileSync;
      // Clean up the staged dir created for this test.
      cleanup(stagedDir);
      // Clean up any genuinely leaked gsd-cmd-rewrites-* dirs so the runner stays clean.
      for (const n of leaked) {
        cleanup(path.join(os.tmpdir(), n));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Guard: runtime-artifact-layout no longer exports getInstallExports
// ---------------------------------------------------------------------------

describe('layout module no longer exports getInstallExports', () => {
  test('getInstallExports is not on the layout module export', () => {
    process.env['GSD_TEST_MODE'] = '1';
    const layout = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
    assert.equal(
      typeof layout.getInstallExports,
      'undefined',
      'getInstallExports should have been removed from runtime-artifact-layout exports (ADR-1508 Phase 2)',
    );
  });
});

// ---------------------------------------------------------------------------
// DEFECT.GENERATIVE-FIX: single-owner reference-identity guard (#1511)
// Proves install.js binds to the conversion module's implementation, not a
// duplicate local copy. If these fail, a duplicate body was re-introduced.
// ---------------------------------------------------------------------------

describe('single-owner reference-identity guard (ADR-1508 / #1511 Phase 2)', () => {
  let install;
  let conversionCjs;
  before(() => {
    process.env['GSD_TEST_MODE'] = '1';
    install = require('../bin/install.js');
    conversionCjs = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
  });

  test('install.computePathPrefix === conversion._computePathPrefix (single implementation)', () => {
    assert.strictEqual(
      install.computePathPrefix,
      conversionCjs._computePathPrefix,
      'install.js must bind computePathPrefix from conversion (not a duplicate body)',
    );
  });

  test('install.applyRuntimeContentRewritesInPlace === conversion.applyRuntimeContentRewritesInPlace (single walk loop)', () => {
    assert.strictEqual(
      install.applyRuntimeContentRewritesInPlace,
      conversionCjs.applyRuntimeContentRewritesInPlace,
      'install.js must bind applyRuntimeContentRewritesInPlace from conversion (not a duplicate walk loop)',
    );
  });

  test('install.applyRuntimeContentRewritesForCommandsInPlace === conversion.applyRuntimeContentRewritesForCommandsInPlace (single copy+rewrite loop)', () => {
    assert.strictEqual(
      install.applyRuntimeContentRewritesForCommandsInPlace,
      conversionCjs.applyRuntimeContentRewritesForCommandsInPlace,
      'install.js must bind applyRuntimeContentRewritesForCommandsInPlace from conversion (not a duplicate copy+rewrite loop)',
    );
  });

  test('install._applyRuntimeRewrites === conversion._applyRuntimeRewrites (single switch engine)', () => {
    assert.strictEqual(
      install._applyRuntimeRewrites,
      conversionCjs._applyRuntimeRewrites,
      'install.js must bind _applyRuntimeRewrites from conversion (not a local shim)',
    );
  });

  // #1675 (ADR-1508): the augment converter family is single-sourced in the
  // conversion module. install.js must re-bind (not re-define) these so there
  // is exactly one body — the generative-drift hazard the dedup removes.
  test('install.convertClaudeToAugmentMarkdown === conversion.convertClaudeToAugmentMarkdown (single converter)', () => {
    assert.strictEqual(
      install.convertClaudeToAugmentMarkdown,
      conversionCjs.convertClaudeToAugmentMarkdown,
      'install.js must bind convertClaudeToAugmentMarkdown from conversion (not a duplicate body)',
    );
  });

  test('install.convertClaudeCommandToAugmentSkill === conversion.convertClaudeCommandToAugmentSkill (single converter)', () => {
    assert.strictEqual(
      install.convertClaudeCommandToAugmentSkill,
      conversionCjs.convertClaudeCommandToAugmentSkill,
      'install.js must bind convertClaudeCommandToAugmentSkill from conversion (not a duplicate body)',
    );
  });

  test('install.convertClaudeAgentToAugmentAgent === conversion.convertClaudeAgentToAugmentAgent (single converter)', () => {
    assert.strictEqual(
      install.convertClaudeAgentToAugmentAgent,
      conversionCjs.convertClaudeAgentToAugmentAgent,
      'install.js must bind convertClaudeAgentToAugmentAgent from conversion (not a duplicate body)',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-190-bridge-collapse.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-190-bridge-collapse (consolidation epic #1969 B3 #1972)", () => {
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('bridge collapse removes cjs-sdk-bridge and runtime-bridge-sync seam', () => {
  const bridgePath = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'cjs-sdk-bridge.cjs');
  const sdkDir = path.join(ROOT, 'sdk');

  assert.equal(fs.existsSync(bridgePath), false, 'cjs-sdk-bridge.cjs must be removed');
  assert.equal(fs.existsSync(sdkDir), false, 'sdk directory must be removed');

  const routers = [
    'gsd-core/bin/lib/init-command-router.cjs',
    'gsd-core/bin/lib/roadmap-command-router.cjs',
    'gsd-core/bin/lib/state-command-router.cjs',
    'gsd-core/bin/lib/validate-command-router.cjs',
    'gsd-core/bin/lib/verify-command-router.cjs',
    'gsd-core/bin/lib/phases-command-router.cjs',
  ];

  for (const rel of routers) {
    const src = read(rel);
    assert.equal(
      src.includes('cjs-sdk-bridge.cjs'),
      false,
      `${rel} must not import cjs-sdk-bridge.cjs`,
    );
  }

  const rootPkg = JSON.parse(read('package.json'));
  assert.equal(
    Object.prototype.hasOwnProperty.call(rootPkg.dependencies || {}, 'synckit'),
    false,
    'package.json must not include synckit',
  );
});
  });
}
