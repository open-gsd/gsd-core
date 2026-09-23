// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression guard for #2012: AskUserQuestion is Claude Code-only — non-Claude
 * runtimes (OpenAI Codex, Gemini, etc.) render it as a markdown code block
 * instead of triggering the interactive TUI, so the session stalls.
 *
 * Every workflow that calls AskUserQuestion MUST include a TEXT_MODE fallback
 * instruction so that, when `workflow.text_mode` is true (or `--text` is
 * passed), all AskUserQuestion calls are replaced with plain-text numbered
 * lists that any runtime can handle.
 *
 * The canonical fallback phrase is:
 *   "TEXT_MODE" (or "text_mode") paired with "plain-text" (or "plain text")
 * near the first AskUserQuestion reference in the file.
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, 'gsd-core', 'workflows');

/**
 * Return true if the file content contains a TEXT_MODE / text_mode fallback
 * instruction for AskUserQuestion calls.
 *
 * Acceptable forms (case-insensitive on key terms):
 *   - "TEXT_MODE" + "plain-text" or "plain text"
 *   - "text_mode" + "plain-text" or "plain text"
 *   - "text mode" + "plain-text" or "plain text"
 */
function hasTextModeFallback(content) {
  const lower = content.toLowerCase();
  const hasTextMode =
    lower.includes('text_mode') ||
    lower.includes('text mode');
  const hasPlainText =
    lower.includes('plain-text') ||
    lower.includes('plain text') ||
    lower.includes('numbered list');
  return hasTextMode && hasPlainText;
}

describe('AskUserQuestion text-mode fallback (#2012)', () => {
  test('every workflow that uses AskUserQuestion includes a TEXT_MODE plain-text fallback', () => {
    const violations = [];

    const files = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.md'));

    for (const fname of files) {
      const fpath = path.join(WORKFLOWS_DIR, fname);
      const content = fs.readFileSync(fpath, 'utf-8');

      if (!content.includes('AskUserQuestion')) continue;

      if (!hasTextModeFallback(content)) {
        violations.push(fname);
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      [
        'AskUserQuestion is Claude Code-only (issue #2012).',
        'Every workflow that uses AskUserQuestion must include a TEXT_MODE fallback',
        'so non-Claude runtimes (OpenAI Codex, Gemini, etc.) can present questions',
        'as plain-text numbered lists instead of stalling on an unexecuted tool call.',
        '',
        'Add this near the argument-parsing section of each workflow:',
        '  Set TEXT_MODE=true if --text is present in $ARGUMENTS OR text_mode from',
        '  init JSON is true. When TEXT_MODE is active, replace every AskUserQuestion',
        '  call with a plain-text numbered list and ask the user to type their choice',
        '  number.',
        '',
        'Workflows missing the fallback:',
        ...violations.map(v => '  gsd-core/workflows/' + v),
      ].join('\n')
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-17-askuserquestion-option-cap.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-17-askuserquestion-option-cap (consolidation epic #1969 B4 #1973)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product (see #17)
// Workflow markdown is the shipped runtime contract; validating its AskUserQuestion
// option limits is a behavioral guard, not an implementation-detail assertion.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'gsd-core', 'workflows');
const ASK_USER_QUESTION_OPTION_CAP = 4;

function walkMarkdownFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, out);
      continue;
    }
    if (entry.isFile() && full.endsWith('.md')) out.push(full);
  }
  return out;
}

function findBalancedClose(text, openIndex, openCh, closeCh) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function getLineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

function collectOptionCapViolations(file, text) {
  const violations = [];
  const askRe = /\bAskUserQuestion\s*\(\s*\[/g;
  let askMatch;

  while ((askMatch = askRe.exec(text)) !== null) {
    const askStart = askMatch.index;
    const arrayOpen = text.indexOf('[', askStart);
    if (arrayOpen === -1) continue;
    const arrayClose = findBalancedClose(text, arrayOpen, '[', ']');
    if (arrayClose === -1) continue;
    const askBlock = text.slice(arrayOpen, arrayClose + 1);
    const blockOffset = arrayOpen;

    const optionsRe = /\boptions\s*:\s*\[/g;
    let optionsMatch;
    while ((optionsMatch = optionsRe.exec(askBlock)) !== null) {
      const openInBlock = optionsMatch.index + optionsMatch[0].length - 1;
      const closeInBlock = findBalancedClose(askBlock, openInBlock, '[', ']');
      if (closeInBlock === -1) continue;
      const optionsBody = askBlock.slice(openInBlock, closeInBlock + 1);
      const labelCount = (optionsBody.match(/\blabel\s*:\s*"[^"]+"/g) || []).length;
      if (labelCount > ASK_USER_QUESTION_OPTION_CAP) {
        const globalIdx = blockOffset + optionsMatch.index;
        violations.push({
          file,
          line: getLineNumber(text, globalIdx),
          count: labelCount,
        });
      }
    }
  }

  return violations;
}

describe('bug #17: AskUserQuestion options arrays respect runtime cap', () => {
  test('every AskUserQuestion options array in workflows has at most 4 options', () => {
    const files = walkMarkdownFiles(ROOT);
    const violations = [];

    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      violations.push(...collectOptionCapViolations(file, text));
    }

    assert.equal(
      violations.length,
      0,
      [
        `Found ${violations.length} AskUserQuestion options-array cap violation(s).`,
        `Runtime cap is ${ASK_USER_QUESTION_OPTION_CAP} options per question.`,
        ...violations.map((v) => {
          const rel = path.relative(path.join(__dirname, '..'), v.file);
          return `  ${rel}:${v.line} -> ${v.count} options`;
        }),
      ].join('\n')
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// #4776 — an artifact-exists question must not block an unattended run
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __autoDescribe, test: __autoTest } = require('node:test');
  __autoDescribe('artifact-exists prompts resolve under --auto (#4776)', () => {
    const WF = path.join(__dirname, '..', 'gsd-core', 'workflows');

    /**
     * The decision points this issue covers. Each names the heading (or, for
     * files with no dedicated heading at this point, the arm's own guard
     * clause) that opens the artifact-exists branch, the option the `--auto`
     * arm must take, and the sibling option that regenerates the artifact
     * (the one an `--auto` arm must NOT select).
     *
     * The maintainer decision recorded on #4776: an unattended run REUSES an
     * existing artifact rather than regenerating it. "Update"/"Re-audit"
     * re-run the generator, rewriting a contract or review that may already
     * carry answers or findings a person recorded, with nobody present to
     * notice — so an `--auto` arm that selects one of those is the defect,
     * not the fix.
     *
     * Widened from the original ui-phase.md/spec-phase.md pair to all 5
     * files sharing the gap (#4776's 2026-09-16 triage comment: "give all 5
     * files a consistent --auto branch... recommended fix").
     * ai-integration-phase.md mirrors ui-phase.md's 3-way Update/View/Skip
     * shape; eval-review.md and ui-review.md have only Re-audit/View, so
     * their non-destructive `--auto` choice is "View", not "Skip".
     */
    const DECISION_POINTS = [
      { file: 'ui-phase.md', anchor: '## 4. Check Existing UI-SPEC', reuseOption: 'Skip', regenOption: 'Update' },
      { file: 'spec-phase.md', anchor: '**Check for existing SPEC.md:**', reuseOption: 'Skip', regenOption: 'Update' },
      { file: 'ai-integration-phase.md', anchor: '## 4. Check Existing AI-SPEC', reuseOption: 'Skip', regenOption: 'Update' },
      { file: 'eval-review.md', anchor: '**If `EVAL_REVIEW_FILE` non-empty:**', reuseOption: 'View', regenOption: 'Re-audit' },
      { file: 'ui-review.md', anchor: '**If `UI_REVIEW_FILE` non-empty:**', reuseOption: 'View', regenOption: 'Re-audit' },
    ];

    /** The text from `anchor` up to the next heading of the same or higher level. */
    function section(content, anchor) {
      const start = content.indexOf(anchor);
      assert.notEqual(start, -1, `anchor not found: ${anchor}`);
      const rest = content.slice(start + anchor.length);
      const end = rest.search(/\n##? /);
      return rest.slice(0, end === -1 ? rest.length : end);
    }

    for (const { file, anchor, reuseOption, regenOption } of DECISION_POINTS) {
      __autoTest(`${file}: the --auto arm reuses the existing artifact, before any prompt`, () => {
        const body = section(fs.readFileSync(path.join(WF, file), 'utf8'), anchor);

        const autoIdx = body.search(/\*\*If `--auto`:\*\*/);
        assert.notEqual(autoIdx, -1,
          `${file}: the artifact-exists branch has no --auto arm, so an unattended run stops here`);

        // `Use AskUserQuestion`, not a bare mention: ui-phase.md's TEXT_MODE
        // paragraph names AskUserQuestion above this branch, and anchoring on
        // that would compare the arm against prose it has nothing to do with.
        const askIdx = body.indexOf('Use AskUserQuestion');
        assert.notEqual(askIdx, -1, `${file}: expected a \`Use AskUserQuestion\` prompt at this decision point`);
        assert.ok(autoIdx < askIdx,
          `${file}: the --auto arm must resolve BEFORE the prompt, or the prompt still runs`);

        // The arm's own sentence — up to the end of that line — must name the
        // reuse option. Scanning the whole section would match the interactive
        // option list below it and pass on a file that auto-selects the
        // regenerating option instead.
        const armLine = body.slice(autoIdx, body.indexOf('\n', autoIdx) === -1 ? undefined : body.indexOf('\n', autoIdx));
        assert.match(armLine, new RegExp(`"${reuseOption}"`),
          `${file}: the --auto arm must select "${reuseOption}" (reuse as-is), not regenerate the artifact`);
        assert.doesNotMatch(armLine, new RegExp(`"${regenOption}`),
          `${file}: auto-selecting "${regenOption}" regenerates an artifact nobody is watching (#4776)`);
      });
    }

    __autoTest('the max-revision-iterations escalation stays interactive under --auto', () => {
      // #4776 explicitly does NOT ask for this one: force-approving blocking
      // findings is a decision a person makes. A future "resolve every prompt
      // under --auto" sweep would break that, so it is pinned here.
      const body = fs.readFileSync(path.join(WF, 'ui-phase.md'), 'utf8');
      const idx = body.indexOf('Force approve');
      assert.notEqual(idx, -1, 'ui-phase.md: expected the max-iterations escalation to still exist');
      const around = body.slice(Math.max(0, idx - 600), idx + 600);
      assert.doesNotMatch(around, /\*\*If `--auto`:\*\*/,
        'the force-approve escalation must keep blocking for a human under --auto');
    });
  });
}
