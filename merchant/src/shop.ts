import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { findSku, SHOPS, type Shop } from "./catalog.ts";

/**
 * The shops' own backend. The x402 wrapper calls it only after a verified payment,
 * with /v1 stripped, so it serves /<shop>/<sku>. A 4xx here means the wrapper does
 * not settle, so a bad request is never charged. Nothing real is delivered.
 */

const PHONE = /^\+\d{8,15}$/;
const DEMO_NOTE = "Demo merchant: nothing real is delivered.";

function digest(text: string): number {
  return createHash("sha256").update(text).digest().readUInt32BE(0);
}

export function rideQuote(from: string, to: string) {
  const h = digest(`${from.trim().toLowerCase()}|${to.trim().toLowerCase()}`);
  const distanceKm = 3 + (h % 23);
  // >>> keeps the shift unsigned; >> turns hashes at or above 2^31 negative.
  return { from, to, distanceKm, fareNgn: 500 + distanceKm * 180, etaMinutes: 4 + ((h >>> 8) % 12), validForMinutes: 10 };
}

/** The wallet that paid, from the x402 payment header the wrapper forwards. */
export function payerOf(header: string | undefined): string | undefined {
  if (!header) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload?: { authorization?: { from?: unknown } } };
    const from = payload.payload?.authorization?.from;
    return typeof from === "string" && /^0x[0-9a-fA-F]{40}$/.test(from) ? from : undefined;
  } catch {
    return undefined;
  }
}

export interface ShopBackendOptions {
  shops?: readonly Shop[];
  now?: () => Date;
  newId?: () => string;
}

export function createShopBackend(options: ShopBackendOptions = {}): Hono {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const shops = options.shops ?? SHOPS;
  const app = new Hono();

  app.get("/ridemate/quote", (c) => {
    const from = c.req.query("from")?.trim();
    const to = c.req.query("to")?.trim();
    if (!from || !to) return c.json({ error: "from and to are required" }, 400);
    return c.json({ shop: "ridemate", sku: "quote", quote: rideQuote(from, to), quotedAt: now().toISOString(), note: DEMO_NOTE });
  });

  app.post("/ridemate/book", async (c) => {
    let body: { from?: unknown; to?: unknown; phone?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON with from, to and phone" }, 400);
    }
    const from = typeof body.from === "string" ? body.from.trim() : "";
    const to = typeof body.to === "string" ? body.to.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!from || !to) return c.json({ error: "from and to are required" }, 400);
    if (!PHONE.test(phone)) return c.json({ error: "phone must be in international format, e.g. +2348012345678" }, 400);
    const quote = rideQuote(from, to);
    return c.json({
      bookingId: `bk_${newId()}`,
      shop: "ridemate",
      sku: "book",
      status: "confirmed",
      pickup: from,
      dropoff: to,
      fareNgn: quote.fareNgn,
      driverEtaMinutes: quote.etaMinutes,
      rider: `${phone.slice(0, 4)}****${phone.slice(-3)}`,
      bookedAt: now().toISOString(),
      note: `${DEMO_NOTE} The fare is paid to the driver; this charge is the booking fee.`,
    });
  });

  app.post("/:shop/:sku", async (c) => {
    const found = findSku(c.req.param("shop"), c.req.param("sku"), shops);
    if (!found || found.sku.method !== "POST") return c.json({ error: "unknown product" }, 404);
    let body: { phone?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON with a phone field" }, 400);
    }
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!PHONE.test(phone)) return c.json({ error: "phone must be in international format, e.g. +2348012345678" }, 400);
    const { shop, sku } = found;
    const at = now();
    const validityDays = typeof sku.facts.validityDays === "number" ? sku.facts.validityDays : undefined;
    return c.json({
      orderId: `ord_${newId()}`,
      shop: shop.id,
      sku: sku.id,
      title: sku.title,
      priceUsd: sku.priceUsd,
      phone: `${phone.slice(0, 4)}****${phone.slice(-3)}`,
      status: "fulfilled",
      fulfilledAt: at.toISOString(),
      ...(validityDays ? { expiresAt: new Date(at.getTime() + validityDays * 86_400_000).toISOString() } : {}),
      note: DEMO_NOTE,
    });
  });

  app.notFound((c) => c.json({ error: "unknown product" }, 404));
  return app;
}
