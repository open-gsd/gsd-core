---
type: Fixed
pr: 5406
---
**Reviewer HTTP lanes no longer forward plans through redirects** — Model discovery and chat completion refuse every 3xx response, report a clear failure, and ignore redirect bodies.
