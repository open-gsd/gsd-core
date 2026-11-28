# How to add a positive control for a new gate

Use this when you added a gate module (`src/gate-<id>.cts`) and `npm run lint:ci` reports `no-control`. What counts as a gate, the control's options and every lint rule are in [The gate positive-control ratchet](../TESTING-SUITES.md#the-gate-positive-control-ratchet).

1. Add a `gateControl({...})` call to `tests/gate-positive-control.test.cjs`
   naming your gate, its module and its `evaluate*` function.
   `expectRed` names the arm the red scenario reaches.
2. Take `red` from the lint's message (`wrong-red` states what the gate reaches).
3. Write the red scenario from the input that makes the gate fail, and the green
   scenario from the nearest input that does not. Reuse the cases in your gate's
   own unit test; the control asserts the pair through one harness.
4. Run `npm run lint:gate-positive-control`.

## Related

- [The gate positive-control ratchet](../TESTING-SUITES.md#the-gate-positive-control-ratchet)
