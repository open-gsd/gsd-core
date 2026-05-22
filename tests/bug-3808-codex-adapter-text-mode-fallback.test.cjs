/**
 * Regression test for bug #3808.
 *
 * When Codex runs in Default mode, `request_user_input` is reported as
 * unavailable. The Codex skill adapter must tell the agent to activate the
 * workflow's built-in TEXT_MODE mechanism (`--text` flag) rather than either:
 *   (a) silently picking a default value — the #3018 failure mode, or
 *   (b) ad-hoc plain-text fallback that bypasses the workflow's own branching.
 *
 * Workflows (e.g. plan-phase.md) already have TEXT_MODE logic:
 *   "Set TEXT_MODE=true if `--text` is present in $ARGUMENTS OR text_mode
 *    from init JSON is true."
 * The adapter must tell the agent to USE that mechanism when
 * `request_user_input` is unavailable instead of inventing its own fallback
 * or silently continuing with defaults.
 *
 * Test design: mirrors the typed-semantic-flag pattern from bug #3018 so that
 * prose rewording doesn't break tests as long as the semantics stay correct.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const INSTALL = require(path.join(__dirname, '..', 'bin', 'install.js'));
const { getCodexSkillAdapterHeader } = INSTALL;

/**
 * Extract the "Execute mode fallback" section text from the adapter header.
 * Returns null if the section is missing. Section runs from the
 * "Execute mode fallback:" label up to the next heading or </codex_skill_adapter> tag.
 */
function extractExecuteModeFallback(header) {
  const m = header.match(/Execute mode fallback:\s*\n([\s\S]*?)(?=\n##\s|\n<\/codex_skill_adapter>)/);
  return m ? m[1].trim() : null;
}

/**
 * Parse the Execute-mode-fallback section into a typed semantic-flag record.
 *
 * Flags for bug #3808 (TEXT_MODE activation):
 *   activatesTextMode       — does the prose tell the agent to activate TEXT_MODE / use --text?
 *   instructsStop           — does the prose tell the agent to stop/halt/wait?
 *   presentsPlainText       — does the prose mention plain-text / numbered-list presentation?
 *   silentlyPicksDefaults   — (anti-pattern) does the prose instruct silent-default picking?
 */
function parseExecuteModeFallbackFor3808(section) {
  if (!section || typeof section !== 'string') {
    return {
      ok: false,
      sectionLength: 0,
      activatesTextMode: false,
      instructsStop: false,
      presentsPlainText: false,
      silentlyPicksDefaults: false,
    };
  }

  const lower = section.toLowerCase();

  // (a) TEXT_MODE activation — adapter must tell the agent to use the workflow's
  // built-in text mode mechanism when request_user_input is unavailable.
  // Accept either: explicit "--text" flag mention OR "text_mode" / "text mode"
  // paired with context showing it is being SET/ACTIVATED (not just referenced).
  const mentionsTextFlag   = section.includes('--text');
  const mentionsTextModeOn = /text_mode\s*=\s*true|set\s+text_mode|activate\s+text.?mode|enable\s+text.?mode|text.?mode.*active|text.?mode.*on\b/i.test(section);
  const activatesTextMode  = mentionsTextFlag || mentionsTextModeOn;

  // (b) STOP/WAIT directive — the agent must halt instead of proceeding silently.
  const instructsStop = /\b(stop|halt|wait)\b/.test(lower);

  // (c) Plain-text fallback presentation.
  const presentsPlainText = /plain.?text|numbered list/.test(lower);

  // Anti-pattern guard — the prose that caused #3018 and resurfaces in #3808.
  const silentlyPicksDefaults = /pick (a |the )?(reasonable|sensible|sane) default/i.test(section);

  return {
    ok: true,
    sectionLength: section.length,
    activatesTextMode,
    instructsStop,
    presentsPlainText,
    silentlyPicksDefaults,
  };
}

describe('bug #3808: codex skill adapter activates TEXT_MODE when request_user_input is unavailable', () => {
  const SKILL_NAMES = ['gsd-plan-phase', 'gsd-discuss-phase', 'gsd-execute-phase', 'gsd-verify-work'];

  test('getCodexSkillAdapterHeader is exported', () => {
    assert.equal(typeof getCodexSkillAdapterHeader, 'function');
  });

  test('Execute mode fallback section exists for all key skills', () => {
    for (const skillName of SKILL_NAMES) {
      const header = getCodexSkillAdapterHeader(skillName);
      const section = extractExecuteModeFallback(header);
      assert.ok(section !== null && section.length > 0,
        `${skillName}: Execute mode fallback section must exist and have content`);
    }
  });

  for (const skillName of SKILL_NAMES) {
    test(`${skillName}: fallback activates TEXT_MODE (--text flag or text_mode=true) when request_user_input is unavailable`, () => {
      const header = getCodexSkillAdapterHeader(skillName);
      const section = extractExecuteModeFallback(header);
      const parsed = parseExecuteModeFallbackFor3808(section);
      assert.equal(parsed.activatesTextMode, true,
        `${skillName}: fallback must instruct the agent to activate TEXT_MODE (mention --text flag or text_mode=true/active) when request_user_input is unavailable (#3808). Section was:\n${section}`);
    });

    test(`${skillName}: fallback instructs STOP/WAIT (not silent continuation)`, () => {
      const header = getCodexSkillAdapterHeader(skillName);
      const section = extractExecuteModeFallback(header);
      const parsed = parseExecuteModeFallbackFor3808(section);
      assert.equal(parsed.instructsStop, true,
        `${skillName}: fallback must include stop/halt/wait instruction. Section was:\n${section}`);
    });

    test(`${skillName}: fallback does NOT contain silent-default anti-pattern`, () => {
      const header = getCodexSkillAdapterHeader(skillName);
      const section = extractExecuteModeFallback(header);
      const parsed = parseExecuteModeFallbackFor3808(section);
      assert.equal(parsed.silentlyPicksDefaults, false,
        `${skillName}: regression — fallback must NOT instruct the agent to pick defaults autonomously (#3018 / #3808). Section was:\n${section}`);
    });
  }

  test('typed semantic-record snapshot for gsd-plan-phase — full contract', () => {
    const section = extractExecuteModeFallback(getCodexSkillAdapterHeader('gsd-plan-phase'));
    const parsed = parseExecuteModeFallbackFor3808(section);
    assert.deepStrictEqual(
      {
        ok: parsed.ok,
        activatesTextMode: parsed.activatesTextMode,
        instructsStop: parsed.instructsStop,
        presentsPlainText: parsed.presentsPlainText,
        silentlyPicksDefaults: parsed.silentlyPicksDefaults,
      },
      {
        ok: true,
        activatesTextMode: true,
        instructsStop: true,
        presentsPlainText: true,
        silentlyPicksDefaults: false,
      },
      `gsd-plan-phase: full TEXT_MODE fallback contract violated (#3808). Section was:\n${section}`,
    );
  });
});
