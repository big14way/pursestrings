import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { findSku } from "./catalog.ts";

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
  return { from, to, distanceKm, fareNgn: 500 + distanceKm * 180, etaMinutes: 4 + ((h >> 8) % 12), validForMinutes: 10 };
}

export interface ShopBackendOptions {
  now?: () => Date;
  newId?: () => string;
}

export function createShopBackend(options: ShopBackendOptions = {}): Hono {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const app = new Hono();

  app.get("/ridemate/quote", (c) => {
    const from = c.req.query("from")?.trim();
    const to = c.req.query("to")?.trim();
    if (!from || !to) return c.json({ error: "from and to are required" }, 400);
    return c.json({ shop: "ridemate", sku: "quote", quote: rideQuote(from, to), quotedAt: now().toISOString(), note: DEMO_NOTE });
  });

  app.post("/:shop/:sku", async (c) => {
    const found = findSku(c.req.param("shop"), c.req.param("sku"));
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
