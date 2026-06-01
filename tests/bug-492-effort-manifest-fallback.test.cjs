'use strict';

process.env.GSD_TEST_MODE = "1";

const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { createTempProject, cleanup } = require("./helpers.cjs");
const { resolveEffortInternal, CONFIG_DEFAULTS } = require("../get-shit-done/bin/lib/core.cjs");
const { CONFIG_DEFAULTS: CANONICAL_CONFIG_DEFAULTS } = require("../get-shit-done/bin/lib/configuration.cjs");

describe("#492 manifest effort fallback", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test("routing_tier_defaults manifest fallback still works", () => {
    assert.strictEqual(resolveEffortInternal(tmpDir, "gsd-planner"), "xhigh");
  });

  test("manifest effort.agent_overrides wins over routing_tier_defaults when no project config", () => {
    const original = CANONICAL_CONFIG_DEFAULTS.effort.agent_overrides;
    try {
      CANONICAL_CONFIG_DEFAULTS.effort.agent_overrides = { "gsd-planner": "max" };
      assert.strictEqual(resolveEffortInternal(tmpDir, "gsd-planner"), "max");
    } finally {
      CANONICAL_CONFIG_DEFAULTS.effort.agent_overrides = original;
    }
  });

  test("manifest effort.default consulted for unknown agent with no project config", () => {
    const original = CANONICAL_CONFIG_DEFAULTS.effort.default;
    try {
      CANONICAL_CONFIG_DEFAULTS.effort.default = "max";
      assert.strictEqual(resolveEffortInternal(tmpDir, "fictional-agent-xyz-492"), "max");
    } finally {
      CANONICAL_CONFIG_DEFAULTS.effort.default = original;
    }
  });

  test("manifest agent_overrides takes precedence over manifest routing_tier_defaults", () => {
    const originalAgentOverrides = CANONICAL_CONFIG_DEFAULTS.effort.agent_overrides;
    try {
      CANONICAL_CONFIG_DEFAULTS.effort.agent_overrides = { "gsd-planner": "minimal" };
      assert.strictEqual(resolveEffortInternal(tmpDir, "gsd-planner"), "minimal");
    } finally {
      CANONICAL_CONFIG_DEFAULTS.effort.agent_overrides = originalAgentOverrides;
    }
  });
});
