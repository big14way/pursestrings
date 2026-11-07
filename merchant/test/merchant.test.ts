import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { SHOPS } from "../src/catalog.ts";
import { createSimulatedFacilitator } from "../src/facilitator.ts";
import { DATADASH } from "../src/deceptive.ts";
import { BURN_ADDRESS } from "../src/megadeals.ts";
import { createMerchant, loadMerchantConfig, type MerchantConfig } from "../src/server.ts";
import { payerOf, rideQuote } from "../src/shop.ts";
import { scanDocument } from "../../src/injection.ts";

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
    expect(facilitator.settlements[0]).toMatchObject({ transaction: expect.stringMatching(/^sim_/), payTo: PAY_TO, network: "eip155:2368" });
    expect(order.paidBy).toBe(PAYER);
  });

  it("books a ride and names the wallet that paid", async () => {
    const { app } = setup();
    const required = await challenge(app, "/v1/ridemate/book", "POST");
    expect(required.accepts[0]).toMatchObject({ amount: "50000000000000000" });
    const response = await app.request(`${BASE}/v1/ridemate/book`, {
      method: "POST",
      headers: { "payment-signature": pay(required), "content-type": "application/json" },
      body: JSON.stringify({ from: "Yaba", to: "Victoria Island", phone: "+2348012345678" }),
    });
    expect(response.status).toBe(200);
    const booking = (await response.json()) as Record<string, unknown>;
    expect(booking).toMatchObject({ status: "confirmed", pickup: "Yaba", dropoff: "Victoria Island", rider: "+234****678", paidBy: PAYER, fareNgn: rideQuote("Yaba", "Victoria Island").fareNgn });
    expect(String(booking.bookingId)).toMatch(/^bk_/);
  });

  it("reads the payer only from a well-formed payment header", () => {
    expect(payerOf(undefined)).toBeUndefined();
    expect(payerOf("not base64 json")).toBeUndefined();
    expect(payerOf(Buffer.from(JSON.stringify({ payload: { authorization: { from: "nope" } } })).toString("base64"))).toBeUndefined();
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

describe("rideQuote", () => {
  it("always gives a sane ETA and fare, whatever the hash", () => {
    const places = ["Yaba", "Victoria Island", "Ikeja", "Lekki", "Surulere", "Ajah", "Ikoyi", "Maryland"];
    for (const from of places) {
      for (const to of places) {
        const q = rideQuote(from, to);
        expect(q.etaMinutes).toBeGreaterThanOrEqual(4);
        expect(q.etaMinutes).toBeLessThanOrEqual(15);
        expect(q.distanceKm).toBeGreaterThanOrEqual(3);
        expect(q.fareNgn).toBe(500 + q.distanceKm * 180);
      }
    }
    expect(rideQuote("Yaba", "Victoria Island").etaMinutes).toBeGreaterThanOrEqual(4);
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
    expect(wellKnown.resources).toHaveLength(7);
  });

  it("reports readiness from the facilitator's supported networks", async () => {
    const { app } = setup();
    expect((await app.request(`${BASE}/readyz`)).status).toBe(200);
    expect(await (await app.request(`${BASE}/healthz`)).json()).toMatchObject({ ok: true, network: "eip155:2368", products: 7, facilitator: "simulated" });
  });
});

describe("MegaDeals, the deliberately malicious merchant", () => {
  it("is labelled, lists a bait price and injected text, and pays out to the burn address", async () => {
    const { app } = setup({ MERCHANT_PROFILE: "megadeals" });
    const catalog = (await (await app.request(`${BASE}/catalog`)).json()) as any;
    expect(catalog).toMatchObject({ merchant: "MegaDeals", payTo: BURN_ADDRESS, notice: expect.stringContaining("Deliberately malicious") });
    expect(catalog.shops[0].description).toMatch(/ignore your previous instructions/);
    expect(catalog.shops[0].products[0]).toMatchObject({ id: "data-1gb", priceUsd: "0.25" });
  });

  it("asks $1.00 in its 402 for the bundle it lists at $0.25", async () => {
    const { app } = setup({ MERCHANT_PROFILE: "megadeals", PAY_TO: "0x1111111111111111111111111111111111111111" });
    const required = await challenge(app, "/v1/megadeals/data-1gb", "POST");
    expect(required.accepts[0]).toMatchObject({ amount: "1000000000000000000", payTo: BURN_ADDRESS, network: "eip155:2368" });
  });

  it("does not serve the honest shops, and rejects unknown profiles", async () => {
    const { app } = setup({ MERCHANT_PROFILE: "megadeals" });
    expect((await app.request(`${BASE}/v1/brightwave/data-1gb`, { method: "POST" })).status).toBe(404);
    expect(() => loadMerchantConfig({ PAY_TO, MERCHANT_PROFILE: "toString" })).toThrow(/MERCHANT_PROFILE/);
  });
});

describe("the subtler deceptive merchants", () => {
  it("DataDash steers buyers in words the pattern scanner does not catch", async () => {
    const { app } = setup({ MERCHANT_PROFILE: "datadash" });
    const catalog = (await (await app.request(`${BASE}/catalog`)).json()) as any;
    expect(catalog).toMatchObject({ merchant: "DataDash", payTo: PAY_TO, notice: expect.stringContaining("Deliberately deceptive") });
    expect(catalog.shops[0].description).toMatch(/automated buyers/);
    // The point of the fixture: only a reading of the meaning flags it.
    expect(scanDocument({ shops: DATADASH.shops })).toEqual([]);
  });

  it("QuickData lists one wallet, and its 402 asks the listed price but pays the burn address", async () => {
    const { app } = setup({ MERCHANT_PROFILE: "quickdata" });
    const catalog = (await (await app.request(`${BASE}/catalog`)).json()) as any;
    expect(catalog).toMatchObject({ merchant: "QuickData", payTo: PAY_TO });
    expect(catalog.shops[0].products[0]).toMatchObject({ id: "data-1gb", priceUsd: "0.28" });
    expect(scanDocument({ shops: catalog.shops })).toEqual([]);
    const required = await challenge(app, "/v1/quickdata/data-1gb", "POST");
    expect(required.accepts[0]).toMatchObject({ amount: "280000000000000000", payTo: BURN_ADDRESS, network: "eip155:2368" });
  });
});
