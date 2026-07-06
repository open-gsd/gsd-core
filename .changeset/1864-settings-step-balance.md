---
type: Fixed
pr: 2014
---
**`settings-advanced.md` no longer has an orphan `</step>` around §8 Model Policy** — the §8 Model Policy block ended with a closing `</step>` but had no matching opening tag (5 opens / 6 closes), leaving its content as loose inter-step prose that could fail to execute reliably. Added the missing `<step name="model_policy">` opener so the section is a proper step. A new workflow `<step>`-tag-balance regression guard (fenced-code-stripped) now blocks any future orphan tag across all top-level workflows. (#1864)
