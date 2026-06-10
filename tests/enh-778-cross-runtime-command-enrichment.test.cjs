// allow-test-rule: source-text-is-the-product
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
