---
type: Added
pr: 6006
---
**Plans can record a checkable baseline for every count/match gate** — write `[HEAD=<value> EXPECT<op><value>]` beside a criterion and `verify plan-structure` rejects one that already holds at HEAD (a gate that passes whether or not the work happens), warns on the old free-form `# baseline at HEAD:` comment, and reports unreadable notations without changing the exit code. (#4309)
