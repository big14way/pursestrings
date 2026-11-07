import { cleanText, scanDocument, type InjectionFinding } from "./injection.js";

/**
 * Merchant discovery. The agent reads each merchant's free /catalog; the products
 * listed there are the only things the planner may choose and the executor may pay.
 */

export interface CatalogParam {
  name: string;
  description: string;
  example?: string;
}

export interface Product {
  shopId: string;
  shopName: string;
  category: string;
  productId: string;
  title: string;
  priceUsd: string;
  method: "GET" | "POST";
  url: string;
  /** Wallet the merchant lists for this product; its live 402 must pay the same one. */
  payTo: string | undefined;
  params: CatalogParam[];
  facts: Record<string, string | number>;
}

export interface Catalog {
  source: string;
  /** Merchant name from the catalog, or its host. */
  name: string;
  network: string;
  asset: { address: string; symbol: string; decimals: number };
  products: Product[];
  /** Text anywhere in the catalog that tries to instruct the agent. */
  findings: InjectionFinding[];
}

const PRICE = /^\d+(\.\d{1,6})?$/;
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Merchant text, cleaned of terminal escapes and hidden characters, then capped. */
function text(value: unknown, max = 200): string {
  return typeof value === "string" ? cleanText(value).slice(0, max) : "";
}

function address(value: unknown): string | undefined {
  return typeof value === "string" && ADDRESS.test(value) ? value : undefined;
}

/** Validates a catalog document. Anything malformed is dropped, not trusted. */
export function parseCatalog(source: string, doc: unknown): Catalog {
  const root = (doc ?? {}) as Record<string, unknown>;
  const origin = new URL(source).origin;
  const asset = (root.asset ?? {}) as Record<string, unknown>;
  const network = text(root.network, 64);
  if (!/^eip155:\d+$/.test(network)) throw new Error(`catalog at ${source} has no valid network`);
  const payTo = address(root.payTo);
  const products: Product[] = [];
  for (const shop of Array.isArray(root.shops) ? root.shops : []) {
    const s = shop as Record<string, unknown>;
    const shopId = text(s.id, 41);
    if (!ID.test(shopId)) continue;
    for (const product of Array.isArray(s.products) ? s.products : []) {
      const p = product as Record<string, unknown>;
      const productId = text(p.id, 41);
      const priceUsd = text(p.priceUsd, 20);
      const method = p.method === "GET" || p.method === "POST" ? p.method : undefined;
      let url: URL;
      try {
        url = new URL(text(p.url, 500));
      } catch {
        continue;
      }
      // A merchant may only list products on its own origin.
      if (!ID.test(productId) || !PRICE.test(priceUsd) || !method || url.origin !== origin) continue;
      products.push({
        shopId,
        shopName: text(s.name, 80) || shopId,
        category: text(s.category, 40),
        productId,
        title: text(p.title, 120),
        priceUsd,
        method,
        url: url.toString(),
        payTo: address(p.payTo) ?? address(s.payTo) ?? payTo,
        params: (Array.isArray(p.params) ? p.params : []).flatMap((x) => {
          const q = x as Record<string, unknown>;
          const name = text(q.name, 40);
          return /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(name) ? [{ name, description: text(q.description, 160), example: text(q.example, 60) || undefined }] : [];
        }),
        facts: Object.fromEntries(
          Object.entries((p.facts ?? {}) as Record<string, unknown>).flatMap(([k, v]) => (typeof v === "number" || typeof v === "string" ? [[k.slice(0, 40), typeof v === "string" ? v.slice(0, 80) : v]] : [])),
        ),
      });
    }
  }
  return {
    source,
    name: text(root.merchant, 80) || new URL(source).host,
    network,
    asset: { address: text(asset.address, 42), symbol: text(asset.symbol, 16), decimals: Number(asset.decimals) || 0 },
    products,
    findings: scanDocument(doc),
  };
}

export async function fetchCatalog(merchantUrl: string, fetchFn: typeof fetch = fetch): Promise<Catalog> {
  const url = new URL("/catalog", merchantUrl).toString();
  const response = await fetchFn(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`catalog at ${url} returned HTTP ${response.status}`);
  return parseCatalog(url, await response.json());
}

export function findProduct(catalog: Catalog, shopId: string, productId: string): Product | undefined {
  return catalog.products.find((p) => p.shopId === shopId && p.productId === productId);
}
