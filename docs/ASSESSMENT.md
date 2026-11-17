# VX Design — Feasibility Assessment & Build Plan

*Based on "Web-Based AI Engineering Platform — Development Specification v0.1" plus the expanded goals: manufacturing-ready PCBs, part-sourcing agents, custom motherboards, enclosure design, and power planning.*

*Cost and timeline figures are rough planning numbers. Confirm them during the G0 audit.*

---

## 1. Bottom line

**You can build this, as long as VX Design is not a clone of Flux.** Flux spent years and a lot of venture money building a browser-native schematic/PCB editor. You don't need to repeat that to get value in-house or to compete. The v0.1 spec already points the right way: an **AI planning and orchestration layer that drives proven open engineering tools (KiCad, ngspice, CadQuery/OCCT) and produces real, editable, verifiable files**.

The wedge against Flux is **spec → verified manufacturing package**, covering electrical, power, sourcing, and enclosure. Every decision is traced to evidence, and the output is open KiCad/STEP files with no lock-in. Flux is mainly an editor with a copilot. VX would be an engineering agent that has an audit trail.

| Horizon | Realistic outcome | Team | Time |
|---|---|---|---|
| In-house MVP (spec G0–G4) | Spec → plan → sourced BOM → power budget → simple KiCad board + fab files you can order | 1–2 strong engineers + AI-assisted dev + EE reviewer part-time | ~4–6 months |
| Useful in-house tool (+ sourcing agent, power planner, enclosure, fab export, Flux import) | Smart Slate timecode board and enclosure prototyped through the platform | same, plus a mechanical/CAD-geometry person part-time | ~8–10 months total |
| Market v1 (multi-tenant, billing, in-browser editing, support) | Credible paid product for small hardware teams and prosumers | 6–12 people | 18–30 months, ~$2–6M |

## 2. What the v0.1 spec gets right

- **Plan-first, evidence-based workflow** (task DAG, approvals, immutable decisions, evidence categories). This is the real product differentiator. Keep it.
- **G0 API/license verification gate** before promising automation. It's essential, because several tools have weaker APIs than their marketing suggests.
- **Vercel for UI only; long jobs on separate workers.** That's correct.
- **Native KiCad output, with no placeholder images.** That's correct and builds trust.
- **Separate gates (ERC ≠ DRC ≠ fit ≠ BOM ≠ manufacturing readiness).** That's correct.

## 3. Gaps between the spec and the goals

The spec defers "hardware manufacturing sign-off" and doesn't cover several things you now want. Each one needs its own workstream:

### 3.1 Manufacturing-ready PCB package (new gate: G4.5 "Fab Package")
- Outputs: Gerbers (or ODB++), drill files, pick-and-place/CPL, fab-formatted BOM, stackup and impedance notes, fab drawing, and assembly drawing. **`kicad-cli` produces almost all of these headlessly**, so this is low risk.
- Panelization: **KiKit** (open source).
- DFM rules: fab-specific DRC rule sets (JLCPCB, PCBWay, OSH Park, MacroFab) as selectable profiles.
- Ordering: most fabs don't offer open ordering APIs (JLCPCB and PCBWay have partner programs). **For in-house use, export a ZIP and upload it manually.** Pursue partner APIs for market.

### 3.2 Sourcing agent
- Data sources: **DigiKey API** (free with registration), **Mouser API** (free), **Nexar/Octopart** (paid tiers, aggregated multi-distributor data), and the **JLCPCB/LCSC parts catalog** (important if you use their assembly service: "basic" vs "extended" parts change cost).
- Agent jobs: parametric search, lifecycle/NRND checks, stock and price breaks, second-source alternates, and BOM cost roll-up at prototype and production quantities.
- **Symbols, footprints, and 3D models are the #1 correctness risk.** Sources include the KiCad official libraries, SnapEDA, Ultra Librarian, and SamacSys/Component Search Engine. Check each one's licensing terms before redistributing in a commercial product. AI-generated footprints from datasheets need mandatory verification (IPC-7351 check, pad-to-STEP overlay, human sign-off). One wrong footprint costs a board spin.
- Licensing: distributor API terms often restrict caching and redistribution. That's fine in-house, but needs commercial agreements before market.

### 3.3 Custom motherboards: the hardest part
- **Schematic generation is achievable.** LLMs can work well from reference designs and datasheets, especially when they generate *code* that compiles to a netlist rather than drawing schematics. Evaluate **atopile**, **SKiDL**, and **tscircuit** in G0. They map naturally to AI generation and version control.
- **Layout is where AI is weakest.** Open autorouting (Freerouting) works for simple 2–4 layer, low-speed boards. High-speed interfaces (DDR, USB 3, MIPI, HDMI, and **SDI/HD video for film gear**) need constraint-driven, human-reviewed layout.
- **Strong recommendation: design the Smart Slate as a carrier board for a System-on-Module** (e.g. a compute module or ESP32/STM32 module, depending on requirements). That removes DDR and processor fan-out routing from scope and puts the AI on problems it can solve: power, connectors, timecode I/O, display, and buttons.
- Practical flow: AI does placement proposals and low-speed routing. A human routes critical nets in KiCad desktop (the native files make this easy). The platform then re-runs DRC and fit checks.

### 3.4 Power planning (high value, low risk, so build it early)
- Mostly **deterministic engineering math, not LLM guesswork**: power tree (sources → regulators → rails → loads), per-rail current budgets, regulator efficiency and dissipation, thermal estimates, battery runtime, inrush and sequencing.
- Use ngspice for transient checks where vendor models exist. Many vendor tools (e.g. TI WEBENCH) have no public API, so treat them as manual references.
- Battery/charger architecture stays a mandatory human approval gate (already in the spec).

### 3.5 Enclosure design and manufacturing
- **CadQuery or build123d** (Python, OCCT-based) for parametric housings generated from the KiCad board STEP export: outline, standoffs and bosses, connector cutouts, display windows, button plungers.
- Fit and interference checks via OCCT boolean/collision ops, which the spec already covers.
- Outputs: STEP (CNC, injection-mold vendors), STL/3MF (3D printing), plus DFM checks per process: wall thickness, draft angles for molding, minimum features for print and CNC.
- Start with **3D-print and CNC**. Molding DFM is a later, harder module.
- Quoting: Xometry, Protolabs, and similar services. API access is limited, so plan for manual upload at first.

## 4. Architecture adjustments

| Area | Recommendation |
|---|---|
| Electrical system of record | KiCad 9+ native files. Don't invent a proprietary format in the MVP. Optionally use a code-based circuit layer (atopile/SKiDL/tscircuit) that *compiles* to KiCad. |
| KiCad automation | `kicad-cli` (headless ERC/DRC/exports) in Docker workers. The KiCad IPC API needs a running instance and has limited schematic coverage, so verify both in G0. Direct S-expression file generation is a viable fallback. |
| Browser viewing | **KiCanvas** (open source KiCad schematic/PCB viewer) and **three.js + occt-import-js** (STEP in browser), or server-side STEP → glTF. Viewer first, editor later. |
| Job queue | Keep it small: **pg-boss** (runs on Supabase Postgres) or **Trigger.dev/Inngest** for durable jobs. Temporal is overkill for the MVP. |
| Workers | One Docker host (Fly.io, Railway, GCP, or a Hetzner VM) with images for KiCad, ngspice, CadQuery, KiKit, and Freerouting. Scale out later. |
| AI | Provider-neutral adapter (per spec), using tool use and structured outputs. The model proposes, deterministic tools verify, and only verified results get committed. |
| Licensing | Run KiCad and the other GPL tools as separate processes in workers (no linking). That works for SaaS. Track every dependency's license in the capability matrix. |

## 5. Top risks

1. **Electrical correctness.** Wrong pinouts or footprints mean scrapped boards. *Mitigation:* evidence categories (already in spec), footprint/3D overlay verification, required human sign-off on schematic and layout before fab export.
2. **Layout automation quality.** *Mitigation:* SoM/carrier approach, human-in-the-loop routing, and autorouting limited to simple boards.
3. **Data and library licensing for market** (Octopart/Nexar, SnapEDA, and others). *Mitigation:* record terms in G0 and budget for commercial data agreements.
4. **Scope.** The full vision is roughly five products (EDA agent, sourcing, MCAD, power, PLM). *Mitigation:* strict phase gates, and every phase has to ship something used on the Smart Slate.
5. **Liability at market.** The tool cannot certify safety, FCC/CE, or battery compliance. *Mitigation:* clear labeling (already in spec), and position the product as engineering assistance with evidence, not sign-off.

## 6. Recommended phase order (in-house)

Reordered from the spec so useful output reaches the Smart Slate early:

| Phase | Weeks | Deliverables | Exit test |
|---|---|---|---|
| **G0: Capability audit** | 2–3 | Docker worker with kicad-cli, KiKit, Freerouting, ngspice, CadQuery; atopile/SKiDL spike; DigiKey + Mouser + Nexar samples; KiCanvas + STEP viewer prototype; Flux export check | Every integration has a runnable sample or a documented blocker |
| **G1+G2: Plan engine + worker backbone** | 5–7 | Supabase schema (spec §14), DOCX/PDF intake → cited requirements → task DAG → approvals; durable queue, checkpoints, budgets, locks | Smart Slate spec yields a stable approved plan, and a run survives worker restart |
| **P1: Sourcing agent + power planner** *(pulled forward)* | 5–6 | Live multi-distributor BOM with alternates and lifecycle; power tree calculator with rail budgets, thermal, runtime | Smart Slate BOM and power budget usable even if the CAD is still done by hand |
| **G3+G4: First board** | 6–8 | Timecode sub-board (not the motherboard): schematic → ERC → layout → DRC → 3D with real STEP models | Opens cleanly in KiCad desktop, zero unwaived DRC errors |
| **G4.5: Fab package** | 2–3 | Gerbers/drill/CPL/BOM per fab profile, KiKit panel, fab ZIP | **Order the board, assemble it, and test it.** This is the real acceptance test |
| **P2: Enclosure** | 4–6 | Parametric housing from board STEP, fit/interference report, STEP + STL outputs | 3D-printed housing fits the real assembled board |
| **G5: Flux import/audit** | 2–4 | Import the existing Smart Slate Flux work, map verified vs. unknown items | Migration plan with bounded tasks (move earlier if the motherboard work lives in Flux today) |
| **Motherboard** | ongoing | SoM carrier motherboard using all modules above | Physical prototype passes bring-up tests |
| **G6: Hardening** | 3–4 | Regression fixtures, security, recovery | Repeat runs produce consistent, traceable results |

## 7. Running costs (in-house, rough)

- Vercel Pro and Supabase Pro: low tens of dollars per month each.
- Worker host: roughly $50–200/month (CPU-heavy, no GPU needed).
- Distributor APIs: DigiKey and Mouser are free. Nexar has a limited free tier, with paid tiers for volume.
- AI usage: the largest variable. Expect hundreds to low thousands of dollars per month with unattended runs. The spec's per-run budgets are the right control.
- **Physical prototypes:** budget for 3–5 board spins and several enclosure prints. Simple assembled boards often cost tens to a few hundred dollars per spin, and complex boards more. Hardware iteration, not software, usually sets the real pace.

## 8. Path to market

1. Prove the platform on Smart Slate, then on VC Composer and the Film Studio sync boxes. Three real products give you case studies and a fixture suite.
2. Add multi-tenancy, billing (Stripe), email, onboarding, and usage metering.
3. Sign commercial data agreements for parts, libraries, and pricing.
4. Add light in-browser editing (part swaps, net edits, placement tweaks) on top of the viewer. Full browser CAD parity with Flux is optional and expensive.
5. Partner integrations with fabs and assembly houses (JLCPCB, PCBWay, MacroFab) and mechanical manufacturers for one-click quote and order. These also become a revenue channel (referral/margin).
6. Positioning: *"From spec to a verified, orderable product: board, power, parts, and enclosure, with an audit trail and open files."*

## 9. Immediate next steps

1. Set up the monorepo scaffold per spec §12 (`apps/web`, `services/orchestrator`, `services/engineering`, `packages/contracts`, `packages/integrations`, `supabase/migrations`, `tests/fixtures`, `docs`).
2. Create the Supabase project and initial schema migration (spec §14 tables).
3. Build the **G0 engineering worker Docker image** and spike scripts. This is the riskiest unknown and should start first.
4. Register for DigiKey, Mouser, and Nexar developer API keys.
5. Prepare a sanitized Smart Slate spec, the timecode board requirements, and the Flux export package.
