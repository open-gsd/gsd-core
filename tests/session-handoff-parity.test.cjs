'use strict';

/**
 * #6797 parity guard (ADR-4962 Decision 7, the added "Done when" bullet of #4845): every follower of the
 * handoff filename grammar is held to the store. `src/session-store.cts` owns the grammar; a hook cannot
 * require the compiled CLI, so each follower carries an inline copy. The copies are listed in the
 * `followers` registry of tests/fixtures/session-handoff-cases.json; this test runs every listed follower
 * over the shared case table and over arbitrary strings against the store, and the text contract
 * `handoff-grammar-readers-registered` fails when a file that reads the grammar is not listed.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const store = require('../gsd-core/bin/lib/session-store.cjs');
const table = require('./fixtures/session-handoff-cases.json');

const ROOT = path.join(__dirname, '..');
const REQUIRED_EXPORTS = ['classifyHandoffName', 'isOwnHandoff', 'sanitizeSessionId', 'resolveSessionId', 'SESSION_ENV_KEYS'];
const NO_KEYS = Object.fromEntries(store.SESSION_ENV_KEYS.map((k) => [k, '']));

const followers = table.followers.map((f) => ({ ...f, mod: require(path.join(ROOT, f.file)) }));

describe('the follower registry', () => {
  test('followerRegistryIsWellFormed: at least one follower, unique ids, existing files, every required export', () => {
    assert.ok(followers.length >= 1);
    assert.equal(new Set(followers.map((f) => f.id)).size, followers.length, 'follower ids are unique');
    for (const f of followers) {
      assert.ok(fs.existsSync(path.join(ROOT, f.file)), `${f.id}: ${f.file} must exist`);
      assert.equal(typeof f.why, 'string', `${f.id}: say why this file carries its own copy`);
      for (const name of REQUIRED_EXPORTS) assert.ok(f.mod[name] !== undefined, `${f.id} must export ${name}`);
    }
  });
});

for (const f of followers) {
  describe(`follower "${f.id}" (${f.file}) is held to the store`, () => {
    for (const row of table.cases) {
      test(`followersMatchCaseTable: ${row.name}`, () => {
        const parsed = f.mod.classifyHandoffName(row.file);
        assert.deepEqual(parsed, store.classifyHandoffName(row.file), 'classify equals the store');
        assert.equal(parsed ? parsed.kind : null, row.expect.kind);
        if (parsed === null) return;
        const entry = { file: row.file, ...parsed, body: row.body };
        assert.equal(f.mod.isOwnHandoff(entry, row.identity), row.expect.is_self);
        assert.equal(f.mod.isOwnHandoff(entry, row.identity), store.isOwnHandoff(entry, row.identity));
      });
    }

    test('followersShareSessionEnvKeys: the same keys in the same order', () => {
      assert.deepEqual([...f.mod.SESSION_ENV_KEYS], [...store.SESSION_ENV_KEYS]);
    });

    test('followersEqualStoreProperty: sanitizeSessionId and classifyHandoffName agree with the store on arbitrary strings', () => {
      fc.assert(fc.property(fc.string(), (raw) => {
        const sid = store.sanitizeSessionId(raw);
        if (f.mod.sanitizeSessionId(raw) !== sid) return false;
        for (const name of [raw, `HANDOFF.${raw}.json`, `HANDOFF.latest.${raw}.json`, `HANDOFF.claimed.${raw}.s1.json`, `HANDOFF.claimed.r.${raw}.json`]) {
          if (JSON.stringify(f.mod.classifyHandoffName(name)) !== JSON.stringify(store.classifyHandoffName(name))) return false;
        }
        return true;
      }), { seed: 6797, numRuns: 600 });
    });

    test('followersEqualStoreProperty: resolveSessionId agrees with the store for a flag, a key, and both', () => {
      fc.assert(fc.property(fc.string(), fc.string(), fc.constantFrom(...store.SESSION_ENV_KEYS, 'TMUX_PANE', 'TERM_SESSION_ID'), (flag, value, key) => {
        const env = { ...NO_KEYS, [key]: value };
        return f.mod.resolveSessionId({ env }) === store.resolveSessionId({ env })
          && f.mod.resolveSessionId({ session: flag, env }) === store.resolveSessionId({ session: flag, env });
      }), { seed: 4845, numRuns: 400 });
    });

    test('followersEqualStoreProperty: isOwnHandoff agrees with the store on generated entries', () => {
      const slug = fc.stringMatching(/^[a-z0-9]{1,6}(-[a-z0-9]{1,6}){0,2}$/);
      const sid = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,10}$/);
      fc.assert(fc.property(
        fc.constantFrom('legacy', 'latest', 'session', 'claimed'),
        fc.option(slug, { nil: null }), fc.option(sid, { nil: null }),
        fc.option(slug, { nil: null }), fc.option(sid, { nil: null }),
        fc.oneof(fc.constant({}), fc.record({ role_id: fc.oneof(slug, fc.string(), fc.integer()) }), fc.record({ role: fc.string() })),
        (kind, entryRole, entrySession, idRole, idSession, body) => {
          const entry = { kind, role_id: entryRole, session_id: entrySession, body };
          const identity = { session_id: idSession, role_id: idRole };
          return f.mod.isOwnHandoff(entry, identity) === store.isOwnHandoff(entry, identity);
        },
      ), { seed: 6815, numRuns: 800 });
    });
  });
}
