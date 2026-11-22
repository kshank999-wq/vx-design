"""Circuit simulation with ngspice in batch mode, for simulation tasks.

The deck comes from the model, so it is treated as untrusted: only circuit elements, models, sources, analyses and
.meas statements are allowed. Anything that could reach outside the simulator (.control blocks with their shell,
system and file commands, .include/.lib of files, file output) is refused before ngspice runs. Results are the
.meas values ngspice prints, read back by name.
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

# Dot-commands a self-contained deck needs. Everything else starting with "." is refused.
ALLOWED_DOT = {
    ".title", ".param", ".model", ".subckt", ".ends", ".tran", ".ac", ".dc", ".op", ".noise", ".tf", ".meas",
    ".measure", ".ic", ".nodeset", ".options", ".option", ".temp", ".func", ".global", ".end", ".step", ".csparam",
}
FORBIDDEN = re.compile(r"\b(shell|system|exec|source|write|wrdata|wrs2p|hardcopy|setcs|codemodel)\b", re.I)
MEAS_LINE = re.compile(r"^\s*([A-Za-z_][\w.]*)\s*=\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)")


def ngspice_version() -> str | None:
    exe = shutil.which("ngspice")
    if not exe:
        return None
    out = subprocess.run([exe, "-v"], capture_output=True, text=True, timeout=30).stdout
    m = re.search(r"ngspice-(\S+)", out)
    return m.group(1) if m else "unknown"


def check_deck(deck: str) -> list[str]:
    """Problems that stop the deck from running (refused commands), each with its line."""
    problems = []
    in_control = False
    for n, raw in enumerate(deck.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("*"):
            continue
        low = line.lower()
        if low.startswith(".control"):
            in_control = True
            problems.append(f"line {n}: .control blocks are not allowed; use .meas statements for results")
            continue
        if low.startswith(".endc"):
            in_control = False
            continue
        if in_control:
            continue
        if low.startswith("."):
            cmd = low.split()[0]
            if cmd not in ALLOWED_DOT:
                problems.append(f"line {n}: {cmd} is not allowed in a self-contained deck (no .include/.lib/file commands)")
        # Commands only run inside .control (refused above); dot lines are checked again for good measure.
        if low.startswith(".") and FORBIDDEN.search(low) and not low.startswith((".meas", ".measure", ".param", ".func")):
            problems.append(f"line {n}: '{line[:60]}' uses a command that is not allowed")
        if "`" in line or "$(" in line:
            problems.append(f"line {n}: shell syntax is not allowed")
    if not any(l.strip().lower().startswith((".tran", ".ac", ".dc", ".op", ".noise", ".tf")) for l in deck.splitlines()):
        problems.append("the deck has no analysis (.tran, .ac, .dc, .op, .noise or .tf)")
    if not any(l.strip().lower().startswith((".meas", ".measure")) for l in deck.splitlines()):
        problems.append("the deck has no .meas statement, so it reports no results")
    return problems


def simulate(deck: str, out: Path, timeout_s: int = 180) -> dict:
    """Runs the deck; returns {ok, stage, problems, measures: {name: value}, log} and writes deck.cir and ngspice.log."""
    out.mkdir(parents=True, exist_ok=True)
    problems = check_deck(deck)
    version = ngspice_version()
    if problems:
        return {"ok": False, "stage": "deck", "problems": problems, "measures": {}, "ngspice": version}
    if not version:
        return {"ok": False, "stage": "tool", "problems": ["ngspice is not installed on this worker"], "measures": {}, "ngspice": None}
    text = deck.rstrip() + "\n"
    if not text.lower().rstrip().endswith(".end"):
        text += ".end\n"
    (out / "deck.cir").write_text(text)
    try:
        r = subprocess.run(["ngspice", "-b", "deck.cir"], cwd=out, capture_output=True, text=True, timeout=timeout_s,
                           env={"PATH": "/usr/bin:/bin:/usr/local/bin", "HOME": str(out)})
    except subprocess.TimeoutExpired:
        return {"ok": False, "stage": "run", "problems": [f"ngspice did not finish within {timeout_s} s"], "measures": {}, "ngspice": version}
    log = (r.stdout or "") + (r.stderr or "")
    (out / "ngspice.log").write_text(log)
    wanted = {l.split()[2].lower() for l in deck.splitlines()
              if l.strip().lower().startswith((".meas", ".measure")) and len(l.split()) > 2}
    measures: dict[str, float] = {}
    for line in log.splitlines():
        m = MEAS_LINE.match(line)
        if m and m.group(1).lower() in wanted:
            measures[m.group(1).lower()] = float(m.group(2))
    missing = sorted(wanted - measures.keys())
    errors = [l.strip() for l in log.splitlines() if re.search(r"\berror\b", l, re.I) and "no error" not in l.lower()][:20]
    failed_meas = [l.strip() for l in log.splitlines() if re.search(r"meas.*(failed|out of interval)", l, re.I)][:20]
    ok = r.returncode == 0 and not errors and bool(measures) and not missing
    return {"ok": ok, "stage": "done" if ok else "run",
            "problems": errors + failed_meas + [f".meas {m} printed no result (the condition never happened in the analysis window?)" for m in missing],
            "measures": measures, "ngspice": version, "files": {"deck": "deck.cir", "log": "ngspice.log"}}
