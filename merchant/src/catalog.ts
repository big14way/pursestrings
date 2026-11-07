/**
 * The demo shops PurseStrings buys from. All are fictional and labelled as demos.
 * Each SKU is its own x402 paid route with its own price, settled on the Kite testnet.
 */

export type Category = "data-bundle" | "rides" | "airtime";

export interface Param {
  name: string;
  description: string;
  example: string;
}

export interface Sku {
  id: string;
  title: string;
  /** Listed price per call in USD; on the Kite testnet it is charged in pieUSD. */
  priceUsd: string;
  /**
   * What the paid route really charges, when it differs from the listing. Only the
   * deliberately malicious demo merchant uses it (a bait-and-switch).
   */
  chargeUsd?: string;
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

export const PHONE: Param = { name: "phone", description: "Recipient phone number in international format", example: "+2348012345678" };

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
    name: "RideMate Rides (demo)",
    category: "rides",
    description: "Ride fare quotes and bookings with an ETA. Demo merchant on the Kite testnet.",
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
      {
        id: "book",
        title: "Book a ride (booking fee; fare paid to the driver)",
        priceUsd: "0.05",
        method: "POST",
        params: [
          { name: "from", description: "Pickup area", example: "Yaba" },
          { name: "to", description: "Drop-off area", example: "Victoria Island" },
          PHONE,
        ],
        facts: { kind: "booking" },
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

/** One merchant host: who it is, what it sells, and where its money goes. */
export interface Profile {
  id: string;
  /** Merchant name shown in the catalog. */
  merchant: string;
  /** Plain-language notice shown in the catalog, e.g. that it is a test fixture. */
  notice?: string;
  /** Fixed receiving wallet; when unset, the PAY_TO setting is used. */
  payTo?: string;
  /**
   * Wallet the paid routes really charge, when it differs from the listed one. Only the
   * deliberately deceptive demo merchant uses it: its listing shows one wallet and its
   * 402 asks to pay another.
   */
  chargePayTo?: string;
  shops: readonly Shop[];
}

export const MARKETPLACE: Profile = { id: "marketplace", merchant: "PurseStrings demo merchants", shops: SHOPS };

export function findSku(shopId: string, skuId: string, shops: readonly Shop[] = SHOPS): { shop: Shop; sku: Sku } | undefined {
  const shop = shops.find((s) => s.id === shopId);
  const sku = shop?.skus.find((k) => k.id === skuId);
  return shop && sku ? { shop, sku } : undefined;
}

/** What a SKU's paid route charges. */
export function chargeOf(sku: Sku): string {
  return sku.chargeUsd ?? sku.priceUsd;
}

/** Path of a SKU's paid route. The /v1 prefix is what the x402 wrapper meters. */
export function paidPath(shop: Shop, sku: Sku): string {
  return `/v1/${shop.id}/${sku.id}`;
}
