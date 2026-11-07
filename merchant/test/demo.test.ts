import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoApp } from "../src/demo/server.ts";

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function waitFor(app: ReturnType<typeof createDemoApp>["app"], id: string, status: string[]) {
  for (let i = 0; i < 200; i++) {
    const run = (await (await app.request(`/api/runs/${id}`)).json()) as any;
    if (status.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run ${id} never reached ${status}`);
}

describe("hosted demo", () => {
  it("runs the agent in the sandbox, waits for the visitor's approvals, and chains the ledger", async () => {
    const { app } = createDemoApp({ stateDir: mkdtempSync(join(tmpdir(), "ps-demo-")), env: {} });
    const created = await app.request("/api/runs", json({}));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    // First the plan's limits, then the stand-in limit after QuickData is refused.
    let run = await waitFor(app, id, ["waiting"]);
    expect(run.question).toMatch(/0\.28 per call/);
    expect((await app.request(`/api/runs/${id}/answer`, json({ approve: true }))).status).toBe(200);
    run = await waitFor(app, id, ["waiting", "done"]);
    expect(run.question).toMatch(/0\.30/);
    await app.request(`/api/runs/${id}/answer`, json({ approve: true }));
    run = await waitFor(app, id, ["done"]);

    expect(run.summary.quarantined.map((q: any) => `${q.merchant} by the ${q.detectedBy}`)).toEqual(["MegaDeals by the pattern scan", "DataDash by the SERV screen"]);
    expect(run.summary.redTeam).toMatchObject({ status: "refused", code: "session_rule_exceeded" });
    expect(run.summary.outcomes.map((o: any) => `${o.status} ${o.merchant}`)).toEqual(["refused QuickData", "paid BrightWave Data (demo)", "paid RideMate Rides (demo)"]);
    expect(run.messages.filter((m: any) => m.type === "confirm")).toHaveLength(2);

    const ledger = (await (await app.request(`/api/runs/${id}/ledger`)).json()) as any;
    expect(ledger.entries.length).toBeGreaterThan(8);
    expect(ledger.chain).toMatchObject({ ok: true });
    expect((await app.request(`/api/runs/${id}/answer`, json({ approve: true }))).status).toBe(409);
  });

  it("declining the limits stops the run with nothing paid", async () => {
    const { app } = createDemoApp({ stateDir: mkdtempSync(join(tmpdir(), "ps-demo-")), env: {} });
    const { id } = (await (await app.request("/api/runs", json({ redTeam: false }))).json()) as { id: string };
    await waitFor(app, id, ["waiting"]);
    await app.request(`/api/runs/${id}/answer`, json({ approve: false }));
    const run = await waitFor(app, id, ["done"]);
    expect(run.summary).toMatchObject({ stoppedReason: "you declined the spending limits", spentUsd: "0.00" });
  });

  it("limits runs per visitor and serves the page and the recorded live run", async () => {
    const { app } = createDemoApp({ stateDir: mkdtempSync(join(tmpdir(), "ps-demo-")), env: {}, runsPerIpPer10Min: 1 });
    const headers = { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" };
    expect((await app.request("/api/runs", { method: "POST", headers, body: "{}" })).status).toBe(201);
    expect((await app.request("/api/runs", { method: "POST", headers, body: "{}" })).status).toBe(429);
    expect((await app.request("/api/runs/nope")).status).toBe(404);
    const recorded = (await (await app.request("/api/recorded")).json()) as any;
    expect(recorded.entries.find((e: any) => e.kind === "plan").serv).toMatchObject({ mode: "live", model: "claude-sonnet-5-serv-kronos" });
  });
});
