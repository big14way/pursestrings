import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeError, KpassError } from "../src/kpass/errors.js";
import { expectOk, Passport } from "../src/kpass/passport.js";
import { commandWords, createLiveRunner, extractJsonObjects, parseEnvelope, redact, redactArgs, Transcript, type ExecFn } from "../src/kpass/runner.js";
import { SimKpass, type Preflight } from "../src/kpass/sim.js";
import type { Delegation } from "../src/kpass/types.js";
import { tempDir } from "./helpers.js";

describe("parseEnvelope", () => {
  it("parses a JSON reply", () => {
    expect(parseEnvelope('{"status":"success","hint":"ok"}', 0)).toEqual({ status: "success", hint: "ok" });
  });

  it("skips log lines printed before the JSON", () => {
    expect(parseEnvelope('Fetching...\nDone\n{\n  "status": "error",\n  "error_code": "wallet_empty"\n}', 6)).toMatchObject({ error_code: "wallet_empty" });
  });

  it("wraps plain text such as --version", () => {
    expect(parseEnvelope("kpass 1.4.2\n", 0)).toEqual({ status: "success", text: "kpass 1.4.2" });
    expect(parseEnvelope("boom", 1)).toMatchObject({ status: "error", error_code: "unparseable_output" });
  });

  it("fills a missing status from the exit code", () => {
    expect(parseEnvelope('{"sessions":[]}', 0).status).toBe("success");
  });

  it("takes the first envelope when kpass 6.x prints two on an error", () => {
    const stdout = '{\n  "_version": "1",\n  "error": "Not logged in. Run \'kpass login init --email \\u003cEMAIL\\u003e\'",\n  "hint": "Run login",\n  "status": "error"\n}\n{\n  "_version": "1",\n  "error": "Not logged in.",\n  "hint": "",\n  "status": "error"\n}\n';
    expect(parseEnvelope(stdout, 3)).toMatchObject({ status: "error", hint: "Run login", error: expect.stringContaining("<EMAIL>") });
  });
});

describe("extractJsonObjects and commandWords", () => {
  it("ignores braces inside strings", () => {
    expect(extractJsonObjects('log {"a":"}{","b":{"c":1}} tail {"d":2}')).toEqual(['{"a":"}{","b":{"c":1}}', '{"d":2}']);
  });

  it("finds the command words around global flags", () => {
    expect(commandWords(["--output", "json", "--no-interactive", "session", "execute", "--url", "https://x"])).toEqual(["session", "execute"]);
    expect(commandWords(["sandbox", "status"])).toEqual(["sandbox", "status"]);
  });
});

describe("redaction", () => {
  it("hides OTP codes and tokens", () => {
    expect(redactArgs(["login", "verify", "--login-id", "l1", "--code", "ABCD1234"])).toEqual(["login", "verify", "--login-id", "l1", "--code", "[redacted]"]);
    expect(redact({ agent_id: "a", token: "agt_secret", nested: [{ exchange_token: "x" }] })).toEqual({ agent_id: "a", token: "[redacted]", nested: [{ exchange_token: "[redacted]" }] });
  });
});

describe("live runner", () => {
  it("runs kpass without a shell, asks for JSON and records a transcript", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_bin, args) => {
      calls.push(args);
      return { stdout: '{"status":"success","token":"agt_123"}', stderr: "", exitCode: 0 };
    };
    const path = join(tempDir(), "t.jsonl");
    const runner = createLiveRunner({ bin: "/bin/kpass", timeoutMs: 1000, exec, transcript: new Transcript(path) });
    const result = await runner.run(["agent:register", "--type", "claude"]);
    expect(calls[0]).toEqual(["--output", "json", "--no-interactive", "agent:register", "--type", "claude"]);
    expect(result.envelope.status).toBe("success");
    const logged = JSON.parse(readFileSync(path, "utf8").trim()) as { envelope: { token: string } };
    expect(logged.envelope.token).toBe("[redacted]");
  });

  it("points every JSON call at the configured backend", async () => {
    const calls: string[][] = [];
    const runner = createLiveRunner({ bin: "kpass", baseURL: "https://passport.dev.gokite.ai", timeoutMs: 1000, exec: async (_b, args) => (calls.push(args), { stdout: '{"status":"success"}', stderr: "", exitCode: 0 }) });
    await runner.run(["wallet", "balance"]);
    expect(calls[0]).toEqual(["--output", "json", "--no-interactive", "--base-url", "https://passport.dev.gokite.ai", "wallet", "balance"]);
    expect(commandWords(calls[0] ?? [])).toEqual(["wallet", "balance"]);
  });

  it("does not add JSON flags to --version", async () => {
    const calls: string[][] = [];
    const runner = createLiveRunner({ bin: "kpass", timeoutMs: 1000, exec: async (_b, args) => (calls.push(args), { stdout: "kpass 1.0", stderr: "", exitCode: 0 }) });
    await runner.run(["--version"]);
    expect(calls[0]).toEqual(["--version"]);
  });
});

describe("errors", () => {
  it("classifies session policy refusals", () => {
    const error = new KpassError({ status: "error", error_code: "session_rule_exceeded", error: "too much" }, 6, "session execute");
    expect(error.isPolicyRefusal).toBe(true);
    expect(error.info.title).toMatch(/per-transaction/);
    expect(describeError("brand_new_code").kind).toBe("unknown");
  });

  it("treats a non-zero exit as failure even with a success status", () => {
    expect(() => expectOk({ args: ["status"], exitCode: 2, envelope: { status: "success" }, stdout: "", stderr: "", durationMs: 0, mode: "live" })).toThrow(KpassError);
  });
});

const delegation: Delegation = {
  task: { summary: "Buy the cheapest data bundle under 5 USD." },
  payment_policy: { max_amount_per_tx: "5", max_total_amount: "6", ttl_seconds: 3600 },
  execution_constraints: { x402: { scope_mode: "scoped", allowed_endpoints: [{ method: "GET", host: "shop.test", path_prefix: "/v1/" }] } },
};

const prices: Record<string, string> = { "/v1/bundle": "3", "/v1/premium": "6", "/v1/airtime": "4" };
const preflight: Preflight = async ({ url }) => {
  const price = prices[new URL(url).pathname];
  return price ? { status: 402, price, asset: "USDC", network: "eip155:2368", paidBody: { ok: true } } : { status: 200 };
};

async function approvedSession(sim = new SimKpass({ preflight })) {
  const passport = new Passport(sim);
  const request = await passport.requestSession(delegation);
  const outcome = await passport.waitForApproval(request.request_id);
  if (outcome.state !== "approved") throw new Error("expected approval");
  return { passport, sim, sessionId: outcome.approved.session_id };
}

describe("simulator", () => {
  it("mirrors the allowance-first create flow", async () => {
    const passport = new Passport(new SimKpass({ preflight }));
    await expect(passport.call(["session", "create", "--delegation", JSON.stringify(delegation)])).rejects.toMatchObject({ code: "allowance_unavailable" });
    const preview = await passport.previewSession(delegation);
    expect(preview.preview).toBe(true);
    expect(preview.user_message).toMatch(/USD 5 per call and USD 6 in total/);
    const request = await passport.requestSession(delegation);
    expect(request).toMatchObject({ status: "human_action_required", request_id: expect.stringMatching(/^req_/) });
  });

  it("stays pending until the passkey approval when auto-approve is off", async () => {
    const sim = new SimKpass({ preflight, autoApprove: false });
    const passport = new Passport(sim);
    const request = await passport.requestSession(delegation);
    expect((await passport.waitForApproval(request.request_id)).state).toBe("pending");
    sim.approve(request.request_id);
    expect((await passport.waitForApproval(request.request_id)).state).toBe("approved");
  });

  it("settles under the caps and reports the merchant's chain", async () => {
    const { passport } = await approvedSession();
    const paid = await passport.execute({ url: "https://shop.test/v1/bundle", method: "GET", idempotencyKey: "k1" });
    expect(paid.x402).toMatchObject({ status_code: 200, chain_id: 2368, simulated: true });
    expect(paid.usage?.spent_total).toBe("3.00");
    expect(paid.x402.parsed_response_body).toEqual({ ok: true });
  });

  it("does not charge twice for the same idempotency key", async () => {
    const { passport } = await approvedSession();
    await passport.execute({ url: "https://shop.test/v1/bundle", method: "GET", idempotencyKey: "same" });
    const again = await passport.execute({ url: "https://shop.test/v1/bundle", method: "GET", idempotencyKey: "same" });
    expect(again.usage?.spent_total).toBe("3.00");
  });

  it("refuses over the per-transaction cap, over budget and outside scope", async () => {
    const { passport } = await approvedSession();
    await expect(passport.execute({ url: "https://shop.test/v1/premium", method: "GET" })).rejects.toMatchObject({ code: "session_rule_exceeded", isPolicyRefusal: true });
    await passport.execute({ url: "https://shop.test/v1/bundle", method: "GET" });
    await expect(passport.execute({ url: "https://shop.test/v1/airtime", method: "GET" })).rejects.toMatchObject({ code: "session_total_exceeded" });
    await expect(passport.execute({ url: "https://evil.test/v1/bundle", method: "GET" })).rejects.toMatchObject({ code: "session_endpoint_forbidden" });
    await expect(passport.execute({ url: "https://shop.test/v1/bundle", method: "POST" })).rejects.toMatchObject({ code: "session_endpoint_forbidden" });
  });

  it("refuses to pay without an approved session", async () => {
    const passport = new Passport(new SimKpass({ preflight }));
    await expect(passport.execute({ url: "https://shop.test/v1/bundle", method: "GET" })).rejects.toMatchObject({ code: "allowance_unavailable" });
  });

  it("rejects malformed delegations", async () => {
    const passport = new Passport(new SimKpass({ preflight }));
    const bad = { ...delegation, payment_policy: { ...delegation.payment_policy, max_amount_per_tx: "five" } };
    await expect(passport.requestSession(bad)).rejects.toMatchObject({ code: "invalid_delegation" });
  });
});
