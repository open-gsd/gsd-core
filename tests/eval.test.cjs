'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const evalMod = require('../gsd-core/bin/lib/eval.cjs');

function capture(fn) {
  const orig = process.stdout.write;
  let buf = '';
  process.stdout.write = (s) => { buf += s; return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  return buf.trim();
}

function runCmd(args) {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origExitCode = process.exitCode;
  let stdout = '';
  let stderr = '';
  process.exitCode = 0;
  process.stdout.write = (s) => { stdout += s; return true; };
  process.stderr.write = (s) => { stderr += s; return true; };
  try {
    evalMod.cmdEvalScore(process.cwd(), args, true);
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: process.exitCode || 0 };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = origExitCode;
  }
}

describe('eval.score (#10)', () => {
  test('computes coverage/infra/overall + band', () => {
    const out = JSON.parse(capture(() =>
      evalMod.cmdEvalScore(process.cwd(), ['eval', 'score', '--covered', '5', '--total', '5', '--infra', 'ok,ok,ok,ok,ok'], true)));
    assert.equal(out.coverage_score, 100);
    assert.equal(out.infra_score, 100);
    assert.equal(out.overall_score, 100);
    assert.equal(out.verdict, 'PRODUCTION READY');
  });

  test('partial/missing infra weighted correctly', () => {
    // coverage 3/5=60; infra (ok,ok,partial,missing,ok)=3.5/5=70; overall=60*.6+70*.4=64 ⇒ NEEDS WORK
    const out = JSON.parse(capture(() =>
      evalMod.cmdEvalScore(process.cwd(), ['eval', 'score', '--covered', '3', '--total', '5', '--infra', 'ok,ok,partial,missing,ok'], true)));
    assert.equal(out.coverage_score, 60);
    assert.equal(out.infra_score, 70);
    assert.equal(out.overall_score, 64);
    assert.equal(out.verdict, 'NEEDS WORK');
  });

  test('band boundary: overall exactly 60 ⇒ NEEDS WORK; 59 ⇒ SIGNIFICANT GAPS', () => {
    // 60: coverage 60 (3/5), infra 60 (3/5 ok) ⇒ 60
    const at60 = JSON.parse(capture(() =>
      evalMod.cmdEvalScore(process.cwd(), ['eval','score','--covered','3','--total','5','--infra','ok,ok,ok,missing,missing'], true)));
    assert.equal(at60.overall_score, 60);
    assert.equal(at60.verdict, 'NEEDS WORK');
    // 40: coverage 40 (2/5), infra 40 (2/5 ok) ⇒ 40 SIGNIFICANT GAPS; under ⇒ NOT IMPLEMENTED
    const at40 = JSON.parse(capture(() =>
      evalMod.cmdEvalScore(process.cwd(), ['eval','score','--covered','2','--total','5','--infra','ok,ok,missing,missing,missing'], true)));
    assert.equal(at40.overall_score, 40);
    assert.equal(at40.verdict, 'SIGNIFICANT GAPS');
  });

  test('band boundary: overall exactly 80 ⇒ PRODUCTION READY; 79 ⇒ NEEDS WORK', () => {
    const at80 = JSON.parse(capture(() =>
      evalMod.cmdEvalScore(process.cwd(), ['eval','score','--covered','4','--total','5','--infra','ok,ok,ok,ok,missing'], true)));
    assert.equal(at80.overall_score, 80);
    assert.equal(at80.verdict, 'PRODUCTION READY');

    const at79 = JSON.parse(capture(() =>
      evalMod.cmdEvalScore(process.cwd(), ['eval','score','--covered','13','--total','20','--infra','ok,ok,ok,ok,ok'], true)));
    assert.equal(at79.overall_score, 79);
    assert.equal(at79.verdict, 'NEEDS WORK');
  });

  test('rounding before banding can promote just-below-80 to PRODUCTION READY', () => {
    const out = JSON.parse(capture(() =>
      evalMod.cmdEvalScore(process.cwd(), ['eval','score','--covered','159999','--total','200000','--infra','ok,ok,ok,ok,missing'], true)));
    assert.equal(out.overall_score, 80);
    assert.equal(out.verdict, 'PRODUCTION READY');
  });

  test('missing --covered value errors: non-zero exitCode, no score JSON on stdout', () => {
    const { stdout, exitCode } = runCmd(['eval', 'score', '--total', '5', '--infra', 'ok,ok,ok,ok,ok']);
    assert.equal(exitCode, 1);
    let parsed;
    try { parsed = JSON.parse(stdout); } catch (_) { parsed = null; }
    assert.ok(parsed === null || parsed.overall_score === undefined, 'stdout must not be a valid score object');
  });

  test('unknown infra token errors instead of silently scoring as missing', () => {
    const { stdout, stderr, exitCode } = runCmd(
      ['eval', 'score', '--covered', '5', '--total', '5', '--infra', 'ok,ok,ok,ok,typo']);
    assert.equal(exitCode, 1);
    assert.match(stderr, /Invalid eval\.score infra token/i);
    assert.equal(stdout, '');
  });

  test('fractional covered/total counts error instead of smuggling partial credit', () => {
    const covered = runCmd(['eval', 'score', '--covered', '0.5', '--total', '1', '--infra', 'ok,ok,ok,ok,ok']);
    assert.equal(covered.exitCode, 1);
    assert.match(covered.stderr, /integer counts/i);
    assert.equal(covered.stdout, '');

    const total = runCmd(['eval', 'score', '--covered', '1', '--total', '1.5', '--infra', 'ok,ok,ok,ok,ok']);
    assert.equal(total.exitCode, 1);
    assert.match(total.stderr, /integer counts/i);
    assert.equal(total.stdout, '');
  });
});
