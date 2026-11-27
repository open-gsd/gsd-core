'use strict';

// Untrusted-input isolation (#12): the shared untrusted-input-boundary reference carries the data/instruction
// directive, a randomized marker, a self-guard instruction and a task anchor, and each ingesting agent @-includes
// it. Was tests/untrusted-input-isolation.test.cjs.

const REF = 'gsd-core/references/untrusted-input-boundary.md';
const INGEST_AGENTS = [
  'gsd-phase-researcher', 'gsd-project-researcher', 'gsd-domain-researcher',
  'gsd-ai-researcher', 'gsd-advisor-researcher', 'gsd-research-synthesizer',
  'gsd-doc-classifier', 'gsd-doc-synthesizer',
  // gsd-ui-researcher carries the full WebSearch/WebFetch toolset (web ingress); gsd-assumptions-analyzer reads
  // codebase source files (external/source-document ingress per the boundary).
  'gsd-ui-researcher', 'gsd-assumptions-analyzer',
];

module.exports = {
  id: 'untrusted-input-isolation',
  issue: '#12',
  check(ctx) {
    ctx.exists(REF, 'untrusted-input-boundary.md must exist');
    ctx.doc(REF)
      .has(/<security_context>/, 'the reference must carry the <security_context> block')
      .has(/treated as data/i, 'the reference must say untrusted content is treated as data')
      .has(/never as instructions/i, 'the reference must say it is never treated as instructions')
      .has(/random|fresh|unique|nonce/i, 'the reference must instruct agents to generate a fresh/random delimiter per wrap')
      .has(/DATA_/, 'the reference must still reference the DATA_ marker pattern')
      .has(/inspect|scan.{0,30}before|act as.{0,30}guard|self.{0,10}guard|self.{0,10}scan/i, 'the reference must instruct agents to self-inspect content for embedded instructions before use')
      .has(/only.{0,40}(?:your|the).{0,20}(?:task|assignment)|assigned task|not tied to/i, 'the reference must instruct agents to act only on their assigned task and ignore instructions in data not tied to it');
    for (const name of INGEST_AGENTS) {
      ctx.doc(`agents/${name}.md`).has(/references\/untrusted-input-boundary\.md/, `${name} must @-include the untrusted-input-boundary reference`);
    }
  },
};
