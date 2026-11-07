import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findNetworks, formatReport, runDoctor, satisfiesNode } from "../src/doctor.js";
import { Passport } from "../src/kpass/passport.js";
import { createLiveRunner } from "../src/kpass/runner.js";
import { SimKpass } from "../src/kpass/sim.js";
import { createServClient } from "../src/serv/client.js";
import { testConfig } from "./helpers.js";

describe("findNetworks", () => {
  it("collects chain ids and CAIP-2 networks from nested replies", () => {
    const found = findNetworks({ balances: [{ network: "eip155:5042002" }, { chain_id: 2368 }], x402: { chain_id: "8453" } });
    expect([...found].sort()).toEqual(["eip155:2368", "eip155:5042002", "eip155:8453"]);
  });
});

describe("satisfiesNode", () => {
  it("needs Node 20.12 or later", () => {
    expect(satisfiesNode("v20.12.0")).toBe(true);
    expect(satisfiesNode("v20.11.1")).toBe(false);
    expect(satisfiesNode("v26.8.1")).toBe(true);
    expect(satisfiesNode("v18.20.0")).toBe(false);
  });
});

describe("runDoctor", () => {
  it("passes in zero-credential mode with warnings only", async () => {
    const config = testConfig();
    const report = await runDoctor({ config, serv: createServClient(config), passport: new Passport(new SimKpass()), nodeVersion: "v22.0.0" }, { offline: true });
    const states = Object.fromEntries(report.checks.map((c) => [c.id, c.state]));
    expect(states).toMatchObject({ node: "ok", "serv-mode": "warn", "serv-ping": "ok", "kpass-bin": "warn", "kpass-me": "warn", settlement: "warn", "kite-rpc": "skip" });
    expect(report.checks.some((c) => c.state === "fail")).toBe(false);
    expect(report.readyForLivePayments).toBe(false);
    expect(existsSync(join(config.stateDir, "doctor.json"))).toBe(true);
    expect(formatReport(report)).toMatch(/Ready for live payments: no/);
  });

  it("verifies the Kite testnet chain id and facilitator support", async () => {
    const config = testConfig();
    const fakeFetch = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("rpc-testnet")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x940" }));
      return new Response(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:2368" }] }));
    }) as typeof fetch;
    const report = await runDoctor({ config, serv: createServClient(config), passport: new Passport(new SimKpass()), fetch: fakeFetch });
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    expect(byId.get("kite-rpc")).toMatchObject({ state: "ok", detail: expect.stringContaining("2368") });
    expect(byId.get("facilitator")).toMatchObject({ state: "ok", detail: expect.stringContaining("exact") });
  });

  it("reports the chain that live paid calls settled on", async () => {
    const config = testConfig({}, "/bin/kpass");
    mkdirSync(config.stateDir, { recursive: true });
    const paid = { at: "2026-11-07T00:00:00Z", mode: "live", args: ["--output", "json", "--no-interactive", "session", "execute", "--url", "https://shop.test/v1/bundle"], exitCode: 0, envelope: { status: "success", x402: { status_code: 200, chain_id: 2368 } } };
    writeFileSync(join(config.stateDir, "kpass-transcript.jsonl"), `${JSON.stringify(paid)}\n`);
    const runner = createLiveRunner({ bin: "/bin/kpass", timeoutMs: 1000, exec: async () => ({ stdout: '{"status":"success","email":"me@test"}', stderr: "", exitCode: 0 }) });
    const report = await runDoctor({ config, serv: createServClient(config), passport: new Passport(runner) }, { offline: true });
    expect(report.settlementNetworks).toEqual(["eip155:2368"]);
    expect(report.checks.find((c) => c.id === "settlement")).toMatchObject({ state: "ok" });
  });

  it("fails the SERV check when the key is rejected", async () => {
    const config = testConfig({ SERV_API_KEY: "bad" });
    const serv = createServClient(config, {
      create: async () => {
        throw Object.assign(new Error("Missing or invalid API key"), { status: 401 });
      },
    });
    const report = await runDoctor({ config, serv, passport: new Passport(new SimKpass()) }, { offline: true });
    expect(report.checks.find((c) => c.id === "serv-ping")).toMatchObject({ state: "fail", detail: expect.stringContaining("HTTP 401") });
  });
});
