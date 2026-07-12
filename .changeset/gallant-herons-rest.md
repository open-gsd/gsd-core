---
type: Fixed
pr: 0
---
**`requirements mark-complete` no longer reports silent success when the traceability row is missing** — it OR-ed its checkbox and table-row writes into one flag, so a checkbox-only reconcile returned a payload byte-identical to a full reconcile while the traceability row stayed Pending (and re-run masked it as already-complete). It now surfaces `table_unmatched` for IDs whose checkbox reconciled but whose table row is absent, and treats a checked box with no table row as partial rather than done. (#2140)
