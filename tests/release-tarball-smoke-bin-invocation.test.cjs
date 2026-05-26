'use strict';

/**
 * Unit tests for the binInvocation helper in scripts/release-tarball-smoke.cjs.
 *
 * Asserts ONLY on the returned descriptor — no process spawning.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { binInvocation } = require('../scripts/release-tarball-smoke.cjs');

describe('binInvocation', () => {
  it('returns shell:true and command=binPath (not execPath) for a .cmd path', () => {
    const bin = 'C:\\prefix\\node_modules\\.bin\\gsd-tools.cmd';
    const result = binInvocation(bin, ['--help']);

    assert.strictEqual(result.command, bin,
      'command must be the .cmd path itself, not process.execPath');
    assert.strictEqual(result.shell, true,
      'shell must be true for .cmd shims (Node CVE-2024-27980 mitigation)');
    // The bin path must NOT appear in args as if it were a node script argument
    assert.ok(
      !result.args.includes(bin),
      'the .cmd path must not be pushed into args as a node-script positional',
    );
  });

  it('returns shell:true and command=binPath for a .bat path', () => {
    const bin = 'C:\\prefix\\node_modules\\.bin\\gsd-tools.bat';
    const result = binInvocation(bin, ['--help']);

    assert.strictEqual(result.shell, true, 'shell must be true for .bat shims');
    assert.strictEqual(result.command, bin, 'command must be the .bat path');
  });

  it('returns command===process.execPath and args[0]===binPath and shell falsy for a POSIX path', () => {
    const bin = '/tmp/prefix/bin/gsd-tools';
    const result = binInvocation(bin, ['--help']);

    assert.strictEqual(result.command, process.execPath,
      'POSIX bin must be invoked via node (process.execPath)');
    assert.strictEqual(result.args[0], bin,
      'POSIX bin path must be args[0] (the node script argument)');
    assert.ok(!result.shell,
      'shell must be falsy for POSIX shebang bins');
  });

  it('quotes a .cmd path containing a space so the shell receives one token', () => {
    const bin = 'C:\\Users\\a b\\node_modules\\.bin\\gsd-tools.cmd';
    const result = binInvocation(bin, ['--help']);

    assert.strictEqual(result.shell, true, 'shell must be true');
    assert.strictEqual(result.command, `"${bin}"`, 'spaced .cmd path must be wrapped in double-quotes as a single shell token');
  });
});
