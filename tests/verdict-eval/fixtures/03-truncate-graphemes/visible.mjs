import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { truncate } = await import(pathToFileURL(process.env.GSD_SUT).href);

test('truncates a long ASCII string', () => assert.equal(truncate('hello world', 5), 'hello'));
test('returns short strings unchanged', () => assert.equal(truncate('hi', 5), 'hi'));
