---
type: Added
pr: 6561
---
**`state prune --keep-recent-quick N` keeps the newest N Quick Tasks rows and moves the older ones to STATE-ARCHIVE.md** — opt-in; rows move verbatim under a copy of the table header, directory-less `/gsd-fast` rows included, and a run with only this option needs no phase position. Without it `state prune` is unchanged. It refuses while a quick-task batch has an unfinished item. Rows appended without a quick id after a prune get the next free number, and W031's remedy names the option.
