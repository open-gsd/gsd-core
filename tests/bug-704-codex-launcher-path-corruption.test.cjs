// allow-test-rule: source-text-is-the-product
'use strict';

/**
 * Regression test for issue #704:
 * "v1.3.1 global install ships literal $gsd-core launcher paths in workflows"
 *
 * ROOT CAUSE: `convertSlashCommandsToCodexSkillMentions` had a regex
 *   /(?<![a-zA-Z0-9./])\/gsd-([a-z0-9-]+)/
 * The lookbehind did NOT include `}`, so shell variable expressions like
 *   `${_GSD_RUNTIME_ROOT}/gsd-core/bin/...`
 * had their `/gsd-core` matched (the char before `/` was `}`, not in the
 * exclusion set), converting it to `$gsd-core` and breaking all Codex
 * workflow launcher paths.
 *
 * FIX: Add `}` to the lookbehind set so `${VAR}/gsd-core/` is excluded.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { convertClaudeCommandToCodexSkill } = require('../bin/install.js');

// The canonical launcher snippet path that was being corrupted
const RUNTIME_ROOT_PATH = '${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}';
// The exact bad token reported in issue #704
const BAD_TOKEN = '$gsd-core';

describe('#704 — Codex global install launcher path corruption', () => {
  test('convertClaudeCommandToCodexSkill does not corrupt ${VAR}/gsd-core/ or $(cmd)/gsd-* paths', () => {
    // Minimal fixture with the launcher snippet and command-substitution patterns
    // that were being corrupted (#704).
    const input = [
      '---',
      'description: Test skill',
      '---',
      '',
      '```bash',
      '_GSD_SHIM_NAME="gsd-tools.cjs"',
      '_GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"',
      'GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"',
      'if [ -f "$GSD_TOOLS" ]; then',
      '  gsd_run() { node "$GSD_TOOLS" "$@"; }',
      'elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then',
      '  GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"',
      '  gsd_run() { node "$GSD_TOOLS" "$@"; }',
      'elif [ -f "$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then',
      '  GSD_TOOLS="$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"',
      '  gsd_run() { node "$GSD_TOOLS" "$@"; }',
      'fi',
      '# Command-substitution path form (reapply-patches pattern)',
      'candidate="$(expand_home "$KILO_CONFIG_DIR")/gsd-local-patches"',
      '```',
    ].join('\n');

    const output = convertClaudeCommandToCodexSkill(input, 'gsd-test-704');

    // Shell-context corruption patterns from issue #704:
    //   - `}$gsd-*` from shell variable expressions `${VAR}/gsd-*`
    //   - `)$gsd-*` from command-substitution paths `$(cmd)/gsd-*`
    const shellCorruptionPatterns = [
      { pattern: '}' + BAD_TOKEN, description: 'shell-variable }$gsd-core' },
      { pattern: ')$gsd-local', description: 'command-substitution )$gsd-local-patches' },
    ];
    for (const { pattern, description } of shellCorruptionPatterns) {
      assert.ok(
        !output.includes(pattern),
        `Codex skill conversion must not produce "${pattern}" (${description}). ` +
          `Offending fragment: ${
            output.includes(pattern)
              ? output.substring(output.indexOf(pattern) - 50, output.indexOf(pattern) + 80)
              : '(not found)'
          }`,
      );
    }

    // The correct path forms must be preserved
    assert.ok(
      output.includes('}/gsd-core/bin/'),
      `Expected "${'}' + '/gsd-core/bin/'}" to appear in the converted output. ` +
        `Got:\n${output.substring(0, 500)}`,
    );
    assert.ok(
      output.includes(')/gsd-local-patches'),
      `Expected ")/gsd-local-patches" to appear in the converted output. ` +
        `Got:\n${output.substring(0, 500)}`,
    );
  });

  test('convertClaudeCommandToCodexSkill preserves all shell path forms (}, ) closers)', () => {
    // All these paths appear after a shell-closing character (} or )) and must
    // NOT be converted to $gsd-* by the Codex slash-command converter.
    const shellPaths = [
      // Shell variable expression forms (} closer)
      { path: '"${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"', corruptedForm: '}$gsd-core' },
      { path: '"${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"', corruptedForm: '}$gsd-core' },
      { path: '"$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"', corruptedForm: '}$gsd-core' },
      // Command-substitution forms () closer) — reapply-patches pattern
      { path: 'candidate="$(expand_home "$KILO_CONFIG_DIR")/gsd-local-patches"', corruptedForm: ')$gsd-local' },
      { path: 'candidate="$(dirname "$(expand_home "$OPENCODE_CONFIG")")/gsd-local-patches"', corruptedForm: ')$gsd-local' },
    ];

    for (const { path: p, corruptedForm } of shellPaths) {
      const input = `---\ndescription: Test\n---\n\n\`\`\`bash\n${p}\n\`\`\``;
      const output = convertClaudeCommandToCodexSkill(input, 'gsd-test-704-paths');
      assert.ok(
        !output.includes(corruptedForm),
        `Path "${p}" was corrupted to contain "${corruptedForm}" after Codex conversion.\n` +
          `Got:\n${output}`,
      );
    }
  });

  test('convertClaudeCommandToCodexSkill still converts legitimate /gsd-<cmd> slash mentions', () => {
    // Slash-command mentions (not preceded by }) should still be converted
    const input = [
      '---',
      'description: Test',
      '---',
      '',
      'Use /gsd-discuss-phase to start a discussion.',
      'Or use /gsd-plan-phase for planning.',
      'Also: /gsd:capture --backlog adds items.',
    ].join('\n');

    const output = convertClaudeCommandToCodexSkill(input, 'gsd-test-704-cmds');

    assert.ok(
      output.includes('$gsd-discuss-phase'),
      'Expected /gsd-discuss-phase to be converted to $gsd-discuss-phase',
    );
    assert.ok(
      output.includes('$gsd-plan-phase'),
      'Expected /gsd-plan-phase to be converted to $gsd-plan-phase',
    );
    assert.ok(
      output.includes('$gsd-capture'),
      'Expected /gsd:capture to be converted to $gsd-capture',
    );
  });

  test('actual shipped workflow files: shell-variable launcher paths contain no $gsd-core', () => {
    // Walk gsd-core/workflows/ and assert that no file produces $gsd-core
    // inside a shell variable expansion context after Codex conversion.
    //
    // NOTE: The regex `/(?<![a-zA-Z0-9./}])\/gsd-/` still converts backtick-
    // wrapped prose paths like `\`/gsd-core/workflows/update.md\`` (a pre-existing
    // issue separate from #704 — update.md's backtick is not in the lookbehind
    // set). That prose-path case is intentionally excluded from this assertion
    // (tracked separately; the primary #704 bug is the shell-variable expansion).
    //
    // We probe for the specific shell-context pattern from the issue report:
    //   BAD:  ${_GSD_RUNTIME_ROOT}$gsd-core/bin/
    //   GOOD: ${_GSD_RUNTIME_ROOT}/gsd-core/bin/
    const workflowsDir = path.join(__dirname, '..', 'gsd-core', 'workflows');
    if (!fs.existsSync(workflowsDir)) {
      // If the directory doesn't exist, skip gracefully (non-standard layout)
      return;
    }

    const files = fs.readdirSync(workflowsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(workflowsDir, f));

    assert.ok(files.length > 0, 'Expected at least one workflow .md file');

    // Shell-context corruption patterns from issue #704:
    //   - `}$gsd-*`: closing brace from `${VAR}/gsd-*` shell variable expressions
    //   - `)$gsd-*`: closing paren from `$(cmd)/gsd-*` command substitutions
    const SHELL_CORRUPTION_RE = /[})](\$gsd-[a-z])/;

    const offending = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const skillName = `gsd-${path.basename(file, '.md')}`;
      const converted = convertClaudeCommandToCodexSkill(content, skillName);
      const match = converted.match(SHELL_CORRUPTION_RE);
      if (match) {
        const idx = converted.indexOf(match[0]);
        offending.push({
          file: path.relative(workflowsDir, file),
          context: converted.substring(Math.max(0, idx - 40), idx + 80),
        });
      }
    }

    assert.deepStrictEqual(
      offending,
      [],
      `Found shell-context path corruption ([})]$gsd-*) in Codex-converted workflow files (#704):\n` +
        offending.map((o) => `  ${o.file}: ...${o.context}...`).join('\n'),
    );
  });

  test('commands/gsd/*.md: shell-variable launcher paths contain no $gsd-core', () => {
    // Walk commands/gsd/ and assert that no command file produces the shell-context
    // }$gsd-core corruption — since commands also go through
    // convertClaudeCommandToCodexSkill when installed globally for Codex.
    const commandsDir = path.join(__dirname, '..', 'commands', 'gsd');
    if (!fs.existsSync(commandsDir)) return;

    const files = fs.readdirSync(commandsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(commandsDir, f));

    assert.ok(files.length > 0, 'Expected at least one command .md file');

    const SHELL_CORRUPTION_RE = /[})](\$gsd-[a-z])/;

    const offending = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const skillName = `gsd-${path.basename(file, '.md')}`;
      const converted = convertClaudeCommandToCodexSkill(content, skillName);
      const match = converted.match(SHELL_CORRUPTION_RE);
      if (match) {
        const idx = converted.indexOf(match[0]);
        offending.push({
          file: path.relative(commandsDir, file),
          context: converted.substring(Math.max(0, idx - 40), idx + 80),
        });
      }
    }

    assert.deepStrictEqual(
      offending,
      [],
      `Found shell-context path corruption ([})]$gsd-*) in Codex-converted command files (#704):\n` +
        offending.map((o) => `  ${o.file}: ...${o.context}...`).join('\n'),
    );
  });
});
