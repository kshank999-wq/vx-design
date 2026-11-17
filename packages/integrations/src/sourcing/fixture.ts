/**
 * Offline stand-in for the distributor APIs (VX_SOURCING=fixture), used in tests and local runs
 * without keys. Every record is labelled fixture: the part numbers starting FX- are invented, and no
 * price, stock figure or SKU here is real. Fixture results are never written to the shared catalog and
 * fixture LCSC numbers are never applied to a fab package.
 */
import type { Offer, PartRecord, SourcingProvider } from "./types.ts";

const OBSERVED = "2026-01-01T00:00:00.000Z";

function offers(sku: string, stock: number, prices: [number, number][], withLcsc = true): Offer[] {
  const base = { provider: "fixture" as const, moq: 1, multiple: 1, packaging: "Cut Tape", currency: "USD", url: null,
                 observedAt: OBSERVED, status: "fixture" as const };
  const list: Offer[] = [
    { ...base, seller: "Fixture Distributor A", sku: `FXA-${sku}`, stock, prices: prices.map(([quantity, unitPrice]) => ({ quantity, unitPrice })) },
    { ...base, seller: "Fixture Distributor B", sku: `FXB-${sku}`, stock: Math.round(stock / 3),
      prices: prices.map(([quantity, unitPrice]) => ({ quantity, unitPrice: Math.round(unitPrice * 1.1 * 10000) / 10000 })) },
  ];
  if (withLcsc) {
    list.push({ ...base, seller: "LCSC (fixture)", sku: `C9${String(Math.abs(hash(sku)) % 100000).padStart(5, "0")}`, stock: stock * 2,
                moq: 10, multiple: 10, packaging: "Tape & Reel",
                prices: prices.filter(([quantity]) => quantity >= 10)
                  .map(([quantity, unitPrice]) => ({ quantity, unitPrice: Math.round(unitPrice * 0.6 * 10000) / 10000 })) });
  }
  return list;
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

function part(mpn: string, manufacturer: string, description: string, pkg: string | null, o: Offer[]): PartRecord {
  return { provider: "fixture", mpn, manufacturer, description: `Fixture record: ${description}`, lifecycle: "active",
           lifecycleRaw: "Active (fixture)", datasheetUrl: null, productUrl: null, package: pkg, specs: {}, offers: o };
}

export const FIXTURE_CATALOG: PartRecord[] = [
  part("AP2112K-3.3TRG1", "Diodes Incorporated", "LDO regulator 3.3V 600mA SOT-23-5", "SOT-23-5",
       offers("AP2112K", 40000, [[1, 0.5], [10, 0.4], [100, 0.25], [1000, 0.15]])),
  part("FX-C0603-105-16V", "Fixture Passives", "capacitor ceramic 1uF 16V X7R 0603", "0603",
       offers("C105-16", 200000, [[1, 0.1], [10, 0.05], [100, 0.02], [1000, 0.008]])),
  part("FX-C0603-105-6V3", "Fixture Passives", "capacitor ceramic 1uF 6.3V X5R 0603", "0603",
       offers("C105-6", 500000, [[1, 0.08], [10, 0.04], [100, 0.01], [1000, 0.004]])),
  part("FX-R0603-1K", "Fixture Passives", "resistor 1 kOhms 1% 0.1W 0603 thick film", "0603",
       offers("R1K", 300000, [[1, 0.1], [10, 0.03], [100, 0.01], [1000, 0.003]])),
  part("FX-LED0603-G", "Fixture Optoelectronics", "LED Green 0603 20mA", "0603",
       offers("LEDG", 80000, [[1, 0.2], [10, 0.12], [100, 0.06], [1000, 0.03]])),
  part("FX-HDR-1X02-2.54", "Fixture Connectors", "pin header 1x2 positions 2.54mm vertical through hole", null,
       offers("HDR2", 20000, [[1, 0.15], [10, 0.1], [100, 0.06], [1000, 0.04]], false)),
];

const CLASS_WORDS = ["capacitor", "resistor", "led", "pin header", "regulator"];

export class FixtureProvider implements SourcingProvider {
  readonly id = "fixture" as const;
  readonly label = "Fixture data (offline stand-in)";
  readonly role = "fixture" as const;
  readonly terms = "Invented test data: not a real offer, price or stock figure.";
  configured(): boolean { return true; }

  async searchMpn(mpn: string): Promise<PartRecord[]> {
    const n = mpn.toUpperCase();
    return FIXTURE_CATALOG.filter((p) => p.mpn.toUpperCase().startsWith(n) || n.startsWith(p.mpn.toUpperCase()));
  }

  async searchKeyword(query: string, limit: number): Promise<PartRecord[]> {
    const q = query.toLowerCase();
    const cls = CLASS_WORDS.find((w) => q.includes(w));
    return FIXTURE_CATALOG.filter((p) => cls && (p.description ?? "").toLowerCase().includes(cls)).slice(0, limit);
  }
}
