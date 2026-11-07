import { describe, expect, it } from "vitest";
import { formatUnits, readChallenge, sameAmount } from "../src/x402.js";

const PIEUSD = "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A";

describe("amounts", () => {
  it("formats atomic amounts", () => {
    expect(formatUnits("300000000000000000", 18)).toBe("0.3");
    expect(formatUnits("1000", 6)).toBe("0.001");
    expect(formatUnits("5000000", 6)).toBe("5");
    expect(() => formatUnits("1.5", 6)).toThrow();
  });

  it("compares decimals exactly", () => {
    expect(sameAmount("0.30", "0.3")).toBe(true);
    expect(sameAmount("$1.10", "1.1")).toBe(true);
    expect(sameAmount("0.35", "0.3")).toBe(false);
  });
});

describe("readChallenge", () => {
  it("reads the x402 v2 PAYMENT-REQUIRED header", async () => {
    const required = { x402Version: 2, resource: { url: "https://m.test/v1/a/b", description: "A: B" }, accepts: [{ scheme: "exact", network: "eip155:2368", asset: PIEUSD, amount: "300000000000000000", payTo: "0x706F739AE390375A1Df4046879a47DC2D46389cc" }] };
    const response = new Response('{"error":"Payment required"}', { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(required)).toString("base64") } });
    expect(await readChallenge(response)).toMatchObject({ x402Version: 2, network: "eip155:2368", priceUsd: "0.3", resourceUrl: "https://m.test/v1/a/b", description: "A: B" });
  });

  it("reads Kite's body format", async () => {
    const body = { error: "payment required", payment: { x402Version: 2, accepts: [{ x402Version: 2, scheme: "exact", network: "eip155:2368", asset: PIEUSD, amount: "100000000000000000", payTo: "0x677A3C93e717ccaA73f19de98c1d715A1768c56e" }], resource: { url: "http://passport.dev.gokite.ai/x402/test" } } };
    expect(await readChallenge(Response.json(body, { status: 402 }))).toMatchObject({ priceUsd: "0.1", resourceUrl: "http://passport.dev.gokite.ai/x402/test" });
  });

  it("leaves the price unknown for an unknown token", async () => {
    const body = { accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1000", payTo: "0x1" }] };
    expect((await readChallenge(Response.json(body, { status: 402 })))?.priceUsd).toBeUndefined();
  });

  it("ignores anything that is not a 402 challenge", async () => {
    expect(await readChallenge(Response.json({ ok: true }))).toBeUndefined();
    expect(await readChallenge(new Response("nope", { status: 402 }))).toBeUndefined();
  });
});
