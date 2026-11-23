'use strict';

// docs/contributor-standards.md (#2721): it exists, has `## ` headings for CONTEXT.md, ADRs and AI-agent-assisted work,
// references CONTEXT.md and docs/adr/, and CONTRIBUTING.md links it. Parity: every backticked heading the doc's
// `## CONTEXT.md` section directs contributors to exists in CONTEXT.md (the ADR and PR body headings the doc names
// elsewhere are not read as CONTEXT.md claims), the glossary heading is still there, the emitted-attribution ruleset
// sits under `## Test rules and lint`, and `### Emitted Artifact Provenance` is registered in the glossary without a
// `Module` suffix. The old test's backtick and heading patterns are linear walks here with the same verdicts, except
// that a heading line is read within its own line. Was tests/contributor-standards.test.cjs.

const STANDARDS = 'docs/contributor-standards.md';
const CONTEXT = 'CONTEXT.md';
const GLOSSARY = '## Glossary — Domain modules and seams';
const PROVENANCE = '### Emitted Artifact Provenance';

// The body of one `## ` section, up to the next `## ` heading; null when the heading is absent.
function sectionBody(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

// The `## ` headings of the standards doc, without the marker.
const h2Headings = (text) => text.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3).trim());

// The backticked headings of one section (two to six hashes, whitespace, a title, no `<` placeholder), in one pass.
function backtickedHeadings(body) {
  const refs = new Set();
  let at = body.indexOf('`');
  while (at !== -1) {
    let end = at + 1;
    while (end < body.length && body[end] === '#') end += 1;
    const hashes = end - (at + 1);
    if (hashes >= 2 && hashes <= 6 && end < body.length && /\s/.test(body[end])) {
      const close = body.indexOf('`', end);
      if (close - end >= 2) {
        const heading = body.slice(at + 1, close).trim();
        if (!heading.includes('<')) refs.add(heading);
        at = body.indexOf('`', close + 1);
        continue;
      }
    }
    at = body.indexOf('`', at + 1);
  }
  return [...refs];
}

// The headings of CONTEXT.md: lines of two to six hashes, whitespace and a title, trimmed.
function actualHeadings(text) {
  const found = new Set();
  for (const line of text.split(/[\n\r\u2028\u2029]/)) {
    let hashes = 0;
    while (hashes < 7 && line[hashes] === '#') hashes += 1;
    if (hashes >= 2 && hashes <= 6 && /\s/.test(line[hashes] ?? '')) found.add(line.trim());
  }
  return found;
}

const headingCheck = (pattern, label) => (text) => {
  const headings = h2Headings(text);
  return headings.some((heading) => pattern.test(heading)) || `Expected an ## heading containing ${label}. Found headings: ${JSON.stringify(headings)}`;
};

module.exports = {
  // The linear walkers, exported for the differential properties of tests/text-contracts.batch10.test.cjs.
  backtickedHeadings, actualHeadings,
  id: 'contributor-standards',
  issue: '#2721',
  check(ctx) {
    const standards = ctx.doc(STANDARDS)
      .satisfies(headingCheck(/context/i, '"context" (case-insensitive)'), 'has required CONTEXT.md section')
      .satisfies(headingCheck(/adr/i, '"ADR" (case-insensitive)'), 'has required ADR section')
      .satisfies(headingCheck(/ai.?agent|agent.?assist/i, '"AI-agent" or "agent-assist" (case-insensitive)'), 'has required AI-agent section')
      .has('CONTEXT.md', 'docs/contributor-standards.md must reference CONTEXT.md')
      .has('docs/adr/', 'docs/contributor-standards.md must reference docs/adr/');

    // The headings the doc's own `## CONTEXT.md` section names, not those of the ADR or PR bodies it describes.
    const refsOf = (text) => {
      const body = sectionBody(text, '## CONTEXT.md');
      return body === null ? [] : backtickedHeadings(body);
    };
    standards
      .satisfies((text) => refsOf(text).length > 0, 'the standards doc must name at least one CONTEXT.md heading')
      .satisfies((text) => {
        const refs = refsOf(text);
        const foreign = ['## Decision', '## Consequences', '## Standards followed'].filter((heading) => refs.includes(heading));
        return foreign.length === 0 || `${foreign.join(', ')} describes another document's structure and must not be read as a CONTEXT.md claim`;
      }, 'the CONTEXT.md heading extractor must not treat ADR or PR body headings as CONTEXT.md claims');

    // The standards doc's references are checked against CONTEXT.md; an unreadable standards doc is already a finding.
    let refs = null;
    standards.satisfies((text) => {
      refs = refsOf(text);
      return true;
    }, 'the standards doc must be readable');
    ctx.doc(CONTEXT)
      .satisfies((text) => {
        if (refs === null) return true;
        const actual = actualHeadings(text);
        const missing = refs.filter((heading) => !actual.has(heading));
        return missing.length === 0 || `docs/contributor-standards.md directs contributors to heading(s) that do not exist in CONTEXT.md: ${JSON.stringify(missing)}`;
      }, 'every CONTEXT.md heading named by the standards doc must exist in CONTEXT.md')
      .satisfies((text) => actualHeadings(text).has(GLOSSARY), 'the glossary heading is the one the standards doc points Module authors at')
      .satisfies((text) => {
        const body = sectionBody(text, '## Test rules and lint');
        if (!body) return 'CONTEXT.md must have a `## Test rules and lint` section';
        return body.includes('RULESET.EMITTED_ATTRIBUTION=') || 'the section does not hold RULESET.EMITTED_ATTRIBUTION=';
      }, 'RULESET.EMITTED_ATTRIBUTION must be a sibling of the other test rules, not floating elsewhere')
      .satisfies((text) => {
        const body = sectionBody(text, GLOSSARY);
        if (!body) return 'CONTEXT.md must have the glossary section';
        return body.includes(PROVENANCE) || `the glossary section does not hold ${PROVENANCE}`;
      }, 'the emitted-artifact family must be registered in the glossary')
      .satisfies((text) => {
        const headings = actualHeadings(text);
        if (!headings.has(PROVENANCE)) return `CONTEXT.md has no ${PROVENANCE} heading`;
        return !headings.has(`${PROVENANCE} Module`) || `${PROVENANCE} Module is a heading`;
      }, 'Emitted Artifact Provenance is a concept, not a module: it ships nothing, so it takes no `Module` suffix');

    ctx.doc('CONTRIBUTING.md').has('contributor-standards.md', 'CONTRIBUTING.md must link to docs/contributor-standards.md');
  },
};
