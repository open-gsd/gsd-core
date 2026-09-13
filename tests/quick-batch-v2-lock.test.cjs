"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");

const { cleanup } = require("./helpers.cjs");
const lock = require("../gsd-core/bin/lib/journal-lock.cjs");
const quickBatchV2 = require("../gsd-core/bin/lib/quick-batch-v2.cjs");

const REQUIRED = [
  "withJournalLock", "acquireJournalLock", "releaseJournalLock",
  "durableReplaceJson", "classifyOwner", "journalLockDir",
];
for (const name of REQUIRED) assert.equal(typeof lock[name], "function", `missing journal-lock export ${name}`);

function tmp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qb-v2-journal-lock-"));
  t.after(() => cleanup(directory));
  // macOS exposes /var as a compatibility symlink to /private/var. Exercise
  // the lock through the exact canonical path required by the safety contract.
  return fs.realpathSync.native(directory);
}

function journal(root) {
  const directory = path.join(root, "journal");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function isHandle(value) {
  return value !== null && value !== undefined && value !== false &&
    !(typeof value === "object" && value.ok === false);
}

function acquire(directory) {
  return lock.acquireJournalLock(directory);
}

test("Darwin compatibility alias is normalized before canonical directory checks", { skip: process.platform !== "darwin" }, (t) => {
  const root = tmp(t);
  if (!root.startsWith("/private/var/")) return t.skip("temporary directory is not beneath the Darwin /var alias");
  const canonicalJournal = journal(root);
  const aliasJournal = canonicalJournal.replace(/^\/private\/var(?=\/)/, "/var");

  const handle = acquire(aliasJournal);
  assert.equal(handle.journalDirectory, canonicalJournal);
  assert.equal(lock.releaseJournalLock(handle), true);
});

function assertBusy(directory) {
  let value;
  let error;
  try { value = acquire(directory); } catch (caught) { error = caught; }
  if (!error) assert.equal(isHandle(value), false, "contender unexpectedly acquired the lock");
  else assert.match(String(error.code || error.message), /busy|lock|held|exist/i);
}

function entriesRecursive(directory) {
  if (!fs.existsSync(directory)) return [];
  const out = [];
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    out.push({ path: current, stat, body: stat.isFile() ? fs.readFileSync(current, "utf8") : null });
    if (stat.isDirectory()) for (const name of fs.readdirSync(current)) visit(path.join(current, name));
  };
  visit(directory);
  return out;
}

function waitMessage(child, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`child exited before IPC message (code=${code}, signal=${signal})`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

function waitExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function spawnHolder(directory) {
  const modulePath = require.resolve("../gsd-core/bin/lib/journal-lock.cjs");
  const source = String.raw`
    "use strict";
    const api = require(process.argv[1]);
    const directory = process.argv[2];
    let handle;
    try {
      handle = api.acquireJournalLock(directory);
      if (handle === null || handle === undefined || handle === false || (handle && handle.ok === false)) {
        process.send({ type: "failed", value: handle });
      } else {
        process.send({ type: "acquired", handle });
      }
    } catch (error) {
      process.send({ type: "error", message: error.message, code: error.code });
    }
    process.on("message", (message) => {
      if (message === "release") {
        try { api.releaseJournalLock(handle); process.send({ type: "released" }); }
        finally { process.exit(0); }
      }
    });
    setInterval(() => {}, 0x7fffffff);
  `;
  return fork("-e", [source, modulePath, directory], { execPath: process.execPath, silent: true });
}

async function liveHolder(t, directory) {
  const child = spawnHolder(directory);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const message = await waitMessage(child);
  assert.equal(message.type, "acquired", JSON.stringify(message));
  return child;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function parseRecord(entry) {
  if (!entry.stat.isFile()) return null;
  try { return JSON.parse(entry.body); } catch { return null; }
}

function ownerAndTicket(directory, handle) {
  const root = lock.journalLockDir(directory);
  const records = entriesRecursive(root).filter((entry) => entry.stat.isFile());
  const owner = records.find((entry) => /owner/i.test(path.basename(entry.path)) || parseRecord(entry)?.pid);
  const ticket = records.find((entry) => entry !== owner &&
    (/ticket/i.test(path.basename(entry.path)) || parseRecord(entry)?.ticket || parseRecord(entry)?.token));
  assert.ok(owner, `owner record not discoverable under ${root}; handle=${JSON.stringify(handle)}`);
  assert.ok(ticket, `ticket record not discoverable under ${root}; handle=${JSON.stringify(handle)}`);
  return { root, owner, ticket, records };
}

test("reconcileActiveRound rejects a live holder and immediately recovers it after SIGKILL", async (t) => {
  const root = tmp(t);
  const parent = "ses_parent";
  const batch = "batch-1";
  const allocated = quickBatchV2.allocateRound(
    root,
    parent,
    batch,
    [{ item_id: "item-1" }],
    { orchestrator_root: root, validation_required: false },
  );
  assert.equal(allocated.ok, true, allocated.reason);
  const expectedRound = allocated.value.round;
  const expectedRevision = allocated.value.journal.revision;
  const directory = quickBatchV2.journalDir(root, parent, batch);
  const journalFiles = [
    quickBatchV2.indexPath(root, parent, batch),
    quickBatchV2.roundPath(root, parent, batch, expectedRound),
    quickBatchV2.manifestPath(root, parent, batch, expectedRound),
  ];
  const originalBytes = journalFiles.map((file) => fs.readFileSync(file));
  const child = await liveHolder(t, directory);

  const busy = quickBatchV2.reconcileActiveRound(root, parent, batch);
  assert.equal(busy.ok, false, "reconcile unexpectedly entered the live holder's critical section");
  assert.match(busy.reason, /busy/i);
  journalFiles.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), originalBytes[index]));

  child.kill("SIGKILL");
  const exited = await waitExit(child);
  assert.equal(exited.signal, "SIGKILL");
  const recovered = quickBatchV2.reconcileActiveRound(root, parent, batch);
  assert.equal(recovered.ok, true, recovered.reason);
  assert.equal(recovered.value.active.round, expectedRound);
  assert.equal(recovered.value.active.revision, expectedRevision);
  journalFiles.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), originalBytes[index]));
  const leftovers = entriesRecursive(lock.journalLockDir(directory)).filter((entry) => entry.stat.isFile());
  assert.deepEqual(leftovers, [], `dead contender records survived reconciliation: ${leftovers.map((entry) => entry.path)}`);
});

test("SIGKILL recovery is immediate and leaves journal data unchanged", async (t) => {
  const directory = journal(tmp(t));
  const journalFile = path.join(directory, "round-1.json");
  writeJson(journalFile, { version: 3, revision: 7 });
  const original = fs.readFileSync(journalFile);
  const child = await liveHolder(t, directory);

  assertBusy(directory);
  assert.deepEqual(fs.readFileSync(journalFile), original);
  child.kill("SIGKILL");
  const exited = await waitExit(child);
  assert.equal(exited.signal, "SIGKILL");

  const recovered = acquire(directory);
  assert.ok(isHandle(recovered), "dead holder was not reconciled on the first acquire");
  lock.releaseJournalLock(recovered);
  assert.deepEqual(fs.readFileSync(journalFile), original);
  const leftovers = entriesRecursive(lock.journalLockDir(directory))
    .filter((entry) => entry.stat.isFile());
  assert.deepEqual(leftovers, [], `dead owner/ticket survived recovery: ${leftovers.map((x) => x.path)}`);
});

test("live and SIGSTOP owners are never stolen", async (t) => {
  if (process.platform === "win32") return t.skip("SIGSTOP/SIGCONT are not available on Windows");
  const directory = journal(tmp(t));
  const child = await liveHolder(t, directory);
  assertBusy(directory);
  child.kill("SIGSTOP");
  assertBusy(directory);
  child.kill("SIGCONT");
  const released = waitMessage(child, (message) => message.type === "released");
  child.send("release");
  await released;
  await waitExit(child);
  const handle = acquire(directory);
  assert.ok(isHandle(handle));
  lock.releaseJournalLock(handle);
});

test("simultaneous contenders admit at most one entrant and cannot delete a newer token", async (t) => {
  const directory = journal(tmp(t));
  const staleHolder = await liveHolder(t, directory);
  staleHolder.kill("SIGKILL");
  await waitExit(staleHolder);
  const modulePath = require.resolve("../gsd-core/bin/lib/journal-lock.cjs");
  const source = String.raw`
    "use strict";
    const api = require(process.argv[1]);
    const directory = process.argv[2];
    process.send({ type: "ready" });
    process.on("message", (message) => {
      if (message !== "go") return;
      let handle = null;
      try { handle = api.acquireJournalLock(directory); } catch {}
      const entered = handle !== null && handle !== undefined && handle !== false && !(handle && handle.ok === false);
      process.send({ type: "result", entered, handle });
      process.on("message", (next) => {
        if (next === "release") { if (entered) api.releaseJournalLock(handle); process.exit(0); }
      });
    });
  `;
  const children = Array.from({ length: 6 }, () => fork("-e", [source, modulePath, directory], {
    execPath: process.execPath, silent: true,
  }));
  t.after(() => children.forEach((child) => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }));
  await Promise.all(children.map((child) => waitMessage(child, (message) => message.type === "ready")));
  const results = children.map((child) => waitMessage(child, (message) => message.type === "result"));
  children.forEach((child) => child.send("go"));
  const messages = await Promise.all(results);
  const entrants = messages.filter((message) => message.entered);
  assert.ok(entrants.length <= 1, `${entrants.length} simultaneous contenders entered`);

  const winnerIndex = messages.findIndex((message) => message.entered);
  const winner = winnerIndex === -1 ? null : children[winnerIndex];
  const winnerHandle = winnerIndex === -1 ? null : messages[winnerIndex].handle;
  const newerBodies = winnerHandle
    ? ownerAndTicket(directory, winnerHandle).records.map((entry) => [entry.path, entry.body])
    : [];
  for (const message of messages.filter((message) => !message.entered)) {
    if (message.handle) lock.releaseJournalLock(message.handle);
  }
  for (const [file, body] of newerBodies) assert.equal(fs.readFileSync(file, "utf8"), body);

  children.forEach((child) => child.send("release"));
  await Promise.all(children.map(waitExit));
  if (winner) assert.equal(winner.exitCode, 0);

  const after = acquire(directory);
  assert.ok(isHandle(after), "a fresh acquisition did not make progress after simultaneous attempts exited");
  lock.releaseJournalLock(after);
});

test("release is token-safe, mismatches are inert, and double release is defined", (t) => {
  const directory = journal(tmp(t));
  const first = acquire(directory);
  assert.ok(isHandle(first));
  const records = ownerAndTicket(directory, first);
  const before = records.records.map((entry) => [entry.path, entry.body]);

  assert.throws(
    () => lock.releaseJournalLock({ ...first, token: `${first.token}-mismatch` }),
    (error) => error && error.code === "EJOURNALLOCKSAFETY",
  );
  assertBusy(directory);
  for (const [file, body] of before) assert.equal(fs.readFileSync(file, "utf8"), body);

  assert.equal(lock.releaseJournalLock(first), true);
  assert.equal(lock.releaseJournalLock(first), false);
  const second = acquire(directory);
  assert.ok(isHandle(second));
  assert.equal(lock.releaseJournalLock(first), false);
  assertBusy(directory);
  lock.releaseJournalLock(second);

  const third = acquire(directory);
  assert.ok(isHandle(third));
  const thirdRecords = ownerAndTicket(directory, third);
  const ownerRecord = parseRecord(thirdRecords.owner);
  const ticketRecord = parseRecord(thirdRecords.ticket);
  assert.ok(ownerRecord && ticketRecord, "owner and ticket must be JSON records");
  const ownerStrings = new Set(Object.values(ownerRecord).filter((value) => typeof value === "string"));
  const sharedToken = Object.entries(ticketRecord).find(([key, value]) =>
    /token|owner|ticket/i.test(key) && ownerStrings.has(value));
  assert.ok(sharedToken, "owner/ticket do not expose their shared fencing token");
  ticketRecord[sharedToken[0]] = `${sharedToken[1]}-mismatch`;
  fs.writeFileSync(thirdRecords.ticket.path, `${JSON.stringify(ticketRecord)}\n`);
  assert.throws(
    () => lock.releaseJournalLock(third),
    (error) => error && error.code === "EJOURNALLOCKSAFETY",
  );
  assertBusy(directory);
  assert.equal(parseRecord({ ...thirdRecords.ticket, body: fs.readFileSync(thirdRecords.ticket.path, "utf8") })[sharedToken[0]], `${sharedToken[1]}-mismatch`);
  cleanup(thirdRecords.root);
});

test("published owner without ticket blocks while live; stale owner and orphan ticket reconcile", async (t) => {
  const directory = journal(tmp(t));
  const child = await liveHolder(t, directory);
  const records = ownerAndTicket(directory, { child: child.pid });
  fs.unlinkSync(records.ticket.path);
  assertBusy(directory);

  child.kill("SIGKILL");
  const exited = await waitExit(child);
  assert.equal(exited.signal, "SIGKILL");
  const reaped = acquire(directory);
  assert.ok(isHandle(reaped), "stale owner without a ticket was not reaped");
  lock.releaseJournalLock(reaped);

  const orphan = acquire(directory);
  assert.ok(isHandle(orphan));
  const orphanRecords = ownerAndTicket(directory, orphan);
  const ticketBody = orphanRecords.ticket.body;
  fs.unlinkSync(orphanRecords.owner.path);
  const orphanResult = acquire(directory);
  assert.ok(isHandle(orphanResult), "orphan ticket was not reconciled");
  assert.equal(fs.existsSync(orphanRecords.ticket.path), false, "exact-token orphan ticket survived reconciliation");
  assert.equal(ticketBody.length > 0, true);
  lock.releaseJournalLock(orphanResult);
});

function classification(value) {
  return typeof value === "string" ? value : value && (value.classification || value.state || value.status);
}

test("classifyOwner covers robust Linux parsing and injected Linux/Darwin identity outcomes", (t) => {
  void t;
  const testing = lock.testingOnly;
  assert.ok(testing && typeof testing.parseLinuxProcStatStartId === "function");
  const linuxStat = "991 (worker name (with spaces)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242 20";
  assert.equal(testing.parseLinuxProcStatStartId(linuxStat), "424242");
  assert.equal(testing.parseLinuxProcStatStartId("991 (truncated) S 1 2"), null);
  const owner = {
    version: 1, token: "a".repeat(64), pid: 991, platform: "linux",
    hostname: "host-a", boot_id: "boot-a", process_start_id: "424242",
    machine_id: "machine-a", pid_namespace: "pid:[123]",
  };
  const probe = (overrides = {}) => ({
    platform: () => "linux", hostname: () => "host-a", bootId: () => "boot-a",
    processStartId: () => ({ status: "found", value: "424242" }),
    machineId: () => "machine-a", pidNamespace: () => "pid:[123]", ...overrides,
  });
  const classify = (record, probes) => classification(lock.classifyOwner(record, probes));

  assert.equal(classify(owner, probe()), "active");
  assert.equal(classify(owner, probe({ processStartId: () => ({ status: "missing", reason: "ESRCH" }) })), "stale");
  assert.equal(classify(owner, probe({ processStartId: () => ({ status: "found", value: "424243" }) })), "stale");
  assert.equal(classify(owner, probe({ bootId: () => "boot-b" })), "stale");
  assert.equal(classify(owner, probe({ processStartId: () => ({ status: "unknown", reason: "EPERM" }) })), "unknown");
  assert.equal(classify(owner, probe({ platform: () => "aix" })), "unknown");
  assert.equal(classify({ nope: true }, probe()), "unknown");

  const darwin = {
    version: 1, token: "b".repeat(64), pid: 992, platform: "darwin",
    hostname: "mac-a", boot_id: "1757671200.000001",
    process_start_id: "Sat Sep 12 12:34:56 2026",
  };
  assert.equal(classify(darwin, {
    platform: () => "darwin", hostname: () => "mac-a", bootId: () => "1757671200.000001",
    processStartId: () => ({ status: "found", value: "Sat Sep 12 12:34:56 2026" }),
  }), "active");
  assert.equal(classify(darwin, {
    platform: () => "darwin", hostname: () => "mac-a", bootId: () => "1757671200.000001",
    processStartId: () => ({ status: "found", value: "Sat Sep 12 12:34:57 2026" }),
  }), "stale");
});

test("Darwin owner probe ignores a poisoned caller PATH and keeps a live owner active", { skip: process.platform !== "darwin" }, (t) => {
  const directory = tmp(t);
  const fakeBin = path.join(directory, "fake-bin");
  const marker = path.join(directory, "fake-ps-ran");
  fs.mkdirSync(fakeBin);
  const fakePs = path.join(fakeBin, "ps");
  fs.writeFileSync(fakePs, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = fakeBin;
    const processIdentity = lock.testingOnly.darwinProcessStartId(process.pid);
    assert.equal(processIdentity.status, "found");
    assert.equal(fs.existsSync(marker), false, "owner probe executed PATH-controlled ps");
    const owner = {
      version: 1, token: "f".repeat(64), pid: process.pid, platform: "darwin",
      hostname: os.hostname(), boot_id: "boot", process_start_id: processIdentity.value,
    };
    assert.equal(lock.classifyOwner(owner, {
      platform: () => "darwin", hostname: () => owner.hostname, bootId: () => "boot",
      processStartId: () => processIdentity,
    }).status, "active");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("legacy singleton and malformed or invalid authoritative records fail closed", async (t) => {
  const cases = [
    ["malformed owner", "owner", "{"],
    ["malformed ticket", "ticket", "{"],
    ["bad version", "owner", JSON.stringify({ version: 999, token: "x", pid: process.pid })],
    ["bad token", "owner", JSON.stringify({ version: 1, token: "", pid: process.pid })],
    ["bad pid", "owner", JSON.stringify({ version: 1, token: "x", pid: -1 })],
    ["bad ticket", "ticket", JSON.stringify({ version: 1, token: "x", pid: process.pid, ticket: "../x" })],
  ];
  for (const [name, target, body] of cases) {
    await t.test(name, () => {
      const directory = journal(tmp(t));
      const handle = acquire(directory);
      assert.ok(isHandle(handle));
      const records = ownerAndTicket(directory, handle);
      const file = records[target].path;
      fs.writeFileSync(file, body);
      assertBusy(directory);
      assert.equal(fs.readFileSync(file, "utf8"), body);
      cleanup(records.root);
    });
  }

  await t.test("legacy singleton", () => {
    const directory = journal(tmp(t));
    const lockPath = path.join(directory, ".journal.lock");
    fs.writeFileSync(lockPath, "legacy-holder\n");
    assertBusy(directory);
    assert.equal(fs.readFileSync(lockPath, "utf8"), "legacy-holder\n");
  });

  await t.test("recognized malformed names fail closed", () => {
    const directory = journal(tmp(t));
    const root = lock.journalLockDir(directory);
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, "owner-not-a-token.json");
    fs.writeFileSync(file, "{}\n");
    assertBusy(directory);
    assert.equal(fs.readFileSync(file, "utf8"), "{}\n");
  });

  await t.test("valid owner from an unsupported identity blocks", () => {
    const directory = journal(tmp(t));
    const root = lock.journalLockDir(directory);
    const token = "c".repeat(64);
    fs.mkdirSync(root, { recursive: true });
    writeJson(path.join(root, `owner-${token}.json`), {
      version: 1,
      token,
      platform: process.platform === "darwin" ? "linux" : "darwin",
      hostname: "foreign-host",
      boot_id: "foreign-boot",
      pid: 1,
      process_start_id: "foreign-start",
    });
    assertBusy(directory);
    assert.ok(fs.existsSync(path.join(root, `owner-${token}.json`)));
  });

  await t.test("unrecognized orphan temp is ignored and untouched", () => {
    const directory = journal(tmp(t));
    const root = lock.journalLockDir(directory);
    fs.mkdirSync(root, { recursive: true });
    const temp = path.join(root, `.tmp-owner-${"d".repeat(64)}-${"e".repeat(64)}`);
    fs.writeFileSync(temp, "orphan-temp\n");
    const handle = acquire(directory);
    assert.ok(isHandle(handle));
    lock.releaseJournalLock(handle);
    assert.equal(fs.readFileSync(temp, "utf8"), "orphan-temp\n");
  });
});

function withPatchedFs(patches, fn) {
  const originals = {};
  for (const [name, replacement] of Object.entries(patches)) {
    originals[name] = fs[name];
    fs[name] = replacement(originals[name]);
  }
  try { return fn(); }
  finally { for (const [name, original] of Object.entries(originals)) fs[name] = original; }
}

test("symlinked journal path components fail closed without touching their targets", async (t) => {
  await t.test("journal directory is a symlink", () => {
    const root = tmp(t);
    const target = path.join(root, "target");
    const linkedJournal = path.join(root, "linked-journal");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "sentinel"), "unchanged\n");
    fs.symlinkSync(target, linkedJournal, "dir");

    assert.throws(
      () => acquire(linkedJournal),
      (error) => error && error.code === "EJOURNALLOCKSAFETY",
    );
    assert.deepEqual(fs.readdirSync(target), ["sentinel"]);
    assert.equal(fs.readFileSync(path.join(target, "sentinel"), "utf8"), "unchanged\n");
  });

  await t.test("ancestor component is a symlink", () => {
    const root = tmp(t);
    const target = path.join(root, "ancestor-target");
    const linkedAncestor = path.join(root, "linked-ancestor");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "sentinel"), "unchanged\n");
    fs.symlinkSync(target, linkedAncestor, "dir");

    assert.throws(
      () => acquire(path.join(linkedAncestor, "missing-journal")),
      (error) => error && error.code === "EJOURNALLOCKSAFETY",
    );
    assert.deepEqual(fs.readdirSync(target), ["sentinel"]);
  });
});

test("symlinked durable replacement parent fails closed without touching its target", (t) => {
  const root = tmp(t);
  const targetDirectory = path.join(root, "replace-target");
  const linkedDirectory = path.join(root, "replace-link");
  const targetFile = path.join(targetDirectory, "journal.json");
  fs.mkdirSync(targetDirectory);
  writeJson(targetFile, { generation: "old" });
  const original = fs.readFileSync(targetFile);
  fs.symlinkSync(targetDirectory, linkedDirectory, "dir");

  assert.throws(
    () => lock.durableReplaceJson(path.join(linkedDirectory, "journal.json"), { generation: "new" }),
    (error) => error && error.code === "EJOURNALLOCKSAFETY",
  );
  assert.deepEqual(fs.readFileSync(targetFile), original);
  assert.deepEqual(fs.readdirSync(targetDirectory), ["journal.json"]);
});

test("filesystem classification positively allows only named local types", () => {
  const classify = lock.testingOnly && lock.testingOnly.isSupportedLocalFilesystem;
  assert.equal(typeof classify, "function");
  for (const type of [0xef53n, 0x58465342n, 0x9123683en, 0x01021994n, 0x794c7630n]) {
    assert.equal(classify("linux", type), true, `Linux type ${type.toString(16)} was not allowed`);
  }
  assert.equal(classify("darwin", 0x4253584en), false, "APFS NX magic was incorrectly accepted as statfs.type");
  assert.equal(classify("darwin", 26n), true, "Darwin APFS statfs f_type was not allowed");
  assert.equal(classify("linux", 0x6969n), false, "NFS was allowed");
  assert.equal(classify("darwin", 2n), false, "Darwin NFS was allowed");
  assert.equal(classify("linux", 0x65735546n), false, "generic FUSE was allowed");
  assert.equal(classify("linux", 0x12345678n), false);
  assert.equal(classify("aix", 0xef53n), false);
});

test("missing and failed statfs fail closed for acquire and durable replacement", async (t) => {
  const cases = ["absent", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EINVAL"];
  for (const failure of cases) {
    await t.test(failure, () => {
      const root = tmp(t);
      const directory = path.join(root, "journal");
      const file = path.join(root, "replacement", "journal.json");
      const replacement = failure === "absent"
        ? () => undefined
        : () => function () { const error = new Error(failure); error.code = failure; throw error; };

      withPatchedFs({ statfsSync: replacement }, () => {
        assert.throws(
          () => acquire(directory),
          (error) => error && error.code === "EJOURNALLOCKDURABILITY" &&
            (failure === "absent" || error.cause?.code === failure),
        );
        assert.throws(
          () => lock.durableReplaceJson(file, { generation: "new" }),
          (error) => error && error.code === "EJOURNALLOCKDURABILITY" &&
            (failure === "absent" || error.cause?.code === failure),
        );
      });
      assert.equal(fs.existsSync(file), false);
    });
  }
});

test("unknown filesystem types and platforms fail closed for both production paths", async (t) => {
  for (const scenario of ["unknown-type", "unsupported-platform"]) {
    await t.test(scenario, () => {
      const root = tmp(t);
      const directory = path.join(root, "journal");
      const file = path.join(root, "replacement", "journal.json");
      const platform = scenario === "unsupported-platform" ? "aix" : process.platform;
      const type = scenario === "unsupported-platform" ? 0xef53n : 0x12345678n;
      withPatchedFs({ statfsSync: () => () => ({ type }) }, () => {
        assert.throws(
          () => lock.acquireJournalLock(directory, { probes: { platform: () => platform } }),
          (error) => error && error.code === "EJOURNALLOCKDURABILITY",
        );
        assert.throws(
          () => lock.durableReplaceJson(file, { generation: "new" }, { platform }),
          (error) => error && error.code === "EJOURNALLOCKDURABILITY",
        );
      });
      assert.equal(fs.existsSync(file), false);
    });
  }
});

test("known local filesystem types permit both production paths", (t) => {
  const root = tmp(t);
  const directory = path.join(root, "journal");
  const file = path.join(root, "replacement", "journal.json");
  const type = process.platform === "darwin" ? 26n : 0xef53n;
  withPatchedFs({ statfsSync: () => () => ({ type }) }, () => {
    const handle = acquire(directory);
    assert.ok(isHandle(handle));
    lock.releaseJournalLock(handle);
    lock.durableReplaceJson(file, { generation: "new" });
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { generation: "new" });
});

test("real Darwin APFS statfs type remains distinct from the documented NX magic", (t) => {
  if (process.platform !== "darwin") return t.skip("Darwin-only real statfs regression");
  const root = tmp(t);
  const observedType = fs.statfsSync(root, { bigint: true }).type;
  assert.equal(observedType, 26n, "test volume is not the expected Darwin APFS fixture");
  assert.notEqual(observedType, 0x4253584en, "statfs f_type must not be confused with APFS nx_magic");
  assert.equal(lock.testingOnly.isSupportedLocalFilesystem("darwin", observedType), true);
  const handle = acquire(journal(root));
  assert.ok(isHandle(handle));
  lock.releaseJournalLock(handle);
});

test("atomic lock publication faults clean temporary records and never publish partial authority", async (t) => {
  const stages = ["temp-write", "temp-fsync", "link", "dir-fsync"];
  for (const stage of stages) {
    await t.test(stage, () => {
      const directory = journal(tmp(t));
      let injected = false;
      const fail = () => { injected = true; const error = new Error(`injected ${stage}`); error.code = "EIO"; throw error; };
      const patches = {};
      if (stage === "temp-write") patches.writeSync = (original) => function (...args) {
        if (!injected) fail();
        return original.apply(this, args);
      };
      if (stage === "temp-fsync") patches.fsyncSync = (original) => function (fd) {
        if (!injected && !fs.fstatSync(fd).isDirectory()) fail();
        return original.call(this, fd);
      };
      if (stage === "link") patches.linkSync = (original) => function (...args) {
        if (!injected) fail();
        return original.apply(this, args);
      };
      if (stage === "dir-fsync") patches.fsyncSync = (original) => function (fd) {
        const stat = fs.fstatSync(fd);
        if (!injected && stat.isDirectory()) fail();
        return original.call(this, fd);
      };

      let value;
      let error;
      withPatchedFs(patches, () => { try { value = acquire(directory); } catch (caught) { error = caught; } });
      assert.equal(injected, true, `${stage} was not exercised`);
      assert.equal(isHandle(value), false, `${stage} returned an acquired handle`);
      assert.ok(error, `${stage} fault was swallowed`);
      assert.ok(
        error.code === "EJOURNALLOCKDURABILITY" || error.code === "EJOURNALLOCKSAFETY",
        `unexpected ${stage} error code ${error.code}`,
      );
      if (error.code === "EJOURNALLOCKDURABILITY") assert.equal(error.cause && error.cause.code, "EIO");
      const files = entriesRecursive(lock.journalLockDir(directory)).filter((entry) => entry.stat.isFile());
      assert.deepEqual(files, [], `${stage} left lock records: ${files.map((entry) => entry.path)}`);
    });
  }
});

test("durableReplaceJson preserves complete old-or-new JSON and fsync ordering under faults", async (t) => {
  for (const stage of ["write", "file-fsync", "rename", "dir-fsync"]) {
    await t.test(stage, () => {
      const root = tmp(t);
      const file = path.join(root, "journal.json");
      const oldValue = { generation: "old", payload: "a".repeat(1024) };
      const newValue = { generation: "new", payload: "b".repeat(1024) };
      writeJson(file, oldValue);
      let injected = false;
      let fileFsyncs = 0;
      let directoryFsyncs = 0;
      const fail = () => { injected = true; const error = new Error(`injected ${stage}`); error.code = "EIO"; throw error; };
      const patches = {
        writeSync: (original) => function (...args) {
          if (!injected && stage === "write") fail();
          return original.apply(this, args);
        },
        renameSync: (original) => function (...args) {
          if (!injected && stage === "rename") fail();
          return original.apply(this, args);
        },
        fsyncSync: (original) => function (fd) {
          const isDirectory = fs.fstatSync(fd).isDirectory();
          if (isDirectory) directoryFsyncs += 1; else fileFsyncs += 1;
          if (!injected && stage === "file-fsync" && !isDirectory) fail();
          if (!injected && stage === "dir-fsync" && isDirectory) fail();
          return original.call(this, fd);
        },
      };
      let error;
      withPatchedFs(patches, () => {
        try { lock.durableReplaceJson(file, newValue); } catch (caught) { error = caught; }
      });
      assert.equal(injected, true, `${stage} was not exercised`);
      assert.ok(error, `${stage} fault was swallowed`);
      assert.equal(error.code, "EJOURNALLOCKDURABILITY");
      assert.equal(error.cause && error.cause.code, "EIO");
      const observed = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepEqual(observed, stage === "dir-fsync" ? newValue : oldValue);
      if (stage !== "write") assert.ok(fileFsyncs >= 1, "temporary file was not fsynced");
      if (stage === "dir-fsync") assert.ok(directoryFsyncs >= 1, "containing directory was not fsynced");
      const debris = fs.readdirSync(root).filter((name) => name !== path.basename(file));
      assert.deepEqual(debris, [], `temporary publication debris remains: ${debris}`);
    });
  }
});

test("lock records have no lease, heartbeat, expiry, or polling contract", (t) => {
  const directory = journal(tmp(t));
  const handle = acquire(directory);
  const records = ownerAndTicket(directory, handle);
  const owner = parseRecord(records.owner);
  const ticket = parseRecord(records.ticket);
  for (const record of [owner, ticket]) {
    for (const key of Object.keys(record)) assert.doesNotMatch(key, /lease|heartbeat|expir|timeout|poll/i);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(lock.testingOnly || {}, "poll"), false);
  lock.releaseJournalLock(handle);
});

test("source and operations guide state the hostile same-user threat boundary", () => {
  const source = fs.readFileSync(require.resolve("../gsd-core/bin/lib/journal-lock.cjs"), "utf8");
  const guide = fs.readFileSync(path.join(__dirname, "../docs/opencode-v2-worktree-transport.md"), "utf8");
  for (const text of [source, guide]) {
    const prose = text.replace(/\n\s*(?:\/\/|\*)\s?/g, " ").replace(/\s+/g, " ");
    assert.match(prose, /malicious or buggy same-(?:OS-)?user process/i);
    assert.match(prose, /outside the supported threat model/i);
    assert.match(prose, /symlink rejection|defense in depth/i);
  }
  assert.match(source, /no inode-conditional[\s\S]{0,80}unlink/i);
});

test("withJournalLock is nonblocking and releases on callback failure", (t) => {
  const directory = journal(tmp(t));
  const held = acquire(directory);
  assert.ok(isHandle(held));
  assertBusy(directory);
  lock.releaseJournalLock(held);

  const marker = new Error("callback-failure");
  assert.throws(() => lock.withJournalLock(directory, () => { throw marker; }), (error) => error === marker);
  const after = acquire(directory);
  assert.ok(isHandle(after), "callback exception leaked the lock");
  lock.releaseJournalLock(after);
});
