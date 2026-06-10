---
type: Added
pr: 843
---
Issues are now checked for duplicates when opened: a no-LLM title-similarity check posts a challenge comment and applies a `possible-duplicate` label when a new issue closely matches existing open ones. Flagged issues that go unanswered for 24h are auto-closed as duplicates (reply, or react 👎 to the bot comment, to keep one open); a reply clears the label and routes to `needs-maintainer-review`. (#836)
