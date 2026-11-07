import { createSimulatedFacilitator } from "../facilitator.ts";
import { createMerchant, loadMerchantConfig } from "../server.ts";

/**
 * The demo page's merchants: in-process copies of the four live demo merchants, each
 * on its own sandbox origin, with the simulated facilitator. They have no port and no
 * public address; only the demo's own agent reaches them, through fetchFn. Nothing is
 * signed, settled or paid.
 */

export interface SandboxMerchant {
  profile: string;
  origin: string;
  name: string;
  /** honest, or the trick a deceptive fixture plays. */
  role: "honest" | "blatant injection" | "steers buyers" | "payee swap";
  /** The live copy on Render, for people who want to read the real listing. */
  live: string;
}

export const SANDBOX_MERCHANTS: SandboxMerchant[] = [
  { profile: "marketplace", origin: "https://marketplace.sandbox", name: "PurseStrings demo merchants", role: "honest", live: "https://pursestrings-merchant.onrender.com/catalog" },
  { profile: "megadeals", origin: "https://megadeals.sandbox", name: "MegaDeals", role: "blatant injection", live: "https://pursestrings-megadeals.onrender.com/catalog" },
  { profile: "datadash", origin: "https://datadash.sandbox", name: "DataDash", role: "steers buyers", live: "https://pursestrings-datadash.onrender.com/catalog" },
  { profile: "quickdata", origin: "https://quickdata.sandbox", name: "QuickData", role: "payee swap", live: "https://pursestrings-quickdata.onrender.com/catalog" },
];

/** The honest merchants' receiving wallet on Kite testnet (public address). */
export const DEMO_PAY_TO = "0x706F739AE390375A1Df4046879a47DC2D46389cc";

export function createSandbox(payTo = DEMO_PAY_TO) {
  const facilitator = createSimulatedFacilitator("eip155:2368");
  const apps = new Map(
    SANDBOX_MERCHANTS.map((m) => [
      m.origin,
      // An explicit env, so the sandbox never inherits a hosting flag or a real wallet key.
      createMerchant(loadMerchantConfig({ MERCHANT_PROFILE: m.profile, PAY_TO: payTo, LOG_ENABLED: "false", PUBLIC_URL: m.origin, MERCHANT_FACILITATOR: "simulated" }), { facilitator }),
    ]),
  );
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const app = apps.get(url.origin);
    if (!app) return Response.json({ error: `${url.host} is not a sandbox merchant` }, { status: 404 });
    return app.request(url.toString(), init);
  }) as typeof fetch;
  return { fetchFn, facilitator };
}
