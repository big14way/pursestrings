import { serve } from "@hono/node-server";
import { loadMerchantConfig, createMerchant } from "./server.ts";

const config = loadMerchantConfig(process.env);
const app = createMerchant(config);
const hostname = process.env.HOST ?? "0.0.0.0";

const server = serve({ fetch: app.fetch, port: config.port, hostname }, (info) => {
  const mode = config.facilitatorMode === "simulated" ? "SIMULATED facilitator, no funds move" : `facilitator ${config.facilitatorUrl}`;
  console.log(`PurseStrings merchants on http://${hostname}:${info.port} (Kite ${config.network}, ${mode}). Catalog: /catalog`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
