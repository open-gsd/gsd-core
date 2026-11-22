---
type: Fixed
pr: 0
---
**The TDD gate finds a RED commit made of capitalised test files** — the task router already treated `Tests/foo.rs`, `Foo.TEST.js` and `Foo_Test.go` as test files, but the gate's RED-commit search used plain git pathspecs, which are case-sensitive, so a RED commit touching only such files was invisible and the gate reported a missing RED commit; the gate now passes the same shared list behind git's `:(icase)` magic, so router and gate agree on letter case for the paths the gate already matches, and lowercase layouts behave as before. (#5766)
