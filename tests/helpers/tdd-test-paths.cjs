'use strict';

// One owner for every path list the #5181 test-file rows share.
// The parity rows (execute-mvp-tdd-gate) and the real-git rows (safe-resume-gate-anchoring)
// read the shared test and non-test lists, so a path added to either is checked in both directions.
// The property rows (tdd-test-files.property) read SAMPLES_BY_SPEC only.

// A root and a nested sample per TEST_FILE_PATHSPECS entry (the directory specs add a deeper one), keyed by spec.
const SAMPLES_BY_SPEC = {
  '*.test.*': ['a.test.js', 'nested/a.test.js'],
  '*.spec.*': ['a.spec.js', 'nested/a.spec.js'],
  ':(glob)**/tests/**': ['tests/x.js', 'nested/tests/x.js', 'crates/core/tests/sub/x.rs'],
  ':(glob)**/__tests__/**': ['__tests__/x.js', 'nested/__tests__/x.js', 'src/__tests__/sub/y.js'],
  '*_test.go': ['a_test.go', 'nested/a_test.go'],
  ':(glob)**/test_*.py': ['test_a.py', 'nested/test_a.py'],
  '*_test.py': ['a_test.py', 'nested/a_test.py'],
  '*_test.exs': ['a_test.exs', 'nested/a_test.exs'],
  '*_spec.rb': ['a_spec.rb', 'nested/a_spec.rb'],
  '*_test.rb': ['a_test.rb', 'nested/a_test.rb'],
};

const SHARED_TEST_PATHS = [
  ...Object.values(SAMPLES_BY_SPEC).flat(),
  'crates/core/tests/scan_test.rs', 'src/__tests__/util.js', 'pkg/api/test_x.py',
  'test_utils/a_test.py', // `*_test.py` counts under a `test_`-prefixed directory
];

const SHARED_NON_TEST_PATHS = [
  'placement.go', 'crates/core/src/scan.rs', 'test_utils/foo.py', 'src/test_utils/factory.py',
  'mytests/a.js', 'src/contests/b.js', 'src/__tests__x/a.js',
];

module.exports = { SAMPLES_BY_SPEC, SHARED_TEST_PATHS, SHARED_NON_TEST_PATHS };
