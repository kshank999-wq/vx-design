"""Shared helpers for G0 capability spikes."""
from __future__ import annotations

import hashlib
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Result:
    """One row of the capability matrix (mirrors public.tool_capabilities)."""

    tool_name: str
    operation: str
    status: str = "untested"  # untested | verified | partial | blocked
    tool_version: str | None = None
    deployment_mode: str = "docker worker"
    license: str | None = None
    commercial_ok: bool | None = None
    notes: str = ""
    errors_seen: str | None = None
    fallback: str | None = None
    evidence: list[str] = field(default_factory=list)  # sample output paths, relative to out dir
    duration_s: float = 0.0


class SpikeFailure(Exception):
    """Raised when a spike runs but its acceptance check does not pass."""


@dataclass
class Cmd:
    returncode: int
    stdout: str
    stderr: str


def run(args: list[str], cwd: Path | None = None, timeout: int = 600, check: bool = True) -> Cmd:
    proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    out = Cmd(proc.returncode, proc.stdout, proc.stderr)
    if check and proc.returncode != 0:
        tail = (proc.stderr or proc.stdout).strip().splitlines()[-15:]
        raise SpikeFailure(f"`{' '.join(args[:4])} ...` exited {proc.returncode}: " + " | ".join(tail))
    return out


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def copy_evidence(src: Path, out_dir: Path, sub: str) -> str:
    """Copies a sample output into the results folder and returns its relative path."""
    dest = out_dir / "samples" / sub / src.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, dest, dirs_exist_ok=True)
    else:
        shutil.copy2(src, dest)
    return str(dest.relative_to(out_dir))


class Timer:
    def __enter__(self) -> "Timer":
        self.start = time.monotonic()
        return self

    def __exit__(self, *exc: object) -> None:
        self.elapsed = time.monotonic() - self.start
