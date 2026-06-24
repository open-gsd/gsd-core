// This suite IS the #1637 false-PASS behavioral eval. It does not text-assert source: it (a) spawns
// the fixtures' visible/held-out node:test suites as subprocesses to prove the held-out-only
// property, and (b) replays a recorded verdict table (data) through a deterministic, key-free
// per-slice scorer. No model is called.
//
// Two layers, mirroring the experiment this ports (N17 / non-inferable-corpus):
//   1. Corpus validity gate — for each fixture: reference passes visible+held-out; defective passes
//      visible but FAILS held-out (so the defect is genuinely non-inferable from the visible suite).
//   2. Per-slice replay scorer — reads seed-verdicts.tsv (recorded model verdicts, NOT live) and
//      reports false-pass/abstain per slice. The non-inferable slices are REPORTED, never gated
//      (that is #1154's exogenous territory). The GATED, non-gameable floor lives on the inferable
//      control: baseline+endogenous must CATCH the spec-determined defect (recall floor) and must
//      NOT abstain on it (over-abstention floor) — so a flag-everything/always-abstain critic fails.
//
// Seed = N17 (n=27, 3 conditions x 3 models x 3 recorded tasks): direction-finding, underpowered.
// It locks the recorded numbers as a regression check on the committed data; it is NOT a B1 ship
// gate. A scaled, multi-model powered run replaces the seed and decides B1. See tests/verdict-eval/README.md.
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, 'verdict-eval');
const FIX = path.join(ROOT, 'fixtures');
const KNOWN_SLICES = new Set(['domain-knowledge', 'truly-spec-silent', 'inferable']);

function runSuite(taskDir, suite, sut) {
  // Strip NODE_TEST_CONTEXT: when this harness runs under `node --test`, the var is set and a
  // naively-inherited child `node --test` switches into subordinate-reporter mode and does not
  // propagate its failure exit code — so a genuinely-failing held-out run would wrongly read PASS.
  const env = { ...process.env, GSD_SUT: path.join(taskDir, sut) };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', path.join(taskDir, suite)], { env, encoding: 'utf8' });
  return r.status === 0 ? 'PASS' : 'FAIL';
}

const taskDirs = fs.readdirSync(FIX, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

describe('verdict-eval: corpus validity gate (held-out-only property)', () => {
  test('fixtures exist', () => {
    assert.ok(taskDirs.length >= 4, `expected >=4 fixtures, found ${taskDirs.length}`);
  });

  for (const t of taskDirs) {
    test(`${t}: reference passes both; defective passes visible, FAILS held-out`, () => {
      const d = path.join(FIX, t);
      assert.equal(runSuite(d, 'visible.mjs', 'reference.mjs'), 'PASS', 'reference must pass visible');
      assert.equal(runSuite(d, 'heldout.mjs', 'reference.mjs'), 'PASS', 'reference must pass held-out');
      assert.equal(runSuite(d, 'visible.mjs', 'defective.mjs'), 'PASS', 'defective must pass visible (defect hidden)');
      assert.equal(runSuite(d, 'heldout.mjs', 'defective.mjs'), 'FAIL', 'defective must FAIL held-out (held-out catches it)');
    });
  }

  test('every fixture declares a known slice in meta.json', () => {
    for (const t of taskDirs) {
      const meta = JSON.parse(fs.readFileSync(path.join(FIX, t, 'meta.json'), 'utf8'));
      assert.ok(KNOWN_SLICES.has(meta.slice), `${t}: meta.slice must be one of ${[...KNOWN_SLICES].join('|')}`);
    }
  });
});

function loadVerdicts() {
  const lines = fs.readFileSync(path.join(ROOT, 'seed-verdicts.tsv'), 'utf8').trim().split('\n');
  const header = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i]; });
    row.confidence = Number(row.confidence);
    return row;
  });
}

const CONDITIONS = ['baseline', 'endogenous', 'exogenous'];
const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
const rate = (rows, pred) => (rows.length === 0 ? null : rows.filter(pred).length / rows.length);

describe('verdict-eval: per-slice replay scorer (seed = N17, direction-finding)', () => {
  const verdicts = loadVerdicts();

  test('seed shape: 27 verdicts (3 conditions x 3 models x 3 recorded tasks)', () => {
    assert.equal(verdicts.length, 27);
    for (const r of verdicts) assert.ok(KNOWN_SLICES.has(r.slice), `unknown slice ${r.slice}`);
  });

  test('REPORT: non-inferable false-pass per condition x slice (informational, NOT gated)', () => {
    const niSlices = ['domain-knowledge', 'truly-spec-silent'];
    const lines = [];
    for (const c of CONDITIONS) {
      for (const s of niSlices) {
        const rows = verdicts.filter((r) => r.condition === c && r.slice === s);
        const fp = rate(rows, (r) => r.verdict === 'passed');
        const ab = rate(rows, (r) => r.verdict === 'insufficient_spec');
        lines.push(`  ${c.padEnd(11)} ${s.padEnd(18)} n=${rows.length} false_pass=${pct(fp)} abstain=${pct(ab)}`);
      }
    }
    console.log('non-inferable slice (REPORTED, not gated — #1154 territory):\n' + lines.join('\n'));

    // Regression-lock the recorded aggregate (100% -> 67% -> 17% over the 6 NI verdicts/condition).
    // This pins the committed seed data; it is NOT a B1 pass/fail decision.
    const niPassed = (c) =>
      verdicts.filter((r) => r.condition === c && r.slice !== 'inferable' && r.verdict === 'passed').length;
    assert.equal(niPassed('baseline'), 6, 'baseline NI false-pass = 6/6 (100%)');
    assert.equal(niPassed('endogenous'), 4, 'endogenous NI false-pass = 4/6 (67%)');
    assert.equal(niPassed('exogenous'), 1, 'exogenous NI false-pass = 1/6 (17%)');
  });

  test('GATE (non-gameable): inferable-recall + no-over-abstention floor on the control', () => {
    // Only baseline+endogenous are gated. Exogenous is the deliberately-false-flag arm whose
    // over-abstention cost (opus deferring a real bug) is a MEASURED result, not a failure.
    for (const c of ['baseline', 'endogenous']) {
      const inf = verdicts.filter((r) => r.condition === c && r.slice === 'inferable');
      assert.equal(inf.length, 3, `${c}: inferable control n=3`);
      const recall = rate(inf, (r) => r.verdict === 'gaps_found');
      const overAbstain = rate(inf, (r) => r.verdict === 'insufficient_spec');
      assert.equal(recall, 1, `${c}: inferable-recall floor = 100% (a pass-everything critic fails this); got ${pct(recall)}`);
      assert.equal(overAbstain, 0, `${c}: over-abstention floor = 0% (a flag-everything critic fails this); got ${pct(overAbstain)}`);
    }
  });
});
