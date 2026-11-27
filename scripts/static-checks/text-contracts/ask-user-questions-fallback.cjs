'use strict';

// AskUserQuestion in the workflows (#2012, #17, #4776): every top-level workflow that uses AskUserQuestion carries a
// TEXT_MODE plain-text fallback, since the tool is Claude Code-only; no AskUserQuestion options array in any workflow
// (steps included) has more than the runtime cap of four labelled options; and the artifact-exists decision points of
// ui-phase, spec-phase, ai-integration-phase, eval-review and ui-review resolve their `--auto` arm before the prompt, on
// the reuse option and never the regenerating one, while the force-approve escalation of ui-phase stays interactive. The
// bracket and label scans are one pass each, with the old test's reading of a bracket inside a string. Was the three
// describe blocks of tests/ask-user-questions-fallback.test.cjs, whose second block was folded in from bug-17.

const WORKFLOWS = 'gsd-core/workflows';
const OPTION_CAP = 4;
const AUTO_ARM = '**If `--auto`:**';
const ESCALATION_WINDOW = 600;
const DECISION_POINTS = [
  { file: 'ui-phase.md', anchor: '## 4. Check Existing UI-SPEC', reuse: 'Skip', regen: 'Update' },
  { file: 'spec-phase.md', anchor: '**Check for existing SPEC.md:**', reuse: 'Skip', regen: 'Update' },
  { file: 'ai-integration-phase.md', anchor: '## 4. Check Existing AI-SPEC', reuse: 'Skip', regen: 'Update' },
  { file: 'eval-review.md', anchor: '**If `EVAL_REVIEW_FILE` non-empty:**', reuse: 'View', regen: 'Re-audit' },
  { file: 'ui-review.md', anchor: '**If `UI_REVIEW_FILE` non-empty:**', reuse: 'View', regen: 'Re-audit' },
];

const isWordChar = (ch) => ch !== undefined && /\w/.test(ch);
const skipBlanks = (text, from) => {
  let at = from;
  while (at < text.length && /\s/.test(text[at])) at += 1;
  return at;
};

function hasTextModeFallback(text) {
  const lower = text.toLowerCase();
  const textMode = lower.includes('text_mode') || lower.includes('text mode');
  const plain = lower.includes('plain-text') || lower.includes('plain text') || lower.includes('numbered list');
  return textMode && plain;
}

// The `]` that closes each `[` (an unmatched `]` is ignored, an unclosed `[` has none), in one pass.
function bracketPartners(text) {
  const partner = new Map();
  const open = [];
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === '[') open.push(at);
    else if (text[at] === ']' && open.length > 0) partner.set(open.pop(), at);
  }
  return partner;
}

// How many `label: "..."` entries a text holds (a word boundary before `label`, a non-empty quoted value).
function labelCount(text) {
  let count = 0;
  let at = text.indexOf('label');
  while (at !== -1) {
    if (!isWordChar(text[at - 1])) {
      let cursor = skipBlanks(text, at + 'label'.length);
      if (text[cursor] === ':') {
        cursor = skipBlanks(text, cursor + 1);
        if (text[cursor] === '"') {
          const close = text.indexOf('"', cursor + 1);
          if (close === -1) break;
          if (close > cursor + 1) {
            count += 1;
            at = text.indexOf('label', close + 1);
            continue;
          }
        }
      }
    }
    at = text.indexOf('label', at + 1);
  }
  return count;
}

// The AskUserQuestion([...]) calls whose `options: [...]` array holds more labelled options than the runtime cap.
function optionCapViolations(text) {
  const partner = bracketPartners(text);
  const violations = [];
  let at = text.indexOf('AskUserQuestion');
  while (at !== -1) {
    let next = at + 1;
    if (!isWordChar(text[at - 1])) {
      let cursor = skipBlanks(text, at + 'AskUserQuestion'.length);
      if (text[cursor] === '(') {
        cursor = skipBlanks(text, cursor + 1);
        if (text[cursor] === '[') {
          next = cursor + 1;
          const close = partner.get(cursor);
          if (close !== undefined) collectOptions(text, partner, cursor, close, violations);
        }
      }
    }
    at = text.indexOf('AskUserQuestion', next);
  }
  return violations;
}

// Every `options: [` inside text[from..to] (nested arrays too), counted against the cap.
function collectOptions(text, partner, from, to, violations) {
  let at = text.indexOf('options', from);
  while (at !== -1 && at < to) {
    let next = at + 1;
    if (!isWordChar(text[at - 1])) {
      let cursor = skipBlanks(text, at + 'options'.length);
      if (text[cursor] === ':') {
        cursor = skipBlanks(text, cursor + 1);
        if (text[cursor] === '[') {
          next = cursor + 1;
          const count = labelCount(text.slice(cursor, partner.get(cursor) + 1));
          if (count > OPTION_CAP) violations.push({ line: text.slice(0, at).split('\n').length, count });
        }
      }
    }
    at = text.indexOf('options', next);
  }
}

// The text after `anchor` up to the next level-one or level-two heading, or null when the anchor is absent.
function sectionAfter(text, anchor) {
  const start = text.indexOf(anchor);
  if (start === -1) return null;
  const rest = text.slice(start + anchor.length);
  const ends = ['\n# ', '\n## '].map((marker) => rest.indexOf(marker)).filter((at) => at !== -1);
  return rest.slice(0, ends.length === 0 ? rest.length : Math.min(...ends));
}

function autoArmProblem(text, { anchor, reuse, regen }) {
  const body = sectionAfter(text, anchor);
  if (body === null) return `anchor not found: ${anchor}`;
  const autoAt = body.indexOf(AUTO_ARM);
  if (autoAt === -1) return 'the artifact-exists branch has no --auto arm, so an unattended run stops here';
  const askAt = body.indexOf('Use AskUserQuestion');
  if (askAt === -1) return 'expected a `Use AskUserQuestion` prompt at this decision point';
  if (!(autoAt < askAt)) return 'the --auto arm must resolve BEFORE the prompt, or the prompt still runs';
  const lineEnd = body.indexOf('\n', autoAt);
  const arm = body.slice(autoAt, lineEnd === -1 ? undefined : lineEnd);
  if (!arm.includes(`"${reuse}"`)) return `the --auto arm must select "${reuse}" (reuse as-is), not regenerate the artifact`;
  if (arm.includes(`"${regen}`)) return `auto-selecting "${regen}" regenerates an artifact nobody is watching (#4776)`;
  return true;
}

module.exports = {
  // The linear walkers, exported for the differential properties of tests/text-contracts.batch10.test.cjs.
  bracketPartners, labelCount, optionCapViolations, sectionAfter,
  id: 'ask-user-questions-fallback',
  issue: '#2012',
  check(ctx) {
    const every = ctx.list(WORKFLOWS, '.md', 'the workflows directory must hold workflows');
    // One document handle per path: every assertion on a file runs on it, so a removed or empty file is one finding.
    const decisionByPath = new Map(DECISION_POINTS.map((point) => [`${WORKFLOWS}/${point.file}`, point]));
    const ESCALATION_PATH = `${WORKFLOWS}/ui-phase.md`;
    for (const rel of [...new Set([...every, ...decisionByPath.keys()])]) {
      const doc = ctx.doc(rel);
      if (rel.split('/').length === 3) {
        doc.satisfies((text) => !text.includes('AskUserQuestion') || hasTextModeFallback(text) || 'it uses AskUserQuestion with no TEXT_MODE plain-text fallback',
          'every workflow that uses AskUserQuestion must include a TEXT_MODE fallback so non-Claude runtimes can present questions as plain-text numbered lists');
      }
      doc.satisfies((text) => {
        const found = optionCapViolations(text);
        return found.length === 0 || found.map((v) => `line ${v.line}: ${v.count} options`).join('; ');
      }, `every AskUserQuestion options array must have at most ${OPTION_CAP} options (the runtime cap)`);
      const point = decisionByPath.get(rel);
      if (point) doc.satisfies((text) => autoArmProblem(text, point), `${point.file}: the --auto arm must reuse the existing artifact, before any prompt`);
      // #4776 does not ask for the escalation: force-approving blocking findings is a decision a person makes.
      if (rel === ESCALATION_PATH) {
        doc.satisfies((text) => {
          const at = text.indexOf('Force approve');
          if (at === -1) return 'ui-phase.md: expected the max-iterations escalation to still exist';
          return !text.slice(Math.max(0, at - ESCALATION_WINDOW), at + ESCALATION_WINDOW).includes(AUTO_ARM) || 'an --auto arm sits next to the force-approve escalation';
        }, 'the max-revision-iterations escalation must keep blocking for a human under --auto');
      }
    }
  },
};
