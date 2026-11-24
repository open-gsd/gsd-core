'use strict';

// debug.md Step 0 after the `init.debug` consolidation (#3149): exactly one init.debug round-trip, none of the three
// replaced calls (state.load, resolve-model gsd-debugger, config-get workflow.tdd_mode), the flat `response_language`
// (not `config.response_language`, the #2402 defect class), the `@file:` unwrap, and the `section_manifest: null`
// read-everything rule. Was tests/init-debug-workflow-contract.test.cjs.

// Every `gsd_run query <name>` invocation in the workflow, in document order.
const queryInvocations = (text) => [...text.matchAll(/gsd_run query ([\w.-]{1,200})/g)].map((match) => match[1]);

module.exports = {
  id: 'init-debug-workflow-contract',
  issue: '#3149',
  check(ctx) {
    ctx.doc('gsd-core/workflows/debug.md')
      .satisfies((text) => {
        const calls = queryInvocations(text).filter((name) => name === 'init.debug').length;
        return calls === 1 || `found ${calls}`;
      }, 'the workflow must make exactly one init.debug round-trip')
      .satisfies((text) => !queryInvocations(text).includes('state.load'), 'state.load is replaced by init.debug')
      .lacks('resolve-model gsd-debugger', 'debugger_model now rides the init bundle')
      .lacks('config-get workflow.tdd_mode', 'tdd_mode now rides the init bundle')
      .lacks('config.response_language', 'response_language is injected at the top level: reading config.response_language against an init bundle resolves undefined and silently drops translated output (#2402)')
      .has('`response_language`', 'the response_language field is still documented, at its new location')
      .has('@file:', 'init payloads can spill to a file: dropping the unwrap leaves INIT holding a path, not JSON')
      .has('section_manifest', 'the section_manifest field is documented')
      .has(/`null`[^\r\n]{0,500}read this workflow in full/i, 'a null section_manifest must be documented as "read everything"');
  },
};
