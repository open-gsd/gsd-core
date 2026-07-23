'use strict';

/**
 * normalize-path-in-content.rule.test.cjs
 *
 * RuleTester unit tests for the local/normalize-path-in-content ESLint rule.
 *
 * Rule: flag a path-returning fn result (PATH_RETURNING_FNS minus path.basename)
 * interpolated into a content template literal (`${ … }`) without POSIX
 * normalization.  "Content" is identified by two shapes:
 *
 *   Shape (a) — quasis contain an @-reference or home-dir prefix marker:
 *     `@~/`, `@$`, `@/`, `$HOME`, `~/` in the template's static parts.
 *     A bare `@` not followed by `~`, `$`, or `/` is NOT a marker.
 *
 *   Shape (b) — per-expression quasi check: quasis[i+1].raw starts with `/`
 *     and contains `.md` or `.json` at the end of a path component.  Catches
 *     `${computePathPrefix(t)}/commands/gsd/x.md` without config-dir markers.
 *
 * Config-dir substrings (`/.claude`, `/commands`, `/skills`, etc.) are NOT
 * content markers — removed to eliminate diagnostic/log FPs.
 *
 * DEFECT category: DEFECT.WINDOWS-PATH-LEAK-IN-MARKDOWN-CONTENT
 * RULESET: RULESET.CONTENT-PATH-NORMALIZATION
 *
 * INVALID (violation expected):
 *  - path.join(home, '.claude') interpolated into a template containing @~/
 *  - computePathPrefix(...) interpolated into a template with /commands/gsd/x.md
 *    (shape b: quasi immediately after starts with /…\.md)
 *  - getGlobalConfigDir() in @${fn()}/commands/gsd/help.md (shape b)
 *
 * VALID (no violation):
 *  - path.basename(p) in any content template — basename cannot contain separators (N1).
 *  - Path normalized via .replace(/\\/g, '/') before interpolation
 *  - Path normalized via String(...).replace(...) before interpolation
 *  - Path in console.log() — log message, not content
 *  - Path in fs.writeFileSync() first arg — real FS path, not content
 *  - Path in new Error() — diagnostic, not content
 *  - throw Error(...) — bare Error() call is a diagnostic, not content (W2)
 *  - Template literal with NO content markers — e.g. just a log string
 *  - path.basename(outputPath) in a status message with bare .md prose — N2
 *  - Template with a bare `@` that is not an @-reference (@-narrowing precision)
 *  - path.resolve(configDir) in `${fn()}/.claude/x` — no .md/.json and no
 *    @-ref markers → not flagged (narrowed from Tier 2 / config-dir markers)
 *  - os.homedir() in `${fn()}/.claude/gsd-core/commands` — same: no .md/.json
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { RuleTester } = require('eslint');

const normalizePathInContent = require('../eslint-rules/normalize-path-in-content.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

// ─── module shape ─────────────────────────────────────────────────────────────

describe('normalize-path-in-content rule module', () => {
  test('exports meta and create', () => {
    assert.strictEqual(typeof normalizePathInContent.meta, 'object');
    assert.strictEqual(typeof normalizePathInContent.create, 'function');
    assert.strictEqual(normalizePathInContent.meta.type, 'problem');
    assert.ok(normalizePathInContent.meta.messages.pathInContent);
  });
});

// ─── INVALID cases (violation expected) ───────────────────────────────────────

describe('normalize-path-in-content invalid cases', () => {
  test('invalid: path.join(home, ".claude") in @~/ home-dir reference template', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [],
      invalid: [
        {
          // Canonical defect shape: path.join result into a markdown @~/ reference
          // without normalization. On Windows, path.join emits backslashes.
          // The '@~/' quasi prefix is the genuine @-reference marker (not bare '@').
          code: "const ref = `@~/${path.join(home, '.claude')}/x.md`;",
          errors: [{ messageId: 'pathInContent' }],
        },
      ],
    });
  });

  test('invalid: computePathPrefix result in content template containing .md reference', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [],
      invalid: [
        {
          // computePathPrefix is a PATH_RETURNING_FNS entry; its result used
          // directly in a template with a .md path reference is flagged.
          code: `const body = \`\${computePathPrefix(t)}/commands/gsd/x.md\`;`,
          errors: [{ messageId: 'pathInContent' }],
        },
      ],
    });
  });

  test('valid (narrowed): path.resolve(configDir) in template with /.claude/x — no .md/.json after expr and no @-ref marker → NOT flagged after Tier 2 marker removal', () => {
    // /.claude was a Tier 2 marker but was removed to eliminate diagnostic FPs.
    // Shape (b) requires the quasi immediately after the expression to start with
    // /…\.md or /…\.json — /.claude/x does NOT end in .md/.json so this is now VALID.
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          code: `const prefix = \`\${path.resolve(configDir)}/.claude/x\`;`,
        },
      ],
      invalid: [],
    });
  });

  test('invalid: getGlobalConfigDir("claude") in @${fn()}/commands/gsd/help.md — shape (b) fires: quasi after expr starts with /commands/gsd/help.md', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [],
      invalid: [
        {
          // Shape (b): quasi[1] = '/commands/gsd/help.md' starts with '/' and ends with '.md'
          // → QUASI_MD_JSON_RE matches → path call is flagged regardless of config-dir markers.
          // Note: bare '@' in quasi[0] is NOT a content marker (only @~, @$, @/ are);
          // this case is detected by shape (b) alone.
          code: `const ref = \`@\${getGlobalConfigDir('claude')}/commands/gsd/help.md\`;`,
          errors: [{ messageId: 'pathInContent' }],
        },
      ],
    });
  });

  test('valid (narrowed): os.homedir() in template /.claude/gsd-core/commands — no .md/.json and no @-ref → NOT flagged after Tier 2 marker removal', () => {
    // /.claude was a Tier 2 marker but was removed to eliminate diagnostic FPs.
    // Shape (b) requires /…\.md or /…\.json immediately after the expression.
    // /.claude/gsd-core/commands has no .md/.json → VALID.
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          code: `const body = \`\${os.homedir()}/.claude/gsd-core/commands\`;`,
        },
      ],
      invalid: [],
    });
  });

  test('invalid: String() wrapping without normalization is still flagged', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [],
      invalid: [
        {
          // String() alone is not a POSIX normalizer — the replace() is still needed.
          // Uses @~/ marker so the content heuristic fires (bare '@' is no longer a marker).
          code: "const ref = `@~/${String(path.join(home, '.claude'))}/x.md`;",
          errors: [{ messageId: 'pathInContent' }],
        },
      ],
    });
  });
});

// ─── VALID cases (no violation) ───────────────────────────────────────────────

describe('normalize-path-in-content valid cases', () => {
  test('valid: path normalized with .replace(/\\\\/g, "/") before interpolation', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          // Correct POSIX normalization via .replace before interpolation into @~/ reference.
          // Uses '@~/' marker so the content heuristic fires, then confirms no violation.
          code: "const ref = `@~/${String(path.join(home, '.claude')).replace(/\\\\/g, '/')}/x.md`;",
        },
      ],
      invalid: [],
    });
  });

  test('valid: toPosixPath() wrapper before interpolation', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          code: `const body = \`\${toPosixPath(path.resolve(configDir))}/commands/gsd/x.md\`;`,
        },
      ],
      invalid: [],
    });
  });

  test('valid: console.log with path — log line, not content (no content markers = no flag)', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          // Log line: no @, $HOME, .md, /gsd etc. in the template quasis
          code: `console.log(\`built \${path.join(a, b)}\`);`,
        },
      ],
      invalid: [],
    });
  });

  test('valid: fs.writeFileSync with path join as first arg — real FS path, not content', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          // The ENTIRE template is an arg to fs.writeFileSync → suppressed
          // as a real filesystem path argument, not markdown content
          code: `fs.writeFileSync(\`\${path.join(a, b)}/foo\`, data);`,
        },
      ],
      invalid: [],
    });
  });

  test('valid: new Error with path — diagnostic, not content', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          // Diagnostic / error message: not markdown content
          code: `throw new Error(\`File not found: \${path.join(dir, file)}\`);`,
        },
      ],
      invalid: [],
    });
  });

  test('valid: template literal with no content markers does not flag path', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          // No @, $HOME, ~/., .md, /gsd, etc. → not considered content
          code: `const msg = \`Processing \${path.join(a, b)} now\`;`,
        },
      ],
      invalid: [],
    });
  });

  test('valid: String() + .replace() chain normalized before interpolation', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          // The real fix used in runtime-artifact-conversion.cts line 2193
          code: `const posixTarget = String(resolvedTarget).replace(/\\\\/g, '/');
const ref = \`@\${posixTarget}/.claude/x.md\`;`,
        },
      ],
      invalid: [],
    });
  });

  test('valid: resolveAgentDir result already POSIX-normalized via toPosixPath', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          code: `const body = \`@\${toPosixPath(resolveAgentDir('opencode', { homedir: () => home }))}/agents/gsd.md\`;`,
        },
      ],
      invalid: [],
    });
  });

  test('valid: path used in require() — module load, not content', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          // require() is a suppressed context
          code: `const m = require(\`\${path.join(libDir, 'helpers')}\`);`,
        },
      ],
      invalid: [],
    });
  });

  // ── N1: path.basename exclusion ─────────────────────────────────────────────
  //
  // path.basename() returns only the final filename component (no directory
  // separators), so it cannot leak backslashes into content regardless of OS.
  // It is excluded from CONTENT_PATH_FNS for this rule.

  test('valid (N1): path.basename(p) in a template with @~/ reference marker — no flag because basename cannot contain separators', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          // path.basename returns a filename with no directory separators;
          // interpolating it into @~/ reference content is safe on all platforms.
          // Uses '@~/' marker so the content heuristic fires, then confirms no
          // violation because path.basename is excluded from CONTENT_PATH_FNS.
          code: "const label = `@~/${path.basename(outputPath)}/x.md`;",
        },
      ],
      invalid: [],
    });
  });

  test('valid (N1): path.basename(p) in a template with /commands/ marker — not flagged', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          code: `const ref = \`/commands/\${path.basename(outputPath)}/help.md\`;`,
        },
      ],
      invalid: [],
    });
  });

  // ── N2: tightened content heuristic ─────────────────────────────────────────
  //
  // A bare `.md` token in plain prose (no @-ref, ~/., $HOME, config-dir, or
  // artifact-path segment) must NOT qualify as "content".  This test mirrors
  // the false-positive from src/profile-output.cts:1205.

  test('valid (N2): path.basename(outputPath) in a status-message template with bare .md prose — not flagged', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          // Mirrors the src/profile-output.cts:1205 false positive.  The template
          // contains "PROJECT.md / REQUIREMENTS.md" (bare prose), but the quasi
          // after the expression does NOT start with '/' → shape (b) does not fire.
          // And no @-ref / $HOME / ~/ markers → shape (a) does not fire.
          code: `const msg = \`Left existing \${path.basename(outputPath)} untouched (no GSD markers found). Broad project context lives in PROJECT.md / REQUIREMENTS.md; pass --force to overwrite.\`;`,
        },
      ],
      invalid: [],
    });
  });

  test('valid (N2): path.join result in prose with bare .md mention — quasi after expr does not start with / → not flagged', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          // path.join IS in CONTENT_PATH_FNS, but the quasi after the expression is
          // ': see README.md for details.' which does NOT start with '/' → shape (b)
          // does not fire.  No @-ref / $HOME / ~/ markers either.
          code: `const note = \`Generated \${path.join(dir, 'output')}: see README.md for details.\`;`,
        },
      ],
      invalid: [],
    });
  });

  // ── N4: canonical INVALID shapes still flag after N1/N2 changes ─────────────

  test('invalid (N4 confirm): @~/${path.join(home,".claude")}/x.md — still flagged after N1/N2/@-narrowing', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [],
      invalid: [
        {
          // @~/ prefix marker in quasis → genuine @-reference content → path.join flagged.
          // Confirms that narrowing '@' to '@~'/'@$'/'@/' leaves the canonical case working.
          code: "const ref = `@~/${path.join(home, '.claude')}/x.md`;",
          errors: [{ messageId: 'pathInContent' }],
        },
      ],
    });
  });

  test('invalid (N4 confirm): ${computePathPrefix(t)}/commands/gsd/x.md — still flagged after N1/N2 via shape (b)', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [],
      invalid: [
        {
          // Shape (b): quasi[1] = '/commands/gsd/x.md' starts with '/' and ends with '.md'
          // → QUASI_MD_JSON_RE matches → flagged.  (/commands/ is no longer in CONTENT_MARKERS
          // but shape (b) per-expression check catches this case.)
          code: `const body = \`\${computePathPrefix(t)}/commands/gsd/x.md\`;`,
          errors: [{ messageId: 'pathInContent' }],
        },
      ],
    });
  });

  // ── W2: bare Error(...) / TypeError(...) suppression ─────────────────────────
  //
  // A bare Error(...)  call (CallExpression, not NewExpression) with a path inside
  // must be suppressed — it is a diagnostic, not content.

  test('valid (W2): throw Error(`...${path.join(...)}`) — Error() is diagnostic; also /.claude is no longer a content marker', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          // W2: bare Error() call (CallExpression).  Additionally, /.claude is no
          // longer in CONTENT_MARKERS (removed to eliminate diagnostic FPs), so this
          // template has no content markers at all — not flagged on either ground.
          code: "throw Error(`Cannot install to /.claude: ${path.join(a, b)}`);",
        },
      ],
      invalid: [],
    });
  });

  test('valid (W2): throw TypeError(`...${path.join(...)}`) — TypeError() is suppressed; also no content markers', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          // W2: /.claude no longer a content marker; also in an Error() call context.
          code: "throw TypeError(`Bad path /.claude: ${path.join(a, b)}`);",
        },
      ],
      invalid: [],
    });
  });

  // ── W3: chained and right-deep concatenation with nested BinaryExpression ──────
  //
  // The BinaryExpression check recursively scans the FULL concat tree for both:
  //   (1) a content marker anywhere in the tree (via isContentString recursion)
  //   (2) an unnormalized path call anywhere in the non-content subtree
  //       (via scanAndReport recursion — the "right-deep FN" fix)
  //
  // Cases:
  //   '@~/' + name + path.join(home, '.claude')
  //     → parse tree: ('@~/' + name) + path.join(...)
  //     → outer left is BinaryExpression → isContentString descends → finds '@~/'
  //     → outer right is path.join → isUnnormalizedPathExpression → flagged
  //
  //   '@~/' + (name + path.join(home, '.claude'))
  //     → parse tree: '@~/' + (name + path.join(...))
  //     → left is '@~/' → content marker found
  //     → right is BinaryExpression; scanAndReport descends → finds path.join → flagged

  test('invalid (W3): "@~/" + name + path.join(home, ".claude") — chained concat flagged via recursive scan', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [],
      invalid: [
        {
          // W3 left-deep: left side is '@~/' + name (nested BinaryExpression).
          // Without recursive descent, the marker '@~/' in the inner literal
          // is invisible to the outer + node and the violation is missed.
          code: "const s = '@~/' + name + path.join(home, '.claude');",
          errors: [{ messageId: 'pathInContent' }],
        },
      ],
    });
  });

  test('invalid (W3-right-deep): "@~/" + (name + path.join(home, ".claude")) — right-deep path call flagged', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [],
      invalid: [
        {
          // W3 right-deep: content marker is in the left literal '@~/' and the path
          // call is nested inside the right-side BinaryExpression (name + path.join).
          // The recursive scanAndReport must descend into the right subtree to find
          // path.join and report it.
          code: "const s = '@~/' + (name + path.join(home, '.claude'));",
          errors: [{ messageId: 'pathInContent' }],
        },
      ],
    });
  });

  test('valid (W3): "log " + path.join(a, b) — no content marker in any sub-literal → not flagged', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          // No content marker anywhere in the concat tree → not flagged.
          code: "const s = 'log ' + path.join(a, b);",
        },
      ],
      invalid: [],
    });
  });

  // ── '@' narrowing precision ────────────────────────────────────────────────────
  //
  // A bare '@' that is not @~, @$, or @/ must NOT trigger the content heuristic
  // (e.g. email addresses, @author attributions in comments / strings).

  test('valid (@-narrowing): bare "@" in string (e.g. email) is not an @-reference marker', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          // The string contains '@' but no @~, @$, @/ and no ~/., $HOME markers.
          // Bare '@' is not in CONTENT_MARKERS (only @~, @$, @/ are).
          // Also: quasi after expression is ';' — no /…\.md shape (b) match.
          code: "const msg = `Contact author@example.com for ${path.join(a, b)}`;",
        },
      ],
      invalid: [],
    });
  });

  test('valid (@-narrowing): @~/${path.join(home, ".claude")}/x.md WITH normalization — not flagged', () => {
    ruleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          // Confirms that after @-narrowing, a proper @~/ reference WITH POSIX
          // normalization is still correctly NOT flagged.
          code: "const ref = `@~/${String(path.join(home, '.claude')).replace(/\\\\/g, '/')}/x.md`;",
        },
      ],
      invalid: [],
    });
  });
});

// ── TS-parser RuleTester ───────────────────────────────────────────────────────
//
// Run representative fixtures through the @typescript-eslint/parser to confirm
// the rule works under the production parser (used on src/**/*.cts).  This
// catches any AST-shape differences between espree and ts-estree.

const { RuleTester: TSRuleTester } = require('eslint');
const tsParser = require('@typescript-eslint/parser');

const tsRuleTester = new TSRuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
});

describe('normalize-path-in-content — @typescript-eslint/parser (TS syntax fixtures)', () => {
  test('TS-parser INVALID: @~/${path.join(home as string, ".claude")}/x.md — flagged under TS parser', () => {
    tsRuleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [],
      invalid: [
        {
          // TS-specific syntax: `home as string` type assertion inside path.join arg.
          // The expression inside ${ } is still path.join (a CallExpression) → flagged.
          code: "const ref = `@~/${path.join(home as string, '.claude')}/x.md`;",
          errors: [{ messageId: 'pathInContent' }],
        },
      ],
    });
  });

  test('TS-parser VALID: @~/${toPosixPath(path.join(home as string, ".claude"))}/x.md — not flagged', () => {
    tsRuleTester.run('normalize-path-in-content', normalizePathInContent, {
      valid: [
        {
          // Same TS syntax but POSIX-normalized via toPosixPath — must NOT be flagged.
          code: "const ref = `@~/${toPosixPath(path.join(home as string, '.claude'))}/x.md`;",
        },
      ],
      invalid: [],
    });
  });
});
