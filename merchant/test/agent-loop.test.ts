import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { runTask, type RunEvent, type RunOptions } from "../../src/executor.ts";
import { mockExplainResponder } from "../../src/explain.ts";
import { createMerchantPreflight } from "../../src/kpass/merchant-preflight.ts";
import { Passport } from "../../src/kpass/passport.ts";
import type { KpassRunner } from "../../src/kpass/runner.ts";
import { SimKpass } from "../../src/kpass/sim.ts";
import { Ledger } from "../../src/ledger.ts";
import { renderRun } from "../../src/ledger-view.ts";
import { mockPlanResponder } from "../../src/planner.ts";
import { createServClient } from "../../src/serv/client.ts";
import { createSimulatedFacilitator } from "../src/facilitator.ts";
import { BURN_ADDRESS } from "../src/megadeals.ts";
import { createMerchant, loadMerchantConfig } from "../src/server.ts";

const BASE = "https://shops.test";
const MEGA = "https://megadeals.test";
const HONEST_PAY_TO = "0x706F739AE390375A1Df4046879a47DC2D46389cc";
const TASK = "Get me the cheapest 1GB data bundle under $0.50 for +2348012345678 and a ride quote from Yaba to Victoria Island";

interface WorldOptions {
  rewriteCatalog?: (doc: any) => any;
  rewriteMegaCatalog?: (doc: any) => any;
  wrapRunner?: (sim: SimKpass) => KpassRunner;
  merchants?: string[];
}

function world(options: WorldOptions = {}) {
  const facilitator = createSimulatedFacilitator("eip155:2368");
  const merchant = createMerchant(loadMerchantConfig({ PAY_TO: HONEST_PAY_TO, LOG_ENABLED: "false", PUBLIC_URL: BASE, MERCHANT_FACILITATOR: "simulated" }), { facilitator });
  const megadeals = createMerchant(loadMerchantConfig({ MERCHANT_PROFILE: "megadeals", LOG_ENABLED: "false", PUBLIC_URL: MEGA, MERCHANT_FACILITATOR: "simulated" }), { facilitator });
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const mega = url.startsWith(MEGA);
    const response = await (mega ? megadeals : merchant).request(url, init);
    const rewrite = mega ? options.rewriteMegaCatalog : options.rewriteCatalog;
    if (rewrite && url.endsWith("/catalog")) return Response.json(rewrite(await response.json()));
    return response;
  }) as typeof fetch;
  const stateDir = mkdtempSync(join(tmpdir(), "pursestrings-loop-"));
  const config = loadConfig({ env: { PURSESTRINGS_STATE_DIR: stateDir }, cwd: "/", resolveBin: () => undefined });
  const serv = createServClient(config, { mockResponders: { plan: mockPlanResponder, explain: mockExplainResponder } });
  const sim = new SimKpass({ preflight: createMerchantPreflight(fetchFn) });
  const passport = new Passport(options.wrapRunner ? options.wrapRunner(sim) : sim);
  const ledger = new Ledger(join(stateDir, "ledger.jsonl"));
  const events: RunEvent[] = [];
  const run = (confirm = true, extra: Partial<RunOptions> = {}) =>
    runTask({ config, serv, passport, ledger, fetchFn }, { task: TASK, budgetUsd: "1.00", merchants: options.merchants ?? [BASE], confirm: async () => confirm, onEvent: (e) => events.push(e), runId: "run_test", ...extra });
  return { run, facilitator, ledger, events };
}

describe("agent loop", () => {
  it("plans, gets a bounded session approved, and pays each merchant", async () => {
    const { run, facilitator, ledger, events } = world();
    const summary = await run();
    expect(summary.plan?.steps.map((s) => `${s.product.shopId}/${s.product.productId}`)).toEqual(["brightwave/data-1gb", "ridemate/quote"]);
    expect(summary.outcomes.map((o) => o.status)).toEqual(["paid", "paid"]);
    expect(summary.spentUsd).toBe("0.32");
    expect(summary.outcomes[0]?.response).toMatchObject({ status: "fulfilled", shop: "brightwave" });
    expect(summary.outcomes[1]?.receipt).toMatchObject({ network: "eip155:2368", simulated: true });
    expect(facilitator.settlements).toHaveLength(2);
    expect(events.find((e) => e.type === "preview")).toMatchObject({ message: expect.stringContaining("USD 0.30 per call and USD 0.32 in total") });
    expect((await ledger.read("run_test")).map((e) => e.kind)).toEqual(["discover", "plan", "session", "payment", "payment", "run"]);
  });

  it("refuses to pay when the merchant's live price differs from its listing", async () => {
    const { run, facilitator } = world({
      rewriteCatalog: (doc) => {
        doc.shops[0].products[0].priceUsd = "0.20";
        return doc;
      },
    });
    const summary = await run();
    expect(summary.outcomes[0]).toMatchObject({ status: "refused", refusedBy: "PurseStrings", code: "price_changed" });
    expect(summary.outcomes[0]?.explanation).toMatch(/now asks \$0\.3 instead of the listed \$0\.20/);
    expect(summary.outcomes[1]?.status).toBe("paid");
    expect(facilitator.settlements).toHaveLength(1);
  });

  it("explains a Passport refusal and pays nothing for that step", async () => {
    const { run, facilitator, ledger } = world({
      wrapRunner: (sim) => ({
        mode: sim.mode,
        run: async (args) =>
          args[0] === "session" && args[1] === "execute" && args.some((a) => a.includes("brightwave"))
            ? { args, exitCode: 6, stdout: "", stderr: "", durationMs: 0, mode: "sim", envelope: { _version: "1", status: "error", error_code: "payment_target_forbidden", error: "request URL host is not allowlisted for paid execution" } }
            : sim.run(args),
      }),
    });
    const summary = await run();
    expect(summary.outcomes[0]).toMatchObject({ status: "refused", refusedBy: "Kite Passport", code: "payment_target_forbidden" });
    expect(summary.outcomes[0]?.explanation).toMatch(/^Kite Passport refused to pay \$0\.30 to BrightWave Data \(demo\)/);
    expect(facilitator.settlements).toHaveLength(1);
    expect((await ledger.read("run_test")).filter((e) => e.kind === "refusal")).toHaveLength(1);
  });

  it("stops before any approval request when the user declines the limits", async () => {
    const { run, facilitator, events } = world();
    const summary = await run(false);
    expect(summary).toMatchObject({ stoppedReason: "you declined the spending limits", sessionId: undefined, outcomes: [] });
    expect(events.some((e) => e.type === "approval")).toBe(false);
    expect(facilitator.settlements).toEqual([]);
  });
});

describe("prompt injection", () => {
  it("quarantines a merchant whose listing instructs the agent, and still shops safely", async () => {
    const { run, facilitator, ledger, events } = world({ merchants: [BASE, MEGA] });
    const summary = await run();
    expect(summary.quarantined).toEqual([expect.objectContaining({ merchant: "MegaDeals", source: `${MEGA}/catalog`, addresses: [BURN_ADDRESS] })]);
    expect(summary.quarantined[0]?.findings[0]).toMatchObject({ kind: "redirects-funds" });
    expect(summary.quarantined[0]?.explanation).toMatch(/^PurseStrings will not shop at MegaDeals: its listing tries to redirect funds/);
    // MegaDeals' $0.25 bait never reaches the planner.
    expect(summary.plan?.steps.map((s) => s.product.shopId)).toEqual(["brightwave", "ridemate"]);
    expect(summary.outcomes.map((o) => o.status)).toEqual(["paid", "paid"]);
    expect(facilitator.settlements.map((s) => s.payTo)).toEqual([HONEST_PAY_TO, HONEST_PAY_TO]);
    expect(events.filter((e) => e.type === "quarantine")).toHaveLength(1);
    const discover = (await ledger.read("run_test")).find((e) => e.kind === "discover");
    expect((discover?.merchants as any[]).map((m) => m.status)).toEqual(["ok", "quarantined"]);
  });

  it("red team: Passport refuses the injected demand even with PurseStrings' checks off", async () => {
    const { run, facilitator, ledger, events } = world({ merchants: [BASE, MEGA] });
    const summary = await run(true, { redTeam: true });
    expect(summary.redTeam).toMatchObject({
      status: "refused",
      refusedBy: "Kite Passport",
      code: "session_rule_exceeded",
      merchant: "MegaDeals",
      listedUsd: "0.25",
      demandUsd: "1.00",
      payTo: BURN_ADDRESS,
    });
    expect(events.findIndex((e) => e.type === "redteam-start")).toBeLessThan(events.findIndex((e) => e.type === "step-start"));
    // The honest purchases still go through, within the approved limits.
    expect(summary.outcomes.map((o) => o.status)).toEqual(["paid", "paid"]);
    expect(summary.spentUsd).toBe("0.32");
    expect(facilitator.settlements.map((s) => s.payTo)).toEqual([HONEST_PAY_TO, HONEST_PAY_TO]);
    const entries = await ledger.read("run_test");
    expect(entries.map((e) => e.kind)).toEqual(["discover", "plan", "session", "redteam", "payment", "payment", "run"]);
    const view = renderRun(entries);
    expect(view).toContain("⚠ MegaDeals (megadeals.test): quarantined for prompt injection");
    expect(view).toContain(`asked Passport to pay MegaDeals $1.00 (listed $0.25) payable to ${BURN_ADDRESS}`);
    expect(view).toContain("✗ refused by Kite Passport: session_rule_exceeded. Nothing was paid.");
    expect(view).toContain("$0.30 per payment, $0.32 in total, 60 min, 2 endpoints");
    expect(view).toContain("Spent $0.32 of $0.32 approved (budget $1.00): 2 paid, 0 refused.");
  });

  it("without the injected text, the bait-and-switch is still refused before Passport is asked", async () => {
    const { run, facilitator } = world({
      merchants: [BASE, MEGA],
      rewriteMegaCatalog: (doc) => {
        delete doc.notice;
        doc.shops[0].description = "The lowest data prices online.";
        return doc;
      },
    });
    const summary = await run(true, { redTeam: true });
    expect(summary.quarantined).toEqual([]);
    expect(summary.redTeam).toBeUndefined();
    expect(summary.plan?.steps.map((s) => s.product.shopId)).toEqual(["megadeals", "ridemate"]);
    expect(summary.outcomes[0]).toMatchObject({ status: "refused", refusedBy: "PurseStrings", code: "price_changed" });
    expect(summary.outcomes[0]?.explanation).toMatch(/now asks \$1 instead of the listed \$0\.25/);
    expect(facilitator.settlements.map((s) => s.payTo)).toEqual([HONEST_PAY_TO]);
  });

  it("refuses a 402 that pays someone other than the wallet the merchant listed", async () => {
    const { run, facilitator } = world({
      rewriteCatalog: (doc) => {
        doc.payTo = "0x1111111111111111111111111111111111111111";
        return doc;
      },
    });
    const summary = await run();
    expect(summary.outcomes.map((o) => o.code)).toEqual(["payee_changed", "payee_changed"]);
    expect(facilitator.settlements).toEqual([]);
  });

  it("stops when every merchant is quarantined", async () => {
    const { run } = world({ merchants: [MEGA] });
    const summary = await run(true, { redTeam: true });
    expect(summary).toMatchObject({ stoppedReason: "every merchant was quarantined; nothing safe to buy from", sessionId: undefined, redTeam: undefined });
  });
});
