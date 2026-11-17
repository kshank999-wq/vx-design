/**
 * Sourcing executor (M-SRC): approved circuit design -> sourced BOM.
 *
 * Every component is looked up on every configured distributor (primary first; a failing provider
 * does not stop the line), identities are checked, generic passives are chosen by rules, prices are
 * computed at 1/10/100/1000 boards, and LCSC numbers are collected for JLCPCB assembly. Live results
 * are added to the shared parts catalog with their observation time; fixture results never are.
 *
 * Steps (checkpointed): context (upstream design) -> resolve (provider calls) -> store.
 * Offers are observations: a resumed attempt reuses the checkpointed resolution instead of calling
 * the providers again, so the stored BOM is the one that was checked.
 */
import { CircuitDesign } from "@vx/planning";
import { BOM_RESOLVER_VERSION, normalizeManufacturer, normalizeMpn, resolveBom, type BomResolution, type SourcingProvider } from "@vx/integrations";
import type { Validation } from "../db.ts";
import type { Executor, ExecutorContext, ExecutorResult } from "../execution.ts";

export function bomCsv(r: BomResolution): string {
  const q = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const tiers = r.quantities.map((n) => `Unit price @${n} boards (${r.currency})`);
  const rows = [["Refs", "Qty/board", "Value", "Footprint", "MPN", "Manufacturer", "Selection", "Lifecycle", "LCSC",
                 ...tiers, "Best seller @100", "Flags", "Data"].map(q).join(",")];
  for (const l of r.lines) {
    rows.push([l.refs.join(" "), l.quantityPerBoard, l.wanted.value, l.wanted.footprint, l.selected?.mpn ?? "", l.selected?.manufacturer ?? "",
               l.selected?.identity ?? "unsourced", l.selected?.lifecycle ?? "", l.lcsc ?? "",
               ...l.pricing.map((p) => p.choice ? p.choice.unitPrice : ""),
               l.pricing.find((p) => p.boards === 100)?.choice?.seller ?? "",
               l.flags.filter((f) => f.severity !== "info").map((f) => f.code).join(" "),
               [...new Set(l.offers.map((o) => o.status))].join("/") || "none"].map(q).join(","));
  }
  return rows.join("\n") + "\n";
}

export function sourcingExecutor(providers: SourcingProvider[]): Executor {
  const fixture = providers.every((p) => p.id === "fixture");
  return {
    id: "sourcing",
    version: BOM_RESOLVER_VERSION,
    describe: `BOM sourcing via ${providers.map((p) => p.label).join(", ")}`,
    disciplines: ["sourcing"],
    canRun: (task) => task.discipline === "sourcing",

    async run(ctx: ExecutorContext): Promise<ExecutorResult> {
      const { task, db } = ctx;
      const source = await ctx.step("context", async () => {
        const d = await db.upstreamJson(task.id, "design");
        if (!d) return null;
        const parsed = CircuitDesign.safeParse(d.value);
        return parsed.success ? { taskKey: d.taskKey, versionId: d.versionId, design: parsed.data } : null;
      });
      if (!source) {
        return { status: "blocked", reason: "Sourcing needs the committed circuit design of an upstream schematic task " +
                                            "('<schematic task>/design'). Run and approve the schematic first." };
      }

      const resolution = await ctx.step("resolve", async () => {
        const r = await resolveBom({ components: source.design.components, nets: source.design.nets }, providers);
        const calls = r.lines.flatMap((l) => l.attempts).filter((a) => a.outcome !== "not_configured");
        for (const p of new Set(calls.map((c) => c.provider))) {
          const n = calls.filter((c) => c.provider === p).length;
          await db.recordCost(ctx.exec.id, "api_call", p, `${p} search`, n, "requests", 0);
        }
        if (r.dataStatus === "live") {
          for (const l of r.lines.filter((x) => x.selected)) {
            const s = l.selected!;
            await db.recordPart({
              mpn: s.mpn, normalized_mpn: normalizeMpn(s.mpn), manufacturer: s.manufacturer,
              normalized_mfr: normalizeManufacturer(s.manufacturer), description: s.description, lifecycle: s.lifecycle,
              datasheet_url: s.datasheetUrl, package: l.wanted.package, provider: s.providers[0],
            }, l.offers.filter((o) => o.status === "live").map((o) => ({
              provider: o.provider, seller: o.seller, sku: o.sku, stock: o.stock, moq: o.moq, multiple: o.multiple,
              packaging: o.packaging, currency: o.currency, url: o.url, data_status: o.status, observed_at: o.observedAt,
              prices: o.prices.map((b) => ({ quantity: b.quantity, unit_price: b.unitPrice })),
            })));
          }
        }
        // Manufacturer CAD offered by a live provider becomes a 3D model library candidate (checked, then verified by a person).
        let candidates = 0;
        if (r.dataStatus === "live") {
          for (const l of r.lines) {
            const cad = l.selected?.cad;
            if (!cad?.has3dModel || !cad.downloadUrl?.startsWith("https://")) continue;
            try {
              await db.registerPartModel({
                projectId: task.project_id, mpn: l.selected!.mpn, manufacturer: l.selected!.manufacturer,
                normalizedMpn: normalizeMpn(l.selected!.mpn), normalizedMfr: normalizeManufacturer(l.selected!.manufacturer),
                footprint: l.wanted.footprint, sourceKind: "nexar", source: cad.source, sourceUrl: cad.downloadUrl,
                license: "Octopart CAD partner terms (e.g. SnapEDA); check before redistributing", shared: true,
              });
              candidates++;
            } catch (e) {
              await ctx.log(`could not register the 3D model offered for ${l.selected!.mpn}: ${(e as Error).message}`, {}, "warn");
            }
          }
        }
        if (candidates) await ctx.log(`${candidates} manufacturer 3D model(s) sent to the model library for checking`);
        await ctx.log(`sourced ${r.counts.sourced} of ${r.counts.lines} line(s) (${r.dataStatus} data): ${r.counts.errors} error(s), ` +
                      `${r.counts.warnings} warning(s), ${r.counts.withLcsc} with an LCSC number`,
                      { counts: r.counts, providers: r.providers.map((p) => `${p.id}:${p.configured ? "on" : "off"}`) });
        return r;
      });

      const stored = await ctx.step("store", async () => {
        const config = { providers: resolution.providers.map((p) => p.id), data_status: resolution.dataStatus,
                         source_design: source.versionId, observed_at: resolution.generatedAt };
        const common = { toolName: "vx-sourcing", toolVersion: BOM_RESOLVER_VERSION, toolConfig: config };
        const json = await ctx.storeArtifact({ ...common, name: `${task.key}/sourced-bom`, kind: "bom", filename: "sourced-bom.json",
          content: JSON.stringify({ ...resolution, source_design: { task: source.taskKey, version_id: source.versionId } }, null, 2),
          contentType: "application/json",
          summary: `${resolution.counts.sourced}/${resolution.counts.lines} lines sourced (${resolution.dataStatus} data)` });
        const csv = await ctx.storeArtifact({ ...common, name: `${task.key}/sourced-bom-csv`, kind: "bom", filename: "sourced-bom.csv",
          content: bomCsv(resolution), contentType: "text/csv; charset=utf-8" });
        // Ref -> LCSC map for the fab package. Fixture numbers are invented, so they are marked and never applied.
        const lcsc = Object.fromEntries(resolution.lines.flatMap((l) => l.lcsc ? l.refs.map((r) => [r, l.lcsc]) : []));
        const map = await ctx.storeArtifact({ ...common, name: `${task.key}/lcsc-map`, kind: "bom", filename: "lcsc-map.json",
          content: JSON.stringify({ data_status: resolution.dataStatus, observed_at: resolution.generatedAt, lcsc }, null, 2),
          contentType: "application/json" });
        return { json: json.versionId, csv: csv.versionId, map: map.versionId };
      });

      const c = resolution.counts;
      const t100 = resolution.totals.find((t) => t.boards === 100);
      const errors = resolution.lines.flatMap((l) => l.flags.filter((f) => f.severity === "error").map((f) => `${l.refs.join(",")}: ${f.message}`));
      const warnings = resolution.lines.flatMap((l) => l.flags.filter((f) => f.severity === "warning").map((f) => `${l.refs.join(",")}: ${f.code}`));
      const check: Validation = {
        kind: "bom_check", result: errors.length ? "fail" : warnings.length ? "warning" : "pass",
        evidence_category: resolution.dataStatus === "live" ? "deterministic_calculation" : "unverified_assumption",
        summary: `${c.sourced}/${c.lines} lines sourced from ${resolution.dataStatus} distributor data` +
                 (t100?.perBoard != null ? `, ${resolution.currency} ${t100.perBoard.toFixed(2)} per board at 100 boards` : "") +
                 `; ${c.withLcsc} line(s) with LCSC numbers; ${c.errors} error(s), ${c.warnings} warning(s)`,
        artifact_version_id: stored.json, tool_name: "vx-sourcing", tool_version: BOM_RESOLVER_VERSION,
        details: { counts: c, totals: resolution.totals, errors: errors.slice(0, 30), warnings: warnings.slice(0, 30) },
      };
      if (errors.length) {
        const transient = resolution.lines.some((l) => l.attempts.some((a) => a.outcome === "error"));
        return { status: "failed", retryable: transient, validations: [check],
                 error: `${errors.length} line problem(s): ${errors.slice(0, 5).join("; ")}` };
      }
      const ruleSelected = resolution.lines.filter((l) => l.selected?.identity === "rule_selected").flatMap((l) => l.refs);
      const reviewReason = resolution.dataStatus !== "live"
        ? "Fixture sourcing data (offline stand-in): part numbers, prices and stock are invented; review the flow, not the numbers"
        : ruleSelected.length ? `Parts chosen by rules need review: ${ruleSelected.join(", ")}`
        : warnings.length ? `Sourcing warnings to review: ${warnings.slice(0, 5).join("; ")}` : null;
      return { status: "passed", validations: [check], reviewReason,
               summary: check.summary + (fixture ? " (fixture data)" : "") };
    },
  };
}
