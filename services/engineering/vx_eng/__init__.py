"""VX Design engineering adapter: KiCad library checks, schematic generation and ERC.

Runs inside the engineering image (KiCad 10). The orchestrator calls it as a subprocess:
    python -m vx_eng validate --spec circuit.json
    python -m vx_eng build --spec circuit.json --out <dir>
Both print one JSON document on stdout.
"""
__version__ = "0.3.0"
