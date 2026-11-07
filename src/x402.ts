/**
 * Reads x402 payment challenges, so the agent can check what a merchant actually
 * asks for (network, asset, price) before it lets Passport pay.
 */

export interface Challenge {
  x402Version: number;
  scheme: string;
  network: string;
  asset: string;
  /** Amount in the asset's smallest unit. */
  amountAtomic: string;
  payTo: string;
  /** Decimal price when the asset's decimals are known, e.g. "0.3". */
  priceUsd: string | undefined;
  resourceUrl: string | undefined;
  description: string | undefined;
}

/** Stablecoins whose decimals we know. Values come from kite-x402-hono's network table. */
export const KNOWN_ASSETS: Record<string, { symbol: string; decimals: number }> = {
  "eip155:2368:0x38129cf4ce5e183eff248f42a7d345bb1b47621a": { symbol: "pieUSD", decimals: 18 },
  "eip155:2366:0x7ab6f3ed87c42ef0adb67ed95090f8bf5240149e": { symbol: "USDC.e", decimals: 6 },
};

export function assetInfo(network: string, asset: string) {
  return KNOWN_ASSETS[`${network}:${asset}`.toLowerCase()];
}

/** "300000000000000000" with 18 decimals -> "0.3". */
export function formatUnits(atomic: string, decimals: number): string {
  if (!/^\d+$/.test(atomic)) throw new Error(`not an atomic amount: ${atomic}`);
  const padded = atomic.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Exact decimal comparison: "0.30" equals "0.3". */
export function sameAmount(a: string, b: string): boolean {
  const norm = (v: string) => {
    const [w = "0", f = ""] = v.trim().replace(/^\$/, "").split(".");
    return `${BigInt(w)}.${f.replace(/0+$/, "")}`;
  };
  return norm(a) === norm(b);
}

function decodeHeader(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

function normalise(raw: unknown): Challenge | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const root = raw as Record<string, unknown>;
  const container = (root.payment && typeof root.payment === "object" ? root.payment : root) as Record<string, unknown>;
  const accepts = Array.isArray(container.accepts) ? container.accepts : undefined;
  const first = accepts?.[0] as Record<string, unknown> | undefined;
  if (!first) return undefined;
  const amount = String(first.amount ?? first.maxAmountRequired ?? "");
  const network = String(first.network ?? "");
  const asset = String(first.asset ?? "");
  if (!/^\d+$/.test(amount) || !network || !asset) return undefined;
  const resource = (container.resource ?? root.resource) as Record<string, unknown> | string | undefined;
  const known = assetInfo(network, asset);
  return {
    x402Version: Number(first.x402Version ?? container.x402Version ?? root.x402Version ?? 1),
    scheme: String(first.scheme ?? ""),
    network,
    asset,
    amountAtomic: amount,
    payTo: String(first.payTo ?? ""),
    priceUsd: known ? formatUnits(amount, known.decimals) : undefined,
    resourceUrl: typeof resource === "string" ? resource : typeof resource?.url === "string" ? resource.url : undefined,
    description: typeof resource === "object" && typeof resource?.description === "string" ? resource.description : typeof first.description === "string" ? first.description : undefined,
  };
}

/** Parses a 402 response: the x402 v2 PAYMENT-REQUIRED header first, then the JSON body. */
export async function readChallenge(response: Response): Promise<Challenge | undefined> {
  if (response.status !== 402) return undefined;
  const header = response.headers.get("payment-required");
  if (header) {
    try {
      const parsed = normalise(decodeHeader(header));
      if (parsed) return parsed;
    } catch {
      // fall through to the body
    }
  }
  try {
    return normalise(await response.clone().json());
  } catch {
    return undefined;
  }
}
