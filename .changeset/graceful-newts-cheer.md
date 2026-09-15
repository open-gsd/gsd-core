---
type: Fixed
pr: 4755
---
verify-command-paths no longer reports a false missing_dir blocker when a plan's <automated> command spells the chain operator entity-escaped (cd src &amp;&amp; npm test): the command text is now decoded to & before segment splitting, so the escaped and literal forms of the same command get identical verdicts (#4730)
