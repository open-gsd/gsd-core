---
type: Changed
pr: 6111
---
**`npm test` fails when product code raw-writes a file named `STATE.md` outside the STATE.md write seam** (#5120, epic #4629): a test-time check of the written path's value, installed for every test chunk and every subprocess that inherits `NODE_OPTIONS`, with the seam-write counts printed beside the zero and no allowlist. The `/gsd-roadmap-upgrade` rollback restores STATE.md byte-exactly under the STATE.md lock, and MCP `gsd_write_state` (the `filesystem` stateIO adapter) writes a `STATE.md` destination under the lock through the seam, so it lands the seam's normalized markdown rather than the exact bytes and waits for a held lock.
