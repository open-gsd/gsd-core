# Audit-UAT fixtures (#2286, fixed by #2317)

Verbatim reproduction files from #2286, driven through `gsd-tools
audit-uat --raw` (the real CLI gate) rather than `parseUatItems` /
`parseVerificationItems` called in isolation.

- `gaps-section-uat.md` — a UAT file whose only outstanding finding lives
  in a `## Gaps` bullet entry.
- `human-verification-frontmatter.md` — a VERIFICATION file whose
  frontmatter declares a structured `human_verification:` array.

This is the one corpus in `tests/fixtures/representative/` with **no**
`todo` marker. #2286 was fixed by #2317 (merged) before this corpus was
written, so `total_items >= 2` is a normal, currently-passing assertion —
proof that a representative fixture, driven through the real gate, is not
automatically doomed to fail. It demonstrates the methodology working end
to end, not just the gaps it finds in the other three gates.
