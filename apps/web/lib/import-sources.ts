/** Where earlier work can come from, and what to export from each tool for "Import existing designs". */
export interface ImportSource { id: string; label: string; files: string; converts: boolean }

export const IMPORT_SOURCES: ImportSource[] = [
  { id: "kicad", label: "KiCad", converts: true,
    files: "The project folder (.kicad_pro, .kicad_sch, .kicad_pcb) or a ZIP of it. The board is read directly and checked." },
  { id: "eagle", label: "Eagle / Fusion Electronics", converts: true,
    files: "The board (.brd) and schematic (.sch). From Fusion, export the Eagle files (File → Export → Eagle). The board is converted to KiCad and checked." },
  { id: "altium", label: "Altium Designer / CircuitMaker / CircuitStudio", converts: true,
    files: "The board (.PcbDoc) and schematics (.SchDoc), plus Outjob outputs if you have them. The board is converted to KiCad and checked." },
  { id: "easyeda", label: "EasyEDA / LCSC", converts: true,
    files: "Export the PCB as EasyEDA source (JSON) or an EasyEDA Pro project (.epro). The board is converted to KiCad and checked." },
  { id: "pads", label: "PADS", converts: true, files: "Export the board as PADS ASCII (.asc). The board is converted to KiCad and checked." },
  { id: "cadstar", label: "CADSTAR", converts: true, files: "Export a PCB archive (.cpa). The board is converted to KiCad and checked." },
  { id: "allegro", label: "Cadence Allegro / OrCAD PCB", converts: true,
    files: "The board (.brd), plus Gerber, ODB++ or IPC-2581, the netlist and the parts list. The board is converted to KiCad where KiCad can read it." },
  { id: "flux", label: "Flux", converts: false,
    files: "Export → Flux project data (JSON and assets), Netlists (EDIF and IPC-D-356), Manufacturing files, Bill of materials, Pick & place, 3D (STEP)." },
  { id: "solidworks", label: "SolidWorks (3D, enclosures)", converts: true,
    files: "Save As → STEP AP214 (.step) for parts and assemblies, and DXF or PDF for drawings. SolidWorks' own .SLDPRT/.SLDASM files can only be opened in SolidWorks. SolidWorks PCB boards (.PcbDoc) convert like Altium." },
  { id: "fusion", label: "Fusion 360 / Onshape / Creo / Inventor (3D)", converts: true,
    files: "Export STEP (.step) for parts and assemblies, STL for 3D-printed parts, and DXF or PDF for drawings. Each model is measured." },
  { id: "other", label: "Any other tool", converts: false,
    files: "Its manufacturing exports: Gerbers and drill files, ODB++ or IPC-2581, the netlist (EDIF, IPC-D-356 or a text netlist), the parts list (CSV/XLSX), the pick-and-place file, STEP models, PDFs of schematics and drawings." },
];

export const sourceOf = (id: string | null | undefined) => IMPORT_SOURCES.find((s) => s.id === id) ?? IMPORT_SOURCES.find((s) => s.id === "other")!;
