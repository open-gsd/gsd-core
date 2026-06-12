// allow-test-rule: source-text-is-the-product
// Tests measure byte sizes of workflow files — the workflow file text IS the
// product loaded by agents at runtime. No command output is parsed.
// Migrated from pending-migration-to-typed-ir per #455.

/**
 * Workflow size budget (measured in BYTES — see #717).
 *
 * Workflow definitions in `gsd-core/workflows/*.md` are loaded verbatim
 * into the agent's context every time the corresponding `/gsd:*` command is
 * invoked. Unbounded growth is paid on every invocation across every session.
 *
 * ## Why bytes, not lines (#717)
 *
 * Line count is a poor proxy: markdown tables and fenced code blocks are
 * token-dense, so a line budget over-penalizes prose and under-catches dense
 * additions. Bytes are cheap, deterministic, and need no tokenizer. They are
 * also the UNIT our vendors bound on — Codex caps instruction docs at 32,768
 * bytes (`project_doc_max_bytes`) and truncates past it. We adopt that unit,
 * not that exact number: our XL/LARGE ceilings sit above 32,768 because these
 * are grandfathered top-level orchestrators loaded by Claude, not Codex
 * AGENTS.md docs — the goal is a bounded, ratcheting budget, not Codex parity.
 *
 * ## Why the budget exists at all (the quality argument, not just cost)
 *
 * With prompt caching the per-invocation *cost* premise is weak (cache reads
 * are ~10% of input). The stronger, caching-independent reason is QUALITY:
 * larger context degrades recall and reasoning ("context rot" / attention
 * budget). Lean, high-signal instructions produce better plans. The ceiling
 * protects the agent's attention, not just the token bill.
 *
 * ## The goal this metric is a proxy for (read before gaming it — #717)
 *
 * The real target is bounded *loaded* context. This test measures one file's
 * bytes, but `@~/.claude/gsd-core/references/...` imports are loaded EAGERLY
 * into context. Moving prose into an eagerly @-imported reference shrinks the
 * measured file while leaving (or growing) total loaded context — that is
 * gaming the proxy, not improving the goal. Legitimate extraction is LAZY:
 * content Read only at the step that needs it (see the discuss-phase mode/
 * template tests below, which forbid templates in <required_reading>).
 *
 * Tiered the same way as agent budgets (#2361):
 *   - XL       : top-level orchestrators (e.g., execute-phase, plan-phase)
 *   - LARGE    : multi-step planners
 *   - DEFAULT  : focused single-purpose workflows (target tier)
 *
 * Raising a budget is a deliberate choice — adjust the constant, write a
 * rationale in the PR, and confirm the bloat is not duplicated content
 * that belongs in `gsd-core/references/` (lazily loaded) or a per-mode
 * subdirectory (see `workflows/discuss-phase/modes/`, #2551).
 *
 * Tighten-only invariant (issue #597): ceilings track the tier high-water mark
 * within GRACE bytes. Budgets may only decrease, never silently creep upward.
 * The assertTightCeiling() call below enforces this automatically.
 *
 * See:
 *   - https://github.com/open-gsd/gsd-core/issues/717  (bytes re-base + rationale)
 *   - https://github.com/open-gsd/gsd-core/issues/2551 (this test)
 *   - https://github.com/open-gsd/gsd-core/issues/2361 (agent budget)
 *   - https://developers.openai.com/codex/guides/agents-md (Codex 32 KB cap)
 *   - https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('node:os');
const path = require('path');
const { assertTightCeiling } = require('../scripts/lib/allowlist-ratchet.cjs');
const { cleanup } = require('./helpers.cjs');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

// Grace band: maximum allowed slack (ceiling − actualMax) in BYTES before a
// ceiling is considered too loose. 3000 bytes ≈ the prior 60-line grace
// re-expressed for the #717 unit swap (these files run ~36–50 bytes/line, so
// ~60–80 lines of breathing room) without permitting gross inflation.
const GRACE = 3000;

// Byte ceilings (#717 re-base from lines). Each tier's ceiling tracks the
// current high-water mark within GRACE (#597 tighten-only ratchet).
// XL high-water mark is execute-phase.md — note that under LINES it was
// plan-phase; bytes genuinely re-rank the tier, which is the point of #717.
// actualMax=93130 (plan-phase, #381 CLAUDE_ENV_FILE persist clause in per-file launcher preamble);
// slack=70 ≤ GRACE. execute-phase.md=92880, new-project.md=61685.
// 93200: +200B headroom for the #381 CLAUDE_ENV_FILE persist clause added to every per-file launcher preamble (legit content growth, ratchet-up per #717).
const XL_BUDGET = 93200;
// LARGE high-water mark is docs-update.md. actualMax=54410 (#891 launcher shim expansion);
// slack=1590 ≤ GRACE. quick.md=45710, autonomous.md=38030.
const LARGE_BUDGET = 56000;
// DEFAULT high-water mark is settings-advanced.md. actualMax=38409 (#891 launcher shim expansion);
// slack=1591 ≤ GRACE.
const DEFAULT_BUDGET = 40000;

// Top-level orchestrators that own end-to-end multi-phase rubrics.
// Grandfathered at current sizes — see PR #2551 for the progressive-disclosure
// pattern that future shrinks should follow. Byte counts noted for reference.
const XL_WORKFLOWS = new Set([
  'execute-phase',  // 92880 bytes (grew in #381 CLAUDE_ENV_FILE persist clause)
  'plan-phase',     // 93130 bytes (tier high-water mark; grew in #381 CLAUDE_ENV_FILE persist clause)
  'new-project',    // 61685 bytes
]);

// Multi-step planners and bigger feature workflows. Grandfathered.
// Byte counts updated in #891 (launcher shim expanded with 17 runtime home arms).
const LARGE_WORKFLOWS = new Set([
  'docs-update',           // 54410 bytes (tier high-water mark)
  'autonomous',            // 38030
  'complete-milestone',    // 29510
  'verify-work',           // 30122
  'transition',            // 21427
  'discuss-phase-assumptions', // 26624
  'progress',              // 26287
  'new-milestone',         // 29808
  'update',                // 20766
  'quick',                 // 45710
  'code-review',           // 28726
]);

const ALL_WORKFLOWS = fs.readdirSync(WORKFLOWS_DIR)
  .filter(f => f.endsWith('.md'))
  .map(f => f.replace('.md', ''));

function budgetFor(workflow) {
  if (XL_WORKFLOWS.has(workflow)) return { tier: 'XL', limit: XL_BUDGET };
  if (LARGE_WORKFLOWS.has(workflow)) return { tier: 'LARGE', limit: LARGE_BUDGET };
  return { tier: 'DEFAULT', limit: DEFAULT_BUDGET };
}

function byteCount(filePath) {
  // Count bytes as on an LF checkout, so the budget is platform-independent.
  // The tier ceilings are calibrated against `wc -c` on a Unix (LF) checkout,
  // but these .md files have no `eol=lf` in .gitattributes, so Windows checks
  // them out as CRLF. Counting raw on-disk bytes there adds one byte per line,
  // which fails CI on the high-water-mark file (execute-phase.md) on Windows
  // ONLY — a false positive that diverges from the LF calibration basis (#683).
  // Stripping CR yields the same LF byte count on every platform. Still a raw
  // byte count (not the old trailing-newline-stripping lineCount()).
  const content = fs.readFileSync(filePath, 'utf-8');
  return Buffer.byteLength(content.replace(/\r\n/g, '\n'), 'utf-8');
}

describe('SIZE: workflow byte-size budget', () => {
  for (const workflow of ALL_WORKFLOWS) {
    const { tier, limit } = budgetFor(workflow);
    test(`${workflow} (${tier}) stays under ${limit} bytes`, () => {
      const filePath = path.join(WORKFLOWS_DIR, workflow + '.md');
      const bytes = byteCount(filePath);
      assert.ok(
        bytes <= limit,
        `${workflow}.md is ${bytes} bytes — exceeds ${tier} budget of ${limit}. ` +
        `Extract per-mode bodies to a workflows/${workflow}/modes/ subdirectory, ` +
        `templates to workflows/${workflow}/templates/, or shared references ` +
        `to gsd-core/references/ — and load them LAZILY (not via @-required_reading, ` +
        `which would shrink this file's bytes without shrinking loaded context). ` +
        `See workflows/discuss-phase/ for the pattern.`
      );
    });
  }
});

describe('SIZE: tier anti-creep (tighten-only ceilings, issue #597)', () => {
  // For each tier, compute the high-water mark (in bytes) across all files in
  // that tier and assert the ceiling stays tight. Prevents budgets from
  // silently drifting upward: ceiling − actualMax must not exceed GRACE.
  test('XL tier: ceiling tracks high-water mark within GRACE', () => {
    const values = ALL_WORKFLOWS
      .filter(w => XL_WORKFLOWS.has(w))
      .map(w => byteCount(path.join(WORKFLOWS_DIR, w + '.md')));
    const actualMax = Math.max(...values);
    assertTightCeiling({ label: 'XL', actualMax, ceiling: XL_BUDGET, grace: GRACE, fail: assert.fail });
  });

  test('LARGE tier: ceiling tracks high-water mark within GRACE', () => {
    const values = ALL_WORKFLOWS
      .filter(w => LARGE_WORKFLOWS.has(w))
      .map(w => byteCount(path.join(WORKFLOWS_DIR, w + '.md')));
    const actualMax = Math.max(...values);
    assertTightCeiling({ label: 'LARGE', actualMax, ceiling: LARGE_BUDGET, grace: GRACE, fail: assert.fail });
  });

  test('DEFAULT tier: ceiling tracks high-water mark within GRACE', () => {
    const values = ALL_WORKFLOWS
      .filter(w => !XL_WORKFLOWS.has(w) && !LARGE_WORKFLOWS.has(w))
      .map(w => byteCount(path.join(WORKFLOWS_DIR, w + '.md')));
    const actualMax = Math.max(...values);
    assertTightCeiling({ label: 'DEFAULT', actualMax, ceiling: DEFAULT_BUDGET, grace: GRACE, fail: assert.fail });
  });
});

describe('SIZE: discuss-phase progressive disclosure (issue #2551)', () => {
  // Issue #2551 targets discuss-phase.md as a thin dispatcher, separate from
  // the per-tier grandfathered budgets above. Originally expressed as <500
  // lines; re-based to bytes for #717 (500 lines ≈ 28 KB at these files'
  // density; set to 30 KB to preserve the thin-dispatcher intent with modest
  // headroom). This is the headline metric of the refactor — every other
  // workflow above its tier is grandfathered and may shrink later via the
  // same pattern.
  // Target raised from 30000 to 32000 in #891 (launcher shim expansion added 17 runtime home arms,
  // adding ~960 bytes to the preamble; the thin-dispatcher intent is preserved — actual=30935).
  const DISCUSS_PHASE_TARGET = 32000;
  test(`discuss-phase.md is under ${DISCUSS_PHASE_TARGET} bytes (issue #2551 target)`, () => {
    const filePath = path.join(WORKFLOWS_DIR, 'discuss-phase.md');
    const bytes = byteCount(filePath);
    assert.ok(
      bytes < DISCUSS_PHASE_TARGET,
      `discuss-phase.md is ${bytes} bytes — must be under ${DISCUSS_PHASE_TARGET} per #2551. ` +
      `Per-mode logic belongs in workflows/discuss-phase/modes/<mode>.md, ` +
      `templates in workflows/discuss-phase/templates/.`
    );
  });

  const SUBDIR = path.join(WORKFLOWS_DIR, 'discuss-phase');

  test('mode files exist for every documented mode', () => {
    const expected = ['power', 'all', 'auto', 'chain', 'text', 'batch', 'analyze', 'default', 'advisor'];
    for (const mode of expected) {
      const p = path.join(SUBDIR, 'modes', `${mode}.md`);
      assert.ok(
        fs.existsSync(p),
        `Expected mode file ${path.relative(WORKFLOWS_DIR, p)} — missing. ` +
        `Each --flag in commands/gsd/discuss-phase.md must have a matching mode file.`
      );
    }
  });

  test('every mode file is a real, non-empty workflow doc', () => {
    const modesDir = path.join(SUBDIR, 'modes');
    if (!fs.existsSync(modesDir)) {
      assert.fail(`workflows/discuss-phase/modes/ directory does not exist`);
    }
    for (const file of fs.readdirSync(modesDir)) {
      if (!file.endsWith('.md')) continue;
      const p = path.join(modesDir, file);
      const content = fs.readFileSync(p, 'utf-8');
      assert.ok(content.trim().length > 100,
        `${file} is empty or near-empty (${content.length} chars) — extraction must preserve behavior, not stub it out`);
    }
  });

  test('templates extracted to discuss-phase/templates/', () => {
    const expected = ['context.md', 'discussion-log.md', 'checkpoint.json'];
    for (const t of expected) {
      const p = path.join(SUBDIR, 'templates', t);
      assert.ok(fs.existsSync(p),
        `Expected template ${path.relative(WORKFLOWS_DIR, p)} — missing.`);
    }
  });

  test('parent discuss-phase.md dispatches to mode files (power)', () => {
    const parent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'discuss-phase.md'), 'utf-8');
    assert.ok(
      /discuss-phase\/modes\/power\.md/.test(parent) ||
      /discuss-phase-power\.md/.test(parent),
      `Parent discuss-phase.md must reference workflows/discuss-phase/modes/power.md ` +
      `(or the legacy discuss-phase-power.md alias) somewhere in its dispatch logic.`
    );
  });

  test('parent dispatches to all extracted modes (auto, chain, all, advisor)', () => {
    const parent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'discuss-phase.md'), 'utf-8');
    for (const mode of ['auto', 'chain', 'all', 'advisor']) {
      assert.ok(
        new RegExp(`discuss-phase/modes/${mode}\\.md`).test(parent),
        `Parent discuss-phase.md must reference workflows/discuss-phase/modes/${mode}.md`
      );
    }
  });

  test('parent reads CONTEXT.md template at the write step (not at top)', () => {
    const parent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'discuss-phase.md'), 'utf-8');
    // The template reference must appear inside or near the write_context step,
    // not in the top-level <required_reading> block (which would defeat lazy load).
    const requiredReadingMatch = parent.match(/<required_reading>([\s\S]*?)<\/required_reading>/);
    if (requiredReadingMatch) {
      assert.ok(
        !/discuss-phase\/templates\/context\.md/.test(requiredReadingMatch[1]),
        `CONTEXT.md template must NOT be in <required_reading> — that defeats lazy loading. ` +
        `Read it inside the write_context step, just before writing the file.`
      );
    }
    assert.ok(
      /discuss-phase\/templates\/context\.md/.test(parent),
      `Parent must reference workflows/discuss-phase/templates/context.md somewhere ` +
      `(inside write_context step) so the template loads only when CONTEXT.md is being written.`
    );
  });

  test('advisor block is gated behind USER-PROFILE.md existence check', () => {
    const parent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'discuss-phase.md'), 'utf-8');
    // The guard MUST be a file-existence check (test -f or equivalent), not an
    // unconditional Read of the advisor mode file.
    assert.ok(
      /USER-PROFILE\.md/.test(parent),
      'Parent must reference USER-PROFILE.md to detect advisor mode'
    );
    assert.ok(
      /test\s+-[ef]\s+["'$].*USER-PROFILE/.test(parent) ||
      /\[\[\s+-[ef]\s+["'$].*USER-PROFILE/.test(parent) ||
      /\[\s+-[ef]\s+["'$].*USER-PROFILE/.test(parent),
      'Advisor mode detection must use a file-existence guard (test -f / [ -f ]) ' +
      'so the advisor mode file is only Read when USER-PROFILE.md exists.'
    );
    // Confirm advisor.md Read is conditional on ADVISOR_MODE
    const advisorReadGuarded =
      /ADVISOR_MODE[\s\S]{0,200}?modes\/advisor\.md/.test(parent) ||
      /modes\/advisor\.md[\s\S]{0,200}?ADVISOR_MODE/.test(parent) ||
      /if[\s\S]{0,200}?ADVISOR_MODE[\s\S]{0,400}?advisor\.md/.test(parent);
    assert.ok(
      advisorReadGuarded,
      'Read of modes/advisor.md must be guarded by ADVISOR_MODE (which derives from USER-PROFILE.md existence). ' +
      'Skip the Read entirely when no profile is present.'
    );
  });

  test('auto mode file documents skipping interactive questions (regression)', () => {
    const auto = fs.readFileSync(path.join(SUBDIR, 'modes', 'auto.md'), 'utf-8');
    assert.ok(
      /skip[\s\S]{0,80}interactive|without\s+(?:using\s+)?AskUserQuestion|recommended\s+(?:option|default)/i.test(auto),
      `auto.md must preserve the documented behavior: skip interactive questions ` +
      `and pick the recommended option without using AskUserQuestion.`
    );
  });

  test('auto mode preserves the single-pass cap (regression for inline rule)', () => {
    const auto = fs.readFileSync(path.join(SUBDIR, 'modes', 'auto.md'), 'utf-8');
    assert.ok(
      /single\s+pass|max_discuss_passes|MAX_PASSES|pass\s+cap/i.test(auto),
      `auto.md must preserve the auto-mode pass cap rule from the original workflow. ` +
      `Without it, the workflow can self-feed and consume unbounded resources.`
    );
  });

  test('all mode file documents auto-selecting all gray areas (regression)', () => {
    const allMode = fs.readFileSync(path.join(SUBDIR, 'modes', 'all.md'), 'utf-8');
    assert.ok(
      /auto-select(?:ed)?\s+ALL|select\s+ALL|all\s+gray\s+areas/i.test(allMode),
      `all.md must preserve the documented behavior: auto-select ALL gray areas ` +
      `without asking the user.`
    );
  });

  test('chain mode documents auto-advance to plan-phase (regression)', () => {
    const chain = fs.readFileSync(path.join(SUBDIR, 'modes', 'chain.md'), 'utf-8');
    assert.ok(
      /plan-phase/.test(chain) && /(auto-advance|auto\s+plan)/i.test(chain),
      `chain.md must preserve the documented auto-advance to plan-phase behavior.`
    );
  });

  test('text mode documents replacing AskUserQuestion (regression)', () => {
    const textMode = fs.readFileSync(path.join(SUBDIR, 'modes', 'text.md'), 'utf-8');
    assert.ok(
      /AskUserQuestion/.test(textMode) && /(numbered\s+list|plain[-\s]text)/i.test(textMode),
      `text.md must preserve the rule: replace AskUserQuestion with plain-text numbered lists.`
    );
  });

  test('batch mode documents 2-5 question grouping (regression)', () => {
    const batch = fs.readFileSync(path.join(SUBDIR, 'modes', 'batch.md'), 'utf-8');
    assert.ok(
      /2[-\s–]5|2\s+to\s+5|--batch=N|--batch\s+N/.test(batch),
      `batch.md must preserve the 2-5 questions-per-batch rule.`
    );
  });

  test('analyze mode documents trade-off table presentation (regression)', () => {
    const analyze = fs.readFileSync(path.join(SUBDIR, 'modes', 'analyze.md'), 'utf-8');
    assert.ok(
      /trade[-\s]off|tradeoff|pros[\s\S]{0,30}cons/i.test(analyze),
      `analyze.md must preserve the trade-off analysis presentation rule.`
    );
  });

  test('CONTEXT.md template preserves all required sections', () => {
    const tpl = fs.readFileSync(path.join(SUBDIR, 'templates', 'context.md'), 'utf-8');
    for (const section of ['<domain>', '<decisions>', '<canonical_refs>', '<code_context>', '<specifics>', '<deferred>']) {
      assert.ok(tpl.includes(section),
        `CONTEXT.md template missing required section ${section} — extraction dropped content.`);
    }
    // spec_lock is conditional but the template still has to include it as a documented option
    assert.ok(/spec_lock/i.test(tpl),
      `CONTEXT.md template must document the conditional <spec_lock> section for SPEC.md integration.`);
  });

  test('checkpoint template is valid JSON', () => {
    const raw = fs.readFileSync(path.join(SUBDIR, 'templates', 'checkpoint.json'), 'utf-8');
    assert.doesNotThrow(() => JSON.parse(raw),
      `checkpoint.json template must parse as valid JSON — downstream code reads it.`);
    const parsed = JSON.parse(raw);
    for (const key of ['phase', 'phase_name', 'timestamp', 'areas_completed', 'areas_remaining', 'decisions']) {
      assert.ok(key in parsed,
        `checkpoint.json template missing required field "${key}" — schema regression vs original workflow.`);
    }
  });

  test('parent does not leak per-mode bodies inline (would defeat extraction)', () => {
    const parent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'discuss-phase.md'), 'utf-8');
    // Heuristic: the parent should not contain the full DISCUSSION-LOG.md template body
    // (extracted to templates/discussion-log.md) — that's the heaviest single block.
    // Look for unique strings that ONLY appear in the original inline template.
    const inlineDiscussionLogSignal = /\| Option \| Description \| Selected \|/g;
    const occurrences = (parent.match(inlineDiscussionLogSignal) || []).length;
    assert.ok(occurrences === 0,
      `Parent discuss-phase.md still contains the inline DISCUSSION-LOG.md table — ` +
      `that block must move to workflows/discuss-phase/templates/discussion-log.md.`);
  });

  test('negative: invalid mode flag combinations document a clear error path', () => {
    // Sanity check: the parent file should explicitly handle the mode dispatch
    // rather than silently doing nothing on an unknown flag pattern.
    const parent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'discuss-phase.md'), 'utf-8');
    assert.ok(
      /ARGUMENTS|--auto|--chain|--all|--power/.test(parent),
      'Parent must dispatch on $ARGUMENTS — losing the flag-parsing block would silently ' +
      'fall back to default mode and obscure user errors.'
    );
  });
});

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

describe('workflow progressive disclosure — MVP bodies lazy-loaded (#720)', () => {
  // MVP-only reference bodies (planner-mvp-mode.md, skeleton-template.md,
  // execute-mvp-tdd.md) must NOT be eagerly @-imported at the top level of the
  // always-loaded workflow files or agent definitions. An @-prefixed path is
  // expanded into context the moment the file loads — regardless of whether
  // MVP_MODE is true — inflating every session's token cost. Use a plain
  // backtick path or a conditional "Read ..." instruction instead. See issue #720.

  test('plan-phase.md does not eagerly @-import planner-mvp-mode.md', () => {
    const planPhaseContent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'plan-phase.md'), 'utf-8');
    assert.ok(
      !/@[~./\w-]*planner-mvp-mode\.md/.test(planPhaseContent),
      'plan-phase.md contains an eager @-import of planner-mvp-mode.md — ' +
      'this loads the MVP body into context for every session, even when MVP_MODE is false. ' +
      'Replace with a conditional Read instruction or a plain backtick path. See #720.'
    );
  });

  test('plan-phase.md does not eagerly @-import skeleton-template.md', () => {
    const planPhaseContent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'plan-phase.md'), 'utf-8');
    assert.ok(
      !/@[~./\w-]*skeleton-template\.md/.test(planPhaseContent),
      'plan-phase.md contains an eager @-import of skeleton-template.md — ' +
      'this loads the template into context on every plan-phase invocation. ' +
      'Replace with a conditional Read instruction or a plain backtick path. See #720.'
    );
  });

  test('plan-phase.md still references both MVP bodies (lazy reference preserved)', () => {
    const planPhaseContent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'plan-phase.md'), 'utf-8');
    assert.ok(
      /planner-mvp-mode\.md/.test(planPhaseContent) && /skeleton-template\.md/.test(planPhaseContent),
      'plan-phase.md must still reference planner-mvp-mode.md and skeleton-template.md ' +
      '(as lazy backtick paths or Read instructions) so agents know where to find them. ' +
      'Do not delete the references — only remove the leading @ sigil. See #720.'
    );
  });

  test('plan-phase.md does not list MVP bodies in <required_reading>', () => {
    const planPhaseContent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'plan-phase.md'), 'utf-8');
    const requiredReadingMatch = planPhaseContent.match(/<required_reading>([\s\S]*?)<\/required_reading>/);
    if (requiredReadingMatch) {
      const block = requiredReadingMatch[1];
      assert.ok(
        !/planner-mvp-mode\.md/.test(block),
        'planner-mvp-mode.md must NOT appear in plan-phase.md <required_reading> — ' +
        'that block is always loaded regardless of MVP_MODE. See #720.'
      );
      assert.ok(
        !/skeleton-template\.md/.test(block),
        'skeleton-template.md must NOT appear in plan-phase.md <required_reading> — ' +
        'that block is always loaded regardless of MVP_MODE. See #720.'
      );
    }
  });

  test('execute-phase.md does not eagerly @-import execute-mvp-tdd.md', () => {
    const executePhaseContent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'execute-phase.md'), 'utf-8');
    assert.ok(
      !/@[~./\w-]*execute-mvp-tdd\.md/.test(executePhaseContent),
      'execute-phase.md contains an eager @-import of execute-mvp-tdd.md — ' +
      'this loads the MVP TDD body into context for every session. ' +
      'Replace with a conditional Read instruction or a plain backtick path. See #720.'
    );
  });

  test('execute-phase.md still references execute-mvp-tdd.md (lazy reference preserved)', () => {
    const executePhaseContent = fs.readFileSync(path.join(WORKFLOWS_DIR, 'execute-phase.md'), 'utf-8');
    assert.ok(
      /execute-mvp-tdd\.md/.test(executePhaseContent),
      'execute-phase.md must still reference execute-mvp-tdd.md (as a lazy backtick path ' +
      'or Read instruction) so agents know where to find it. ' +
      'Do not delete the reference — only ensure there is no leading @ sigil. See #720.'
    );
  });

  test('gsd-planner.md does not eagerly @-import planner-mvp-mode.md', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-planner.md'), 'utf-8');
    assert.ok(
      !/@[~./\w-]*planner-mvp-mode\.md/.test(content),
      'gsd-planner.md contains an eager @-import of planner-mvp-mode.md — ' +
      'this loads the MVP body into context for every session, even when MVP_MODE is false. ' +
      'Replace with a conditional Read instruction or a plain backtick path. See #720.'
    );
  });

  test('gsd-planner.md does not eagerly @-import skeleton-template.md', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-planner.md'), 'utf-8');
    assert.ok(
      !/@[~./\w-]*skeleton-template\.md/.test(content),
      'gsd-planner.md contains an eager @-import of skeleton-template.md — ' +
      'this loads the template into context on every planner invocation. ' +
      'Replace with a conditional Read instruction or a plain backtick path. See #720.'
    );
  });

  test('gsd-planner.md does not eagerly @-import user-story-template.md', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-planner.md'), 'utf-8');
    assert.ok(
      !/@[~./\w-]*user-story-template\.md/.test(content),
      'gsd-planner.md contains an eager @-import of user-story-template.md — ' +
      'this loads the template into context on every planner invocation. ' +
      'Replace with a conditional Read instruction or a plain backtick path. See #720.'
    );
  });

  test('gsd-planner.md still references the three MVP bodies', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-planner.md'), 'utf-8');
    assert.ok(
      /planner-mvp-mode\.md/.test(content),
      'gsd-planner.md must still reference planner-mvp-mode.md (as a lazy path or Read instruction). ' +
      'Do not delete the reference — only remove the leading @ sigil. See #720.'
    );
    assert.ok(
      /skeleton-template\.md/.test(content),
      'gsd-planner.md must still reference skeleton-template.md (as a lazy path or Read instruction). ' +
      'Do not delete the reference — only remove the leading @ sigil. See #720.'
    );
    assert.ok(
      /user-story-template\.md/.test(content),
      'gsd-planner.md must still reference user-story-template.md (as a lazy path or Read instruction). ' +
      'Do not delete the reference — only remove the leading @ sigil. See #720.'
    );
  });

  test('gsd-executor.md does not eagerly @-import execute-mvp-tdd.md', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-executor.md'), 'utf-8');
    assert.ok(
      !/@[~./\w-]*execute-mvp-tdd\.md/.test(content),
      'gsd-executor.md contains an eager @-import of execute-mvp-tdd.md — ' +
      'this loads the MVP TDD body into context for every session. ' +
      'Replace with a conditional Read instruction or a plain backtick path. See #720.'
    );
  });

  test('gsd-executor.md still references execute-mvp-tdd.md', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-executor.md'), 'utf-8');
    assert.ok(
      /execute-mvp-tdd\.md/.test(content),
      'gsd-executor.md must still reference execute-mvp-tdd.md (as a lazy path or Read instruction). ' +
      'Do not delete the reference — only remove the leading @ sigil. See #720.'
    );
  });
});

describe('SIZE: byteCount is line-ending independent (#683 regression)', () => {
  // The budget ceilings are calibrated against an LF (Unix) checkout; Windows
  // checks these .md files out as CRLF, which previously inflated the count by
  // one byte per line and failed CI only on Windows for the high-water file.
  test('CRLF and LF content of the same logical file count identically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-size-eol-'));
    try {
      const body = 'line one\nline two\nthree — with a multibyte dash\n';
      const lfPath = path.join(dir, 'lf.md');
      const crlfPath = path.join(dir, 'crlf.md');
      fs.writeFileSync(lfPath, body);
      fs.writeFileSync(crlfPath, body.replace(/\n/g, '\r\n'));
      assert.strictEqual(
        byteCount(crlfPath),
        byteCount(lfPath),
        'byteCount must normalize CRLF so the byte budget is platform-independent'
      );
      // And it must remain a real LF byte count (not stripped/whitespace-trimmed).
      assert.strictEqual(byteCount(lfPath), Buffer.byteLength(body, 'utf-8'));
    } finally {
      cleanup(dir);
    }
  });
});
