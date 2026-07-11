'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('fast-check');

const {
  LOOP_POINTS,
  HOOK_KINDS,
  INTERFACE_POINTS,
  PROFILES,
  AXES,
  AXES_FREE_STRING,
  CAPABILITY_REQUIRED,
  EOS_REQUIRED,
  isValidGsdRange,
  validateEntries,
  renderMarkdown,
} = require(path.join(__dirname, '..', 'scripts', 'registry-schema.cjs'));

// ─── Fixtures ─────────────────────────────────────────────────────────────

function validCapabilityEntry() {
  return {
    id: 'my-capability',
    name: 'My Capability',
    type: 'capability',
    repo: 'octocat/my-capability',
    description: 'Does a useful thing for GSD users.',
    author: 'Octocat',
    license: 'MIT',
    enginesGsd: '>=1.6.0 <3.0.0',
    install: 'gsd capability install https://github.com/octocat/my-capability.git#v1.0.0',
    uninstall: 'gsd capability remove my-capability',
    interactions: {
      loopExtensionPoints: ['execute:pre'],
      hookKinds: ['step'],
      configKeys: ['myCapability.enabled'],
      requires: [],
      runtimeCompat: ['all'],
      produces: [],
      consumes: [],
    },
    discussion: 'https://github.com/octocat/my-capability/discussions/1',
  };
}

function validEosEntry() {
  return {
    id: 'my-host-plugin',
    name: 'My Host Plugin',
    type: 'eos',
    repo: 'octocat/my-host-plugin',
    description: 'Embeds GSD as an orchestration engine in My Host.',
    author: 'Octocat',
    license: 'MIT',
    enginesGsd: '>=1.6.0 <3.0.0',
    install: 'See the My Host plugin marketplace listing.',
    uninstall: 'Uninstall via the My Host plugin manager.',
    protocolVersion: 1,
    interactions: {
      interfacePoints: ['command', 'state'],
      profile: 'programmatic-cli',
      axes: {
        embeddingMode: 'imperative',
        commandSurface: 'slash-file',
        dispatch: 'Supports nested background dispatch up to depth 3.',
        modelMode: 'active',
        hookBus: 'host',
        stateIO: 'filesystem',
        transport: 'mcp',
        runtime: 'node',
      },
    },
    discussion: 'https://github.com/octocat/my-host-plugin/discussions/2',
  };
}

// ─── Vocabulary constants ───────────────────────────────────────────────────

describe('registry-schema: closed vocabulary constants', () => {
  test('LOOP_POINTS is the 12 canonical loop points (ADR-857), in order', () => {
    assert.deepEqual(LOOP_POINTS, [
      'discuss:pre',
      'discuss:post',
      'plan:pre',
      'plan:post',
      'execute:pre',
      'execute:wave:pre',
      'execute:wave:post',
      'execute:post',
      'verify:pre',
      'verify:post',
      'ship:pre',
      'ship:post',
    ]);
  });

  test('HOOK_KINDS is step/contribution/gate (ADR-857 Decision 4)', () => {
    assert.deepEqual(HOOK_KINDS, ['step', 'contribution', 'gate']);
  });

  test('INTERFACE_POINTS is the six ADR-1239 interface points', () => {
    assert.deepEqual(INTERFACE_POINTS, ['command', 'dispatch', 'model', 'hooks', 'state', 'artifact']);
  });

  test('PROFILES is the three ADR-1239 negotiation profiles', () => {
    assert.deepEqual(PROFILES, ['programmatic-cli', 'declarative-cli', 'ide']);
  });

  test('AXES has exactly the eight ADR-1239 negotiated axis keys', () => {
    assert.deepEqual(
      Object.keys(AXES).sort(),
      ['commandSurface', 'dispatch', 'embeddingMode', 'hookBus', 'modelMode', 'runtime', 'stateIO', 'transport'].sort(),
    );
  });

  test('AXES.dispatch carries the free-string sentinel, not an enum array', () => {
    assert.equal(AXES.dispatch, AXES_FREE_STRING);
    assert.equal(Array.isArray(AXES.dispatch), false);
  });

  test('every non-dispatch AXES entry is a non-empty enum array', () => {
    for (const [key, value] of Object.entries(AXES)) {
      if (key === 'dispatch') continue;
      assert.ok(Array.isArray(value), `AXES.${key} should be an array`);
      assert.ok(value.length > 0, `AXES.${key} should be non-empty`);
    }
  });

  test('CAPABILITY_REQUIRED lists the 12 required capability entry fields', () => {
    assert.deepEqual(CAPABILITY_REQUIRED, [
      'id', 'name', 'type', 'repo', 'description', 'author', 'license',
      'enginesGsd', 'install', 'uninstall', 'interactions', 'discussion',
    ]);
  });

  test('EOS_REQUIRED lists the 13 required eos entry fields (adds protocolVersion)', () => {
    assert.deepEqual(EOS_REQUIRED, [
      'id', 'name', 'type', 'repo', 'description', 'author', 'license',
      'enginesGsd', 'install', 'uninstall', 'interactions', 'discussion', 'protocolVersion',
    ]);
  });
});

// ─── validateEntries: capability ───────────────────────────────────────────

describe('validateEntries: capability — happy path', () => {
  test('a fully-valid capability entry passes', () => {
    const verdict = validateEntries([validCapabilityEntry()], { type: 'capability' });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.errors, []);
  });
});

describe('validateEntries: capability — required fields', () => {
  for (const field of CAPABILITY_REQUIRED) {
    test(`missing required field "${field}" fails`, () => {
      const entry = validCapabilityEntry();
      delete entry[field];
      const verdict = validateEntries([entry], { type: 'capability' });
      assert.equal(verdict.ok, false);
      assert.ok(verdict.errors.length > 0, 'expected at least one error');
      assert.ok(
        verdict.errors.some((e) => e.field === field),
        `expected an error referencing field "${field}", got: ${JSON.stringify(verdict.errors)}`,
      );
    });
  }
});

describe('validateEntries: capability — field shape violations', () => {
  test('bad id (not kebab-case) fails', () => {
    const entry = validCapabilityEntry();
    entry.id = 'Not_Kebab_Case';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'id'));
  });

  test('bad repo (not owner/repo form) fails', () => {
    const entry = validCapabilityEntry();
    entry.repo = 'not-a-valid-repo';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'repo'));
  });

  test('bad enginesGsd (malformed range) fails', () => {
    const entry = validCapabilityEntry();
    entry.enginesGsd = 'not-a-semver-range';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'enginesGsd'));
  });

  test('bad discussion URL fails', () => {
    const entry = validCapabilityEntry();
    entry.discussion = 'https://example.com/not-a-discussion';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'discussion'));
  });

  test('bad license fails', () => {
    const entry = validCapabilityEntry();
    entry.license = 'Not A Valid License!!';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'license'));
  });

  test('unknown top-level key fails (strict schema)', () => {
    const entry = validCapabilityEntry();
    entry.extraUnknownField = 'nope';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'extraUnknownField'));
  });

  test('duplicate id across two entries fails', () => {
    const a = validCapabilityEntry();
    const b = validCapabilityEntry();
    b.name = 'A Different Name';
    b.repo = 'octocat/another-capability';
    b.discussion = 'https://github.com/octocat/another-capability/discussions/2';
    // b.id intentionally left the same as a.id
    const verdict = validateEntries([a, b], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'id' && /duplicate/i.test(e.reason)));
  });

  test('empty loopExtensionPoints fails (AC3 — must be non-empty)', () => {
    const entry = validCapabilityEntry();
    entry.interactions.loopExtensionPoints = [];
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.loopExtensionPoints'));
  });

  test('invalid loop point fails', () => {
    const entry = validCapabilityEntry();
    entry.interactions.loopExtensionPoints = ['not:a:real:point'];
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.loopExtensionPoints'));
  });

  test('invalid hook kind fails', () => {
    const entry = validCapabilityEntry();
    entry.interactions.hookKinds = ['not-a-real-kind'];
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.hookKinds'));
  });
});

// ─── validateEntries: eos ───────────────────────────────────────────────────

describe('validateEntries: eos — happy path', () => {
  test('a fully-valid eos entry passes', () => {
    const verdict = validateEntries([validEosEntry()], { type: 'eos' });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.errors, []);
  });
});

describe('validateEntries: eos — field shape violations', () => {
  test('bad interfacePoint fails', () => {
    const entry = validEosEntry();
    entry.interactions.interfacePoints = ['not-a-real-point'];
    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.interfacePoints'));
  });

  test('bad profile fails', () => {
    const entry = validEosEntry();
    entry.interactions.profile = 'not-a-real-profile';
    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.profile'));
  });

  test('bad axis value fails', () => {
    const entry = validEosEntry();
    entry.interactions.axes.embeddingMode = 'not-a-real-value';
    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.axes.embeddingMode'));
  });

  test('protocolVersion < 1 fails', () => {
    const entry = validEosEntry();
    entry.protocolVersion = 0;
    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'protocolVersion'));
  });

  test('missing axis key fails', () => {
    const entry = validEosEntry();
    delete entry.interactions.axes.runtime;
    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.axes'));
  });

  test('extra axis key fails', () => {
    const entry = validEosEntry();
    entry.interactions.axes.notARealAxis = 'x';
    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.axes'));
  });
});

// ─── renderMarkdown ─────────────────────────────────────────────────────────

describe('renderMarkdown', () => {
  test('is deterministic across two calls regardless of input entry order', () => {
    const a = validCapabilityEntry();
    const b = { ...validCapabilityEntry(), id: 'zzz-capability', name: 'ZZZ Capability' };
    const first = renderMarkdown([a, b], { type: 'capability', sourceFile: 'capabilities.json' });
    const second = renderMarkdown([b, a], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.equal(first, second);
  });

  test('contains the shields.io release badge for a populated registry', () => {
    const rendered = renderMarkdown([validCapabilityEntry()], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.match(rendered, /img\.shields\.io\/github\/v\/release/);
  });

  test('contains the entry discussion URL for a populated registry', () => {
    const entry = validCapabilityEntry();
    const rendered = renderMarkdown([entry], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.ok(rendered.includes(entry.discussion), 'expected rendered output to include the discussion URL');
  });

  test('contains the empty-state text for zero entries', () => {
    const rendered = renderMarkdown([], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.match(rendered, /No entries yet/);
  });
});

// ─── isValidGsdRange ────────────────────────────────────────────────────────

describe('isValidGsdRange', () => {
  test('fast-check property: well-formed operator+M.N.P ranges are valid', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('', '>=', '>', '<=', '<', '=', '^', '~'),
        fc.integer({ min: 0, max: 999 }),
        fc.integer({ min: 0, max: 999 }),
        fc.integer({ min: 0, max: 999 }),
        (op, major, minor, patch) => {
          const range = `${op}${major}.${minor}.${patch}`;
          assert.equal(isValidGsdRange(range), true, range);
        },
      ),
    );
  });

  test('fast-check property: a non-numeric major segment is always invalid', () => {
    // Replacing a numeric segment with letters can never be a well-formed range.
    // Letters-only (not arbitrary garbage) keeps the generator from accidentally
    // producing a valid semver-with-prerelease like `1.2.3-rc` — `>=1.2.3-rc.0.0`
    // IS a legitimate prerelease range the validator accepts, which would make an
    // "always invalid" assertion intermittently fail (a hidden flake).
    fc.assert(
      fc.property(
        fc.constantFrom('', '>=', '>', '<=', '<', '=', '^', '~'),
        fc
          .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 1, maxLength: 6 })
          .map((chars) => chars.join('')),
        (op, letters) => {
          assert.equal(isValidGsdRange(`${op}${letters}.0.0`), false, `${op}${letters}.0.0`);
        },
      ),
    );
  });

  test('boundary: valid range strings', () => {
    for (const good of ['1.0.0', '>=1.0.0', '^1.0.0 <2.0.0', '*']) {
      assert.equal(isValidGsdRange(good), true, good);
    }
  });

  test('boundary: invalid range strings', () => {
    for (const bad of ['1.0', '>=abc', '']) {
      assert.equal(isValidGsdRange(bad), false, bad);
    }
  });
});
