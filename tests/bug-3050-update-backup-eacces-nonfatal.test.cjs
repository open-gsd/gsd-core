'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('bug #3050: update backup skips unreadable files non-fatally', () => {
  test('update workflow backup loop wraps copyFileSync in try/catch and logs non-fatal skip', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'update.md'),
      'utf8',
    );

    const hasTryCatch = /try\s*\{[\s\S]*copyFileSync\([\s\S]*\}[\s\S]*catch\s*\(err\)/.test(content);
    assert.ok(hasTryCatch, 'backup copy loop must catch per-file copy errors');

    const hasNonFatalSkipMessage = /Skipped \(non-fatal\):/.test(content);
    assert.ok(
      hasNonFatalSkipMessage,
      'workflow must log a non-fatal skip message for unreadable custom files',
    );
  });
});
