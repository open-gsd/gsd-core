'use strict';

/**
 * #6787: the artifact registry in gsd-core/templates/README.md names the commands that write each file.
 * Every command it names must exist, and the rows that once named the wrong producer must name the right ones.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'gsd-core', 'templates', 'README.md'), 'utf8');
const COMMANDS = new Set(
  fs.readdirSync(path.join(ROOT, 'commands', 'gsd'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3)),
);

/** Table rows whose first cell is a code span, as `{ file, producers }` with the command names of the producer cell. */
function registryRows(markdown) {
  const rows = [];
  for (const line of markdown.split('\n')) {
    if (!/^\s*\|\s*`/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const file = /^`([^`]+)`$/.exec(cells[0]);
    if (!file) continue;
    const producers = [];
    for (const cell of cells.slice(1)) {
      for (const m of cell.matchAll(/`\/gsd[:-]([a-z0-9-]+)[^`]*`/g)) producers.push(m[1]);
    }
    rows.push({ file: file[1], producers });
  }
  return rows;
}

describe('templates registry producers (#6787)', () => {
  const rows = registryRows(README);

  test('the registry has rows that name producers', () => {
    assert.ok(rows.some((r) => r.producers.length > 0));
  });

  test('every command a row names exists under commands/gsd', () => {
    for (const row of rows) {
      for (const name of row.producers) {
        assert.ok(COMMANDS.has(name), `${row.file} names /gsd:${name}, which is not a command`);
      }
    }
  });

  test('the corrected rows name their real producers', () => {
    const producersOf = (file) => (rows.find((r) => r.file === file) || { producers: [] }).producers.slice().sort();
    assert.deepEqual(producersOf('NN-UAT.md'), ['execute-phase', 'verify-work']);
    assert.deepEqual(producersOf('NN-VALIDATION.md'), ['plan-phase', 'validate-phase']);
    assert.deepEqual(producersOf('CLAUDE.md'), ['new-project', 'profile-user']);
  });
});
