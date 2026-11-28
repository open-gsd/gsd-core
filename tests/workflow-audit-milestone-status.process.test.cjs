'use strict';

/**
 * #6812: /gsd-audit-milestone step 2 takes each phase's verification status from its owner, `verification.status`,
 * never from the report's own `status:`. The step's bash blocks are run here as written, under a real bash: with the real
 * CLI on fixtures (a passed report whose covered file changed reads `stale`; an archived phase is read where it lies),
 * and with a stub CLI for the exit-status property (a failed or refused read stops the block before anything reads its
 * answer; an answer is recorded as given).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { skipUnless } = require('./helpers/bash-probe.cjs');
const { span } = require('./helpers/doc-bash-span.cjs');
const { runHook, OUTCOME, assertSeamExit } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');
const { createTempProject, createTempDir, cleanup, runGsdTools, TOOLS_PATH } = require('./helpers.cjs');
const { VERIFICATION_STATUS } = require('../gsd-core/bin/lib/verification.cjs');

const SKIP = skipUnless('bash', 'node');
const WORKFLOW = 'gsd-core/workflows/audit-milestone.md';
const PHASE_DIR = path.join('.planning', 'phases', '01-setup');
const ARCHIVED_DIR = path.join('.planning', 'milestones', 'v1.0-phases', '01-setup');
const PROBE = 'printf "RECORDED=%s\\n" "$VERIFICATION_STATUS"';
const NEXT_PROBE = 'printf "NEXT_ACTION=%s\\nNEXT_COMMAND=%s\\n" "$NEXT_ACTION" "$NEXT_COMMAND"';

// Step 2's blocks, each to the end of its fence (the closing ``` dropped): the first planning.inspect line of the
// workflow through the owner read, and the next-step reads. The first block must hold the owner read, so a workflow
// whose first planning.inspect is another step's (step 5c's, before #6812) is not run in step 2's place.
const fence = (from) => span(WORKFLOW, from, '```').slice(0, -1);
const block = () => {
  const lines = fence('PLANNING_ROOT=$(gsd_run query planning.inspect');
  assert.ok(lines.some((line) => line.startsWith('VERIFICATION_STATUS=$(gsd_run query verification.status')), `${WORKFLOW}: the first planning.inspect block must read the owner`);
  return lines;
};
const nextBlock = () => fence('NEXT_ACTION=$(gsd_run query verification.status');
// The statuses step 2 reads the owner's next step for: all but passed and phase_dir_not_found.
const TAKES_NEXT = (status) => ![VERIFICATION_STATUS.PASSED, VERIFICATION_STATUS.PHASE_DIR_NOT_FOUND].includes(status);

function runBlock(cwd, home, { gsdRun, phase, setE = false, next = false, extraEnv = {} }) {
  const tail = next ? [...nextBlock(), NEXT_PROBE] : [];
  const script = [...(setE ? ['set -e'] : []), gsdRun, `PHASE=${phase}`, ...block(), PROBE, ...tail, ''].join('\n');
  const env = isolatedEnv({ home, override: { AUDIT_NODE: process.execPath, AUDIT_TOOLS: TOOLS_PATH, ...extraEnv } });
  return runHook('-c', [script], { interpreter: 'bash', cwd, env, timeoutMs: PROBE_TIMEOUT_MS });
}

const recorded = (r) => (/^RECORDED=(.*)$/m.exec(r.stdout) || [])[1];
const nextAction = (r) => (/^NEXT_ACTION=(.*)$/m.exec(r.stdout) || [])[1];
const nextCommand = (r) => (/^NEXT_COMMAND=(.*)$/m.exec(r.stdout) || [])[1];

describe('audit-milestone step 2 reads the owner (#6812)', { skip: SKIP }, () => {
  const REAL = 'gsd_run() { "$AUDIT_NODE" "$AUDIT_TOOLS" "$@"; }';

  // A project with phase 01's report written from `frontmatter` (null: no report). `fingerprint` covers src/a.ts;
  // `archived` puts the phase directory under milestones/v1.0-phases/ instead of phases/.
  function project(t, frontmatter, { fingerprint = false, editAfter = false, archived = false } = {}) {
    const dir = createTempProject('gsd-audit-owner-');
    const home = createTempDir('gsd-audit-owner-home-');
    t.after(() => {
      cleanup(dir);
      cleanup(home);
    });
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n### Phase 1: Setup\n\n**Goal**: g\n');
    const phaseDir = archived ? ARCHIVED_DIR : PHASE_DIR;
    fs.mkdirSync(path.join(dir, phaseDir), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    if (frontmatter !== null) {
      const lines = ['---', frontmatter];
      if (fingerprint) {
        const digest = runGsdTools(['verification', 'fingerprint', phaseDir, 'src/a.ts', '--raw'], dir);
        assert.ok(digest.success, digest.error);
        lines.push('covered_files:', '  - src/a.ts', `covered_digest: ${digest.output.trim()}`);
      }
      lines.push('---', '# Verification', '', '| REQ-01 | 01-01 | a exists | ✓ SATISFIED | src/a.ts |', '');
      fs.writeFileSync(path.join(dir, phaseDir, '01-VERIFICATION.md'), lines.join('\n'));
    }
    if (editAfter) fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    return { dir, home };
  }

  for (const [title, frontmatter, options, phase, expected] of [
    ['a passed report whose covered file changed records stale', 'status: passed', { fingerprint: true, editAfter: true }, '01', VERIFICATION_STATUS.STALE],
    ['the same report before the change records passed', 'status: passed', { fingerprint: true }, '01', VERIFICATION_STATUS.PASSED],
    ['a human_needed report records human_needed', 'status: human_needed', {}, '01', VERIFICATION_STATUS.HUMAN_NEEDED],
    ['a report with broken frontmatter records unparseable', 'status: [unclosed', {}, '01', VERIFICATION_STATUS.UNPARSEABLE],
    ['a phase with no report records missing', null, {}, '01', VERIFICATION_STATUS.MISSING],
    ['a report without a status records missing', 'phase: 01', {}, '01', VERIFICATION_STATUS.MISSING],
    ['a phase with no directory records phase_dir_not_found, not a refusal', 'status: passed', {}, '07', VERIFICATION_STATUS.PHASE_DIR_NOT_FOUND],
    ['an archived phase is read in its archive directory', 'status: passed', { archived: true }, '01', VERIFICATION_STATUS.PASSED],
  ]) {
    test(`[real bash + real CLI: the block's exit status and variable] ${title}`, (t) => {
      const { dir, home } = project(t, frontmatter, options);
      // The statuses step 2 reads the next step for also run that block.
      const r = runBlock(dir, home, { gsdRun: REAL, phase, next: TAKES_NEXT(expected) });
      assertSeamExit(assert, r, 0, title);
      assert.equal(recorded(r), expected);
    });
  }

  test("[real bash + real CLI: the block's exit status and variables] a stale phase's next step is the owner's command", (t) => {
    const { dir, home } = project(t, 'status: passed', { fingerprint: true, editAfter: true });
    const r = runBlock(dir, home, { gsdRun: REAL, phase: '01', next: true });
    assertSeamExit(assert, r, 0, 'stale next step');
    const owner = runGsdTools(['query', 'verification.status', PHASE_DIR, '--pick', 'next_command'], dir);
    assert.ok(owner.success, owner.error);
    assert.notEqual(owner.output.trim(), '');
    assert.equal(nextCommand(r), owner.output.trim());
  });

  // An active phase's such report is refused as early as planning.inspect, which reads the active phases' reports
  // through the same owner; an archived one is refused by the owner read itself.
  for (const archived of [false, true]) {
    test(`[real bash + real CLI: the block's exit status] a report status outside the writer set stops the block before a status is recorded (${archived ? 'archived phase, at the owner read' : 'active phase'})`, (t) => {
      const { dir, home } = project(t, 'status: verified', { archived });
      if (archived) {
        // The two reads before the owner's answer, so the stop below is the owner read's own.
        assert.ok(runGsdTools(['query', 'planning.inspect', '--pick', 'generated_from.planning_root'], dir).success);
        const found = runGsdTools(['query', 'find-phase', '01', '--pick', 'directory'], dir);
        assert.ok(found.success, found.error);
        assert.equal(path.normalize(found.output.trim()), ARCHIVED_DIR);
      }
      const r = runBlock(dir, home, { gsdRun: REAL, phase: '01' });
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.notEqual(r.exitCode, 0);
      assert.equal(recorded(r), undefined);
    });
  }

  test("[real bash: the blocks' exit status under a stub CLI] property: an answer is recorded as given; a failed or refused read stops the block before its answer is used, with or without set -e", (t) => {
    const home = createTempDir('gsd-audit-owner-home-');
    t.after(() => cleanup(home));
    // Each read fails as the real CLI does: nothing on stdout and a non-zero exit. The owner refuses an empty phase
    // directory (98), as the real one does, so a found and a not-found phase are both drawn: the block must hand the
    // owner a path either way. Each next-step read fails on its own stage, named by its `--pick` field, so either hard stop is caught alone.
    const STUB = [
      'gsd_run() {',
      '  case "$2" in',
      '    planning.inspect) [ "$STUB_FAIL" = inspect ] && return "$STUB_RC"; printf %s "$STUB_ROOT" ;;',
      '    find-phase) [ "$STUB_FAIL" = find ] && return "$STUB_RC"; printf %s "$STUB_DIR" ;;',
      '    verification.status) [ -n "$3" ] || return 98',
      '      if [ "$5" = status ]; then [ "$STUB_FAIL" = owner ] && return "$STUB_RC"; printf %s "$STUB_STATUS"',
      '      else [ "$STUB_FAIL" = "$5" ] && return "$STUB_RC"; printf %s "/gsd-next-$5"; fi ;;',
      '    *) return 97 ;;',
      '  esac',
      '}',
    ].join('\n');
    const members = Object.values(VERIFICATION_STATUS);
    fc.assert(fc.property(
      fc.constantFrom(...members),
      fc.constantFrom('none', 'inspect', 'find', 'owner', 'next_action', 'next_command'),
      fc.integer({ min: 1, max: 125 }),
      fc.constantFrom('', '.planning/phases/01-setup'),
      fc.boolean(),
      (status, fail, rc, foundDir, setE) => {
        const r = runBlock(home, home, {
          gsdRun: STUB,
          phase: '01',
          setE,
          next: true,
          extraEnv: { STUB_ROOT: path.join(home, '.planning'), STUB_DIR: foundDir, STUB_STATUS: status, STUB_FAIL: fail, STUB_RC: String(rc) },
        });
        assert.equal(r.outcome, OUTCOME.EXITED);
        if (fail === 'none') {
          assert.equal(r.exitCode, 0, r.stderr);
          assert.equal(recorded(r), status);
          assert.equal(nextAction(r), '/gsd-next-next_action');
          assert.equal(nextCommand(r), '/gsd-next-next_command');
        } else {
          assert.notEqual(r.exitCode, 0);
          // A failed next-step read comes after the status is recorded, and a failed next_command read after the
          // next_action read; every other failure comes before the status.
          assert.equal(recorded(r), fail.startsWith('next_') ? status : undefined);
          assert.equal(nextAction(r), undefined);
          assert.equal(nextCommand(r), undefined);
        }
      },
    ), { numRuns: 90 });
  });
});
