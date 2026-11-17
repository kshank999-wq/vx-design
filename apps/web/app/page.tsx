const gates = [
  ["G0", "Capability audit", "Verify every tool and API with a runnable sample"],
  ["G1", "Plan engine", "Spec upload → cited requirements → task graph → approval"],
  ["G2", "Worker backbone", "Durable queue, checkpoints, budgets, locks"],
  ["P1", "Sourcing + power", "Multi-distributor BOM and power-tree calculator"],
  ["G3", "First circuit", "Editable KiCad schematic with ERC report"],
  ["G4", "PCB + 3D", "Board, DRC, STEP alignment and fit results"],
  ["G4.5", "Fab package", "Gerbers, drill, placement, BOM — ready to order"],
] as const;

export default function Home() {
  return (
    <main>
      <h1>VX Design</h1>
      <p className="lede">From specification to a verified, orderable product.</p>
      <ol>
        {gates.map(([id, name, detail]) => (
          <li key={id}>
            <strong>{id}</strong>
            {name} — {detail}
          </li>
        ))}
      </ol>
    </main>
  );
}
