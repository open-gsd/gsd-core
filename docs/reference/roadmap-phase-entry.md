# ROADMAP.md phase-list entry grammar

A phase-list entry is the checklist bullet that summarises one phase in `ROADMAP.md`, for example `- [ ] **Phase 3: Authentication**`. Every command that reads or rewrites a ROADMAP checklist entry (`validate consistency`, `validate health`, `roadmap analyze`, `roadmap get-phase`, `phase insert`, `phase next-decimal`, `phase complete`, `phase remove`, `roadmap update-plan-progress`, `roadmap upgrade`) recognises an entry with the same grammar, defined once in `src/phase-entry-grammar.cts` (#5763 for readers, #5764 for writers).

---

## Accepted forms

An entry is one line, and every part below is matched the same way by every reader:

| Part | Accepted | Notes |
| :-- | :-- | :-- |
| Indent | any spaces or tabs | The entry must start its line. A mention in the middle of a sentence, or after `>`, is not an entry. |
| Bullet marker | `-` or `*`, followed by one to four spaces or tabs | `-[ ] Phase 1` is not a Markdown list item, so it is not an entry. |
| Checkbox | `[ ]`, `[x]`, `[X]` | `x` and `X` are both ticked. |
| Bold wrapper | `**Phase N: Name**` or `__Phase N: Name__` | Optional, except where a reader needs the index form (below). A single `*` is not a bold wrapper. |
| Gaps | spaces or tabs; none required between the box and the label | A line break between the marker, the box and the label ends the match. |

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
| `-[ ] Phase 1` (no space after the marker) | Matched by readers; `phase complete` skipped it | Not an entry |
| `* [ ] **Phase 2: Name**` under `phase complete`, `phase remove`, `roadmap update-plan-progress` | Writers only found `-` bullets | Ticked, deleted, renumbered or stamped like any other entry |
| `- [X] **Phase 2: Name**` under `phase remove` | Not deleted | Deleted |
| `text - [ ] Phase 2: Name` (mid-line mention) under `phase remove` | Deleted or renumbered | Left alone |
| Indented `  - [ ] **Phase 1: Name**` under `phase complete` | Indent removed by the tick | Indent kept |
| `- [ ] *Phase 2: Name*` (a lone `*` wrapper) under `roadmap upgrade` | Rewritten | Left alone, as every reader already did |
| `- [ ] **Phase 5**: needs Phase 2: X` under `phase remove 2` | Deleted | Left alone: the first `Phase` on the line is its own label |
| Plan rows nested under an entry, after a less-indented line (`roadmap update-plan-progress`) | The nested rows ran on past the less-indented line | The nested rows end at the less-indented line |

A ROADMAP.md that parsed before still parses: the accepted set only grew, apart from the mid-line, line-break and no-space-after-marker rows, which were never real entries.

`phase remove` is the one writer that also deletes and renumbers a decorated entry, such as the struck-through `- [x] ~~**Phase 4: Delta**~~` of a retired phase or an emoji before the label, which the readers skip: left alone, two entries would end up with one number. The decoration may not contain the word `Phase`.

## What is not a phase-list entry

Other checkbox lines keep their own patterns because they are not phase entries: requirement rows (`- [x] **REQ-1**`), plan rows (`- [ ] 01-01-PLAN.md`), and the generic checkbox bullets of the markdown sectionizer. The phase-number declaration scan in `src/phase-id.cts` (`buildPhaseDeclarationScans`) is also deliberately wider than an entry: any text inside the box, numbered-list rows and bracket-id bullets count, because over-counting a declared number is harmless and reusing one is not.

## Where the pattern lives

The prefix (indent, marker, checkbox, bold wrapper) is built by `phaseEntryPrefixSrc` and `phaseEntryRegExp`; the tick is read by `isPhaseEntryChecked`. Readers add only their own tail (the `Phase` label, the id token, the separator). Writers that flip, delete, renumber or rewrite an entry build their pattern the same way: `phaseEntrySplitRegExp` returns a pattern whose first group is everything through the opening `[` and whose second group runs from the closing `]` to the end of the entry, so a tick is a replace of `$1x$2` that keeps the entry's indent, marker, gaps and bold token as written. `tests/phase-entry-grammar-agreement.test.cjs` generates entries in every accepted form and runs each reader and each writer over them.
