// allow-test-rule: source-text-is-the-product
// Tests that every GSD workflow that spawns a subagent carries the liveness phrase
// "runs in a subagent" on its spawn announcement banner line.
// Canonical phrase defined in get-shit-done/references/ui-brand.md § Spawning Indicators.
// Regression test for https://github.com/open-gsd/gsd-core/issues/558.
//
// DESIGN NOTE: We check two independent conditions per file:
//
// 1. BANNER CHECK — every `◆ Spawning …` line (user-visible print) must carry the liveness
//    phrase on that same line. This is the primary convention.
//
// 2. SUBAGENT PRESENCE CHECK — if a file contains a `subagent_type` assignment (i.e. it
//    actually dispatches a subagent), it must contain the liveness phrase somewhere in the
//    file. This is a coarser fallback that catches workflows that dispatch without a
//    `◆ Spawning …` banner — either because they use a prose "Print: `◆ Spawning …`"
//    instruction that was missed, or a display line with a different prefix.
//
// Together the two checks are strictly stronger than the original file-level check,
// without generating false positives for `subagent_type` strings that appear inside
// Agent() code blocks that are themselves within a file that already has a liveness note.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'get-shit-done', 'workflows');
const LIVENESS_PHRASE = 'runs in a subagent';

// Matches a user-visible spawn banner line (the ◆ glyph signals a UI-brand display event).
// We do NOT match raw `subagent_type=` lines here because those are code-block internals,
// not user-visible announcements — the liveness phrase belongs on the banner, not inside
// the Agent() call.
const SPAWN_BANNER_RE = /◆\s+(?:Spawning|spawning)/;

function findMdFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

describe('spawn-liveness-banner', () => {
  test('every ◆ Spawning… banner line carries the liveness phrase "runs in a subagent"', () => {
    const mdFiles = findMdFiles(WORKFLOWS_DIR);
    const bannerViolations = [];

    for (const filePath of mdFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const rel = path.relative(WORKFLOWS_DIR, filePath);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (SPAWN_BANNER_RE.test(line) && !line.includes(LIVENESS_PHRASE)) {
          bannerViolations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    assert.deepStrictEqual(
      bannerViolations,
      [],
      `The following ◆ Spawning… banner lines are missing the liveness phrase "${LIVENESS_PHRASE}":\n` +
        bannerViolations.map(v => `  - ${v}`).join('\n') +
        '\n\nPer get-shit-done/references/ui-brand.md § "Spawning Indicators":\n' +
        'every spawn announcement banner must carry "runs in a subagent" so users know\n' +
        'that silence during a subagent run is expected and do not kill a healthy agent.\n' +
        'See https://github.com/open-gsd/gsd-core/issues/558'
    );
  });

  test('every workflow that dispatches a subagent contains the liveness phrase somewhere', () => {
    const mdFiles = findMdFiles(WORKFLOWS_DIR);
    const presenceViolations = [];

    for (const filePath of mdFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const rel = path.relative(WORKFLOWS_DIR, filePath);

      if (content.includes('subagent_type') && !content.includes(LIVENESS_PHRASE)) {
        presenceViolations.push(rel);
      }
    }

    assert.deepStrictEqual(
      presenceViolations,
      [],
      `The following workflow files contain "subagent_type" but are missing the liveness phrase "${LIVENESS_PHRASE}" anywhere in the file:\n` +
        presenceViolations.map(f => `  - ${f}`).join('\n') +
        '\n\nPer get-shit-done/references/ui-brand.md § "Spawning Indicators":\n' +
        'every workflow that spawns a subagent must carry "runs in a subagent" so users know\n' +
        'that silence during a subagent run is expected and do not kill a healthy agent.\n' +
        'See https://github.com/open-gsd/gsd-core/issues/558'
    );
  });
});
