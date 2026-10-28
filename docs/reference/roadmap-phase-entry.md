# ROADMAP.md phase-list entry grammar

A phase-list entry is the checklist bullet that summarises one phase in `ROADMAP.md`, for example `- [ ] **Phase 3: Authentication**`. Every command that reads a ROADMAP checklist (`validate consistency`, `validate health`, `roadmap analyze`, `roadmap get-phase`, `phase insert`, `phase next-decimal`, `phase complete`) recognises an entry with the same grammar, defined once in `src/phase-entry-grammar.cts` (#5763).

---

## Accepted forms

An entry is one line, and every part below is matched the same way by every reader:

| Part | Accepted | Notes |
| :-- | :-- | :-- |
| Indent | any spaces or tabs | The entry must start its line. A mention in the middle of a sentence, or after `>`, is not an entry. |
| Bullet marker | `-` or `*` | |
| Checkbox | `[ ]`, `[x]`, `[X]` | `x` and `X` are both ticked. |
| Bold wrapper | `**Phase N: Name**` or `__Phase N: Name__` | Optional, except where a reader needs the index form (below). A single `*` is not a bold wrapper. |
| Gaps | spaces or tabs, none required | A line break between the marker, the box and the label ends the match. |

`roadmap analyze` and the entry that `phase add` / `phase insert` write require the bold wrapper, because a plain bullet is not an entry `roadmap analyze` reports on. A plain `- **Phase 36 — Name**` bullet without a checkbox is also accepted where the roadmapper writes that house style.

## What changed

Readers used to disagree on these inputs; they now agree:

| Input | Before | Now |
| :-- | :-- | :-- |
| `* [x] **Phase 1: Name**` | Found by some readers only | Found by all |
| `- [X] **Phase 1: Name**` | Read as unticked by `roadmap analyze` | Ticked everywhere |
| `- [ ] __Phase 1: Name__` | Found by `phase complete` only | Found by all |
| `text - [ ] Phase 1` (mid-line) | Treated as an entry by readers without a line anchor | Not an entry |
| `-` newline `[ ] Phase 1` | Matched across the line break | Not an entry |

A ROADMAP.md that parsed before still parses: the accepted set only grew, apart from the last two rows, which were never real entries.

## Where the pattern lives

The prefix (indent, marker, checkbox, bold wrapper) is built by `phaseEntryPrefixSrc` and `phaseEntryRegExp`; the tick is read by `isPhaseEntryChecked`. Readers add only their own tail (the `Phase` label, the id token, the separator). Writers that splice, flip, delete or renumber an entry keep private patterns until #5764.
