'use strict';

/**
 * Regression test for #1747:
 *   /gsd-new-project emits unsupported search provider config keys, causing
 *   /gsd-settings unknown-key warnings.
 *
 * Root cause: `buildNewProjectConfig` (src/config.cts) emits seven search-
 * provider availability flags into the default .planning/config.json, but
 * only three were registered in the canonical schema manifest
 * (gsd-core/bin/shared/config-schema.manifest.json → VALID_CONFIG_KEYS).
 * config-loader.cts then prints an "unknown config key(s)" warning for the
 * four unregistered keys (tavily_search, ref_search, perplexity, jina) even
 * though research-provider.cts consumes all seven.
 *
 * Fix direction (per triage): register the four missing keys in the schema —
 * do NOT remove them from the generator. They are wired providers.
 *
 * This test locks the bug fix two ways:
 *   1. Direct: the four previously-missing keys are in VALID_CONFIG_KEYS.
 *   2. Structural parity: every config-driven provider flag consumed by
 *      providerAvailability() in research-provider.cts is in VALID_CONFIG_KEYS
 *      — so a future provider addition cannot silently reintroduce this drift.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config-schema.cjs');

// The four keys that were emitted by buildNewProjectConfig and consumed by
// research-provider.cts but missing from VALID_CONFIG_KEYS — the exact bug.
const MISSING_KEYS = ['tavily_search', 'ref_search', 'perplexity', 'jina'];

// Every config-driven provider flag read by providerAvailability() in
// src/research-provider.cts. context7 and websearch are intentionally
// excluded: they are hardcoded `true` (not config-gated), so they have no
// corresponding config key to register.
const PROVIDER_CONFIG_KEYS = [
  'brave_search',
  'firecrawl',
  'exa_search',
  'tavily_search',
  'ref_search',
  'perplexity',
  'jina',
];

describe('#1747: new-project config emits only schema-recognized provider keys', () => {
  test('the four previously-missing provider keys are in VALID_CONFIG_KEYS', () => {
    const absent = MISSING_KEYS.filter((k) => !VALID_CONFIG_KEYS.has(k));
    assert.deepStrictEqual(
      absent,
      [],
      `These provider keys are emitted by buildNewProjectConfig and consumed by research-provider.cts but missing from VALID_CONFIG_KEYS:\n  ${absent.join('\n  ')}\n\nAdd them to gsd-core/bin/shared/config-schema.manifest.json (validKeys).`
    );
  });

  test('every config-driven research-provider flag is registered in the schema (drift guard)', () => {
    const drifted = PROVIDER_CONFIG_KEYS.filter((k) => !VALID_CONFIG_KEYS.has(k));
    assert.deepStrictEqual(
      drifted,
      [],
      `These research-provider config flags are not in VALID_CONFIG_KEYS — a fresh /gsd-new-project config would trigger an unknown-key warning under /gsd-settings:\n  ${drifted.join('\n  ')}\n\nWhen you add a provider to providerAvailability() in src/research-provider.cts, also register its config key in gsd-core/bin/shared/config-schema.manifest.json.`
    );
  });
});
