/**
 * Live checks against the real distributor APIs. Each runs only when its keys are set, and asks for one
 * well-known part (Nexar bills per part returned). Run: pnpm --filter @vx/integrations test:live
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DigiKeyProvider, MouserProvider, NexarProvider, type SourcingProvider } from "../src/index.ts";

const MPN = process.env.VX_LIVE_TEST_MPN ?? "AP2112K-3.3TRG1";
const providers: SourcingProvider[] = [
  new NexarProvider(process.env.NEXAR_CLIENT_ID, process.env.NEXAR_CLIENT_SECRET),
  new DigiKeyProvider(process.env.DIGIKEY_CLIENT_ID, process.env.DIGIKEY_CLIENT_SECRET),
  new MouserProvider(process.env.MOUSER_API_KEY),
];

for (const p of providers) {
  test(`${p.label}: live lookup of ${MPN}`, { skip: p.configured() ? false : `${p.id} keys not set` }, async () => {
    const parts = await p.searchMpn(MPN);
    assert.ok(parts.length > 0, "found the part");
    const part = parts.find((x) => x.mpn.toUpperCase().startsWith(MPN.toUpperCase().slice(0, 8)))!;
    assert.ok(part, `a result matches ${MPN}: ${parts.map((x) => x.mpn).join(", ")}`);
    assert.ok(part.manufacturer, "manufacturer present");
    const priced = part.offers.filter((o) => o.prices.length);
    assert.ok(priced.length > 0, "at least one priced offer");
    for (const o of priced) {
      assert.equal(o.status, "live");
      assert.ok(o.prices.every((b) => b.quantity > 0 && b.unitPrice > 0), "positive price breaks");
    }
    console.log(`  ${p.id}: ${part.mpn} (${part.manufacturer}), lifecycle ${part.lifecycleRaw ?? "n/a"}, ${part.offers.length} offer(s), ` +
                `sellers ${[...new Set(part.offers.map((o) => o.seller))].slice(0, 6).join(", ")}`);
  });
}
