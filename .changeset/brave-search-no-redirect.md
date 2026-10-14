---
type: Fixed
pr: 59
---
Brave web search no longer follows HTTP redirects, so the X-Subscription-Token header cannot be forwarded to another host; a redirect now reports an API error.
