'use strict';

/**
 * #4782 — compact agent variants must not stage into Claude's agents directory.
 *
 * The compact/canonical choice is made in code at init.cts's agent-skills
 * persona fallback, gated `runtime !== 'claude'` (claude's contract is a
 * skills-injection path, not a persona fallback). Staging the 29
 * `agents/*.compact.md` files into `.claude/agents/` therefore shipped dead
 * files whose `name:` frontmatter is byte-identical to their canonical
 * sibling's — the harness has to pick one and nothing states which (#4553
 * family). Claude is the one runtime whose agents kind skips them; every
 * other runtime's emission is byte-identical, and the existing
 * `_removeGsdEntries` prune (every `gsd-*` entry) cleans previously staged
 * compact copies on upgrade.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runMinimalInstall } = require('./helpers/install-shared.cjs');

const SOURCE_AGENTS_DIR = path.join(__dirname, '..', 'agents');
const listAgents = (agentsDir) => (fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : []);
const isCompact = (f) => f.endsWith('.compact.md');

describe('#4782 compact agent staging', () => {
  test('claude install stages no *.compact.md and leaves canonical agents intact', (t) => {
    const root = createTempDir('gsd-4782-clean-');
    t.after(() => cleanup(root));

    const { configDir } = runMinimalInstall({ runtime: 'claude', scope: 'global', root });
    assert.strictEqual(configDir, path.join(root, '.claude'));

    const staged = listAgents(path.join(configDir, 'agents'));
    const compact = staged.filter(isCompact);
    const canonical = staged.filter((f) => f.startsWith('gsd-') && f.endsWith('.md') && !isCompact(f));

    assert.deepStrictEqual(
      compact,
      [],
      `claude agents dir must not contain compact variants; got: ${compact.join(', ')}`,
    );
    const sourceCanonical = fs.readdirSync(SOURCE_AGENTS_DIR)
      .filter((f) => f.startsWith('gsd-') && f.endsWith('.md') && !isCompact(f));
    assert.strictEqual(
      canonical.length,
      sourceCanonical.length,
      `canonical agent count must be unchanged (source: ${sourceCanonical.length})`,
    );
  });

  test('claude install removes previously staged compact variants (upgrade over 1.14.0)', (t) => {
    const root = createTempDir('gsd-4782-upgrade-');
    t.after(() => cleanup(root));
    // Plant what a 1.14.0 install left behind: GSD-owned compact copies (one
    // real, one synthetic) next to the canonical agent.
    const agentsDir = path.join(root, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'gsd-doc-writer.compact.md'), '---\nname: gsd-doc-writer\n---\ncompact');
    fs.writeFileSync(path.join(agentsDir, 'gsd-zombie.compact.md'), '---\nname: gsd-zombie\n---\ncompact');

    const { configDir } = runMinimalInstall({ runtime: 'claude', scope: 'global', root });

    const staged = listAgents(path.join(configDir, 'agents'));
    assert.deepStrictEqual(
      staged.filter(isCompact),
      [],
      'the stale-agent prune must remove previously staged compact variants',
    );
    assert.ok(
      staged.includes('gsd-doc-writer.md'),
      'the canonical agent must still be staged',
    );
  });

  test('non-claude agents kinds still stage compact variants (opencode parity)', (t) => {
    const root = createTempDir('gsd-4782-opencode-');
    t.after(() => cleanup(root));

    const { configDir } = runMinimalInstall({ runtime: 'opencode', scope: 'global', root });

    const compact = listAgents(path.join(configDir, 'agents')).filter(isCompact);
    const sourceCompact = fs.readdirSync(SOURCE_AGENTS_DIR).filter(isCompact);
    assert.strictEqual(
      compact.length,
      sourceCompact.length,
      `opencode must still stage every compact variant (source: ${sourceCompact.length})`,
    );
  });
});
