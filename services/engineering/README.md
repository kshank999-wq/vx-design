# Engineering workers

Isolated containers that run engineering tools on behalf of the orchestrator:
KiCad (`kicad-cli`), KiKit, Freerouting, ngspice, CadQuery/build123d, and code-to-netlist
tools (atopile / SKiDL) under evaluation.

Rules (spec §8): no arbitrary model-generated shell commands; each adapter exposes fixed
operations; record tool version and config with every output; cap CPU, memory and time.

First deliverable is the G0 spike image and scripts that fill in `public.tool_capabilities`
(seeded with untested rows by `supabase/seed.sql`).
