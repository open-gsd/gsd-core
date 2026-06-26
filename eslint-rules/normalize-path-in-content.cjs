'use strict';

/**
 * normalize-path-in-content
 *
 * Flag: a path-returning function result (PATH_RETURNING_FNS call, or a
 * variable that scope-resolves to one) interpolated into a template literal
 * (`${ … }`) or string concatenation that is CONTENT — heuristic: the
 * template/string also contains a genuine reference marker (see shapes below)
 * WITHOUT the path flowing through a POSIX normalizer
 * (isPosixNormalizerCall: `.replace(/\\/g,'/')`, `toPosixPath`, etc.).
 *
 * The canonical defect is computePathPrefix returning `${resolvedTarget}/`
 * verbatim on Windows (PR #1622) — backslashes leaked into `@~/.claude/...`
 * markdown content, breaking cross-platform substring checks and producing
 * malformed @-references in Windsurf workflow files.
 *
 * References:
 *   DEFECT.WINDOWS-PATH-LEAK-IN-MARKDOWN-CONTENT (CONTEXT.md)
 *   RULESET.CONTENT-PATH-NORMALIZATION (CONTEXT.md)
 *
 * Message:
 *   Cite RULESET.CONTENT-PATH-NORMALIZATION: normalize at source
 *   `String(<path>).replace(/\\/g,'/')` before interpolating into content.
 *
 * ── Known boundaries ────────────────────────────────────────────────────────
 *
 * (a) Name-based matching only. `path`, `os`, and the project resolver names in
 *     PATH_RETURNING_FNS are recognized by spelling. A local variable that
 *     shadows one of these names is out of scope.
 *
 * (b) Shallow expression inspection. Only the direct expression inside `${ }`
 *     (or a concatenation operand) is checked, plus one level of String() cast.
 *     Deeper wrapping (e.g. `.toLowerCase()` after a path call) is not detected
 *     as a path-returning expression and will not trigger the rule.
 *
 * (c) Content heuristic — two shapes are recognized:
 *
 *     Shape (a) — quasis contain an @-reference or home-dir prefix marker:
 *       `@~/`, `@$`, `@/`, `$HOME`, `~/` anywhere in the template's static
 *       parts.  A bare `@` that is NOT immediately followed by `~`, `$`, or `/`
 *       (e.g. an email address or attribution line) does NOT qualify.
 *
 *     Shape (b) — per-expression: quasis[i+1].raw starts with a forward slash
 *       and contains `.md` or `.json` at the end of a path component.  This
 *       catches `${computePathPrefix(t)}/commands/gsd/x.md` and
 *       `@${getGlobalConfigDir()}/agents/foo.md` without requiring config-dir
 *       markers in CONTENT_MARKERS.
 *
 *     Config-dir substrings (e.g. `/.claude`, `/commands`, `/skills`, etc.)
 *     are NOT content markers — they appeared in log/error/diagnostic strings
 *     too often and generated false positives.  Shape (b) covers the genuine
 *     content-emit cases without those FPs.
 *
 *     Bare `.md`/`.json` tokens in plain prose (e.g. "see PROJECT.md") do NOT
 *     qualify — they carry no separator-bearing path context that could be
 *     tainted by backslashes.  Pure log messages, filesystem paths passed to
 *     fs.* functions, and Error messages that lack these markers are NOT flagged.
 *
 * (d) Suppression by call context. A path expression inside a `fs.*` call
 *     argument (readFileSync, writeFileSync, join, resolve, etc.), a
 *     `console.*` call, `new Error(...)`, a bare `Error(...)` / `TypeError(...)`
 *     / `RangeError(...)` etc. (any CallExpression whose callee is an Identifier
 *     whose name ends in `Error`), or a `require(...)` is not flagged — these
 *     are real FS paths or diagnostics, not content.
 *
 * (e) Indirect data-flow is NOT tracked. If a path-returning call result is
 *     stored in a variable or object field and that variable is later
 *     interpolated into a content template (e.g. `${globalSkillDir}/SKILL.md`
 *     → `@${entry.ref}` as in src/init.cts), the rule DOES NOT detect the
 *     violation — it only flags direct path-returning call expressions inside
 *     `${ }`.  Indirect content-path-leaks rely on
 *     RULESET.CONTENT-PATH-NORMALIZATION discipline (normalize at source) and
 *     code review.  The one known indirect leak (src/init.cts cmdAgentSkills
 *     `entry.ref` building) is fixed by normalizing at the content-emit site.
 *
 * (f) path.basename is excluded from PATH_RETURNING_FNS for this rule.
 *     path.basename() returns only the final filename component — it cannot
 *     contain directory separators, so it is safe to interpolate into content
 *     without normalization. Only calls that produce separator-bearing paths
 *     (path.join, path.resolve, path.dirname, path.relative, path.normalize,
 *     os.homedir, os.tmpdir, and the project resolver functions) are flagged.
 */

const {
  PATH_RETURNING_FNS,
  isPosixNormalizerCall,
  unwrapString,
} = require('./lib/portability-vocab.cjs');

// ── Rule-local path-fn set: PATH_RETURNING_FNS minus path.basename ─────────
//
// path.basename() returns a filename with no directory separators, so it
// cannot leak backslashes into content. All other entries in PATH_RETURNING_FNS
// DO produce separator-bearing paths and ARE checked by this rule.
//
// Note: toPosixPath remains in this set intentionally (it IS a path-returning
// function), but isContentPathReturningCall is never reached for a toPosixPath
// call because isPosixNormalizerCall short-circuits first in isUnnormalizedPathExpression.
const CONTENT_PATH_FNS = new Set(PATH_RETURNING_FNS.filter(fn => fn !== 'path.basename'));

/**
 * Returns true when `node` (a CallExpression) is a call to one of the
 * CONTENT_PATH_FNS entries (PATH_RETURNING_FNS minus path.basename).
 *
 * @param {import('eslint').Rule.Node} node
 * @returns {boolean}
 */
function isContentPathReturningCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const callee = node.callee;

  // Dotted call: path.join, os.homedir, etc.
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.property.type === 'Identifier'
  ) {
    const dotted = `${callee.object.name}.${callee.property.name}`;
    if (CONTENT_PATH_FNS.has(dotted)) return true;
  }

  // Bare call: getGlobalConfigDir(), resolveKimiGlobalDir(), etc.
  if (callee.type === 'Identifier') {
    if (CONTENT_PATH_FNS.has(callee.name)) return true;
  }

  return false;
}

// ── Content-heuristic markers ──────────────────────────────────────────────
//
// A template/string is considered "content" (markdown @-references, workflow
// bodies, generated documentation) when its STATIC parts (quasis) contain at
// least one genuine reference marker.  Two shapes are recognized:
//
//   Shape (a) — explicit @-reference / home-dir prefix in quasis:
//     '@~'    → @~/.claude/ reference (home-dir @-reference form)
//     '@$'    → @${prefix}/commands/... reference (interpolated @-reference)
//     '@/'    → @/path/... reference (root-relative @-reference form)
//     '$HOME' → $HOME/.cursor/... in generated workflow content
//     '~/'    → ~/. shorthand for home-dir references in content
//
//     NOTE: bare '@' is deliberately excluded — it is too broad and would
//     match email addresses and attribution lines (@author), causing false
//     positives. Only the genuine @-reference shapes (@~, @$, @/) are matched.
//
//   Shape (b) — path-returning interpolation immediately before a .md/.json
//     file reference (per-expression quasi check, not template-wide):
//     quasis[i+1].raw matches /^\/[^\s`]*\.(md|json)(\b|$|\/)/ — the text
//     immediately following expression `i` starts with `/...path.md` or
//     `/...path.json`, indicating the expression is a path prefix for a
//     content file reference.  This catches `${computePathPrefix(t)}/commands/
//     gsd/x.md` and `@${getGlobalConfigDir('claude')}/commands/gsd/help.md`
//     without requiring config-dir markers in CONTENT_MARKERS.
//
// Deliberately excluded from CONTENT_MARKERS (were Tier 2 / Tier 3):
//   Config-dir substrings (`/.claude`, `/.cursor`, `/.gemini`, `/.config`,
//   etc.) and artifact-path segments (`/commands`, `/agents`, `/skills`,
//   `/workflows`, `/rules`, `/gsd`) — these are too broad as standalone
//   markers and generate false positives when interpolated into log/error/
//   diagnostic strings that mention config-dir paths.  Shape (b) above covers
//   the genuine content-emit cases without the FP risk.
//
//   '@'    — too broad; matches email addresses and @author attributions.
//             Only the genuine @-reference prefixes (@~, @$, @/) are kept.
//   '.md'  — too broad; appears in plain prose ("see PROJECT.md") with no
//             separator-bearing path context.
//   '.json' — same rationale as '.md'.
const CONTENT_MARKERS = [
  // Shape (a) — @-reference / home-dir prefix markers
  '@~',          // @~/.claude/ home-dir @-reference form
  '@$',          // @${prefix}/... interpolated @-reference form
  '@/',          // @/path/... root-relative @-reference form
  '$HOME',       // $HOME/.cursor/ path prefix in content
  '~/',          // ~/. shorthand in content
];

// ── Shape (b): per-expression quasi marker ───────────────────────────────────
//
// Applied per-expression in TemplateLiteral: quasis[i+1].raw must start with
// a forward slash and contain `.md` or `.json` before the next whitespace or
// end of the quasi string.  This matches `/commands/gsd/x.md`,
// `/skills/foo/SKILL.md`, `/help.json`, etc. without requiring a config-dir
// marker in CONTENT_MARKERS.
//
// The check is: /^\/[^\s`]*\.(md|json)(\b|\/|$)/ against the raw quasi text.
// The `\b` / `\/` / end-of-string ensures the extension is a terminal component
// (not a `.md` substring in the middle of a word).
const QUASI_MD_JSON_RE = /^\/[^\s`]*\.(md|json)(\b|\/|$)/;

// ── FS-call suppression: callee names that indicate a real filesystem path ─
const FS_OBJECT_NAMES = new Set(['fs', 'path', 'os']);
const FS_METHOD_NAMES = new Set([
  'readFileSync', 'writeFileSync', 'existsSync', 'statSync',
  'mkdirSync', 'mkdtempSync', 'readdirSync', 'unlinkSync',
  'copyFileSync', 'renameSync', 'lstatSync', 'accessSync',
  'readFile', 'writeFile', 'mkdir', 'mkdtemp', 'stat', 'access',
  'cpSync', 'rmSync', 'openSync', 'fstatSync', 'realpathSync',
  'join', 'resolve', 'dirname', 'basename', 'relative', 'normalize',
  'homedir', 'tmpdir',
]);
const FS_BARE_NAMES = new Set(['require']);
const LOG_OBJECT_NAMES = new Set(['console']);
const LOG_METHOD_NAMES = new Set(['log', 'warn', 'error', 'info', 'debug', 'trace']);

/**
 * Returns true if any quasis in the TemplateLiteral contains a content marker.
 */
function isContentTemplate(templateLiteralNode) {
  const quasis = templateLiteralNode.quasis || [];
  for (const quasi of quasis) {
    const raw = quasi.value?.raw ?? quasi.value?.cooked ?? '';
    for (const marker of CONTENT_MARKERS) {
      if (raw.includes(marker)) return true;
    }
  }
  return false;
}

/**
 * Returns true if `node` (a CallExpression) is a context where template
 * literals are real FS paths or diagnostic messages — NOT content.
 *
 * Checks:
 *  - fs.method(templateLiteral, ...)
 *  - path.method(templateLiteral, ...)
 *  - console.method(...)
 *  - new Error(...)
 *  - require(...)
 */
function isInSuppressedCallContext(expressionNode) {
  const parent = expressionNode.parent;
  if (!parent) return false;

  // Direct argument to a call expression
  if (parent.type === 'CallExpression') {
    const callee = parent.callee;

    // fs.*, path.*, os.* calls → FS paths
    if (
      callee.type === 'MemberExpression' &&
      !callee.computed &&
      callee.object.type === 'Identifier' &&
      callee.property.type === 'Identifier' &&
      FS_OBJECT_NAMES.has(callee.object.name) &&
      FS_METHOD_NAMES.has(callee.property.name)
    ) {
      return true;
    }

    // console.log/warn/error → diagnostic
    if (
      callee.type === 'MemberExpression' &&
      !callee.computed &&
      callee.object.type === 'Identifier' &&
      callee.property.type === 'Identifier' &&
      LOG_OBJECT_NAMES.has(callee.object.name) &&
      LOG_METHOD_NAMES.has(callee.property.name)
    ) {
      return true;
    }

    // require(...) → not content
    if (callee.type === 'Identifier' && FS_BARE_NAMES.has(callee.name)) {
      return true;
    }

    // W2: bare Error(...) / TypeError(...) / RangeError(...) etc. → diagnostic.
    // Handles the call-expression form (as opposed to `new Error(...)` which is
    // a NewExpression).  Any Identifier callee whose name ends in 'Error' is
    // treated as a diagnostic constructor, not content production.
    if (callee.type === 'Identifier' && callee.name.endsWith('Error')) {
      return true;
    }
  }

  // new Error(...) → diagnostic
  if (parent.type === 'NewExpression') {
    const callee = parent.callee;
    if (callee.type === 'Identifier' && callee.name.endsWith('Error')) {
      return true;
    }
  }

  // throw statement containing the template → diagnostic
  if (parent.type === 'ThrowStatement') {
    return true;
  }

  return false;
}

/**
 * Returns true if `expressionNode` (the expression inside `${ }`) is a
 * content-path-returning call (PATH_RETURNING_FNS minus path.basename) that
 * is NOT POSIX-normalized.
 *
 * Checks:
 *  1. If it is a POSIX normalizer call → NOT a violation.
 *  2. Unwrap String() cast → check if inner is a content path call.
 *  3. Direct content path-returning call.
 *
 * Returns false if the expression has been POSIX-normalized.
 */
function isUnnormalizedPathExpression(exprNode) {
  if (!exprNode) return false;

  // If it's already POSIX-normalized → not a violation
  if (isPosixNormalizerCall(exprNode)) return false;

  // Unwrap String() cast
  const inner = unwrapString(exprNode);

  // If the unwrapped inner is POSIX-normalized → not a violation
  if (isPosixNormalizerCall(inner)) return false;

  // Direct content path-returning call (possibly wrapped in String())
  // Note: path.basename is excluded from CONTENT_PATH_FNS — it returns a
  // filename with no directory separators, so it cannot leak backslashes.
  if (isContentPathReturningCall(inner)) return true;

  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow path-returning calls interpolated into content (markdown/workflow) template ' +
        'literals without POSIX normalization (DEFECT.WINDOWS-PATH-LEAK-IN-MARKDOWN-CONTENT)',
      category: 'Portability',
    },
    schema: [],
    messages: {
      pathInContent:
        'Path-returning call interpolated into content template literal without POSIX normalization ' +
        '(RULESET.CONTENT-PATH-NORMALIZATION). ' +
        "Normalize at source: String(<path>).replace(/\\\\\\\\/g, '/') before interpolating into content. " +
        'See DEFECT.WINDOWS-PATH-LEAK-IN-MARKDOWN-CONTENT in CONTEXT.md.',
    },
  },

  create(context) {
    return {
      /**
       * Check TemplateLiteral expressions: `...${<expr>}...`
       *
       * For each expression inside the template, if:
       *   1. The template contains a content marker in its static parts
       *   2. The expression is a path-returning call without POSIX normalization
       *   3. The template is NOT in a suppressed call context (fs.*, console.*, Error)
       * → report a violation.
       */
      TemplateLiteral(node) {
        // Check if the entire template is in a suppressed context
        if (isInSuppressedCallContext(node)) return;

        const quasis = node.quasis || [];
        const exprs = node.expressions || [];

        // Shape (a): any quasi contains a CONTENT_MARKERS marker → check all
        // expressions in this template for unnormalized path calls.
        if (isContentTemplate(node)) {
          for (const expr of exprs) {
            if (isUnnormalizedPathExpression(expr)) {
              context.report({ node: expr, messageId: 'pathInContent' });
            }
          }
          return;
        }

        // Shape (b): per-expression quasi check.  For expression at index i,
        // quasis[i+1].raw starts with a forward slash followed by a path that
        // terminates in .md or .json — the expression is a path prefix being
        // interpolated directly before a content file reference.  This catches
        // `${computePathPrefix(t)}/commands/gsd/x.md` and
        // `@${getGlobalConfigDir('claude')}/commands/gsd/help.md` without
        // requiring config-dir markers in CONTENT_MARKERS.
        for (let i = 0; i < exprs.length; i++) {
          const nextQuasi = quasis[i + 1];
          if (!nextQuasi) continue;
          const raw = nextQuasi.value?.raw ?? nextQuasi.value?.cooked ?? '';
          if (QUASI_MD_JSON_RE.test(raw) && isUnnormalizedPathExpression(exprs[i])) {
            context.report({ node: exprs[i], messageId: 'pathInContent' });
          }
        }
      },

      /**
       * Check BinaryExpression string concatenation: <path> + "/foo.md"
       *
       * For `left + right` or `right + left` where one side is a string
       * literal containing a content marker and the other is a path-returning
       * call without POSIX normalization.
       *
       * W3 (right-deep FN): when a content marker is present anywhere in the
       * concat tree, search the ENTIRE tree recursively for any unnormalized
       * path-returning call — not just the immediate sibling.  This catches
       *   '@~/' + (name + path.join(home, '.claude'))
       * where the path call is nested inside a right-side BinaryExpression.
       */
      BinaryExpression(node) {
        if (node.operator !== '+') return;

        const { left, right } = node;

        // isContentString: recursively check if a node (or its concat
        // sub-tree) contains a Literal/TemplateLiteral quasi with a
        // content marker.  Descends into nested BinaryExpression `+` chains.
        function isContentString(n) {
          if (!n) return false;
          // Plain string literal
          if (n.type === 'Literal' && typeof n.value === 'string') {
            return CONTENT_MARKERS.some((m) => n.value.includes(m));
          }
          // TemplateLiteral — check quasis (static parts)
          if (n.type === 'TemplateLiteral') {
            for (const quasi of (n.quasis || [])) {
              const raw = quasi.value?.raw ?? quasi.value?.cooked ?? '';
              if (CONTENT_MARKERS.some((m) => raw.includes(m))) return true;
            }
          }
          // Descend into nested + concatenations
          if (n.type === 'BinaryExpression' && n.operator === '+') {
            return isContentString(n.left) || isContentString(n.right);
          }
          return false;
        }

        const treeHasContent = isContentString(left) || isContentString(right);

        // Suppress if the whole concatenation is in a suppressed context
        if (isInSuppressedCallContext(node)) return;

        if (!treeHasContent) return;

        // Only report at the TOP-LEVEL BinaryExpression for this concat chain
        // (i.e. when the parent is NOT also a `+` BinaryExpression) to avoid
        // duplicate reports on every node of a chained concatenation.
        const parentNode = node.parent;
        if (
          parentNode &&
          parentNode.type === 'BinaryExpression' &&
          parentNode.operator === '+'
        ) {
          return;
        }

        // Recursively scan the full concat tree for unnormalized path calls
        // and report each one found.
        function scanAndReport(n) {
          if (!n) return;
          if (n.type === 'BinaryExpression' && n.operator === '+') {
            // Check left
            if (isUnnormalizedPathExpression(n.left)) {
              context.report({ node: n.left, messageId: 'pathInContent' });
            } else {
              scanAndReport(n.left);
            }
            // Check right
            if (isUnnormalizedPathExpression(n.right)) {
              context.report({ node: n.right, messageId: 'pathInContent' });
            } else {
              scanAndReport(n.right);
            }
          }
        }

        scanAndReport(node);
      },
    };
  },
};

module.exports = rule;
