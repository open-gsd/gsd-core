/**
 * #5287 — `/gsd:phase --insert <X>` takes the phase to insert AFTER and creates a new
 * decimal phase (5 → 5.1, or 5.2 when 5.1 exists). A printed chain that then
 * runs `/gsd:discuss-phase`, `/gsd:plan-phase` or `/gsd:execute-phase` with the
 * same `<X>` targets the existing phase, which resolves cleanly, so nothing
 * warns and the inserted phase stays empty.
 *
 * Every shipped markdown chain that inserts a phase and then addresses one
 * must address the inserted phase:
 *   - a literal follow-up must be a decimal child of the insert's literal
 *     (`--insert 5` then `5.1`, never `5` or `05`);
 *   - a placeholder follow-up must differ from the insert's placeholder (case
 *     and bracket style ignored), and the paragraph after the chain must name
 *     it and say it comes from the insert.
 * A chain is the insert plus the commands that follow it: on the same line
 * (`→`-joined, up to the next insert on that line), then on the lines after
 * it that start with a command. Blank lines are skipped only before the first
 * follow-up; once a follow-up is seen, a blank line ends the chain, so an
 * unrelated command further down is not absorbed.
 *
 * Not checked:
 *   - whether the explanation is TRUE (a sentence that names the placeholder
 *     and the insert passes even if it misdescribes them);
 *   - follow-ups written inside a sentence ("Then run `/gsd:plan-phase <N>`")
 *     or inside a separate indented fence. Reaching those lexically would also
 *     absorb unrelated prose.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PHASE_NUMBER_TOKEN_SOURCE, comparePhaseNum } = require('../gsd-core/bin/lib/phase-id.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const SCAN_ROOTS = ['gsd-core', 'commands', 'agents', 'skills'].map((d) => path.join(REPO_ROOT, d));
const AUDIT_MILESTONE = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'audit-milestone.md');

// An argument may sit in its own backticks or quotes: `/gsd:plan-phase "<N>"`.
const INSERT_RE = /[/$]gsd[:-]phase\s+--insert\s+[`"']?([^\s`"']+)/g;
const FOLLOW_UP_RE = /[/$]gsd[:-](discuss|plan|execute)-phase\s+[`"']?([^\s`"']+)/g;
const COMMAND_LINE_RE = /^\s*(?:[-*]\s+)?`?[/$]gsd[:-]/;
const PHASE_NUMBER_RE = new RegExp(`^${PHASE_NUMBER_TOKEN_SOURCE}$`);

function collectMarkdownFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      results.push(...collectMarkdownFiles(full));
    } else if (entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

function followUpsIn(text, lineNo) {
  return [...text.matchAll(FOLLOW_UP_RE)].map((m) => ({ command: m[1], arg: m[2], line: lineNo }));
}

/**
 * Find each insert chain and return the insert argument, the follow-ups, and
 * the paragraph right after the chain's last command line.
 */
function findInsertChains(text) {
  const lines = text.split(/\r?\n/);
  const chains = [];
  for (let i = 0; i < lines.length; i++) {
    const inserts = [...lines[i].matchAll(INSERT_RE)];
    for (let k = 0; k < inserts.length; k++) {
      const insert = inserts[k];
      const end = k + 1 < inserts.length ? inserts[k + 1].index : lines[i].length;
      const followUps = followUpsIn(lines[i].slice(insert.index + insert[0].length, end), i + 1);
      let last = i;
      // Only the line's last insert owns the command lines below it.
      if (k === inserts.length - 1) {
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === '') {
            if (followUps.length > 0) break;
            continue;
          }
          if (!COMMAND_LINE_RE.test(lines[j]) || new RegExp(INSERT_RE.source).test(lines[j])) break;
          followUps.push(...followUpsIn(lines[j], j + 1));
          last = j;
        }
      }
      if (followUps.length === 0) continue;
      let j = last + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      const after = [];
      for (; j < lines.length && lines[j].trim() !== ''; j++) after.push(lines[j]);
      chains.push({ line: i + 1, insertArg: insert[1], followUps, nextParagraph: after.join(' ') });
    }
  }
  return chains;
}

function normalizePlaceholder(arg) {
  return arg.replace(/^[<{[]|[>}\]]$/g, '').toLowerCase();
}

function isPhaseNumber(arg) {
  return PHASE_NUMBER_RE.test(arg);
}

/**
 * `child` is `parent` plus exactly one `.N` segment with N ≥ 1, the prefix
 * compared numerically (5 → 05.1 is fine; 5 → 5.0 and 5.1 → 5.1.0.1 are not).
 */
function isDecimalChild(parent, child) {
  const cut = child.lastIndexOf('.');
  if (cut <= 0) return false;
  if (child.split('.').length !== parent.split('.').length + 1) return false;
  if (!(Number(child.slice(cut + 1)) >= 1)) return false;
  return comparePhaseNum(child.slice(0, cut), parent) === 0;
}

function chainProblems(chain) {
  const problems = [];
  const insertArg = chain.insertArg;
  const explained = new Set();
  for (const f of chain.followUps) {
    const where = `L${f.line}: /gsd:${f.command}-phase ${f.arg}`;
    if (isPhaseNumber(insertArg) && isPhaseNumber(f.arg)) {
      if (!isDecimalChild(insertArg, f.arg)) {
        problems.push(`${where} is not a decimal phase inserted after ${insertArg}`);
      }
      continue;
    }
    if (isPhaseNumber(f.arg)) {
      problems.push(`${where} is a literal after a placeholder insert (${insertArg}); the inserted number is not known`);
      continue;
    }
    if (normalizePlaceholder(f.arg) === normalizePlaceholder(insertArg)) {
      problems.push(`${where} reuses the insert's after-phase argument`);
      continue;
    }
    if (explained.has(f.arg)) continue;
    explained.add(f.arg);
    if (!(chain.nextParagraph.includes(f.arg) && /\binsert\b/i.test(chain.nextParagraph))) {
      problems.push(`${where}: the paragraph after the chain does not say ${f.arg} comes from the insert's output`);
    }
  }
  return problems;
}

function problemsIn(text) {
  return findInsertChains(text).flatMap(chainProblems);
}

describe('phase-insert chains address the inserted phase, not the after-phase (#5287)', () => {
  test('the pre-fix audit-milestone block is flagged on every follow-up', () => {
    const preFix = [
      '/gsd:phase --insert <N> "Close gap: <REQ-ID> — <description>"',
      '/gsd:discuss-phase <N>',
      '/gsd:plan-phase <N>',
      '/gsd:execute-phase <N>',
      '',
      'For Nyquist-coverage gaps flagged in the table above, prefer running',
    ].join('\n');
    assert.equal(problemsIn(preFix).length, 3);
  });

  test('a padded literal that names the after-phase is flagged', () => {
    const padded = ['/gsd:phase --insert 5 "x"', '/gsd:discuss-phase 05', '/gsd:plan-phase 5.1'].join('\n');
    assert.deepEqual(problemsIn(padded).map((p) => p.split(' ')[0]), ['L2:']);
  });

  test('a placeholder that differs only in case or brackets is flagged', () => {
    const aliased = ['/gsd:phase --insert <N> "x"', '/gsd:plan-phase {n}', '/gsd:execute-phase [N]'].join('\n');
    assert.equal(problemsIn(aliased).length, 2);
  });

  test('a chain split by blank lines is still one chain', () => {
    const split = ['/gsd:phase --insert <N> "x"', '', '/gsd:plan-phase <N>', '', 'Prose.'].join('\n');
    assert.equal(problemsIn(split).length, 1);
  });

  test('a one-line chain joined by arrows is parsed', () => {
    const good = '`/gsd:phase --insert 5 "x"` → `/gsd:plan-phase 5.1` → `/gsd:execute-phase 5.1`';
    const bad = '`/gsd:phase --insert 5 "x"` → `/gsd:plan-phase 5` → `/gsd:execute-phase 5.1`';
    assert.equal(findInsertChains(good).length, 1);
    assert.deepEqual(problemsIn(good), []);
    assert.equal(problemsIn(bad).length, 1);
  });

  test('a follow-up argument in backticks or quotes is still read', () => {
    const quoted = ['/gsd:phase --insert <N> "x"', '/gsd:plan-phase `<N>`', '/gsd:execute-phase "<N>"'].join('\n');
    assert.equal(problemsIn(quoted).length, 2);
  });

  test('a zero or extra segment is not a decimal child', () => {
    const zero = ['/gsd:phase --insert 5 "x"', '/gsd:plan-phase 5.0', '/gsd:execute-phase 5.1.1'].join('\n');
    assert.equal(problemsIn(zero).length, 2);
  });

  test('an unrelated command after a finished chain is not absorbed', () => {
    const later = ['/gsd:phase --insert 5 "x"', '/gsd:plan-phase 5.1', '/gsd:execute-phase 5.1', '', '/gsd:plan-phase 6'].join('\n');
    assert.deepEqual(problemsIn(later), []);
  });

  test('two inserts on one line are two chains, each checked against its own insert', () => {
    const good = '`/gsd:phase --insert 5 "x"` → `/gsd:plan-phase 5.1` → `/gsd:phase --insert 6 "y"` → `/gsd:plan-phase 6.1`';
    const bad = '`/gsd:phase --insert 5 "x"` → `/gsd:plan-phase 5.1` → `/gsd:phase --insert 6 "y"` → `/gsd:plan-phase 6`';
    assert.equal(findInsertChains(good).length, 2);
    assert.deepEqual(problemsIn(good), []);
    assert.equal(problemsIn(bad).length, 1);
  });

  test('a distinct placeholder that is never explained is flagged', () => {
    const unexplained = ['/gsd:phase --insert <after-phase> "x"', '/gsd:plan-phase <new-phase>', '', 'Unrelated.'].join('\n');
    assert.equal(problemsIn(unexplained).length, 1);
  });

  test('a prose line ends the chain, so later commands in prose are not follow-ups', () => {
    const prose = [
      '/gsd:phase --insert <after-phase> "x"',
      '/gsd:plan-phase <new-phase>',
      '',
      '`<new-phase>` is the number the insert prints.',
      'Then run /gsd:plan-phase <after-phase> on the old phase if needed.',
    ].join('\n');
    assert.deepEqual(problemsIn(prose), []);
  });

  test('audit-milestone.md carries both closure chains (positive control)', () => {
    const chains = findInsertChains(fs.readFileSync(AUDIT_MILESTONE, 'utf-8'));
    assert.equal(chains.length, 2, 'expected the gaps_found and tech_debt chains');
    for (const c of chains) assert.equal(c.followUps.length, 3);
  });

  test('no shipped chain addresses the after-phase or leaves the new number unexplained', () => {
    const files = SCAN_ROOTS.flatMap(collectMarkdownFiles);
    assert.ok(files.length > 0, 'expected markdown files to scan');
    const failures = [];
    let chainCount = 0;
    for (const file of files) {
      const chains = findInsertChains(fs.readFileSync(file, 'utf-8'));
      chainCount += chains.length;
      for (const p of chains.flatMap(chainProblems)) failures.push(`${path.relative(REPO_ROOT, file)} ${p}`);
    }
    assert.deepEqual(failures, []);
    assert.ok(chainCount >= 4, `expected at least the four known chains, found ${chainCount}`);
  });
});
