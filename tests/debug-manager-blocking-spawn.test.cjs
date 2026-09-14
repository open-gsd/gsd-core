// Shipped agent Markdown is the installed contract: the runtime reads these
// files and performs the Agent() spawns they describe, so the shipped text is
// the subject under test.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readFileNormalized } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, 'agents');
const MANAGER = path.join(AGENTS_DIR, 'gsd-debug-session-manager.md');
const MANAGER_COMPACT = path.join(AGENTS_DIR, 'gsd-debug-session-manager.compact.md');
const DEBUG_WORKFLOW = path.join(ROOT, 'gsd-core', 'workflows', 'debug.md');

// Pull out each `Agent( … )` call literally, so a row asserts against the
// shipped spawn rather than against a pattern retyped from the fix.
function agentSpawnBlocks(content) {
  const blocks = [];
  const re = /Agent\(\s*\n([\s\S]*?)\n\)/g;
  let m;
  while ((m = re.exec(content)) !== null) blocks.push(m[0]);
  return blocks;
}

function debuggerSpawn(content, label) {
  const matches = agentSpawnBlocks(content).filter((b) => b.includes('subagent_type="gsd-debugger"'));
  assert.equal(matches.length, 1, `${label}: expected exactly one gsd-debugger spawn block`);
  return matches[0];
}

describe('debug session manager: the debugger spawn must block (#4395)', () => {
  // ROW 1 + 2 — the reported defect, in both shipped variants.
  for (const [label, file] of [['full', MANAGER], ['compact', MANAGER_COMPACT]]) {
    test(`${label} variant spawns gsd-debugger with run_in_background: false`, () => {
      const spawn = debuggerSpawn(readFileNormalized(file), `${label} variant`);
      // Claude Code backgrounds subagents by DEFAULT — debug.md:209 (#2196) says
      // so outright. Without the flag the manager's Step 3 ("Handle Agent
      // Return") has no return to inspect, so it emits CONTINUE_REQUIRED, the
      // orchestrator auto-resumes, and a second detached debugger races the
      // first on .planning/debug/<slug>.md.
      assert.match(
        spawn,
        /run_in_background:\s*false/,
        `${label} variant: the debugger spawn must be blocking, or the manager cannot see its result`,
      );
    });
  }

  // ROW 3 — the pair cannot drift apart.
  test('both variants agree on the debugger spawn flag', () => {
    const full = debuggerSpawn(readFileNormalized(MANAGER), 'full variant');
    const compact = debuggerSpawn(readFileNormalized(MANAGER_COMPACT), 'compact variant');
    const flagOf = (s) => (s.match(/run_in_background:\s*(true|false)/) || [])[1];
    // Assert the flag is PRESENT before asserting agreement: two missing flags
    // are also "equal", so a bare equality check passes vacuously on the very
    // tree this test exists to reject.
    assert.ok(flagOf(full), 'full variant must declare the flag at all');
    assert.ok(flagOf(compact), 'compact variant must declare the flag at all');
    assert.equal(
      flagOf(compact),
      flagOf(full),
      'the compact sibling must not diverge from the canonical agent on spawn semantics',
    );
  });

  // ROW 4 — close the CLASS, not just this instance.
  test('every subagent spawn under agents/ declares run_in_background explicitly', () => {
    const offenders = [];
    for (const name of fs.readdirSync(AGENTS_DIR)) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(AGENTS_DIR, name);
      for (const block of agentSpawnBlocks(readFileNormalized(file))) {
        if (!block.includes('subagent_type=')) continue;
        if (!/run_in_background:\s*(true|false)/.test(block)) {
          offenders.push(`${name}: ${block.split('\n').find((l) => l.includes('subagent_type=')).trim()}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'An agent that spawns a subagent must DECIDE whether that spawn blocks. ' +
      'Leaving it unstated inherits the host default (Claude Code backgrounds ' +
      'subagents), which is how #4395 produced colliding debuggers.\n  ' +
      offenders.join('\n  '),
    );
  });

  // ROW 5 — the fix one level up is undisturbed.
  test('the orchestrator to session-manager hop still mandates a blocking spawn (#2196)', () => {
    const workflow = readFileNormalized(DEBUG_WORKFLOW);
    assert.match(
      workflow,
      /run_in_background:\s*false`\s*—\s*Claude Code backgrounds subagents by default/,
      'debug.md must keep the #2196 mandate that the session-manager spawn blocks',
    );
  });

  // ROW 6 — Step 2 stays the single spawn-format source.
  test('continuation spawns delegate to Step 2 rather than inlining their own Agent() call', () => {
    const manager = readFileNormalized(MANAGER);
    const spawnBlocks = agentSpawnBlocks(manager).filter((b) => b.includes('subagent_type='));
    assert.equal(
      spawnBlocks.length,
      1,
      'exactly one Agent() spawn literal may exist — the continuation sites say "see Step 2 format", ' +
      'which is what makes fixing Step 2 fix all of them',
    );
    assert.match(manager, /see Step 2 format/, 'the continuation sites must still point at Step 2');
  });

  // ROW 7 — the non-terminal shape was not collaterally removed.
  test('CONTINUE_REQUIRED and both terminal markers survive', () => {
    const manager = readFileNormalized(MANAGER);
    // CONTINUE_REQUIRED has a legitimate trigger unrelated to this defect: the
    // manager genuinely exhausting its own turn budget mid-investigation.
    assert.match(manager, /## CONTINUE_REQUIRED/, 'the non-terminal marker must remain');
    assert.match(manager, /## DEBUG SESSION COMPLETE/, 'the terminal marker must remain');
    assert.match(manager, /ABANDONED/, 'the abandoned disposition must remain');
  });
});
