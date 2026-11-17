# G0 capability matrix

Generated 2026-11-17T01:09:50+00:00 by `services/engineering/g0/run.py` in the `vx-engineering:g0` image.
Each row ran a real operation on the fixture circuit (2-pin input, AP2112K-3.3 LDO, LED) and checked a
concrete acceptance condition; checks marked with a negative control were also shown to fail on bad input.

| Tool | Operation | Status | Version | License |
|---|---|---|---|---|
| kicad | schematic_generation | verified | 10.0.8 | GPL-3.0 (run as separate process) |
| kicad | headless_erc | verified | 10.0.8 | GPL-3.0 |
| kicad | pcb_generation | verified | 10.0.8 | GPL-3.0 |
| freerouting | autoroute | verified | 2.5.0 | GPL-3.0 (run as separate process) |
| kicad | headless_drc | verified | 10.0.8 | GPL-3.0 |
| kicad | fab_outputs | verified | 10.0.8 | GPL-3.0 |
| kicad | step_export | partial | 10.0.8 | GPL-3.0 |
| kikit | panelization | verified | 1.8.1 | MIT |
| cadquery | step_import_export | verified | 2.8.0 | Apache-2.0 (OCCT: LGPL-2.1 with exception) |
| cadquery | enclosure_generation | partial | 2.8.0 | Apache-2.0 |
| cadquery | interference_check | verified | 2.8.0 | Apache-2.0 |
| ngspice | transient_simulation | verified | 44.2 | BSD-3-Clause (modified) |
| skidl | netlist_compile | verified | 3.0.0 | MIT |
| atopile | netlist_compile | partial | 0.12.6 | MIT |
| kicad | ipc_api | BLOCKED | 0.8.0 | MIT (kicad-python) |
| digikey | product_search | untested | - | - |
| mouser | product_search | untested | - | - |
| nexar | part_lookup | untested | - | - |
| lcsc_jlc | parts_catalog | not in container | - | - |
| kicanvas | browser_view | not in container | - | - |
| threejs | step_render | not in container | - | - |
| flux | project_export | not in container | - | - |

## Details

### kicad · schematic_generation — verified

Generated a native .kicad_sch from code (symbols copied from installed libraries, `extends` flattened, nets joined by labels on pin endpoints). KiCad's own netlist export reproduces all 4 intended nets exactly.

Fallback: atopile / SKiDL netlist generation (no schematic drawing)

Evidence: `samples/kicad/g0_ldo_led.kicad_sch`, `samples/kicad/netlist.net`

### kicad · headless_erc — verified

`kicad-cli sch erc` JSON report: generated schematic has 0 violations; negative control (power flags removed) reports 4 error(s): label_dangling; power_pin_not_driven

Evidence: `samples/kicad/erc_clean.json`

### kicad · pcb_generation — verified

Created a .kicad_pcb from the KiCad netlist with the pcbnew Python API: 6 library footprints placed, nets assigned to pads, 28.0x16.0 mm outline. Pre-route DRC shows 10 unconnected items as expected. Design rules from fab profile `jlcpcb-2layer-standard`. Placement is scripted, not automatic. Note: KiCad's SWIG Python bindings are deprecated in favour of the IPC API; plan to migrate.

Evidence: `samples/kicad/unrouted/g0_ldo_led.kicad_pcb`

### freerouting · autoroute — verified

DSN export -> Freerouting (headless) -> SES import: 31 track segments, 0 vias on a 2-layer board; track widths [0.187, 0.25] mm (narrower segments neck down between fine-pitch pads). Suitable for simple low-speed boards; not for impedance-controlled or high-speed nets.

Evidence: `samples/kicad/routed/g0_ldo_led_routed.kicad_pcb`, `samples/freerouting/board.ses`, `samples/freerouting/freerouting.log`

### kicad · headless_drc — verified

`kicad-cli pcb drc` JSON report on the routed board: 0 errors, 0 unconnected items, 0 warning(s). Rules: `jlcpcb-2layer-standard` (min track 0.127 mm, min clearance 0.127 mm), read from the .kicad_pro. Negative control: the same board before routing reported 10 unconnected items.

Evidence: `samples/kicad/drc_routed.json`, `samples/kicad/drc_unrouted.json`

### kicad · fab_outputs — verified

Headless exports: 9 Gerber layers, Excellon drill, pick-and-place CSV (6 parts), BOM CSV. Content checked for all references. Not yet checked: fab-house DFM rules, stackup/impedance notes, assembly drawings.

Evidence: `samples/kicad/fab`

### kicad · step_export — partial

Board STEP exported headlessly. This image has no KiCad 3D model library (use the kicad/kicad:*-full image or fetch manufacturer STEP files per part), so the STEP contains the bare board only.

Evidence: `samples/kicad/board.step`

### kikit · panelization — verified

`kikit panelize` produced a 2x2 panel (58.1x50.1 mm, 72 footprints) with mousebites and rails. `kikit fab jlcpcb --assembly`: produced bom.csv, gerber, gerbers.zip, pos.csv; LCSC part numbers filled for 0 BOM line(s) - JLCPCB assembly needs one per line (sourcing agent work), and its rotation offsets are not yet verified.

Evidence: `samples/kikit/panel.kicad_pcb`, `samples/kikit/fab_jlcpcb`

### cadquery · step_import_export — verified

Imported KiCad's board STEP: 28.00 x 16.00 x 1.51 mm, matching the 28.0x16.0 mm outline; export/re-import preserves volume. Manufacturer component STEP files still to be tested once real part models are sourced.

### cadquery · enclosure_generation — partial

Parametric open-top shell with corner standoffs generated from the board STEP bounding box; valid solid exported as STEP and STL. Not yet: lid, connector cutouts from footprint positions, process DFM (wall thickness, draft angles).

Evidence: `samples/cadquery/enclosure.step`, `samples/cadquery/enclosure.stl`

### cadquery · interference_check — verified

Boolean intersection: board vs generated enclosure = 0.0000 mm^3 (fits). Negative control with walls 1 mm inside the board edge = 126.84 mm^3 (collision detected).

### ngspice · transient_simulation — verified

Batch-mode transient run; measured RC time constant 0.9999 ms vs analytic 1.0000 ms (within 1%). Waveform saved. Vendor regulator models still need per-part checks.

Evidence: `samples/ngspice/rc.cir`, `samples/ngspice/rc_out.txt`

### skidl · netlist_compile — verified

Python circuit description compiled to a KiCad netlist whose connectivity matches the fixture exactly.

Evidence: `samples/skidl/skidl.net`

### atopile · netlist_compile — partial

CLI installs and runs. A full build was not exercised: atopile projects pull part packages from its registry and need a project scaffold. Evaluate in a follow-up spike alongside SKiDL.

### kicad · ipc_api — blocked

kicad-python needs a running KiCad GUI instance with the API server enabled; none exists in a headless worker. Follow-up: run KiCad under a virtual display (Xvfb) or wait for a headless API host.

```
ConnectionError: Failed to connect to KiCad: Connection refused
```

Fallback: kicad-cli + pcbnew Python bindings (verified) and direct file generation

### digikey · product_search — untested

Not run: set DIGIKEY_CLIENT_ID, DIGIKEY_CLIENT_SECRET to test a live lookup of AP2112K-3.3TRG1.

### mouser · product_search — untested

Not run: set MOUSER_API_KEY to test a live lookup of AP2112K-3.3TRG1.

### nexar · part_lookup — untested

Not run: set NEXAR_CLIENT_ID, NEXAR_CLIENT_SECRET to test a live lookup of AP2112K-3.3TRG1.

## Not covered by this container

- **lcsc_jlc · parts_catalog**: Catalog download and basic/extended part mapping (P1 sourcing work).
- **kicanvas · browser_view**: Browser-side; verify in apps/web.
- **threejs · step_render**: Browser-side; verify in apps/web.
- **flux · project_export**: Manual: export from the Flux account and inventory the archive.
