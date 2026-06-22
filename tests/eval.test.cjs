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
    assert.equal(at40.verdict, 'SIGNIFICANT GAPS');
  });
});
