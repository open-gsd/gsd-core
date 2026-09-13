/* eslint-disable @typescript-eslint/ban-ts-comment,
                  @typescript-eslint/no-require-imports,
                  @typescript-eslint/no-unsafe-assignment,
                  @typescript-eslint/no-unsafe-member-access,
                  @typescript-eslint/no-unsafe-return,
                  @typescript-eslint/no-unsafe-call,
                  @typescript-eslint/no-unsafe-argument */
// @ts-nocheck -- security-reviewed durable V2 transport port
'use strict';

/*
 * Crash-visible, non-waiting journal lock.
 *
 * Each contender owns immutable owner-<token>.json and ticket-<token>.json
 * records.  The owner record is the bakery algorithm's "choosing" flag: it is
 * published before a ticket is selected.  There is deliberately no lease,
 * heartbeat, timeout, retry loop, or singleton file that a competing process
 * could accidentally remove.
 *
 * releaseJournalLock() removes the owner first.  Consequently a ticket without
 * an owner is non-authoritative and may be reaped by a later contender.  A
 * second release after a completed release is a no-op and returns false.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { tryWithinRootLexical } = require("./security.cjs");

const TOKEN_RE = /^[a-f0-9]{64}$/;
const OWNER_NAME_RE = /^owner-(.+)\.json$/;
const TICKET_NAME_RE = /^ticket-(.+)\.json$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const OWNER_VERSION = 1;
// Bound for the local owner-identity probes (sysctl/ps). A hung probe must
// degrade to a fail-closed "unknown" classification, never hang the contender.
const PROBE_TIMEOUT_MS = 5_000;

const ERROR_BUSY = "EJOURNALLOCKBUSY";
const ERROR_SAFETY = "EJOURNALLOCKSAFETY";
const ERROR_DURABILITY = "EJOURNALLOCKDURABILITY";

// statfs(2) f_type values for the explicitly supported local filesystems.
// Generic FUSE is intentionally absent because a FUSE mount may be remote.
const LOCAL_FILESYSTEM_TYPES = Object.freeze({
  darwin: Object.freeze({
    // Node's Darwin statfs binding exposes f_type, the kernel's historic VFS
    // registration number, not nx_magic. Current Darwin reports 26 for APFS.
    // APFS nx_magic (0x4253584e, "BSXN") is an on-disk superblock field and
    // must never be accepted as an observed statfs.type value.
    APFS_VFS_TYPE: 26n,
  }),
  linux: Object.freeze({
    EXT2_3_4: 0xef53n,
    XFS: 0x58465342n,
    BTRFS: 0x9123683en,
    TMPFS: 0x01021994n,
    OVERLAYFS: 0x794c7630n,
  }),
});

class JournalLockError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "JournalLockError";
    this.code = code;
  }
}

function lockError(code, message, cause) {
  return new JournalLockError(code, message, cause);
}

function errorCode(error) {
  return error && typeof error === "object" ? error.code : undefined;
}

function isAbsent(error) {
  return errorCode(error) === "ENOENT";
}

function journalLockDir(journalDirectory) {
  if (typeof journalDirectory !== "string" || journalDirectory.length === 0) {
    throw new TypeError("journalDirectory must be a non-empty string");
  }
  return path.join(journalDirectory, ".journal-lock");
}

function ownerPath(lockDirectory, token) {
  return path.join(lockDirectory, `owner-${token}.json`);
}

function ticketPath(lockDirectory, token) {
  return path.join(lockDirectory, `ticket-${token}.json`);
}

function writeAll(fd, data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) {
      throw lockError(ERROR_DURABILITY, "A complete durable write could not be made");
    }
    offset += written;
  }
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    throw lockError(
      ERROR_DURABILITY,
      `Cannot fsync journal lock directory ${directory}; refusing unsafe lock operation`,
      error,
    );
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve the primary failure */ }
    }
  }
}

function unlinkExact(file, directory, allowAbsent = true) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (allowAbsent && isAbsent(error)) return false;
    throw lockError(ERROR_DURABILITY, `Cannot remove exact lock record ${file}`, error);
  }
  fsyncDirectory(directory);
  return true;
}

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

function assertToken(token) {
  if (!TOKEN_RE.test(token)) {
    throw lockError(ERROR_SAFETY, "Journal lock token is not 64 lowercase hexadecimal characters");
  }
}

function jsonBytes(value) {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new TypeError("value must be JSON-serializable");
  }
  return `${serialized}\n`;
}

/*
 * Publish an immutable record.  linkSync is intentional: unlike rename it
 * cannot replace an existing record.  The temp name belongs to this operation
 * alone and is the only temp this function will clean.
 */
function publishImmutableJson(directory, finalFile, value, token, kind) {
  const temp = path.join(directory, `.tmp-${kind}-${token}-${randomToken()}`);
  let fd;
  let linked = false;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    writeAll(fd, jsonBytes(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    fs.linkSync(temp, finalFile);
    linked = true;
    fsyncDirectory(directory);
  } catch (error) {
    if (error instanceof JournalLockError) throw error;
    const detail = errorCode(error) === "EEXIST"
      ? `Immutable ${kind} record already exists at ${finalFile}`
      : `Cannot durably publish immutable ${kind} record ${finalFile}`;
    throw lockError(ERROR_DURABILITY, detail, error);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort after failed publication */ }
    }
    try { fs.unlinkSync(temp); } catch (error) {
      if (!isAbsent(error)) {
        throw lockError(
          ERROR_DURABILITY,
          `Cannot remove exact owned publication temp ${temp}${linked ? " after publication" : ""}`,
          error,
        );
      }
    }
  }
}

function parseLinuxProcStatStartId(raw) {
  if (typeof raw !== "string") return null;
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  const prefix = raw.slice(0, close + 1);
  if (!/^\s*[0-9]+\s+\(.*\)$/.test(prefix)) return null;
  const remainder = raw.slice(close + 1).trim().split(/\s+/);
  // remainder[0] is field 3 (state), so field 22 is index 19.
  const startId = remainder[19];
  return typeof startId === "string" && /^[0-9]+$/.test(startId) ? startId : null;
}

function parseDarwinBootTime(raw) {
  if (typeof raw !== "string") return null;
  const match = raw.match(/\bsec\s*=\s*([0-9]+)\s*,\s*usec\s*=\s*([0-9]+)\b/);
  return match ? `${match[1]}.${match[2].padStart(6, "0")}` : null;
}

function commandProbe(command, args) {
  const result = childProcess.spawnSync(command, args, {
    encoding: "utf8",
    // Probes must not resolve binaries or locale data from a caller-controlled
    // environment. Commands supplied here are fixed OS paths.
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    windowsHide: true,
    // Local owner-identity probes only; a timeout surfaces as a fail-closed
    // "unknown"/safety classification at every call site, never an hang.
    timeout: PROBE_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  return result;
}

const DARWIN_PS_PATHS = Object.freeze(["/bin/ps", "/usr/bin/ps"]);
const DARWIN_SYSCTL_PATHS = Object.freeze(["/usr/sbin/sysctl", "/sbin/sysctl"]);

function trustedDarwinExecutable(candidates, name) {
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* try the next fixed OS path */ }
  }
  throw new Error(`no trusted Darwin ${name} executable is available`);
}

function darwinPsPath() {
  return trustedDarwinExecutable(DARWIN_PS_PATHS, "ps");
}

function darwinSysctlPath() {
  return trustedDarwinExecutable(DARWIN_SYSCTL_PATHS, "sysctl");
}

function linuxBootId() {
  return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

function linuxProcessStartId(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const value = parseLinuxProcStatStartId(raw);
    return value === null
      ? { status: "unknown", reason: "malformed /proc stat data" }
      : { status: "found", value };
  } catch (error) {
    if (isAbsent(error)) {
      try {
        fs.accessSync(`/proc/${process.pid}/stat`, fs.constants.R_OK);
      } catch (selfError) {
        return { status: "unknown", reason: `procfs is unavailable (${errorCode(selfError) || "error"})` };
      }
      return { status: "missing", reason: "process is absent" };
    }
    return { status: "unknown", reason: `cannot read process identity (${errorCode(error) || "error"})` };
  }
}

function darwinBootId() {
  const result = commandProbe(darwinSysctlPath(), ["-n", "kern.boottime"]);
  if (result.status !== 0) throw new Error("sysctl kern.boottime failed");
  const value = parseDarwinBootTime(result.stdout);
  if (value === null) throw new Error("ambiguous sysctl kern.boottime output");
  return value;
}

function normalizeDarwinStart(raw) {
  const value = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  return value.length === 0 ? null : value;
}

function darwinProcessStartId(pid) {
  try {
    const result = commandProbe(darwinPsPath(), ["-o", "lstart=", "-p", String(pid)]);
    if (result.status === 1 && String(result.stdout || "").trim() === "" &&
        String(result.stderr || "").trim() === "") {
      return { status: "missing", reason: "process is absent" };
    }
    if (result.status !== 0) {
      return { status: "unknown", reason: `ps failed with status ${result.status}` };
    }
    const value = normalizeDarwinStart(result.stdout);
    return value === null
      ? { status: "unknown", reason: "ambiguous ps process start output" }
      : { status: "found", value };
  } catch (error) {
    return { status: "unknown", reason: `cannot run trusted Darwin ps (${errorCode(error) || "error"})` };
  }
}

function optionalRead(file) {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function optionalReadlink(file) {
  try {
    const value = fs.readlinkSync(file).trim();
    return value || null;
  } catch {
    return null;
  }
}

const defaultProbes = Object.freeze({
  platform: () => process.platform,
  hostname: () => os.hostname(),
  bootId(platform) {
    if (platform === "linux") return linuxBootId();
    if (platform === "darwin") return darwinBootId();
    throw new Error(`unsupported owner platform ${platform}`);
  },
  processStartId(platform, pid) {
    if (platform === "linux") return linuxProcessStartId(pid);
    if (platform === "darwin") return darwinProcessStartId(pid);
    return { status: "unknown", reason: `unsupported owner platform ${platform}` };
  },
  pidNamespace: () => optionalReadlink("/proc/self/ns/pid"),
  machineId: () => optionalRead("/etc/machine-id"),
});

function validOwner(owner, expectedToken) {
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return false;
  if (owner.version !== OWNER_VERSION || owner.token !== expectedToken || !TOKEN_RE.test(owner.token)) return false;
  if (owner.platform !== "linux" && owner.platform !== "darwin") return false;
  if (typeof owner.hostname !== "string" || owner.hostname.length === 0) return false;
  if (typeof owner.boot_id !== "string" || owner.boot_id.length === 0) return false;
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  if (typeof owner.process_start_id !== "string" || owner.process_start_id.length === 0) return false;
  for (const optional of ["pid_namespace", "machine_id"]) {
    if (owner[optional] !== undefined && (typeof owner[optional] !== "string" || owner[optional].length === 0)) return false;
  }
  return true;
}

function unknown(reason) {
  return { status: "unknown", reason };
}

function classifyOwner(owner, probes = defaultProbes) {
  if (!owner || typeof owner !== "object" || Array.isArray(owner) || !TOKEN_RE.test(owner.token || "")) {
    return unknown("owner metadata is malformed");
  }
  if (!validOwner(owner, owner.token)) return unknown("owner metadata is malformed");

  let platform;
  let hostname;
  try {
    platform = probes.platform();
    hostname = probes.hostname();
  } catch (error) {
    return unknown(`cannot identify this host (${errorCode(error) || "error"})`);
  }
  if (platform !== owner.platform) return unknown("owner belongs to another or unsupported platform");
  if (hostname !== owner.hostname) return unknown("owner belongs to another host");

  if (platform === "linux") {
    try {
      const localMachineId = probes.machineId();
      if (owner.machine_id && (!localMachineId || owner.machine_id !== localMachineId)) {
        return unknown("Linux machine identity differs or is unavailable");
      }
      const localNamespace = probes.pidNamespace();
      if (owner.pid_namespace && (!localNamespace || owner.pid_namespace !== localNamespace)) {
        return unknown("Linux PID namespace differs or is unavailable");
      }
    } catch (error) {
      return unknown(`cannot compare Linux host identity (${errorCode(error) || "error"})`);
    }
  }

  let bootId;
  try {
    bootId = probes.bootId(platform);
  } catch (error) {
    return unknown(`cannot probe boot identity (${errorCode(error) || "error"})`);
  }
  if (typeof bootId !== "string" || bootId.length === 0) return unknown("boot identity is ambiguous");
  if (bootId !== owner.boot_id) return { status: "stale", reason: "host has rebooted" };

  let processIdentity;
  try {
    processIdentity = probes.processStartId(platform, owner.pid);
  } catch (error) {
    return unknown(`cannot probe owner process (${errorCode(error) || "error"})`);
  }
  if (!processIdentity || processIdentity.status === "unknown") {
    return unknown(processIdentity && processIdentity.reason ? processIdentity.reason : "process identity is ambiguous");
  }
  if (processIdentity.status === "missing") return { status: "stale", reason: "owner process is absent" };
  if (processIdentity.status !== "found" || typeof processIdentity.value !== "string") {
    return unknown("process identity probe returned an unsupported result");
  }
  if (processIdentity.value !== owner.process_start_id) {
    return { status: "stale", reason: "PID was reused by another process" };
  }
  return { status: "active", reason: "owner process identity matches" };
}

function createOwnerMetadata(token, probes) {
  const platform = probes.platform();
  if (platform !== "linux" && platform !== "darwin") {
    throw lockError(ERROR_SAFETY, `Journal locking is unsupported on platform ${platform}`);
  }

  let hostname;
  let bootId;
  let processIdentity;
  try {
    hostname = probes.hostname();
    bootId = probes.bootId(platform);
    processIdentity = probes.processStartId(platform, process.pid);
  } catch (error) {
    throw lockError(ERROR_SAFETY, "Cannot establish unambiguous journal lock owner identity", error);
  }
  if (typeof hostname !== "string" || !hostname || typeof bootId !== "string" || !bootId ||
      !processIdentity || processIdentity.status !== "found" || typeof processIdentity.value !== "string" ||
      !processIdentity.value) {
    throw lockError(ERROR_SAFETY, "Cannot establish unambiguous journal lock owner identity");
  }

  const owner = {
    version: OWNER_VERSION,
    token,
    platform,
    hostname,
    boot_id: bootId,
    pid: process.pid,
    process_start_id: processIdentity.value,
  };
  if (platform === "linux") {
    let namespace = null;
    let machineId = null;
    try { namespace = probes.pidNamespace(); } catch { /* optional identity */ }
    try { machineId = probes.machineId(); } catch { /* optional identity */ }
    if (namespace) owner.pid_namespace = namespace;
    if (machineId) owner.machine_id = machineId;
  }
  return owner;
}

function isSupportedLocalFilesystem(platform, type) {
  let numeric;
  try { numeric = typeof type === "bigint" ? type : BigInt(type); } catch { return false; }
  const supported = LOCAL_FILESYSTEM_TYPES[platform];
  return supported !== undefined && Object.values(supported).includes(numeric);
}

function requireSupportedLocalFilesystem(directory, platform) {
  if (typeof fs.statfsSync !== "function") {
    throw lockError(
      ERROR_DURABILITY,
      `Cannot positively classify journal filesystem at ${directory}; fs.statfsSync is unavailable`,
    );
  }
  let stat;
  try {
    stat = fs.statfsSync(directory, { bigint: true });
  } catch (error) {
    throw lockError(ERROR_DURABILITY, `Cannot inspect journal filesystem at ${directory}`, error);
  }
  if (!stat || !isSupportedLocalFilesystem(platform, stat.type)) {
    throw lockError(
      ERROR_DURABILITY,
      `Journal locking requires an explicitly supported local ${platform} filesystem at ${directory}`,
    );
  }
}

function normalizeDirectoryPath(directory) {
  const absolute = path.resolve(directory);
  if (process.platform !== "darwin") return absolute;
  // Darwin exposes these fixed, system-owned compatibility aliases as ordinary
  // API paths. Canonicalize only those aliases; arbitrary symlinks still fail.
  for (const [alias, canonical] of [["/var", "/private/var"], ["/tmp", "/private/tmp"], ["/etc", "/private/etc"]]) {
    // Lexical is intentional: identify the alias spelling before resolving
    // this one explicitly permitted symlink; descendants may not exist yet.
    if (tryWithinRootLexical(absolute, alias) === null) continue;
    let resolvedAlias;
    try { resolvedAlias = fs.realpathSync.native(alias); }
    catch (error) { throw lockError(ERROR_SAFETY, `Cannot verify Darwin compatibility alias ${alias}`, error); }
    if (resolvedAlias !== canonical) {
      throw lockError(ERROR_SAFETY, `Darwin compatibility alias has an unexpected target: ${alias}`);
    }
    return `${canonical}${absolute.slice(alias.length)}`;
  }
  return absolute;
}

/*
 * Validate every existing path component and create missing descendants one
 * component at a time. This rejects symlink aliases and canonical mismatches
 * before publication. It is defense in depth, not atomic protection against a
 * hostile same-user process replacing components concurrently.
 */
function ensureCanonicalDirectory(directory, description) {
  const absolute = normalizeDirectoryPath(directory);
  const parsed = path.parse(absolute);
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;

  for (const component of components) {
    current = path.join(current, component);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (!isAbsent(error)) {
        throw lockError(ERROR_SAFETY, `Cannot safely inspect ${description} component ${current}`, error);
      }
      try {
        fs.mkdirSync(current);
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") {
          throw lockError(ERROR_DURABILITY, `Cannot create ${description} component ${current}`, mkdirError);
        }
      }
      try {
        stat = fs.lstatSync(current);
      } catch (inspectError) {
        throw lockError(ERROR_SAFETY, `Cannot verify created ${description} component ${current}`, inspectError);
      }
    }

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw lockError(ERROR_SAFETY, `${description} component must be a real directory, not a symlink: ${current}`);
    }
    let canonical;
    try {
      canonical = fs.realpathSync.native(current);
    } catch (error) {
      throw lockError(ERROR_SAFETY, `Cannot resolve ${description} component ${current}`, error);
    }
    if (canonical !== current) {
      throw lockError(ERROR_SAFETY, `${description} component is not canonical: ${current}`);
    }
  }
  return absolute;
}

function readRecognizedJson(file, expectedToken, kind) {
  let stat;
  let value;
  try {
    stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { malformed: true, reason: `${kind} record is not a regular file` };
    }
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (isAbsent(error)) return { absent: true };
    return { malformed: true, reason: `cannot parse ${kind} record (${errorCode(error) || "invalid JSON"})` };
  }

  if (kind === "owner") {
    return validOwner(value, expectedToken)
      ? { value }
      : { malformed: true, reason: "owner metadata does not match its exact token path" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== OWNER_VERSION ||
      value.token !== expectedToken || !DECIMAL_RE.test(value.ticket || "") || value.ticket === "0") {
    return { malformed: true, reason: "ticket metadata does not match its exact token path" };
  }
  return { value };
}

function safety(message) {
  throw lockError(ERROR_SAFETY, `${message}. Inspect ${".journal-lock"} manually; no ambiguous record was deleted`);
}

function verifyAndUnlink(file, directory, token, kind, allowAbsent = true) {
  // Exact path/value verification and immutable unique-token records protect
  // compliant quick-batch processes. Pure Node has no inode-conditional
  // unlink, so a malicious or buggy same-OS-user process that directly
  // renames, replaces, or deletes records is outside the supported threat
  // model and can violate these guarantees.
  const record = readRecognizedJson(file, token, kind);
  if (record.absent) {
    if (allowAbsent) return false;
    safety(`Expected ${kind} record disappeared at ${file}`);
  }
  if (record.malformed) safety(`Refusing to remove ${kind} record at ${file}: ${record.reason}`);
  if (record.value.token !== token) safety(`Token mismatch in ${kind} record at ${file}`);
  return unlinkExact(file, directory, allowAbsent);
}

function scanRecords(lockDirectory, probes, ownToken) {
  let names;
  try {
    names = fs.readdirSync(lockDirectory);
  } catch (error) {
    throw lockError(ERROR_DURABILITY, `Cannot scan journal lock directory ${lockDirectory}`, error);
  }

  const tokens = new Set();
  for (const name of names) {
    const ownerMatch = OWNER_NAME_RE.exec(name);
    const ticketMatch = TICKET_NAME_RE.exec(name);
    if (ownerMatch) {
      if (!TOKEN_RE.test(ownerMatch[1])) safety(`Malformed recognized owner record name ${name}`);
      tokens.add(ownerMatch[1]);
    }
    if (ticketMatch) {
      if (!TOKEN_RE.test(ticketMatch[1])) safety(`Malformed recognized ticket record name ${name}`);
      tokens.add(ticketMatch[1]);
    }
  }

  const records = [];
  for (const token of tokens) {
    const ownerFile = ownerPath(lockDirectory, token);
    const ticketFile = ticketPath(lockDirectory, token);
    const ownerRecord = readRecognizedJson(ownerFile, token, "owner");
    const ticketRecord = readRecognizedJson(ticketFile, token, "ticket");

    if (ownerRecord.malformed) safety(`Malformed recognized owner record ${ownerFile}: ${ownerRecord.reason}`);
    if (ticketRecord.malformed) safety(`Malformed recognized ticket record ${ticketFile}: ${ticketRecord.reason}`);

    if (ownerRecord.absent) {
      // Owner-first release makes this exact-token ticket an orphan.
      if (!ticketRecord.absent) verifyAndUnlink(ticketFile, lockDirectory, token, "ticket");
      continue;
    }

    const classification = token === ownToken
      ? { status: "active", reason: "current contender" }
      : classifyOwner(ownerRecord.value, probes);
    if (classification.status === "stale") {
      // Multiple reapers may race only on these exact token-derived paths.
      verifyAndUnlink(ownerFile, lockDirectory, token, "owner");
      if (!ticketRecord.absent) verifyAndUnlink(ticketFile, lockDirectory, token, "ticket");
      continue;
    }
    records.push({
      token,
      owner: ownerRecord.value,
      classification,
      ticket: ticketRecord.absent ? null : BigInt(ticketRecord.value.ticket),
    });
  }
  return records;
}

function cleanOwnRecords(handle) {
  const { lockDirectory, token } = handle;
  const ownOwner = ownerPath(lockDirectory, token);
  const ownTicket = ticketPath(lockDirectory, token);
  let ownerError;
  try {
    verifyAndUnlink(ownOwner, lockDirectory, token, "owner");
  } catch (error) {
    ownerError = error instanceof Error ? error : new Error(String(error));
  }
  try {
    verifyAndUnlink(ownTicket, lockDirectory, token, "ticket");
  } catch (ticketError) {
    if (ownerError === undefined) throw ticketError instanceof Error ? ticketError : new Error(String(ticketError));
  }
  if (ownerError !== undefined) throw ownerError;
}

function acquireJournalLock(journalDirectory, options = {}) {
  const canonicalJournalDirectory = ensureCanonicalDirectory(journalDirectory, "Journal directory");
  const lockDirectory = journalLockDir(canonicalJournalDirectory);
  const legacyFile = path.join(canonicalJournalDirectory, ".journal.lock");
  const probes = options.probes || defaultProbes;

  try {
    fs.lstatSync(legacyFile);
    throw lockError(
      ERROR_SAFETY,
      `Legacy journal lock exists at ${legacyFile}; remove it only after an operator proves no legacy writer is active`,
    );
  } catch (error) {
    if (error instanceof JournalLockError) throw error;
    if (!isAbsent(error)) {
      throw lockError(ERROR_SAFETY, `Cannot safely inspect legacy journal lock ${legacyFile}`, error);
    }
  }

  ensureCanonicalDirectory(lockDirectory, "Journal lock directory");
  const platform = probes.platform();
  requireSupportedLocalFilesystem(lockDirectory, platform);

  const token = randomToken();
  assertToken(token);
  const handle = {
    journalDirectory: canonicalJournalDirectory,
    lockDirectory,
    token,
    released: false,
    ownerReleased: false,
  };
  const owner = createOwnerMetadata(token, probes);

  try {
    publishImmutableJson(lockDirectory, ownerPath(lockDirectory, token), owner, token, "owner");
    const firstScan = scanRecords(lockDirectory, probes, token);
    let maximum = 0n;
    for (const record of firstScan) {
      if (record.ticket !== null && record.ticket > maximum) maximum = record.ticket;
    }
    const ticket = maximum + 1n;
    publishImmutableJson(
      lockDirectory,
      ticketPath(lockDirectory, token),
      { version: OWNER_VERSION, token, ticket: ticket.toString() },
      token,
      "ticket",
    );

    const finalScan = scanRecords(lockDirectory, probes, token);
    for (const record of finalScan) {
      if (record.token === token) continue;
      if (record.ticket === null) {
        throw lockError(
          ERROR_BUSY,
          `Journal lock is busy: ${String(record.classification.status)} contender ${String(record.token)} is publishing its ticket; retry later`,
        );
      }
      if (record.ticket < ticket || (record.ticket === ticket && record.token < token)) {
        throw lockError(
          ERROR_BUSY,
          `Journal lock is busy: contender ${String(record.token)} has bakery priority; retry later`,
        );
      }
    }
    handle.ticket = ticket.toString();
    return handle;
  } catch (error) {
    try { cleanOwnRecords(handle); } catch (cleanupError) {
      throw lockError(
        ERROR_SAFETY,
        `Journal lock acquisition failed and exact owned records could not be fully cleaned: ${cleanupError.message}`,
        error,
      );
    }
    throw error;
  }
}

function releaseJournalLock(handle, options = {}) {
  void options;
  if (!handle || typeof handle !== "object" || typeof handle.lockDirectory !== "string") {
    throw new TypeError("handle must be returned by acquireJournalLock");
  }
  assertToken(handle.token);
  if (handle.released) return false;

  const ownerFile = ownerPath(handle.lockDirectory, handle.token);
  const ticketFile = ticketPath(handle.lockDirectory, handle.token);
  let removed = false;

  if (!handle.ownerReleased) {
    const ownerRecord = readRecognizedJson(ownerFile, handle.token, "owner");
    if (ownerRecord.absent) {
      // An absent owner means this handle no longer authorizes a release.  The
      // ticket is an orphan and a future scan may reap it by exact token.
      handle.released = true;
      return false;
    }
    if (ownerRecord.malformed || ownerRecord.value.token !== handle.token) {
      safety(`Release token verification failed for owner record ${ownerFile}`);
    }
    removed = verifyAndUnlink(ownerFile, handle.lockDirectory, handle.token, "owner", false);
    handle.ownerReleased = true;
  }

  const ticketRecord = readRecognizedJson(ticketFile, handle.token, "ticket");
  if (!ticketRecord.absent) {
    if (ticketRecord.malformed || ticketRecord.value.token !== handle.token) {
      safety(`Release token verification failed for ticket record ${ticketFile}`);
    }
    verifyAndUnlink(ticketFile, handle.lockDirectory, handle.token, "ticket");
    removed = true;
  }
  handle.released = true;
  return removed;
}

function withJournalLock(journalDirectory, criticalSection, options = {}) {
  if (typeof criticalSection !== "function") throw new TypeError("criticalSection must be a function");
  const handle = acquireJournalLock(journalDirectory, options);
  try {
    return criticalSection(handle);
  } finally {
    releaseJournalLock(handle, options);
  }
}

// WIN-1 (DEFECT.WINDOWS-FS-OPS): rename errnos that are transient on Windows
// (an AV scanner / indexer holding a brief lock).
const RENAME_RETRY_ERRNOS = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_MAX_ATTEMPTS = 3;
const RENAME_RETRY_BACKOFF_MS = 50;
let renameSleepBuf;
function renameBackoff() {
  if (renameSleepBuf === undefined) renameSleepBuf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(renameSleepBuf, 0, 0, RENAME_RETRY_BACKOFF_MS);
}

/**
 * Rename with a bounded retry on transient Windows errnos. This is durable
 * replacement recovery, not bakery-lock acquisition: acquireJournalLock never
 * waits for a competing owner and returns busy immediately.
 */
function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : "";
      if (attempt < RENAME_MAX_ATTEMPTS && RENAME_RETRY_ERRNOS.has(code)) {
        renameBackoff();
        continue;
      }
      throw error;
    }
  }
}

function durableReplaceJson(file, value, options = {}) {
  if (typeof file !== "string" || file.length === 0) throw new TypeError("file must be a non-empty string");
  const requestedFile = path.resolve(file);
  const directory = ensureCanonicalDirectory(path.dirname(requestedFile), "Replacement parent directory");
  const absoluteFile = path.join(directory, path.basename(requestedFile));
  const token = randomToken();
  const temp = path.join(directory, `.tmp-replace-${path.basename(absoluteFile)}-${token}`);
  let fd;
  let renamed = false;
  try {
    requireSupportedLocalFilesystem(directory, options.platform || process.platform);
    fd = fs.openSync(temp, "wx", 0o600);
    writeAll(fd, jsonBytes(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    renameWithRetry(temp, absoluteFile);
    renamed = true;
    fsyncDirectory(directory);
  } catch (error) {
    if (error instanceof JournalLockError) throw error;
    throw lockError(ERROR_DURABILITY, `Cannot durably replace JSON file ${absoluteFile}`, error);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve primary failure */ }
    }
    if (!renamed) {
      try { fs.unlinkSync(temp); } catch (error) {
        if (!isAbsent(error)) {
          throw lockError(ERROR_DURABILITY, `Cannot remove exact owned replacement temp ${temp}`, error);
        }
      }
    }
  }
}

module.exports = {
  withJournalLock,
  acquireJournalLock,
  releaseJournalLock,
  durableReplaceJson,
  classifyOwner,
  journalLockDir,
  // Testing-only pure/probe seams. There is intentionally no polling seam.
  testingOnly: Object.freeze({
    parseLinuxProcStatStartId,
    parseDarwinBootTime,
    normalizeDarwinStart,
    darwinProcessStartId,
    isSupportedLocalFilesystem,
  }),
};
