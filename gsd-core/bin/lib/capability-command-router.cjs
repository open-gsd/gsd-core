'use strict';
/**
 * capability-command-router.cjs — ADR-2346 P2 (#2368).
 *
 * Behavior-preserving relocation of the former `case 'capability':` arm from
 * gsd-tools.cjs (gsd-tools.cjs:1693..2399, pre-cutover). Owns the capability
 * lifecycle CLI (state/list/install/upgrade/remove/consent/trust) and wires the
 * capability-lifecycle / -trust / -consent / -ledger / -loader modules.
 *
 * Dispatched via HOST_COMMAND_ROUTERS.capability in runCommand's default case
 * (host dispatch table, ADR-2346 Layer 2). Hand-authored CJS (sibling of
 * ensure-runtime-build.cjs) — not a generated .cts, so it is committed directly.
 *
 * NOTE: the require() paths below are sibling-relative (./X.cjs), correct for
 * this file's home in bin/lib/ — rewritten from the arm's original ./lib/X.cjs
 * (which resolved relative to bin/gsd-tools.cjs).
 */

const fs = require('node:fs');
const path = require('node:path');
const io = require('./io.cjs');
const { output, error, ERROR_REASON } = io;
const { ExitError } = require('./cli-exit.cjs');
const capabilityState = require('./capability-state.cjs');
const capabilityWriter = require('./capability-writer.cjs');

async function routeCapabilityCommand({ args, cwd, raw }) {
  // capability state [--config-dir <path>]
  // Root resolution: 'capability' is NOT in SKIP_ROOT_RESOLUTION for the
  // same reason 'loop' is not: both are registry/config queries that need
  // the project root (cwd) for .planning/config.json activation resolution.
  // If 'loop' were ever added to SKIP_ROOT_RESOLUTION, 'capability' should
  // be added at the same time to keep them consistent.
  const capSubcommand = args[1];
  // --- Capability management CLI helpers (ADR-1244 D5/D6; install/update/remove/list/disable/enable).
  //     Pure arg parsing + scope/config/host-version resolution. The lifecycle modules themselves are
  //     lazy-required inside each mutating branch so the common state/set paths never load them. ---
  const capFlagValue = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const v = args[i + 1];
    if (!v || v.startsWith('--')) {
      error(`Missing value for ${name}`, ERROR_REASON ? ERROR_REASON.USAGE : undefined);
    }
    return v;
  };
  const capHasFlag = (name) => args.includes(name);
  const capRepeatedFlag = (name) => {
    const out = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === name) {
        const v = args[i + 1];
        if (!v || v.startsWith('--')) {
          error(`Missing value for ${name}`, ERROR_REASON ? ERROR_REASON.USAGE : undefined);
        }
        out.push(v);
        i++; // skip the consumed value
      }
    }
    return out;
  };
  // Resolve a --scope value to the lifecycle runtimeDir — the scope ROOT that holds
  // .gsd/capabilities/<id> and the .gsd-capabilities.json ledger, matching capability-loader's
  // read paths exactly (global → $GSD_HOME||home; project → the resolved project root). For the
  // project scope this is just `cwd`: the outer dispatch already resolved cwd to the project root
  // via findProjectRoot (capability is NOT in SKIP_ROOT_RESOLUTION), so no second resolve is needed.
  // Note: the strict_known_registries policy (capReadStrict) is read from the PROJECT config
  // regardless of --scope — it is a project-scoped policy; there is no machine-wide source allowlist.
  const capResolveScope = (scope) => {
    const s = scope || 'global';
    if (s !== 'global' && s !== 'project') {
      error(`Invalid --scope "${s}": expected global or project`, ERROR_REASON ? ERROR_REASON.USAGE : undefined);
    }
    if (s === 'project') return { scope: 'project', runtimeDir: cwd };
    const os = require('node:os');
    return { scope: 'global', runtimeDir: process.env.GSD_HOME || os.homedir() };
  };
  // capabilities.strict_known_registries policy (null=permissive, []=lockdown, [hosts]=allowlist).
  // loadConfig's whitelist does not surface this key, so read config.json directly (drift-guard pattern);
  // undefined => the lifecycle's permissive default. The raw value is passed THROUGH verbatim — a
  // malformed (non-array, non-null) value must reach the trust gate so it can fail CLOSED, not be
  // silently downgraded to permissive here.
  const capReadStrict = () => {
    let cfgPath;
    try {
      const { planningDir } = require('./planning-workspace.cjs');
      cfgPath = path.join(planningDir(cwd), 'config.json');
    } catch {
      return undefined; // cannot even resolve the project config dir — permissive default
    }
    if (!fs.existsSync(cfgPath)) return undefined; // no project config — permissive default
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    } catch {
      // Config is PRESENT but unreadable/unparseable: a security policy must not silently
      // downgrade to permissive. Fail CLOSED — lockdown ([]) blocks external installs (local
      // still allowed) until the config is fixed.
      return [];
    }
    if (cfg && cfg.capabilities && Object.prototype.hasOwnProperty.call(cfg.capabilities, 'strict_known_registries')) {
      return cfg.capabilities.strict_known_registries;
    }
    return undefined;
  };
  // Running GSD version (hard gate for engines.gsd at install/load); fail-closed to 0.0.0.
  // #1920: prefer the authoritative gsd-core/VERSION the installer writes for EVERY runtime
  // (gsd-core/bin/ -> ../VERSION), so installed layouts report the true version even when the
  // walked-up ../../package.json is the versionless CommonJS marker or the user's own project.
  // Fall back to the runtime-root package.json (dev/source tree), then fail-closed. Mirrors
  // readHostVersion() in capability-loader.cts.
  const capHostVersion = () => {
    const SEMVER_PREFIX = /^\d+\.\d+\.\d+/;
    try {
      const v = fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim();
      if (SEMVER_PREFIX.test(v)) return v;
    } catch { /* not an installed tree (no gsd-core/VERSION) */ }
    try {
      const pkg = require(path.join(__dirname, '..', '..', '..', 'package.json')); // gsd-core/bin/lib/ -> repo root is three up
      if (pkg && typeof pkg.version === 'string' && SEMVER_PREFIX.test(pkg.version)) return pkg.version;
    } catch { /* runtime root has no package.json */ }
    return '0.0.0';
  };
  // #1459: the USER-OWNED consent home (GSD_HOME||homedir()) where project-scope consent records
  // live — OUTSIDE any repo. SAME rule as the loader/consent-store path resolution so a record
  // written here is the record the loader checks.
  const capConsentHome = () => {
    const osMod = require('node:os');
    return process.env.GSD_HOME || osMod.homedir();
  };
  // #1459: realpath(cwd) — the canonical PROJECT ROOT used to bind/lookup a project consent
  // record (the consent store realpaths it too, so loader + CLI agree). Best-effort: cwd if the
  // path cannot be realpath'd (e.g. it does not exist yet).
  const capProjectRoot = () => {
    try { return fs.realpathSync(cwd); } catch { return cwd; }
  };
  // UX-2: run the best-effort pre-op crash-recovery sweep AND surface any warnings it reports
  // (e.g. a corrupt-present ledger, or a rollback that could not complete) on stderr. The previous
  // bare `try { reconcile } catch {}` discarded the report entirely, so corruption detected during
  // reconcile was invisible. We never abort on a reconcile warning here — the mutating op that
  // follows runs its own fail-closed checks — but the warning must be OBSERVABLE.
  // #1459 IC-03: pass scope + the user-owned consent home so a rollback that DELETES a committed/
  // half-committed PROJECT-scope entry whose bundle dir is gone also REVOKES the now-stale consent
  // record (an identical re-drop then stays inactive until re-consented). Global scope / no store →
  // reconcile revokes nothing.
  const capRunReconcile = (runtimeDir, lifecycle, scope) => {
    try {
      const report = lifecycle.reconcileCapabilities({ runtimeDir, scope, consentStoreDir: capConsentHome() });
      if (report && Array.isArray(report.warnings)) {
        for (const w of report.warnings) {
          try { process.stderr.write(`capability reconcile: ${w}\n`); } catch { /* best-effort */ }
        }
      }
    } catch { /* best-effort crash recovery — never block the op on a reconcile failure */ }
  };
  if (capSubcommand === 'state') {
    const configDirIdx = args.indexOf('--config-dir');
    let configDir = null;
    if (configDirIdx !== -1) {
      const configDirVal = args[configDirIdx + 1];
      // Validate that --config-dir has a following non-flag value.
      if (!configDirVal || configDirVal.startsWith('--')) {
        error('Missing value for --config-dir', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
      }
      configDir = configDirVal;
    }
    const resolvedConfigDir = configDir ? path.resolve(configDir) : null;
    // --runtime <r> (#2003): explicit runtime override so the config-dir
    // resolution bypasses the persisted-runtime fallback. Dual-form like
    // --config-dir (--runtime X / --runtime=X).
    let stateRuntime = undefined;
    const stateRuntimeEqArg = args.find(arg => arg.startsWith('--runtime='));
    const stateRuntimeIdx = args.indexOf('--runtime');
    if (stateRuntimeEqArg) {
      const value = stateRuntimeEqArg.slice('--runtime='.length).trim();
      if (!value) error('Missing value for --runtime', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
      stateRuntime = value;
    } else if (stateRuntimeIdx !== -1) {
      const value = args[stateRuntimeIdx + 1];
      if (!value || value.startsWith('--')) {
        error('Missing value for --runtime', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
      }
      stateRuntime = value;
    }
    capabilityState.cmdCapabilityState(cwd, resolvedConfigDir, raw, { runtime: stateRuntime });
  } else if (capSubcommand === 'set') {
    // capability set <id> [--on|--off|--enable|--disable] [--gate <key>=<bool>]... [--config-dir <dir>] [--runtime <r>] [--scope <s>]
    const capId = args[2];
    if (!capId || capId.startsWith('--')) {
      error('Missing capability id for: capability set <id>', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
    }
    // Parse --config-dir
    const setConfigDirIdx = args.indexOf('--config-dir');
    let setConfigDir = null;
    if (setConfigDirIdx !== -1) {
      const setConfigDirVal = args[setConfigDirIdx + 1];
      if (!setConfigDirVal || setConfigDirVal.startsWith('--')) {
        error('Missing value for --config-dir', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
      }
      setConfigDir = setConfigDirVal;
    }
    const resolvedSetConfigDir = setConfigDir ? path.resolve(setConfigDir) : null;
    // Parse --on/--enable and --off/--disable (mutually exclusive)
    const hasOn = args.includes('--on') || args.includes('--enable');
    const hasOff = args.includes('--off') || args.includes('--disable');
    if (hasOn && hasOff) {
      error('Conflicting flags: --on/--enable and --off/--disable cannot both be present', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
    }
    let setEnabled;
    if (hasOn) {
      setEnabled = true;
    } else if (hasOff) {
      setEnabled = false;
    }
    // Parse --gate <key>=<bool> (repeatable)
    const setGates = {};
    for (let gi = 0; gi < args.length; gi++) {
      if (args[gi] === '--gate') {
        const gateVal = args[gi + 1];
        if (!gateVal || gateVal.startsWith('--')) {
          error('Missing value for --gate (expected <key>=<true|false>)', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
        }
        const eqIdx = gateVal.indexOf('=');
        if (eqIdx === -1) {
          error(`Malformed --gate value "${gateVal}": expected <key>=<true|false>`, ERROR_REASON ? ERROR_REASON.USAGE : undefined);
        }
        const gateKey = gateVal.slice(0, eqIdx);
        const gateBoolStr = gateVal.slice(eqIdx + 1);
        if (gateBoolStr !== 'true' && gateBoolStr !== 'false') {
          error(`Malformed --gate value "${gateVal}": bool must be true or false`, ERROR_REASON ? ERROR_REASON.USAGE : undefined);
        }
        setGates[gateKey] = gateBoolStr === 'true';
        gi++; // skip consumed value
      }
    }
    // Parse --runtime and --scope (validate that values are present and not flags)
    const runtimeIdx = args.indexOf('--runtime');
    let setRuntime;
    if (runtimeIdx !== -1) {
      const runtimeVal = args[runtimeIdx + 1];
      if (!runtimeVal || runtimeVal.startsWith('--')) {
        error('Missing value for --runtime', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
      }
      setRuntime = runtimeVal;
    }
    const scopeIdx = args.indexOf('--scope');
    let setScope;
    if (scopeIdx !== -1) {
      const scopeVal = args[scopeIdx + 1];
      if (!scopeVal || scopeVal.startsWith('--')) {
        error('Missing value for --scope', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
      }
      setScope = scopeVal;
    }
    capabilityWriter.cmdCapabilitySet(
      cwd,
      resolvedSetConfigDir,
      capId,
      { enabled: setEnabled, gates: Object.keys(setGates).length > 0 ? setGates : undefined, runtime: setRuntime, scope: setScope },
      raw,
    );
  } else if (capSubcommand === 'install') {
    // capability install <spec> [--integrity sha512-…] [--scope global|project] [--yes] [--shared-file <rel>]…
    const spec = args[2];
    if (!spec || spec.startsWith('--')) {
      error('Missing <spec> for: capability install <spec>', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
    }
    const { scope, runtimeDir } = capResolveScope(capFlagValue('--scope'));
    const lifecycle = require('./capability-lifecycle.cjs');
    const trust = require('./capability-trust.cjs');
    // Finding 5(b): bound the --shared-file COUNT EARLY — before reconcile, source resolution,
    // staging, or any shared-config write — so an over-cap install fails fast with a clear count
    // error and leaves NO staging dir / _pending behind. The lifecycle re-checks (defense in
    // depth); this CLI-side guard short-circuits before even the pre-op reconcile runs.
    const installSharedFiles = capRepeatedFlag('--shared-file');
    const ledgerModInstall = require('./capability-ledger.cjs');
    if (installSharedFiles.length > ledgerModInstall.MAX_SHARED_FILES) {
      error(
        `capability install blocked: too many --shared-file entries: ${installSharedFiles.length} ` +
        `exceeds the maximum of ${ledgerModInstall.MAX_SHARED_FILES}.`,
        ERROR_REASON ? ERROR_REASON.USAGE : undefined,
      );
    }
    capRunReconcile(runtimeDir, lifecycle, scope); // UX-2: surface reconcile warnings on stderr
    const res = await lifecycle.installCapability(spec, {
      runtimeDir,
      hostVersion: capHostVersion(),
      consentGranted: capHasFlag('--yes'),
      integrity: capFlagValue('--integrity'),
      sharedFiles: installSharedFiles,
      strictKnownRegistries: capReadStrict(),
      // #1459: bind a user consent record for a CONSENTED project install (under the user-owned
      // consent home, NOT in the repo). The lifecycle records nothing for global scope.
      scope,
      consentStoreDir: capConsentHome(),
    });
    if (res.status === 'installed') {
      output({
        status: 'installed',
        id: res.id,
        version: res.version,
        scope,
        disclosure: trust.summarizeDisclosure(res.disclosure || {}),
      }, raw);
    } else if (res.status === 'aborted') {
      // 'aborted' always means "executable surface needs consent" in the lifecycle contract —
      // match it regardless of the requiresConsent flag so a future aborted path can't fall
      // through to the generic "blocked: unknown reason" arm with a misleading message.
      const disclosure = trust.summarizeDisclosure(res.disclosure || {});
      // UX-5: emit a structured aborted envelope on STDOUT before the non-zero exit so automation
      // can detect the consent requirement programmatically. We throw ExitError (not error(),
      // which calls process.exit and would bypass the stdout-capture flush) so the buffered stdout
      // is flushed before exit; the human-readable guidance still lands on stderr.
      output({ status: 'aborted', requiresConsent: true, scope, disclosure }, raw);
      throw new ExitError(
        1,
        ['Error: This capability declares executable surfaces and needs your consent before install:']
          .concat(disclosure.map((l) => '  ' + l))
          .concat(['Re-run with --yes to grant consent and install.'])
          .join('\n'),
      );
    } else {
      error(
        `capability install blocked: ${(res.blockReasons || ['unknown reason']).join('; ')}`,
        ERROR_REASON ? ERROR_REASON.SDK_FAIL_FAST : undefined,
      );
    }
  } else if (capSubcommand === 'update') {
    // capability update [<id> | --all] [--scope global|project] [--yes] [--shared-file <rel>]…
    const all = capHasFlag('--all');
    const id = args[2] && !args[2].startsWith('--') ? args[2] : undefined;
    if (!all && !id) {
      error('capability update requires <id> or --all', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
    }
    if (all && id) {
      error('capability update: pass either <id> or --all, not both', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
    }
    const { scope, runtimeDir } = capResolveScope(capFlagValue('--scope'));
    const lifecycle = require('./capability-lifecycle.cjs');
    const ledgerMod = require('./capability-ledger.cjs');
    const trust = require('./capability-trust.cjs');
    // Finding 4 (MEDIUM): parse the --shared-file list ONCE and enforce MAX_SHARED_FILES BEFORE
    // the pre-op reconcile (install has this early guard; update did not — it ran reconcile, then
    // re-parsed --shared-file per entry inside upgradeOne). An over-cap update now fails fast with
    // a clear count error and leaves no reconcile side-effects, mirroring the install dispatch.
    const updateSharedFiles = capRepeatedFlag('--shared-file');
    if (updateSharedFiles.length > ledgerMod.MAX_SHARED_FILES) {
      error(
        `capability update blocked: too many --shared-file entries: ${updateSharedFiles.length} ` +
        `exceeds the maximum of ${ledgerMod.MAX_SHARED_FILES}.`,
        ERROR_REASON ? ERROR_REASON.USAGE : undefined,
      );
    }
    capRunReconcile(runtimeDir, lifecycle, scope); // UX-2: surface reconcile warnings on stderr
    // readLedgerStrict: returns null when MISSING (no installs yet), throws CorruptLedgerError
    // when the ledger FILE EXISTS but is unparseable. Using the strict variant ensures a
    // corrupt-but-present ledger fails closed rather than silently reporting not_installed (<id>)
    // or succeeding with an empty list (--all), both of which bypass fail-closed (Codex pass 3 M2).
    let ledger;
    try {
      ledger = ledgerMod.readLedgerStrict(runtimeDir);
    } catch (err) {
      error(`capability update blocked: ${err.message}`, ERROR_REASON ? ERROR_REASON.SDK_FAIL_FAST : undefined);
    }
    const entries = (ledger && ledger.entries) || {};
    const upgradeOne = async (capId) => {
      const entry = entries[capId];
      if (!entry) return { id: capId, status: 'not_installed' };
      // expectedId pins the op to the requested id: a retargeted/edited source that now resolves
      // to a different manifest id is refused by the lifecycle rather than upgrading the wrong cap.
      const r = await lifecycle.upgradeCapability(entry.source, {
        runtimeDir,
        hostVersion: capHostVersion(),
        consentGranted: capHasFlag('--yes'),
        sharedFiles: updateSharedFiles, // finding 4: parsed once, count-checked before reconcile
        strictKnownRegistries: capReadStrict(),
        expectedId: capId,
        // #1459: re-record the project consent for the upgraded bundle (new integrity/signature).
        scope,
        consentStoreDir: capConsentHome(),
      });
      // UX-6: normalize absent fields to explicit null so a not_installed/blocked row serializes
      // them as null rather than omitting them (JSON.stringify drops undefined keys), giving a
      // stable per-entry shape for `--all` consumers.
      return {
        id: capId,
        status: r.status,
        fromVersion: r.fromVersion ?? null,
        toVersion: r.toVersion ?? null,
        requiresConsent: r.requiresConsent ?? null,
        blockReasons: r.blockReasons ?? null,
        disclosure: r.disclosure ? trust.summarizeDisclosure(r.disclosure) : null,
      };
    };
    if (all) {
      // Sequential by design: each upgrade takes the per-scope capability lock; parallel
      // runs would contend on the ledger/lock (mirrors the worktree config.lock policy).
      const results = [];
      for (const capId of Object.keys(entries)) {
        results.push(await upgradeOne(capId));
      }
      const failed = results.filter((x) => x.status !== 'upgraded');
      if (failed.length > 0) {
        // UX-1: emit the FULL structured result on STDOUT first (success and partial-failure
        // alike), then set a non-zero exit. Previously the results JSON was embedded inside the
        // error STRING on stderr, so automation could not parse a partial-failure run as
        // structured data. We throw ExitError (not error(), which calls process.exit and would
        // bypass the stdout-capture flush) so the buffered stdout is flushed before exit and a
        // concise reason still lands on stderr.
        output({ scope, updated: results }, raw);
        throw new ExitError(
          1,
          `Error: capability update --all: ${failed.length} of ${results.length} did not upgrade ` +
            `(see the JSON result on stdout for per-capability status).`,
        );
      }
      output({ scope, updated: results }, raw);
    } else {
      const r = await upgradeOne(id);
      if (r.status === 'upgraded') {
        output({ status: 'upgraded', id: r.id, fromVersion: r.fromVersion, toVersion: r.toVersion, scope, disclosure: r.disclosure }, raw);
      } else if (r.status === 'not_installed') {
        error(`capability "${id}" is not installed in ${scope} scope; use: capability install`, ERROR_REASON ? ERROR_REASON.USAGE : undefined);
      } else if (r.status === 'aborted') {
        // 'aborted' always means "needs consent" (see install) — handle it independently of the
        // requiresConsent flag so it never falls through to the generic blocked arm.
        error(
          [`capability update for "${id}" changes its executable surface and needs your consent:`]
            .concat((r.disclosure || []).map((l) => '  ' + l))
            .concat(['Re-run with --yes to grant consent and update.'])
            .join('\n'),
          ERROR_REASON ? ERROR_REASON.USAGE : undefined,
        );
      } else {
        error(`capability update blocked: ${(r.blockReasons || ['unknown reason']).join('; ')}`, ERROR_REASON ? ERROR_REASON.SDK_FAIL_FAST : undefined);
      }
    }
  } else if (capSubcommand === 'remove') {
    // capability remove <id> [--purge-data] [--scope global|project]
    const id = args[2];
    if (!id || id.startsWith('--')) {
      error('Missing <id> for: capability remove <id>', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
    }
    const { scope, runtimeDir } = capResolveScope(capFlagValue('--scope'));
    const lifecycle = require('./capability-lifecycle.cjs');
    const ledgerMod = require('./capability-ledger.cjs');
    capRunReconcile(runtimeDir, lifecycle, scope); // UX-2: surface reconcile warnings on stderr
    // Ledger first: an installed overlay is removable even if its id shadows a first-party name.
    // Only when the id is NOT an installed overlay do we reject a first-party id (vs. a typo).
    // Use readLedgerStrict so a corrupt-but-present ledger surfaces corruption here rather than
    // silently reporting "first-party cannot be removed" for any id (finding 7).
    let removeLedger;
    try {
      removeLedger = ledgerMod.readLedgerStrict(runtimeDir);
    } catch (err) {
      error(`capability remove blocked: ${err.message}`, ERROR_REASON ? ERROR_REASON.SDK_FAIL_FAST : undefined);
    }
    const inLedger = !!(removeLedger && removeLedger.entries && Object.prototype.hasOwnProperty.call(removeLedger.entries, id));
    if (!inLedger) {
      const base = require('./capability-loader.cjs').loadRegistry();
      if (base && base.capabilities && Object.prototype.hasOwnProperty.call(base.capabilities, id)) {
        error(`"${id}" is a first-party capability and cannot be removed here; use the product uninstaller (gsd --uninstall)`, ERROR_REASON ? ERROR_REASON.USAGE : undefined);
      }
    }
    const res = lifecycle.removeCapability(id, {
      runtimeDir,
      removeData: capHasFlag('--purge-data'),
      // #1459: a project-scope removal revokes the user consent record so a later repo-dropped
      // bundle of the same id cannot silently re-activate against a stale consent.
      scope,
      consentStoreDir: capConsentHome(),
    });
    if (res.status === 'removed') {
      // #1459 finding 3: a project removal whose consent revoke FAILED (e.g. the consent-store lock
      // could not be acquired) is a NON-CLEAN removal — the bundle/ledger are gone but a STALE consent
      // record remains. Surface it on stderr + in the JSON so the user knows to clear it.
      if (res.consentRevokeFailed) {
        process.stderr.write(`warning: ${res.consentRevokeWarning || `consent record for "${id}" could not be revoked; clear it with: gsd capability trust revoke ${id}`}\n`);
      }
      output({
        status: 'removed',
        id,
        scope,
        removedFiles: res.removedFiles,
        strippedEdits: res.strippedEdits,
        dataPreserved: res.dataPreserved,
        consentRevokeFailed: res.consentRevokeFailed || undefined,
        consentRevokeWarning: res.consentRevokeWarning || undefined,
      }, raw);
    } else if (res.status === 'not_installed') {
      error(`capability "${id}" is not installed in ${scope} scope`, ERROR_REASON ? ERROR_REASON.USAGE : undefined);
    } else {
      error(`capability remove blocked: ${(res.blockReasons || ['unknown reason']).join('; ')}`, ERROR_REASON ? ERROR_REASON.SDK_FAIL_FAST : undefined);
    }
  } else if (capSubcommand === 'list') {
    // capability list [--json] [--scope global|project] — emits a JSON array of capability descriptors.
    // When --scope is given, only that scope's overlay ledger is read (finding 8: honor --scope so a
    // corrupt unrelated ledger in another scope does not block a scoped list).
    const loader = require('./capability-loader.cjs');
    const ledgerMod = require('./capability-ledger.cjs');
    const semver = require('./semver-compare.cjs');
    const host = capHostVersion();
    const rows = [];
    const listScopeArg = capFlagValue('--scope');
    // Validate --scope if provided.
    if (listScopeArg && listScopeArg !== 'global' && listScopeArg !== 'project') {
      error(`Invalid --scope "${listScopeArg}": must be "global" or "project"`, ERROR_REASON ? ERROR_REASON.USAGE : undefined);
    }
    // First-party capabilities are always included (they have no scope concept).
    const base = loader.loadRegistry();
    const fp = (base && base.capabilities) || {};
    // #1459: consult the composed overlay's warnings so a DISCOVERED-BUT-INACTIVE project overlay
    // (a bundle whose project ledger looks committed but has no user consent record on THIS
    // machine) is marked status:'inactive' with a reason, instead of silently appearing active.
    // loadRegistry is non-throwing; a failure here just leaves rows un-annotated.
    const inactiveById = {};
    try {
      const composed = loader.loadRegistry({ includeInstalled: true, cwd });
      const overlayWarnings = (composed && composed._overlay && composed._overlay.warnings) || [];
      for (const w of overlayWarnings) {
        // #1459 IC-02: classify by the STRUCTURAL discriminant `kind`, not by matching the
        // human-readable reason prose (which is free to change without breaking this filter).
        if (w && typeof w.id === 'string' && w.kind === 'unconsented') {
          inactiveById[`${w.scope} ${w.id}`] = w.reason;
        }
      }
    } catch { /* best-effort — list still works without the inactive annotation */ }
    // Issue #2045 (DEFECT 3): derive each capability's SURFACED state from the
    // SAME resolver `capability state` uses (resolveCapabilityRuntimeState), so
    // `list` and `state` stop disagreeing. `list` previously derived `status`
    // purely from ledger-entry existence — an installed-but-not-surfaced cap
    // reported active in `list` and absent in `state`. Surfaced is evaluated at
    // the default runtime config dir (the resolver resolves it when undefined),
    // matching `capability state <id>` with no --config-dir. Best-effort: a
    // resolver failure leaves surfacedById empty (rows report surfaced:null).
    const surfacedById = {};
    // surfacedById is keyed by capId only (NOT `${scope} ${capId}`): surface
    // state is single-source — one runtime config dir → one .gsd-surface.json
    // → one surfaced truth per capId — and the loader dedupes overlay caps to
    // one registry entry per id (first-party-wins). So a cap installed in both
    // scopes correctly shares one surfaced value across its list rows.
    try {
      const surfaceState = capabilityState.resolveCapabilityRuntimeState(cwd, undefined);
      for (const cap of (surfaceState && surfaceState.capabilities) || []) {
        if (cap && typeof cap.id === 'string') {
          surfacedById[cap.id] = cap.surfaced === true;
        }
      }
    } catch { /* best-effort — list still works without the surfaced annotation */ }
    for (const capId of Object.keys(fp)) {
      const cap = fp[capId] || {};
      rows.push({
        id: capId,
        role: cap.role || null,
        version: cap.version || null,
        tier: cap.tier || null,
        source: 'first-party',
        scope: 'first-party',
        status: 'active',
        surfaced: Object.prototype.hasOwnProperty.call(surfacedById, capId) ? surfacedById[capId] === true : null,
        title: cap.title || null,
      });
    }
    // Overlay scopes: honor --scope to read only the requested scope (finding 8).
    const overlayScopes = listScopeArg ? [listScopeArg] : ['global', 'project'];
    for (const sc of overlayScopes) {
      const { runtimeDir } = capResolveScope(sc);
      // readLedgerStrict: returns null when MISSING (no overlays yet), throws CorruptLedgerError
      // when the ledger FILE EXISTS but is unparseable. Using the strict variant ensures a
      // corrupt-but-present ledger is visible to the user (blocked/error) rather than silently
      // dropping overlay entries and returning a first-party-only list (site A fix, #1462).
      let ledger;
      try {
        ledger = ledgerMod.readLedgerStrict(runtimeDir);
      } catch (err) {
        // UX-3: name the offending scope so the user knows WHICH ledger to fix.
        error(`capability list blocked (${sc} scope): ${err.message}`, ERROR_REASON ? ERROR_REASON.SDK_FAIL_FAST : undefined);
      }
      if (!ledger || !ledger.entries) continue;
      for (const capId of Object.keys(ledger.entries)) {
        const entry = ledger.entries[capId];
        let manifest = {};
        try {
          // #1459 CONVERGENCE finding 2: read the (project-plantable) capability.json via the SHARED
          // bounded fd reader (open → fstat → require regular file → size cap → read exactly size), NOT
          // a raw fs.readFileSync which BLOCKS forever on a repo-planted FIFO/device manifest and reads
          // an oversized manifest unbounded into memory (OOM). 8 MiB is wildly more than any real
          // declarative capability.json. A null (genuinely missing) or a bounded-reader throw
          // (non-regular/oversized/IO) → leave manifest = {} so the entry is LISTED but with no metadata
          // (null role/tier/title) rather than hanging the list — `capability list` still exits cleanly.
          const raw = ledgerMod.readSmallRegularFile(path.join(runtimeDir, '.gsd', 'capabilities', capId, 'capability.json'), 8 * 1024 * 1024);
          manifest = raw === null ? {} : JSON.parse(raw);
        } catch { manifest = {}; }
        let status = 'active';
        let reason = null;
        const range = manifest.engines && manifest.engines.gsd;
        if (typeof range === 'string' && range && !semver.semverSatisfies(host, range)) status = 'incompatible';
        // #1459: a project overlay with no user consent record is DISCOVERED-BUT-INACTIVE.
        const inactiveReason = inactiveById[`${sc} ${capId}`];
        if (inactiveReason) { status = 'inactive'; reason = inactiveReason; }
        rows.push({
          id: capId,
          role: manifest.role || null,
          version: entry.version || null,
          tier: manifest.tier || null,
          source: entry.source || null,
          scope: sc,
          status,
          reason,
          // Issue #2045 (DEFECT 3): surfaced reflects surface composition, so
          // list and state agree. An inactive (unconsented/incompatible) cap is
          // surfaced:false by definition; otherwise defer to the resolver.
          surfaced: status === 'active'
            ? (Object.prototype.hasOwnProperty.call(surfacedById, capId) ? surfacedById[capId] === true : null)
            : false,
          title: manifest.title || null,
        });
      }
    }
    output(rows, raw || capHasFlag('--json'));
  } else if (capSubcommand === 'disable' || capSubcommand === 'enable') {
    // capability disable|enable <id> — toggles activation state (same mechanism as: capability set <id> --off|--on).
    const id = args[2];
    if (!id || id.startsWith('--')) {
      error(`Missing <id> for: capability ${capSubcommand} <id>`, ERROR_REASON ? ERROR_REASON.USAGE : undefined);
    }
    const dCfg = capFlagValue('--config-dir');
    capabilityWriter.cmdCapabilitySet(
      cwd,
      dCfg ? path.resolve(dCfg) : null,
      id,
      { enabled: capSubcommand === 'enable', runtime: capFlagValue('--runtime'), scope: capFlagValue('--scope') },
      raw,
    );
  } else if (capSubcommand === 'outdated') {
    // capability outdated [--json] [--scope global|project] — ADR-1244 D6 "Update available?".
    // For each installed overlay in the chosen scope(s), LIGHT-PEEK its recorded source for the
    // latest available version and report whether a newer one exists. This never re-clones/re-packs;
    // a failing/unsupported peek DEGRADES that row to status 'unknown' (the verb never crashes).
    const lifecycle = require('./capability-lifecycle.cjs');
    const outdatedScopeArg = capFlagValue('--scope');
    if (outdatedScopeArg && outdatedScopeArg !== 'global' && outdatedScopeArg !== 'project') {
      error(`Invalid --scope "${outdatedScopeArg}": must be "global" or "project"`, ERROR_REASON ? ERROR_REASON.USAGE : undefined);
    }
    // Honor --scope (read only that scope's ledger); default sweeps both, mirroring `list`.
    const outdatedScopes = outdatedScopeArg ? [outdatedScopeArg] : ['global', 'project'];
    const records = [];
    for (const sc of outdatedScopes) {
      const { runtimeDir } = capResolveScope(sc);
      // outdatedCapabilities is read-only + non-throwing (returns [] on a missing/corrupt ledger).
      const scRecords = lifecycle.outdatedCapabilities({ runtimeDir });
      for (const r of scRecords) records.push({ ...r, scope: sc });
    }
    const asJson = raw || capHasFlag('--json');
    if (asJson) {
      output(records, false); // machine output: the records array (JSON).
    } else {
      // Human-readable table: ID | Source | Current | Latest | Status.
      const headers = ['ID', 'Source', 'Current', 'Latest', 'Status'];
      const cell = (v) => (v === null || v === undefined ? '-' : String(v));
      const tableRows = records.map((r) => [cell(r.id), cell(r.sourceKind), cell(r.current), cell(r.latest), cell(r.status)]);
      const widths = headers.map((h, i) => Math.max(h.length, ...tableRows.map((row) => row[i].length), 0));
      const fmt = (row) => row.map((c, i) => c.padEnd(widths[i])).join('  ').replace(/\s+$/, '');
      const lines = [fmt(headers), widths.map((w) => '-'.repeat(w)).join('  ').replace(/\s+$/, '')];
      for (const row of tableRows) lines.push(fmt(row));
      if (tableRows.length === 0) lines.push('(no installed overlay capabilities)');
      output(records, true, lines.join('\n') + '\n');
    }
  } else if (capSubcommand === 'trust') {
    // capability trust list [--scope project] [--json]
    // capability trust revoke <id> [--project <path>]
    // The user-owned consent store (#1459) gates PROJECT-scope third-party capability activation.
    const consentMod = require('./capability-consent.cjs');
    const trustSub = args[2];
    if (trustSub === 'list') {
      // --scope is accepted for symmetry; only 'project' records exist today.
      const listScope = capFlagValue('--scope');
      if (listScope && listScope !== 'project') {
        error(`Invalid --scope "${listScope}" for trust list: only "project" consent records exist`, ERROR_REASON ? ERROR_REASON.USAGE : undefined);
      }
      const store = consentMod.readConsentStore(capConsentHome());
      const rows = Object.keys(store.records).map((k) => {
        const r = store.records[k];
        // #1459 IC-09: surface disclosureSignature + contentHash so an operator can diff the STORED
        // binding against the current bundle (e.g. `gsd capability list` showing inactive after a
        // tamper) and understand why a consented cap deactivated. The contentHash is THE security
        // binding the loader checks; disclosureSignature is the executable-surface re-consent key.
        return {
          id: r.id, scope: r.scope, projectRoot: r.projectRoot,
          integrity: r.integrity, disclosureSignature: r.disclosureSignature, contentHash: r.contentHash,
          consentedAt: r.consentedAt,
        };
      });
      output(rows, raw || capHasFlag('--json'));
    } else if (trustSub === 'revoke') {
      const id = args[3];
      if (!id || id.startsWith('--')) {
        error('Missing <id> for: capability trust revoke <id>', ERROR_REASON ? ERROR_REASON.USAGE : undefined);
      }
      // --project pins the project root whose consent is revoked; defaults to realpath(cwd).
      const projFlag = capFlagValue('--project');
      let projectRoot;
      try { projectRoot = projFlag ? fs.realpathSync(path.resolve(projFlag)) : capProjectRoot(); }
      catch { projectRoot = projFlag ? path.resolve(projFlag) : cwd; }
      // #1459 finding 3: revokeProjectConsent THROWS when the consent-store lock cannot be acquired
      // (round-3: never do an unlocked read-modify-write). Catch it and emit a CLEAN, actionable
      // error rather than letting runMain surface a raw SDK/stack failure. The lifecycle treats a
      // consent-write failure as non-fatal, so a clean exit-1 here is the right contract.
      try {
        consentMod.revokeProjectConsent({ gsdHome: capConsentHome(), projectRoot, id });
      } catch (err) {
        error(
          `capability trust revoke blocked: ${err && err.message ? err.message : String(err)} ` +
          `(could not acquire the consent-store lock; another capability operation may be in progress — retry)`,
          ERROR_REASON ? ERROR_REASON.SDK_FAIL_FAST : undefined,
        );
      }
      output({ status: 'revoked', id, projectRoot, scope: 'project' }, raw);
    } else {
      error(
        `Unknown capability trust subcommand: ${trustSub}. Available: list, revoke`,
        ERROR_REASON ? ERROR_REASON.SDK_UNKNOWN_COMMAND : undefined,
      );
    }
  } else {
    error(
      `Unknown capability subcommand: ${capSubcommand}. Available: install, update, remove, list, outdated, trust, disable, enable, state, set`,
      ERROR_REASON ? ERROR_REASON.SDK_UNKNOWN_COMMAND : undefined,
    );
  }
}

module.exports = { routeCapabilityCommand };
