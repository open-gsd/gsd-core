'use strict';

// gsd-core/references/ui-consideration-probe.md keeps its taxonomy id column in sync with the source-of-truth
// UI_TAXONOMY of the built ui-consideration-probe.cjs, the closed taxonomy stays DISJOINT from the open-prose
// domain-probes.md bank (the mixed-axis boundary, ADPT-02), the doc links that bank, its `## Inputs` section
// documents the text_en channel (#4657), and the UI-SPEC template keeps `UI Considerations` and `Copywriting
// Contract` as distinct `##` sections. The comparison is on PARSED table ids and `##` headings, never a raw
// substring. Was tests/ui-consideration-probe-docs-fixtures.test.cjs.

const path = require('node:path');

const taxonomyIds = () => require(path.join(__dirname, '..', '..', '..', 'gsd-core', 'bin', 'lib', 'ui-consideration-probe.cjs')).UI_TAXONOMY.map((entry) => entry.id);

// The text of a `## <name>` section: after the heading line start, up to the next `## ` heading.
function sectionOf(markdown, heading) {
  const after = markdown.split(heading)[1];
  return after === undefined ? null : after.split(/^## /m)[0];
}

// First-column ids of the `## Taxonomy` table: skips the `id` header row and the separator row.
function docTaxonomyIds(markdown) {
  return sectionOf(markdown, /^## Taxonomy/m).split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.split('|')[1].trim())
    .filter((cell) => /^[a-z][a-z0-9-]{0,100}$/.test(cell) && cell !== 'id');
}

// The `##` topic headings of a document, lower-cased.
function headings(markdown) {
  return markdown.split('\n').filter((line) => /^## /.test(line)).map((line) => line.replace(/^## /, '').trim().toLowerCase());
}

module.exports = {
  id: 'ui-consideration-probe-docs-fixtures',
  issue: '#1867',
  check(ctx) {
    ctx.doc('gsd-core/references/ui-consideration-probe.md')
      .satisfies((text) => {
        if (sectionOf(text, /^## Taxonomy/m) === null) return 'no ## Taxonomy section';
        const fromDoc = docTaxonomyIds(text);
        const fromCode = taxonomyIds();
        return JSON.stringify(fromDoc) === JSON.stringify(fromCode) || `doc ids ${JSON.stringify(fromDoc)} against code ids ${JSON.stringify(fromCode)}`;
      }, 'the doc taxonomy ids must equal the code UI_TAXONOMY ids, in order (doc == code)')
      .has(/domain-probes\.md/, 'the doc must name domain-probes.md as the companion open-prose bank (link, do not duplicate)')
      .satisfies((text) => {
        const inputs = sectionOf(text, /^## Inputs/m);
        if (inputs === null) return 'no ## Inputs section';
        if (!/text_en/.test(inputs)) return 'the Inputs section does not mention text_en';
        return /English/.test(inputs) || 'the Inputs section does not say English';
      }, 'the Inputs section must document the optional text_en field as the classifier-facing English rendering (#4657)');

    ctx.doc('gsd-core/references/domain-probes.md').satisfies((text) => {
      const topics = headings(text);
      const overlap = taxonomyIds().filter((id) => topics.includes(id));
      return overlap.length === 0 || `overlapping ids: ${overlap.join(', ')}`;
    }, 'no taxonomy id may overlap a domain-probes.md open-prose topic (closed/open disjointness)');

    ctx.doc('gsd-core/templates/UI-SPEC.md').satisfies((text) => {
      const topics = headings(text);
      if (!topics.includes('ui considerations')) return 'no ## UI Considerations section';
      return topics.includes('copywriting contract') || 'no ## Copywriting Contract section';
    }, 'the template must have both ## UI Considerations and ## Copywriting Contract as distinct sections (de-dup, not a rename)');
  },
};
