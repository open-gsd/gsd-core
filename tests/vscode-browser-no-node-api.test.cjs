// allow-test-rule: source-text-is-the-product (#2103). browser.js's entire
// contract IS "zero Node APIs" — a VS Code Web/webworker host has no Node
// core modules at all, so this is a runtime-contract source check, not a
// behavioral proxy for something observable another way (there is no Node
// runtime to observe failing against in CI). Mirrors the existing
// phase6-capstone-conformance.test.cjs precedent for the same exemption class.
'use strict';

/**
 * VS Code browser (Web Extension) entry static guard — #2103.
 *
 * `vscode/browser.js` is the `browser` field entry VS Code Web / vscode.dev
 * loads in a webworker context, which has NO Node core modules at all
 * (`fs`, `path`, `child_process`) and no Node globals (`process`, `Buffer`,
 * `__dirname`, `__filename`). Requiring one throws immediately at load time.
 *
 * This is the reason browser.js does NOT require `./host-binding.js` (whose
 * transitive engine-lib dependencies pull in `node:fs` — see host-binding.js's
 * and browser.js's own header comments for the full chain) — it implements an
 * independent, minimal composition directly against `vscode.lm`.
 *
 * No real browser or VS Code host is available in CI (mock vscode only, per
 * every other vscode-*.test.cjs in this suite).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BROWSER_PATH = path.join(__dirname, '..', 'vscode', 'browser.js');

test('vscode/browser.js source contains ZERO require("fs" | "path" | "child_process") (or "node:" prefixed forms)', () => {
  const src = fs.readFileSync(BROWSER_PATH, 'utf8');
  const bannedRequires = [
    /require\(\s*['"]fs['"]\s*\)/,
    /require\(\s*['"]node:fs['"]\s*\)/,
    /require\(\s*['"]path['"]\s*\)/,
    /require\(\s*['"]node:path['"]\s*\)/,
    /require\(\s*['"]child_process['"]\s*\)/,
    /require\(\s*['"]node:child_process['"]\s*\)/,
  ];
  const offenders = [];
  for (const line of src.split(/\r?\n/)) {
    // Skip comment lines (this file's own header documents the constraint in
    // prose, which legitimately contains the string `require('fs')` etc.).
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    for (const re of bannedRequires) {
      if (re.test(line)) offenders.push(line.trim());
    }
  }
  assert.deepEqual(offenders, [],
    `vscode/browser.js must never require a Node core module outside a comment; found: ${JSON.stringify(offenders)}`);
});

test('vscode/browser.js does NOT require ./host-binding.js or ./extension.js (both pull in fs-heavy engine-lib modules transitively)', () => {
  const src = fs.readFileSync(BROWSER_PATH, 'utf8');
  const codeLines = src.split(/\r?\n/).filter((l) => {
    const t = l.trim();
    return !(t.startsWith('*') || t.startsWith('//'));
  }).join('\n');
  assert.doesNotMatch(codeLines, /require\(\s*['"]\.\/(host-binding|extension)\.js['"]\s*\)/,
    'browser.js must compose its own zero-Node-API surface, not require a module with fs-pulling transitive deps');
});

test('vscode/browser.js source contains no Node-only globals (process/Buffer/__dirname/__filename) outside comments', () => {
  const src = fs.readFileSync(BROWSER_PATH, 'utf8');
  const offenders = [];
  for (const line of src.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    if (/\bprocess\.|\bBuffer\.|__dirname\b|__filename\b/.test(line)) offenders.push(line.trim());
  }
  assert.deepEqual(offenders, []);
});

test('vscode/browser.js is valid, loadable JS (node --check equivalent — require does not throw)', () => {
  assert.doesNotThrow(() => require(BROWSER_PATH));
});

test('REACHABILITY: browser.js activate() runs against a mock vscode host without throwing (no real VS Code/browser in CI)', () => {
  const Module = require('module');
  const originalLoad = Module._load;
  const registeredCommands = {};
  let chatCreated = false;
  const toolNames = [];
  const mockVscode = {
    commands: {
      registerCommand(id, handler) {
        registeredCommands[id] = handler;
        return { dispose() {} };
      },
    },
    chat: {
      createChatParticipant(id, handler) {
        chatCreated = true;
        return { id, handler, dispose() {} };
      },
    },
    lm: {
      registerTool(name) {
        toolNames.push(name);
        return { dispose() {} };
      },
    },
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    LanguageModelTextPart: class { constructor(t) { this.text = t; } },
    LanguageModelToolResult: class { constructor(p) { this.parts = p; } },
  };
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return mockVscode;
    return originalLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[BROWSER_PATH];
    const browser = require(BROWSER_PATH);
    const context = { subscriptions: [] };
    assert.doesNotThrow(() => browser.activate(context));
    assert.ok(registeredCommands['gsd.invoke'], 'gsd.invoke command registered on web too');
    assert.ok(chatCreated, 'chat participant registered on web');
    assert.ok(toolNames.length > 0, 'LM tools registered on web');
    assert.ok(context.subscriptions.length > 0);
  } finally {
    Module._load = originalLoad;
    delete require.cache[BROWSER_PATH];
  }
});
