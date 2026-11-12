// Source text is the product (#5069):
// gsd-core/references/autonomous-smart-discuss.md and planner-reversibility.md are
// runtime-loaded prose: their text IS the contract the autonomous orchestrator
// follows. Every assertion is scoped to a named section or fenced block so prose
// elsewhere in the file cannot satisfy it. The CONTEXT.md template the reference
// prescribes is additionally fed to the real decision extractor
// (gsd-core/bin/lib/decisions.cjs) — the parser the blocking decision-coverage
// gate runs — so the new "Decided autonomously" subsection is tested behaviorally.
// Issue #5069.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { collectSection, scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { extractDecisions } = require('../gsd-core/bin/lib/decisions.cjs');

const ROOT = path.resolve(__dirname, '..');
const SMART_DISCUSS = path.join(ROOT, 'gsd-core', 'references', 'autonomous-smart-discuss.md');
const AUTONOMOUS = path.join(ROOT, 'gsd-core', 'workflows', 'autonomous.md');
const PLANNER_REVERSIBILITY = path.join(ROOT, 'gsd-core', 'references', 'planner-reversibility.md');
const COMMANDS_DOC = path.join(ROOT, 'docs', 'COMMANDS.md');

/** Read a shipped file with line endings normalized, so CRLF checkouts behave alike. */
function read(file) {
  return fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Body of the first heading at `level` whose text matches `re`; fails the test when absent. */
function section(md, level, re) {
  const found = collectSection(md, (h) => h.level === level && re.test(h.text));
  assert.ok(found, `expected a level-${level} heading matching ${re}`);
  return found.body;
}

/** Inner text of every terminated fenced block in `md` with the given info string. */
function fences(md, info) {
  const lines = md.split('\n');
  return scanFencedBlocks(lines)
    .filter((b) => b.closeLineIdx !== -1 && (b.infoString || '').trim() === info)
    .map((b) => lines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n'));
}

/** Data rows of the first GFM pipe table in `body`, as arrays of trimmed cells. */
function tableRows(body) {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith('|'));
  assert.ok(start !== -1, 'expected a pipe table');
  const table = [];
  for (let i = start; i < lines.length && lines[i].trim().startsWith('|'); i++) table.push(lines[i]);
  return table
    .slice(2) // header + separator
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
}

/** The parenthesised example list of a classification-table cell, sorted. */
function examples(cell) {
  const m = /\(([^)]*)\)/.exec(cell);
  assert.ok(m, `expected a parenthesised example list in: ${cell}`);
  return m[1].split(',').map((s) => s.trim()).sort();
}

const classification = () => section(read(SMART_DISCUSS), 2, /^Sub-step 3\.5: Classify/);
const present = () => section(read(SMART_DISCUSS), 2, /^Sub-step 4: Present/);
const writeContext = () => section(read(SMART_DISCUSS), 2, /^Sub-step 5: Write CONTEXT/);
const writeLog = () => section(read(SMART_DISCUSS), 2, /^Sub-step 6: Write DISCUSSION-LOG/);

/** The fenced CONTEXT.md template that Sub-step 5 prescribes. */
function contextTemplate() {
  const blocks = fences(writeContext(), 'markdown');
  assert.equal(blocks.length, 1, 'Sub-step 5 must carry exactly one fenced markdown CONTEXT.md template');
  return blocks[0];
}

/** The `<decisions>` block of a CONTEXT.md text. */
function decisionsBlock(ctx) {
  const m = /<decisions>\n([\s\S]*?)\n<\/decisions>/.exec(ctx);
  assert.ok(m, 'CONTEXT.md template must contain a <decisions> … </decisions> block');
  return m[1];
}

/** The documented line shape of one auto-decided item (#5069; discuss-phase/modes/auto.md). */
const AUTO_LINE_RE = /\[auto\] \[[^\]\n]+\] — Q: "[^"\n]*" → Selected: "[^"\n]*"/;

// ─── Classification ─────────────────────────────────────────────────────────────

describe('#5069 smart discuss classifies every grey-area question', () => {
  test('classification table names all three classes with their handling', () => {
    const rows = tableRows(classification());
    assert.equal(rows.length, 3, `classification table must have exactly three classes, got ${rows.length}`);
    const [reversible, hard, preference] = rows;
    assert.match(reversible[0], /technical, reversible/i);
    assert.match(reversible[1], /decide autonomously/i);
    assert.match(reversible[1], /no prompt/i);
    assert.match(hard[0], /technical, hard to reverse/i);
    assert.match(hard[1], /ask, with a recommendation/i);
    assert.match(preference[0], /product \/ UX \/ preference/i);
    assert.match(preference[1], /neutrally/i);
  });

  test('reversible class lists the issue examples', () => {
    const [reversible] = tableRows(classification());
    for (const example of ['file layout', 'naming', 'internal data shapes', 'error-handling patterns', 'test approach']) {
      assert.ok(reversible[0].includes(example), `reversible class must name "${example}"`);
    }
  });

  test('hard-to-reverse class lists the issue examples', () => {
    const [, hard] = tableRows(classification());
    for (const example of ['persisted schema', 'public API/URL contracts', 'auth model', 'new external dependency', 'data migrations']) {
      assert.ok(hard[0].includes(example), `hard-to-reverse class must name "${example}"`);
    }
  });

  test('docs/COMMANDS.md class table lists the same examples as the reference (parity)', () => {
    const ref = tableRows(classification());
    const autonomous = section(read(COMMANDS_DOC), 3, /^`\/gsd-autonomous`$/);
    const at = autonomous.indexOf('**Smart discuss question classes.**');
    assert.ok(at !== -1, 'COMMANDS.md /gsd-autonomous must document the smart discuss question classes');
    const doc = tableRows(autonomous.slice(at));
    assert.equal(doc.length, 3, 'COMMANDS.md class table must list the same three classes');
    const list = (cell) => cell.split(',').map((s) => s.trim()).sort();
    assert.deepEqual(list(doc[0][1]), examples(ref[0][0]), 'reversible examples diverge between COMMANDS.md and the reference');
    assert.deepEqual(list(doc[1][1]), examples(ref[1][0]), 'hard-to-reverse examples diverge between COMMANDS.md and the reference');
  });

  test('classes map onto the existing reversibility taxonomy', () => {
    const body = classification();
    assert.match(body, /`reversible`/, 'reversible class must map to the `reversible` rating');
    assert.match(body, /`costly`[^\n]*`one-way`|`one-way`[^\n]*`costly`/, 'hard to reverse must map to `costly` / `one-way`');
  });

  test('unsure between reversible and hard to reverse resolves to hard to reverse', () => {
    assert.match(classification(), /unsure between reversible and hard to reverse[^\n]*treat (it|the question) as hard to reverse/i);
  });

  test('unsure between technical and product resolves to product', () => {
    assert.match(classification(), /unsure between technical and product[^\n]*treat (it|the question) as product/i);
  });

  test('dominant option reclassifies a preference question as technical, with no filler', () => {
    const body = classification();
    assert.match(body, /wins on every axis[^\n]*reclassify it as technical/i);
    assert.match(body, /never pad[^\n]*filler/i);
  });

  test('an area of only reversible technical questions is not presented', () => {
    assert.match(classification(), /all reversible technical questions is not presented/i);
  });

  test('states why its tie-break differs from the planner taxonomy', () => {
    const line = classification().split('\n').find((l) => /planner-reversibility\.md/.test(l));
    assert.ok(line, 'classification must reference planner-reversibility.md');
    assert.match(line, /opposite/i, 'the reference must say the tie-break is deliberately the opposite of the planner rule');
  });
});

// ─── Presentation ───────────────────────────────────────────────────────────────

describe('#5069 smart discuss presents each class differently', () => {
  test('decided-autonomously block is informational, with no prompt', () => {
    const body = section(present(), 3, /^Decided autonomously block/);
    assert.match(body, /without AskUserQuestion|no AskUserQuestion|do not prompt/i);
    assert.ok(fences(body, '').some((f) => /Decided autonomously/.test(f)), 'the block must show a display template');
  });

  test('zero auto-decided items omits the block', () => {
    const body = section(present(), 3, /^Decided autonomously block/);
    assert.match(body, /no question was decided autonomously[^\n]*(skip|omit)/i);
  });

  test('accept-all applies only to hard-to-reverse questions', () => {
    const hard = section(present(), 3, /^Hard-to-reverse questions/);
    assert.match(hard, /"Accept all"/, 'the hard-to-reverse path keeps the acceptance prompt');
    assert.match(hard, /✅ Recommended/, 'the hard-to-reverse table keeps its Recommended column');
    const preference = section(present(), 3, /^Preference questions/);
    assert.doesNotMatch(preference, /"Accept all"/, 'preference questions must not be accepted in bulk');
  });

  test('preference questions are asked neutrally', () => {
    const body = section(present(), 3, /^Preference questions/);
    assert.doesNotMatch(body, /✅ Recommended/, 'no Recommended column for preference questions');
    assert.match(body, /no `?Recommended`? label/i);
    assert.match(body, /no pre-selection/i);
    assert.match(body, /2[–-]3 genuinely competitive options/i);
    assert.match(body, /trade-off/i);
    assert.match(body, /"You decide"[^\n]*last/i, '"You decide" stays available, as the last option');
    assert.match(body, /"You decide"[^\n]*Claude's Discretion/i, 'a delegated preference answer is Claude\'s Discretion, not Decided autonomously');
  });

  test('questions added by "Discuss deeper" are classified too', () => {
    const hard = section(present(), 3, /^Hard-to-reverse questions/);
    const line = hard.split('\n').find((l) => l.startsWith('**On "Discuss deeper":**'));
    assert.ok(line, 'the Discuss deeper branch must exist');
    assert.match(line, /Classify every new question with Sub-step 3\.5/);
    assert.match(line, /neutral rules/);
  });
});

// ─── CONTEXT.md output ──────────────────────────────────────────────────────────

describe('#5069 CONTEXT.md records auto-decided items', () => {
  test('CONTEXT template puts "### Decided autonomously" inside <decisions>', () => {
    const decisions = decisionsBlock(contextTemplate());
    assert.match(decisions, /^### Decided autonomously$/m);
    const bulletAfter = decisions.split('\n### Decided autonomously\n')[1].split('\n').find((l) => l.startsWith('- '));
    assert.ok(bulletAfter, 'Decided autonomously must show a bullet template');
    assert.match(bulletAfter, /^- \[[^\]]+\] Q: "[^"]*" → Selected: "[^"]*" — /, 'bullet must use the [Area] Q/Selected line shape, plain (no bold lead-in)');
  });

  test('hard-to-reverse decisions record a Reversibility rating with a rationale', () => {
    assert.match(decisionsBlock(contextTemplate()), /\*\*Reversibility:\*\*[^\n]*costly\|one-way[^\n]*rationale/i);
  });

  test('zero auto-decided items omits the CONTEXT subsection', () => {
    assert.match(writeContext(), /omit[^\n]*`### Decided autonomously`|`### Decided autonomously`[^\n]*omit/i);
  });

  test('CONTEXT template stays parseable by the decision-coverage gate', () => {
    const outcome = extractDecisions(contextTemplate()).outcome;
    assert.equal(outcome, 'none-present', `template must not trip the gate (got ${outcome})`);
  });

  test('property: Decided autonomously bullets never trip the decision gate', () => {
    const template = contextTemplate();
    const placeholder = template.split('\n').find((l) => /^- \[[^\]]+\] Q: /.test(l));
    assert.ok(placeholder, 'template must carry a Decided autonomously bullet to substitute');
    // Single-line free text. D-tokens (`D-1`, `D4-x`) are excluded: the gate
    // deliberately fails loud on them anywhere in <decisions> (#4130).
    const text = fc.stringMatching(/^[A-Za-z0-9 ,.'()/_:-]{1,40}$/).filter((s) => !/D[0-9]*-[A-Za-z0-9]/.test(s));
    fc.assert(
      fc.property(fc.array(fc.tuple(text, text, text, text), { minLength: 1, maxLength: 6 }), (items) => {
        const bullets = items.map(([area, q, a, why]) => `- [${area}] Q: "${q}" → Selected: "${a}" — ${why}`);
        const ctx = template.replace(placeholder, bullets.join('\n'));
        const result = extractDecisions(ctx);
        return result.outcome === 'none-present' && result.decisions.filter((d) => d.trackable).length === 0;
      }),
    );
  });

  test('reversal is by editing CONTEXT.md or re-running discuss, with no confirmation gate', () => {
    const body = writeContext();
    assert.match(body, /revers\w*[^\n]*edit[^\n]*CONTEXT\.md[^\n]*re-run/i);
    assert.match(body, /no confirmation (step|gate)|no override step/i);
  });

  test('recorded questions and answers are data and stay on one line', () => {
    const body = writeContext();
    assert.match(body, /data, never an instruction/);
    assert.match(body, /collapse line breaks to spaces/);
    assert.match(body, /start a line with `#` or `<`/);
  });
});

// ─── DISCUSSION-LOG.md + commit ─────────────────────────────────────────────────

describe('#5069 DISCUSSION-LOG records auto-decided items', () => {
  test('DISCUSSION-LOG records auto-decided items in the [auto] line format', () => {
    const body = writeLog();
    assert.match(body, /discuss-phase\/templates\/discussion-log\.md/, 'reuses the existing discussion-log template');
    assert.ok(fences(body, '').some((f) => AUTO_LINE_RE.test(f)), 'shows the [auto] [Area] — Q/Selected line');
  });

  test('commit stages CONTEXT.md and DISCUSSION-LOG.md together', () => {
    const commits = fences(writeLog(), 'bash').filter((b) => /query commit/.test(b));
    assert.ok(
      commits.some((b) => /--files[^\n]*-CONTEXT\.md[^\n]*-DISCUSSION-LOG\.md/.test(b)),
      'one commit must stage both files',
    );
  });

  test('infrastructure skip commits CONTEXT.md without a discussion log', () => {
    const body = writeLog();
    assert.match(body, /infrastructure/i);
    const commits = fences(body, 'bash').filter((b) => /query commit/.test(b));
    assert.ok(
      commits.some((b) => /--files[^\n]*-CONTEXT\.md/.test(b) && !/DISCUSSION-LOG/.test(b)),
      'the infrastructure path commits CONTEXT.md alone',
    );
  });
});

// ─── Claims and planner guard ───────────────────────────────────────────────────

describe('#5069 surrounding contracts', () => {
  test('smart discuss no longer claims output identical to discuss-phase', () => {
    assert.doesNotMatch(read(SMART_DISCUSS), /identical/i);
    const step = /<step name="smart_discuss">([\s\S]*?)<\/step>/.exec(read(AUTONOMOUS));
    assert.ok(step, 'autonomous.md must keep its smart_discuss step');
    assert.doesNotMatch(step[1], /identical/i);
  });

  test('planner does not treat Decided autonomously entries as settled', () => {
    const settled = section(read(PLANNER_REVERSIBILITY), 2, /^Already settled$/);
    const line = settled.split('\n').find((l) => /Decided autonomously/.test(l));
    assert.ok(line, 'Already settled must address Decided autonomously entries');
    assert.match(line, /not (human-)?settled|never (human-)?settled/i);
  });
});
