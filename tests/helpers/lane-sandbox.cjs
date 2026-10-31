'use strict';

// #5019: a scratch TMPDIR plus an outside "victim" dir no lane-evidence verb may touch.
// Shared by the verb, property and workflow-fence suites so the layout has one owner.

const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('../helpers.cjs');
const { laneStatePath } = require('../../gsd-core/bin/lib/lane-evidence.cjs');

module.exports = function laneSandbox(t) {
  const dir = createTempDir('gsd-5019-');
  t.after(() => cleanup(dir));
  const tmp = path.join(dir, 'tmp'); fs.mkdirSync(tmp);
  const victim = path.join(dir, 'victim'); fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, 'keep'), 'x');
  const review = path.join(dir, '01-REVIEW.md');
  const lane = (suffix) => { const d = path.join(tmp, `gsd-review-lanes-${suffix}`); fs.mkdirSync(d); return d; };
  return { dir, tmp, victim, review, lane, state: laneStatePath(review, tmp) };
};
