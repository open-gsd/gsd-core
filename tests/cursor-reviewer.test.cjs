// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Cursor CLI Reviewer Tests (#1960)
 *
 * Verifies that /gsd-review includes Cursor CLI as a peer reviewer:
 *   - review.md workflow contains cursor detection, flag parsing, self-detection, invocation
 *   - commands/gsd/review.md command file mentions --cursor flag
 *   - help.md lists --cursor in the /gsd-review signature
 *   - docs/COMMANDS.md has --cursor flag row
 *   - docs/FEATURES.md has Cursor in the review section
 *   - i18n docs mirror the same content
 *   - REVIEWS.md template includes Cursor Review section
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

describe('Cursor CLI reviewer in /gsd-review (#1960)', () => {

  // --- review.md workflow ---

  describe('review.md workflow', () => {
    const reviewPath = path.join(ROOT, 'gsd-core', 'workflows', 'review.md');
    let content;

    test('review.md exists', () => {
      assert.ok(fs.existsSync(reviewPath), 'review.md should exist');
      content = fs.readFileSync(reviewPath, 'utf-8');
    });

    test('contains cursor CLI detection via command -v cursor-agent', () => {
      const c = fs.readFileSync(reviewPath, 'utf-8');
      assert.ok(
        c.includes('command -v cursor-agent'),
        'review.md should detect cursor CLI via "command -v cursor-agent" (not the cursor IDE launcher)'
      );
    });

    test('contains --cursor flag parsing', () => {
      const c = fs.readFileSync(reviewPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'review.md should parse --cursor flag'
      );
    });

    test('contains CURSOR_SESSION_ID self-detection', () => {
      const c = fs.readFileSync(reviewPath, 'utf-8');
      assert.ok(
        c.includes('CURSOR_SESSION_ID'),
        'review.md should detect self-CLI via CURSOR_SESSION_ID env var'
      );
    });

    test('invocation uses cursor-agent single binary with -p flag', () => {
      const c = fs.readFileSync(reviewPath, 'utf-8');
      assert.ok(
        c.includes('cursor-agent -p'),
        'review.md should invoke cursor via "cursor-agent -p" (single binary, not two-token "cursor agent")'
      );
    });

    test('invocation includes --output-format text', () => {
      const c = fs.readFileSync(reviewPath, 'utf-8');
      assert.ok(
        c.includes('--output-format text'),
        'review.md cursor-agent invocation should include "--output-format text"'
      );
    });

    test('invocation passes prompt as a file-path argument (not via stdin pipe)', () => {
      const c = fs.readFileSync(reviewPath, 'utf-8');
      assert.ok(
        c.includes('Read the file at /tmp/gsd-review-prompt-'),
        'review.md cursor-agent invocation should pass prompt by referencing the file path as an argument'
      );
    });

    test('does NOT use broken two-token "cursor agent " form', () => {
      const c = fs.readFileSync(reviewPath, 'utf-8');
      // Must not match "cursor agent " (cursor + space + agent + space)
      // The hyphenated "cursor-agent" must NOT trip this check — the regex uses a space, not a hyphen.
      assert.ok(
        !/cursor agent /.test(c),
        'review.md must NOT contain the broken two-token form "cursor agent " (use "cursor-agent" instead)'
      );
    });

    test('does NOT pipe the prompt into a cursor command via stdin', () => {
      const c = fs.readFileSync(reviewPath, 'utf-8');
      // Must not match a pipe feeding into a cursor command (e.g. "| cursor" or "|cursor")
      // "cursor-agent" (hyphenated) must NOT trip this — the regex anchors on "cursor" not followed by "-agent"
      assert.ok(
        !/\| *cursor(?!-agent)/.test(c),
        'review.md must NOT pipe the prompt to a cursor command via stdin'
      );
    });

    test('contains Cursor Review section in REVIEWS.md template', () => {
      const c = fs.readFileSync(reviewPath, 'utf-8');
      assert.ok(
        c.includes('Cursor Review'),
        'review.md should include a "Cursor Review" section in the REVIEWS.md template'
      );
    });

    test('lists cursor in the reviewers frontmatter array', () => {
      const c = fs.readFileSync(reviewPath, 'utf-8');
      assert.ok(
        /reviewers:.*cursor/.test(c),
        'review.md should list cursor in the reviewers array'
      );
    });
  });

  // --- commands/gsd/review.md ---

  describe('commands/gsd/review.md', () => {
    const cmdPath = path.join(ROOT, 'commands', 'gsd', 'review.md');

    test('mentions --cursor flag', () => {
      const c = fs.readFileSync(cmdPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'commands/gsd/review.md should mention --cursor flag'
      );
    });

    test('mentions Cursor in objective or context', () => {
      const c = fs.readFileSync(cmdPath, 'utf-8');
      assert.ok(
        c.includes('Cursor'),
        'commands/gsd/review.md should mention Cursor'
      );
    });
  });

  // --- help.md ---

  describe('help.md', () => {
    // After #3039, help content moved into help/modes/full.md.
    const helpPath = path.join(ROOT, 'gsd-core', 'workflows', 'help', 'modes', 'full.md');

    test('lists --cursor in /gsd-review signature', () => {
      const c = fs.readFileSync(helpPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'help.md should list --cursor in the /gsd-review command signature'
      );
    });
  });

  // --- docs/COMMANDS.md ---

  describe('docs/COMMANDS.md', () => {
    const docsPath = path.join(ROOT, 'docs', 'COMMANDS.md');

    test('has --cursor flag row', () => {
      const c = fs.readFileSync(docsPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'docs/COMMANDS.md should have a --cursor flag row'
      );
    });
  });

  // --- docs/FEATURES.md ---

  describe('docs/FEATURES.md', () => {
    const featPath = path.join(ROOT, 'docs', 'FEATURES.md');

    test('has --cursor in review command signature', () => {
      const c = fs.readFileSync(featPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'docs/FEATURES.md should include --cursor in the review command signature'
      );
    });

    test('mentions Cursor in the review purpose', () => {
      const c = fs.readFileSync(featPath, 'utf-8');
      assert.ok(
        c.includes('Cursor'),
        'docs/FEATURES.md should mention Cursor in the review section'
      );
    });
  });

  // --- i18n: ja-JP ---

  describe('docs/ja-JP/COMMANDS.md', () => {
    const jaPath = path.join(ROOT, 'docs', 'ja-JP', 'COMMANDS.md');

    test('has --cursor flag row', () => {
      const c = fs.readFileSync(jaPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'docs/ja-JP/COMMANDS.md should have a --cursor flag row'
      );
    });
  });

  describe('docs/ja-JP/FEATURES.md', () => {
    const jaPath = path.join(ROOT, 'docs', 'ja-JP', 'FEATURES.md');

    test('has --cursor in review command signature', () => {
      const c = fs.readFileSync(jaPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'docs/ja-JP/FEATURES.md should include --cursor in the review command signature'
      );
    });

    test('mentions Cursor in the review section', () => {
      const c = fs.readFileSync(jaPath, 'utf-8');
      assert.ok(
        /Cursor/i.test(fs.readFileSync(jaPath, 'utf-8')),
        'docs/ja-JP/FEATURES.md should mention Cursor in the review section'
      );
    });
  });

  // --- i18n: ko-KR ---

  describe('docs/ko-KR/COMMANDS.md', () => {
    const koPath = path.join(ROOT, 'docs', 'ko-KR', 'COMMANDS.md');

    test('has --cursor flag row', () => {
      const c = fs.readFileSync(koPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'docs/ko-KR/COMMANDS.md should have a --cursor flag row'
      );
    });
  });

  describe('docs/ko-KR/FEATURES.md', () => {
    const koPath = path.join(ROOT, 'docs', 'ko-KR', 'FEATURES.md');

    test('has --cursor in review command signature', () => {
      const c = fs.readFileSync(koPath, 'utf-8');
      assert.ok(
        c.includes('--cursor'),
        'docs/ko-KR/FEATURES.md should include --cursor in the review command signature'
      );
    });

    test('mentions Cursor in the review section', () => {
      const c = fs.readFileSync(koPath, 'utf-8');
      assert.ok(
        /Cursor/i.test(fs.readFileSync(koPath, 'utf-8')),
        'docs/ko-KR/FEATURES.md should mention Cursor in the review section'
      );
    });
  });
});
