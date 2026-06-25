'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REF = path.join(ROOT, 'gsd-core', 'references', 'untrusted-input-boundary.md');
const INGEST_AGENTS = [
  'gsd-phase-researcher', 'gsd-project-researcher', 'gsd-domain-researcher',
  'gsd-ai-researcher', 'gsd-advisor-researcher', 'gsd-research-synthesizer',
  'gsd-doc-classifier', 'gsd-doc-synthesizer',
  // AC #2 named agents: gsd-ui-researcher carries the full WebSearch/WebFetch
  // toolset (web ingress); gsd-assumptions-analyzer reads 5-15 codebase source
  // files (external/source-document ingress per the boundary).
  'gsd-ui-researcher', 'gsd-assumptions-analyzer',
];

describe('untrusted-input isolation (#12)', () => {
  test('shared reference exists with the data/instruction directive', () => {
    assert.ok(fs.existsSync(REF), 'untrusted-input-boundary.md must exist');
    const src = fs.readFileSync(REF, 'utf8');
    assert.match(src, /<security_context>/);
    assert.match(src, /treated as data/i);
    assert.match(src, /never as instructions/i);
  });

  test('reference contains randomized-marker instruction (honest PPA 2506.05739)', () => {
    const src = fs.readFileSync(REF, 'utf8');
    // Must mention randomness near a DATA marker — fixed/predictable markers are spoofable
    assert.match(src, /random|fresh|unique|nonce/i,
      'reference must instruct agents to generate a fresh/random delimiter per wrap');
    assert.match(src, /DATA_/,
      'reference must still reference DATA_ marker pattern');
  });

  test('reference contains self-guard/self-scan instruction (honest PromptArmor 2507.15219)', () => {
    const src = fs.readFileSync(REF, 'utf8');
    // Must instruct agent to scan/inspect content itself before using it
    assert.match(src, /inspect|scan.{0,30}before|act as.{0,30}guard|self.{0,10}guard|self.{0,10}scan/i,
      'reference must instruct agents to self-inspect content for embedded instructions before use');
  });

  test('reference contains task-anchor instruction (honest Referencing 2504.20472)', () => {
    const src = fs.readFileSync(REF, 'utf8');
    // Must instruct agent to act only on its assigned task and ignore off-task instructions in data
    assert.match(src, /only.{0,40}(?:your|the).{0,20}(?:task|assignment)|assigned task|not tied to/i,
      'reference must instruct agents to act only on their assigned task and ignore instructions in data not tied to that task');
  });

  for (const name of INGEST_AGENTS) {
    test(`${name} @-includes the untrusted-input-boundary reference`, () => {
      const src = fs.readFileSync(path.join(ROOT, 'agents', `${name}.md`), 'utf8');
      assert.match(src, /references\/untrusted-input-boundary\.md/, `${name} missing the @-include`);
    });
  }
});
