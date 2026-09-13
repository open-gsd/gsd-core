'use strict';

const path = require('path');

/**
 * no-unconfined-path-join
 *
 * Epic #4636 consolidated every hand-rolled path-containment check in this
 * repo onto a single implementation, `isContainedIn` in `src/security.cts`,
 * exported as two deliberate families:
 *
 *   - `assertWithinRoot` / `tryWithinRoot` — realpath-resolved containment.
 *     This is the DEFAULT for any boundary that takes external input (a user
 *     path, a config value, an argv path): it resolves symlinks before
 *     comparing, so a symlink planted inside the root that points outside it
 *     cannot escape the check.
 *   - `assertWithinRootLexical` / `tryWithinRootLexical` — lexical (string
 *     prefix) containment, no filesystem access. This family exists ONLY for
 *     the narrow case where a symlink must be PRESERVED rather than
 *     resolved, or where the candidate path does not exist on disk yet (so
 *     `realpath` would throw or silently resolve nothing). A caller must
 *     pick the family deliberately — collapsing a lexical call site onto the
 *     realpath form is not a safe "simplification": doing exactly that broke
 *     four tests in Phase 3 of this epic (#4653), because those sites
 *     depended on the symlink surviving unresolved.
 *
 * This rule has two arms, both aimed at call sites that never went through
 * that consolidation and so get neither guarantee.
 *
 * ## Arm 1 — hand-rolled containment comparison (`handRolledContainment`)
 *
 * Flags `x.startsWith(y + path.sep)` and the string-literal equivalents
 * (`y + '/'`, `y + '\\'`). This shape looks like a containment check but is
 * not one: it is a plain string-prefix test with no symlink resolution, no
 * normalization of `..` segments, and no protection against a `y` that is
 * itself a prefix of a sibling directory name (`/root-evil` starts with
 * `/root` + sep only if the separator is included, which this shape happens
 * to get right — but every other edge case `isContainedIn` handles is still
 * missing). Replace it with `assertWithinRoot`/`tryWithinRoot` (or the
 * `*Lexical` variant only if a symlink genuinely must not be resolved, or
 * the target does not exist yet) from `src/security.cts`.
 *
 * A one-line justified holdout can suppress a single occurrence with a
 * trailing same-line comment:
 *
 *     resolved.startsWith(root + path.sep); // allow-handrolled-containment: <reason>
 *
 * The marker covers two distinct justifications, and the mandatory reason
 * text is what distinguishes them for review:
 *
 *   (a) the comparison is not a containment decision at all — prefix
 *       filtering for selection, grouping or display, an ancestor-walk loop
 *       condition, or identity matching.
 *   (b) it IS a containment decision, but the canonical predicate in
 *       `src/security.cts` is unreachable from this file. Two real cases:
 *       `gsd-core/bin/lib/capability-validator.cjs` is a committed `.cjs`
 *       that must run before `npm run build:lib`, and
 *       `gsd-core/bin/lib/security.cjs` (the compiled predicate) is build
 *       output that is gitignored and untracked — requiring it would break
 *       a fresh clone. `scripts/lib/drift-scan.cjs` runs under `lint:ci`
 *       with the same exposure.
 *
 * The text after the colon must be non-empty after trimming — an empty or
 * missing reason does not suppress, and neither does the marker text without
 * a colon at all.
 *
 * ## Arm 2 — a discarded containment answer (`discardedContainmentResult`)
 *
 * Flags a bare statement-position call to one of the `src/security.cts`
 * containment predicates (`assertWithinRoot`, `tryWithinRoot`,
 * `requireSafePath`, `assertWithinRootLexical`, `tryWithinRootLexical`,
 * `isPathConfined`, `assertDestWithinConfigHome`) whose return value is
 * discarded. The return value IS the answer — for the `try*`/`is*` members
 * of this family in particular, calling them and throwing away the result is
 * indistinguishable from never having called them at all: no exception is
 * thrown on containment failure, so the call is a no-op that merely looks
 * like a check. This "validate one path, use another" defect recurred five
 * separate times across epic #4636's call sites. `assertWithinRoot` and its
 * lexical sibling throw on failure, so a bare statement call to those two
 * IS meaningful as a guard — but this rule still flags it, because the
 * common bug pattern is copy-pasting a `try*`/`is*` call as if it were an
 * `assert*` one; the fix in every case is to use the returned/normalized
 * path (or the boolean) rather than re-deriving it, or re-reading the
 * original unchecked value, downstream.
 *
 * ## Allowlist
 *
 * `allowlist` (repo-relative POSIX paths) exempts pre-existing legacy
 * violations pending migration, with mechanics identical to
 * `no-adhoc-timeout-literal.cjs`: an allowlisted file's violations are
 * counted internally but not reported; a listed file with zero violations
 * reports `staleAllowlistEntry` so the dead entry gets deleted. The
 * allowlist only ever ratchets down.
 */

const DISCARDED_CALL_NAMES = new Set([
  'assertWithinRoot',
  'tryWithinRoot',
  'requireSafePath',
  'assertWithinRootLexical',
  'tryWithinRootLexical',
  'isPathConfined',
  'assertDestWithinConfigHome',
]);

const MARKER_RE = /allow-handrolled-containment:(.*)$/;

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hand-rolled path-containment comparisons and discarded containment-check results',
      category: 'Security',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowlist: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      handRolledContainment:
        'Hand-rolled containment comparison `x.startsWith(y + sep)`: this repo consolidated every ' +
        'path-containment check onto one implementation (`isContainedIn`, src/security.cts), exported ' +
        'as `assertWithinRoot`/`tryWithinRoot` (realpath-resolved — use this at any boundary that takes ' +
        'external input) and `assertWithinRootLexical`/`tryWithinRootLexical` (lexical, no filesystem ' +
        'access — use ONLY where a symlink must be PRESERVED rather than resolved, or the target does ' +
        'not exist yet). A caller must pick the family deliberately: collapsing a lexical site onto the ' +
        'realpath form broke four tests in Phase 3 of epic #4636 (#4653). Replace this comparison with a ' +
        'call to the correct family member, or if this is a justified holdout add a trailing same-line ' +
        'comment `// allow-handrolled-containment: <non-empty reason>` explaining either (a) this is not ' +
        'actually a containment decision (prefix filtering for selection/grouping/display, an ' +
        'ancestor-walk loop condition, or identity matching), or (b) it is a containment decision but the ' +
        'canonical predicate in src/security.cts is unreachable from this file.',
      discardedContainmentResult:
        'Containment predicate `{{name}}(...)` called as a bare statement: the return value IS the ' +
        'answer, and discarding it is indistinguishable from never calling it — no exception is thrown ' +
        'on failure for the `try*`/`is*` members of this family, so the call becomes a no-op that only ' +
        'looks like a check. This "validate one path, use another" defect recurred five times across ' +
        'epic #4636. Use the returned/normalized path (or boolean) at the point where you assign, branch, ' +
        'or pass a value downstream instead of discarding it.',
      staleAllowlistEntry:
        '{{file}} no longer contains an unconfined path-join violation. Delete its line from ' +
        'eslint-rules/no-unconfined-path-join.allowlist.json — the allowlist only ratchets down.',
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const allowlist = Array.isArray(options.allowlist) ? options.allowlist : [];

    const filename = context.filename || context.getFilename();
    const cwd = context.cwd || (context.getCwd ? context.getCwd() : process.cwd());
    const rel = path.relative(cwd, filename).split(path.sep).join('/');
    const allowlisted = allowlist.includes(rel);
    let violations = 0;

    const sourceCode = context.sourceCode || context.getSourceCode();

    /**
     * Returns true if a same-line trailing comment carries
     * `allow-handrolled-containment: <non-empty reason>`.
     */
    function isMarkerSuppressed(node) {
      const allComments =
        typeof sourceCode.getAllComments === 'function' ? sourceCode.getAllComments() : [];
      const line = node.loc.start.line;
      for (const comment of allComments) {
        if (comment.loc.start.line !== line) continue;
        const match = MARKER_RE.exec(comment.value);
        if (match && match[1] && match[1].trim().length > 0) {
          return true;
        }
      }
      return false;
    }

    /**
     * Right operand of `y + <right>` is a separator: either `path.sep`-shaped
     * (a non-computed MemberExpression whose property is the identifier
     * `sep`) or a single-character separator string literal.
     */
    function isSeparatorOperand(node) {
      if (!node) return false;
      if (
        node.type === 'MemberExpression' &&
        !node.computed &&
        node.property.type === 'Identifier' &&
        node.property.name === 'sep'
      ) {
        return true;
      }
      if (node.type === 'Literal' && typeof node.value === 'string') {
        return node.value === '/' || node.value === '\\';
      }
      return false;
    }

    /**
     * Resolves the callee name of a discarded-containment candidate call:
     * a bare Identifier callee, or a non-computed MemberExpression whose
     * property is an Identifier.
     */
    function calleeName(callee) {
      if (callee.type === 'Identifier') return callee.name;
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier'
      ) {
        return callee.property.name;
      }
      return null;
    }

    // A marker-suppressed occurrence is not a violation at all, so it must NOT
    // count toward keeping an allowlist entry alive — otherwise a file whose
    // every occurrence carries a marker keeps its allowlist entry forever and
    // `staleAllowlistEntry` never fires, which defeats the one-directional
    // ratchet this rule exists to be.
    //
    // Truth table:
    //   marked                              -> not counted, not reported
    //   allowlisted + real violations        -> counted (entry justified), not reported
    //   allowlisted + only marked violations -> counter 0 -> staleAllowlistEntry fires, entry removable
    //   neither                              -> counted and reported
    function reportViolation(node, messageId, data) {
      if (isMarkerSuppressed(node)) return;
      violations += 1;
      if (allowlisted) return;
      context.report({ node, messageId, data });
    }

    return {
      CallExpression(node) {
        // Arm 1: x.startsWith(y + sep)
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'startsWith' &&
          node.arguments.length === 1
        ) {
          const arg = node.arguments[0];
          if (
            arg.type === 'BinaryExpression' &&
            arg.operator === '+' &&
            isSeparatorOperand(arg.right)
          ) {
            reportViolation(node, 'handRolledContainment');
            return;
          }
        }

        // Arm 2: a discarded containment-predicate result.
        if (node.parent && node.parent.type === 'ExpressionStatement') {
          const name = calleeName(callee);
          if (name && DISCARDED_CALL_NAMES.has(name)) {
            reportViolation(node, 'discardedContainmentResult', { name });
          }
        }
      },

      'Program:exit'(node) {
        if (allowlisted && violations === 0) {
          context.report({ node, messageId: 'staleAllowlistEntry', data: { file: rel } });
        }
      },
    };
  },
};

module.exports = rule;
