# Custom phase IDs

The identity rules for phases created with `"phase_naming": "custom"`: how an ID becomes a directory, which IDs are refused, and how readers resolve a directory to its owner. The keys are in [Core Settings](../CONFIGURATION.md#custom-phase-directories); the verb is `gsd-tools phase add --id` in the [CLI reference](../CLI-TOOLS.md).

`gsd-tools phase add "Product boundary" --id PRODUCT-BOUNDARY` creates
`.planning/phases/CCM-PRODUCT-BOUNDARY-product-boundary/`. The optional
`project_code` prefixes the directory; pass the ID without that prefix.
Add-batch derives custom IDs from its descriptions. Creation validates the
whole batch before writing any directories or updating the roadmap.

Custom IDs must be nonempty and contain no whitespace, colons, path separators,
`..` or NUL, and cannot start with `[`. IDs equivalent to an existing recorded
ID, roadmap declaration or another ID in the batch are refused, including case
and numeric-padding aliases. Prefix pairs such as `SETUP` and `SETUP-2` are
allowed when their directory-owned markers establish separate identities.
IDs in the readers' reserved backlog and icebox ranges are also refused
(for example `0`, `0.5`, `00-00` and `999`); those phases would be hidden from
ordinary phase listings. Digit-leading IDs such as `2FA` and `7B` remain valid.

New custom directories contain a regular UTF-8 `.phase-id` file with the exact
ID, without the project prefix or slug. Readers use that record even after
roadmap edits or archival. Existing markerless custom directories continue to
resolve and can be removed when exactly one known owner matches. An ambiguous
removal or rename refuses and names the candidates; write the correct owning ID
into that directory's `.phase-id` to resolve the ambiguity. Read-only lookups
never refuse: when a markerless directory could belong to overlapping IDs such as
`SETUP` and `SETUP-2`, the longest declared ID that prefixes the directory name
owns it. Put the exact owning ID, without the project prefix or title slug, in
the directory's `.phase-id` to pin it. Numeric phases
without custom identity records, including their inserted decimal children,
retain numeric renumbering.

`phase add --id` returns a usage error unless effective `phase_naming` is custom;
previously it wrote a directory that readers could not resolve. A project config
shadows global defaults, including when that project config is `{}`. Set custom
naming in the effective project config rather than relying on a shadowed global
default. A corrupt project config reports its parse failure instead.
