# Phase Argument Parsing

Parse and normalize phase arguments for commands that operate on phases.

## Extraction

From `$ARGUMENTS`:
- Extract phase number (first numeric argument)
- Extract flags (prefixed with `--`)
- Remaining text is description (for insert/add commands)

## Using gsd-tools

The `find-phase` command handles normalization and validation in one step:

```bash
PHASE_INFO=$(gsd_run query find-phase "${PHASE}")
```

Returns JSON with:
- `found`: true/false
- `directory`: Full path to phase directory
- `phase_number`: Normalized number (e.g., "06", "06.1")
- `phase_name`: Name portion (e.g., "foundation")
- `plans`: Array of PLAN.md files
- `summaries`: Array of SUMMARY.md files

## Manual Normalization (Legacy)

Zero-pad the leading integer to 2 digits. Preserve a letter suffix and any dotted
segments — the canonical grammar in `src/phase-id.cts` (`normalizePhaseName`):
`8 → 08`, `2.1 → 02.1`, `3A → 03A`, `23.1.2 → 23.1.2`.

```bash
# Normalize phase number
# #4748: one branch for the whole canonical token — digits, optional [A-Z],
# dotted segments. Pad through $((10#…)) so an already-padded `08` is not read
# as octal by printf; anything non-canonical passes through untouched.
if [[ "$PHASE" =~ ^([0-9]+)([A-Z]?)((\.[0-9]+)*)$ ]]; then
  PHASE_INT=${BASH_REMATCH[1]}
  PHASE=$(printf "%02d" "$((10#$PHASE_INT))")${BASH_REMATCH[2]}${BASH_REMATCH[3]}
fi
```

## Validation

Use `roadmap get-phase` to validate phase exists:

```bash
PHASE_CHECK=$(gsd_run query roadmap.get-phase "${PHASE}" --pick found)
if [ "$PHASE_CHECK" = "false" ]; then
  echo "ERROR: Phase ${PHASE} not found in roadmap"
  exit 1
fi
```

## Directory Lookup

Use `find-phase` for directory lookup:

```bash
PHASE_DIR=$(gsd_run query find-phase "${PHASE}" --raw)
```
