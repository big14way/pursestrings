import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { runTask, type RunEvent } from "../../src/executor.ts";
import { mockExplainResponder } from "../../src/explain.ts";
import { createMerchantPreflight } from "../../src/kpass/merchant-preflight.ts";
import { Passport } from "../../src/kpass/passport.ts";
import type { KpassRunner } from "../../src/kpass/runner.ts";
import { SimKpass } from "../../src/kpass/sim.ts";
import { Ledger } from "../../src/ledger.ts";
import { mockPlanResponder } from "../../src/planner.ts";
import { createServClient } from "../../src/serv/client.ts";
import { createSimulatedFacilitator } from "../src/facilitator.ts";
import { createMerchant, loadMerchantConfig } from "../src/server.ts";

const BASE = "https://shops.test";
const TASK = "Get me the cheapest 1GB data bundle under $0.50 for +2348012345678 and a ride quote from Yaba to Victoria Island";

function world(options: { rewriteCatalog?: (doc: any) => any; wrapRunner?: (sim: SimKpass) => KpassRunner } = {}) {
  const facilitator = createSimulatedFacilitator("eip155:2368");
  const merchant = createMerchant(loadMerchantConfig({ PAY_TO: "0x706F739AE390375A1Df4046879a47DC2D46389cc", LOG_ENABLED: "false", PUBLIC_URL: BASE, MERCHANT_FACILITATOR: "simulated" }), { facilitator });
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await merchant.request(String(input), init);
    if (options.rewriteCatalog && String(input).endsWith("/catalog")) return Response.json(options.rewriteCatalog(await response.json()));
    return response;
  }) as typeof fetch;
  const stateDir = mkdtempSync(join(tmpdir(), "pursestrings-loop-"));
  const config = loadConfig({ env: { PURSESTRINGS_STATE_DIR: stateDir }, cwd: "/", resolveBin: () => undefined });
  const serv = createServClient(config, { mockResponders: { plan: mockPlanResponder, explain: mockExplainResponder } });
  const sim = new SimKpass({ preflight: createMerchantPreflight(fetchFn) });
  const passport = new Passport(options.wrapRunner ? options.wrapRunner(sim) : sim);
  const ledger = new Ledger(join(stateDir, "ledger.jsonl"));
  const events: RunEvent[] = [];
  const run = (confirm = true) => runTask({ config, serv, passport, ledger, fetchFn }, { task: TASK, budgetUsd: "1.00", merchants: [BASE], confirm: async () => confirm, onEvent: (e) => events.push(e), runId: "run_test" });
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
    expect((await ledger.read("run_test")).map((e) => e.kind)).toEqual(["plan", "session", "payment", "payment", "run"]);
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
