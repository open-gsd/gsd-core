# OpenCode V2 worktree transport

OpenCode dispatches GSD executor work through the `gsd_worktree_task` native
tool. The transport uses only OpenCode V2 APIs. It does not invoke
`opencode run`, create detached executor sessions, relocate sessions with
`session_move`, shell-poll, or use a legacy `wait` action. A missing native tool
is a fail-closed condition, not permission to substitute a process transport.
Claude, Codex, Kilo, Kimi, and other process-based runtimes retain their
descriptor-selected process argv/cwd behavior; this native contract applies
only when the descriptor selects `exec.transport == "native-tool"`.

## Flat V2 plugin and provisioning

The OpenCode V2 integration has one self-contained CommonJS descriptor at
`.opencode/plugins/gsd-core.js`, with public ID `gsd-core`. It registers the
core hooks, `gsd_worktree_task`, and the
`gsd-worktree-task.attestation.v1` RPC, and its setup returns one unified
reverse-order cleanup path. The authored implementation lives under
`src/opencode-v2-plugin/**`; the generated descriptor does not load a package
directory entrypoint, a sibling plugin, or a runtime dependency from an
ancestor `node_modules` tree. It contains its required OpenCode runtime code.

The V2 bundle builder owns exactly two outputs: that flat plugin and the
separate CLI helper `gsd-core/bin/lib/opencode-v2-attestation.cjs`. The helper
also has its linked source map and third-party notice; the flat plugin has no
plugin map or sidecar notice. The installer/package's OpenCode plugin surface
ships exactly `.opencode/plugins/gsd-core.js`.

For project-local provisioning, after Git creates each new OpenCode linked
worktree, the lifecycle copies the complete local `.opencode` tree into that
worktree. If the source tree is absent this is a successful no-op. If copying
fails, lifecycle rollback removes only that newly created worktree; it does
not tear down existing worktrees or the parent project.

Native quick-batch worktrees are created under the established ignored
`.claude/worktrees` root, outside the source `.opencode` tree. This prevents
the provisioning copy from recursing; the provisioner also rejects any
destination inside the source `.opencode` tree.

## Durable wave lifecycle

The current parent starts every eligible same-wave child with one shared wave
ID, exact manifest path and agent identity, canonical worktree directory,
explicit agent/provider/bare-model/medium-or-high effort, and bounded timeout.
All starts are accepted before one exact seal of the complete returned
session/directory set. A subset, extra job, duplicate, unknown identity, or
differing reseal fails closed.

The plugin imports each child under the real current parent at its target
worktree. It durably observes the sealed wave and queues one
`gsd_worktree_wave_completed` notification when the wave becomes terminal. That
notification is only a wake-up signal. It is model-visible, replayable, and
never job-selection, status, attestation, or mutation authority.

On resume, the same current parent calls parent-scoped `recover`, reconciles the
complete wave with its retained start/seal records, and obtains fresh `status`.
After a required OpenCode/OpenChamber restart, the operator uses the normal
application restart, resumes the same parent session in the same canonical
`$PROJECT_FOLDER`, and then performs that recover/status sequence. If the
parent, project, plugin version/hash, agent registry, or wave identity cannot be
proved, execution stops with resources preserved. Shell process termination,
guessed PIDs, nested OpenCode execution, detached sessions, and self-move are
not recovery mechanisms.

The parent records each quick-batch round in a crash-visible journal under
`.opencode/.runtime/gsd-worktree-waves/`. Journal mutations use immutable
owner and ticket records, durable replacement, and a non-waiting bakery lock.
They require a positively identified local filesystem and reject symlinked
journal path components.

Before merge, the parent must literally observe a fresh native-tool `status`
result with `merge_ready: true`. A notification is only a wake-up signal and
never authorization. The model then invokes coordinate-only
`quick-batch v2-attest`; the helper discovers the compatible managed OpenCode
service and obtains the authoritative status bytes over the registered
`gsd-worktree-task.attestation.v1` RPC. Caller-supplied status, recovery,
endpoint, header, and BATCH evidence is rejected.

The helper validates the whole RPC wave before selecting an item: exact
parent/wave, one complete sealed expected job set, literal `merge_ready:true`,
empty reasons, freshness and bounded observation interval, managed-service
provenance, manifest snapshots, and every requested/live executor identity. It
then selects exactly one job whose session ID equals the journal item's bound
session and validates that item's directory, manifest agent, executor,
provider/model/variant, parent, final self-recursion deny, and successful
terminal outcome. Missing or duplicate bound sessions, a wrong-item session,
or a malformed unrelated sibling fails before item authorization.

Freshness is checked twice. The first RPC attestation precedes read-only merge
preparation and `merge_intent`. After preparation and durable `merge_intent`,
the model observes native status again and the helper refreshes the RPC
attestation. `quick-batch v2-merge` then requires the exact parent, batch,
round, item, expected revision, prepared child and target tips, refreshed
digest, and manifest identity. The journal must still be at `merge_intent`, the
RPC provenance must be native and no more than 30 seconds old, and the current
manifest/agent/worktree/branch must match before the route calls the approved
merge primitive. The native route passes a journal-derived absolute expiry and
a journal revision/digest/phase/tip callback into that primitive; both are
rechecked immediately before the target `update-ref` compare-and-swap, so time
spent in merge-tree, policy, identity, or inventory preflight cannot consume
expired authority. Unknown, duplicate, or omitted fields fail closed. The legacy
`query worktree.merge-one` mutation route refuses active native manifests;
process-host manifests keep their existing behavior.

The authorized route records a successful merge in the journal under the same
journal lock. `merged_sync_pending`, compare-and-swap movement, and real merge
conflicts preserve the worktree, branch, and data. `unsupported_policy` and
`unsupported_git_capability` are recoverable, nonterminal environment results.
The transport requires Git with behavioral support for two-argument
`merge-tree --write-tree`; it does not rely on a version string. Effective
signed-merge policy and porcelain merge hooks are unsupported, including a
policy introduced between prepare and mutation.

Teardown uses only `quick-batch v2-teardown`. It requires the journaled
`teardown_pending` state, exact native identity, and the merged child tip; the
legacy teardown route refuses native ownership. Resources are removed only
after the exact merge has been durably recorded. For a multi-job wave, every
item receives both fresh attestations and every merge is durably journaled while
all wave worktrees remain present. Teardown starts only after the all-merged
barrier. No plugin status is requested or expected after the first teardown,
because removal intentionally makes the prior complete-wave status inapplicable.

Legacy `worktree.cleanup-wave` scans every raw caller-manifest entry before it
plans or mutates anything. If native metadata or any path/branch/manifest token
matches an active native journal item, the whole cleanup is rejected with zero
merge, removal, or branch-deletion side effects. This also covers copied
manifests with native metadata stripped; process-only manifests are unchanged.

When validation is enabled, the verification step calls coordinate-only
`quick-batch v2-verify`. The helper resolves no sibling: it reads the exact
quick-item verification artifact once into a `Buffer`, strict-admits and
canonically evaluates that same captured byte sequence, and hashes those same
bytes. Strict admission requires the exact canonical item filename, a regular
non-symlink file, fatal UTF-8 decoding, exact frontmatter fences, and exactly one
unquoted canonical top-level status scalar. Canonical evaluation includes current declared fingerprint coverage or
legacy SUMMARY-clock staleness. Only current, determinate `passed` evidence
mints an authorizing receipt. Current, well-formed, determinate `gaps_found` and
`human_needed` evidence may persist compatibility receipts, but they bind only
failed/blocked outcomes and never authorize completion. Stale, malformed,
missing, unknown, or staleness-indeterminate evidence persists no receipt and no
BATCH outcome. Generic
`quick-batch complete` cannot mint this receipt and refuses active native items;
coordinate-bound `v2-complete` checks it before invoking the existing
exactly-once completion primitive. The `completed` transition and round close
reread and canonically re-evaluate the exact artifact and current covered inputs
before comparing path, status, and SHA-256. Changed covered bytes therefore
revoke authorization even when report bytes are unchanged. Calling completion
first or supplying arbitrary transition JSON cannot prove verification. The
verifier's semantic judgment remains model-authored; the
trusted boundary proves which canonical artifact and status the helper read,
not that the model's judgment is objectively correct.

The flat descriptor and generated helper are loaded by the long-running
OpenCode V2 service and the coordinate-only CLI route respectively. After
installing or updating them, restart OpenCode/OpenChamber before dispatch and
follow the same-parent restart protocol above. Both project-local and global
installs resolve the project directory through OpenCode's location context and
discover the managed service; no machine-specific checkout or tool path is
embedded. `npm run check:opencode-v2-bundles` byte-compares the generated
outputs, so a fresh global or local install never performs a network install or
resolves the plugin through an ancestor `node_modules` tree.

## Threat boundary

Symlink rejection and exact-token cleanup are defense in depth for crashes and
races among compliant GSD processes. A malicious or buggy same-OS-user process
can directly replace or remove filesystem records; that behavior is outside
the supported threat model because portable Node.js has no inode-conditional
unlink primitive. Ambiguous records therefore fail closed and require manual
inspection rather than age-based takeover.

The merge primitive also cannot hold a repository-wide lock against arbitrary
same-user Git commands or direct writes. Such a process can race the small
post-CAS inventory/index synchronization window. The implementation preserves
detected collisions and supports exact retry, but it does not claim protection
from a hostile peer with the same OS identity.

This residual boundary does not weaken supported API guarantees: every
compliant GSD/OpenCode route still fails closed on stale, malformed, duplicate,
ambiguous, or mismatched evidence and rechecks authorization at its actual
mutation boundary.
