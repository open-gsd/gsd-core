'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runGsdTools } = require('./helpers.cjs');

test('bug #167: query meta-command prefixes direct gsd-tools calls', () => {
  const direct = runGsdTools(['init.progress']);
  assert.equal(direct.success, true, `init.progress failed: ${direct.error || direct.output}`);

  const meta = runGsdTools(['query', 'init.progress']);
  assert.equal(meta.success, true, `query init.progress failed: ${meta.error || meta.output}`);

  assert.deepEqual(
    JSON.parse(meta.output),
    JSON.parse(direct.output),
    'query-prefixed and direct invocations should return identical init.progress payloads'
  );
});
