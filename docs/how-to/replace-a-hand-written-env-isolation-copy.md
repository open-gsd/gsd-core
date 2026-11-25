# How to replace a hand-written env-isolation copy

**Goal:** Turn a `local/no-adhoc-env-isolation` lint error in a test into a call to the one helper that builds an isolated env, `tests/helpers/isolated-env.cjs`.

**Prerequisites:** A test file under `tests/` that fails `npm run lint` with `inlinePathFilter` or `adhocHomeConstruction`. There is no allowlist and no per-file exemption: the helper is the only route.

---

## Read the finding

| Message | What the rule saw | Replace it with |
|---|---|---|
| `inlinePathFilter` | A split of `process.env.PATH`, or `X.split(path.delimiter).filter(...)` | `isolatedPath({ without: [...] })` |
| `adhocHomeConstruction` | An object literal with a `HOME` or `USERPROFILE` key, or an assignment to `env.HOME` / `env.USERPROFILE` on an object that is not `process.env` | `isolatedEnv({ home })`, `homePair(dir)`, or `setEnvForTest(t, vars)` |

A disable comment does not clear it. An `eslint-disable` for this rule is counted anyway by `tests/no-adhoc-env-isolation.rule.test.cjs`, which lints with inline config off, and an unused one is a lint error.

---

## Build the env a test hands to a child

```javascript
const { isolatedEnv } = require('./helpers/isolated-env.cjs');

const env = isolatedEnv({ home: tempDir });
```

`home` sets `HOME` and `USERPROFILE` together, blanks the config-location variables, and strips ambient `GSD_*` and the runner's `RUN_TESTS_*`. Add `claudeConfigDir`, `path` or `override` for the one key a test needs set.

## Build a PATH a tool cannot resolve from

```javascript
const { isolatedEnv, isolatedPath } = require('./helpers/isolated-env.cjs');

const { path: limitedPath } = isolatedPath({ without: ['git'] });
const env = isolatedEnv({ home: tempDir, path: limitedPath });
```

## Spread the HOME / USERPROFILE pair into a larger literal

When a full env is not what the site needs, `homePair(dir)` is the one spelling of the pair:

```javascript
const { homePair } = require('./helpers/isolated-env.cjs');

const env = { ...process.env, ...homePair(tempDir), GSD_HOME: tempDir };
```

## Point the current process at a home for one test

For a test that calls the product in-process, set the variables for the test's lifetime. They are restored afterwards, and `undefined` unsets a variable:

```javascript
const { setEnvForTest, withHome } = require('./helpers/isolated-env.cjs');

test('reads the declared home', (t) => {
  withHome(t, tempDir);
  setEnvForTest(t, { CLAUDE_CONFIG_DIR: undefined });
  // os.homedir() is tempDir here
});
```

---

## When none of these fits

Change `tests/helpers/isolated-env.cjs` in the same PR so the next site can use the new option. Do not add a per-file exemption: none exists.
