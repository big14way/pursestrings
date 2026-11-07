/**
 * The demo shops PurseStrings buys from. All are fictional and labelled as demos.
 * Each SKU is its own x402 paid route with its own price, settled on the Kite testnet.
 */

export type Category = "data-bundle" | "ride-quote" | "airtime";

export interface Param {
  name: string;
  description: string;
  example: string;
}

export interface Sku {
  id: string;
  title: string;
  /** Price per call in USD; on the Kite testnet it is charged in pieUSD. */
  priceUsd: string;
  method: "GET" | "POST";
  /** Query parameters for GET, JSON body fields for POST. */
  params: Param[];
  /** Product facts the planner compares, e.g. data allowance. */
  facts: Record<string, string | number>;
}

export interface Shop {
  id: string;
  name: string;
  category: Category;
  description: string;
  skus: Sku[];
}

const PHONE: Param = { name: "phone", description: "Recipient phone number in international format", example: "+2348012345678" };

export const SHOPS: readonly Shop[] = [
  {
    id: "brightwave",
    name: "BrightWave Data (demo)",
    category: "data-bundle",
    description: "Mobile data bundles delivered to any number. Demo merchant on the Kite testnet.",
    skus: [
      { id: "data-1gb", title: "1 GB data, 30 days", priceUsd: "0.30", method: "POST", params: [PHONE], facts: { dataMb: 1024, validityDays: 30 } },
      { id: "data-5gb", title: "5 GB data, 30 days", priceUsd: "1.20", method: "POST", params: [PHONE], facts: { dataMb: 5120, validityDays: 30 } },
    ],
  },
  {
    id: "swiftbyte",
    name: "SwiftByte Data (demo)",
    category: "data-bundle",
    description: "Prepaid data plans with instant activation. Demo merchant on the Kite testnet.",
    skus: [
      { id: "data-1gb", title: "1 GB data, 30 days", priceUsd: "0.35", method: "POST", params: [PHONE], facts: { dataMb: 1024, validityDays: 30 } },
      { id: "data-5gb", title: "5 GB data, 30 days", priceUsd: "1.10", method: "POST", params: [PHONE], facts: { dataMb: 5120, validityDays: 30 } },
    ],
  },
  {
    id: "ridemate",
    name: "RideMate Quotes (demo)",
    category: "ride-quote",
    description: "Paid ride fare quotes with an ETA. Demo merchant on the Kite testnet.",
    skus: [
      {
        id: "quote",
        title: "Ride fare quote",
        priceUsd: "0.02",
        method: "GET",
        params: [
          { name: "from", description: "Pickup area", example: "Yaba" },
          { name: "to", description: "Drop-off area", example: "Victoria Island" },
        ],
        facts: { kind: "quote" },
      },
    ],
  },
  {
    id: "topup",
    name: "TopUp Express (demo)",
    category: "airtime",
    description: "Airtime top-ups for prepaid lines. Demo merchant on the Kite testnet.",
    skus: [{ id: "airtime-1000", title: "NGN 1,000 airtime", priceUsd: "0.65", method: "POST", params: [PHONE], facts: { airtimeNgn: 1000 } }],
  },
];

export function findSku(shopId: string, skuId: string): { shop: Shop; sku: Sku } | undefined {
  const shop = SHOPS.find((s) => s.id === shopId);
  const sku = shop?.skus.find((k) => k.id === skuId);
  return shop && sku ? { shop, sku } : undefined;
}

/** Path of a SKU's paid route. The /v1 prefix is what the x402 wrapper meters. */
export function paidPath(shop: Shop, sku: Sku): string {
  return `/v1/${shop.id}/${sku.id}`;
}
