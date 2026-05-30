---
type: Removed
pr: 522
---
Retire the gsd-sdk shim/command. GSD now invokes gsd-tools query <command> (behaviorally identical via gsd-tools' query meta-prefix) everywhere; the vestigial gsd-sdk shim builder, installer wiring, and the #3406 stale-standalone-sdk shadow warning are removed.
