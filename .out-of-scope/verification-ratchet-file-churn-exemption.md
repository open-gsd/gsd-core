# Exempting or refusing ratchet and pin files declared as verification evidence

**Source:** [#6234](https://github.com/open-gsd/gsd-core/issues/6234)
**Decision:** wontfix — by design: a covered file's bytes are part of `covered_digest`
**Date:** 2026-11-17

## Proposal summary

A phase that declares a source-tree ratchet or pin file (a line-count budget module, an expected-skips pin, a lint allowlist, a measured-seconds table) in `covered_files` goes stale every time a later, unrelated phase rewrites that file, because `isSharedPlanningDoc` (`src/verification.cts`) exempts only direct children of a planning root (#4623). The reporter asked for one of two shapes: byte-skip a declared class of churn files wherever they sit, or refuse such a path at the `verification.fingerprint` write seam so the covered set never contains one. They measured the effect with a digest A/B on a real repository and noted their own install refuses two hard-coded file names.

## Why GSD does not own this

- **The digest is defined over covered bytes.** A declared covered file whose content changes must change `covered_digest`; that is the contract, and the fail-closed staleness behavior was kept on purpose (see `stale-verification-completion-split.md`, ADR-5057).
- **The churn class is not derivable.** Nothing in the file's path, content or the phase's report says "a ratchet rewrites this on every phase". The reporter's own patch hard-codes two names and misses a third in the same repository, so any class rule GSD chose would be an enumeration that is wrong for the next project.
- **The cause is the declaration.** A phase that lists a ratchet or pin file as its covered evidence has chosen evidence that other phases are expected to rewrite; the planning-document exemption of #4623 exists because those files are ordinary bookkeeping that GSD itself writes, which is not true of a project's own ratchet files.
- **Acknowledged:** the staleness the reporter measured is real and is not the ground for rejection.

## What this does NOT cover

- Reducing false staleness through an owner that is declared rather than guessed (for example a configuration-owned list of files excluded from every digest), which stays welcome.
- Wording of the stale remedy text, which is presentation and may be proposed separately.
- A bug where a digest, status or remedy contradicts ADR-5057, or where `verification.fingerprint` mis-hashes a declared file.

## Re-open criteria

A concrete, declarative owner for "this file is excluded from covered digests" (a configuration key or a report field that the user, not GSD, fills in), with the digest property tests and a positive control updated to match, so that GSD never has to guess which files are churn files.

## Related

- `.out-of-scope/stale-verification-completion-split.md`
- #4623, #4907, #4953, #5851
