---
type: Fixed
pr: 0
---
**init.manager stops reporting dates, shas and ledger ids as phase dependencies** — dep_phases scraped every digit run out of a phase's Depends-on prose, so phases whose prose declares no dependency read as blocked (dates split into year/month/day, git shas fragmenting, WINDOWS ledger ids, even the phase's own number); extraction now pulls only Phase-prefixed references — including "Phases 1, 2, and 3" lists and "Phase 1-3" ranges — and planning-inspect's dependencies field uses the same anchored grammar. (#4764)
