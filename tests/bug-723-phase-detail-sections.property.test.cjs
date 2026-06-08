const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');

const core = require('../gsd-core/bin/lib/core.cjs');

function writeState(tmpDir) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    '---\nmilestone: v1.1\n---\n',
    'utf-8',
  );
}

function buildRoadmap(activeNums, extraNums) {
  const activeChecklist = activeNums
    .map((num) => `- [ ] **Phase ${num}: Active ${num}**`)
    .join('\n');
  const activeDetails = activeNums
    .map((num) => `### Phase ${num}: Active ${num}\n**Goal**: Active ${num}.`)
    .join('\n\n');
  const extraDetails = extraNums
    .map((num) => `### Phase ${num}: Extra ${num}\n**Goal**: Extra ${num}.`)
    .join('\n\n');

  return `# Roadmap

<details open>
<summary>v1.1 Current</summary>

${activeChecklist}

</details>

## Phase Details

${activeDetails}

## Backlog

${extraDetails}
`;
}

function phaseHeadingNames(content) {
  return [...content.matchAll(/^#{2,4}\s*Phase\s+(\d+):\s*([^\n]+)/gmi)]
    .map((match) => `${match[1]}:${match[2].trim()}`);
}

describe('bug #723 property: active details phase section containment', () => {
  let tmpDir;

  afterEach(() => {
    cleanup(tmpDir);
    tmpDir = undefined;
  });

  test('property: appended flat detail phases are exactly active references and idempotent', () => {
    tmpDir = createTempProject('gsd-test-723-property-');
    writeState(tmpDir);

    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 8 }),
        fc.uniqueArray(fc.integer({ min: 31, max: 60 }), { minLength: 1, maxLength: 8 }),
        (activeNums, extraNums) => {
          const roadmap = buildRoadmap(activeNums, extraNums);
          const scoped = core.extractCurrentMilestone(roadmap, tmpDir);
          const scopedAgain = core.extractCurrentMilestone(scoped, tmpDir);
          const headings = phaseHeadingNames(scoped);

          assert.deepStrictEqual(scopedAgain, scoped, 'phase detail appending must be idempotent');

          for (const num of activeNums) {
            assert.ok(
              headings.includes(`${num}:Active ${num}`),
              `active phase ${num} must be present in scoped milestone`,
            );
          }

          for (const num of extraNums) {
            assert.ok(
              !headings.includes(`${num}:Extra ${num}`),
              `extra phase ${num} must not be appended into scoped milestone`,
            );
          }
        },
      ),
    );
  });
});
