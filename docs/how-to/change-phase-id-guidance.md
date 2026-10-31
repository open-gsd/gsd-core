# Change generated phase-ID guidance

The full agent definitions and phase-emitting instruction wrappers carry a short,
canonical region. It states the identity rule, names the CLI `display_id` field,
and directs a lazy Read of `gsd-core/references/phase-id-convention.md` before
emitting identities. It contains no grammar diagram, source line numbers or eager
`@` import. The reference owns complete rules and the canonical card.

Edit the typed `PHASE_ID_RULES` or the short renderer in `src/phase-id-card.cts`,
then run `npm run build:lib`. Regenerate and verify:

```bash
node scripts/gen-phase-id-convention.cjs --write
node scripts/gen-phase-id-convention.cjs --check
```

Never edit managed bytes by hand. The generator preflights every selected file
before writing; malformed or nested markers cause a zero-write failure. It
preserves unmanaged bytes and line endings. `lint:generated-sync` runs its check.

## Selection and copied artifacts

`TARGETS` pins full agents, phase-emitting workflows and template instruction
wrappers. Regions in wrappers sit outside copied Markdown fences. Copy only the
artifact body. Raw artifact bodies, including autonomous's minimal CONTEXT.md,
carry no region. Reviewed existing artifact formats outside this instruction
scope are explicit exclusions; an unlisted new phase-emitting template is an
error. Compact variants and user-facing help output remain outside approval.

Add a deliberate target only after checking its instruction role and its size
cap; add a regression when changing selection. The independent walk includes
agents, workflows and templates. Evidence checks reject handwritten convention
prescriptions, variable phase labels and reconstructed phase paths outside
managed regions. Defined legacy artifact examples remain in copied fences;
the two legacy execution-summary titles are explicitly sequential-only.

## Identity and legacy output

Use returned writer/CLI identities and paths. Phase labels use `display_id` from
CLI phase rows (init, progress and stats); Progress table cells instead use the
numeric reader identity from `phase_number`, with the project-code prefix removed.
Do not put `Phase N` or bracket display labels in that machine-readable column.
Keep backlog creation on its existing layout and round-trip its returned number
through `find-phase`. No parser, grammar, writer or migrator change is involved.

Sequential summary bodies, execution titles and prior-summary paths retain their
legacy rendering. For other conventions substitute returned identities and paths.
Run the template-to-reader and backlog creation-to-lookup regressions under all
three conventions, without repairing the rendered fixture.

## Verification and size

Run build, `lint:ci`, `lint:changeset`, the generator check and touched test files,
then the clean-recipe full suite alone. Existing caps are fixed. The short region
replaces the full inline card to reduce repeated dispatch content; an eager
reference import does not reduce loaded content. See
[acknowledge emitted drift](acknowledge-emitted-drift.md) for that distinction and
the commit-trailer procedure. Any cap-required extraction must be conditional and
lazy; record its measured before/after size.
