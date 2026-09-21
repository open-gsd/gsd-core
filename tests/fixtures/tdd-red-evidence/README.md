# Real reporter fixtures (#4692)

Captured unchanged with Node 24.20.0 and Vitest 5.0.1. Each run exited 1.
Timing and temporary source paths are captured data, not matching criteria.

The Vitest source was `evidence.test.js`:

```js
import { describe, it, expect } from 'vitest';
describe('email validation', () => {
  it('rejects empty email', () => { expect(1).toBe(2); });
  it('accepts valid email', () => { expect(1).toBe(1); });
});
```

- `vitest.tap`: `vitest run evidence.test.js --reporter=tap`
- `vitest-flat.tap`: `vitest run evidence.test.js --reporter=tap-flat`
- `node.tap`: `node --test --test-reporter=tap evidence.node.cjs`, with the same
  suite/test names, `node:test`'s `describe`/`it`, and `node:assert/strict`'s
  `assert.equal(1, 2)` / `assert.equal(1, 1)`.

These commands were exposed through the capture project's npm scripts and run
with `npm run --silent` so the stored stdout is the original reporter stream.
Vitest is not needed to run GSD's regression suite.
