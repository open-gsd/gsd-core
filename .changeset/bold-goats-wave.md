---
type: Fixed
pr: 9999
---
**api-coverage detector no longer false-positives non-API phases** — the external-API-integration detector behind the blocking `verify:pre` seal gate required only same-line co-occurrence of an integration verb and an API noun, treated `/` as a word boundary (so first-party Next.js `src/app/api/…` route paths matched), and read any capitalized word before API/SDK/REST/GraphQL as a service name (so threat-model prose like "Resolver-only API" fired). The compound rule now requires the verb and noun to share one clause within a bounded word gap; fenced code, inline code spans, and path-shaped tokens are excluded before matching; and the `<Service> API` surface rule requires proper-noun position (or dependency evidence on the line) and rejects compound modifiers. A phase that integrates no external API can now declare it first-class in COVERAGE.md — `No external API integration: <reason>` — instead of fabricating a matrix row (#2365)
