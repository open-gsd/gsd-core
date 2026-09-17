---
type: Fixed
pr: 4826
---
**Roadmap queries read past hard-wrapped Goal/Requirements fields** — the roadmapper soft-wraps long fields at ~85 chars, but five single-line field regexes truncated every wrapped Goal/Requirements at the first line: plan-phase's phase_req_ids silently dropped continuation-line REQ IDs (escaping the Requirements Coverage Gate), get-phase/analyze cut the goal mid-sentence, and phase complete left later REQs Pending with empty warnings. A shared multiline extractor now reads wrapped fields to the next field label. (#4731)
