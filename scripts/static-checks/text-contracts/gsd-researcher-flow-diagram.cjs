'use strict';

// gsd-phase-researcher enforces data-flow architecture diagrams instead of file-listing diagrams, and the
// research template carries the matching directive (#2139). Was tests/gsd-researcher-flow-diagram.test.cjs.

const DIAGRAM_HEADING = '### System Architecture Diagram';

module.exports = {
  id: 'gsd-researcher-flow-diagram',
  issue: '#2139',
  check(ctx) {
    const researcher = ctx.doc('agents/gsd-phase-researcher.md')
      .has(DIAGRAM_HEADING, 'gsd-phase-researcher.md must contain "### System Architecture Diagram"')
      .has('data flow through conceptual components', 'the directive must require "data flow through conceptual components"')
      .has('not file listings', 'the directive must explicitly state "not file listings"');
    for (const requirement of ['entry points', 'processing stages', 'decision points', 'external dependencies', 'arrows']) {
      researcher.has(new RegExp(requirement, 'i'), `the directive must mention "${requirement}"`);
    }
    researcher
      .has('Component Responsibilities table', 'the directive must redirect file mapping to the Component Responsibilities table')
      .before(DIAGRAM_HEADING, '### Recommended Project Structure', 'the System Architecture Diagram section must come before Recommended Project Structure');

    ctx.doc('gsd-core/templates/research.md')
      .has(DIAGRAM_HEADING, 'the research template must contain "### System Architecture Diagram"')
      .has('data flow through conceptual components', 'the research template must include the flow diagram directive')
      .has('not file listings', 'the research template must prohibit file listings in diagrams');
  },
};
