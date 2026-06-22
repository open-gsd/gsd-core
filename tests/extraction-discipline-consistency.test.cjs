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
      assert.match(src, /rule-application, not generation/i);
      assert.match(src, /do not (infer|embellish)/i);
    });
  }
});
