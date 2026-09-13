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
 * Reporting is deferred to `Program:exit` so a marker can be matched against
 * the SPECIFIC violation it trails: among the violations that END on the
 * marker's line and before the marker starts, only the one with the LARGEST
 * end offset (i.e. the one immediately preceding the marker) is suppressed.
 * An earlier violation sharing the same line is still reported, and a marker
 * suppresses at most one violation.
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
 *
 * ## Known gaps
 *
 * This rule raises the COST of the accidental hand-rolled copy — the failure
 * mode this repo actually observed five separate times — it is not a proof
 * that every unconfined path comparison is caught. Specifically:
 *
 *   - `x.startsWith(root)` with NO separator — the genuinely unsafe variant,
 *     since it accepts a sibling like `/root-evil` — is NOT flagged. Flagging
 *     every bare `startsWith(identifier)` call in the codebase would swamp
 *     the rule with unrelated string-prefix checks, so arm 1 only fires once
 *     a separator is visibly appended. The canonical predicate
 *     (`isContainedIn` / `assertWithinRoot` / `tryWithinRoot`) is
 *     separator-aware internally, which is exactly why replacing either
 *     shape — the correct-looking `root + sep` form and the actually-unsafe
 *     bare form — with a call to it is the fix.
 *   - Other spellings of the same comparison are not recognized:
 *     `indexOf(root + path.sep) === 0` and
 *     `x.slice(root.length).startsWith(path.sep)`.
 *   - The suppression marker is anchored to the reported node's END line
 *     (`node.loc.end.line`), not its start line: a call whose closing paren
 *     lands on a later line than its first argument needs the marker after
 *     THAT (closing) line, not after the call's opening line. `end.line` was
 *     chosen over `start.line` specifically so a multi-line call CAN be
 *     suppressed — the marker just has to trail the line the call's closing
 *     paren is on, which is where a reader's eye (and a trailing `//`
 *     comment) naturally lands after a multi-line expression. There is still
 *     no "anywhere in this call" anchoring: a marker placed after the
 *     opening line of a multi-line call does not suppress it.
 *   - A separator reached through more than one level of `const` aliasing
 *     (e.g. `const s1 = path.sep; const sep = s1; x.startsWith(root + sep)`)
 *     is not resolved — only a single hop from a `+` right-operand Identifier
 *     to its unique `const` initializer is followed, and only when that
 *     initializer is itself a separator operand. `let`/reassigned/parameter
 *     bindings are deliberately left unresolved: this is targeted alias
 *     resolution for the one common shape, not general constant folding.
 *   - Four shipped installer-migration bodies —
 *     `src/installer-migrations/003-rename-get-shit-done-to-gsd-core.cts`,
 *     `004-prune-stale-pristine-snapshots.cts`,
 *     `009-pi-retire-reserved-hooks-dir.cts`, and
 *     `010-antigravity-retire-confighome-artifacts.cts` — are entirely
 *     un-ratcheted (excluded via `ignores` in `eslint.config.mjs`, listed by
 *     exact path, not a directory wildcard). Their `plan` bodies are hashed
 *     into `EXPECTED_CHECKSUMS` via `plan.toString()`
 *     (tests/installer-migrations.test.cjs, issue #670), and that hash
 *     includes comments — so neither a code fix NOR a suppression marker can
 *     land inside these four bodies without drifting the checksum and
 *     breaking upgrade state for anyone who already applied the migration.
 *     A justification-(c) marker was tried and measured to still drift the
 *     checksum, which is why (c) does not appear above: a marker cannot
 *     serve this case. The only remedy is a fix-forward migration; a NEW
 *     migration file is unaffected and still fully linted.
 */

const DISCARDED_CALL_NAMES = new Set([
  'assertWithinRoot',
  'tryWithinRoot',
  'requireSafePath',
  'assertWithinRootLexical',
  'tryWithinRootLexical',
  'isPathConfined',
  'assertDestWithinConfigHome',
  // `isContainedIn` (src/security.cts) is a boolean predicate: calling it as a
  // bare statement and discarding the boolean is a pure no-op — arm 2's
  // failure mode, on the one function the whole consolidation funnels through.
  'isContainedIn',
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
     * Returns the list of valid suppression-marker comments in the file: a
     * Line comment carrying `allow-handrolled-containment: <non-empty
     * reason>`. A BLOCK comment never qualifies — the convention is a
     * trailing `//` marker, and accepting `/* *\/` would let an unrelated
     * block comment silently suppress too.
     */
    function findMarkerComments() {
      const allComments =
        typeof sourceCode.getAllComments === 'function' ? sourceCode.getAllComments() : [];
      const markers = [];
      for (const comment of allComments) {
        if (comment.type !== 'Line') continue;
        const match = MARKER_RE.exec(comment.value);
        if (match && match[1] && match[1].trim().length > 0) {
          markers.push(comment);
        }
      }
      return markers;
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
     * A template-literal argument ends with a separator: either the trailing
     * quasi text itself ends with `/` or `\` (`` `${root}/` ``), or the
     * trailing quasi is empty and the LAST expression is a separator operand
     * (`` `${root}${path.sep}` ``). Only the tail matters — a separator
     * embedded mid-template followed by further literal text is not a
     * containment-prefix shape.
     */
    function isSeparatorEndingTemplate(node) {
      if (!node || node.type !== 'TemplateLiteral') return false;
      const quasis = node.quasis;
      if (!quasis || quasis.length === 0) return false;
      const lastQuasi = quasis[quasis.length - 1];
      const tail =
        lastQuasi.value.cooked !== null && lastQuasi.value.cooked !== undefined
          ? lastQuasi.value.cooked
          : lastQuasi.value.raw;
      if (tail && (tail.endsWith('/') || tail.endsWith('\\'))) {
        return true;
      }
      if (tail === '' && node.expressions.length > 0) {
        const lastExpr = node.expressions[node.expressions.length - 1];
        return isSeparatorOperand(lastExpr);
      }
      return false;
    }

    /**
     * Resolves a `+` right-operand Identifier to a separator via a single
     * `const` alias hop: `const sep = path.sep; x.startsWith(root + sep)`.
     * Uses scope analysis to find the unique binding for the identifier and
     * checks whether ITS initializer is a separator operand. Deliberately
     * narrow: only a `const` declarator with exactly one definition is
     * resolved, and only one hop is followed — this is not general constant
     * folding, and `let`/reassigned/parameter bindings are left unresolved.
     */
    function resolveSeparatorAlias(identifierNode) {
      const scope = sourceCode.getScope(identifierNode);
      const ref = scope.references.find((r) => r.identifier === identifierNode);
      if (!ref || !ref.resolved) return false;
      const variable = ref.resolved;
      if (variable.defs.length !== 1) return false;
      const def = variable.defs[0];
      if (def.type !== 'Variable') return false;
      if (!def.parent || def.parent.kind !== 'const') return false;
      const declarator = def.node;
      if (!declarator || !declarator.init) return false;
      return isSeparatorOperand(declarator.init);
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

    // Violations are not reported (or counted) during traversal. Each
    // would-be violation is deferred so that, once every node in the file has
    // been visited, a trailing marker can be matched against the SPECIFIC
    // violation it trails rather than every violation that happens to share
    // its line. See `Program:exit` for the resolution pass.
    //
    // Truth table (after resolution):
    //   marked                              -> not counted, not reported
    //   allowlisted + real violations        -> counted (entry justified), not reported
    //   allowlisted + only marked violations -> counter 0 -> staleAllowlistEntry fires, entry removable
    //   neither                              -> counted and reported
    const pending = [];
    function reportViolation(node, messageId, data) {
      pending.push({ node, messageId, data });
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
            (isSeparatorOperand(arg.right) ||
              (arg.right.type === 'Identifier' && resolveSeparatorAlias(arg.right)))
          ) {
            reportViolation(node, 'handRolledContainment');
            return;
          }
          if (isSeparatorEndingTemplate(arg)) {
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
        // Resolve marker suppression: for each valid marker comment, find
        // among the still-unresolved pending violations the one whose node
        // ends on the marker's line and before the marker starts, preferring
        // the LARGEST such end offset — i.e. the violation the marker
        // visibly trails most closely. A marker suppresses at most one
        // violation; a violation is suppressed by at most one marker.
        const markers = findMarkerComments();
        const suppressed = new Set();
        for (const comment of markers) {
          let best = null;
          for (const entry of pending) {
            if (suppressed.has(entry)) continue;
            if (entry.node.loc.end.line !== comment.loc.start.line) continue;
            if (entry.node.range[1] > comment.range[0]) continue;
            if (!best || entry.node.range[1] > best.node.range[1]) {
              best = entry;
            }
          }
          if (best) suppressed.add(best);
        }

        for (const entry of pending) {
          if (suppressed.has(entry)) continue;
          violations += 1;
          if (allowlisted) continue;
          context.report({ node: entry.node, messageId: entry.messageId, data: entry.data });
        }

        if (allowlisted && violations === 0) {
          context.report({ node, messageId: 'staleAllowlistEntry', data: { file: rel } });
        }
      },
    };
  },
};

module.exports = rule;
