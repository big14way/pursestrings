import { serve } from "@hono/node-server";
import { createMerchant, loadMerchantConfig } from "./server.ts";

// MERCHANT_PROFILE may list several profiles for local runs, e.g.
// "marketplace,megadeals": each gets its own port, starting at PORT.
const profiles = (process.env.MERCHANT_PROFILE ?? "marketplace").split(",").map((p) => p.trim()).filter(Boolean);
const basePort = Number(process.env.PORT ?? 8402);
const hostname = process.env.HOST ?? "0.0.0.0";
const servers: Array<ReturnType<typeof serve>> = [];

for (const [index, profile] of profiles.entries()) {
  const env: Record<string, string | undefined> = { ...process.env, MERCHANT_PROFILE: profile, PORT: String(basePort + index) };
  // A public URL names one host; with several local profiles each uses its own origin.
  if (profiles.length > 1) {
    delete env.PUBLIC_URL;
    delete env.RENDER_EXTERNAL_URL;
  }
  const config = loadMerchantConfig(env);
  const app = createMerchant(config);
  servers.push(
    serve({ fetch: app.fetch, port: config.port, hostname }, (info) => {
      const mode = config.facilitatorMode === "simulated" ? "SIMULATED facilitator, no funds move" : `facilitator ${config.facilitatorUrl}`;
      console.log(`${config.profile.merchant} on http://${hostname}:${info.port} (Kite ${config.network}, ${mode}). Catalog: /catalog`);
    }),
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    let open = servers.length;
    for (const server of servers) server.close(() => --open === 0 && process.exit(0));
  });
}
