"use strict";
/**
 * Capability trust gate — ADR-1244 Phase 4 (Decision D5 + the compatibility half of D6), extended
 * by ADR-2782 Phase 3 (#2796) with a FOURTH executable-surface class (the reviewer lane), and by
 * ADR-2363 Phase 1 (#3248) with a FIFTH, NON-executable class: the instruction surface.
 *
 * PURE module. It computes *what* a capability would do and *whether* policy allows it; it
 * never mutates the filesystem and never performs I/O beyond reading staged files to confirm
 * declared executable artifacts exist. The actual consent decision (yes/no) is passed in by the
 * caller — GSD has no interactive-prompt layer in lib (the runtime/CLI edge owns that), so the
 * gate stays testable and side-effect-free. See docs/explanation/capability-trust-model.md.
 *
 * LEAF MODULE — imports ONLY: node:fs, node:path, and ./semver-compare.cjs.
 *
 * ADR-2782 D5 (#2796): a `reviewer` lane is piped the plan text, requirements, research findings
 * and CONTEXT.md decisions, then its output is read back into REVIEWS.md — making it an executable
 * surface exactly like a hook, command module, or MCP server, and it is disclosed and consent-bound
 * the same way. `disclosureSignature` appends the lane element to its output ONLY when at least one
 * lane is declared (D4.5) — a lane-free manifest's signature stays byte-identical to before this
 * class existed, so no already-consented capability re-prompts on upgrade. The RESOLVED host (as
 * opposed to the declared `hostConfigKey`) is disclosed to a human but deliberately EXCLUDED from
 * the signature — the loader has no config resolver and must compute the same signature as the
 * lifecycle (constraint 2, `.gsd/phase/chore-2796-reviewer-trust-disclosure/40-design.md`).
 *
 * ADR-2363 D5 (#3248): a capability's declared `skills` are INSTRUCTION surfaces — their bodies are
 * copied verbatim into the user's agent instruction context, so their reach is bounded only by what
 * the agent will do when told. They are disclosed BY NAME and never content-scanned (D2 —
 * Kerckhoffs: a shipped rule set is readable by the adversary who installs it). Unlike the four
 * executable classes they never set `hasExecutable` (D3) and never enter `disclosureSignature` (D4):
 * folding them in would perturb the stored signature of every already-consented skill-bearing
 * capability and fire a spurious re-consent on its next upgrade — the harm ADR-2782 D4 rule 5
 * already forbids. Any future signature binding arrives as a versioned v2, never an in-place
 * re-encoding of v1. ADR-2363 D3's class table names "skills, agents", but third-party `agents[]`
 * are deliberately EXCLUDED here: `stageAgentsForRuntimeWithConverter` (`src/install-profiles.cts`)
 * takes only a source directory, with no registry-aware third-party staging path the way
 * `readInstalledCapabilitySkill` gives skills — so a declared agent is never actually staged into
 * the instruction context, and disclosing it would name a surface that does not exist. Agents stay
 * unimplemented pending a maintainer decision.
 *
 * Exports:
 *   RESERVED_NAMESPACES               — id prefixes third parties may not claim
 *   discloseExecutableSurfaces(...)   — enumerate the four executable classes + instruction surfaces
 *   collectReviewerLaneSurfaces(...)  — the reviewer-lane collector, independently testable
 *   collectInstructionSurfaces(...)   — the instruction-surface collector, independently testable
 *   checkReservedNamespace(id)        — is this id in a reserved namespace?
 *   evaluateSourceAllowed(parsed,...) — strictKnownRegistries enforcement
 *   checkEngines(manifest, host)      — engines.gsd hard gate + compatVersions downgrade
 *   evaluateInstallTrust(args)        — compose: source + namespace + engines + disclosure
 *   executableSetChanged(old, new)    — did the executable surface set change between versions?
 *   summarizeDisclosure(disclosure)   — human-readable consent-prompt lines
 *   summarizeInstructionSurfaces(d)   — the instruction-surface section of the consent summary
 *   UNRESOLVED_HOST_MARKER            — the non-blank marker for an unresolved openai-http host
 *   EGRESS_PAYLOAD_CLASSES            — the named data classes every reviewer lane receives
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const semverMod = require('./semver-compare.cjs');
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/**
 * Id prefixes reserved for first-party / vendor capabilities. A third-party capability whose
 * id begins with any of these is rejected at install so it cannot impersonate a first-party
 * one. Match is case-insensitive on the normalized id.
 */
const RESERVED_NAMESPACES = ['gsd-', 'gsd-core-', 'anthropic-'];
/**
 * ADR-2782 D5's gating requirement (#2796): every reviewer lane is piped the plan text,
 * requirements, research findings and CONTEXT.md decisions. Named explicitly here so disclosure
 * says exactly this — never the unhelpful "sends data to the tool" (design section B5).
 */
const EGRESS_PAYLOAD_CLASSES = ['plan text', 'requirements', 'research findings', 'CONTEXT.md decisions'];
/**
 * B3 (#2796 matrix): `resolvedHost` must never be a blank string — a blank reads as "no
 * destination" rather than "not resolved". This marker is disclosed for an `openai-http` lane
 * when no resolver was supplied to `collectReviewerLaneSurfaces`, or the supplied resolver could
 * not resolve the declared `hostConfigKey`. Deliberately NOT part of `disclosureSignature`'s input
 * (see the lane signature line) — only the human-facing surface carries it.
 */
const UNRESOLVED_HOST_MARKER = '(unresolved — no host resolver was supplied at disclosure time)';
/**
 * Loopback hostnames recognized LITERALLY, never by substring (an evil host must not spoof this,
 * e.g. `notlocalhost.example`). D5: localhost is not "safe by default" — it is disclosed and
 * FLAGGED, never omitted (matrix B4).
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------
function asString(v) {
    return typeof v === 'string' ? v : '';
}
/**
 * Run `fn`, returning `fallback` instead of throwing. Makes each per-class collector total: a
 * hostile manifest (a Proxy with a throwing trap, a throwing getter, or a non-object/null root)
 * degrades ONE surface class to empty rather than crashing disclosure for the other three classes
 * behind it in the same manifest (ADR-2782 #2796 — disclosure runs before validation and must never
 * throw; matrix C5/E2).
 */
function safeCollect(fn, fallback) {
    try {
        return fn();
    }
    catch {
        return fallback;
    }
}
/**
 * Recognize a loopback/local destination from a RESOLVED openai-http host value (matrix B4). Matches
 * literally, never by substring — an evil host must not spoof `localhost` via e.g.
 * `notlocalhost.example`. Falls back to a scheme-less leading-segment match so a bare config value
 * like `localhost:1234` or `192.168.1.5:8080` (no `http://` prefix) is still recognized.
 *
 * The fallback triggers on EITHER `new URL()` throwing (a value that is not parseable as an absolute
 * URL at all, e.g. `192.168.1.5:8080` — WHATWG scheme names cannot start with a digit) OR it
 * succeeding with an EMPTY hostname: `new URL('localhost:1234')` does NOT throw — it mis-parses the
 * scheme-less `host:port` shape as an opaque URL whose "scheme" IS the hostname text
 * (`protocol: "localhost:"`, `hostname: ""`), which would otherwise silently fail to recognize a
 * bare local config value as local.
 */
function isLocalHostValue(hostValue) {
    let hostname = '';
    try {
        hostname = new URL(hostValue).hostname;
    }
    catch {
        hostname = '';
    }
    if (!hostname) {
        hostname = extractBareHost(hostValue);
    }
    // WHATWG returns an IPv6 hostname bracketed; a bare config value may not be.
    const lower = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
    if (LOOPBACK_HOSTNAMES.has(lower))
        return true;
    if (isLoopbackIpv6(lower))
        return true;
    return isLoopbackIpv4(lower);
}
/**
 * Pull the host out of a value `new URL()` could not parse — a scheme-less
 * `host:port`, or one carrying a path/query/fragment.
 *
 * IPv6 needs explicit handling: splitting on `:` mangles `[::1]:8080` to `[`,
 * which then matches nothing and silently reports a loopback destination as
 * remote. A bracketed literal is taken through its closing bracket; an unbracketed
 * value with two or more colons is treated as a bare IPv6 address rather than
 * `host:port`, since a host:port has exactly one.
 */
function extractBareHost(hostValue) {
    let s = String(hostValue).trim();
    const schemeEnd = s.indexOf('://');
    if (schemeEnd >= 0)
        s = s.slice(schemeEnd + 3);
    s = s.split(/[/?#]/)[0] || '';
    if (s.startsWith('[')) {
        const close = s.indexOf(']');
        return close > 0 ? s.slice(1, close) : s;
    }
    const colons = (s.match(/:/g) || []).length;
    if (colons >= 2)
        return s;
    return colons === 1 ? s.slice(0, s.indexOf(':')) : s;
}
/**
 * Render one declared argv member for the human consent prompt.
 *
 * A string prints as itself. Anything else prints in a form that makes its
 * presence and shape visible rather than vanishing: an argv member the host
 * still receives, but which the user was never shown, is a surface consented to
 * unseen. Never throws — a circular or BigInt member must not break the prompt.
 */
function renderArgForHuman(arg) {
    if (typeof arg === 'string')
        return arg;
    if (typeof arg === 'bigint')
        return `<${String(arg)}n>`;
    try {
        const json = JSON.stringify(arg);
        return json === undefined ? `<${typeof arg}>` : `<${json}>`;
    }
    catch {
        return `<${typeof arg}>`;
    }
}
/** `::1`, its expanded forms, and IPv4-mapped loopback (`::ffff:127.0.0.1`). */
function isLoopbackIpv6(host) {
    if (!host.includes(':'))
        return false;
    if (host === '::1')
        return true;
    const mapped = /^::ffff:(.+)$/i.exec(host);
    if (mapped)
        return isLoopbackIpv4(mapped[1]);
    const groups = host.split(':').filter((g) => g !== '');
    if (groups.length === 0)
        return false;
    return groups.every((g, i) => (i === groups.length - 1 ? /^0*1$/.test(g) : /^0*$/.test(g)));
}
/**
 * 127.0.0.0/8 under inet_aton semantics, which is what a browser, curl and the
 * OS resolver all accept. `127.1`, `2130706433`, `0x7f000001` and `0177.0.0.1`
 * are every bit as loopback as `127.0.0.1`; a disclosure that flags only the
 * dotted-quad form understates a local destination for the other four.
 */
function isLoopbackIpv4(host) {
    const parts = host.split('.');
    if (parts.length < 1 || parts.length > 4)
        return false;
    const nums = [];
    for (const part of parts) {
        let n;
        if (/^0[xX][0-9a-fA-F]+$/.test(part))
            n = parseInt(part, 16);
        else if (/^0[0-7]+$/.test(part))
            n = parseInt(part, 8);
        else if (/^\d+$/.test(part))
            n = parseInt(part, 10);
        else
            return false;
        if (!Number.isFinite(n) || n < 0)
            return false;
        nums.push(n);
    }
    // inet_aton: the final part absorbs every remaining octet.
    let addr;
    if (nums.length === 1)
        addr = nums[0];
    else if (nums.length === 2)
        addr = ((nums[0] & 0xff) * 0x1000000) + (nums[1] & 0xffffff);
    else if (nums.length === 3)
        addr = ((nums[0] & 0xff) * 0x1000000) + ((nums[1] & 0xff) * 0x10000) + (nums[2] & 0xffff);
    else
        addr = ((nums[0] & 0xff) * 0x1000000) + ((nums[1] & 0xff) * 0x10000) + ((nums[2] & 0xff) * 0x100) + (nums[3] & 0xff);
    if (!Number.isFinite(addr) || addr < 0 || addr > 0xffffffff)
        return false;
    return Math.floor(addr / 0x1000000) === 127;
}
/**
 * Collect the `hooks` executable-surface class: [{ event, script }] — scripts run as runtime hook
 * commands. Extracted from the former monolithic `discloseExecutableSurfaces` (ADR-2782 #2796,
 * cyclomatic 51 / cognitive 99 / 110 lines / `risk_level: critical`) — BEHAVIOR UNCHANGED, only
 * isolated so it is independently testable and the orchestrator shrinks instead of growing a fourth
 * class inline. `missingArtifacts` is a shared accumulator the orchestrator passes to every collector
 * that can populate it.
 */
function collectHookSurfaces(manifest, stagedDir, missingArtifacts) {
    const hooks = [];
    if (Array.isArray(manifest.hooks)) {
        for (const h of manifest.hooks) {
            if (typeof h !== 'object' || h === null)
                continue;
            const rec = h;
            const script = asString(rec['script']);
            const event = asString(rec['event']);
            if (script) {
                hooks.push({ event, script });
                if (stagedDir && !artifactExists(stagedDir, script)) {
                    missingArtifacts.push(script);
                }
            }
        }
    }
    return hooks;
}
/**
 * Collect the `commands` executable-surface class: [{ family, module, router? }] — modules
 * require()'d into the GSD CLI process. Extracted, BEHAVIOR UNCHANGED — see `collectHookSurfaces`.
 */
function collectCommandSurfaces(manifest, stagedDir, missingArtifacts) {
    const commandModules = [];
    if (Array.isArray(manifest.commands)) {
        for (const c of manifest.commands) {
            if (typeof c !== 'object' || c === null)
                continue;
            const rec = c;
            const moduleName = asString(rec['module']);
            const family = asString(rec['family']);
            // TRUST2-3 (#1459): capture the router (which exported fn runs) so retargeting it forces re-consent.
            const router = asString(rec['router']);
            if (moduleName) {
                commandModules.push({ family, module: moduleName, router });
                if (stagedDir && !artifactExists(stagedDir, moduleName)) {
                    missingArtifacts.push(moduleName);
                }
            }
        }
    }
    return commandModules;
}
/**
 * Collect the `mcpServers` executable-surface class: object map { name: { command, args } } OR
 * array [{ name, command, args }] (or array [{ name, config: { command, args } }]). Captures the
 * COMMAND, not just the name — the command is the executable that actually runs, and consent must
 * disclose it (Codex R1 H1). Extracted, BEHAVIOR UNCHANGED — see `collectHookSurfaces`. Unlike
 * hooks/commands, an MCP server's command is never existence-checked against `stagedDir` (exactly
 * like a reviewer lane's `binary` — see `collectReviewerLaneSurfaces` — it may be any PATH
 * executable, not necessarily a bundle artifact), so this collector takes no `missingArtifacts`
 * accumulator.
 */
function collectMcpSurfaces(manifest) {
    const mcpServers = [];
    if (manifest.mcpServers && typeof manifest.mcpServers === 'object') {
        const pushServer = (name, config) => {
            if (!name)
                return;
            const cfg = (typeof config === 'object' && config !== null) ? config : {};
            const command = asString(cfg['command']);
            // TRUST2-4 (#1459): the RAW args array (incl non-string members) is what the host receives, so it
            // is folded — stable-encoded — into the signature. `argv` is the string-filtered view for the
            // human summary; `rawArgs` is the full declared array bound into the signature.
            const rawArgs = Array.isArray(cfg['args']) ? cfg['args'] : [];
            const argv = rawArgs.filter((a) => typeof a === 'string');
            // TRUST2-2 (#1459): a non-stdio MCP server ({ type|transport, url, headers }) was previously
            // invisible to the disclosure/signature. Capture the transport TYPE, the URL, and the HEADERS
            // (string→string, prototype-pollution-safe) so a swapped endpoint or header forces re-consent.
            const transport = asString(cfg['type']) || asString(cfg['transport']);
            const url = asString(cfg['url']);
            const headers = {};
            const rawHeaders = cfg['headers'];
            if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
                for (const [k, v] of Object.entries(rawHeaders)) {
                    if (k === '__proto__' || k === 'constructor' || k === 'prototype')
                        continue;
                    if (typeof v === 'string')
                        headers[k] = v;
                }
            }
            // TRUST-2 (#1459): env can change WHAT a command does without touching command/argv, so it is
            // part of the disclosed (and consent-bound) surface. Filter to string→string entries only —
            // a non-string env value cannot be exported as a real environment variable, and including it
            // would make the signature depend on un-runnable junk. Prototype-pollution-safe: copy only
            // own enumerable string keys, never __proto__/constructor/prototype.
            const env = {};
            const rawEnv = cfg['env'];
            if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
                for (const [k, v] of Object.entries(rawEnv)) {
                    if (k === '__proto__' || k === 'constructor' || k === 'prototype')
                        continue;
                    if (typeof v === 'string')
                        env[k] = v;
                }
            }
            const cwd = asString(cfg['cwd']);
            // Finding 5 (MEDIUM, #1459): capture the FULL config (every declared field the writer persists),
            // not just the whitelisted ones. Prototype-pollution-safe: copy only own enumerable keys and
            // never the dangerous keys. The CAP_MARKER the writer stamps on persist (`_gsdCapability`) is the
            // capability id (constant per cap), so it does not perturb the signature; we copy config as
            // DECLARED here (pre-stamp) and the writer adds the marker at write time.
            const rawConfig = {};
            for (const [k, v] of Object.entries(cfg)) {
                if (k === '__proto__' || k === 'constructor' || k === 'prototype')
                    continue;
                rawConfig[k] = v;
            }
            const surface = { name, transport, command, argv, rawArgs, url, headers, env, rawConfig };
            if (cwd)
                surface.cwd = cwd;
            mcpServers.push(surface);
        };
        if (Array.isArray(manifest.mcpServers)) {
            for (const s of manifest.mcpServers) {
                if (typeof s === 'object' && s !== null) {
                    const rec = s;
                    pushServer(asString(rec['name']), rec['config'] ?? rec);
                }
            }
        }
        else {
            for (const [name, config] of Object.entries(manifest.mcpServers)) {
                pushServer(name, config);
            }
        }
    }
    return mcpServers;
}
/**
 * Collect the reviewer-lane executable-surface class (ADR-2782 D5, #2796): 0 or 1 entries, since a
 * capability manifest carries AT MOST ONE `reviewer` body (Phase 2's validator rejects an array
 * shape outright — matrix C2b). The array return shape matches the other three collectors so
 * `Disclosure`/`disclosureSignature` treat it uniformly (sort-then-fold), even though today it can
 * never hold more than one entry.
 *
 * TOTAL and absent-safe (matrix C1–C5): no `reviewer` key, `reviewer: null`, a non-object body
 * (array/boolean/number), a malformed `invoke`, non-array `flags`, or the whole manifest being a
 * throwing Proxy/getter all degrade to "no lane" rather than throwing — disclosure runs BEFORE
 * Phase 2's validation, on a manifest validation would reject outright.
 *
 * `resolveHost` is optional — supplied by the lifecycle (never the loader, which has no config
 * access) to disclose the REAL destination of an `openai-http` lane to a human at install/upgrade
 * time. Its return value is NEVER folded into `disclosureSignature` (design constraint 2: the
 * signature must stay a pure function of the manifest, or the loader and lifecycle would compute
 * different signatures for the same manifest and produce a permanent false re-consent loop).
 */
function collectReviewerLaneSurfaces(manifest, resolveHost) {
    return safeCollect(() => {
        const r = manifest.reviewer;
        // C1 (no reviewer key) / C2a (null) / C2b (non-object: array, boolean, number) all disclose no
        // lane — never an error at this layer. Validation of a malformed body is Phase 2's job.
        if (typeof r !== 'object' || r === null || Array.isArray(r))
            return [];
        const rec = r;
        const slug = asString(rec['slug']);
        const transport = asString(rec['transport']);
        const handler = asString(rec['handler']);
        // C3: `invoke` absent/malformed still discloses a lane, with empty binary/args/rawArgs rather
        // than crashing — validating `invoke`'s shape is Phase 2's job, not disclosure's.
        const invokeRaw = rec['invoke'];
        const invoke = (typeof invokeRaw === 'object' && invokeRaw !== null && !Array.isArray(invokeRaw))
            ? invokeRaw
            : {};
        const binary = asString(invoke['binary']);
        // B1b: the RAW declared args (may contain non-strings the host still receives) is what the
        // signature binds; `args` is the string-filtered RENDERED view for a human summary — the exact
        // argv/rawArgs split MCP servers already use for the same reason (TRUST2-4, #1459).
        const rawArgsDeclared = Array.isArray(invoke['args']) ? invoke['args'] : [];
        const args = rawArgsDeclared.filter((a) => typeof a === 'string');
        const hostConfigKey = asString(invoke['hostConfigKey']);
        const promptChannel = asString(invoke['promptChannel']);
        // #2483: the declared env pairs. String-filtered for the human line exactly as `args` is, and
        // prototype-safe (own enumerable keys only, dangerous keys never copied) exactly as `rawConfig`
        // is. Disclosure runs BEFORE validation, so a non-object or non-string-valued `env` reaches here
        // and must degrade to "declares none" rather than throw.
        const env = {};
        const envRaw = invoke['env'];
        if (typeof envRaw === 'object' && envRaw !== null && !Array.isArray(envRaw)) {
            for (const [k, v] of Object.entries(envRaw)) {
                if (k === '__proto__' || k === 'constructor' || k === 'prototype')
                    continue;
                if (typeof v === 'string')
                    env[k] = v;
            }
        }
        const defaultHost = asString(invoke['defaultHost']);
        // The completeness backstop (mirrors rawConfig). Everything the invoke object declares that the
        // explicit fields above do not already bind. Same prototype-safe copy.
        const residualInvoke = {};
        for (const [k, v] of Object.entries(invoke)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype')
                continue;
            if (k === 'binary' || k === 'args' || k === 'hostConfigKey' || k === 'promptChannel')
                continue;
            residualInvoke[k] = v;
        }
        // The outer half of the same backstop. `probe` is the one that matters most — its `binary` is
        // spawned before dispatch — and the two exclusions below are ADR-2782's deliberate cosmetic
        // carve-outs, not fields nobody got round to.
        const residualLane = {};
        for (const [k, v] of Object.entries(rec)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype')
                continue;
            if (k === 'slug' || k === 'transport' || k === 'handler' || k === 'invoke')
                continue;
            if (k === 'reviewsSection' || k === 'timeoutFloorMs')
                continue;
            residualLane[k] = v;
        }
        const probeRaw = rec['probe'];
        const probeIsObj = typeof probeRaw === 'object' && probeRaw !== null && !Array.isArray(probeRaw);
        const probeBinary = probeIsObj ? asString(probeRaw['binary']) : '';
        const probeKind = probeIsObj ? asString(probeRaw['kind']) : '';
        // An EMPTY (or wholly unrecognised) reviewer body declares no lane and must
        // not be treated as one. Without this, `reviewer: {}` alone flips
        // hasExecutable true and perturbs the disclosure signature — producing a
        // re-consent prompt whose only content is "(no binary declared)". That is a
        // prompt carrying no security information, which is exactly the
        // click-through-training harm this design refuses for reviewsSection and
        // timeoutFloorMs; refusing it there and permitting it here would be
        // inconsistent.
        //
        // The test is deliberately BROAD — any one recognised field with a value is
        // enough. Requiring specifically a binary, or specifically a slug, would let
        // a lane declaring only the other slip through unconsented, which is the far
        // worse failure.
        // `env`/`defaultHost` join the test for the reason the comment above gives for keeping it broad:
        // a lane declaring ONLY an `env` pair would otherwise declare "nothing", disclose nothing, and
        // still hand those pairs to a spawned child once #2927/#3062 made overlay lanes executable —
        // the exact slip-through the broad test exists to refuse.
        const declaresSomething = Boolean(slug || transport || handler || binary || hostConfigKey || promptChannel
            || rawArgsDeclared.length > 0 || Object.keys(env).length > 0 || defaultHost || probeBinary);
        if (!declaresSomething)
            return [];
        // B2/B3/B4: resolvedHost/isLocalDestination are only meaningful for an openai-http lane — a
        // spawn lane has no destination concept, so both stay at their inapplicable defaults ('' /
        // false), mirroring McpServerSurface's existing empty-when-inapplicable convention (e.g.
        // `url: ''` for a stdio server). For openai-http, resolvedHost never ends up '' — it is either a
        // real resolved value or the explicit UNRESOLVED_HOST_MARKER (never a blank read as "no
        // destination").
        // The shape test is deliberately WIDER than an exact transport match, and the
        // human summary uses the same one. Disclosure runs BEFORE validation, so a
        // mis-cased or unrecognised `transport` reaches here; keying only on the exact
        // string would leave a lane that plainly declares a hostConfigKey with a BLANK
        // destination, which reads as "no destination" — the precise thing B3 forbids.
        const hasHttpShape = transport === 'openai-http' || (!binary && Boolean(hostConfigKey));
        let resolvedHost = '';
        let isLocalDestination = false;
        if (hasHttpShape) {
            resolvedHost = UNRESOLVED_HOST_MARKER;
            if (typeof resolveHost === 'function') {
                let resolved;
                try {
                    resolved = resolveHost(hostConfigKey);
                }
                catch {
                    resolved = undefined;
                }
                if (typeof resolved === 'string' && resolved)
                    resolvedHost = resolved;
            }
            if (resolvedHost !== UNRESOLVED_HOST_MARKER) {
                isLocalDestination = isLocalHostValue(resolvedHost);
            }
        }
        const surface = {
            slug,
            transport,
            binary,
            args,
            rawArgs: rawArgsDeclared,
            hostConfigKey,
            resolvedHost,
            isLocalDestination,
            promptChannel,
            handler,
            env,
            defaultHost,
            residualInvoke,
            residualLane,
            probeBinary,
            probeKind,
            // B5: every lane receives the same named egress payload classes — a fresh copy per surface so
            // no caller can mutate the shared constant through a returned surface.
            egressPayloadClasses: [...EGRESS_PAYLOAD_CLASSES],
        };
        return [surface];
    }, []);
}
/**
 * The manifest fields whose declared names become instruction surfaces. Ordered data rather than a
 * hand-rolled loop per field, so a future second member of the class is one row, not a second copy
 * of the same filter. Deliberately a ONE-row table today: third-party `agents[]` are never staged
 * into the instruction context — `stageAgentsForRuntimeWithConverter` (`src/install-profiles.cts`)
 * takes only a source directory, with no registry-aware staging path the way
 * `readInstalledCapabilitySkill` gives skills — so disclosing them would name a surface that does
 * not exist. ADR-2363 D3's class table says "skills, agents"; the agents half is therefore
 * deliberately unimplemented pending a maintainer decision.
 */
const INSTRUCTION_SURFACE_FIELDS = [
    { field: 'skills', kind: 'skill' },
];
/**
 * Collect the instruction surfaces a manifest declares (ADR-2363 D5, #3248) — peer to the four
 * executable-surface collectors, and invoked through the same `safeCollect` wrapper so a hostile
 * value here degrades ONLY this class to empty rather than losing the other four.
 *
 * Liberal in what it accepts, exactly like the existing collectors: a non-object manifest, an
 * absent field, a non-array field, and a non-string/blank member each degrade quietly. A non-array
 * `skills` is NOT a partial success — it yields nothing, because a scalar declares no set.
 *
 * Deliberately does NOT:
 *   - dedup (a manifest declaring a stem twice discloses it twice — disclosure reports what the
 *     manifest SAYS; collapsing would misreport it, and dedup is the registry's job);
 *   - normalize or truncate a name (it is disclosed verbatim so the user sees what was declared);
 *   - existence-check the stem against `stagedDir`. A stem is a REGISTRY name, not a bundle-relative
 *     artifact path — checking it would repeat the reviewer-lane `binary` mistake (matrix C6) and
 *     put registry names into `missingArtifacts`, which is for declared bundle FILES only.
 */
function collectInstructionSurfaces(manifest) {
    const surfaces = [];
    if (typeof manifest !== 'object' || manifest === null)
        return surfaces;
    for (const { field, kind } of INSTRUCTION_SURFACE_FIELDS) {
        const declared = manifest[field];
        if (!Array.isArray(declared))
            continue;
        for (const entry of declared) {
            // A non-string or blank member is dropped INDIVIDUALLY — the valid siblings around it still
            // disclose, mirroring how collectHookSurfaces skips a malformed entry rather than the array.
            if (typeof entry !== 'string')
                continue;
            if (entry.trim() === '')
                continue;
            surfaces.push({ kind, name: entry });
        }
    }
    return surfaces;
}
/**
 * Enumerate every executable surface a capability manifest declares.
 *
 * Recognizes the FOUR executable surface kinds a capability can ship:
 *   - `hooks`:    [{ event, script }]              — scripts run as runtime hook commands
 *   - `commands`: [{ family, module, router? }]    — modules require()'d into the CLI process
 *   - `mcpServers`: { <name>: {...} } | [{ name }] — servers spawned by the host runtime
 *   - `reviewer`: { slug, transport, invoke, ... }  — an external reviewer lane (ADR-2782 D5, #2796)
 *
 * plus ONE non-executable class (ADR-2363 D5, #3248):
 *   - `skills`: string[] of owned stems — INSTRUCTION surfaces, whose bodies land in the agent's
 *     instruction context. Disclosed by name; they never set `hasExecutable` (D3) and never enter
 *     `disclosureSignature` (D4). Stems are registry names, so they are never existence-checked
 *     against `stagedDir` and never appear in `missingArtifacts`. `agents` is excluded — see the
 *     module header.
 *
 * `mcpServers` is not a first-party capability.json field today, but a third-party manifest may
 * declare it, so the trust gate discloses it whenever present (honest disclosure over the
 * narrower first-party schema). Pure: when `stagedDir` is provided, declared hook/command-module
 * files are existence-checked and any missing ones reported, but nothing is mutated. A reviewer
 * lane's `binary` is NEVER existence-checked against `stagedDir` (matrix C6) — like an MCP server's
 * command, it is a PATH lookup on the user's machine, never a bundle artifact; existence-checking it
 * would block every lane install.
 *
 * TOTAL: never throws, for any manifest shape — including a non-object manifest, a Proxy with
 * throwing traps, or a property with a throwing getter (matrix C5, E2). Disclosure runs BEFORE
 * Phase 2's validation, on a manifest validation would reject outright, so it must tolerate what
 * validation does not. Each surface class is collected independently (`safeCollect`) so a hostile
 * value in ONE class degrades only that class to empty rather than losing the others.
 *
 * `resolveHost` (optional, #2796) is forwarded to `collectReviewerLaneSurfaces` so a caller with
 * config access (the lifecycle, never the loader — see `signatureForManifest`) can disclose the REAL
 * destination of an `openai-http` lane. It never affects the returned signature.
 */
function discloseExecutableSurfaces(manifest, stagedDir, resolveHost) {
    const missingArtifacts = [];
    const hooks = safeCollect(() => collectHookSurfaces(manifest, stagedDir, missingArtifacts), []);
    const commandModules = safeCollect(() => collectCommandSurfaces(manifest, stagedDir, missingArtifacts), []);
    const mcpServers = safeCollect(() => collectMcpSurfaces(manifest), []);
    const reviewerLanes = safeCollect(() => collectReviewerLaneSurfaces(manifest, resolveHost), []);
    const instructionSurfaces = safeCollect(() => collectInstructionSurfaces(manifest), []);
    // ADR-2363 D3: instruction surfaces are deliberately ABSENT from this expression. Adding them
    // would silently change `executableSetChanged` and the auto-update re-consent trigger.
    const hasExecutable = hooks.length > 0 || commandModules.length > 0 || mcpServers.length > 0 || reviewerLanes.length > 0;
    return { hooks, commandModules, mcpServers, reviewerLanes, instructionSurfaces, hasExecutable, missingArtifacts };
}
/**
 * Existence-check a manifest-declared artifact path under stagedDir, refusing to follow it
 * outside the staged root (defense against `../` traversal in a hostile manifest).
 */
function artifactExists(stagedDir, relPath) {
    if (!relPath || node_path_1.default.isAbsolute(relPath) || relPath.split(/[/\\]/).includes('..')) {
        // A traversal/absolute artifact path is treated as "not present" (and is independently
        // rejected by the validator / lifecycle); never resolve it.
        return false;
    }
    try {
        return node_fs_1.default.existsSync(node_path_1.default.join(stagedDir, relPath));
    }
    catch {
        return false;
    }
}
// ---------------------------------------------------------------------------
// Namespace reservation
// ---------------------------------------------------------------------------
/**
 * Is `id` in a reserved namespace? Reserved prefixes are first-party/vendor-only so a
 * third-party capability cannot impersonate a first-party one.
 */
function checkReservedNamespace(id) {
    if (typeof id !== 'string' || !id)
        return { reserved: false, namespace: null };
    const lower = id.toLowerCase();
    for (const ns of RESERVED_NAMESPACES) {
        if (lower.startsWith(ns))
            return { reserved: true, namespace: ns };
    }
    return { reserved: false, namespace: null };
}
// ---------------------------------------------------------------------------
// strictKnownRegistries enforcement
// ---------------------------------------------------------------------------
/**
 * Extract the host of a URL-bearing spec for host-based allowlist matching. Returns '' when no
 * host can be parsed (caller treats '' as non-matching).
 */
function specHost(parsed) {
    // git specs may be scp-style (git@host:path) or URL-style; tarball/registry are URLs.
    const raw = parsed.target || parsed.raw || '';
    const scp = /^[^@/]+@([^:]+):/.exec(raw);
    if (scp)
        return scp[1].toLowerCase();
    try {
        return new URL(raw).hostname.toLowerCase();
    }
    catch {
        return '';
    }
}
/**
 * True if `host` equals an allowlist entry or is a subdomain of it. Host-based, NOT substring:
 * `github.com` matches `github.com` and `api.github.com`, never `evilgithub.com`.
 */
function hostMatchesAllowlist(host, list) {
    if (!host)
        return false;
    for (const entryRaw of list) {
        const entry = typeof entryRaw === 'string' ? entryRaw.trim().toLowerCase() : '';
        if (!entry)
            continue;
        if (host === entry || host.endsWith('.' + entry))
            return true;
    }
    return false;
}
/**
 * True for a Windows/UNC network path. Matches any two leading slash-or-backslash characters
 * (`\\`, `//`, and the mixed `\/` / `/\` forms Windows also treats as UNC-absolute).
 */
function isUncPath(p) {
    return /^[\\/]{2}/.test(p);
}
/** Extract the server host of a UNC path (`\\server\share` -> `server`). */
function uncHost(p) {
    const m = /^[\\/]{2}([^\\/]+)/.exec(p);
    return m ? m[1].toLowerCase() : '';
}
/**
 * Apply the `capabilities.strict_known_registries` policy to a parsed spec.
 *
 *   undefined/null  -> permissive: external installs allowed (consent gate still applies).
 *   []              -> lockdown:   all EXTERNAL installs blocked (local-only).
 *   non-empty list  -> allowlist:  only sources whose host matches an entry are allowed.
 *   anything else   -> FAIL CLOSED: a malformed policy value blocks the install.
 *
 * Local (filesystem) sources are never "external" and are always allowed — EXCEPT a UNC network
 * path (`\\server\share`), which is remote despite parsing as an "absolute"/local-kind spec and is
 * therefore subject to the policy.
 */
function evaluateSourceAllowed(parsed, strict) {
    const target = parsed.target || parsed.raw || '';
    const unc = parsed.kind === 'local' && isUncPath(target);
    if (parsed.kind === 'local' && !unc)
        return { allowed: true, reason: null };
    if (strict === undefined || strict === null)
        return { allowed: true, reason: null };
    if (!Array.isArray(strict)) {
        // A security policy must never be silently ignored when it is the wrong type (e.g. a
        // string `"[]"` from a hand-edited config). Fail closed.
        return {
            allowed: false,
            reason: 'capabilities.strict_known_registries must be an array (or null/unset); refusing the install on a malformed policy value',
        };
    }
    if (strict.length === 0) {
        return {
            allowed: false,
            reason: 'capabilities.strict_known_registries is [] — all external capability installs are disabled. ' +
                'Install from a local path, or add an allowed host to the list.',
        };
    }
    // npm specs carry no host; the "registry" is npm itself. Treat the allowlist token "npm" as
    // permitting the npm source kind.
    if (parsed.kind === 'npm') {
        if (strict.some((e) => typeof e === 'string' && e.trim().toLowerCase() === 'npm')) {
            return { allowed: true, reason: null };
        }
        return {
            allowed: false,
            reason: `npm source is not in capabilities.strict_known_registries (add "npm" to allow it)`,
        };
    }
    const host = unc ? uncHost(target) : specHost(parsed);
    if (hostMatchesAllowlist(host, strict))
        return { allowed: true, reason: null };
    return {
        allowed: false,
        reason: `source host "${host || '(unparseable)'}" is not in capabilities.strict_known_registries`,
    };
}
// ---------------------------------------------------------------------------
// engines.gsd hard gate + compatVersions downgrade
// ---------------------------------------------------------------------------
/**
 * Hard-gate a manifest against the running host version via engines.gsd, consulting
 * compatVersions for a graceful-downgrade target when the current version is incompatible.
 */
function checkEngines(manifest, hostVersion) {
    const engines = manifest.engines;
    let range = null;
    if (engines && typeof engines === 'object' && !Array.isArray(engines)) {
        const g = engines['gsd'];
        if (typeof g === 'string' && g)
            range = g;
    }
    if (!range)
        return { compatible: true, range: null, satisfiedBy: 'unconstrained' };
    if (semverMod.semverSatisfies(hostVersion, range)) {
        return { compatible: true, range, satisfiedBy: 'engines' };
    }
    // Current version is incompatible — look for a compatVersions entry that works, picking the
    // newest such capability version (best graceful downgrade).
    const compat = manifest.compatVersions;
    let best;
    if (compat && typeof compat === 'object' && !Array.isArray(compat)) {
        for (const [capVer, gsdRange] of Object.entries(compat)) {
            if (typeof gsdRange !== 'string' || !gsdRange)
                continue;
            if (!semverMod.semverSatisfies(hostVersion, gsdRange))
                continue;
            if (best === undefined || semverMod.isSemverNewer(capVer, best))
                best = capVer;
        }
    }
    if (best !== undefined) {
        return { compatible: false, range, satisfiedBy: 'compatVersions', downgradeTo: best };
    }
    return { compatible: false, range, satisfiedBy: null };
}
// ---------------------------------------------------------------------------
// Composite install verdict
// ---------------------------------------------------------------------------
/**
 * Compose the full install trust verdict: source policy + reserved-namespace + engines gate +
 * executable-surface disclosure. `allowed` is true only when no gate blocks; `requiresConsent`
 * is true when allowed AND the capability ships any executable surface.
 *
 * engines.gsd is also enforced inside resolveCapabilitySource at resolve time; re-checking here
 * is defense-in-depth and lets callers surface a compatVersions downgrade hint.
 */
function evaluateInstallTrust(args) {
    const { parsed, manifest, stagedDir, strictKnownRegistries, hostVersion, resolveHost } = args;
    const blockReasons = [];
    const src = evaluateSourceAllowed(parsed, strictKnownRegistries);
    if (!src.allowed && src.reason)
        blockReasons.push(src.reason);
    const ns = checkReservedNamespace(manifest.id);
    if (ns.reserved) {
        blockReasons.push(`capability id "${asString(manifest.id)}" uses the reserved namespace "${ns.namespace}" — ` +
            'reserved for first-party capabilities');
    }
    const engines = checkEngines(manifest, hostVersion);
    if (!engines.compatible) {
        const hint = engines.downgradeTo
            ? ` (compatVersions offers ${engines.downgradeTo} for this host)`
            : '';
        blockReasons.push(`capability requires engines.gsd "${engines.range}" but host is ${hostVersion}${hint}`);
    }
    // #2796: resolveHost is optional and, when supplied, discloses the REAL destination of an
    // openai-http reviewer lane to the human at install/upgrade time — it never affects the
    // consent-binding signature (disclosureSignature never reads resolvedHost; design constraint 2).
    const disclosure = discloseExecutableSurfaces(manifest, stagedDir, resolveHost);
    // #3514 (F21c): prompt-only integrity status. Set AFTER discloseExecutableSurfaces so the
    // surface builder (and every signature computed from it) is untouched — see the field's
    // disclosure-interface comment for why this must never reach disclosureSignature.
    if (args.integrityPin === 'sha512')
        disclosure.integrityStatus = 'pinned';
    else if (args.integrityPin === 'git-commit')
        disclosure.integrityStatus = 'commit-pinned';
    else if (args.integrityPin === 'none')
        disclosure.integrityStatus = 'unverified';
    // A manifest that declares a hook script or command module NOT present in the staged bundle
    // (missing, or escaping the bundle via an absolute/`..` path) is rejected: such an artifact
    // would run from outside the integrity-pinned, reversible install root. Only enforced when a
    // stagedDir was provided to existence-check against.
    if (stagedDir && disclosure.missingArtifacts.length > 0) {
        blockReasons.push(`capability declares executable artifacts not present in the staged bundle (or escaping it): ${disclosure.missingArtifacts.join(', ')}`);
    }
    const allowed = blockReasons.length === 0;
    const requiresConsent = allowed && disclosure.hasExecutable;
    return { allowed, requiresConsent, disclosure, engines, blockReasons };
}
// ---------------------------------------------------------------------------
// Executable-set change detection (auto-update re-prompt trigger)
// ---------------------------------------------------------------------------
/**
 * Serialize a value to JSON with object keys RECURSIVELY SORTED, so the result is stable under key
 * reordering. Used to fold an MCP server's `env` map into the disclosure signature: ADDING or
 * CHANGING any env entry changes the signature (forces re-consent), but merely REORDERING the keys
 * does NOT (no false re-prompt). TRUST-2 (#1459).
 *
 * TOTAL (#2796, matrix C5c/E2): a value declared inside an unvalidated manifest — e.g. a reviewer
 * lane's `invoke.args` — may contain a BigInt (which `JSON.stringify` throws on) or a circular
 * reference (which unguarded recursion stack-overflows on). Both are handled without throwing:
 * a BigInt renders as its decimal string; a cycle (an object that is its OWN ancestor in the current
 * recursion path — tracked via `seen`, added before recursing into children and removed once fully
 * processed) renders as the literal string `"[Circular]"`. Neither case is reachable for the golden
 * hooks/mods/mcp fixtures this phase's byte-identity tests pin down, so their output is unaffected.
 *
 * KNOWN LIMIT — signature collision on non-JSON numerics (#2796 isolated review, finding E).
 * `NaN`, `Infinity`, `-Infinity` and `undefined` all render as `null` here, inheriting
 * `JSON.stringify`'s own coercion. Two materially different manifests could therefore share a
 * consent signature. This is NOT reachable through any production path: every manifest arrives via
 * `readManifestBounded`'s strict `JSON.parse`, and the JSON grammar has no `NaN`/`Infinity`/
 * `undefined` literal — such input throws before disclosure runs. `0` vs `-0` IS expressible in
 * valid JSON and does collide, but is inert: `String(0) === String(-0)`, so a spawned process
 * receives identical argv either way.
 *
 * Recorded here rather than only in the PR that found it: reachability rests entirely on the ingest
 * path staying `JSON.parse`-only. Anyone who adds a loader that builds a manifest by other means
 * (a JS config file, a deserializer, a test double promoted to production) re-opens this, and needs
 * to see it at the point they would break it.
 */
function stableJson(value, seen) {
    if (typeof value === 'bigint')
        return JSON.stringify(`${value.toString()}n`);
    if (value === null || typeof value !== 'object') {
        try {
            return JSON.stringify(value) ?? 'null';
        }
        catch {
            // A non-object value whose serialization still throws (defensive; JSON.stringify does not
            // throw for any other typeof today, but this keeps the contract TOTAL against future engines).
            return 'null';
        }
    }
    const seenSet = seen ?? new Set();
    if (seenSet.has(value))
        return '"[Circular]"';
    try {
        seenSet.add(value);
        if (Array.isArray(value)) {
            return `[${value.map((v) => stableJson(v, seenSet)).join(',')}]`;
        }
        const obj = value;
        const keys = Object.keys(obj).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k], seenSet)}`).join(',')}}`;
    }
    catch {
        // A Proxy with a throwing trap, or a getter that throws on read — never propagate (matrix C5).
        return '"[unserializable]"';
    }
    finally {
        seenSet.delete(value);
    }
}
function disclosureSignature(d) {
    // TRUST2-1 (#1459): build EVERY surface line via stableJson of an ARRAY of its components, so each
    // component is encoded — a `:`-delimited concatenation let a delimiter inside a component (e.g. an
    // mcp name `x:a` vs command `b`) collide with a different decomposition. JSON-encoding every
    // component makes each line an injective function of its components (no delimiter injection).
    const hooks = d.hooks.map((h) => stableJson(['hook', h.event, h.script])).sort();
    // TRUST2-3: include the router (which exported fn runs) so retargeting it forces re-consent.
    const mods = d.commandModules.map((m) => stableJson(['mod', m.family, m.module, m.router || ''])).sort();
    // Include transport + command + RAW args + url + headers + env + cwd + the FULL declared config so a
    // version that:
    //   - swaps the stdio executable it runs (command/args), OR
    //   - changes the env it runs with (e.g. NODE_OPTIONS=--require evil.js), OR
    //   - changes the cwd it runs in, OR
    //   - (TRUST2-2) swaps the transport/url/headers of a non-stdio (http/sse) server, OR
    //   - (TRUST2-4) changes a NON-STRING arg the host still receives, OR
    //   - (finding 5) changes ANY OTHER declared field the writer persists (a future envFile/workingDir/
    //     launch option NOT in the explicit whitelist above)
    // is detected as a changed surface (forces re-consent). The explicit fields are kept FIRST for
    // readability/stability; `rawConfig` is the completeness backstop. All are STABLE-encoded (recursively
    // key-sorted JSON) so any add/change forces re-consent while a pure key reorder does NOT (no false
    // re-prompt).
    const mcp = d.mcpServers
        .map((s) => stableJson([
        'mcp',
        s.name,
        s.transport || '',
        s.command,
        s.rawArgs || [],
        s.url || '',
        s.headers || {},
        s.env || {},
        s.cwd || '',
        // Finding 5: the FULL declared config — completeness so any persisted field change re-consents.
        s.rawConfig || {},
    ]))
        .sort();
    // ADR-2782 D5 (#2796): fold in slug/transport/binary/rawArgs/hostConfigKey/promptChannel/handler —
    // every field that changes WHAT runs, WHERE it sends data, or WHAT CODE post-processes its output
    // (matrix A3–A9). Deliberately ABSENT from this line: `reviewsSection` and `timeoutFloorMs` (matrix
    // A10/A13 — cosmetic fields; folding them in would force a re-consent prompt that carries no
    // security information, training users to click through) and the RESOLVED host (design constraint
    // 2 — the loader has no config resolver and must compute the SAME signature as the lifecycle, or a
    // resolver-bearing caller and a resolver-less caller would permanently disagree on one manifest's
    // signature).
    // #2483: the eight-field enumeration above was a CLOSED list over an OPEN vocabulary, and it had
    // already fallen behind by EIGHT fields before `env` made the ninth — `defaultHost` (the manifest's
    // OWN fallback egress host), `path` (appended to it to build the URL), `outputChannel`, `outputArg`,
    // `modelArg`, `effortChannel`, `modelDiscovery` and `fallbackModel` all reach `resolveLanePlan` and
    // none was signed. Counted, because the number is easy to state ambiguously: `resolveLanePlan`
    // reads THIRTEEN distinct `inv.*` fields once `env` is included (twelve before this PR added it),
    // of which the pre-#2483 tuple bound four — so eight were unbound before `env`, nine including it.
    // So the fix is not a ninth name: it is a residual, the same completeness backstop `rawConfig` gives
    // the MCP line one screen up (#1459 finding 5). `env`/`defaultHost` are ALSO named explicitly,
    // mirroring that line's deliberate explicit-then-backstop overlap, because they are the two the
    // human summary renders and a reader should be able to find them in the signature by name.
    //
    // APPENDED ONLY WHEN NON-EMPTY, which is D4.5 one level down: a lane declaring nothing beyond the
    // eight already-bound fields keeps a BYTE-IDENTICAL signature, so this cannot re-prompt every
    // consented capability for a field it does not use. A lane that DOES declare one re-consents — which
    // is the correct outcome, not a cost: those fields were executable and undisclosed.
    const lanes = d.reviewerLanes
        .map((l) => {
        const tuple = [
            'lane', l.slug, l.transport, l.binary, l.rawArgs || [], l.hostConfigKey, l.promptChannel, l.handler,
        ];
        const extra = {
            env: l.env || {},
            defaultHost: l.defaultHost || '',
            residual: l.residualInvoke || {},
            laneResidual: l.residualLane || {},
        };
        const declaresExtra = Object.keys(extra.env).length > 0
            || extra.defaultHost !== ''
            || Object.keys(extra.residual).length > 0
            || Object.keys(extra.laneResidual).length > 0;
        if (declaresExtra)
            tuple.push(extra);
        return stableJson(tuple);
    })
        .sort();
    // D4.5 (the highest-consequence line in this phase): the lane element is appended ONLY when at
    // least one lane is declared. A lane-free manifest's signature stays BYTE-IDENTICAL to before this
    // class existed (matrix A1a/A1b/A1c) — appending unconditionally would change every already-
    // installed capability's signature and re-prompt every user for every capability on next upgrade,
    // whether or not they use any reviewer lane at all.
    return lanes.length > 0 ? JSON.stringify([hooks, mods, mcp, lanes]) : JSON.stringify([hooks, mods, mcp]);
}
/**
 * Did the executable surface set change between two versions? Auto-update must re-prompt for
 * consent when it did (the user consented to one set of executable surfaces, not another).
 */
function executableSetChanged(oldD, newD) {
    return disclosureSignature(oldD) !== disclosureSignature(newD);
}
/**
 * THE single source of truth for the consent-binding signature of a capability manifest: run
 * `discloseExecutableSurfaces` then `disclosureSignature`. Both the loader (which checks whether a
 * previously-consented project cap still matches) and the lifecycle (which records the consent)
 * compute the binding through THIS helper so they can never drift. `stagedDir` is forwarded for
 * artifact existence-checking; the signature itself is over the executable SET (hooks/mods/mcp incl.
 * env/cwd), not the missingArtifacts list, so it is a stable key regardless of the stagedDir.
 */
function signatureForManifest(manifest, stagedDir) {
    return disclosureSignature(discloseExecutableSurfaces(manifest, stagedDir));
}
// ---------------------------------------------------------------------------
// Human-readable consent prompt
// ---------------------------------------------------------------------------
/** Max characters of an env VALUE shown in the human consent prompt before it is truncated. */
const ENV_VALUE_MAX = 60;
/**
 * Environment names that turn a declared pair into arbitrary code execution in a spawned child
 * (#2483). This list drives the consent prompt's WARNING line. The capability validator carries its
 * own denylist that REFUSES these names outright (`DENIED_LANE_ENV_KEYS`); the two are deliberately
 * separate layers rather than one, because they answer different questions: the validator refuses a
 * manifest it can reject, and this list makes sure anything that DOES reach a prompt is read loudly.
 * Neither is the boundary — install-time consent is, since no enumeration of execution-primitive
 * names can be complete against an arbitrary third-party child.
 */
const EXECUTION_PRIMITIVE_ENV = new Set([
    'NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'LD_PRELOAD', 'LD_AUDIT', 'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'PYTHONSTARTUP', 'PYTHONPATH', 'BASH_ENV', 'ENV',
    'PERL5OPT', 'RUBYOPT', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH', 'NODE_PATH',
    'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'PATH',
]);
/** Truncate a long env value for the human prompt (the full value is still in the signature). */
function truncateEnvValue(v) {
    if (typeof v !== 'string')
        return '';
    return v.length > ENV_VALUE_MAX ? `${v.slice(0, ENV_VALUE_MAX)}… (${v.length} chars)` : v;
}
/**
 * Characters that must never reach the consent prompt unescaped. `summarizeDisclosure`'s lines are
 * joined with `\n` and written RAW to stderr on the needs-consent path, and every value in them is
 * attacker-controlled manifest data. A raw newline forges a line indistinguishable from genuine
 * disclosure text; a raw ESC lets a value rewrite or clear lines already printed; a bidi override
 * visually reorders one. C0, DEL, C1, the bidi/isolate controls, and the line/paragraph separators
 * are all escaped to a visible `\uXXXX`, so the value stays identifiable and cannot forge output.
 */
const UNSAFE_PROMPT_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
/** Max characters of any single manifest-supplied value rendered into the consent prompt. */
const PROMPT_VALUE_MAX = 200;
/**
 * Render one manifest-supplied value safely into a consent-prompt line: escape every character that
 * could forge or rewrite output, then bound the length so one oversized value cannot flood the
 * prompt and push the rest off screen. Escaping is IDENTITY for ordinary names, so this changes no
 * existing rendered output for any well-formed manifest — only the disclosure OBJECT is verbatim;
 * the rendered LINE is always escaped.
 */
function renderValueForPrompt(v) {
    // `String(v)` on an arbitrary `unknown` risks Object's default `[object Object]` stringification
    // (@typescript-eslint/no-base-to-string) for a non-primitive; every call site here passes a string
    // in practice, but the parameter stays `unknown` for the same total-collector discipline as
    // `renderArgForHuman`, so a non-primitive is JSON-stringified instead of coerced.
    let s;
    if (typeof v === 'string') {
        s = v;
    }
    else if (v === null || v === undefined) {
        s = '';
    }
    else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
        s = String(v);
    }
    else {
        try {
            s = JSON.stringify(v) ?? '';
        }
        catch {
            s = '';
        }
    }
    const escaped = s.replace(UNSAFE_PROMPT_CHARS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return escaped.length > PROMPT_VALUE_MAX
        ? `${escaped.slice(0, PROMPT_VALUE_MAX)}… (${escaped.length} chars)`
        : escaped;
}
/**
 * Render the instruction-surface section of a consent summary (ADR-2363 D3/D5, #3248).
 *
 * Extracted as its own exported function for two reasons. It is called from BOTH branches of
 * `summarizeDisclosure` — a skill-only capability has `hasExecutable === false` and takes the early
 * return, so a section appended only at the end would never render for exactly the capabilities
 * that need it. And it gives tests a typed surface to assert on, instead of regex-matching prose out
 * of `summarizeDisclosure` (CONTRIBUTING — "Prohibited: Raw Text Matching on Test Outputs").
 *
 * Returns `[]` when nothing is declared, so either caller can append unconditionally without
 * emitting an empty header.
 *
 * TOTAL for a partial disclosure object: the CLI edge calls `summarizeDisclosure(res.disclosure || {})`
 * (`capability-command-router.cjs`), so a bare `{}` — carrying no `instructionSurfaces` at all —
 * reaches this function whenever a lifecycle result has no disclosure.
 *
 * #3248: every manifest-supplied value rendered here (`kind`, `name`) goes through
 * `renderValueForPrompt` first — the CLI edge writes these lines RAW to stderr on the needs-consent
 * path, and an unescaped name could forge a line or rewrite output already printed (see that
 * function's comment).
 */
function summarizeInstructionSurfaces(disclosure) {
    const declared = disclosure?.instructionSurfaces;
    const surfaces = Array.isArray(declared) ? declared : [];
    if (surfaces.length === 0)
        return [];
    const lines = [
        `  instruction surfaces (${surfaces.length}): installed into your agent's instruction context`,
    ];
    for (const s of surfaces) {
        // #3248: kind/name are manifest-supplied — escape+bound before rendering (see `renderValueForPrompt`).
        const kind = s?.kind ? renderValueForPrompt(s.kind) : '(kind?)';
        const name = s?.name ? renderValueForPrompt(s.name) : '(name?)';
        lines.push(`    - ${kind}: ${name}`);
    }
    // ADR-2363 D1/D2, and Kerckhoffs: say plainly that nothing inspected these bodies. A summary that
    // named the surface while implying review would be worse than silence — a "looks checked" line
    // displaces the judgement this prompt exists to provoke (Goodhart, D2).
    lines.push('        these bodies are installed verbatim and are NOT content-scanned');
    return lines;
}
/**
 * Render a disclosure as consent-prompt lines. Returned as an array so the CLI/runtime edge can
 * format it; the lib never writes to stdout.
 *
 * #3248: every manifest-supplied value interpolated into a line (hook event/script, command
 * family/module/router, MCP name/transport/url/command/argv/header-keys/env-keys+values/cwd,
 * reviewer-lane slug/hostConfigKey/resolvedHost/defaultHost/binary/rawArgs/handler/probe-binary/
 * env-keys+values, missingArtifacts entries)
 * goes through `renderValueForPrompt` first, which escapes forging/rewriting control characters and
 * bounds the length. These lines are joined with `\n` and written RAW to stderr on the
 * needs-consent path (`capability-command-router.cjs`), so an unescaped value could forge a line or
 * rewrite/clear output already printed — defeating the informed-consent guarantee this function
 * exists to provide. GSD-authored literals (fallback placeholders, headings, `<redacted>`) are never
 * escaped — only manifest-supplied data is.
 */
/**
 * #3515: one predicate for "this MCP server is remote (connects to a URL; nothing local is
 * spawned)" — shared by the section's confinement notice and the per-server rendering so the
 * consent-prompt claim cannot drift from what is actually disclosed per server. Branches on the
 * DECLARED SHAPE: an http/sse transport, or a server with no command but a url.
 */
function isRemoteMcpServer(s) {
    return (s.transport === 'http' || s.transport === 'sse') || (!s.command && !!s.url);
}
function summarizeDisclosure(disclosure) {
    const lines = [];
    const instructionLines = summarizeInstructionSurfaces(disclosure);
    // #3514 (F21c): computed once, appended before every return path so a future path cannot miss it.
    const integrity = integrityStatusLine(disclosure);
    if (!disclosure.hasExecutable) {
        // ADR-2363 D3: "declarative only" is true ONLY when there is no instruction surface either.
        // Claiming it unconditionally told a user their capability contributes nothing to weigh while
        // it was contributing agent instructions — the exact category error ADR-2363 was written to end.
        if (instructionLines.length === 0) {
            lines.push('This capability ships no executable surfaces (declarative only).');
            if (integrity)
                lines.push(integrity);
            return lines;
        }
        lines.push('This capability ships no executable surfaces, but contributes agent instructions:');
        for (const line of instructionLines)
            lines.push(line);
        if (integrity)
            lines.push(integrity);
        return lines;
    }
    lines.push('This capability ships executable surfaces that will run in your agent runtime:');
    if (disclosure.hooks.length > 0) {
        lines.push(`  hooks (${disclosure.hooks.length}): run as runtime hook commands`);
        for (const h of disclosure.hooks) {
            const event = h.event ? renderValueForPrompt(h.event) : '(event?)';
            lines.push(`    - ${event} -> ${renderValueForPrompt(h.script)}`);
        }
    }
    if (disclosure.commandModules.length > 0) {
        lines.push(`  command modules (${disclosure.commandModules.length}): require()'d into the GSD CLI process`);
        for (const m of disclosure.commandModules) {
            // TRUST2-3 (#1459): show the router (which exported fn runs) so the user consents to the exact entry point.
            const routerSuffix = m.router ? ` [router: ${renderValueForPrompt(m.router)}]` : '';
            const family = m.family ? renderValueForPrompt(m.family) : '(family?)';
            lines.push(`    - ${family} -> ${renderValueForPrompt(m.module)}${routerSuffix}`);
        }
    }
    if (disclosure.mcpServers.length > 0) {
        lines.push(`  MCP servers (${disclosure.mcpServers.length}): spawned/connected by the host runtime`);
        // #3515 (epic #1900 F20): the confinement-posture notice. Hook commands are confined to the
        // capability bundle (D5 rule 5); an MCP server's command/args/env/cwd are written VERBATIM and
        // may point anywhere on the machine — an intentional asymmetry (confining them would break
        // global/npx servers), disclosed here so the consent is informed rather than assumed. env is
        // named explicitly (isolated review finding): an execution-primitive env value changes WHAT
        // runs without touching command or argv — the classic vector — and omitting it would invite
        // the inference that env IS confined. Only SPAWNED (stdio) servers earn the line: a remote
        // (http/sse) server runs nothing locally, and the claim must be exact in a consent prompt.
        // One shared predicate (below) decides spawn-vs-remote for the notice AND the per-server
        // rendering, so the two cannot drift into an inexact claim.
        if (disclosure.mcpServers.some((s) => !isRemoteMcpServer(s))) {
            lines.push('    intentionally NOT confined to the bundle: a server\'s command, args, env, and cwd are written ' +
                'verbatim and may point anywhere on this machine — unlike hooks, which are confined to the capability bundle root');
        }
        for (const s of disclosure.mcpServers) {
            // TRUST2-2 (#1459): a non-stdio (http/sse) server connects to a URL; disclose the endpoint, not
            // a (nonexistent) command. A stdio server discloses command + args as before.
            const isRemote = isRemoteMcpServer(s);
            const name = renderValueForPrompt(s.name);
            if (isRemote) {
                const t = s.transport ? renderValueForPrompt(s.transport) : 'http';
                const url = s.url ? renderValueForPrompt(s.url) : '(no url declared)';
                lines.push(`    - ${name} -> [${t}] ${url}`);
                // Header VALUES are redacted in the human summary (they may carry secrets); only the KEY set
                // is shown. The full values ARE in the signature, so a value change forces re-consent.
                const hdrKeys = s.headers ? Object.keys(s.headers) : [];
                if (hdrKeys.length > 0) {
                    lines.push(`        headers: ${hdrKeys.map((k) => `${renderValueForPrompt(k)}=<redacted>`).join(', ')}`);
                }
            }
            else {
                // Command + args are each escaped individually (not the joined string) so a value that
                // embeds a newline cannot forge a line even when it lands mid-argv.
                const cmd = [s.command, ...s.argv].filter(Boolean).map(renderValueForPrompt).join(' ');
                lines.push(`    - ${name} -> ${cmd || '(no command declared)'}`);
            }
            // TRUST-2 (#1459): env can change WHAT runs without touching the command, so show each env key
            // and its (truncated) value — the user is consenting to this exact environment. Truncate first
            // (keeps the prompt readable at the existing 60-char bound), then escape the result (#3248) so
            // the truncated value can still not forge or rewrite output.
            const envKeys = s.env ? Object.keys(s.env) : [];
            if (envKeys.length > 0) {
                lines.push(`        env: ${envKeys
                    .map((k) => `${renderValueForPrompt(k)}=${renderValueForPrompt(truncateEnvValue(s.env[k]))}`)
                    .join(', ')}`);
            }
            if (s.cwd)
                lines.push(`        cwd: ${renderValueForPrompt(s.cwd)}`);
        }
    }
    if (disclosure.reviewerLanes.length > 0) {
        lines.push(`  reviewer lane (${disclosure.reviewerLanes.length}): an external reviewer receives plan/review data on every run`);
        for (const l of disclosure.reviewerLanes) {
            // B1/B2/B3/B4: disclose binary+args for a spawn lane, or hostConfigKey+resolved destination
            // (flagged local when applicable, never omitted as "safe") for an openai-http lane — never
            // curl/the transport name alone, which would be true and useless (design B2).
            // Branch on the DECLARED SHAPE, not on an exact transport string. A lane
            // whose transport is mis-cased or unrecognised still has a hostConfigKey,
            // and falling through to the spawn branch would print "(no binary
            // declared)" for a lane that in fact egresses to a live remote host —
            // understating the disclosure precisely when it matters. Disclosure runs
            // BEFORE validation, so a non-canonical transport does reach this code.
            const slug = l.slug ? renderValueForPrompt(l.slug) : '(slug?)';
            if (l.transport === 'openai-http' || (!l.binary && l.hostConfigKey)) {
                const localTag = l.isLocalDestination ? ' [local]' : '';
                const hostConfigKey = l.hostConfigKey ? renderValueForPrompt(l.hostConfigKey) : '(hostConfigKey?)';
                lines.push(`    - ${slug} -> [openai-http] ${hostConfigKey} => ${renderValueForPrompt(l.resolvedHost)}${localTag}`);
                // #2483: the MANIFEST's own fallback host, which `resolveLanePlan` uses whenever the config
                // key resolves to nothing (`configured ?? declaredDefault`). Without this line a lane whose
                // key is unset renders as "(unresolved)" — which reads as "no destination" — while actually
                // shipping the egress payload classes below to an address the manifest chose. That is the
                // understating-the-disclosure failure the branch test one comment up already refuses.
                // Escaped like every other rendered value (#3248): it is manifest-supplied by the same route.
                if (l.defaultHost) {
                    lines.push(`        fallback destination declared by this capability: ${renderValueForPrompt(l.defaultHost)}`);
                }
            }
            else {
                // Render the RAW declared args, not the string-filtered view. The raw
                // array is what the host receives and what the consent signature binds,
                // so a non-string member that is invisible here is a surface the user
                // consented to without being shown — the opposite of the disclosure's
                // whole purpose. `renderArgForHuman` stringifies a non-string member; that
                // string is equally attacker-controlled, so it is escaped too (#3248).
                const cmd = [l.binary, ...l.rawArgs.map(renderArgForHuman)]
                    .filter(Boolean)
                    .map(renderValueForPrompt)
                    .join(' ');
                lines.push(`    - ${slug} -> ${cmd || '(no binary declared)'}`);
            }
            if (l.handler)
                lines.push(`        handler: ${renderValueForPrompt(l.handler)}`);
            // The probe binary belongs in the prompt beside the dispatch binary when it differs — but the
            // two probe kinds are NOT the same disclosure and must not be rendered as one.
            // `command-capability` SPAWNS `<binary> --help`; `command-exists` only asks `hasBinary`, which
            // scans PATH and spawns nothing. An earlier revision of this line asserted the spawn for both,
            // which is a FALSE statement in a consent prompt — the one place a claim must be exact.
            if (l.probeBinary && l.probeBinary !== l.binary) {
                const probeBinary = renderValueForPrompt(l.probeBinary);
                lines.push(l.probeKind === 'command-capability'
                    ? `        probes by running: ${probeBinary} --help`
                    : `        probes for the presence of: ${probeBinary} (no process is started)`);
            }
            // #2483: identical treatment to the MCP `env` line above, for the identical reason stated
            // there — env changes WHAT runs without touching the command, so the user consents to this
            // exact environment or not at all. The parity is byte-level and deliberate: since #3248 the
            // MCP line escapes BOTH key and value through `renderValueForPrompt`, and a lane's env is
            // manifest-supplied by the same route — so rendering it raw here would reintroduce, on the
            // newer surface, precisely the prompt-forging vector #3248 closed on the older one.
            const laneEnvKeys = l.env ? Object.keys(l.env) : [];
            if (laneEnvKeys.length > 0) {
                lines.push(`        env: ${laneEnvKeys
                    .map((k) => `${renderValueForPrompt(k)}=${renderValueForPrompt(truncateEnvValue(l.env[k]))}`)
                    .join(', ')}`);
                // Names that make an environment pair an EXECUTION primitive rather than configuration.
                // The validator REFUSES these on a reviewer lane (`DENIED_LANE_ENV_KEYS`), so in practice a
                // first-party or freshly-validated manifest never reaches this line. It still earns its
                // place, and the reason is the reason to keep both layers:
                //   - Disclosure runs BEFORE validation, and on manifests validation would reject outright.
                //     A user consenting to an already-installed or hand-placed capability sees this line
                //     whether or not the validator ever ran on it.
                //   - No enumeration of execution-primitive names is complete against an arbitrary
                //     third-party child, so consent — not either list — is the boundary. A name missing from
                //     both costs a quieter line on a value that is still SHOWN, which is the only
                //     incompleteness budget an enumeration like this can honestly carry.
                const flagged = laneEnvKeys.filter((k) => EXECUTION_PRIMITIVE_ENV.has(k));
                if (flagged.length > 0) {
                    lines.push(`        WARNING — ${flagged.map(renderValueForPrompt).join(', ')} can make this lane run code of the capability's choosing`);
                }
            }
            lines.push(`        sends: ${l.egressPayloadClasses.join(', ')}`);
        }
    }
    for (const line of instructionLines)
        lines.push(line);
    if (disclosure.missingArtifacts.length > 0) {
        lines.push('  WARNING — declared artifacts not found in the staged bundle:');
        for (const a of disclosure.missingArtifacts) {
            lines.push(`    - ${renderValueForPrompt(a)}`);
        }
    }
    if (integrity)
        lines.push(integrity);
    return lines;
}
/**
 * #3514 (F21c): the one-line integrity status for the consent prompt, or null when the caller
 * supplied no `integrityPin` (legacy — no line, byte-identical output). GSD-authored literals,
 * never manifest data — no escaping needed. A consent-prompt claim must be EXACT: a git
 * commit-pinned source renders its own line, never "sha512 pin" — no sha512 was supplied
 * (isolated review finding).
 */
function integrityStatusLine(disclosure) {
    if (disclosure.integrityStatus === 'pinned') {
        return '  content: sha512 pin supplied and verified before staging';
    }
    if (disclosure.integrityStatus === 'commit-pinned') {
        return '  content: pinned to a git commit, checked out before staging';
    }
    if (disclosure.integrityStatus === 'unverified') {
        return '  content: NO PINNED HASH — staged unverified (a computed sha512 is recorded in the ledger at install)';
    }
    return null;
}
module.exports = {
    RESERVED_NAMESPACES,
    discloseExecutableSurfaces,
    // #2796: the reviewer-lane collector, exported for independent testability (ADR-2782's own
    // argument for extracting per-class collectors rather than growing the switch inline).
    collectReviewerLaneSurfaces,
    // ADR-2363 D5 (#3248): the instruction-surface collector, exported for independent testability —
    // same rationale as `collectReviewerLaneSurfaces` above.
    collectInstructionSurfaces,
    checkReservedNamespace,
    evaluateSourceAllowed,
    checkEngines,
    evaluateInstallTrust,
    executableSetChanged,
    summarizeDisclosure,
    // ADR-2363 D3/D5 (#3248): the instruction-surface section of the consent summary, exported so
    // callers/tests can assert on it directly — see `summarizeInstructionSurfaces`'s own JSDoc.
    summarizeInstructionSurfaces,
    // #3248: the consent-prompt escaping/bounding helper, exported so tests can assert directly that
    // control characters (newline, ESC, bidi overrides, etc.) never reach a rendered prompt line.
    renderValueForPrompt,
    // #1459: the consent-binding signature (single source of truth for loader + lifecycle consent).
    disclosureSignature,
    signatureForManifest,
    // #2796: the non-blank unresolved-host marker and the named egress payload classes, exported so
    // tests can assert exact equality rather than a loose substring match.
    UNRESOLVED_HOST_MARKER,
    EGRESS_PAYLOAD_CLASSES,
};
