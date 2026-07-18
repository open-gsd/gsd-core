// allow-test-rule: source-text-is-the-product (see #1964)
// Agent .md + reference .md files — their text IS what the runtime loads.
// Testing text content tests the deployed semantic-recall contract.
// Per CONTRIBUTING.md exception matrix. Covers epic #1957 Phase 3C (#1964).
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const AGENT = path.join(ROOT, 'agents/gsd-debugger.md');
const REFERENCE = path.join(ROOT, 'gsd-core/references/debugger-semantic-recall.md');

describe('semantic knowledge-base recall via MemPalace (#1964, epic #1957 Phase 3C)', () => {
  describe('reference extract exists and is wired in', () => {
    test('gsd-core/references/debugger-semantic-recall.md exists', () => {
      assert.ok(fs.existsSync(REFERENCE), 'debugger-semantic-recall.md reference must exist');
    });

    test('gsd-debugger.md @-includes the semantic-recall reference', () => {
      const content = fs.readFileSync(AGENT, 'utf8');
      assert.ok(
        content.includes('@~/.claude/gsd-core/references/debugger-semantic-recall.md'),
        'gsd-debugger.md must @-include the semantic-recall reference from the knowledge_base_protocol / Matching Logic'
      );
    });
  });

  describe('semantic recall via MemPalace (criterion 1 — same root cause, different wording)', () => {
    test('reference documents querying MemPalace for meaning-similar prior resolutions', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/mempalace/i.test(content), 'must name MemPalace as the semantic-memory surface');
      assert.ok(/semantic/i.test(content), 'must document semantic (not keyword) recall');
      assert.ok(/top-?k|meaning.similar|semantically.similar/i.test(content),
        'must document surfacing top-k meaning-similar prior resolutions');
    });

    test('reference states the payoff: catches lexically-different / same-root-cause cases', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/different.{0,30}word|lexically|same root cause|wording/i.test(content),
        'must state that semantic recall catches same-root-cause/different-wording cases keyword overlap misses (the self-noted limitation)');
    });

    test('reference documents indexing resolved sessions into MemPalace at archive', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/index|archive|store|capture/i.test(content),
        'must document that resolved sessions are indexed into MemPalace at archive time');
    });
  });

  describe('graceful degradation — MemPalace absent falls back to keyword matching (criterion 2)', () => {
    test('reference documents the keyword fallback when MemPalace is unavailable', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/fall[\s-]?back|fallback|when.*(?:absent|unavailable)|degrade/i.test(content),
        'must document degradation to keyword matching when MemPalace is absent');
      assert.ok(/keyword/i.test(content), 'must name keyword matching as the fallback');
    });

    test('knowledge-base.md remains the durable plain-text source of truth', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/knowledge-base\.md|durable|plain[\s-]?text|source of truth/i.test(content),
        'must state that knowledge-base.md remains the durable plain-text source of truth (semantic recall is layered on top)');
    });
  });

  describe('agent wiring — Phase 0 / Matching Logic is semantic-first', () => {
    test('gsd-debugger.md knowledge_base_protocol describes semantic-first matching', () => {
      const content = fs.readFileSync(AGENT, 'utf8');
      // The Matching Logic section must now lead with semantic recall, not "keyword overlap, not semantic"
      assert.ok(/semantic/i.test(content), 'agent must reference semantic recall');
      assert.ok(/mempalace/i.test(content), 'agent must name MemPalace');
      assert.ok(/fall[\s-]?back|fallback/i.test(content), 'agent must describe the keyword fallback');
    });

    test('the stale "keyword overlap, not semantic similarity" claim is gone', () => {
      const content = fs.readFileSync(AGENT, 'utf8');
      assert.ok(
        !/keyword overlap, not semantic similarity/i.test(content),
        'the old "Matching is keyword overlap, not semantic similarity" claim must be removed (it is now semantic-first)'
      );
    });
  });

  describe('no new embedding/vector infrastructure (Choose Boring / Zawinski)', () => {
    test('reference states MemPalace is reused — no new vector store', () => {
      const content = fs.readFileSync(REFERENCE, 'utf8');
      assert.ok(/reuse|no new|without adding|existing.*(?:semantic|memory|capability)/i.test(content),
        'must state MemPalace is reused rather than adding new embedding/vector infrastructure');
    });
  });
});
