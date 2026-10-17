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

  // Boundary rule (#5119 review 5477747649, Major 1): an assignment in a closed
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

  // Typed declarations (#5119 review 5477747649, Major 2): the scanned sources
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
});
