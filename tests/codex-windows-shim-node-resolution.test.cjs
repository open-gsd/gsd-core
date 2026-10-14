/**
 * #4838: the Codex Windows `.cmd` hook shim baked ONE absolute node.exe path at
 * install time, with no fallback. A WinGet Node upgrade removes the versioned
 * directory (`...\node-v24.15.0-win-x64\node.exe`), so the shim pointed at a
 * path that no longer existed and the hook failed silently until the installer
 * was re-run. The shim now resolves node when the hook fires: an explicit
 * `GSD_NODE_PATH`, then the baked install-time path while it still exists (the
 * #3662 minimal-PATH guarantee), then `node.exe` from PATH.
 *
 * The shim is batch text, so these tests pin the rendered candidate order and
 * quoting structurally; they cannot execute cmd.exe on a non-Windows host.
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');
const { buildCodexHookWindowsShimIR } = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');

const SCRIPT = 'C:/Users/me/.codex/hooks/gsd-check-update.js';
const WINGET_NODE = 'C:/Users/me/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.LTS_x/node-v24.15.0-win-x64/node.exe';
const RUNNER = JSON.stringify(WINGET_NODE);

function render(runner = RUNNER, script = SCRIPT) {
  return buildCodexHookWindowsShimIR(script, runner).render.cmd();
}

describe('#4838: the Codex Windows shim resolves node when the hook fires', () => {
  test('GSD_NODE_PATH is a candidate, and it is tried before the baked path', () => {
    const text = render();
    const env = text.indexOf('GSD_NODE_PATH');
    const baked = text.indexOf(WINGET_NODE);
    assert.ok(env !== -1, 'the shim must honour GSD_NODE_PATH');
    assert.ok(baked !== -1, 'the install-time path stays as a candidate');
    assert.ok(env < baked, 'an explicit override outranks the install-time path');
  });

  test('every file candidate is checked for existence before it is used', () => {
    const text = render();
    assert.match(text, /IF EXIST "%GSD_NODE_PATH%"/);
    assert.match(text, new RegExp(`IF EXIST "${escapeRegex(WINGET_NODE)}"`));
  });

  test('node.exe on PATH is the last resort, after the baked path', () => {
    const text = render();
    const where = text.search(/where\s+\$PATH:node\.exe/i);
    assert.ok(where !== -1, 'the shim must fall back to node.exe on PATH via `where $PATH:` (PATH only: plain `where` also searches the current directory)');
    assert.ok(where > text.indexOf(WINGET_NODE), 'PATH lookup comes after the install-time path');
  });

  test('the resolved interpreter runs the hook script with every argument forwarded', () => {
    const text = render();
    const lines = text.split('\r\n').filter(Boolean);
    const last = lines[lines.length - 1];
    assert.match(last, /^@?"%GSD_NODE%" "C:\/Users\/me\/\.codex\/hooks\/gsd-check-update\.js" %\*$/);
  });

  test('the file is CRLF throughout and never invokes bash', () => {
    const text = render();
    assert.ok(!/(^|[^\r])\n/.test(text), 'every newline must be CRLF');
    assert.ok(!/bash/i.test(text), 'bash is the #3426 failure; the shim must stay pure cmd.exe');
  });

  test('a percent sign in the install-time path is escaped so cmd.exe does not expand it', () => {
    const text = render(JSON.stringify('C:/Users/100%/node.exe'));
    assert.ok(text.includes('C:/Users/100%%/node.exe'), 'the literal percent is doubled');
    assert.ok(!/100%\/node/.test(text), 'a lone percent would start a variable expansion');
  });

  test('the IR contract is unchanged: interpreter, target, hookCommand, passthrough', () => {
    const ir = buildCodexHookWindowsShimIR(SCRIPT, RUNNER);
    assert.equal(ir.invocation.interpreter, WINGET_NODE);
    assert.equal(ir.invocation.target, SCRIPT);
    assert.equal(ir.passthroughArgs, true);
    assert.ok(ir.hookCommand.includes('.cmd'));
  });
});
