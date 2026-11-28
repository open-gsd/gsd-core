# Runtime identity: why the PATH branch and the anchored probe

> Explanation. This page records why the `gsd-tools` launcher defends against a foreign
> binary the way it does. The behavior and the verb are in the
> [Runtime Identity feature entry](../FEATURES.md); the diagnostic steps are in
> [Diagnose which gsd-tools is running](../how-to/diagnose-a-foreign-gsd-tools.md).

## The defect: two packages, one binary name

The predecessor package `get-shit-done-cc` publishes a binary named `gsd-tools`, and so does
this one. They answer some of the same verb names with different semantics.
[#3129](https://github.com/open-gsd/gsd-core/issues/3129) is the worked example:
`phases.clear` archives here and deletes there. Both print success-shaped output, and
`.planning/` is gitignored by default, so a user lost 43 phase directories with no error, no
warning, and nothing recoverable from git. The failure was silent in both directions — the
workflow could not tell it had reached the wrong handler, and the handler could not tell it
had been called by a workflow written for a different contract (#3146).

## Why two defenses, one structural and one asserted

The launcher's `PATH` resolution branch looks for `gsd_run` instead of `gsd-tools`. Only this
package publishes `gsd_run`; the predecessor publishes `gsd-tools` and `gsd-sdk`. Our
`gsd_run` follows its own symlink chain and executes the `gsd-tools.cjs` sitting beside it,
so resolving it cannot land on a foreign handler. That guarantee is structural.

The path-based branches (a project-local install, a runtime config directory) have no such
guarantee: they trust their configured location. So once resolution finishes, and before any
verb runs, the preamble probes the tool it picked with `runtime-identity --raw`. That
guarantee is asserted.

## Why the match is anchored at both ends

A substring search for `@opengsd/gsd-core` accepts the decoy
`{"packageName":"get-shit-done-cc","note":"@opengsd/gsd-core"}`, which any colliding package
could publish. The preamble instead requires the payload to begin with
`{"packageName":"@opengsd/gsd-core"` and to end with a closing brace, so a truncated answer
fails as well. Closing on `}` costs nothing in future-proofing: a JSON object's own brace is
always the last character, whatever type the last value has.

## Why the status is a value

`GSD_IDENTITY_STATUS` (`ok` / `unverified`) exists so the gate can be tested — and read by a
later step — without anyone parsing the warning text.

## Why the assertion arrived second: the byte budget

The preamble is inlined into 113 shipped files, several of which sat within single-digit
bytes of frozen size ceilings — `agents/gsd-verifier.md` had 2 bytes of headroom — and those
caps are red lines, not budgets. A first attempt to inline an assertion broke five of them.
What made it fit was collapsing the resolver's twenty near-identical `elif [ -f … ]` arms
into a single candidate-list helper, which is worth far more bytes than the assertion costs:
the preamble is now 1,876 bytes smaller than the version that carried no assertion at all, so
every one of the 113 files moved away from its ceiling.

## Why it fails closed

If no `gsd_run` is reachable, the resolver falls through its remaining path-based branches
and finally errors with an install command. It does not fall back to executing whatever
`gsd-tools` happens to be on `PATH` — that fallback was the vulnerability.

## Why a doubly-sourced preamble cannot build a recursive launcher

`command -v gsd_run` finds the shell function on a second source and would return the bare
string `gsd_run`, defining the function in terms of itself. `unset -f gsd_run` leads that
branch, so the second source resolves exactly as the first did. An executability guard was
tried here instead and removed: it rejected the bare name, fell through every branch, and hit
the resolver's `exit 1` — which, in a sourced script, kills the caller's shell.
