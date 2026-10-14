/**
 * #4859: runtime-generated guidance must name a command the installed surface
 * registers. `/gsd:<cmd>` (colon form) is registered on no install route — the
 * npm installer produces `/gsd-<cmd>` (`$gsd-<cmd>` on Codex) and the native
 * plugin produces `/gsd-core:gsd-<cmd>` — but string literals in the compiled
 * runtime code are printed verbatim, so the install-time conversion of
 * markdown artifacts never reaches them. Every such literal is routed through
 * `formatGsdSlash` (the runtime-aware projection), and a static guard keeps the
 * colon form out of the source.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup, runGsdTools } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');

/** `/gsd:` followed by a command name; `/gsd:section` is the fragment close-tag, not a command. */
const COLON_COMMAND_RE = /\/gsd:(?!section\b)[a-z][a-z-]*/g;

/** Non-comment lines of `file` that spell `/gsd:<command>`, as `rel:line: hits`. */
function colonCommandOffenders(dir, ext, relPrefix) {
  const offenders = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(ext))) {
    const lines = splitLines(fs.readFileSync(path.join(dir, file), 'utf-8'));
    let inBlockComment = false;
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        return;
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlockComment = true;
        return;
      }
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      const hits = line.match(COLON_COMMAND_RE);
      if (hits) offenders.push(`${relPrefix}${file}:${i + 1}: ${hits.join(', ')}`);
    });
  }
  return offenders;
}

describe('#4859: no colon-form command literal in runtime code', () => {
  test('src/*.cts non-comment code never spells /gsd:<command>', () => {
    const offenders = colonCommandOffenders(SRC_DIR, '.cts', 'src/');
    assert.deepEqual(
      offenders,
      [],
      `these source lines print the unregistered colon form; route them through runtimeCommand/formatGsdSlash:\n${offenders.join('\n')}`,
    );
  });

  test('shipped gsd-core/bin/lib/*.cjs (generated registry included) never spells /gsd:<command>', () => {
    const offenders = colonCommandOffenders(path.join(ROOT, 'gsd-core', 'bin', 'lib'), '.cjs', 'gsd-core/bin/lib/');
    assert.deepEqual(
      offenders,
      [],
      `these shipped lines print the unregistered colon form; the registry generator rewrites capability text, hand-written modules must use the hyphen form:\n${offenders.join('\n')}`,
    );
  });
});

describe('#4859: smart-entry menu names the registered command form', () => {
  function menu(runtime) {
    // An empty directory is the `no-project` situation: a fixed, runtime-independent action list.
    const bare = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-4859-bare-'));
    try {
      const res = runGsdTools(['smart-entry', '--json'], bare, { GSD_RUNTIME: runtime });
      assert.ok(res.success, `smart-entry failed: ${res.error}`);
      return JSON.parse(res.output);
    } finally {
      cleanup(bare);
    }
  }

  test('claude: every action command is /gsd-<cmd>', () => {
    const result = menu('claude');
    assert.ok(result.actions.length > 0, 'the menu must offer actions');
    for (const a of result.actions) {
      assert.match(a.command, /^\/gsd-[a-z]/, `${a.id} command must be hyphen-form, got ${JSON.stringify(a.command)}`);
      assert.ok(!a.command.includes('/gsd:'), `${a.id} command must not use the colon form: ${a.command}`);
    }
  });

  test('codex: every action command is $gsd-<cmd>', () => {
    const result = menu('codex');
    for (const a of result.actions) {
      assert.match(a.command, /^\$gsd-[a-z]/, `${a.id} command must be the codex form, got ${JSON.stringify(a.command)}`);
    }
  });

  test('a command with arguments keeps its argument tail', () => {
    const result = menu('claude');
    const all = require('../gsd-core/bin/lib/smart-entry.cjs');
    const progressNext = all.actionsFor('planning', { current_phase: '3' }).find((a) => a.id === 'progress-next');
    assert.ok(progressNext, 'planning offers progress-next');
    assert.equal(progressNext.command, '/gsd-progress --next', `got ${JSON.stringify(progressNext.command)}`);
    assert.ok(result.actions.length > 0);
  });
});

describe('#4859: rejection messages name the registered command form', () => {
  test('quick-batch --discuss rejection points at /gsd-quick, not /gsd:quick', () => {
    const dispatch = require('../gsd-core/bin/lib/quick-batch-dispatch.cjs');
    const result = dispatch.parseQuickBatchArgs(['--discuss']);
    assert.equal(result.ok, false);
    assert.ok(!result.reason.includes('/gsd:'), `reason must not use the colon form: ${result.reason}`);
    assert.match(result.reason, /\/gsd-quick --discuss/);
  });
});
