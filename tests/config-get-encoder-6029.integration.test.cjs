/**
 * #6029 acceptance (C2 of epic #4633): the real CLI path behind
 * `/gsd-code-review`. `query config-get workflow.code_review_depth_overrides
 * --default '[]'` must hand the resolver a JSON array, not the string "[]"
 * (#4262 / #4382).
 *
 * Integration suite: it spawns the CLI subprocess and so crosses the bin entry
 * points (docs/TESTING-SUITES.md). The in-process parser/encoder coverage lives
 * in config-get-encoder-6029.test.cjs.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cleanup, runGsdTools, createTempProject } = require('./helpers.cjs');

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const { resolveCodeReviewDepth } = require(path.join(LIB, 'code-review-depth.cjs'));

describe('#6029 acceptance: /gsd-code-review resolve_depth in a project with no config keys', () => {
  let tmp;
  beforeEach(() => {
    tmp = createTempProject('gsd-6029-cr-');
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), '{}');
  });
  afterEach(() => cleanup(tmp));

  test("real CLI: query config-get workflow.code_review_depth_overrides --default '[]' feeds the resolver an array", () => {
    const r = runGsdTools(['query', 'config-get', 'workflow.code_review_depth_overrides', '--default', '[]'], tmp, { HOME: tmp });
    assert.equal(r.success, true, r.error);
    const overrides = JSON.parse(r.output);
    assert.ok(Array.isArray(overrides), `expected an array, got ${JSON.stringify(overrides)}`);
    const depth = resolveCodeReviewDepth({ flagDepth: '', configDepth: '', overrides, files: ['src/a.ts'], repoRoot: tmp });
    assert.equal(depth.ok, true, JSON.stringify(depth));
  });
});
