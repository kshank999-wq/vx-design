# ADR 0001: KiCad native files are the electrical system of record

Status: accepted (for MVP)

## Context
VX Design needs editable, manufacturable electrical designs. Building a proprietary
schematic/PCB format and editor would take years and lock users in.

## Decision
Electrical designs are stored as KiCad 9+ native projects, versioned as artifact versions.
The platform generates, checks and exports them through worker adapters. Users edit them in
KiCad desktop when human layout is needed. A code-based circuit layer (atopile / SKiDL /
tscircuit) that compiles to KiCad may be added after the G0 spike.

## Consequences
- Output opens in a free, widely used tool; no lock-in.
- Browser shows read-only views (KiCanvas, STEP viewer) until in-browser editing is built.
- KiCad automation limits (IPC API needs a running instance) must be verified in G0.
