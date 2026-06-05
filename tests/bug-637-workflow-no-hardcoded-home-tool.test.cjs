// allow-test-rule: source-text-is-the-product
// Workflow .md text IS what the runtime loads and the agent executes, so
// asserting on its shell invocations tests the deployed contract directly.
//
// Repo-wide regression guard for #637 (generalizes the plan-phase-only guard
// from #621): NO workflow .md may invoke gsd-tools via a hardcoded
// `node "$HOME/.../gsd-tools.cjs"` path. On a global/shim-only install with no
// project-local runtime, that path can miss a working install, so the step
// reports the tool "not found" instead of resolving it. Every invocation must
// go through the `gsd_run` launcher (defined once per file in the canonical
// preamble, which resolves RUNTIME_DIR → .claude → PATH → $HOME in order).
//
// The parity test (runtime-launcher-parity) guards the retired $GSD_SDK and
// bare /gsd-tools tokens but NOT this hardcoded-node form — which is exactly
// how it survived across plan-phase.md (#621) and three more files (#637).

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

// Hardcoded direct invocation form. Distinct from the canonical preamble, which
// references $HOME only inside a `[ -f "$HOME/..." ]` probe / `GSD_TOOLS=`
// assignment and always invokes `node "$GSD_TOOLS"` — never `node "$HOME/..."`.
const HARDCODED_HOME_INVOCATION = /node\s+"\$HOME\/[^"]*gsd-tools\.cjs"/;

function collectWorkflowMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectWorkflowMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

describe('bug #637: no workflow .md hardcodes a $HOME gsd-tools invocation', () => {
  test('every gsd-core/workflows/**/*.md resolves gsd-tools via gsd_run, not a hardcoded $HOME path', () => {
    const files = collectWorkflowMarkdown(WORKFLOWS_DIR);
    assert.ok(files.length > 0, 'expected workflow markdown files to exist');

    const offenders = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (HARDCODED_HOME_INVOCATION.test(line)) {
          offenders.push(`${path.relative(WORKFLOWS_DIR, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    assert.deepStrictEqual(
      offenders,
      [],
      'Workflow files must invoke gsd-tools via the resolved `gsd_run` launcher, ' +
        'not a hardcoded `node "$HOME/.../gsd-tools.cjs"` path. Offenders:\n' +
        offenders.join('\n'),
    );
  });
});
