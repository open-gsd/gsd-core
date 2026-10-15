'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const HELPER_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'planning-artifact-content.cjs');
const CLI_PATH = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const NORMALIZE_COMMAND = 'gsd_run query normalize-planning-artifact-content --raw';

const { normalizePlanningArtifactContent } = require(HELPER_PATH);

function stepBody(source, name) {
  const match = source.match(new RegExp(`<step name="${name}">([\\s\\S]*?)<\\/step>`));
  assert.ok(match, `expected <step name="${name}"> contract`);
  return match[1];
}

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

describe('normalizePlanningArtifactContent', () => {
  test('removes only a standalone content closer outside a fenced block and is idempotent', () => {
    const input = 'Normal\n</content>\n```text\n</content>\n```\n';
    const expected = 'Normal\n```text\n</content>\n```\n';

    const normalized = normalizePlanningArtifactContent(input);

    assert.equal(normalized, expected);
    assert.equal(normalizePlanningArtifactContent(normalized), normalized);
    assert.equal(occurrences(normalized, '</content>'), 1);
  });

  test('preserves CRLF and fenced markers byte-for-byte while removing the outside line', () => {
    const input = 'Before\r\n</content>\r\n~~~md\r\n</content>\r\n~~~\r\nAfter\r\n';
    const expected = 'Before\r\n~~~md\r\n</content>\r\n~~~\r\nAfter\r\n';

    assert.equal(normalizePlanningArtifactContent(input), expected);
  });

  test('honors delimiter character, opener length, and an unterminated fence', () => {
    const input = [
      '````text',
      '</content>',
      '```',
      '</content>',
      '````',
      '</content>',
      '~~~',
      '</content>',
    ].join('\n');
    const expected = [
      '````text',
      '</content>',
      '```',
      '</content>',
      '````',
      '~~~',
      '</content>',
    ].join('\n');

    assert.equal(normalizePlanningArtifactContent(input), expected);
  });

  test('does not treat an indented or invalid backtick delimiter as a fence', () => {
    const input = [
      '    ```text',
      '</content>',
      '    ```',
      '```bad`info',
      '</content>',
      'ordinary </content> text',
    ].join('\n');
    const expected = [
      '    ```text',
      '    ```',
      '```bad`info',
      'ordinary </content> text',
    ].join('\n');

    assert.equal(normalizePlanningArtifactContent(input), expected);
  });
});

test('CLI applies the same byte-preserving helper to the complete stdin payload', () => {
  const input = 'Normal\n</content>\n```text\n</content>\n```\n';
  const result = spawnSync(
    process.execPath,
    [CLI_PATH, 'query', 'normalize-planning-artifact-content', '--raw'],
    { cwd: ROOT, input, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Normal\n```text\n</content>\n```\n');
});

test('CLI preserves non-UTF-8 bytes in retained lines', () => {
  const input = Buffer.concat([
    Buffer.from('Before '),
    Buffer.from([0xff, 0xfe]),
    Buffer.from('\n</content>\nAfter\n'),
  ]);
  const expected = Buffer.concat([
    Buffer.from('Before '),
    Buffer.from([0xff, 0xfe]),
    Buffer.from('\nAfter\n'),
  ]);
  const result = spawnSync(
    process.execPath,
    [CLI_PATH, 'query', 'normalize-planning-artifact-content', '--raw'],
    { cwd: ROOT, input, timeout: PROBE_TIMEOUT_MS },
  );

  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(result.stdout, expected);
});

test('PLAN and SUMMARY contracts each invoke the shared normalizer once before writing', () => {
  const planner = fs.readFileSync(path.join(ROOT, 'agents', 'gsd-planner.md'), 'utf8');
  const executePlan = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'execute-plan.md'), 'utf8');
  const planStep = stepBody(planner, 'write_phase_prompt');
  const summaryStep = stepBody(executePlan, 'create_summary');

  for (const [label, step, writeAnchor] of [
    ['PLAN', planStep, '**ALWAYS use the Write tool'],
    ['SUMMARY', summaryStep, '**Critical ordering — write and commit SUMMARY.md'],
  ]) {
    assert.equal(
      occurrences(step, NORMALIZE_COMMAND),
      1,
      `${label} must invoke the shared programmatic normalizer exactly once`,
    );
    assert.ok(
      step.indexOf(NORMALIZE_COMMAND) < step.indexOf(writeAnchor),
      `${label} must normalize the complete candidate before its final Write contract`,
    );
    assert.match(step, /complete candidate content|complete candidate payload/i);
    assert.match(step, /stdout.*Write payload|Write payload.*stdout/i);
  }
});

test('segmented execution delegates SUMMARY creation to the normalized create_summary contract', () => {
  const executePlan = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'execute-plan.md'), 'utf8');
  const segmentStep = stepBody(executePlan, 'segment_execution');

  assert.match(segmentStep, /create_summary/);
  assert.match(segmentStep, /normaliz/i);
  assert.ok(
    segmentStep.indexOf('create_summary') < segmentStep.indexOf('create SUMMARY.md'),
    'the normalized canonical contract must govern the segmented SUMMARY creation instruction',
  );
});
