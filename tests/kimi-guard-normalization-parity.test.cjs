/**
 * Kimi guard-normalization parity test (#2304 / PR #2326 review Major 1).
 *
 * The KIMI_TOOL_NAMES map + normalizeKimiPayload helper is deliberately
 * inlined per hook script (a sibling require is a staging dependency that
 * can fail silently — see the rationale comment in each guard), which
 * leaves five hand-maintained copies plus their inverse in bin/install.js
 * (claudeToKimiTools / convertKimiToolName). Nothing at runtime binds them.
 *
 * This test is that binding, with zero runtime coupling:
 *   1. the five inlined copies are byte-identical;
 *   2. every entry in the guard map is the value-inverse of what the
 *      installer's matcher vocabulary emits for that Claude tool;
 *   3. every guard-relevant Claude tool the installer translates has a
 *      reverse entry — so a vocabulary extension or rename that updates
 *      convertKimiToolName without updating the guards fails HERE instead
 *      of leaving a guard silently dormant (the #2304 failure mode).
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { convertKimiToolName } = require('../bin/install.js');

const HOOK_FILES = [
  'hooks/gsd-prompt-guard.js',
  'hooks/gsd-read-guard.js',
  'hooks/gsd-worktree-path-guard.js',
  'hooks/gsd-read-injection-scanner.js',
  'hooks/gsd-workflow-guard.js',
];

// Claude tool names whose PreToolUse/PostToolUse guards are registered with a
// translated matcher on Kimi (runtime-hooks-surface.cts buildKimiHooksTomlBlock):
// the write guards match WriteFile|StrReplaceFile, the injection scanner
// matches ReadFile, and gsd-workflow-guard.js matches Shell|WriteFile|StrReplaceFile.
const GUARD_RELEVANT_CLAUDE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'Read', 'Bash'];

function extractBlock(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = src.indexOf('const KIMI_TOOL_NAMES');
  assert.notEqual(start, -1, `${file}: KIMI_TOOL_NAMES block not found`);
  const endMarker = '  return data;\n}';
  const end = src.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${file}: normalizeKimiPayload end not found`);
  return src.slice(start, end + endMarker.length);
}

function parseMap(block) {
  const m = block.match(/const KIMI_TOOL_NAMES = \{([^}]*)\};/);
  assert.ok(m, 'KIMI_TOOL_NAMES literal not parseable');
  const entries = {};
  for (const pair of m[1].split(',')) {
    const kv = pair.match(/\s*(\w+):\s*'(\w+)'/);
    if (kv) entries[kv[1]] = kv[2];
  }
  assert.ok(Object.keys(entries).length > 0, 'KIMI_TOOL_NAMES parsed empty');
  return entries;
}

describe('Kimi guard normalization parity', () => {
  test('all inlined copies of the normalization block are byte-identical', () => {
    const blocks = HOOK_FILES.map(extractBlock);
    for (let i = 1; i < blocks.length; i++) {
      assert.equal(
        blocks[i],
        blocks[0],
        `${HOOK_FILES[i]} normalization block diverges from ${HOOK_FILES[0]}`
      );
    }
  });

  test('guard map is the value-inverse of the installer matcher vocabulary', () => {
    const map = parseMap(extractBlock(HOOK_FILES[0]));
    for (const [kimiName, claudeName] of Object.entries(map)) {
      const modulePath = convertKimiToolName(claudeName);
      assert.ok(
        typeof modulePath === 'string' && modulePath.endsWith(`:${kimiName}`),
        `KIMI_TOOL_NAMES.${kimiName} -> '${claudeName}' is not the inverse of ` +
          `convertKimiToolName('${claudeName}') = ${modulePath}`
      );
    }
  });

  test('every guard-relevant Claude tool has a reverse entry (dormancy alarm)', () => {
    const map = parseMap(extractBlock(HOOK_FILES[0]));
    for (const claudeName of GUARD_RELEVANT_CLAUDE_TOOLS) {
      const modulePath = convertKimiToolName(claudeName);
      assert.ok(modulePath, `installer no longer maps ${claudeName} — update this test`);
      const kimiName = modulePath.slice(modulePath.lastIndexOf(':') + 1);
      assert.ok(
        map[kimiName] !== undefined,
        `Kimi name '${kimiName}' (from ${claudeName}) has no KIMI_TOOL_NAMES ` +
          `reverse entry — the matching guard would be silently dormant on Kimi (#2304)`
      );
    }
  });
});
