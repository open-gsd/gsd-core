---
type: Fixed
pr: 2058
---
**`gsd-tools config-set <key> null` now clears (removes) the key instead of persisting the literal string `"null"`.** The documented "Clear" action previously fell through the value parser and stored `"null"` — a truthy value — so "cleared" keys stayed set and `config-get` returned `"null"`; for secret keys (`brave_search`/`firecrawl`/`exa_search`) a masked success line hid a truthy value on disk that integrations could pass along as a real credential. `config-set <key> null` now deletes the key (short-circuiting the typed per-key validators so clearing an enum/boolean/number key removes it rather than being rejected), making the "Clear" flows in `settings-integrations.md` / `settings-advanced.md` actually clear.
