# Engineering workers

Isolated containers that run engineering tools on behalf of the orchestrator.

The `vx-engineering:g0` image (see `Dockerfile`) is based on the official `kicad/kicad:10.0.8`
image and adds KiKit, Freerouting (Java 25), CadQuery, SKiDL, kicad-python and atopile.
ngspice and the KiCad symbol/footprint libraries come with the base image; KiCad's 3D model
library does not (use a `-full` base image or per-part manufacturer STEP files).

## G0 capability audit

```bash
./scripts/g0-run.sh            # from the repo root: build image, run audit, update docs/g0/
SKIP_BUILD=1 ./scripts/g0-run.sh
```

`g0/run.py` runs one fixture circuit (`g0/fixture.py`: 2-pin input, AP2112K-3.3 LDO, LED)
through the full flow and checks each step against a concrete acceptance condition:

| Step | Check | Negative control |
|---|---|---|
| Schematic generated from code (`g0/kicad_sch.py`) | KiCad's netlist equals the design intent | — |
| ERC | 0 violations | removing power flags produces errors |
| PCB from netlist (pcbnew API) | footprints placed, nets on pads | pre-route DRC shows unconnected items |
| Freerouting autoroute | SES imported, no analytics sent | — |
| DRC with fab profile (`g0/fab_profiles.py`) | 0 errors, 0 unconnected | unrouted board fails |
| Gerber / drill / position / BOM | files present, every reference listed | — |
| KiKit panel + JLCPCB package | 2x2 panel geometry | — |
| STEP → CadQuery | board dimensions match outline | — |
| Enclosure + interference | board fits | undersized enclosure collides |
| ngspice transient | RC time constant within 1% of analytic | — |
| SKiDL netlist | connectivity equals fixture | — |

Part-data APIs (DigiKey, Mouser, Nexar) run only when their credentials are set; see
`scripts/g0-run.sh`. With `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set, results are
upserted into `public.tool_capabilities`.

Building behind a TLS-intercepting proxy: `EXTRA_CA_CERT=/path/to/ca.crt ./build.sh`
(passed as a BuildKit secret, never stored in the image).

## Rules for production adapters (spec §8)

No arbitrary model-generated shell commands; each adapter exposes fixed operations; record
tool version and config with every output; cap CPU, memory and time; no outbound network
from tool processes unless an adapter needs it.

## vx_eng (G3, G4)

`vx_eng/` is the engineering library the worker calls as a subprocess. It prints one JSON document.

```bash
python3 -m vx_eng validate --spec circuit.json        # library checks only
python3 -m vx_eng build --spec circuit.json --out dir  # project + ERC + netlist check + PDF/SVG/BOM + zip
python3 -m vx_eng footprints --spec circuit.json      # courtyard extents per footprint, fab profiles (for the layout prompt)
python3 -m vx_eng layout-check --spec circuit.json --layout layout.json
python3 -m vx_eng layout-build --spec circuit.json --layout layout.json --out dir   # board + route + DRC + 3D + exports
```

- `library.py` holds a name index of every installed symbol and footprint, built at image build time. It
  parses symbol definitions lazily, flattens `extends` inheritance and reads footprint pads.
- `circuit.py` validates a design: references, symbols and footprints with suggestions, pins with the
  symbol's real pin list, pin-to-pad coverage, unconnected pins, and undriven power inputs.
- `schematic.py` generates a native KiCad 10 schematic. All units of multi-unit parts are placed; each pin
  gets a wire stub and label; external supplies get PWR_FLAGs. UUIDs are derived from the design, so output
  is byte-for-byte deterministic.
- `kicad.py` wraps `kicad-cli`: ERC (JSON), netlist, PDF, SVG and BOM.
- `pcb.py` (G4) handles the board:
  - checks placements against courtyards (via pcbnew);
  - builds the `.kicad_pcb` from KiCad's netlist of the generated schematic, with symbol UUIDs, fields and
    full net names, so schematic parity holds;
  - routes with Freerouting (`-mt 1`, analytics off);
  - adds GND pours;
  - runs DRC with `--schematic-parity --refill-zones`;
  - fetches 3D models per footprint;
  - renders and exports (`pcb render`, SVG, PDF, STEP, GLB).
- `fab.py` holds the fab design-rule profiles. They are written into the `.kicad_pro` and applied to the board
  for the router.

Tests (`tests/test_vx_eng.py`) include negative controls. One removes the power source, and ERC must report
`power_pin_not_driven`. The G4 tests have two more:
- the same board unrouted must report unconnected items;
- a footprint value changed on the board must show up as a parity difference.
