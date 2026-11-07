import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { SHOPS } from "../src/catalog.ts";
import { createSimulatedFacilitator } from "../src/facilitator.ts";
import { createMerchant, loadMerchantConfig, type MerchantConfig } from "../src/server.ts";
import { rideQuote } from "../src/shop.ts";

const PAY_TO = "0x706F739AE390375A1Df4046879a47DC2D46389cc";
const PAYER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const PIEUSD = "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A";
const BASE = "https://shops.test";

function setup(env: Record<string, string> = {}) {
  const config: MerchantConfig = loadMerchantConfig({ PAY_TO, LOG_ENABLED: "false", PUBLIC_URL: BASE, MERCHANT_FACILITATOR: "simulated", ...env });
  const facilitator = createSimulatedFacilitator("eip155:2368");
  const app = createMerchant(config, { facilitator });
  return { app, facilitator };
}

async function challenge(app: ReturnType<typeof createMerchant>, path: string, method: string): Promise<PaymentRequired> {
  const response = await app.request(`${BASE}${path}`, { method });
  expect(response.status).toBe(402);
  return JSON.parse(Buffer.from(response.headers.get("payment-required")!, "base64").toString()) as PaymentRequired;
}

/** A structurally valid payment for the simulated facilitator. Not a real signature. */
function pay(required: PaymentRequired): string {
  const accepted = required.accepts[0]!;
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted,
    payload: { signature: "0xfixture", authorization: { from: PAYER, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: `0x${"11".repeat(32)}` } },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("loadMerchantConfig", () => {
  it("defaults to the Kite testnet and the Pieverse facilitator", () => {
    const config = loadMerchantConfig({ PAY_TO });
    expect(config).toMatchObject({ network: "testnet", facilitatorMode: "pieverse", facilitatorUrl: "https://facilitator.pieverse.io/v2", port: 8402 });
  });

  it("requires a real receiving address", () => {
    expect(() => loadMerchantConfig({})).toThrow(/PAY_TO/);
    expect(() => loadMerchantConfig({ PAY_TO: `0x${"0".repeat(40)}` })).toThrow(/PAY_TO/);
  });

  it("refuses the simulated facilitator on a hosted deployment", () => {
    expect(() => loadMerchantConfig({ PAY_TO, MERCHANT_FACILITATOR: "simulated", RENDER: "true" })).toThrow(/local runs only/);
  });

  it("uses Render's external URL for the catalog", () => {
    expect(loadMerchantConfig({ PAY_TO, RENDER_EXTERNAL_URL: "https://m.onrender.com/" }).publicUrl).toBe("https://m.onrender.com");
  });
});

describe("x402 challenges", () => {
  const { app } = setup();
  const products = SHOPS.flatMap((shop) => shop.skus.map((sku) => ({ shop, sku })));

  it.each(products.map((p) => [`${p.shop.id}/${p.sku.id}`, p] as const))("%s asks for its price in pieUSD on Kite testnet", async (_name, { shop, sku }) => {
    const required = await challenge(app, `/v1/${shop.id}/${sku.id}`, sku.method);
    expect(required.x402Version).toBe(2);
    const [whole = "0", frac = ""] = sku.priceUsd.split(".");
    const atomic = (BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0"))).toString();
    expect(required.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:2368", asset: PIEUSD, amount: atomic, payTo: PAY_TO, extra: { name: "pieUSD", version: "1" } });
    expect(required.resource.url).toBe(`${BASE}/v1/${shop.id}/${sku.id}`);
    expect(required.resource.description).toBe(`${shop.name}: ${sku.title}`);
  });

  it("charges nothing for unknown products or the wrong method", async () => {
    expect((await app.request(`${BASE}/v1/brightwave/data-99gb`, { method: "POST" })).status).toBe(404);
    expect((await app.request(`${BASE}/v1/brightwave/data-1gb`, { method: "GET" })).status).toBe(405);
  });
});

describe("paid purchases", () => {
  it("delivers the order after the payment verifies and settles", async () => {
    const { app, facilitator } = setup();
    const required = await challenge(app, "/v1/brightwave/data-1gb", "POST");
    const response = await app.request(`${BASE}/v1/brightwave/data-1gb`, {
      method: "POST",
      headers: { "payment-signature": pay(required), "content-type": "application/json" },
      body: JSON.stringify({ phone: "+2348012345678" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeTruthy();
    expect(response.headers.get("x-pursestrings-simulated")).toBe("1");
    const order = (await response.json()) as Record<string, unknown>;
    expect(order).toMatchObject({ shop: "brightwave", sku: "data-1gb", status: "fulfilled", priceUsd: "0.30", phone: "+234****678" });
    expect(String(order.orderId)).toMatch(/^ord_/);
    expect(facilitator.settlements).toHaveLength(1);
    expect(facilitator.settlements[0]).toMatch(/^sim_/);
  });

  it("serves a paid ride quote over GET", async () => {
    const { app } = setup();
    const path = "/v1/ridemate/quote?from=Yaba&to=Victoria%20Island";
    const required = await challenge(app, path, "GET");
    const response = await app.request(`${BASE}${path}`, { headers: { "payment-signature": pay(required) } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { quote: unknown }).quote).toEqual(rideQuote("Yaba", "Victoria Island"));
  });

  it("does not settle when the order is invalid", async () => {
    const { app, facilitator } = setup();
    const required = await challenge(app, "/v1/topup/airtime-1000", "POST");
    const response = await app.request(`${BASE}/v1/topup/airtime-1000`, {
      method: "POST",
      headers: { "payment-signature": pay(required), "content-type": "application/json" },
      body: JSON.stringify({ phone: "12345" }),
    });
    expect(response.status).toBe(400);
    expect(facilitator.settlements).toEqual([]);
  });

  it("rejects a payment made for a cheaper product", async () => {
    const { app, facilitator } = setup();
    const cheap = await challenge(app, "/v1/brightwave/data-1gb", "POST");
    const response = await app.request(`${BASE}/v1/brightwave/data-5gb`, {
      method: "POST",
      headers: { "payment-signature": pay(cheap), "content-type": "application/json" },
      body: JSON.stringify({ phone: "+2348012345678" }),
    });
    expect(response.status).toBe(402);
    expect(facilitator.settlements).toEqual([]);
  });
});

describe("discovery", () => {
  it("lists every shop and product with absolute paid URLs", async () => {
    const { app } = setup();
    const catalog = (await (await app.request(`${BASE}/catalog`)).json()) as { network: string; shops: Array<{ id: string; products: Array<{ url: string; priceUsd: string }> }> };
    expect(catalog.network).toBe("eip155:2368");
    expect(catalog.shops.map((s) => s.id)).toEqual(["brightwave", "swiftbyte", "ridemate", "topup"]);
    expect(catalog.shops[0]?.products[0]).toMatchObject({ url: `${BASE}/v1/brightwave/data-1gb`, priceUsd: "0.30" });
    const wellKnown = (await (await app.request(`${BASE}/.well-known/x402`)).json()) as { resources: unknown[] };
    expect(wellKnown.resources).toHaveLength(6);
  });

  it("reports readiness from the facilitator's supported networks", async () => {
    const { app } = setup();
    expect((await app.request(`${BASE}/readyz`)).status).toBe(200);
    expect(await (await app.request(`${BASE}/healthz`)).json()).toMatchObject({ ok: true, network: "eip155:2368", products: 6, facilitator: "simulated" });
  });
});
