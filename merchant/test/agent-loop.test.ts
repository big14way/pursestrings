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
import { mockScreenResponder } from "../../src/screen.ts";
import { SIM_PAYER } from "../../src/kpass/merchant-preflight.ts";
import { createServClient } from "../../src/serv/client.ts";
import { createSimulatedFacilitator } from "../src/facilitator.ts";
import { BURN_ADDRESS } from "../src/megadeals.ts";
import { createMerchant, loadMerchantConfig } from "../src/server.ts";

const BASE = "https://shops.test";
const MEGA = "https://megadeals.test";
const DASH = "https://datadash.test";
const QUICK = "https://quickdata.test";
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
  const fixture = (profile: string, url: string) => createMerchant(loadMerchantConfig({ MERCHANT_PROFILE: profile, PAY_TO: HONEST_PAY_TO, LOG_ENABLED: "false", PUBLIC_URL: url, MERCHANT_FACILITATOR: "simulated" }), { facilitator });
  const datadash = fixture("datadash", DASH);
  const quickdata = fixture("quickdata", QUICK);
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const mega = url.startsWith(MEGA);
    const app = mega ? megadeals : url.startsWith(DASH) ? datadash : url.startsWith(QUICK) ? quickdata : merchant;
    const response = await app.request(url, init);
    const rewrite = mega ? options.rewriteMegaCatalog : options.rewriteCatalog;
    if (rewrite && url.endsWith("/catalog")) return Response.json(rewrite(await response.json()));
    return response;
  }) as typeof fetch;
  const stateDir = mkdtempSync(join(tmpdir(), "pursestrings-loop-"));
  const config = loadConfig({ env: { PURSESTRINGS_STATE_DIR: stateDir }, cwd: "/", resolveBin: () => undefined });
  const serv = createServClient(config, { mockResponders: { plan: mockPlanResponder, explain: mockExplainResponder, screen: mockScreenResponder } });
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
    expect((await ledger.read("run_test")).map((e) => e.kind)).toEqual(["identity", "discover", "plan", "session", "payment", "payment", "run"]);
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
    expect(entries.map((e) => e.kind)).toEqual(["identity", "discover", "plan", "session", "redteam", "payment", "payment", "run"]);
    const view = renderRun(entries);
    expect(view).toContain("⚠ MegaDeals (megadeals.test): quarantined by the pattern scan");
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
    // The same bundle from BrightWave stands in, under its own approved limit.
    expect(summary.outcomes.map((o) => `${o.status} ${o.merchant}`)).toEqual(["refused MegaDeals Data", "paid BrightWave Data (demo)", "paid RideMate Rides (demo)"]);
    expect(facilitator.settlements.map((s) => s.payTo)).toEqual([HONEST_PAY_TO, HONEST_PAY_TO]);
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

describe("the subtler attacks", () => {
  it("DataDash passes the pattern scan, but the SERV screen reads the steering and quarantines it", async () => {
    const { run, events } = world({ merchants: [BASE, DASH] });
    const summary = await run();
    expect(summary.quarantined).toHaveLength(1);
    expect(summary.quarantined[0]).toMatchObject({ merchant: "DataDash", detectedBy: "SERV screen" });
    expect(summary.quarantined[0]?.findings[0]).toMatchObject({ kind: "steering", excerpt: expect.stringMatching(/automated buyers/) });
    expect(summary.plan?.steps.map((s) => s.product.shopId)).toEqual(["brightwave", "ridemate"]);
    const screened = events.filter((e) => e.type === "catalog");
    expect(screened).toEqual([expect.objectContaining({ merchant: "PurseStrings demo merchants", screen: expect.objectContaining({ verdict: "clean" }) })]);
  });

  it("QuickData's payee swap is within the Passport caps; PurseStrings refuses it and buys the same bundle elsewhere", async () => {
    const { run, facilitator, ledger, events } = world({ merchants: [BASE, QUICK] });
    const summary = await run();
    expect(summary.quarantined).toEqual([]);
    expect(summary.plan?.steps.map((s) => s.product.shopId)).toEqual(["quickdata", "ridemate"]);
    const [refused, replaced, ride] = summary.outcomes;
    expect(refused).toMatchObject({ status: "refused", refusedBy: "PurseStrings", code: "payee_changed", merchant: "QuickData" });
    expect(refused?.explanation).toMatch(new RegExp(`paid at ${BURN_ADDRESS}`));
    expect(refused?.explanation).toMatch(/Passport limits alone would have allowed this payment/);
    expect(refused?.note).toBe("Your Passport limits alone would have allowed this payment ($0.28 is within the $0.28 cap): they cap amounts, not who is paid.");
    expect(replaced).toMatchObject({ status: "paid", merchant: "BrightWave Data (demo)", priceUsd: "0.30" });
    expect(ride).toMatchObject({ status: "paid", merchant: "RideMate Rides (demo)" });
    expect(events.find((e) => e.type === "fallback")).toMatchObject({ refused: expect.objectContaining({ product: expect.objectContaining({ shopId: "quickdata" }) }), alternative: expect.objectContaining({ product: expect.objectContaining({ shopId: "brightwave" }) }) });
    // Two sessions: the plan's, then a separate $0.30 limit for the stand-in.
    const sessions = (await ledger.read("run_test")).filter((e) => e.kind === "session");
    expect(sessions.map((e) => (e.delegation as any).payment_policy.max_total_amount)).toEqual(["0.30", "0.30"]);
    expect(summary.spentUsd).toBe("0.32");
    expect(facilitator.settlements.map((s) => s.payTo)).toEqual([HONEST_PAY_TO, HONEST_PAY_TO]);
  });

  it("asks before the stand-in: declining leaves the item unbought and opens no second session", async () => {
    const { run, ledger } = world({ merchants: [BASE, QUICK] });
    let asked = 0;
    const summary = await run(true, { confirm: async () => ++asked === 1 });
    expect(asked).toBe(2);
    expect(summary.outcomes.map((o) => o.status)).toEqual(["refused", "paid"]);
    const entries = await ledger.read("run_test");
    expect(entries.filter((e) => e.kind === "session")).toHaveLength(1);
    expect(entries.find((e) => e.kind === "fallback")).toMatchObject({ approved: false });
  });
});

describe("identity, receipts, booking, fee and the ledger chain", () => {
  it("names the Passport agent, records the payer from each receipt, and accrues the fee", async () => {
    const { run, ledger, events } = world();
    const summary = await run();
    expect(events[0]).toEqual({ type: "identity", identity: expect.objectContaining({ agentId: "agent_sim_pursestrings", agentType: "pursestrings", userId: "user_sim", mode: "sim" }) });
    expect(summary.outcomes.map((o) => o.receipt?.paidBy)).toEqual([SIM_PAYER, SIM_PAYER]);
    expect(summary.feeUsd).toBe("0.0016");
    const entries = await ledger.read("run_test");
    expect(entries.filter((e) => e.kind === "payment").map((e) => e.agentId)).toEqual(["agent_sim_pursestrings", "agent_sim_pursestrings"]);
    expect(entries.find((e) => e.kind === "run")).toMatchObject({ feeUsd: "0.0016" });
    const view = renderRun(entries);
    expect(view).toContain("Agent agent_sim_pursestrings (pursestrings), owned by user_sim");
    expect(view).toContain(`paid by ${SIM_PAYER}`);
    expect(view).toContain("fee at 0.5%: $0.0016");
  });

  it("books a ride when the task asks for a booking", async () => {
    const { run } = world();
    const summary = await run(true, { task: "Book a ride for +2348012345678 from Yaba to Victoria Island" });
    expect(summary.plan?.steps.map((s) => `${s.product.shopId}/${s.product.productId}`)).toEqual(["ridemate/book"]);
    expect(summary.outcomes[0]).toMatchObject({ status: "paid", priceUsd: "0.05", response: expect.objectContaining({ status: "confirmed", pickup: "Yaba", dropoff: "Victoria Island" }) });
  });

  it("chains every entry, so an edit, a deletion or a reorder is caught", async () => {
    const { run, ledger } = world({ merchants: [BASE, QUICK] });
    await run();
    expect(await ledger.verify()).toMatchObject({ ok: true, unchained: 0 });
    const { readFileSync, writeFileSync } = await import("node:fs");
    const original = readFileSync(ledger.path, "utf8").trimEnd().split("\n");
    const check = async (lines: string[]) => {
      writeFileSync(ledger.path, `${lines.join("\n")}\n`);
      return ledger.verify();
    };
    const edited = [...original];
    edited[3] = edited[3]!.replace('"0.30"', '"0.01"');
    expect(await check(edited)).toMatchObject({ ok: false, brokenAt: 4, reason: expect.stringMatching(/edited/) });
    expect(await check(original.filter((_, i) => i !== 2))).toMatchObject({ ok: false, brokenAt: 3, reason: expect.stringMatching(/removed, reordered or inserted/) });
    expect(await check([original[1]!, original[0]!, ...original.slice(2)])).toMatchObject({ ok: false, brokenAt: 1 });
    expect(await check(original)).toMatchObject({ ok: true });
  });
});
