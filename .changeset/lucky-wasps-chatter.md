---
type: Changed
pr: 1062
---
**The planner now blocks plans that would self-trip their own verify gate** — when an acceptance criterion negative-greps for a literal (`grep -c 'LIT' file == 0`) and that same literal appears verbatim in an `<action>` body, plan creation now fails at write time instead of letting the executor waste cycles on a comment-text echo at commit time. Unquoted/ambiguous grep targets warn instead of failing; add `<!-- planner-discipline-allow: LIT -->` to allowlist a legitimate occurrence. (#1062)
