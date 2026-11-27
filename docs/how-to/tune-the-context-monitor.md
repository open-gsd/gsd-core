# How to tune the context monitor's fire-points

**Goal:** Make the context monitor warn the agent earlier or later than its defaults of 35% (WARNING) and 25% (CRITICAL) context remaining.

**Prerequisites:** The context monitor hook is installed for your runtime. Only Claude Code registers it (see [Supported hosts](../context-monitor.md#supported-hosts-4840)). On a runtime without it, Codex today, both keys are inert: `config-set` still stores and validates them, but no hook reads them, so storing a value is not evidence that a fire-point moved. Check that the monitor is installed for your runtime first. For why the monitor exists and how it measures "remaining", see [The context window monitor](../context-monitor.md).

---

## Step 1: Choose the pair

Two keys set the fire-points. Both are percentages of context **remaining** before auto-compaction, so a *larger* number fires *earlier*:

| Key | Default | Meaning |
|-----|---------|---------|
| `hooks.context_warning_threshold` | `35` | At or below this, the agent is told to wrap up and avoid new complex work |
| `hooks.context_critical_threshold` | `25` | At or below this, the agent is told to stop and save state |

`critical` must be strictly below `warning`. How much runway "35% remaining" buys depends on the window size and on what the phase is doing, which is why the values are per project. Both keys are optional; absent keys resolve to the defaults, which is what every existing project gets.

---

## Step 2: Set them in the root project config

Edit `.planning/config.json` at the project root:

```jsonc
{
  "hooks": {
    "context_warnings": true,
    "context_warning_threshold": 45,
    "context_critical_threshold": 30
  }
}
```

Do not change the constants in `gsd-context-monitor.js` instead. The file is in the managed-hooks registry, so the next install re-stages the vendored body and the edit is gone without a conflict or a warning. A config key survives by construction.

If you set the keys with `gsd-tools config-set`, move **both** whenever either would cross the other. `config-set` validates the 0 to 100 domain per key, but deliberately does not enforce the pair: it writes one key per call, and a two-step retune can be transiently inconsistent on disk. Going from 35 / 25 to 20 / 10 is valid throughout if you set critical first, and inconsistent in between if you set warning first. A pair check in the setter would reject that intermediate write and force one order.

`config-set` refuses `warning` 0 and `critical` 100 at write time. They are in range but have no legal partner (nothing is below 0 and nothing is above 100), so the hook would always discard them.

---

## Step 3: Make sure you wrote the file the monitor reads

The monitor reads `<cwd>/.planning/config.json` and nothing else. It does not consult a sub-project or workstream config, but `gsd-tools config-set` does write to one when the environment selects it. A scoped write succeeds and the monitor keeps using the root value, or the default when the root has none:

| Environment | `config-set` writes to |
|---|---|
| neither variable | `.planning/config.json`, the file the monitor reads |
| `GSD_PROJECT=p` | `.planning/p/config.json` |
| `GSD_WORKSTREAM=w` | `.planning/workstreams/w/config.json` |
| both | `.planning/p/workstreams/w/config.json` |

Unset both variables when you run `config-set` for these keys, or edit the root file directly. `hooks.context_warnings` has always had the same root-only scope.

---

## If a value is unusable

The hook never blocks a tool call, so it never throws on a bad value. It degrades:

| Config | Resolved |
|---|---|
| key absent | the default (35 / 25) |
| not a number, or outside 0 to 100 | the default for that key |
| `critical >= warning` after resolution | **both** defaults: an inconsistent pair has no coherent reading, and honouring one side would silently discard the other |
| `warning` 0, or `critical` 100 | **both** defaults, always |

The rows are different rules and compose in this order: an unusable value is replaced by its own default first, and only the resulting pair is checked. So `context_warning_threshold: 150` with `context_critical_threshold: 30` resolves to 35 / 30, not 35 / 25, because 30 is usable and 30 < 35 holds.

The pair check compares resolved values, so overriding only one key is still checked against the other's default. `context_warning_threshold: 20` on its own is inconsistent with the default critical of 25 and resolves back to 35 / 25. Move both when either crosses the other.

---

## Related

- [The context window monitor](../context-monitor.md): how the monitor measures remaining context, debounces, and why it never blocks
- [Configuration](../CONFIGURATION.md): the `hooks.*` keys
