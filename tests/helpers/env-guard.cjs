'use strict';

/**
 * Set (or, with `undefined`, delete) one environment variable for the length of a test.
 * node:test restores it in `t.after`; the returned function restores it earlier, for a
 * test that must run git (or anything else env-sensitive) before its last assertion.
 */
function stubEnv(t, name, value) {
  const prior = process.env[name];
  const restore = () => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; };
  t.after(restore);
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  return restore;
}

module.exports = { stubEnv };
