#!/usr/bin/env python3
"""Poll GSD async SLURM manifests and notify once on terminal state.

Default output is intentionally silent while jobs are pending/running so this can
be used from cron or any other lightweight watchdog. It prints exactly when a job reaches
a terminal state and the manifest has not been notified yet.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import glob
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
from typing import Any

TERMINAL_STATES = {
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "OUT_OF_MEMORY",
    "NODE_FAIL",
    "PREEMPTED",
    "BOOT_FAIL",
    "DEADLINE",
}
RUNNING_STATES = {"RUNNING", "COMPLETING", "CONFIGURING", "RESIZING", "SUSPENDED"}
PENDING_STATES = {"PENDING"}


def utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run(cmd: list[str]) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except FileNotFoundError as e:
        return 127, "", str(e)
    except subprocess.TimeoutExpired as e:
        return 124, (e.stdout or "").strip() if isinstance(e.stdout, str) else "", "command timed out"


def atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=False)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            if os.path.exists(tmp):
                os.unlink(tmp)
        except OSError:
            pass


def load_manifest(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def job_id_of(manifest: dict[str, Any]) -> str | None:
    slurm = manifest.get("slurm") if isinstance(manifest.get("slurm"), dict) else {}
    return str(slurm.get("job_id") or manifest.get("job_id") or "").strip() or None


def primary_sacct_line(job_id: str, sacct_out: str) -> str:
    lines = [line for line in sacct_out.splitlines() if line.strip()]
    if not lines:
        return ""
    for line in lines:
        if line.split("|", 1)[0] == job_id:
            return line
    return lines[0]


def map_status_from_squeue(squeue_out: str) -> tuple[str | None, str | None]:
    if not squeue_out.strip():
        return None, None
    line = squeue_out.splitlines()[0]
    state = line.split("|", 1)[0].strip().upper()
    if state in RUNNING_STATES:
        return "running", state
    if state in PENDING_STATES:
        return "pending", state
    return "running", state


def map_status_from_sacct(job_id: str, sacct_out: str) -> tuple[str | None, str | None, str | None]:
    line = primary_sacct_line(job_id, sacct_out)
    if not line:
        return None, None, None
    parts = line.split("|")
    state = parts[2].strip().upper() if len(parts) > 2 else "UNKNOWN"
    exit_code = parts[3].strip() if len(parts) > 3 else ""
    base_state = state.split()[0]
    if base_state == "COMPLETED" and exit_code.startswith("0:0"):
        return "completed_unverified", base_state, exit_code
    if base_state == "CANCELLED":
        return "cancelled", base_state, exit_code
    if base_state == "TIMEOUT":
        return "timeout", base_state, exit_code
    if base_state in TERMINAL_STATES:
        return "failed", base_state, exit_code
    if base_state in RUNNING_STATES:
        return "running", base_state, exit_code
    if base_state in PENDING_STATES:
        return "pending", base_state, exit_code
    return "unknown", base_state, exit_code


def is_terminal_status(status: str | None) -> bool:
    return status in {"completed_unverified", "failed", "cancelled", "timeout"}


def update_manifest(path: Path, manifest: dict[str, Any], *, dry_run: bool) -> tuple[str, str]:
    job_id = job_id_of(manifest)
    if not job_id:
        raise ValueError(f"{path}: missing slurm.job_id")

    previous_status = str(manifest.get("status") or "submitted")
    if previous_status == "verified":
        return "verified", ""

    slurm = manifest.setdefault("slurm", {})
    now = utc_now()
    manifest["last_checked_at"] = now

    rc, sout, serr = run(["squeue", "-h", "-j", job_id, "-o", "%T|%M|%R"])
    if rc == 0 and sout:
        slurm["last_squeue"] = sout
        status, state = map_status_from_squeue(sout)
        manifest["status"] = status or previous_status
        slurm["last_state"] = state
        if not dry_run:
            atomic_write_json(path, manifest)
        return manifest["status"], ""
    if rc not in (0, 1):
        slurm["last_squeue_error"] = serr or f"squeue exited {rc}"

    sacct_cmd = [
        "sacct",
        "-n",
        "-P",
        "-j",
        job_id,
        "--format=JobID,JobName,State,ExitCode,Elapsed,MaxRSS,ReqMem,AllocCPUS",
    ]
    rc, aout, aerr = run(sacct_cmd)
    if rc == 0 and aout:
        slurm["last_sacct"] = aout
        status, state, exit_code = map_status_from_sacct(job_id, aout)
        manifest["status"] = status or previous_status
        slurm["last_state"] = state
        if exit_code is not None:
            slurm["last_exit_code"] = exit_code
    else:
        if rc != 0:
            slurm["last_sacct_error"] = aerr or f"sacct exited {rc}"
        manifest["status"] = previous_status if previous_status else "unknown"

    status = str(manifest.get("status") or "unknown")
    message = ""
    if is_terminal_status(status):
        if not manifest.get("terminal_state_at"):
            manifest["terminal_state_at"] = now
        if not manifest.get("notified_at"):
            manifest["notified_at"] = now
            phase = manifest.get("phase") or "?"
            plan = manifest.get("plan_id") or manifest.get("plan") or "?"
            task = manifest.get("task_id") or manifest.get("task") or "?"
            state = slurm.get("last_state") or status
            exit_code = slurm.get("last_exit_code") or ""
            if status == "completed_unverified":
                message = (
                    f"SLURM job {job_id} for GSD phase {phase} plan {plan} task {task} "
                    f"reached COMPLETED ({exit_code}).\n"
                    f"Manifest: {path}\n"
                    f"Next: run /gsd-resume-work or /gsd-execute-phase {phase} to inspect logs, "
                    "verify artifacts, update the manifest, and close the plan."
                )
            else:
                message = (
                    f"SLURM job {job_id} for GSD phase {phase} plan {plan} task {task} "
                    f"reached terminal state {state} ({exit_code}).\n"
                    f"Manifest: {path}\n"
                    "Next: inspect stdout/stderr and diagnose before resubmitting or marking the plan complete."
                )

    if not dry_run:
        atomic_write_json(path, manifest)
    return status, message


def expand_paths(args: list[str]) -> list[Path]:
    if not args:
        args = [".planning/async-jobs/*.json"]
    paths: list[Path] = []
    for arg in args:
        matches = glob.glob(arg) if any(ch in arg for ch in "*?[") else [arg]
        for m in matches:
            p = Path(m)
            if p.is_file():
                paths.append(p)
    return sorted(set(paths))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Poll GSD async SLURM manifests.")
    ap.add_argument("manifests", nargs="*", help="Manifest JSON paths or globs; default .planning/async-jobs/*.json")
    ap.add_argument("--verbose", action="store_true", help="Print status for running/pending jobs too")
    ap.add_argument("--dry-run", action="store_true", help="Do not update manifests")
    args = ap.parse_args(argv)

    paths = expand_paths(args.manifests)
    if not paths:
        if args.verbose:
            print("No async SLURM manifests found.")
        return 0

    rc = 0
    for path in paths:
        try:
            manifest = load_manifest(path)
            status, message = update_manifest(path, manifest, dry_run=args.dry_run)
            if message:
                print(message)
            elif args.verbose:
                job_id = job_id_of(manifest) or "?"
                print(f"{path}: job {job_id} status={status}")
        except Exception as e:
            print(f"ERROR: {path}: {e}", file=sys.stderr)
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
