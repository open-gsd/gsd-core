---
type: Security
pr: 752
---
**`gsd-tools config-set` prototype-pollution guard hardened and regression-tested.** The guard that blocks `__proto__`, `prototype`, and `constructor` segments in dotted config keys now uses inline literal comparisons at each property-write site (instead of a pre-loop `Set` check), so CodeQL's `js/prototype-pollution-utility` analysis recognises it as a sanitising barrier and code-scanning alert #26 clears. Runtime behaviour is unchanged from #663. Added regression tests that drive schema-valid dynamic-prefix keys (`agent_skills.__proto__`, `agent_skills.constructor`, `features.__proto__`, `review.models.constructor`) all the way to the guard — these reach `setConfigValue` past the schema gate and were previously the guard's only untested attack surface. (#751)
