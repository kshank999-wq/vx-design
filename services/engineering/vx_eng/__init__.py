"""VX Design engineering adapter: KiCad library checks, schematic generation and ERC,
board layout, routing (Freerouting), DRC with schematic parity, 3D models and exports.

Runs inside the engineering image (KiCad 10). The orchestrator calls it as a subprocess:
    python -m vx_eng validate --spec circuit.json
    python -m vx_eng build --spec circuit.json --out <dir>
    python -m vx_eng footprints --spec circuit.json
    python -m vx_eng layout-check --spec circuit.json --layout layout.json
    python -m vx_eng layout-build --spec circuit.json --layout layout.json --out <dir>
    python -m vx_eng fab-package --project <project.zip> --out <dir>
Each prints one JSON document on stdout.
"""
__version__ = "0.5.0"
