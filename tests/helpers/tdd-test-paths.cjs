'use strict';

// One owner for every path list the #5181 test-file rows share.
// The real-git rows (safe-resume-gate-anchoring) read the shared test and non-test lists, so a
// path added to either is checked in both directions.
// The parity row (execute-mvp-tdd-gate) and the property rows (tdd-test-files.property) read
// SAMPLES_BY_GLOB only.
// No two shared paths may spell one directory with different case: macOS and Windows disks
// fold them into one directory, and the real-git seed writes every path into one repo.

// A root and a nested sample per TEST_FILE_GLOBS entry (the directory globs add a deeper one), keyed by glob.
const SAMPLES_BY_GLOB = {
  '*.test.*': ['a.test.js', 'nested/a.test.js'],
  '*.spec.*': ['a.spec.js', 'nested/a.spec.js'],
  'tests/**': ['tests/x.js', 'nested/tests/x.js', 'crates/core/tests/sub/x.rs'],
  'test/**': ['test/x.js', 'nested/test/x.js', 'pkg/test/sub/y.js'],
  '__tests__/**': ['__tests__/x.js', 'nested/__tests__/x.js', 'src/__tests__/sub/y.js'],
  '*_test.go': ['a_test.go', 'nested/a_test.go'],
  'test_*.py': ['test_a.py', 'nested/test_a.py'],
  '*_test.py': ['a_test.py', 'nested/a_test.py'],
  '*_test.exs': ['a_test.exs', 'nested/a_test.exs'],
  '*_spec.rb': ['a_spec.rb', 'nested/a_spec.rb'],
  '*_test.rb': ['a_test.rb', 'nested/a_test.rb'],
};

const SHARED_TEST_PATHS = [
  ...Object.values(SAMPLES_BY_GLOB).flat(),
  'crates/core/tests/scan_test.rs', 'src/__tests__/util.js', 'pkg/api/test_x.py',
  'test_utils/a_test.py', // `*_test.py` counts under a `test_`-prefixed directory
  'app/Tests/x.py', 'ios/Tests/A/ATests.swift', 'pkg/Test_x.py', // git and the router both ignore case
];

const SHARED_NON_TEST_PATHS = [
  'placement.go', 'crates/core/src/scan.rs', 'test_utils/foo.py', 'src/test_utils/factory.py',
  'mytests/a.js', 'src/contests/b.js', 'src/__tests__x/a.js',
  'src/a.test.d/impl.js', // `*` stays inside one path segment in both readers
];

module.exports = { SAMPLES_BY_GLOB, SHARED_TEST_PATHS, SHARED_NON_TEST_PATHS };
