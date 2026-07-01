'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXTRACTORS = ['gsd-doc-classifier', 'gsd-doc-synthesizer'];

describe('extraction discipline (#8)', () => {
  for (const name of EXTRACTORS) {
    test(`${name} instructs rule-application, not generation`, () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'agents', `${name}.md`), 'utf8');
      assert.match(src, /<extraction_discipline>/, `${name} missing <extraction_discipline>`);
      assert.match(src, /rule-application, not generation/i, `${name} missing rule-application framing`);
      assert.match(src, /do not (infer|embellish)/i, `${name} missing no-infer/embellish rule`);
    });

    test(`${name} contains no-fabrication "mark absent" guidance`, () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'agents', `${name}.md`), 'utf8');
      // Must instruct marking absent fields rather than guessing/fabricating
      assert.match(src, /mark.{0,30}absent/i, `${name} missing "mark absent" no-fabrication guidance`);
    });

    test(`${name} does NOT contain the anti-JSON-reasoning overclaim`, () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'agents', `${name}.md`), 'utf8');
      // The overclaim: "do not reason your way to a ... answer" or "extended deliberation breaks structure"
      assert.doesNotMatch(src, /do not reason your way/i, `${name} still contains anti-JSON-reasoning overclaim`);
      assert.doesNotMatch(src, /extended deliberation.{0,30}breaks/i, `${name} still contains anti-reasoning overclaim`);
    });

    test(`${name} contains few-shot input->output exemplars`, () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'agents', `${name}.md`), 'utf8');
      // Must have at least one worked Input: / Output: pair (or Input -> Output arrow pattern)
      const hasInputOutput = /Input:/i.test(src) && /Output:/i.test(src);
      const hasArrow = /Input\s*→/.test(src) || /Input\s*->/.test(src);
      assert.ok(hasInputOutput || hasArrow, `${name} missing few-shot Input->Output exemplars`);
      // Must have at least 2 exemplar pairs (clean + ambiguous/UNKNOWN)
      const inputMatches = (src.match(/\bInput:/gi) || []).length;
      const arrowMatches = (src.match(/\bInput\s*[→-]/g) || []).length;
      const exemplarCount = inputMatches || arrowMatches;
      assert.ok(exemplarCount >= 2, `${name} needs at least 2 exemplars (clean + UNKNOWN/ambiguous), found ${exemplarCount}`);
    });

    test(`${name} contains a terminal schema restatement before write/output step`, () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'agents', `${name}.md`), 'utf8');
      // Must have a terminal schema restatement marker immediately before the write/output step
      assert.match(src, /terminal.{0,60}schema|schema.{0,60}restatement|output.{0,40}contract.{0,40}reminder|final.{0,40}output.{0,40}schema/i,
        `${name} missing terminal schema restatement before write step`);
    });
  }
});
