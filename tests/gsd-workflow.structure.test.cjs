'use strict';

/**
 * Structure / contract tests for the /gsd smart-entry command + workflow.
 *
 * Spec: docs/superpowers/specs/2026-06-27-gsd-smart-entry-design.md
 *
 * These assert the CONTRACT the markdown layer exposes — not implementation
 * logic — over the shipped artifacts: frontmatter completeness, size caps, the
 * TEXT_MODE fallback clause, the /gsd:progress fallback, and that every command
 * the classifier can emit resolves to a real existing slash command file.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CMD = path.join(ROOT, 'commands', 'gsd', 'next.md');
const WF = path.join(ROOT, 'gsd-core', 'workflows', 'smart-entry.md');
const CMDS_DIR = path.join(ROOT, 'commands', 'gsd');

// NEW_FILE_CAP from tests/workflow-size-budget.test.cjs (#1074).
const NEW_FILE_CAP = 32768;

function read(p) {
  return fs.readFileSync(p, 'utf-8');
}

/** Parse YAML-ish frontmatter (key: value lines between --- fences). */
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([a-z_-]+):\s*(.*)$/);
    if (mm) fm[mm[1]] = mm[2];
  }
  return fm;
}

describe('/gsd:next command file (commands/gsd/next.md)', () => {
  const content = read(CMD);

  test('exists', () => {
    assert.ok(fs.existsSync(CMD));
  });

  test('frontmatter has name: gsd:next (surfaces as /gsd:next)', () => {
    const fm = parseFrontmatter(content);
    assert.equal(fm.name, 'gsd:next');
  });

  test('has NO requires field (must work pre-project)', () => {
    const fm = parseFrontmatter(content);
    assert.equal(fm.requires, undefined);
  });

  test('allowed-tools includes AskUserQuestion, Bash, SlashCommand', () => {
    const fmBlock = content.match(/^---\r?\n[\s\S]*?\r?\n---/)[0];
    assert.match(fmBlock, /AskUserQuestion/);
    assert.match(fmBlock, /Bash/);
    assert.match(fmBlock, /SlashCommand/);
  });

  test('references the smart-entry workflow', () => {
    assert.match(content, /workflows\/smart-entry\.md/);
  });
});

describe('/gsd:next workflow (gsd-core/workflows/smart-entry.md)', () => {
  const content = read(WF);

  test('exists and is under the NEW_FILE_CAP (32 KiB)', () => {
    assert.ok(fs.existsSync(WF));
    const bytes = fs.statSync(WF).size;
    assert.ok(bytes < NEW_FILE_CAP, `workflow is ${bytes} bytes, must be < ${NEW_FILE_CAP}`);
  });

  test('contains the TEXT_MODE fallback clause', () => {
    assert.match(content, /TEXT_MODE/);
    assert.match(content, /numbered list/i);
  });

  test('contains the gsd_run shim resolver block', () => {
    assert.match(content, /_GSD_SHIM_NAME/);
    assert.match(content, /gsd_run\(\)/);
  });

  test('runs smart-entry --json to detect', () => {
    assert.match(content, /smart-entry --json/);
  });

  test('falls back to /gsd:progress on detection failure (never strands)', () => {
    assert.match(content, /\/gsd:progress/);
    assert.match(content, /unavailable/i);
  });

  test('dispatches exactly one command then stops', () => {
    assert.match(content, /dispatch/i);
    // "stop" / "do not chain" guard language present
    assert.match(content, /(stop|do not chain|do not re-enter)/i);
  });
});

describe('smart-entry: every emitted command resolves to a real slash command', () => {
  // Drive the classifier across all situations and collect every command string
  // it can emit, then assert each resolves to commands/gsd/<name>.md.
  const smartEntry = require('../gsd-core/bin/lib/smart-entry.cjs');
  const { SITUATIONS, actionsFor } = smartEntry;

  // A minimal signal shape sufficient for actionsFor (which only reads
  // current_phase for label text). actionsFor ignores other fields.
  const sampleSignals = {
    current_phase: 2,
    total_phases: 5,
    status: 'executing',
    progress: 60,
    has_planning: true,
    has_roadmap: true,
    git_dirty: false,
    git_unpushed: false,
    paused: false,
    blockers: [],
    has_git: true,
    verify_failed: false,
    stale_activity: false,
  };

  const allCommands = new Set();
  for (const situation of SITUATIONS) {
    for (const a of actionsFor(situation, sampleSignals)) {
      allCommands.add(a.command);
    }
  }

  test(`collected commands from all ${SITUATIONS.length} situations`, () => {
    assert.ok(allCommands.size >= 8, `expected a broad command set, got ${allCommands.size}`);
  });

  for (const cmd of allCommands) {
    test(`command "${cmd}" resolves to a real commands/gsd/*.md file`, () => {
      // Strip leading "/gsd:" and any trailing flags, map to a file stem.
      const stem = cmd.replace(/^\/gsd:/, '').split(/\s+/)[0];
      // Special-case: "progress --next" / "progress --do" still → progress.md.
      const file = path.join(CMDS_DIR, `${stem}.md`);
      assert.ok(
        fs.existsSync(file),
        `command "${cmd}" → expected file commands/gsd/${stem}.md (not found)`,
      );
    });
  }
});
