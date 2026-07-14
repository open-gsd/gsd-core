'use strict';

/**
 * Property-based tests for the statusline git-segment parser (#2163)
 *
 * Module: hooks/gsd-statusline.js
 * Exported: parseGitStatus(text), buildGitSegment(info)
 *
 * Properties tested:
 *   (a) parseGitStatus: never throws on any input; returns null or the full
 *       typed shape with non-negative counts (total robustness)
 *   (b) round-trip: synthetic porcelain-v2 output for a generated repo state
 *       parses back to exactly that state
 *   (c) prefix-robustness: unknown-prefix lines (future porcelain extensions)
 *       inserted anywhere leave the parsed result unchanged
 *   (d) no-branch-header: any input lacking '# branch.head' parses to null
 *   (e) buildGitSegment: never throws; '' iff branch absent; ✓ iff clean+synced
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { parseGitStatus, buildGitSegment } = require('../hooks/gsd-statusline.js');

const INFO_KEYS = ['branch', 'ahead', 'behind', 'staged', 'unstaged', 'untracked'];
const COUNT_KEYS = ['ahead', 'behind', 'staged', 'unstaged', 'untracked'];

// Branch names from a path-safe alphabet (no whitespace/control chars, which
// git itself forbids in ref names).
const arbBranch = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,40}$/);

// A generated repo state with bounded counts.
const arbState = fc.record({
  branch: arbBranch,
  ahead: fc.nat({ max: 99 }),
  behind: fc.nat({ max: 99 }),
  staged: fc.nat({ max: 20 }),
  unstagedChanged: fc.nat({ max: 20 }),
  unmerged: fc.nat({ max: 5 }),
  untracked: fc.nat({ max: 20 }),
});

/**
 * Render synthetic porcelain v2 --branch output for a generated state.
 * Staged entries get XY 'M.', unstaged 'M' entries '.M', unmerged 'u UU'.
 */
function renderPorcelain(s) {
  const lines = [
    '# branch.oid 0123456789abcdef0123456789abcdef01234567',
    `# branch.head ${s.branch}`,
    `# branch.upstream origin/${s.branch}`,
    `# branch.ab +${s.ahead} -${s.behind}`,
  ];
  for (let i = 0; i < s.staged; i++) {
    lines.push(`1 M. N... 100644 100644 100644 0123456 0123456 staged-${i}.txt`);
  }
  for (let i = 0; i < s.unstagedChanged; i++) {
    lines.push(`1 .M N... 100644 100644 100644 0123456 0123456 unstaged-${i}.txt`);
  }
  for (let i = 0; i < s.unmerged; i++) {
    lines.push(`u UU N... 100644 100644 100644 100644 0123456 0123456 0123456 conflict-${i}.txt`);
  }
  for (let i = 0; i < s.untracked; i++) {
    lines.push(`? new-${i}.txt`);
  }
  return lines.join('\n') + '\n';
}

describe('gsd-statusline git segment: parseGitStatus properties', () => {
  // (a) Total: never throws, result is null or the full typed shape
  test('property: never throws and returns null or a well-formed info object', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant(42),
          fc.constant({}),
          fc.string({ unit: 'binary', maxLength: 300 }),
          fc.string({ unit: 'grapheme-composite', maxLength: 300 }),
          // line soup: random lines joined with \n
          fc.array(fc.string({ maxLength: 60 }), { maxLength: 30 }).map((a) => a.join('\n'))
        ),
        (input) => {
          let result;
          assert.doesNotThrow(() => { result = parseGitStatus(input); });
          if (result !== null) {
            assert.deepEqual(Object.keys(result).sort(), [...INFO_KEYS].sort());
            for (const k of COUNT_KEYS) {
              assert.equal(typeof result[k], 'number');
              assert.ok(result[k] >= 0, `${k} must be >= 0`);
            }
            assert.equal(typeof result.branch, 'string');
            assert.ok(result.branch.length > 0);
          }
        }
      )
    );
  });

  // (b) Round-trip: synthetic porcelain for a state parses back exactly
  test('property: round-trip through synthetic porcelain v2 output', () => {
    fc.assert(
      fc.property(arbState, (s) => {
        const parsed = parseGitStatus(renderPorcelain(s));
        assert.ok(parsed, 'well-formed porcelain must parse');
        assert.equal(parsed.branch, s.branch);
        assert.equal(parsed.ahead, s.ahead);
        assert.equal(parsed.behind, s.behind);
        assert.equal(parsed.staged, s.staged);
        // unmerged (conflict) entries count as unstaged
        assert.equal(parsed.unstaged, s.unstagedChanged + s.unmerged);
        assert.equal(parsed.untracked, s.untracked);
      })
    );
  });

  // (c) Prefix-robustness: unknown-prefix lines never change the result
  test('property: unknown-prefix lines inserted anywhere are ignored', () => {
    // Lines whose first two chars are none of the recognized prefixes
    // ('# ', '1 ', '2 ', 'u ', '? ').
    const arbUnknownLine = fc
      .string({ maxLength: 50 })
      .map((s) => `z ${s}`);
    fc.assert(
      fc.property(
        arbState,
        fc.array(arbUnknownLine, { minLength: 1, maxLength: 10 }),
        fc.nat({ max: 1000 }),
        (s, extras, seedPos) => {
          const baseline = parseGitStatus(renderPorcelain(s));
          const lines = renderPorcelain(s).split('\n');
          // deterministic insertion positions derived from seedPos
          extras.forEach((extra, i) => {
            const pos = (seedPos + i * 7) % (lines.length + 1);
            lines.splice(pos, 0, extra);
          });
          const withExtras = parseGitStatus(lines.join('\n'));
          assert.deepEqual(withExtras, baseline);
        }
      )
    );
  });

  // (d) No-branch-header: input without '# branch.head' parses to null
  test('property: input lacking a branch.head header parses to null', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 60 }), { maxLength: 30 }),
        (rawLines) => {
          const text = rawLines
            .filter((l) => !l.startsWith('# branch.head '))
            .join('\n');
          assert.equal(parseGitStatus(text), null);
        }
      )
    );
  });
});

describe('gsd-statusline git segment: buildGitSegment properties', () => {
  // (e) Never throws; '' iff no branch; clean+synced renders the ✓ marker
  test('property: never throws and is empty exactly when branch is absent', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant({}),
          arbState.map((s) => ({
            branch: s.branch,
            ahead: s.ahead,
            behind: s.behind,
            staged: s.staged,
            unstaged: s.unstagedChanged + s.unmerged,
            untracked: s.untracked,
          }))
        ),
        (info) => {
          let seg;
          assert.doesNotThrow(() => { seg = buildGitSegment(info); });
          assert.equal(typeof seg, 'string');
          if (!info || !info.branch) {
            assert.equal(seg, '');
          } else {
            assert.ok(seg.includes(info.branch));
            const dirty =
              info.staged || info.unstaged || info.untracked || info.ahead || info.behind;
            assert.equal(seg.includes('✓'), !dirty);
          }
        }
      )
    );
  });
});
