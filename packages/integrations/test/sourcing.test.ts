import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FixtureProvider, matchIdentity, normalizeManufacturer, packageFromFootprint, parseValue, priceFor, resolveBom, valuesInText,
  type Offer, type PartRecord, type SourcingProvider,
} from "../src/index.ts";

const FIXTURE_CIRCUIT = {
  components: [
    { ref: "J1", symbol: "Connector_Generic:Conn_01x02", value: "VIN 5V", footprint: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical", mpn: null, manufacturer: null },
    { ref: "C1", symbol: "Device:C", value: "1uF", footprint: "Capacitor_SMD:C_0603_1608Metric", mpn: null, manufacturer: null },
    { ref: "U1", symbol: "Regulator_Linear:AP2112K-3.3", value: "AP2112K-3.3", footprint: "Package_TO_SOT_SMD:SOT-23-5", mpn: "AP2112K-3.3TRG1", manufacturer: "Diodes Incorporated" },
    { ref: "C2", symbol: "Device:C", value: "1uF", footprint: "Capacitor_SMD:C_0603_1608Metric", mpn: null, manufacturer: null },
    { ref: "R1", symbol: "Device:R", value: "1k", footprint: "Resistor_SMD:R_0603_1608Metric", mpn: null, manufacturer: null },
    { ref: "D1", symbol: "Device:LED", value: "Green", footprint: "LED_SMD:LED_0603_1608Metric", mpn: null, manufacturer: null },
  ],
  nets: [
    { name: "VIN", pins: ["J1.1", "C1.1", "U1.1", "U1.3"] },
    { name: "GND", pins: ["J1.2", "C1.2", "U1.2", "C2.2", "D1.1"] },
    { name: "+3V3", pins: ["U1.5", "C2.1", "R1.1"] },
    { name: "LED_A", pins: ["R1.2", "D1.2"] },
  ],
};

test("identity: normalization, packaging variants and manufacturer aliases", () => {
  assert.equal(matchIdentity({ mpn: "AP2112K-3.3TRG1", manufacturer: "Diodes Incorporated" }, { mpn: "ap2112k-3.3trg1", manufacturer: "DIODES INC." }), "exact");
  assert.equal(matchIdentity({ mpn: "AP2112K-3.3" }, { mpn: "AP2112K-3.3TRG1" }), "packaging_variant");
  assert.equal(matchIdentity({ mpn: "AP2112K-3.3TRG1" }, { mpn: "AP2112K-1.8TRG1" }), "different");
  assert.equal(matchIdentity({ mpn: "LM358", manufacturer: "Texas Instruments" }, { mpn: "LM358", manufacturer: "onsemi" }), "different");
  assert.equal(normalizeManufacturer("Murata Electronics North America"), "MURATA");
  assert.equal(packageFromFootprint("Capacitor_SMD:C_0603_1608Metric"), "0603");
  assert.equal(packageFromFootprint("Package_TO_SOT_SMD:SOT-23-5"), "SOT-23-5");
  assert.equal(parseValue("4k7", "Ω"), 4700);
  assert.ok(Math.abs(parseValue("100nF", "F")! - 1e-7) < 1e-15);
  assert.deepEqual(valuesInText("CAP CER 1UF 16V X7R 0603").farads, [1e-6]);
  assert.deepEqual(valuesInText("RES SMD 1 kOhms 1% 1/10W 0603").ohms, [1000]);
});

test("price at quantity honours MOQ, multiples and the cheaper next break", () => {
  const offer: Offer = { provider: "fixture", seller: "X", sku: "x", stock: 1e6, moq: 10, multiple: 5, packaging: null, currency: "USD",
                         prices: [{ quantity: 10, unitPrice: 0.1 }, { quantity: 100, unitPrice: 0.02 }], url: null, observedAt: "", status: "fixture" };
  assert.deepEqual(priceFor(offer, 1), { unitPrice: 0.1, buyQty: 10, extended: 1 });
  assert.deepEqual(priceFor(offer, 62), { unitPrice: 0.02, buyQty: 100, extended: 2 }, "100 at the break costs less than 65");
  assert.deepEqual(priceFor(offer, 12), { unitPrice: 0.1, buyQty: 15, extended: 1.5 });
});

test("fixture BOM: every line sourced, passives chosen by rules with a voltage rating check", async () => {
  const r = await resolveBom(FIXTURE_CIRCUIT, [new FixtureProvider()]);
  assert.equal(r.dataStatus, "fixture");
  assert.equal(r.counts.lines, 5, "C1 and C2 share a line");
  assert.equal(r.counts.sourced, 5);
  const caps = r.lines.find((l) => l.refs.join() === "C1,C2")!;
  assert.equal(caps.selected!.mpn, "FX-C0603-105-16V", "6.3 V part rejected for a 5 V input (needs 10 V+)");
  assert.match(caps.wanted.requirements[0]!, /rail voltage unknown from net names: required 16 V/,
               "C1 sits on VIN (voltage not in its name), so the shared line takes the stricter unknown-rail rule");
  const c2only = await resolveBom({ ...FIXTURE_CIRCUIT, components: [FIXTURE_CIRCUIT.components[3]!] }, [new FixtureProvider()]);
  assert.match(c2only.lines[0]!.wanted.requirements[0]!, /on a 3.3 V rail: rated 10 V or more/);
  assert.equal(caps.selected!.identity, "rule_selected");
  const u1 = r.lines.find((l) => l.refs.join() === "U1")!;
  assert.equal(u1.selected!.identity, "exact");
  assert.match(u1.lcsc!, /^C9\d{5}$/);
  assert.equal(r.lines.find((l) => l.refs.join() === "J1")!.lcsc, null);
  assert.ok(r.lines.find((l) => l.refs.join() === "J1")!.flags.some((f) => f.code === "no_lcsc"));
  const t100 = r.totals.find((t) => t.boards === 100)!;
  assert.ok(t100.perBoard! > 0 && t100.missingLines.length === 0);
  assert.equal(caps.pricing.find((p) => p.boards === 1)!.need, 2);
});

class Scripted implements SourcingProvider {
  readonly label: string;
  readonly terms = "test";
  readonly id: "nexar" | "digikey" | "mouser";
  readonly role: "primary" | "fallback_a" | "fallback_b";
  private readonly answer: PartRecord[] | Error | "unconfigured";
  constructor(id: "nexar" | "digikey" | "mouser", role: "primary" | "fallback_a" | "fallback_b",
              answer: PartRecord[] | Error | "unconfigured") { this.id = id; this.role = role; this.answer = answer; this.label = id; }
  configured() { return this.answer !== "unconfigured"; }
  async searchMpn() { if (this.answer instanceof Error) throw this.answer; return this.answer === "unconfigured" ? [] : this.answer; }
  async searchKeyword() { return []; }
}

const rec = (provider: "nexar" | "digikey" | "mouser", lifecycle: PartRecord["lifecycle"], sellers: string[]): PartRecord => ({
  provider, mpn: "AP2112K-3.3TRG1", manufacturer: "Diodes Inc.", description: "LDO", lifecycle, lifecycleRaw: lifecycle,
  datasheetUrl: null, productUrl: null, package: "SOT-23-5", specs: {},
  offers: sellers.map((s) => ({ provider, seller: s, sku: `${s}-1`, stock: 5000, moq: 1, multiple: 1, packaging: null, currency: "USD",
                                prices: [{ quantity: 1, unitPrice: 0.3 }], url: null, observedAt: "", status: "live" as const })),
});

test("fallback: a failed primary does not stop the line; disagreements and single sourcing are flagged", async () => {
  const one = { components: [FIXTURE_CIRCUIT.components[2]!], nets: [] };
  const r = await resolveBom(one, [
    new Scripted("nexar", "primary", new Error("HTTP 503")),
    new Scripted("digikey", "fallback_a", [rec("digikey", "active", ["DigiKey"])]),
    new Scripted("mouser", "fallback_b", [rec("mouser", "nrnd", ["Mouser"])]),
  ]);
  const line = r.lines[0]!;
  assert.deepEqual(line.attempts.map((a) => a.outcome), ["error", "ok", "ok"]);
  assert.deepEqual(line.selected!.providers, ["digikey", "mouser"]);
  const codes = line.flags.map((f) => f.code);
  assert.ok(codes.includes("provider_error") && codes.includes("lifecycle_disagreement") && codes.includes("no_lcsc"));
  assert.ok(!codes.includes("single_source"), "two sellers stock 100+");
  assert.equal(r.dataStatus, "live");
});

test("no provider configured: lines are unsourced with a plain error, never invented", async () => {
  const r = await resolveBom({ components: [FIXTURE_CIRCUIT.components[2]!], nets: [] },
                             [new Scripted("nexar", "primary", "unconfigured")]);
  assert.equal(r.counts.sourced, 0);
  assert.equal(r.lines[0]!.flags[0]!.code, "no_provider");
  assert.equal(r.totals[0]!.total, null);
  assert.equal(r.dataStatus, "none");
});

test("a provider that refuses us is asked once per parts list, and an anti-bot page is named as such", async () => {
  const { ProviderError } = await import("../src/index.ts");
  let calls = 0;
  class Refusing extends Scripted {
    async searchMpn(): Promise<PartRecord[]> { calls++; throw new ProviderError("digikey", "auth", "HTTP 403: <!DOCTYPE html><html><head><title>Just a moment...</title>"); }
  }
  const two = { components: [FIXTURE_CIRCUIT.components[2]!, FIXTURE_CIRCUIT.components[1]!], nets: [] };
  const r = await resolveBom(two, [new Refusing("digikey", "fallback_a", []), new Scripted("mouser", "fallback_b", [rec("mouser", "active", ["Mouser"])])]);
  assert.equal(calls, 1, "the refusing provider is not asked again");
  const errs = r.lines.flatMap((l) => l.attempts.filter((a) => a.provider === "digikey").map((a) => a.error ?? ""));
  assert.ok(errs.some((e) => /anti-bot firewall/.test(e) && !e.startsWith("skipped")), errs.join(" | "));
  assert.ok(errs.some((e) => e.startsWith("skipped: ")), errs.join(" | "));
});
