import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "../src/ledger.js";
import { listRuns, renderRun, renderRunList } from "../src/ledger-view.js";
import { explorerTxUrl } from "../src/render.js";

const TX = "0xb453c167de285c6652a95c8ad3579e945429d30d8cbd1127b72c002c999aca34";

const entry = (runId: string, at: string, kind: LedgerEntry["kind"], data: Record<string, unknown> = {}): LedgerEntry => ({ runId, at, kind, ...data });

describe("ledger view", () => {
  it("links real Kite testnet transactions to the explorer, never simulated ones", () => {
    expect(explorerTxUrl(2368, TX)).toBe(`https://testnet.kitescan.ai/tx/${TX}`);
    expect(explorerTxUrl(2368, "sim_0123456789abcdef0123456789abcdef")).toBeUndefined();
    expect(explorerTxUrl(8453, TX)).toBeUndefined();
  });

  it("lists runs newest first with their counts", () => {
    const entries = [
      entry("run_a", "2026-11-07T10:00:00.000Z", "plan", { task: "first" }),
      entry("run_a", "2026-11-07T10:00:05.000Z", "run", { stopped: "you declined the spending limits", spentUsd: "0.00" }),
      entry("run_b", "2026-11-07T11:00:00.000Z", "discover", { task: "second", merchants: [{ status: "ok" }, { status: "quarantined" }] }),
      entry("run_b", "2026-11-07T11:00:01.000Z", "plan", { task: "second" }),
      entry("run_b", "2026-11-07T11:00:09.000Z", "payment", {}),
      entry("run_b", "2026-11-07T11:00:10.000Z", "refusal", {}),
      entry("run_b", "2026-11-07T11:00:11.000Z", "run", { finished: true, spentUsd: "0.30" }),
    ];
    expect(listRuns(entries)).toEqual([
      { runId: "run_b", startedAt: "2026-11-07T11:00:00.000Z", task: "second", paid: 1, refused: 1, quarantined: 1, spentUsd: "0.30", status: "finished" },
      { runId: "run_a", startedAt: "2026-11-07T10:00:00.000Z", task: "first", paid: 0, refused: 0, quarantined: 0, spentUsd: "0.00", status: "stopped: you declined the spending limits" },
    ]);
    expect(renderRunList(listRuns(entries))).toContain("run_b  2026-11-07 11:00 UTC  $0.30  1 paid, 1 refused, 1 quarantined");
    expect(renderRunList([])).toMatch(/No runs/);
  });

  it("shows a real payment with its explorer link and the SERV traces", () => {
    const view = renderRun([
      entry("run_c", "2026-11-07T12:00:00.000Z", "plan", { task: "t", budgetUsd: "1.00", steps: [{ shopName: "BrightWave", title: "1 GB", priceUsd: "0.30" }], serv: { mode: "live", model: "claude-sonnet-5-serv-kronos", requestId: "msg_plan" } }),
      entry("run_c", "2026-11-07T12:00:01.000Z", "session", { sessionId: "sess_1", mode: "live", delegation: { payment_policy: { max_amount_per_tx: "0.30", max_total_amount: "0.30", ttl_seconds: 3600 }, execution_constraints: { x402: { allowed_endpoints: [{}] } } } }),
      entry("run_c", "2026-11-07T12:00:09.000Z", "payment", { merchant: "BrightWave", item: "1 GB", priceUsd: "0.30", receipt: { chainId: 2368, network: "eip155:2368", transaction: TX, simulated: false } }),
      entry("run_c", "2026-11-07T12:00:10.000Z", "run", { finished: true, spentUsd: "0.30", paid: 1, refused: 0 }),
    ]);
    expect(view).toContain(`tx ${TX} on eip155:2368`);
    expect(view).toContain(`https://testnet.kitescan.ai/tx/${TX}`);
    expect(view).toContain("$0.30 per payment, $0.30 in total, 60 min, 1 endpoint");
    expect(view).toContain("SERV request ids (console.openserv.ai > Usage > Activity): msg_plan (plan)");
  });
});
