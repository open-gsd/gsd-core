---
type: Changed
pr: 176
---
`CommandRoutingHub` error results are now a typed discriminated union (ADR-0174 P1.2). The `errorKind` field is renamed to `kind` and each variant carries only its own typed payload: `UnknownCommand` → `{ kind, command }`; `InvalidArgs` → `{ kind, arg, reason }`; `HandlerRefusal` → `{ kind, reason }`; `HandlerFailure` → `{ kind, message, cause? }`. Factory functions `makeUnknownCommand`, `makeInvalidArgs`, `makeHandlerRefusal`, `makeHandlerFailure` are exported for handler and caller use. The generic `message`/`details` escape hatches are removed from Hub-emitted errors.

<!-- docs-exempt: internal refactor — Hub Result shape is SDK-internal (ADR-0174 P1.2); no public docs surface affected -->
