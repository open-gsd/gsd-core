'use strict';
// allow-test-rule: source-text-is-the-product [adapter header contract in bin/install.js]

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INSTALL_JS = path.join(__dirname, '..', 'bin', 'install.js');
const src = fs.readFileSync(INSTALL_JS, 'utf8');

describe('bug #279: Codex adapter documents Agent() and deferred tool discovery', () => {
  test('adapter mapping section includes explicit Agent(...) -> spawn_agent mapping', () => {
    assert.ok(
      /Task\(subagent_type="X", prompt="Y"\).*spawn_agent\(agent_type="X", message="Y"\)/.test(src) &&
      /Agent\(subagent_type="X", prompt="Y"\).*spawn_agent\(agent_type="X", message="Y"\)/.test(src),
      'Codex adapter must explicitly map both Task(...) and Agent(...) to spawn_agent',
    );
  });

  test('adapter includes deferred tool_search discovery guidance before inline fallback', () => {
    assert.ok(
      src.includes('deferred') && src.includes('tool_search') && src.includes('spawn_agent'),
      'Codex adapter must instruct deferred tool discovery via tool_search before deciding to run inline',
    );
  });
});
