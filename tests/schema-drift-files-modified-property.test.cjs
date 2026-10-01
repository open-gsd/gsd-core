'use strict';

/**
 * #5170 review (property coverage): `verify schema-drift` reads a plan's `files_modified` through the
 * Frontmatter Module (#4562) — an inline array, a block sequence and CRLF line endings must all yield the
 * same files. The property: for any list of plan files, in any of the supported spellings, the verb names
 * the schema file exactly when it is in the list (and reports nothing when it is not), always exit 0
 * (payload mode: a blocking drift verdict is delivered on stdout).
 *
 * Seeded; each run is a real CLI process, so the run count is bounded.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { runTools } = require('./helpers/gsd-tools-cli.cjs');

const SCHEMA = 'prisma/schema.prisma';
const OTHERS = ['src/a.ts', 'lib/b.js', 'docs/readme.md', 'x/y/z.py', 'pkg/index.ts'];

const dirs = [];
afterEach(() => { while (dirs.length > 0) cleanup(dirs.pop()); });

const FORMS = {
  inline: (files) => `files_modified: [${files.join(', ')}]`,
  block: (files) => (files.length === 0 ? 'files_modified: []' : `files_modified:\n${files.map((f) => `  - ${f}`).join('\n')}`),
};

function planText(files, form, crlf) {
  const text = `---\nphase: 1\nplan: 1\nwave: 1\ntype: execute\n${FORMS[form](files)}\n---\n# p\n`;
  return crlf ? text.replace(/\n/g, '\r\n') : text;
}

function run(dir, files, form, crlf) {
  const target = path.join(dir, '.planning/phases/01-x/01-01-PLAN.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, planText(files, form, crlf));
  const r = runTools(['verify', 'schema-drift', '1'], dir);
  return { r, data: JSON.parse(r.stdout) };
}

describe('verify schema-drift: files_modified spellings (property, seeded)', () => {
  test('the schema file is named exactly when it is listed, in every spelling and line ending', () => {
    const dir = createTempGitProject('gsd-schema-drift-prop-');
    dirs.push(dir);
    fc.assert(
      fc.property(
        fc.subarray(OTHERS, { maxLength: 4 }),
        fc.boolean(),
        fc.nat({ max: 4 }),
        fc.constantFrom('inline', 'block'),
        fc.boolean(),
        (others, withSchema, at, form, crlf) => {
          const files = others.slice();
          if (withSchema) files.splice(Math.min(at, files.length), 0, SCHEMA);
          const { r, data } = run(dir, files, form, crlf);
          if (r.exitCode !== 0) return false;
          if (withSchema) return data.drift_detected === true && JSON.stringify(data.schema_files) === JSON.stringify([SCHEMA]);
          return data.drift_detected === false && data.schema_files.length === 0;
        },
      ),
      { seed: 5170, numRuns: 24 },
    );
  });

  test('boundaries: an empty list, one file and the schema file alone are each answered (limit-1 / limit / limit+1 of the list)', () => {
    const dir = createTempGitProject('gsd-schema-drift-bounds-');
    dirs.push(dir);
    for (const form of ['inline', 'block']) {
      for (const crlf of [false, true]) {
        assert.equal(run(dir, [], form, crlf).data.drift_detected, false, `${form} empty`);
        assert.equal(run(dir, [SCHEMA], form, crlf).data.drift_detected, true, `${form} schema alone`);
        assert.equal(run(dir, [OTHERS[0], SCHEMA], form, crlf).data.drift_detected, true, `${form} schema last`);
      }
    }
  });
});
