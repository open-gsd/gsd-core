'use strict';

/**
 * Tests for the STATE.md write-path anti-divergence drift guard
 * (epic #3408, issue #3468, ADR-3408 Decision 5; SHRUNK per ADR-3473 §8.6,
 * issue #3871) — `scripts/lint-state-write-path-drift.cjs`.
 *
 * Design contract: docs/adr/3408-state-write-path-preservation.md (§8.1/§8.2/§8.3)
 *                   docs/adr/3473-enforcement-by-construction.md (§8.6)
 *
 * The guard covers five axes, each backed by its own exported pure function
 * and each terminal (every finding carries its own `reason` — there is no
 * ratchet and nothing here reads a baseline file): `findPolicyDispatchDrift`/
 * `findUnimplementedPolicies` (Axis 1, policy dispatch), `findRawStateWrites`
 * (Axis 2, a raw `fs.writeFileSync` against the state path),
 * `findUnstrippedContentWrites` (Axis 3, a frontmatter-shaped body write),
 * `findPromptSeamUses` (Axis 4, prompt-layer prose shelling out to a
 * write-side command), and `findCompositionBypasses` (Axis 5, a direct
 * `syncStateFrontmatter`/`applyPostSyncPreservation` call outside their
 * owner). ADR-3473 §8.6 retired one prior axis's `writeStateMd(` arm and the
 * ratchet/retired-baseline machinery that backed it, once `writeStateMd`'s
 * third parameter started requiring a `StateTransaction` the type system
 * names; issue #3871 review kept that axis's OTHER arm (now
 * `findCompositionBypasses`) because the type system gates only
 * `writeStateMd`'s parameter, not a call site that never goes through
 * `writeStateMd` at all — that arm was made terminal too.
 *
 * Sections D and E drive each pure function directly with in-memory
 * fixtures — no temp tree needed, mirroring
 * tests/state-field-drift.test.cjs's own house pattern. Section F instead
 * drives the real CLI entry point, via the guard's `--root <dir>` flag
 * (`collect(root)` takes a matching parameter, default `REPO_ROOT`, so every
 * existing invocation — `npm run lint:ci` included — is unaffected): this is
 * what lets a real-tree fixture run inside a disposable `createTempDir()`
 * tree instead of ever mutating this repository's own `src/`, where a
 * planted fixture would be visible to any concurrent `tsc`/`npm run
 * build:lib`/`npm run lint`/another guard invocation, and would survive as
 * build-breaking debris if the process were killed before `t.after` ran. D1
 * is the one exception among the fixture-driven rows: it asserts the real
 * repo's own `src/` and prompt layer are clean, so it runs through the CLI's
 * `--json` output against the real `REPO_ROOT` with no `--root` override.
 *
 * Fixtures use array `.join('\n')`, never an indented template literal —
 * indentation bleed would shift every asserted line number.
 *
 * Assertions compare the frozen `REASON` enum values and the `--json`/pure
 * function return shapes only — never a substring/regex match on the human
 * formatter's prose (CONTRIBUTING.md, "Prohibited: Raw Text Matching on Test
 * Outputs").
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const guard = require('../scripts/lint-state-write-path-drift.cjs');
const {
  REASON,
  findPromptSeamUses,
  findPolicyDispatchDrift,
  findUnstrippedContentWrites,
  findRawStateWrites,
  findCompositionBypasses,
  targetsStatePath,
  EXECUTOR_FILE,
  SEAM_OWNER_FILE,
  SEAM_OWNER_EXEMPT_FUNCTIONS,
  REPO_ROOT,
} = guard;

const GUARD_PATH = path.join(REPO_ROOT, 'scripts', 'lint-state-write-path-drift.cjs');

// A synthetic, non-executor consumer file — never a real repo path — used
// wherever a row does not specifically need EXECUTOR_FILE behavior.
const OTHER_FILE = 'src/example-consumer.cts';

// ─── D1: the real tree, through the CLI's --json contract ─────────────────

describe('D1 — the real tree', () => {
  test('guard: clean tree passes', () => {
    const result = runNode([GUARD_PATH, '--json'], { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(result.outcome, 'exited');
    const body = JSON.parse(result.stdout);
    assert.strictEqual(body.ok, true);
    assert.deepStrictEqual(body.findings, []);
    assert.strictEqual(result.exitCode, 0);
  });
});

// ─── D8: comments are not drift (composition-bypass shape) ────────────────

describe('D8 — comments are not drift', () => {
  test('guard: comments are not drift', () => {
    const text = [
      '// syncStateFrontmatter(content, cwd);',
      '/**',
      ' * applyPostSyncPreservation(originalContent, content, synced, statePath, options);',
      ' */',
      'function noop() {}',
    ].join('\n');

    // ADR-3180 Amendment 3's recorded false positive: a `//` line comment
    // and a `/* */` block comment both carrying the exact call text must
    // stay silent — both are blanked by `stripComments` before the seam-call
    // regex ever runs.
    assert.deepStrictEqual(findCompositionBypasses(OTHER_FILE, text), []);
  });
});

// ─── D9/D10: the owner-file exemption is function-scoped, not file-scoped ──

describe('D9 — owner functions are exempt', () => {
  test('guard: owner functions are exempt', () => {
    // `syncAndPreserveStateMd` is the sole legitimate place
    // `syncStateFrontmatter(` and `applyPostSyncPreservation(` appear
    // together (the composition every OTHER caller routes through).
    assert.ok(SEAM_OWNER_EXEMPT_FUNCTIONS.includes('syncAndPreserveStateMd'));

    const text = [
      'function syncAndPreserveStateMd(originalContent, transformedContent, statePath, cwd, options) {',
      '  const synced = syncStateFrontmatter(transformedContent, cwd, options.authoritativeFm);',
      '  return applyPostSyncPreservation(originalContent, transformedContent, synced, statePath, options);',
      '}',
    ].join('\n');

    // The seam's own internal plumbing (the one owned composition —
    // sync then post-sync preservation) is not a bypass.
    assert.deepStrictEqual(findCompositionBypasses(SEAM_OWNER_FILE, text), []);
  });

  test('guard: writeStateMd is also exempt — its own sanctioned direct syncStateFrontmatter call is not a bypass', () => {
    assert.ok(SEAM_OWNER_EXEMPT_FUNCTIONS.includes('writeStateMd'));

    const text = [
      'function writeStateMd(statePath, content, transaction, cwd, clock) {',
      "  const synced = syncStateFrontmatter(content, cwd, undefined, transaction.kind === 'rebuild');",
      '  platformWriteSync(statePath, synced);',
      '}',
    ].join('\n');

    assert.deepStrictEqual(findCompositionBypasses(SEAM_OWNER_FILE, text), []);
  });
});

describe('D10 — the owner file is not exempt', () => {
  test('guard: the owner file is not exempt', () => {
    // ADR-3408 Decision 5's named gaming route: a whole-FILE exemption on
    // the owner is exactly how getMilestoneInfo stayed invisible to an
    // earlier drift guard. A call inside any OTHER function in state.cts —
    // not one of SEAM_OWNER_EXEMPT_FUNCTIONS — must still be caught.
    const text = [
      'function patchCore(cwd) {',
      '  const modified = compute();',
      '  const synced = syncStateFrontmatter(modified, cwd);',
      '  return synced;',
      '}',
    ].join('\n');

    const out = findCompositionBypasses(SEAM_OWNER_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reason, REASON.COMPOSITION_BYPASS);
    assert.strictEqual(out[0].line, 3);
  });
});

// ─── D12: CRLF is scanned identically to LF ────────────────────────────────

describe('D12 — CRLF is scanned identically', () => {
  test('guard: CRLF is scanned identically', () => {
    const lfText = [
      'function cmdSomethingElse(cwd) {',
      '  const synced = syncStateFrontmatter(modified, cwd);',
      '}',
    ].join('\n');
    const crlfText = lfText.split('\n').join('\r\n');

    const lfOut = findCompositionBypasses(OTHER_FILE, lfText);
    const crlfOut = findCompositionBypasses(OTHER_FILE, crlfText);

    assert.strictEqual(crlfOut.length, 1);
    const strip = (arr) => arr.map(({ line, symbol, source }) => ({ line, symbol, source }));
    assert.deepStrictEqual(strip(crlfOut), strip(lfOut));
    // A stray trailing \r surviving into the reported source (the repo's
    // documented \n-only-regex bug class) would show up here as a
    // sanitized `\x0d` escape — it must not.
    assert.strictEqual(crlfOut[0].source, 'const synced = syncStateFrontmatter(modified, cwd);');
  });
});

// ─── E1/E2 (Phase 2 / #3469, RETAINED per issue #3871): the composition-pair
// re-assembly shape itself, and the legitimate single-call composition ─────

describe('E1 — a re-assembled composition at a new call site is detected', () => {
  test('guard: a call site invoking syncStateFrontmatter and applyPostSyncPreservation directly (bypassing syncAndPreserveStateMd) is caught on BOTH calls', () => {
    // Finding 3's exact shape (ADR-3408 Amendment 2): every step calls an
    // owner, so neither call alone is undeclared — but assembling the PAIR
    // at a call site outside the seam composition is the re-derivation §8.3
    // forbids by name. Synthetic: the real instance of this shape
    // (cmdPhaseComplete's pre-#3469 adapter) was fixed by that phase.
    const text = [
      'function cmdReassembledAdapter(cwd, statePath, stateContent) {',
      '  let synced = syncStateFrontmatter(stateContent, cwd, authoritativeFm);',
      '  synced = applyPostSyncPreservation(originalStateContent, stateContent, synced, statePath, options);',
      '  return synced;',
      '}',
    ].join('\n');

    const out = findCompositionBypasses(OTHER_FILE, text);
    assert.strictEqual(out.length, 2, 'both re-assembled stages must be caught, not just one');
    assert.deepStrictEqual(out.map((f) => f.symbol).sort(), ['applyPostSyncPreservation', 'syncStateFrontmatter']);
    assert.ok(out.every((f) => f.reason === REASON.COMPOSITION_BYPASS));
  });
});

describe('E2 — a legitimate single call to the composition is not detected', () => {
  test('guard: calling syncAndPreserveStateMd (the ONE write-seam composition) is not a bypass', () => {
    // Verbatim shape from a real caller of the composition (e.g.
    // milestone.cts's cmdMilestoneComplete) — a single call to the owned
    // composition function, never to its two internal stages directly.
    const text = [
      '      const finalContent = syncAndPreserveStateMd(',
      '        originalStateContent,',
      '        result.content,',
      '        statePath,',
      '        cwd,',
      '        {',
      '          resync: true,',
      '          authoritativeFm: Object.keys(authoritativeFm).length > 0 ? authoritativeFm : undefined,',
      '          divergedFields,',
      '        },',
      '      );',
    ].join('\n');

    assert.deepStrictEqual(findCompositionBypasses(OTHER_FILE, text), []);
  });
});

// ─── D11: the prompt layer is in the scan surface ──────────────────────────

describe('D11 — the prompt layer is in the scan surface', () => {
  const PROMPT_FILE = 'gsd-core/workflows/example-workflow.md';

  test('guard: the prompt layer is in the scan surface', () => {
    const text = [
      '# Example workflow',
      '',
      'Run gsd-tools state.patch --field status --value done to record completion directly.',
    ].join('\n');

    const out = findPromptSeamUses(PROMPT_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 3);
    assert.strictEqual(out[0].reason, REASON.PROMPT_LAYER_STATE_WRITE);
    assert.strictEqual(out[0].symbol, 'prompt-layer-state-write');
  });

  test('control: the same candidate wrapped in backticks is a mention, not an invocation, and is not reported', () => {
    // Proves the detection above is genuinely exercising the code-span
    // exclusion, not merely that the fixture happens to score zero.
    const text = 'Documentation only: `gsd-tools state.patch --field status --value done`.';
    assert.deepStrictEqual(findPromptSeamUses(PROMPT_FILE, text), []);
  });
});

// ─── D14: field-name-keyed BRANCH comparisons (not just CALLS) ────────────
// #3468: `applyPreserveIfPlaceholder` shipped a `field !== 'milestone_name'`
// branch — a field-name-keyed dispatch that routed around
// `getFieldClassification` entirely, so `FIELD_NAME_DISPATCH_RE` (which only
// matches the CALL shape) reported zero violations while the branch shape
// sat in the executor undetected. This section drives the widened detector
// directly against in-memory fixtures, mirroring D2's own "guard: does the
// pure function itself report" pattern.

describe('D14 — field-name-keyed branch comparisons are caught', () => {
  test('guard: field !== literal is reported as FIELD_NAME_DISPATCH', () => {
    const text = [
      'function applyPreserveIfPlaceholder(field, cls, ctx) {',
      "  if (field !== 'milestone_name') return;",
      '}',
    ].join('\n');

    const out = findPolicyDispatchDrift(EXECUTOR_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reason, REASON.FIELD_NAME_DISPATCH);
    assert.strictEqual(out[0].line, 2);
    assert.strictEqual(out[0].field, 'milestone_name');
  });

  test('guard: field === literal is reported as FIELD_NAME_DISPATCH', () => {
    const text = [
      'function applyPreserveWhenUnchanged(field, cls, ctx) {',
      "  if (field === 'status') return;",
      '}',
    ].join('\n');

    const out = findPolicyDispatchDrift(EXECUTOR_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reason, REASON.FIELD_NAME_DISPATCH);
    assert.strictEqual(out[0].line, 2);
    assert.strictEqual(out[0].field, 'status');
  });

  test('guard: the reversed literal === field is reported as FIELD_NAME_DISPATCH', () => {
    const text = [
      'function applyPreserveIfPlaceholder(field, cls, ctx) {',
      "  if ('milestone' === field) return;",
      '}',
    ].join('\n');

    const out = findPolicyDispatchDrift(EXECUTOR_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reason, REASON.FIELD_NAME_DISPATCH);
    assert.strictEqual(out[0].line, 2);
    assert.strictEqual(out[0].field, 'milestone');
  });

  test('control: preservation === literal (the CORRECT policy-dispatch shape) is NOT reported', () => {
    const text = [
      'function applyPreserveAlways(field, cls, ctx) {',
      "  if (cls.preservation === 'preserve-always') return;",
      '}',
    ].join('\n');

    assert.deepStrictEqual(findPolicyDispatchDrift(EXECUTOR_FILE, text), []);
  });

  test('control: an unrelated variable compared to a literal is NOT reported', () => {
    const text = [
      'function helper(status, cls, ctx) {',
      "  if (status !== 'unknown') return;",
      '}',
    ].join('\n');

    assert.deepStrictEqual(findPolicyDispatchDrift(EXECUTOR_FILE, text), []);
  });

  test('control: bracket-indexed field access (ctx.postFm[field]) compared to a non-literal is NOT reported', () => {
    const text = [
      'function applyPreserveWhenUnchanged(field, cls, ctx) {',
      '  if (ctx.postFm[field] === snapshot) return;',
      '}',
    ].join('\n');

    assert.deepStrictEqual(findPolicyDispatchDrift(EXECUTOR_FILE, text), []);
  });
});

// ─── D15: `file` (and other attacker-derived fields) are sanitized AT
// CONSTRUCTION, not just by the human formatter ─────────────────────────────
// Security review finding: a repo can legally track a filename containing C1
// control bytes or bidi-override codepoints — exactly as attacker-controlled
// on a fork PR as the `source` fragment this guard already sanitized before
// this fix. Before this fix `file` reached `--json` stdout unsanitized —
// only the human formatter wrapped it. A finding's `file` (and any other
// attacker-derived field, like `field`) must come back escaped from the
// FINDER itself, so every consumer (human, `--json`) inherits the
// sanitization uniformly.
//
// The two attack codepoints are built via `String.fromCharCode` rather than
// embedded as literal bytes, so this test file's own source never carries a
// live control/bidi codepoint on disk.

describe('D15 — file (and field) values are sanitized at construction', () => {
  const RLO = String.fromCharCode(0x202e); // RIGHT-TO-LEFT OVERRIDE (bidi)
  const C1_CSI = String.fromCharCode(0x9b); // C1 CONTROL: CSI
  const ATTACK_FILE = `src/evil${RLO}${C1_CSI}name.cts`;
  const ESCAPED_FILE = 'src/evil\\u202e\\x9bname.cts';

  test('findRawStateWrites: an attacker-controlled filename comes back escaped', () => {
    const text = ['function cmdSomethingElse(cwd) {', '  fs.writeFileSync(statePath, modified);', '}'].join('\n');

    const out = findRawStateWrites(ATTACK_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].file, ESCAPED_FILE);
    // Neither raw attack codepoint survives in the finding at all — this is
    // exactly what reaches `--json` stdout verbatim (JSON.stringify
    // neutralizes C0 but NOT C1 or bidi codepoints, which is why
    // construction-time escaping — not JSON.stringify — is load-bearing).
    assert.ok(!out[0].file.includes(RLO));
    assert.ok(!out[0].file.includes(C1_CSI));
  });

  test('findPromptSeamUses: an attacker-controlled filename comes back escaped', () => {
    const text = 'Run gsd-tools state.patch --field status --value done to record completion directly.';

    const out = findPromptSeamUses(ATTACK_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].file, ESCAPED_FILE);
    assert.ok(!out[0].file.includes(RLO));
    assert.ok(!out[0].file.includes(C1_CSI));
  });

  test('findPolicyDispatchDrift: filename AND the field literal are both escaped', () => {
    const text = ["  if (field === 'status" + RLO + C1_CSI + "') return;"].join('\n');

    const out = findPolicyDispatchDrift(ATTACK_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].file, ESCAPED_FILE);
    assert.strictEqual(out[0].field, 'status\\u202e\\x9b');
    assert.ok(!out[0].field.includes(RLO));
    assert.ok(!out[0].field.includes(C1_CSI));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Section E (Phase 2 / #3469) — ADR-3408 §8.3 Matrix section E: guard rows
// closing Phase 1's declared known gap (Axis 3, §8.3(b)). E1/E2/E6/E7/E8
// (all of which drove the retired `findSeamBypasses`/ratchet machinery) are
// REMOVED along with it, per ADR-3473 §8.6. E3/E4/E5 (the frontmatter-write
// axis ADR-3473 §8.6 did NOT name for removal) are retained.
// ─────────────────────────────────────────────────────────────────────────

describe('E3 — a patchCore-style frontmatter write is detected (closes the Phase 1 declared gap)', () => {
  test('guard: stateReplaceField over unstripped content with a variable field name is caught', () => {
    // The pre-Phase-2 shape #3469 fixed: patchCore ran stateReplaceField
    // over content that was never stripped of frontmatter, letting a
    // lowercase/frontmatter-shaped patch key rewrite the YAML block
    // directly, outside FIELD_CLASSIFICATION.
    const text = [
      'function patchCoreOld(content, intent) {',
      '  let modified = content;',
      '  for (const [field, value] of Object.entries(intent.patches)) {',
      '    const replaced = stateReplaceField(modified, field, value);',
      '    if (replaced !== null) modified = replaced;',
      '  }',
      '  return { content: modified };',
      '}',
    ].join('\n');

    const out = findUnstrippedContentWrites(EXECUTOR_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reason, REASON.UNSTRIPPED_CONTENT_WRITE);
    assert.strictEqual(out[0].line, 4);
  });
});

describe('E4 — updateCore\'s strip-then-replace is NOT detected', () => {
  test('guard: the real updateCore call site (content stripped first) is not flagged', () => {
    // Verbatim from src/state-transition.cts's real updateCore — the shape
    // Phase 1 measured a naive co-occurrence detector at 29 false positives
    // to 1 true positive against; this is one of the 29.
    const text = [
      'function updateCore(content, intent) {',
      '  const existingFm = extractFrontmatter(content) as Record<string, unknown>;',
      '  const hasFrontmatter = Object.keys(existingFm).length > 0;',
      '  const body = stripFrontmatter(content);',
      '  const result = stateReplaceField(body, intent.field, intent.value);',
      '  if (result === null) {',
      '    return { content, updated: [], data: { updated: false } };',
      '  }',
      '}',
    ].join('\n');

    assert.deepStrictEqual(findUnstrippedContentWrites(EXECUTOR_FILE, text), []);
  });
});

describe('E5 — sectionBody-scoped stateReplaceField calls are NOT detected', () => {
  test('guard: a literal field name against a non-stripFrontmatter-derived section slice is not flagged', () => {
    // Verbatim from src/state-transition.cts's real mutateCurrentPositionFirstTime:
    // sectionBody is a Current-Position section slice (frontmatter-free by
    // construction — it comes from body.slice(...), never from raw content),
    // and the field name is a fixed Title-Case literal that can never
    // collide with a lowercase/snake_case YAML key. One of the ~20 calls
    // Phase 1's naive detector over-reported.
    const text = [
      'function mutateCurrentPositionFirstTime(body, intent, today, updated) {',
      '  const span = locateCurrentPosition(body);',
      '  if (span === null) return body;',
      '  let sectionBody = body.slice(span.start, span.end);',
      '  const phaseLabel = `${intent.phaseNumber} — EXECUTING`;',
      '  if (/^Phase:/m.test(sectionBody)) {',
      '    sectionBody = sectionBody.replace(/^Phase:.*$/m, `Phase: ${phaseLabel}`);',
      '  } else {',
      "    const replaced = stateReplaceField(sectionBody, 'Phase', phaseLabel);",
      '    if (replaced !== null) sectionBody = replaced;',
      '  }',
      '}',
    ].join('\n');

    assert.deepStrictEqual(findUnstrippedContentWrites(EXECUTOR_FILE, text), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F — ADR-3473 §8.6: the raw-write axis (`findRawStateWrites`), and the
// guard's own real CLI entry point proving the shrunk guard can still fail.
// ─────────────────────────────────────────────────────────────────────────

describe('F1 — the raw-write axis: pure function coverage', () => {
  test('guard: fs.writeFileSync against statePath is reported', () => {
    const text = [
      'function bogusRawWrite(statePath, content) {',
      '  fs.writeFileSync(statePath, content);',
      '}',
    ].join('\n');

    const out = findRawStateWrites(OTHER_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reason, REASON.RAW_STATE_WRITE);
    assert.strictEqual(out[0].line, 2);
    assert.strictEqual(out[0].source, 'fs.writeFileSync(statePath, content);');
  });

  test('guard: fs.writeFileSync against a STATE.md literal is reported', () => {
    const text = [
      'function bogusRawWrite(cwd, content) {',
      "  fs.writeFileSync(path.join(cwd, 'STATE.md'), content);",
      '}',
    ].join('\n');

    const out = findRawStateWrites(OTHER_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reason, REASON.RAW_STATE_WRITE);
  });

  test('control: fs.writeFileSync against an unrelated target is NOT reported', () => {
    const text = ['function writeSomethingElse(otherPath, content) {', '  fs.writeFileSync(otherPath, content);', '}'].join(
      '\n',
    );

    assert.deepStrictEqual(findRawStateWrites(OTHER_FILE, text), []);
  });

  test('control: platformWriteSync (the sanctioned seam) against statePath is NOT reported — a different call, by name', () => {
    // The type/seam this axis exists BESIDE, not instead of: every real
    // STATE.md writer in this codebase calls `platformWriteSync`, never raw
    // `fs.writeFileSync`, against `statePath`. This axis only matches the
    // literal `fs.writeFileSync` call shape.
    const text = ['function realWriter(statePath, content) {', '  platformWriteSync(statePath, content);', '}'].join(
      '\n',
    );

    assert.deepStrictEqual(findRawStateWrites(OTHER_FILE, text), []);
  });

  test('guard: comments are not drift', () => {
    const text = [
      '// fs.writeFileSync(statePath, modified);',
      '/**',
      ' * fs.writeFileSync(statePath, modified);',
      ' */',
      'function noop() {}',
    ].join('\n');

    assert.deepStrictEqual(findRawStateWrites(OTHER_FILE, text), []);
  });

  test('targetsStatePath: bare identifier and STATE.md-literal both match; an unrelated identifier does not', () => {
    assert.ok(targetsStatePath('statePath'));
    assert.ok(targetsStatePath("path.join(cwd, 'STATE.md')"));
    assert.ok(!targetsStatePath('otherPath'));
  });
});

describe('F2 — a guard that cannot fail is not a guard: the real CLI entry point catches a raw write', () => {
  test('CLI: --root <synthetic tree> with fs.writeFileSync(statePath, ...) is reported, without touching the real src/ tree', (t) => {
    // A throwaway tree in an OS temp dir, never inside this repository — the
    // guard's own `--root` flag (default REPO_ROOT, so every OTHER caller of
    // this CLI is unaffected) is what makes this possible without mutating
    // the repo under test. See this file's header for why a real-src/
    // fixture was rejected.
    const tmpRoot = createTempDir('state-write-path-drift-guard-');
    t.after(() => cleanup(tmpRoot));

    const srcDir = path.join(tmpRoot, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const fixtureContent = [
      "import * as fs from 'node:fs';",
      '',
      'function bogusRawWrite(statePath: string, content: string): void {',
      '  fs.writeFileSync(statePath, content);',
      '}',
    ].join('\n');
    fs.writeFileSync(path.join(srcDir, 'bogus.cts'), fixtureContent, 'utf8');

    const result = runNode([GUARD_PATH, '--root', tmpRoot, '--json'], { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(result.outcome, 'exited');
    assert.strictEqual(result.exitCode, 1, 'a real raw write against statePath must fail the CLI, not pass it');

    const body = JSON.parse(result.stdout);
    assert.strictEqual(body.ok, false);
    const finding = body.findings.find((f) => f.file === 'src/bogus.cts');
    assert.ok(finding, 'the planted fixture must appear in --json findings');
    assert.strictEqual(finding.reason, REASON.RAW_STATE_WRITE);
    assert.strictEqual(finding.line, 4);
  });

  test('CLI: --root <a clean synthetic tree> passes, proving --root does not silently widen scope back to REPO_ROOT', (t) => {
    const tmpRoot = createTempDir('state-write-path-drift-guard-clean-');
    t.after(() => cleanup(tmpRoot));

    const srcDir = path.join(tmpRoot, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'clean.cts'), "export const noop = () => 'noop';\n", 'utf8');
    const result = runNode([GUARD_PATH, '--root', tmpRoot, '--json'], { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(result.outcome, 'exited');
    assert.strictEqual(result.exitCode, 0);
    const body = JSON.parse(result.stdout);
    assert.strictEqual(body.ok, true);
    assert.deepStrictEqual(body.findings, []);
  });
});

describe('F3 — a guard that cannot fail is not a guard: the real CLI entry point catches a composition bypass', () => {
  test('CLI: --root <synthetic tree> with a re-assembled syncStateFrontmatter + applyPostSyncPreservation pair is reported, without touching the real src/ tree', (t) => {
    const tmpRoot = createTempDir('state-write-path-drift-guard-composition-');
    t.after(() => cleanup(tmpRoot));

    const srcDir = path.join(tmpRoot, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const fixtureContent = [
      'function cmdReassembledAdapter(cwd: string, statePath: string, stateContent: string): string {',
      '  let synced = syncStateFrontmatter(stateContent, cwd, authoritativeFm);',
      '  synced = applyPostSyncPreservation(originalStateContent, stateContent, synced, statePath, options);',
      '  return synced;',
      '}',
    ].join('\n');
    fs.writeFileSync(path.join(srcDir, 'bogus-composition.cts'), fixtureContent, 'utf8');

    const result = runNode([GUARD_PATH, '--root', tmpRoot, '--json'], { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(result.outcome, 'exited');
    assert.strictEqual(result.exitCode, 1, 'a re-assembled write-seam composition must fail the CLI, not pass it');

    const body = JSON.parse(result.stdout);
    assert.strictEqual(body.ok, false);
    const findings = body.findings.filter((f) => f.file === 'src/bogus-composition.cts');
    assert.strictEqual(findings.length, 2, 'both re-assembled stages must appear in --json findings');
    assert.ok(findings.every((f) => f.reason === REASON.COMPOSITION_BYPASS));
  });
});

// ---------------------------------------------------------------------------
// C1 of epic #4629 (ADR-4629 §8.1, migration step 1) — the OPAQUE-TRANSFORM
// recognition CAPABILITY. `findOpaqueStateTransforms` recognizes a residual
// `readModifyWriteStateMd(path, (content) => …)` write whose transform is an
// inline anonymous arrow / function expression (the shape §8.1 replaces with a
// declared StateWriteIntent). C1 ships the capability proven on a seeded fixture;
// it is deliberately NOT wired into collect()'s failing scan (that is C2 —
// §8.2/§8.3 Required — Phase 2), so the ~16 existing residual callers do not turn
// lint:ci red and no ratchet is introduced (ADR-3408 §6 phased migration).
describe('C1 (ADR-4629 §8.1): findOpaqueStateTransforms — opaque readModifyWriteStateMd recognition', () => {
  test('positive control: an inline arrow transform (the #4551 residue shape) is flagged', () => {
    const text = [
      'stateUpdated = readModifyWriteStateMd(',
      '  statePath,',
      '  (stateContent) => {',
      "    return stateContent.replace(/None/g, '');",
      '  },',
      '  cwd,',
      ');',
    ].join('\n');
    const out = guard.findOpaqueStateTransforms('src/some-residual-writer.cts', text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reason, REASON.OPAQUE_STATE_TRANSFORM);
    assert.strictEqual(out[0].axis, 'opaque-transform');
  });

  test('positive control: a function-expression transform is also flagged (Postel: over-report-safe)', () => {
    const text = 'readModifyWriteStateMd(p, function (c) { return c; }, cwd);';
    assert.strictEqual(guard.findOpaqueStateTransforms('src/x.cts', text).length, 1);
  });

  test('negative control: a declared-intent (identifier) 2nd arg is NOT flagged', () => {
    const text = 'readModifyWriteStateMd(p, writeIntent, cwd);';
    assert.strictEqual(guard.findOpaqueStateTransforms('src/x.cts', text).length, 0);
  });

  test('negative control: a non-readModifyWriteStateMd call with an arrow is NOT flagged', () => {
    const text = 'someOther(p, (c) => c, cwd);';
    assert.strictEqual(guard.findOpaqueStateTransforms('src/x.cts', text).length, 0);
  });

  test('no behavior change: the capability is NOT wired into the failing scan (collect has no opaque-transform findings)', () => {
    // C1 ships recognition; C2 wires enforcement. Wiring it now would red the ~16 residual callers.
    const { findings } = guard.collect();
    assert.strictEqual(
      findings.some((f) => f.reason === REASON.OPAQUE_STATE_TRANSFORM),
      false,
      'C1 must not wire opaque-transform into collect() (that is C2, §8.2/§8.3 Required — Phase 2)',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// F4 — #5104 (epic #4629, ADR-4629 Decision 5: Axis 2 "extended"): a raw
// write whose call is wrapped over several lines, or whose target is a
// variable assigned in the same function, is still a raw STATE.md write.
// Before #5104 the axis scanned one line at a time and matched only the
// `statePath` identifier or a `STATE.md` literal in the captured argument,
// so every positive row below reported 0.
// ─────────────────────────────────────────────────────────────────────────

describe('F4 — the raw-write axis sees wrapped calls and same-function variable targets (#5104)', () => {
  const { MAX_TARGET_RESOLUTION_HOPS, nearestPrecedingAssignment } = guard;

  // W(...) wraps body lines in a function; `lines` is the reported lines.
  const W = (...body) => ['function w(statePath, dir, c) {', ...body, '}'].join('\n');
  const lines = (text) => findRawStateWrites(OTHER_FILE, text).map((f) => f.line);

  // `lookups` assignments stand between the write target `v0` and the
  // STATE.md literal: v0 = v1, v1 = v2, ..., v(lookups-1) = path.join(dir, 'STATE.md').
  function chainFixture(lookups) {
    const out = ['function chained(dir, content) {', `  const v${lookups - 1} = path.join(dir, 'STATE.md');`];
    for (let k = lookups - 2; k >= 0; k--) out.push(`  const v${k} = v${k + 1};`);
    out.push('  fs.writeFileSync(v0, content);', '}');
    return out.join('\n');
  }

  test('guard: a call wrapped over several lines is reported at the line of the call', () => {
    const out = findRawStateWrites(OTHER_FILE, W('  fs.writeFileSync(', '    statePath,', '    c,', '  );'));
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reason, REASON.RAW_STATE_WRITE);
    assert.strictEqual(out[0].line, 2);
    assert.strictEqual(out[0].source, 'fs.writeFileSync(');
    assert.deepStrictEqual(lines(W('  fs.writeFileSync( // the state file', '    statePath, c);')), [2]);
  });

  test('guard: a variable resolved through same-function assignments is reported', () => {
    // From a STATE.md literal, from statePath, through a file-name constant, and wrapped.
    assert.deepStrictEqual(lines(W("  const p = path.join(dir, 'STATE.md');", '  fs.writeFileSync(p, c);')), [3]);
    assert.deepStrictEqual(lines(W('  const target = statePath;', '  fs.writeFileSync(target, c);')), [3]);
    assert.deepStrictEqual(lines(W("  const name = 'STATE.md';", '  const p = path.join(dir, name);', '  fs.writeFileSync(p, c);')), [4]);
    assert.deepStrictEqual(lines(W("  const p = path.join(dir, 'STATE.md');", '  fs.writeFileSync(', '    p,', '    c);')), [3]);
  });

  test('guard: an assignment earlier on the write\'s own line is read, one after the call is not', () => {
    assert.deepStrictEqual(lines(W("  const p = path.join(dir, 'STATE.md'); fs.writeFileSync(p, c);")), [2]);
    assert.deepStrictEqual(
      lines(['function w(p, dir, c) {', "  fs.writeFileSync(p, c); p = path.join(dir, 'STATE.md');", '}'].join('\n')),
      [],
    );
  });

  test('guard: a reassignment that reads its own earlier value resolves to that earlier assignment', () => {
    assert.deepStrictEqual(lines(W("  let p = path.join(dir, 'STATE.md');", "  p = p + '.tmp';", '  fs.writeFileSync(p, c);')), [4]);
    // ...and terminates when the earlier value is not STATE.md.
    assert.deepStrictEqual(lines(W("  let p = path.join(dir, 'notes');", "  p = p + '.md';", '  fs.writeFileSync(p, c);')), []);
  });

  test('guard: a write inside a nested arrow, method or callback still reads the enclosing variable', () => {
    const p = "  const p = path.join(dir, 'STATE.md');";
    assert.deepStrictEqual(lines(W(p, '  const flush = () => {', '    fs.writeFileSync(p, c);', '  };')), [4]);
    assert.deepStrictEqual(lines(W(p, '  return {', '    commit() {', '      fs.writeFileSync(p, c);', '    },', '  };')), [5]);
    assert.deepStrictEqual(lines(W(p, '  withLock(() => { fs.writeFileSync(p, c); });')), [3]);
    assert.deepStrictEqual(lines(W(p, '  function flush() { fs.writeFileSync(p, c); }')), [3]);
    assert.deepStrictEqual(lines(W(p, '  items.forEach((item) => {', '    fs.writeFileSync(p, item);', '  });')), [4]);
  });

  test('guard: an assignment and write in a one-line block or arrow body, or a reassignment in a closed block, is reported', () => {
    assert.deepStrictEqual(lines(W("  if (c) { const p = path.join(dir, 'STATE.md'); fs.writeFileSync(p, c); }")), [2]);
    assert.deepStrictEqual(lines("const w = () => { const p = join(dir,'STATE.md'); fs.writeFileSync(p,c); };"), [1]);
    assert.deepStrictEqual(lines(['function f(p, statePath, c) {', '  if (a) { p = statePath; } fs.writeFileSync(p, c);', '}'].join('\n')), [2]);
  });

  test('bound: chains of MAX_TARGET_RESOLUTION_HOPS - 1 and exactly MAX lookups are reported, one more is not', () => {
    assert.ok(Number.isInteger(MAX_TARGET_RESOLUTION_HOPS) && MAX_TARGET_RESOLUTION_HOPS > 1);
    assert.strictEqual(findRawStateWrites(OTHER_FILE, chainFixture(MAX_TARGET_RESOLUTION_HOPS - 1)).length, 1);
    assert.strictEqual(findRawStateWrites(OTHER_FILE, chainFixture(MAX_TARGET_RESOLUTION_HOPS)).length, 1);
    assert.strictEqual(findRawStateWrites(OTHER_FILE, chainFixture(MAX_TARGET_RESOLUTION_HOPS + 1)).length, 0);
  });

  // Work bounds. Source files are untrusted input to lint:ci, so the work of
  // resolving a target must stay polynomial in the file, whatever its text.
  // Counted, not timed: `stats.assignmentLookups` is the number of
  // nearestPrecedingAssignment calls and `stats.linesRead` the lines they read.
  //
  // Every hop branches over each name a right-hand side reads. Memoized on
  // (name, line, hops left), each of the N names is looked up from at most
  // N + 1 lines at each of MAX_TARGET_RESOLUTION_HOPS depths, and with one
  // assignment per name each lookup ends within 2 calls.
  test('bound: right-hand sides that each read every name cost a polynomial number of assignment lookups', () => {
    const N = 20;
    const sum = Array.from({ length: N }, (_, k) => `v${k}`).join(' + ');
    const body = [];
    for (let k = 0; k < N; k++) body.push(`  let v${k} = ${sum};`, '  { }');
    body.push(`  fs.writeFileSync(${sum}, c);`);
    const stats = {};
    const out = findRawStateWrites(OTHER_FILE, W(...body), stats);
    assert.strictEqual(typeof stats.assignmentLookups, 'number', 'findRawStateWrites reports assignmentLookups');
    assert.ok(stats.assignmentLookups > 0, 'the seam counts lookups');
    assert.ok(stats.assignmentLookups <= 2 * N * (N + 1) * MAX_TARGET_RESOLUTION_HOPS, `${stats.assignmentLookups} lookups`);
    assert.deepStrictEqual(out, []);
  });

  // The same names with many writes. A verdict below a write's line is the
  // same for every write that sees the same body boundaries after it, so the
  // first write resolves as in the row above, and each later write only looks
  // up its N target names from its own line (each within 2 calls).
  test('bound: later writes in a file reuse the verdicts below their line', () => {
    const N = 10;
    const WRITES = 50;
    const sum = Array.from({ length: N }, (_, k) => `v${k}`).join(' + ');
    const body = [];
    for (let k = 0; k < N; k++) body.push(`  let v${k} = ${sum};`, '  { }');
    for (let k = 0; k < WRITES; k++) body.push(`  fs.writeFileSync(${sum}, c);`);
    const stats = {};
    const out = findRawStateWrites(OTHER_FILE, W(...body), stats);
    assert.ok(stats.assignmentLookups > 0, 'the seam counts lookups');
    const bound = 2 * N * (N + 1) * MAX_TARGET_RESOLUTION_HOPS + WRITES * 2 * N;
    assert.ok(stats.assignmentLookups <= bound, `${stats.assignmentLookups} lookups, bound ${bound}`);
    assert.deepStrictEqual(out, []);
  });

  // A verdict below a write's line is shared with a later write only when the
  // same body boundaries follow it: here a `}` between the two writes lets the
  // second one go past `p = x` to the STATE.md assignment, so they differ.
  test('bound: a shared verdict is not reused across a body boundary between two writes', () => {
    const text = W("  let p = path.join(dir, 'STATE.md');", '  p = x;', '  const q = p;', '  fs.writeFileSync(q, c);', '  }', '  fs.writeFileSync(q, c);');
    assert.deepStrictEqual(lines(text), [7]);
  });

  // Many writes in one file. A line above a write reads the same for every
  // write, so the file's lines are read at most once per name across all of
  // its writes, and each write's own line (cut at the call) once per name it
  // resolves. Here the names are `p`, `path` and `dir`.
  test('bound: many writes in one file read each line at most once per name, plus each write\'s own line', () => {
    const N = 200;
    const body = ["  let p = path.join(dir, 'notes');", '  { }'];
    for (let k = 0; k < N; k++) body.push('  fs.writeFileSync(p, c);');
    const text = W(...body);
    const names = ['p', 'path', 'dir'];
    const stats = {};
    const out = findRawStateWrites(OTHER_FILE, text, stats);
    assert.strictEqual(typeof stats.linesRead, 'number', 'findRawStateWrites reports linesRead');
    assert.ok(stats.linesRead > 0, 'the seam counts lines read');
    const fileLines = text.split('\n').length;
    assert.ok(stats.linesRead <= names.length * (fileLines + N), `${stats.linesRead} lines read`);
    assert.deepStrictEqual(out, []);
  });

  // A long run of whitespace on a line that names the variable. Only the
  // verdicts are asserted: the time a line costs has no counter here.
  test('whitespace: a long run of spaces on a binding line changes no verdict', () => {
    const ws = ' '.repeat(4000);
    assert.deepStrictEqual(lines(W(`  const p${ws}x;`, '  fs.writeFileSync(p, c);')), []);
    assert.deepStrictEqual(lines(W(`  const p${ws}= path.join(dir, 'STATE.md');`, '  fs.writeFileSync(p, c);')), [3]);
    assert.deepStrictEqual(lines(W(`  const p:${ws}string = path.join(dir, 'STATE.md');`, '  fs.writeFileSync(p, c);')), [3]);
    assert.deepStrictEqual(lines(W(`  const p = path.join(dir, 'STATE.md');`, `  for (const p${ws}of xs) {`, '    fs.writeFileSync(p, c);', '  }')), []);
    assert.deepStrictEqual(lines(W(`  const p = path.join(dir, 'STATE.md');`, `  for (const${ws}q${ws}x) {`, '    fs.writeFileSync(p, c);', '  }')), [4]);
  });

  // A run after `=` that a line terminator `.` does not match ends (`\r` in a
  // CRLF file, U+2028). Each assignment head the scan matches is decided once,
  // so the heads decided are at most the occurrences of the name. The count
  // bounds the matches tried, not the steps inside one; verdicts are pinned.
  test('bound: a run after `=` ending in \\r or U+2028 decides each assignment head once', () => {
    const ws = ' '.repeat(4000);
    for (const end of ['\r', '\u2028']) {
      const unread = W(`  const p =${ws}x;${end}`, '  p = p = p = p;' + end, '  fs.writeFileSync(p, c);');
      const stats = {};
      assert.deepStrictEqual(findRawStateWrites(OTHER_FILE, unread, stats).map((f) => f.line), [], JSON.stringify(end));
      assert.strictEqual(typeof stats.assignmentMatches, 'number', 'findRawStateWrites reports assignmentMatches');
      assert.ok(stats.assignmentMatches > 0, 'the seam counts assignment heads');
      assert.ok(stats.assignmentMatches <= unread.match(/\bp\b/g).length, `${stats.assignmentMatches} heads`);
      // The terminator inside the run, before the value: the value is read.
      assert.deepStrictEqual(lines(W(`  const p =${ws}${end}  path.join(dir, 'STATE.md');`, '  fs.writeFileSync(p, c);')), [3], JSON.stringify(end));
    }
  });

  test('stats: null or undefined receives nothing and changes no finding', () => {
    const text = W("  const p = path.join(dir, 'STATE.md');", '  fs.writeFileSync(p, c);');
    const expected = findRawStateWrites(OTHER_FILE, text, {});
    assert.strictEqual(expected.length, 1);
    assert.deepStrictEqual(findRawStateWrites(OTHER_FILE, text, null), expected);
    assert.deepStrictEqual(findRawStateWrites(OTHER_FILE, text, undefined), expected);
    assert.deepStrictEqual(findRawStateWrites(OTHER_FILE, text), expected);
  });

  // The cap on one write's own text, MAX_RAW_WRITE_TEXT_LENGTH: its first
  // argument, and its line before the call. Past it the write is reported
  // unresolved, never passed (fail closed).
  test('cap: a first argument of MAX_RAW_WRITE_TEXT_LENGTH - 1 or exactly MAX characters is resolved, one more is reported unresolved', () => {
    const { MAX_RAW_WRITE_TEXT_LENGTH: MAX } = guard;
    assert.ok(Number.isInteger(MAX) && MAX > 'statePath'.length, 'MAX_RAW_WRITE_TEXT_LENGTH is exported');
    const reasons = (text) => findRawStateWrites(OTHER_FILE, text).map((f) => [f.line, f.reason]);
    // An unassigned name, padded with spaces: resolved and not reported up to
    // the cap.
    const named = (len) => W(`  fs.writeFileSync(a${' '.repeat(len - 1)}, c);`);
    assert.deepStrictEqual(reasons(named(MAX - 1)), []);
    assert.deepStrictEqual(reasons(named(MAX)), []);
    assert.deepStrictEqual(reasons(named(MAX + 1)), [[2, REASON.RAW_STATE_WRITE_UNRESOLVED]]);
    // The state path: reported either way, unresolved past the cap.
    const state = (len) => W(`  fs.writeFileSync(statePath${' '.repeat(len - 'statePath'.length)}, c);`);
    assert.deepStrictEqual(reasons(state(MAX - 1)), [[2, REASON.RAW_STATE_WRITE]]);
    assert.deepStrictEqual(reasons(state(MAX)), [[2, REASON.RAW_STATE_WRITE]]);
    assert.deepStrictEqual(reasons(state(MAX + 1)), [[2, REASON.RAW_STATE_WRITE_UNRESOLVED]]);
    // A call left open at the end of the file reads what is left, as before.
    assert.deepStrictEqual(reasons('function w(c) {\n  fs.writeFileSync(\n'), []);
  });

  test('cap: a line holding MAX_RAW_WRITE_TEXT_LENGTH - 1 or exactly MAX characters before the call is resolved, one more is reported unresolved', () => {
    const { MAX_RAW_WRITE_TEXT_LENGTH: MAX } = guard;
    const reasons = (text) => findRawStateWrites(OTHER_FILE, text).map((f) => [f.line, f.reason]);
    const before = (len, target) => W(`${' '.repeat(len)}fs.writeFileSync(${target}, c);`);
    assert.deepStrictEqual(reasons(before(MAX - 1, 'q')), []);
    assert.deepStrictEqual(reasons(before(MAX, 'q')), []);
    assert.deepStrictEqual(reasons(before(MAX + 1, 'q')), [[2, REASON.RAW_STATE_WRITE_UNRESOLVED]]);
    assert.deepStrictEqual(reasons(before(MAX, 'statePath')), [[2, REASON.RAW_STATE_WRITE]]);
    assert.deepStrictEqual(reasons(before(MAX + 1, 'statePath')), [[2, REASON.RAW_STATE_WRITE_UNRESOLVED]]);
  });

  // Counted, not timed: `stats.argumentChars` is the characters the argument
  // capture read, which `targetsStatePath` and `identifiersIn` then read
  // again. Without the cap, each call left open read the rest of the file.
  test('bound: calls left open, one per line, read at most MAX_RAW_WRITE_TEXT_LENGTH + 1 argument characters each, and are reported', () => {
    const { MAX_RAW_WRITE_TEXT_LENGTH: MAX } = guard;
    const N = 1000;
    const text = 'function f(){\n' + 'fs.writeFileSync(\n'.repeat(N) + '}';
    const stats = {};
    const out = findRawStateWrites(OTHER_FILE, text, stats);
    assert.strictEqual(typeof stats.argumentChars, 'number', 'findRawStateWrites reports argumentChars');
    assert.ok(stats.argumentChars > 0, 'the seam counts argument characters');
    assert.ok(stats.argumentChars <= N * (MAX + 1), `${stats.argumentChars} argument characters, bound ${N * (MAX + 1)}`);
    // Every call whose remaining text is longer than the cap is reported, once.
    const open = [...text.matchAll(/fs\.writeFileSync\(/g)].map((c) => c.index + c[0].length);
    const expected = open.filter((start) => text.length - start > MAX).map((start) => text.slice(0, start).split('\n').length);
    assert.ok(expected.length > 0 && expected[0] === 2, 'the fixture holds calls past the cap');
    assert.deepStrictEqual(out.map((f) => f.line), expected);
    assert.ok(out.every((f) => f.reason === REASON.RAW_STATE_WRITE_UNRESOLVED));
  });

  // Counted, not timed: `stats.ownLineChars` is the characters of each
  // write's line before the call, counted at each read (the cut, then once per
  // name looked up from the write's own line; here only `p`). Without the cap,
  // each of the writes re-read the whole line before it.
  test('bound: many writes on one line read at most MAX_RAW_WRITE_TEXT_LENGTH characters of the line before each call, and the line is reported unresolved once', () => {
    const { MAX_RAW_WRITE_TEXT_LENGTH: MAX } = guard;
    const N = 2000;
    const many = (value) => W(`  let p = ${value};`, '  { }', '  ' + 'fs.writeFileSync(p, c); '.repeat(N));
    const stats = {};
    const out = findRawStateWrites(OTHER_FILE, many("path.join(dir, 'notes')"), stats);
    assert.strictEqual(typeof stats.ownLineChars, 'number', 'findRawStateWrites reports ownLineChars');
    assert.ok(stats.ownLineChars > 0, 'the seam counts own-line characters');
    assert.ok(stats.ownLineChars <= 2 * N * MAX, `${stats.ownLineChars} own-line characters, bound ${2 * N * MAX}`);
    assert.ok(stats.argumentChars <= N * (MAX + 1), `${stats.argumentChars} argument characters`);
    assert.deepStrictEqual(out.map((f) => [f.line, f.reason]), [[4, REASON.RAW_STATE_WRITE_UNRESOLVED]]);
    // With a STATE.md target, the writes within the cap are still reported
    // as raw writes: the cap adds a finding, it does not drop one.
    const state = findRawStateWrites(OTHER_FILE, many('statePath'));
    assert.ok(state.filter((f) => f.reason === REASON.RAW_STATE_WRITE).length > 0);
    assert.strictEqual(state.filter((f) => f.reason === REASON.RAW_STATE_WRITE_UNRESOLVED).length, 1);
    assert.ok(state.every((f) => f.line === 4));
  });

  // The file's resolver budget, MAX_RAW_WRITE_RESOLVER_WORK, counted in
  // `stats.resolverWork`: each write's argument and line before the call by
  // length, and each line the resolver reads by `lineReadWork`. Past it the
  // write is reported unresolved, never passed (fail closed).
  test('budget: a file that takes MAX_RAW_WRITE_RESOLVER_WORK - 1 or exactly MAX work is resolved, one more is reported unresolved', () => {
    const { MAX_RAW_WRITE_RESOLVER_WORK: MAX, lineReadWork } = guard;
    assert.ok(Number.isInteger(MAX) && MAX > 0, 'MAX_RAW_WRITE_RESOLVER_WORK is exported');
    // Two padding lines between the assignment of `p` and the write are read
    // once, for `p`. `wide` holds `p`, so it is charged per `(`; `narrow` does
    // not, so it is charged its length plus the fixed cost of a read.
    const fixture = (wide, narrow) => W("  let p = path.join(dir, 'notes');", wide, narrow, "  fs.writeFileSync(p, 'x');");
    const run = (text) => {
      const stats = {};
      const out = findRawStateWrites(OTHER_FILE, text, stats).map((f) => [f.line, f.reason]);
      return { out, work: stats.resolverWork };
    };
    const base = run(fixture('', ''));
    assert.strictEqual(typeof base.work, 'number', 'findRawStateWrites reports resolverWork');
    assert.deepStrictEqual(base.out, []);
    const D = 10000;
    const READ = lineReadWork('', 'p'); // the fixed cost of a read
    const NAME = lineReadWork('p', 'p') - 1 - READ; // one occurrence of `p`
    const sized = (total) => {
      // lineReadWork(wide) = a * D, lineReadWork(narrow) = r, READ <= r < READ + D.
      const charge = total - base.work + 2 * READ; // the empty padding lines
      const a = Math.floor((charge - READ) / D);
      const r = charge - a * D;
      const wide = 'p' + '('.repeat(D - 1) + 'x'.repeat(a - READ - NAME - D);
      const narrow = 'x'.repeat(r - READ);
      assert.strictEqual(lineReadWork(wide, 'p') + lineReadWork(narrow, 'p'), charge);
      return fixture(wide, narrow);
    };
    for (const total of [MAX - 1, MAX]) {
      const got = run(sized(total));
      assert.deepStrictEqual(got.out, [], `total ${total}`);
      assert.strictEqual(got.work, total);
    }
    const over = run(sized(MAX + 1));
    assert.deepStrictEqual(over.out, [[5, REASON.RAW_STATE_WRITE_UNRESOLVED]]);
    assert.ok(over.work <= MAX, `${over.work} work`);
    // A write that names the state path outright reads no line, and its
    // argument and line before the call are still charged.
    const direct = {};
    assert.strictEqual(findRawStateWrites(OTHER_FILE, W('  fs.writeFileSync(statePath, c);'), direct).length, 1);
    assert.strictEqual(direct.linesRead, 0);
    assert.strictEqual(direct.resolverWork, direct.argumentChars + direct.ownLineChars);
    assert.ok(direct.resolverWork > 0);
  });

  // Counted, not timed. Each name's first lookup reads back to the enclosing
  // named function, so N writes of N different names read about N * N / 2
  // lines without the budget. The long second argument makes each line cost
  // more, so fewer writes reach the budget.
  test('bound: writes that each name a different variable stop at the file\'s budget, and every later write is reported unresolved', () => {
    const { MAX_RAW_WRITE_RESOLVER_WORK: MAX } = guard;
    const N = 1800;
    const body = [];
    for (let k = 0; k < N; k++) body.push(`  fs.writeFileSync(a${k}, '${'x'.repeat(200)}');`);
    const stats = {};
    const out = findRawStateWrites(OTHER_FILE, W(...body), stats);
    assert.ok(stats.resolverWork <= MAX, `${stats.resolverWork} work`);
    assert.ok(stats.linesRead < (N * N) / 2, `${stats.linesRead} lines read`);
    assert.ok(out.length > 0 && out.length < N, `${out.length} reported`);
    assert.ok(out.every((f) => f.reason === REASON.RAW_STATE_WRITE_UNRESOLVED));
    // The reported writes are the last ones, each once: lines first..N+1.
    const first = out[0].line;
    assert.deepStrictEqual(out.map((f) => f.line), Array.from({ length: N + 2 - first }, (_, k) => first + k));
  });

  // Counted, not timed. A line that repeats a typed head, a `for` header or a
  // destructuring head scans to its end once per repeat; `lineReadWork`
  // charges it per repeat, so past the budget it is not read at all.
  test('bound: a line repeating a typed, for or destructuring head is charged per repeat, and past the budget the write is reported unresolved', () => {
    const { MAX_RAW_WRITE_RESOLVER_WORK: MAX } = guard;
    for (const head of ['const p: ', 'for (const p ', 'const {p ']) {
      const shape = (n) => W(`  ${head.repeat(n)}`, '  fs.writeFileSync(p, c);');
      // A few repeats: read, and not reported.
      assert.deepStrictEqual(lines(shape(100)), [], head);
      const stats = {};
      const out = findRawStateWrites(OTHER_FILE, shape(8000), stats);
      assert.ok(stats.resolverWork <= MAX, `${head}: ${stats.resolverWork} work`);
      assert.deepStrictEqual(out.map((f) => [f.line, f.reason]), [[3, REASON.RAW_STATE_WRITE_UNRESOLVED]], head);
    }
  });

  // Counted, not timed. Every write that reaches a wide right-hand side used
  // to read it again; it is now read once and kept for later writes.
  test('bound: a wide right-hand side is read once for all the writes that reach it', () => {
    const rhs = Array.from({ length: 2000 }, (_, k) => `a${k}`).join(' + ');
    const work = (writes) => {
      const stats = {};
      const body = [`  let p = ${rhs};`];
      for (let k = 0; k < writes; k++) body.push('  fs.writeFileSync(p, c);');
      assert.deepStrictEqual(findRawStateWrites(OTHER_FILE, W(...body), stats), []);
      return stats.resolverWork;
    };
    const W1 = 100;
    const perWrite = (work(2 * W1) - work(W1)) / W1;
    assert.ok(perWrite > 0 && perWrite < rhs.length / 4, `${perWrite} work per write, right-hand side ${rhs.length}`);
    // The one read of a right-hand side is charged: with a single name in it,
    // its line read, its right-hand side read and the two readers (`p`, `a`)
    // are most of the work.
    const { READER_WORK } = guard;
    const same = Array(2000).fill('a').join(' + ');
    const stats = {};
    findRawStateWrites(OTHER_FILE, W(`  let p = ${same};`, '  fs.writeFileSync(p, c);'), stats);
    const floor = 2 * same.length + stats.readersBuilt * READER_WORK;
    assert.ok(stats.resolverWork >= floor, `${stats.resolverWork} work, floor ${floor}`);
  });

  // Counted, not timed. Past a body boundary a write walks every earlier
  // assignment of its name, and most of those lookups end in the cache
  // without reading a line, so each lookup is charged on its own.
  test('bound: every lookup and line read is charged, so walking earlier assignments past body boundaries is bounded by the budget', () => {
    const { MAX_RAW_WRITE_RESOLVER_WORK: MAX, LOOKUP_WORK, lineReadWork } = guard;
    const N = 300;
    const body = [];
    for (let k = 0; k < N; k++) body.push(`  p = q${k};`, '  }');
    for (let k = 0; k < N; k++) body.push('  fs.writeFileSync(p, c);');
    const stats = {};
    assert.deepStrictEqual(findRawStateWrites(OTHER_FILE, W(...body), stats), []);
    assert.ok(Number.isInteger(LOOKUP_WORK) && LOOKUP_WORK > 0, 'LOOKUP_WORK is exported');
    assert.ok(stats.assignmentLookups >= N * N, `${stats.assignmentLookups} lookups`);
    const READ = lineReadWork('', 'p'); // the fixed cost of a read
    assert.ok(READ > 1);
    assert.ok(stats.resolverWork >= stats.assignmentLookups * LOOKUP_WORK + stats.linesRead * READ, `${stats.resolverWork} work`);
    assert.ok(stats.resolverWork <= MAX);
  });

  // Counted, not timed. A name that occurs at many overlapping offsets (a run
  // of `a` read for the name `aaa...`) makes the head regex read the name
  // again at each one, so a read is charged occurrences x name length too.
  test('bound: a name occurring at many overlapping offsets is charged per occurrence, and past the budget its writes are reported unresolved', () => {
    const { MAX_RAW_WRITE_RESOLVER_WORK: MAX } = guard;
    const run = (L, M, K, writes) => {
      const body = Array(K).fill('a'.repeat(M));
      for (let w = 0; w < writes; w++) body.push(`  fs.writeFileSync(${'a'.repeat(L - w)}, c);`);
      const stats = {};
      const out = findRawStateWrites(OTHER_FILE, W(...body), stats);
      return { out, stats };
    };
    // One read of a 20000-character run for a 200-character name.
    const small = run(200, 20000, 1, 1);
    assert.deepStrictEqual(small.out, []);
    assert.ok(small.stats.resolverWork >= (20000 - 200 + 1) * 200, `${small.stats.resolverWork} work`);
    // The review's shape, shortened: its 4000-character names are longer than
    // MAX_RESOLVED_NAME_LENGTH, so each is charged as the whole budget, no
    // line is read and every write is reported.
    const big = run(4000, 100000, 2, 2);
    assert.ok(big.stats.resolverWork <= MAX, `${big.stats.resolverWork} work`);
    assert.deepStrictEqual(big.out.map((f) => f.reason), [REASON.RAW_STATE_WRITE_UNRESOLVED, REASON.RAW_STATE_WRITE_UNRESOLVED]);
  });

  // A name's regexes are compiled once per file (its reader), which takes far
  // longer than a lookup and is kept for the file, so building one is charged.
  // Counted, not timed.
  test('bound: each distinct name builds one reader, charged by its length, short or long', () => {
    const { READER_WORK, READER_WORK_PER_CHAR } = guard;
    assert.ok(Number.isInteger(READER_WORK) && READER_WORK > 0 && Number.isInteger(READER_WORK_PER_CHAR), 'reader charges are exported');
    for (const L of [6, 200]) {
      const N = 100;
      const name = (k) => `n${k}_`.padEnd(L, 'x');
      const body = [];
      for (let k = 0; k < N; k++) body.push(`  ${name(k)} = q;`, `  fs.writeFileSync(${name(k)}, c);`);
      const stats = {};
      assert.deepStrictEqual(findRawStateWrites(OTHER_FILE, W(...body), stats), []);
      assert.strictEqual(stats.readersBuilt, N + 1, 'one reader per written name, and one for q');
      const readers = N * (READER_WORK + READER_WORK_PER_CHAR * L) + READER_WORK + READER_WORK_PER_CHAR;
      assert.ok(stats.resolverWork >= readers, `L=${L}: ${stats.resolverWork} work, readers ${readers}`);
    }
  });

  test('cap: a name of MAX_RESOLVED_NAME_LENGTH - 1 or exactly MAX characters is resolved, one more spends the budget and is reported unresolved', () => {
    const { MAX_RESOLVED_NAME_LENGTH: MAX } = guard;
    assert.ok(Number.isInteger(MAX) && MAX > 0, 'MAX_RESOLVED_NAME_LENGTH is exported');
    const reasons = (text) => findRawStateWrites(OTHER_FILE, text).map((f) => [f.line, f.reason]);
    const named = (len) => W(`  fs.writeFileSync(${'a'.repeat(len)}, c);`, '  fs.writeFileSync(q, c);');
    assert.deepStrictEqual(reasons(named(MAX - 1)), []);
    assert.deepStrictEqual(reasons(named(MAX)), []);
    // The write with the long name, and the later one, are reported.
    assert.deepStrictEqual(reasons(named(MAX + 1)), [[2, REASON.RAW_STATE_WRITE_UNRESOLVED], [3, REASON.RAW_STATE_WRITE_UNRESOLVED]]);
  });

  // Counted, not timed. Quoted strings are dropped from an expression before
  // its names are read. A run of escaped quotes (here inside a template
  // literal, which the argument capture treats as one string) used to cost
  // that step time quadratic in the run; each character is now examined at
  // most three times.
  test('bound: a run of escaped quotes in a target or a right-hand side is stripped in one pass', () => {
    const run = "`'" + "\\'".repeat(1000) + '`';
    const shapes = [W(`  fs.writeFileSync(${run}, c);`), W(`  const q = ${run};`, '  fs.writeFileSync(q, c);')];
    for (const text of shapes) {
      const stats = {};
      assert.deepStrictEqual(findRawStateWrites(OTHER_FILE, text, stats), []);
      assert.strictEqual(typeof stats.stringScanChars, 'number', 'findRawStateWrites reports stringScanChars');
      assert.ok(stats.stringScanChars >= run.length, `${stats.stringScanChars} characters examined`);
      const bound = 3 * (stats.argumentChars + run.length);
      assert.ok(stats.stringScanChars <= bound, `${stats.stringScanChars} characters examined, bound ${bound}`);
    }
  });

  test('budget: once it is spent, every later write in the file is reported, and earlier verdicts stand', () => {
    const text = [
      'function a(statePath, c) {',
      '  fs.writeFileSync(statePath, c);',
      `  ${'const p: '.repeat(8000)}`,
      '  fs.writeFileSync(p, c);',
      '}',
      'function b(statePath, q, c) {',
      '  fs.writeFileSync(statePath, c);',
      '  fs.writeFileSync(q, c);',
      '}',
    ].join('\n');
    assert.deepStrictEqual(findRawStateWrites(OTHER_FILE, text).map((f) => [f.line, f.reason]), [
      [2, REASON.RAW_STATE_WRITE],
      [4, REASON.RAW_STATE_WRITE_UNRESOLVED],
      [7, REASON.RAW_STATE_WRITE_UNRESOLVED],
      [8, REASON.RAW_STATE_WRITE_UNRESOLVED],
    ]);
  });

  test('control: a variable assigned from a non-STATE.md literal, or a loop over an unrelated list, is NOT reported', () => {
    assert.deepStrictEqual(lines(W("  const p = path.join(dir, 'ROADMAP.md');", '  fs.writeFileSync(p, c);')), []);
    assert.deepStrictEqual(lines(W('  for (const f of files) {', '    fs.writeFileSync(f, c);', '  }')), []);
  });

  test('binding: a for...of or destructuring binding stops resolution; a same-named const in a sibling block is not picked up', () => {
    // The real shape (src/roadmap-upgrade.cts rollback loop): without the
    // binding rule the backward scan skips `for (const [filePath, backup] of …)`
    // (it has no `=`) and resolves to the sibling block's `const filePath`.
    const sibling = ['  {', "    const filePath = path.join(dir, 'STATE.md');", '    platformWriteSync(filePath, c);', '  }'];
    assert.deepStrictEqual(lines(W(...sibling, '  for (const [filePath, backup] of backups) {', '    fs.writeFileSync(filePath, backup.content);', '  }')), []);
    assert.deepStrictEqual(lines(W(...sibling, '  const { filePath, body } = entry;', '  fs.writeFileSync(filePath, body);')), []);
  });

  test('scope: resolution stops at the enclosing named function, and skips strings and property names', () => {
    const otherFn = ['function other(dir) {', "  const p = path.join(dir, 'STATE.md');", '  return p;', '}'];
    assert.deepStrictEqual(lines([...otherFn, 'function writer(p, c) {', '  fs.writeFileSync(p, c);', '}'].join('\n')), []);
    assert.deepStrictEqual(
      lines(W('  const target = statePath;', "  fs.writeFileSync(path.join(dir, 'target'), c);", '  fs.writeFileSync(opts.target, c);')),
      [],
    );
  });

  // Boundary rule: an assignment in a closed
  // sibling block or arrow body is not in scope at the write. The nearest
  // assignment ends the search only when no `{`, `}` or `=>` lies between it
  // and the write; otherwise the search goes on to the next earlier one.
  test('boundary: an outer STATE.md binding shadowed only inside a closed block or arrow body is still reported', () => {
    const outer = "  const p = path.join(dir, 'STATE.md');";
    const inner = "    const p = path.join(dir, 'ROADMAP.md');";
    assert.deepStrictEqual(lines(W(outer, '  if (x) {', inner, '    use(p);', '  }', '  fs.writeFileSync(p, c);')), [7]);
    assert.deepStrictEqual(lines(W(outer, "  if (x) { const p = 'ROADMAP.md'; use(p); }", '  fs.writeFileSync(p, c);')), [4]);
    assert.deepStrictEqual(lines(W(outer, '  const g = () => {', inner, '    return p;', '  };', '  fs.writeFileSync(p, c);')), [7]);
  });

  test('boundary control: with no boundary between them, the nearest assignment decides', () => {
    assert.deepStrictEqual(lines(W("  const p = path.join(dir, 'STATE.md');", "  p = path.join(dir, 'ROADMAP.md');", '  fs.writeFileSync(p, c);')), []);
    assert.deepStrictEqual(
      lines(W('  withLock(() => {', "    const p = path.join(dir, 'ROADMAP.md');", '    fs.writeFileSync(p, c);', '  });')),
      [],
    );
  });

  // Typed declarations: the scanned sources
  // are TypeScript, so a declaration may carry an annotation before `=`.
  test('typed: a typed declaration binds its name for Axis 2', () => {
    for (const decl of ['const p: string', 'let p: string', 'var p: string', 'const p: Array<string>', 'let p: string | undefined', 'const p: Record<string, string>']) {
      assert.deepStrictEqual(lines(W(`  ${decl} = path.join(dir, 'STATE.md');`, '  fs.writeFileSync(p, c);')), [3], decl);
    }
    // A comparison, an object key, or a declaration with no initializer is not an assignment to `p`.
    for (const line of ["  const ok: boolean = p == path.join(dir, 'STATE.md');", "  const o = { p: path.join(dir, 'STATE.md') };", "  let p: string; const q = path.join(dir, 'STATE.md');"]) {
      assert.deepStrictEqual(lines(['function w(p, dir, c) {', line, '  fs.writeFileSync(p, c);', '}'].join('\n')), [], line);
    }
  });

  test('Axis 3 is unchanged: without options, nearestPrecedingAssignment reads only the untyped forms, as before #5104', () => {
    // Axis 3 calls nearestPrecedingAssignment with no options; Axis 2's typed
    // and binding rules are opt-in, so Axis 3's verdicts do not move.
    // The right-hand side runs to the line end, `;` included, as it always has.
    const rhs = 'stripFrontmatter(content)';
    for (const form of [`  const p = ${rhs};`, `  let p = ${rhs};`, `  p = ${rhs};`, `  let p: string; p = ${rhs};`]) {
      assert.strictEqual(nearestPrecedingAssignment([form], 0, 'p'), `${rhs};`, form);
    }
    for (const form of [`  const p: string = ${rhs};`, `  const ok = p === ${rhs};`, `  const o = { p: ${rhs} };`]) {
      assert.strictEqual(nearestPrecedingAssignment([form], 0, 'p'), null, form);
    }
    assert.strictEqual(nearestPrecedingAssignment([`  const p: string = ${rhs};`], 0, 'p', { typed: true }), `${rhs};`);
    assert.deepStrictEqual(nearestPrecedingAssignment(['  for (const p of xs) {'], 0, 'p', { stopAtPatternBinding: true, withLine: true }), null);
    assert.deepStrictEqual(nearestPrecedingAssignment([`  p = ${rhs}`, ''], 1, 'p', { withLine: true }), { rhs, line: 0 });
  });

  // Known gaps. Each row records the CORRECT verdict (`expected`) and asserts
  // today's observed one (`currentBuggyOutput`), per CONTRIBUTING.md's
  // characterization rule (not `{ todo: true }`, which gsd-test counts as a
  // failure). `notDeepStrictEqual` checks only that the row's two literals
  // differ; the `deepStrictEqual` against the guard is what fails loudly when
  // a fix changes the verdict. Flip the row to a regular assertion then. The
  // syntax-tree follow-up that closes these is #5279.
  const gapLoop = (table, kind) => {
    for (const gap of table) {
      test(`known gap (${kind}, currently wrong): ${gap.shape}`, () => {
        assert.notDeepStrictEqual(gap.currentBuggyOutput, gap.expected);
        assert.deepStrictEqual(lines(gap.text), gap.currentBuggyOutput);
      });
    }
  };

  // The file a join names is not read: a directory derived from statePath
  // decides, whatever file is joined to it (false positives).
  const KNOWN_TAIL_GAPS = [
    {
      shape: 'statePath-derived directory joined inline with another file name',
      text: W("  fs.writeFileSync(path.join(path.dirname(statePath), 'ROADMAP.md'), c);"),
      expected: [],
      currentBuggyOutput: [2],
    },
    {
      shape: 'statePath-derived directory joined with another file name through variables',
      text: W('  const d = path.dirname(statePath);', "  const p = path.join(d, 'ROADMAP.md');", '  fs.writeFileSync(p, c);'),
      expected: [],
      currentBuggyOutput: [4],
    },
    {
      shape: 'statePath-derived directory joined with a const holding another file name',
      text: W('  const d = path.dirname(statePath);', "  const n = 'ROADMAP.md';", '  fs.writeFileSync(path.join(d, n), c);'),
      expected: [],
      currentBuggyOutput: [4],
    },
  ];
  gapLoop(KNOWN_TAIL_GAPS, 'join tail');

  // Line-based reading of assignments and scope.
  const KNOWN_SCOPE_GAPS = [
    {
      // Missed: each hop resumes on the line above, so a chain on one line breaks.
      shape: 'two assignments of a chain on the write\'s line',
      text: W("  const d = path.join(dir, 'STATE.md'); const p = d; fs.writeFileSync(p, c);"),
      expected: [2],
      currentBuggyOutput: [],
    },
    {
      // False positive: a right-hand side runs past its own `;` to the line end.
      shape: 'right-hand side running into a later statement on its line',
      text: W("  const p = path.join(dir, 'ROADMAP.md'); const q = statePath;", '  fs.writeFileSync(p, c);'),
      expected: [],
      currentBuggyOutput: [3],
    },
    {
      // Missed: `p += x` is not read as an assignment, so the scan reaches `let p = dir`.
      shape: 'a += that adds the STATE.md segment',
      text: W('  let p = dir;', "  p += '/STATE.md';", '  fs.writeFileSync(p, c);'),
      expected: [4],
      currentBuggyOutput: [],
    },
    {
      // Missed: `.` does not match `\r`, so no assignment line matches in a CRLF file.
      shape: 'a variable target in a CRLF file',
      text: W("  const p = path.join(dir, 'STATE.md');", '  fs.writeFileSync(p, c);').replace(/\n/g, '\r\n'),
      expected: [3],
      currentBuggyOutput: [],
    },
    {
      // False positive: a template is kept whole, so a word in its text is read as a name.
      shape: 'a word in template text that names a statePath variable',
      text: W('  const notes = statePath;', '  const p = `${dir}/notes`;', '  fs.writeFileSync(p, c);'),
      expected: [],
      currentBuggyOutput: [4],
    },
    {
      // Missed: the value starts on the line after `=`.
      shape: 'declaration whose STATE.md value starts on the next line',
      text: W('  const p =', "    path.join(dir, 'STATE.md');", '  fs.writeFileSync(p, c);'),
      expected: [4],
      currentBuggyOutput: [],
    },
    {
      // Missed: only the `=` line is read, so the STATE.md segment on a later line is not.
      shape: 'declaration whose STATE.md value continues on later lines',
      text: W('  const p = path.join(', '    dir,', "    'STATE.md',", '  );', '  fs.writeFileSync(p, c);'),
      expected: [6],
      currentBuggyOutput: [],
    },
    {
      // Missed: only the `=` line is read, so the name holding STATE.md on a later line is not.
      shape: 'declaration whose value continues on later lines with a name holding STATE.md',
      text: W("  const n = 'STATE.md';", '  const p = path.join(', '    dir,', '    n,', '  );', '  fs.writeFileSync(p, c);'),
      expected: [7],
      currentBuggyOutput: [],
    },
    {
      // Missed: the annotation holds a `;`, which ends it.
      shape: 'type annotation holding a semicolon',
      text: W("  const p: { a: string; b: string } = path.join(dir, 'STATE.md');", '  fs.writeFileSync(p, c);'),
      expected: [3],
      currentBuggyOutput: [],
    },
    {
      // Missed: a function header on the write's line ends the scan.
      shape: 'one-line function assigning and writing a STATE.md path',
      text: "function w(){ const p = join(dir,'STATE.md'); fs.writeFileSync(p,c); }",
      expected: [1],
      currentBuggyOutput: [],
    },
    {
      // Missed: the named-function header ends the scan before its default is read.
      shape: 'default parameter holding a STATE.md path',
      text: ["function w(p = path.join(dir, 'STATE.md')) {", '  fs.writeFileSync(p, c);', '}'].join('\n'),
      expected: [2],
      currentBuggyOutput: [],
    },
    {
      // Missed: a module-level constant sits behind the function boundary.
      shape: 'module-level STATE.md file-name constant used inside a function',
      text: ["const STATE_FILENAME = 'STATE.md';", 'function f(d, c) {', '  fs.writeFileSync(path.join(d, STATE_FILENAME), c);', '}'].join('\n'),
      expected: [3],
      currentBuggyOutput: [],
    },
    {
      // Missed: a file name built in another function is not resolved.
      shape: 'STATE.md file name returned by another function',
      text: ['function stateName() {', "  return 'STATE.md';", '}', 'function f(d, c) {', '  fs.writeFileSync(path.join(d, stateName()), c);', '}'].join('\n'),
      expected: [5],
      currentBuggyOutput: [],
    },
    {
      // Missed: a Map built in another function is not resolved, and the key string is dropped.
      shape: 'STATE.md file name held as a Map value built in another function',
      text: ['function names() {', '  const m = new Map();', "  m.set('state', 'STATE.md');", '  return m;', '}', 'function f(d, c) {', '  const m = names();', "  fs.writeFileSync(path.join(d, m.get('state')), c);", '}'].join('\n'),
      expected: [8],
      currentBuggyOutput: [],
    },
    {
      // False positive: a one-line nested function's parameter shadows the outer variable.
      shape: 'one-line nested function parameter shadowing an outer statePath variable',
      text: W('  const target = statePath;', '  function inner(target) { fs.writeFileSync(target, c); }'),
      expected: [],
      currentBuggyOutput: [3],
    },
    {
      // False positive: a named-function header on the write's line is dropped,
      // so a top-level one-line function's parameter resolves to an earlier
      // function's variable.
      shape: "one-line top-level function's parameter resolved into an earlier function",
      text: ['function other(dir) {', "  const p = path.join(dir, 'STATE.md');", '  return p;', '}', 'function w(p, c) { fs.writeFileSync(p, c); }'].join('\n'),
      expected: [],
      currentBuggyOutput: [5],
    },
    {
      // False positive: `x =>` reads as an assignment `x = >…`; past its `{` the
      // search goes on to the outer `let x`.
      shape: 'bare arrow parameter shadowing an outer statePath variable',
      text: W('  let x = statePath;', '  const save = x => {', '    fs.writeFileSync(x, c);', '  };'),
      expected: [],
      currentBuggyOutput: [4],
    },
    {
      // False positive: a `for` header's loop-scoped `let` earlier on the write's line is read.
      shape: "for header's loop-scoped let earlier on the write's line",
      text: W('  for (let p = statePath; i < 0; i++) n++; fs.writeFileSync(p, c);'),
      expected: [],
      currentBuggyOutput: [2],
    },
    {
      // False positive: a block-scoped binding earlier on the write's line is read.
      shape: "block-scoped sibling binding earlier on the write's line",
      text: ['function f(p, statePath, c) {', '  if (a) { const p = statePath; use(p); } else { fs.writeFileSync(p, c); }', '}'].join('\n'),
      expected: [],
      currentBuggyOutput: [2],
    },
    {
      // False positive: an arrow's own parameter shadows the outer STATE.md variable.
      shape: 'same-name arrow parameter shadowing an outer STATE.md variable',
      text: W("  const p = path.join(dir, 'STATE.md');", '  const save = (p) => {', '    fs.writeFileSync(p, c);', '  };'),
      expected: [],
      currentBuggyOutput: [4],
    },
    {
      // False positive: arrows are not boundaries, so `b`'s parameter resolves to `a`'s variable.
      shape: 'sibling arrow body binding the same name',
      text: ['const a = (dir) => {', "  const p = path.join(dir, 'STATE.md');", '  return p;', '};', 'const b = (p, c) => {', '  fs.writeFileSync(p, c);', '};'].join('\n'),
      expected: [],
      currentBuggyOutput: [6],
    },
    ...['save', 'async save'].map((head) => ({
      // False positive: a method header has no `function` keyword, so it does
      // not end the scan, and the parameter resolves to a sibling method's variable.
      shape: `class method \`${head}(p, c)\` parameter resolved to a sibling method's STATE.md variable`,
      text: ['class S {', '  load(dir) {', "    const p = path.join(dir, 'STATE.md');", '    return p;', '  }', `  ${head}(p, c) {`, '    fs.writeFileSync(p, c);', '  }', '}'].join('\n'),
      expected: [],
      currentBuggyOutput: [7],
    })),
    {
      // False positive: an unnamed `function (p)` header does not end the scan,
      // and its parameter is not read as a binding.
      shape: 'function expression parameter shadowing an outer STATE.md variable',
      text: W("  const p = path.join(dir, 'STATE.md');", '  const save = function (p) {', '    fs.writeFileSync(p, c);', '  };'),
      expected: [],
      currentBuggyOutput: [4],
    },
    {
      // False positive: as above, so `b`'s parameter resolves to `a`'s variable.
      shape: 'sibling function expression body binding the same name',
      text: ['const a = function (dir) {', "  const p = path.join(dir, 'STATE.md');", '  return p;', '};', 'const b = function (p, c) {', '  fs.writeFileSync(p, c);', '};'].join('\n'),
      expected: [],
      currentBuggyOutput: [6],
    },
    {
      // False positive: a target computed from the state file is not the state file.
      shape: 'target derived from the state file',
      text: W("  const p = readTarget(path.join(dir, 'STATE.md'));", '  fs.writeFileSync(p, c);'),
      expected: [],
      currentBuggyOutput: [3],
    },
    {
      // False positive: `/STATE\.md/` also matches a longer file name.
      shape: 'a STATE.md.bak literal',
      text: W("  fs.writeFileSync(path.join(dir, 'STATE.md.bak'), c);"),
      expected: [],
      currentBuggyOutput: [2],
    },
    {
      // Missed: `/STATE\.md/` reads the text, so a name split across literals evades it.
      shape: "a STATE.md name split across literals ('STATE' + '.md')",
      text: W("  fs.writeFileSync(path.join(dir, 'STATE' + '.md'), c);"),
      expected: [2],
      currentBuggyOutput: [],
    },
    {
      // Missed: as above, through a variable.
      shape: "a STATE.md name split across literals ('STATE' + '.md') through a variable",
      text: W("  const p = path.join(dir, 'STATE' + '.md');", '  fs.writeFileSync(p, c);'),
      expected: [3],
      currentBuggyOutput: [],
    },
    {
      // Missed: as above, for a name built in a template.
      shape: 'a STATE.md name built in a template (`STATE${\'.md\'}`)',
      text: W("  fs.writeFileSync(path.join(dir, `STATE${'.md'}`), c);"),
      expected: [2],
      currentBuggyOutput: [],
    },
  ];
  gapLoop(KNOWN_SCOPE_GAPS, 'line-based scope');

  // The axis matches only the literal text `fs.writeFileSync(`, over
  // `stripComments` output, which does not track strings or regex literals.
  const KNOWN_MATCH_GAPS = [
    {
      shape: 'wrapped call after a string holding //',
      text: W("  const u = 'http://x'; fs.writeFileSync(", '    statePath, c);'),
      expected: [2],
      currentBuggyOutput: [],
    },
    {
      shape: 'wrapped call after a regex literal holding //',
      text: W('  const re = /\\//; fs.writeFileSync(', '    statePath, c);'),
      expected: [2],
      currentBuggyOutput: [],
    },
    {
      shape: 'the call spelled inside a string literal',
      text: W('  const s = "fs.writeFileSync(statePath, c)";'),
      expected: [],
      currentBuggyOutput: [2],
    },
    ...[
      ['fs.promises.writeFile onto statePath', '  await fs.promises.writeFile(statePath, c);'],
      ['fs.appendFileSync onto statePath', '  fs.appendFileSync(statePath, c);'],
      ['fs.renameSync of a temp file onto statePath', '  fs.renameSync(tmp, statePath);'],
      ['an aliased fs module (nfs.writeFileSync)', '  nfs.writeFileSync(statePath, c);'],
      ['destructured writeFileSync onto statePath', '  writeFileSync(statePath, c);'],
    ].map(([shape, body]) => ({ shape, text: W(body), expected: [2], currentBuggyOutput: [] })),
  ];
  gapLoop(KNOWN_MATCH_GAPS, 'call match');

  // Names a generated identifier must not take: JS/TS reserved and keyword-like
  // words, and the names the fixture already uses.
  const RESERVED = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
    'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
    'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void',
    'while', 'with', 'yield', 'await', 'async', 'static', 'let', 'of', 'undefined', 'implements',
    'interface', 'package', 'private', 'protected', 'public', 'type', 'as', 'declare',
    'path', 'fs', 'dir', 'content', 'statePath', 'writer', 'use', 'x', 'unrelated', 'doWork',
  ]);

  test('property: a write whose target can be STATE.md is reported through typed, let/var, chained, wrapped and shadowed declarations', () => {
    // Oracle, from the spec rather than the resolver: a write whose target can
    // be STATE.md must be reported, at its own line; a write whose every
    // possible target is a known other file must not be. The fixture binds a
    // chain of 1..MAX_TARGET_RESOLUTION_HOPS declarations ending in
    // path.join(dir, '<file>'). With `shadow`, a closed block before the write
    // redeclares the target as ROADMAP.md: out of scope at the write for
    // `const`/`let`, a possible reassignment for `var`. Either way the target
    // can still be the chain's value, so STATE.md must still report.
    // Fail fast when the bound is not exported: an undefined `max` makes
    // fc.integer generate without limit instead of failing.
    assert.ok(Number.isInteger(MAX_TARGET_RESOLUTION_HOPS), 'MAX_TARGET_RESOLUTION_HOPS is exported');
    const fc = require('./helpers/fast-check-setup.cjs');
    const ident = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,7}$/).filter((s) => !RESERVED.has(s));
    const keyword = fc.constantFrom('const', 'let', 'var');
    const annotation = fc.constantFrom('', ': string', ': string | undefined', ': PathLike', ': Readonly<string>');
    const depth = fc.integer({ min: 1, max: MAX_TARGET_RESOLUTION_HOPS });
    const otherFile = fc.constantFrom('ROADMAP.md', 'PLAN.md', 'STATE.json', 'notes.md');
    const filler = fc.array(fc.constantFrom('  const unrelated = 1;', '', '  // a comment', '  doWork();'), { maxLength: 3 });
    fc.assert(
      fc.property(
        fc.record({ name: ident, kw: keyword, ann: annotation, depth, other: otherFile, fill: filler, shadow: fc.boolean(), wrapped: fc.boolean() }),
        ({ name, kw, ann, depth: n, other, fill, shadow, wrapped }) => {
          const v = (k) => `${name}_${k}`;
          const build = (file) => {
            const out = ['function writer(dir, content, x) {', ...fill];
            out.push(`  ${kw} ${v(0)}${ann} = path.join(dir, '${file}');`);
            for (let k = 1; k < n; k++) out.push(`  ${kw} ${v(k)}${ann} = ${v(k - 1)};`);
            const target = v(n - 1);
            if (shadow) out.push('  if (x) {', `    ${kw} ${target}${ann} = path.join(dir, 'ROADMAP.md');`, `    use(${target});`, '  }');
            const writeLine = out.length + 1;
            if (wrapped) out.push('  fs.writeFileSync(', `    ${target},`, '    content);');
            else out.push(`  fs.writeFileSync(${target}, content);`);
            out.push('}');
            return { text: out.join('\n'), writeLine };
          };
          const hit = build('STATE.md');
          const found = findRawStateWrites(OTHER_FILE, hit.text);
          return found.length === 1 && found[0].line === hit.writeLine && findRawStateWrites(OTHER_FILE, build(other).text).length === 0;
        },
      ),
    );
  });

  test('CLI: --root <synthetic tree> with a wrapped call and a variable target reports both', (t) => {
    const tmpRoot = createTempDir('state-write-path-drift-guard-5104-');
    t.after(() => cleanup(tmpRoot));

    const srcDir = path.join(tmpRoot, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const fixtureContent = [
      "import * as fs from 'node:fs';",
      "import * as path from 'node:path';",
      '',
      'function wrapped(statePath: string, content: string): void {',
      '  fs.writeFileSync(',
      '    statePath,',
      '    content);',
      '}',
      '',
      'function viaVariable(dir: string, content: string): void {',
      "  const p: string = path.join(dir, 'STATE.md');",
      '  fs.writeFileSync(p, content);',
      '}',
    ].join('\n');
    fs.writeFileSync(path.join(srcDir, 'bogus.cts'), fixtureContent, 'utf8');

    const result = runNode([GUARD_PATH, '--root', tmpRoot, '--json'], { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(result.outcome, 'exited');
    assert.strictEqual(result.exitCode, 1);

    const body = JSON.parse(result.stdout);
    assert.strictEqual(body.ok, false);
    const reported = body.findings
      .filter((f) => f.file === 'src/bogus.cts' && f.reason === REASON.RAW_STATE_WRITE)
      .map((f) => f.line);
    assert.deepStrictEqual(reported, [5, 12]);
  });

  test('CLI: --root <synthetic tree> with a call left open fails the run as an unresolved raw write', (t) => {
    const tmpRoot = createTempDir('state-write-path-drift-guard-5104-open-');
    t.after(() => cleanup(tmpRoot));

    const srcDir = path.join(tmpRoot, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    // No `,` or `)` closes the call before the cap.
    const filler = Array(Math.ceil(guard.MAX_RAW_WRITE_TEXT_LENGTH / 8)).fill('    x +');
    const fixtureContent = ["import * as fs from 'node:fs';", 'function open(): void {', '  fs.writeFileSync(', ...filler, '}'].join('\n');
    fs.writeFileSync(path.join(srcDir, 'bogus.cts'), fixtureContent, 'utf8');

    const result = runNode([GUARD_PATH, '--root', tmpRoot, '--json'], { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(result.outcome, 'exited');
    assert.strictEqual(result.exitCode, 1);

    const body = JSON.parse(result.stdout);
    assert.strictEqual(body.ok, false);
    assert.ok(body.summary.rawWriteViolations > 0);
    const reasons = new Set(body.findings.filter((f) => f.file === 'src/bogus.cts').map((f) => f.reason));
    assert.deepStrictEqual([...reasons], [REASON.RAW_STATE_WRITE_UNRESOLVED]);
  });
});
