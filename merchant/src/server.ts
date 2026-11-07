import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { Hono } from "hono";
import { createApp, KITE_NETWORKS, loadConfig as loadWrapperConfig } from "kite-x402-hono";
import { chargeOf, MARKETPLACE, paidPath, type Profile, type Shop, type Sku } from "./catalog.ts";
import { createSimulatedFacilitator } from "./facilitator.ts";
import { MEGADEALS } from "./megadeals.ts";
import { createShopBackend } from "./shop.ts";

export const PIEVERSE_FACILITATOR = "https://facilitator.pieverse.io/v2";

export const PROFILES: Record<string, Profile> = { marketplace: MARKETPLACE, megadeals: MEGADEALS };

export interface MerchantConfig {
  /** Which merchant this host is: the honest marketplace or the malicious test fixture. */
  profile: Profile;
  payTo: string;
  network: "testnet" | "mainnet";
  facilitatorUrl: string;
  facilitatorMode: "pieverse" | "simulated";
  port: number;
  /** Public origin used in the catalog, e.g. https://pursestrings-merchant.onrender.com. */
  publicUrl: string | undefined;
  /** Settings passed through to every kite-x402-hono wrapper. */
  passthrough: Record<string, string>;
}

type Env = Record<string, string | undefined>;

const PASSTHROUGH = ["LOG_ENABLED", "LOG_FORMAT", "TRUST_PROXY_HEADERS", "TRUSTED_PROXY_CIDRS", "RATE_LIMIT_RPS", "RATE_LIMIT_BURST", "FACILITATOR_TIMEOUT_MS", "MAX_CONCURRENT_REQUESTS"];

export function loadMerchantConfig(env: Env = process.env): MerchantConfig {
  const profileId = env.MERCHANT_PROFILE?.trim() || "marketplace";
  const profile = Object.hasOwn(PROFILES, profileId) ? PROFILES[profileId] : undefined;
  if (!profile) throw new Error(`MERCHANT_PROFILE must be one of ${Object.keys(PROFILES).join(", ")}`);
  const payTo = (profile.payTo ?? env.PAY_TO ?? env.MERCHANT_PAY_TO ?? "").trim();
  if (!/^0x[\da-fA-F]{40}$/.test(payTo) || /^0x0{40}$/i.test(payTo)) throw new Error("PAY_TO must be a nonzero EVM address (the merchant's receiving wallet)");
  const network = (env.KITE_NETWORK?.trim() || "testnet") as MerchantConfig["network"];
  if (network !== "testnet" && network !== "mainnet") throw new Error("KITE_NETWORK must be testnet or mainnet");
  const facilitatorMode = (env.MERCHANT_FACILITATOR?.trim() || "pieverse") as MerchantConfig["facilitatorMode"];
  if (facilitatorMode !== "pieverse" && facilitatorMode !== "simulated") throw new Error("MERCHANT_FACILITATOR must be pieverse or simulated");
  if (facilitatorMode === "simulated" && (env.RENDER || env.NODE_ENV === "production")) {
    throw new Error("The simulated facilitator is for local runs only; it cannot run on a hosted deployment");
  }
  const port = Number(env.PORT ?? 8402);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be a valid port number");
  const publicUrl = (env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL)?.trim().replace(/\/+$/, "") || undefined;
  const passthrough = Object.fromEntries(PASSTHROUGH.flatMap((k) => (env[k] ? [[k, env[k] as string]] : [])));
  return { profile, payTo, network, facilitatorUrl: env.FACILITATOR_URL?.trim() || PIEVERSE_FACILITATOR, facilitatorMode, port, publicUrl, passthrough };
}

export interface MerchantOptions {
  facilitator?: FacilitatorClient;
  backend?: Hono;
}

interface Listing {
  shop: Shop;
  sku: Sku;
  path: string;
  wrapper: ReturnType<typeof createApp>;
}

export function createMerchant(config: MerchantConfig, options: MerchantOptions = {}): Hono {
  const chain = KITE_NETWORKS[config.network];
  const simulated = config.facilitatorMode === "simulated";
  const facilitator = options.facilitator ?? (simulated ? createSimulatedFacilitator(chain.network) : new HTTPFacilitatorClient({ url: config.facilitatorUrl }));
  const { profile } = config;
  const backend = options.backend ?? createShopBackend({ shops: profile.shops });

  // The wrapper strips /v1 and calls this with /<shop>/<sku>; serve it in-process.
  const fetchUpstream = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return backend.fetch(
      new Request(`http://shop.internal${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: hasBody ? await request.arrayBuffer() : undefined,
      }),
    );
  };

  const listings = new Map<string, Listing>();
  for (const shop of profile.shops) {
    for (const sku of shop.skus) {
      const wrapperConfig = {
        ...loadWrapperConfig({
          PAY_TO: config.payTo,
          // Required by the wrapper but unused: fetchUpstream serves the shop in-process.
          UPSTREAM_URL: "http://127.0.0.1:9",
          KITE_NETWORK: config.network,
          PRICE_USD: chargeOf(sku),
          FACILITATOR_URL: config.facilitatorUrl,
          ...config.passthrough,
        }),
        description: `${shop.name}: ${sku.title}`,
      };
      const wrapper = createApp(wrapperConfig, { facilitator, fetchUpstream });
      listings.set(`${shop.id}/${sku.id}`, { shop, sku, path: paidPath(shop, sku), wrapper });
    }
  }

  const origin = (requestUrl: string) => config.publicUrl ?? new URL(requestUrl).origin;
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true, profile: profile.id, network: chain.network, asset: chain.symbol, facilitator: simulated ? "simulated" : config.facilitatorUrl, products: listings.size }));

  // Readiness: the facilitator offers exact payments on our network.
  app.get("/readyz", (c) => {
    const first = listings.values().next().value as Listing;
    return first.wrapper.fetch(new Request(new URL("/readyz", c.req.url)), c.env);
  });

  app.get("/catalog", (c) => {
    const base = origin(c.req.url);
    return c.json({
      merchant: profile.merchant,
      ...(profile.notice ? { notice: profile.notice } : {}),
      network: chain.network,
      asset: { address: chain.asset, symbol: chain.symbol, decimals: chain.decimals },
      payTo: config.payTo,
      facilitator: simulated ? "simulated (local only, no funds move)" : config.facilitatorUrl,
      shops: profile.shops.map((shop) => ({
        id: shop.id,
        name: shop.name,
        category: shop.category,
        description: shop.description,
        products: shop.skus.map((sku) => ({ id: sku.id, title: sku.title, priceUsd: sku.priceUsd, method: sku.method, url: `${base}${paidPath(shop, sku)}`, params: sku.params, facts: sku.facts })),
      })),
    });
  });

  app.get("/.well-known/x402", (c) => {
    const base = origin(c.req.url);
    return c.json({
      x402Version: 2,
      resources: [...listings.values()].map(({ shop, sku, path }) => ({
        url: `${base}${path}`,
        method: sku.method,
        description: `${shop.name}: ${sku.title}`,
        accepts: [{ scheme: "exact", network: chain.network, asset: chain.asset, priceUsd: chargeOf(sku), payTo: config.payTo }],
      })),
    });
  });

  // Paid routes. Unknown products are a free 404: nothing to pay for.
  app.all("/v1/:shop/:sku", async (c) => {
    const listing = listings.get(`${c.req.param("shop")}/${c.req.param("sku")}`);
    if (!listing) return c.json({ error: "unknown product", catalog: `${origin(c.req.url)}/catalog` }, 404);
    if (c.req.method !== listing.sku.method && c.req.method !== "OPTIONS") {
      return c.json({ error: `use ${listing.sku.method} for this product` }, 405, { Allow: listing.sku.method });
    }
    const response = await listing.wrapper.fetch(c.req.raw, c.env);
    if (!simulated) return response;
    const marked = new Response(response.body, response);
    marked.headers.set("x-pursestrings-simulated", "1");
    return marked;
  });

  app.notFound((c) => c.json({ error: "not found", catalog: `${origin(c.req.url)}/catalog` }, 404));
  return app;
}
