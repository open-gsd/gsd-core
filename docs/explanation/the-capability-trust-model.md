# The capability trust model

> **Status:** Implemented in ADR-1244 Phase 4 (`gsd-core/bin/lib/capability-trust.cjs`,
> `capability-lifecycle.cjs`). This document is the *honest* explanation of why GSD trusts
> third-party capabilities the way it does — including what it does **not** protect against.

GSD capabilities can ship the same executable artifacts GSD itself ships — hook scripts,
command modules, and (for third parties) MCP server declarations. That is full first-party
parity, chosen deliberately (epic #1244, alternative 2). Parity means a third-party
capability is, in the limit, **arbitrary code you have invited into your agent runtime**.
This page explains the barrier GSD puts in front of that invitation, and why the barrier is
*consent + integrity + reversibility* rather than a sandbox.

## Why there is no sandbox (Ask #1)

ADR-857 D8 originally earned "no sandbox" on a *declarative-only* premise: capabilities were
data, not code. This feature reverses that premise, so the justification must be re-derived on
grounds that survive third-party **code execution**. It is:

**GSD has no process boundary to interpose.** A capability's executable surfaces all run inside
the host agent runtime's own trust context:

- **hook scripts** run as the runtime's configured hook commands (your shell, your
  permissions);
- **command modules** are `require()`'d directly into the GSD CLI's own Node process;
- **MCP servers** are spawned by the host runtime, not by GSD.

GSD never forks a sandboxed child to run any of this. It *could* not meaningfully do so: the
runtime loads hooks and MCP servers itself, and a command module is in-process by definition.
A `sandboxTier` enum on capabilities that GSD does not actually enforce would be security
theater — worse than nothing, because it implies a boundary that isn't there.

The runtime descriptor's existing `sandboxTier` axis (`none` | `codex-agent-sandbox`,
`runtime-config-adapter-registry.cts`) is the **runtime's own** sandbox over everything it
executes — capability code included. That sandbox keeps applying. But it belongs to the
runtime (e.g. Codex's `workspace-write`), not to GSD, and GSD does not extend or simulate it.

So the barrier GSD owns is the same posture the Obsidian and VS Code marketplaces settled on
after their own supply-chain incidents:

1. **No execution at install.** Staging is copy-only. `npm` sources use `--ignore-scripts`;
   there is no `postinstall`. Installing a capability never runs its code.
2. **Integrity before extraction.** Tarball sources verify a `sha512` digest over the fetched
   bytes *before* anything is written to the install root; a mismatch aborts.
3. **Disclosure + explicit consent.** Every executable surface a capability declares is
   disclosed at install, and installing one that ships *any* executable surface requires
   explicit consent. Declining aborts cleanly, writing nothing.
4. **Namespace reservation.** Third parties cannot claim the `gsd-`, `gsd-core-`, or
   `anthropic-` id prefixes, so a hostile capability cannot impersonate a first-party one.
5. **Reversibility.** The ledger records exactly what each install wrote; `remove` deletes
   exactly those files and surgically strips exactly the shared-config entries the capability
   added, touching nothing the user owns.

Consent is meaningful precisely because (1)–(2) guarantee nothing has run *yet* when you are
asked, and (4)–(5) guarantee you can fully undo it. That is the trade GSD makes instead of a
sandbox it cannot honestly provide.

## `strictKnownRegistries` default (Ask #4a)

`capabilities.strict_known_registries` gates **install itself**, not merely auto-update.

| Value | Meaning |
| --- | --- |
| unset / `null` *(default)* | External installs (git / npm / tarball / registry) are allowed, each still passing the consent + integrity gate. Local filesystem installs always allowed. |
| `[]` *(explicit empty array)* | **Blocks all external installs** — managed/enterprise lockdown. Local installs only. |
| `["github.com", "registry.example.com"]` | Allowlist — only sources whose host matches an entry (exact host or a subdomain of it) are permitted. |

The default is **permissive-with-consent**, not Obsidian-style restricted-by-default. The epic
deliberately chose decentralized URL/git distribution over a curated-registry gate (alternative
3), so the consent prompt is the default barrier and full lockdown is one config key away. The
allowlist match is **host-based**, not substring: `github.com` does not match
`evilgithub.com`.

## The npm transitive-dependency boundary (Ask #4b)

`integrity` (sha512) pins **only the top-level fetched artifact** — the tarball, or the output
of `npm pack`. It does **not** pin the resolved dependency graph.

`--ignore-scripts` and copy-only staging stop *install-time* execution (no `postinstall`). But
when a capability's command module is later `require()`'d, Node resolves and executes that
module's **transitive dependency tree**, and sha512 says nothing about those packages — they
can be mutable or compromised independently of the pinned top artifact. This is exactly the
Wiz / VS Code supply-chain lesson.

For the `npm` source kind, therefore: a green integrity check means "the package tarball is the
one you pinned," **not** "every line of code that will run is the code you reviewed." Authors
who want a stronger guarantee should vendor their dependencies into the capability or ship a
lockfile; the consent prompt always discloses when a capability ships command modules, which is
the surface through which transitive code reaches your process.

## Where third-party code runs: command dispatch (Phase 5 / D7)

A capability may declare a **command family** (`commands: [{ family, module, router }]`). When you
run `gsd-tools <family> …`, GSD dispatches it by `require()`-ing the named module's router function.
This is the one place a third-party capability's own code executes in the GSD CLI process, so it is
gated twice:

1. **Consent.** A third-party family is dispatchable only if its capability has a **committed
   ledger entry** — i.e. you installed it through the lifecycle (and, for executable surfaces,
   consented). The loader records a dispatchable "command root" only for committed (non-`_pending`)
   capabilities; a bundle merely *present* on disk with no ledger entry still contributes its
   declarative surfaces (skills/agents/config) but is **not** command-dispatchable.
2. **Confinement.** The router module is loaded **from the capability's own install root** — a bare
   `.cjs` basename, `realpath`-confined to that directory, rejecting `..` traversal and symlink
   escape. A capability can never reach code outside its own bundle, and a first-party command
   (`graphify`/`intel`/`audit`, which ship in `bin/lib/`) can never be shadowed by a third-party one.

### The project-scope trust boundary (be honest about it)

Capabilities can be installed **globally** (under your home, `$GSD_HOME/.gsd/capabilities/`) or
**project-scoped** (under a repository, `<projectRoot>/.gsd/capabilities/`). The consent signal is
the ledger, and the project-scope ledger (`<projectRoot>/.gsd-capabilities.json`) lives **inside the
repository**. A repository you check out can therefore ship both a capability bundle *and* a
ledger that marks it "committed." Running `gsd-tools <that-family>` inside such a repo will execute
its code.

This is the same trust boundary that already applies to a repository's build scripts, npm
`postinstall`, or a project-scoped capability's hooks (which GSD has loaded since Phase 2) — and it
is **narrower** than those, because a command never fires on its own: you have to type it. GSD does
not (and with plain files cannot) cryptographically distinguish a genuine project-local install from
a forged project ledger. The honest guidance:

- A **global** install's consent record lives outside any repo and is trustworthy.
- A **project-scoped** capability is only as trustworthy as the repository it ships in — treat
  running its commands like running that repo's other code. Review repos before running `gsd`
  commands in them, and prefer global installs for capabilities you want to trust across projects.
