'use strict';

/**
 * Bug #1529 parity / drift guard.
 *
 * The runtime → project-instruction-file mapping is shared between two
 * parallel surfaces:
 *   (A) the Node surface — `getProjectInstructionFile` in runtime-name-policy.cjs,
 *       consumed by profile-output.cjs (the generate-claude-md handler).
 *   (B) the bash surface — `gsd-tools query project-instruction-file --runtime <r>`,
 *       consumed by gsd-core/workflows/new-project.md to set $INSTRUCTION_FILE.
 *
 * Per DEFECT.GENERATIVE-FIX, any shared mapping between two surfaces MUST
 * carry a parity assertion that fails when they diverge. This test is that
 * guard: it asserts (A) and (B) return the same filename for every runtime,
 * AND that the new-project.md workflow derives $INSTRUCTION_FILE from the
 * shared query rather than a hardcoded codex-only branch (the original bug).
 *
 * Boundary coverage (per RULESET.TESTS.boundary-coverage): claude (the
 * kept-as-is case) and an unknown runtime (the AGENTS.md default) are both
 * exercised alongside every runtime family in the mapping table.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const RUNTIME_NAME_POLICY_PATH = path.join(
  ROOT,
  'gsd-core',
  'bin',
  'lib',
  'runtime-name-policy.cjs',
);
const GSD_TOOLS_PATH = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const NEW_PROJECT_WORKFLOW_PATH = path.join(
  ROOT,
  'gsd-core',
  'workflows',
  'new-project.md',
);

const { getProjectInstructionFile } = require(RUNTIME_NAME_POLICY_PATH);

const RUNTIMES = [
  'claude',
  'codex',
  'opencode',
  'kilo',
  'kimi',
  'copilot',
  'antigravity',
  // 'gemini' intentionally excluded from this loop — #4709 AC#1 made it
  // REFUSE (RetiredRuntimeError) on both surfaces instead of agreeing on a
  // fallback value, so `getProjectInstructionFile('gemini')` now throws
  // before the two sides can even be compared. Its own dedicated test below
  // pins that refusal-parity instead.
  'future-runtime-xyz',
  '',
];

function queryInstructionFile(runtime) {
  const args = [
    GSD_TOOLS_PATH,
    'query',
    'project-instruction-file',
    '--runtime',
    runtime,
  ];
  const r = runNode(args, {
    cwd: ROOT,
    env: { ...process.env, GSD_RUNTIME: '' },
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  throwIfFailed(r, `node ${args.join(' ')}`);
  return r.stdout.trim();
}

describe('bug #1529: getProjectInstructionFile ↔ gsd-tools query parity', () => {
  for (const runtime of RUNTIMES) {
    const label = runtime === '' ? '<empty>' : runtime;
    test(`Node function and CLI query agree for runtime=${label}`, () => {
      const fromFunction = getProjectInstructionFile(runtime);
      const fromQuery = queryInstructionFile(runtime);
      assert.strictEqual(
        fromQuery,
        fromFunction,
        `gsd-tools query project-instruction-file --runtime ${label} returned "${fromQuery}" but getProjectInstructionFile() returned "${fromFunction}"; the two surfaces drifted.`,
      );
    });
  }

  // #4709 AC#1 inverted this case: gemini used to silently agree with the CLI
  // on AGENTS.md (the defect this parity guard would have pinned); both
  // surfaces now refuse it outright instead, which is still parity — just
  // parity-of-refusal rather than parity-of-value.
  test('Node function and CLI query both refuse for runtime=gemini (retired by #1928)', () => {
    assert.throws(
      () => getProjectInstructionFile('gemini'),
      /retired by #1928/,
      'getProjectInstructionFile("gemini") must refuse, not silently agree with the CLI on AGENTS.md',
    );

    const args = [GSD_TOOLS_PATH, 'query', 'project-instruction-file', '--runtime', 'gemini'];
    const r = runNode(args, {
      cwd: ROOT,
      env: { ...process.env, GSD_RUNTIME: '' },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    assert.notStrictEqual(
      r.exitCode, 0,
      'gsd-tools query project-instruction-file --runtime gemini must exit non-zero, not silently print AGENTS.md',
    );
    // The CLI must emit the same clean single-line error routeSkillsRoot emits
    // for an unknown runtime — never a raw stack trace.
    assert.match(
      r.stderr, /Antigravity/,
      'stderr must name the successor runtime (Antigravity)',
    );
    assert.match(
      r.stderr, /#1928/,
      'stderr must name the retiring issue (#1928)',
    );
    assert.ok(
      !/\n\s+at\s/.test(r.stderr),
      `stderr must not contain a dumped stack trace, got: ${r.stderr}`,
    );
  });
});

describe('bug #1529: new-project.md workflow uses the shared policy query', () => {
  // allow-test-rule: structural-regression-guard (#1529)
  // the workflow's bash block MUST invoke the
  // shared `gsd_run query project-instruction-file` query rather than a hardcoded
  // codex-only `if/else` branch; there is no typed IR for "this bash block calls a
  // specific gsd-tools query instead of a hardcoded mapping".
  const workflow = fs.readFileSync(NEW_PROJECT_WORKFLOW_PATH, 'utf8');

  test('workflow derives INSTRUCTION_FILE from the shared query', () => {
    assert.ok(
      /INSTRUCTION_FILE=\$\(gsd_run query project-instruction-file --runtime "\$RUNTIME"\)/.test(workflow),
      'new-project.md must derive INSTRUCTION_FILE via `gsd_run query project-instruction-file --runtime "$RUNTIME"` (the shared policy adapter)',
    );
  });

  test('workflow no longer hardcodes the codex-only branch', () => {
    assert.ok(
      !/if \[ "\$RUNTIME" = "codex" \]; then INSTRUCTION_FILE="AGENTS\.md"; else INSTRUCTION_FILE="\.claude\/CLAUDE\.md"; fi/.test(workflow),
      'new-project.md must not contain the retired codex-only `if [ "$RUNTIME" = "codex" ]; then INSTRUCTION_FILE="AGENTS.md"; else INSTRUCTION_FILE=".claude/CLAUDE.md"; fi` branch (#1529 regression guard)',
    );
  });
});
