import { randomBytes } from "node:crypto";
import { readChallenge } from "../x402.js";
import type { Preflight } from "./sim.js";

/** Payer recorded by simulated payments. Not a real wallet; nothing is ever signed. */
export const SIM_PAYER = "0x5150000000000000000000000000000000000001";

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The simulator's view of a merchant: a real unpaid request to read the 402 challenge.
 * If the merchant itself runs the simulated facilitator (it says so in a header), the
 * purchase is completed with a structural payment so the order body comes back.
 * Against a real merchant nothing is paid; the simulator reports a simulated body.
 */
export function createMerchantPreflight(fetchFn: typeof fetch = fetch): Preflight {
  return async ({ url, method, headers, body }) => {
    const init: RequestInit = {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(90_000),
    };
    const response = await fetchFn(url, init);
    if (response.status !== 402) return { status: response.status, paidBody: await readBody(response) };
    const challenge = await readChallenge(response);
    const required = response.headers.get("payment-required");
    const simulatedMerchant = response.headers.get("x-pursestrings-simulated") === "1";
    return {
      status: 402,
      price: challenge?.priceUsd,
      asset: challenge?.asset,
      network: challenge?.network,
      pay:
        simulatedMerchant && required
          ? async () => {
              const decoded = JSON.parse(Buffer.from(required, "base64").toString("utf8")) as { accepts: Array<{ payTo: string; amount: string }> };
              const accepted = decoded.accepts[0]!;
              const payload = {
                x402Version: 2,
                accepted,
                payload: {
                  signature: "0xsimulated",
                  authorization: { from: SIM_PAYER, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: `0x${randomBytes(32).toString("hex")}` },
                },
              };
              const paid = await fetchFn(url, { ...init, headers: { ...(init.headers as Record<string, string>), "payment-signature": Buffer.from(JSON.stringify(payload)).toString("base64") } });
              return { status: paid.status, body: await readBody(paid) };
            }
          : undefined,
    };
  };
}
