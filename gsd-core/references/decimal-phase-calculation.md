# Decimal Phase Calculation

Calculate the next decimal phase number for urgent insertions.

## Using gsd-tools

```bash
IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END' || true
$ARGUMENTS
GSD_ARGS_END
GSD_ARGS=${GSD_ARGS%$'\n'}
GSD_WS=$(echo " $GSD_ARGS" | sed -nE 's/.* --ws +([A-Za-z0-9][A-Za-z0-9._-]*).*/--ws \1/p' | head -n 1) # Read-loaded file: write the command's original argument string in place of $GSD_ARGS
# Get next decimal phase after phase 6
gsd_run query phase.next-decimal ${GSD_WS:+--ws=${GSD_WS##* }} 6
```

Output:
```json
{
  "found": true,
  "base_phase": "06",
  "next": "06.1",
  "existing": []
}
```

With existing decimals:
```json
{
  "found": true,
  "base_phase": "06",
  "next": "06.3",
  "existing": ["06.1", "06.2"]
}
```

## Extract Values

```bash
IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END' || true
$ARGUMENTS
GSD_ARGS_END
GSD_ARGS=${GSD_ARGS%$'\n'}
GSD_WS=$(echo " $GSD_ARGS" | sed -nE 's/.* --ws +([A-Za-z0-9][A-Za-z0-9._-]*).*/--ws \1/p' | head -n 1) # Read-loaded file: write the command's original argument string in place of $GSD_ARGS
DECIMAL_PHASE=$(gsd_run query phase.next-decimal ${GSD_WS:+--ws=${GSD_WS##* }} "${AFTER_PHASE}" --pick next)
BASE_PHASE=$(gsd_run query phase.next-decimal ${GSD_WS:+--ws=${GSD_WS##* }} "${AFTER_PHASE}" --pick base_phase)
```

Or with --raw flag:
```bash
IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END' || true
$ARGUMENTS
GSD_ARGS_END
GSD_ARGS=${GSD_ARGS%$'\n'}
GSD_WS=$(echo " $GSD_ARGS" | sed -nE 's/.* --ws +([A-Za-z0-9][A-Za-z0-9._-]*).*/--ws \1/p' | head -n 1) # Read-loaded file: write the command's original argument string in place of $GSD_ARGS
DECIMAL_PHASE=$(gsd_run query phase.next-decimal ${GSD_WS:+--ws=${GSD_WS##* }} "${AFTER_PHASE}" --raw)
# Returns just: 06.1
```

## Examples

| Existing Phases | Next Phase |
|-----------------|------------|
| 06 only | 06.1 |
| 06, 06.1 | 06.2 |
| 06, 06.1, 06.2 | 06.3 |
| 06, 06.1, 06.3 (gap) | 06.4 |

## Directory Naming

Decimal phase directories use the full decimal number:

```bash
IFS= read -rd '' GSD_ARGS <<'GSD_ARGS_END' || true
$ARGUMENTS
GSD_ARGS_END
GSD_ARGS=${GSD_ARGS%$'\n'}
GSD_WS=$(echo " $GSD_ARGS" | sed -nE 's/.* --ws +([A-Za-z0-9][A-Za-z0-9._-]*).*/--ws \1/p' | head -n 1) # Read-loaded file: write the command's original argument string in place of $GSD_ARGS
SLUG=$(gsd_run query generate-slug "$DESCRIPTION" --raw)
PLANNING_DIR=$(gsd_run query config-path ${GSD_WS:+--ws=${GSD_WS##* }} --raw) && PLANNING_DIR=${PLANNING_DIR%/config.json}
: "${PLANNING_DIR:?planning directory not resolved for this scope}"
PHASE_DIR="$PLANNING_DIR/phases/${DECIMAL_PHASE}-${SLUG}"
mkdir -p "$PHASE_DIR"
```

Example: `.planning/phases/06.1-fix-critical-auth-bug/`
