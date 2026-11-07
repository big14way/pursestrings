# PurseStrings

**Your agent shops. You hold the purse strings.**

PurseStrings is a shopping and payments agent bounded by a Kite Agent Passport session the user approves once with a passkey: per-transaction cap, total budget, allowed merchants and a time limit. SERV Reasoning explains every payment and every refusal in plain language, and guards the agent against injected instructions.

## Status

In active development. The foundation is in place: the SERV Reasoning client, the Kite Passport CLI wrapper with a local simulator, and a `doctor` command that checks every dependency. The planner, the merchant services and the demo will land here next.

## Quick start

Requires Node.js 20.12 or later.

```bash
npm install
npm run build
node dist/cli.js doctor
```

With no credentials, `doctor` runs SERV in mock mode and Kite Passport in the built-in simulator, and still probes the Kite testnet RPC and the Pieverse facilitator. No funds move in the simulator.

To go live:

1. Create a SERV Reasoning API key at [console.openserv.ai](https://console.openserv.ai), copy `.env.example` to `.env` and set `SERV_API_KEY`.
2. Install the Kite Passport CLI and log in:
   ```bash
   curl -fsSL https://cli.gokite.ai/install.sh | bash
   kpass signup init --email you@example.com   # or: kpass login init --email ...
   kpass agent:register --type pursestrings
   ```
3. Run `node dist/cli.js doctor` again. Add `--probe-serv` to also exercise `serv_prompt_guard` and the Kronos audit (spends a few credits).

`doctor` writes its report and every kpass exchange to `.pursestrings/` (git-ignored) so runs can be audited and replayed.

## Demo merchants

`merchant/` is the shop side: four demo merchants (two competing data-bundle sellers, a ride-quote service and an airtime seller) selling over x402 on the Kite testnet. Each product is its own paid route built on [kite-x402-hono](https://github.com/BrKDDD/kite-x402-hono), priced in pieUSD and settled through the Pieverse facilitator.

```bash
npm run merchant       # real settlement on the Kite testnet (needs MERCHANT_PAY_TO)
npm run merchant:sim   # local only: simulated facilitator, no funds move
```

| Route | What it is |
| --- | --- |
| `GET /catalog` | Free directory of shops, products, prices and paid URLs |
| `GET /.well-known/x402` | x402 discovery for every paid route |
| `POST /v1/<shop>/<product>` | Paid purchase, e.g. `/v1/brightwave/data-1gb` with `{"phone":"+234..."}` |
| `GET /v1/ridemate/quote?from=&to=` | Paid ride quote |
| `GET /healthz`, `GET /readyz` | Liveness, and facilitator readiness for the Kite testnet |

An unpaid request gets a 402 challenge. A request with a valid payment is fulfilled and then settled; invalid orders are never charged. `merchant/scripts/buy.ts` pays a route directly from a testnet wallet to check settlement end to end.

Deploy on Render's free plan with the included `render.yaml` (New > Blueprint).

## Development

```bash
npm run check   # typecheck, tests, build
npm run dev -- doctor --offline
```

## License

MIT
