# PurseStrings

**Your agent shops. You hold the purse strings.**

PurseStrings is a shopping and payments agent bounded by a Kite Agent Passport session the user approves once with a passkey: per-transaction cap, total budget, allowed merchants and a time limit. SERV Reasoning explains every payment and every refusal in plain language, and guards the agent against injected instructions.

## Status

In active development. Working today:
- the agent loop (`pursestrings run`): discover, plan with SERV, approve limits with a passkey, pay over x402, explain;
- demo merchants on the Kite testnet, including MegaDeals, a deliberately malicious one;
- prompt-injection defences and a red-team mode that tests the Passport session directly;
- an audit view of every run (`pursestrings ledger`).

It all runs with zero credentials against the built-in Passport simulator.

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

## Run the agent

```bash
npm run build
node dist/cli.js run "Get me the cheapest 1GB data bundle under \$0.50 for +2348012345678 and a ride quote from Yaba to Victoria Island"
```

What happens:

1. **Discover.** PurseStrings reads each merchant's free `/catalog`. Only those merchants can ever be paid. A merchant whose listing tries to give the agent instructions is quarantined (see below).
2. **Plan.** SERV Reasoning (`claude-sonnet-5-serv-kronos`, with `serv_prompt_guard` and `serv_shadow_agent`) picks catalog products and explains why. The model only names product ids: URLs, methods and prices come from the catalog, and the plan is validated in code (known products, declared inputs, within budget).
3. **Bound.** Kite Passport is asked for a separate spending session capped at the plan: largest single payment, plan total, one hour, scoped to the chosen endpoints. You approve it with your passkey.
4. **Pay.** Before each payment PurseStrings checks its own allowlist and caps and re-reads the merchant's live 402 challenge, refusing if the price, network, token or receiving wallet changed. Then Passport pays over x402.
5. **Explain.** Every payment and refusal gets one plain sentence and goes to `.pursestrings/ledger.jsonl`.

With no credentials this runs end to end against the simulator. Nothing real moves:

```bash
npm run merchant:sim   # honest merchants on :8402, MegaDeals on :8403
KPASS_MODE=sim SERV_MODE=mock node dist/cli.js run "Get me the cheapest 1GB data bundle under \$0.50 for +2348012345678 and a ride quote from Yaba to Victoria Island" \
  --merchant http://localhost:8402 --merchant http://localhost:8403 --yes --red-team
node dist/cli.js ledger last
```

## Prompt injection: three layers

An agent that pays can be robbed. Merchant pages are written by the merchant, so PurseStrings treats them as data and never relies on one defence.

[MegaDeals](https://pursestrings-megadeals.onrender.com/catalog) is a deliberately malicious demo merchant. Its listing tells AI shopping agents to ignore their limits and send their whole budget to the burn address. Its 402 asks $1.00 for a bundle it lists at $0.25.

1. **PurseStrings quarantines it.** Every string in a catalog is scanned for text that addresses AI agents, overrides their rules, redirects funds or asks for secrecy. A merchant that does any of this never reaches the planner and cannot be paid. SERV explains the decision in one sentence, with `serv_prompt_guard` declared on that call.
2. **PurseStrings checks every payment in code.** The planner can only name catalog product ids. Before each payment, the merchant's live 402 must match the listing: network, token, receiving wallet and price. MegaDeals' bait-and-switch is refused even when its listing carries no injected text.
3. **Kite Passport bounds the session.** Even an agent that was fully fooled can only spend inside the session you approved with your passkey. `run --red-team` shows this. After approval it plays the fooled agent: it asks Passport to pay MegaDeals' $1.00 demand directly, with PurseStrings' own checks off. Passport refuses (`session_rule_exceeded`: over the $0.30 per-payment cap), and nothing is paid. Red-team mode only ever targets Kite testnet merchants.

SERV's `serv_prompt_guard` is declared on every call that carries merchant text, and its verdicts appear in the SERV console's Safety report. It targets attempts to extract or override the system prompt, so PurseStrings does not rely on it alone.

## The ledger

Every run is appended to `.pursestrings/ledger.jsonl`. Its entries are: the merchants found or quarantined, the plan with its SERV trace id, the limits you approved, the red-team attempt, each payment with its transaction, and each refusal with who refused and why.

```bash
node dist/cli.js ledger          # recent runs
node dist/cli.js ledger last     # one run in full, with testnet.kitescan.ai links for real transactions
node dist/cli.js ledger <run id> --json
```

## Demo merchants

`merchant/` is the shop side: four demo merchants (two competing data-bundle sellers, a ride-quote service and an airtime seller) selling over x402 on the Kite testnet, live at [pursestrings-merchant.onrender.com](https://pursestrings-merchant.onrender.com/catalog). The same server runs MegaDeals with `MERCHANT_PROFILE=megadeals`. Each product is its own paid route built on [kite-x402-hono](https://github.com/BrKDDD/kite-x402-hono), priced in pieUSD and settled through the Pieverse facilitator.

```bash
npm run merchant       # real settlement on the Kite testnet (needs MERCHANT_PAY_TO)
npm run merchant:sim   # local only: simulated facilitator, no funds move; MegaDeals on PORT+1
```

| Route | What it is |
| --- | --- |
| `GET /catalog` | Free directory of shops, products, prices and paid URLs |
| `GET /.well-known/x402` | x402 discovery for every paid route |
| `POST /v1/<shop>/<product>` | Paid purchase, e.g. `/v1/brightwave/data-1gb` with `{"phone":"+234..."}` |
| `GET /v1/ridemate/quote?from=&to=` | Paid ride quote |
| `GET /healthz`, `GET /readyz` | Liveness, and facilitator readiness for the Kite testnet |

An unpaid request gets a 402 challenge. A request with a valid payment is fulfilled and then settled; invalid orders are never charged. `merchant/scripts/buy.ts` pays a route directly from a testnet wallet to check settlement end to end.

Deploy both on Render's free plan with the included `render.yaml` (New > Blueprint). Free instances sleep when idle, so the first request after a while takes up to a minute.

## Development

```bash
npm run check   # typecheck, tests, build
npm run dev -- doctor --offline
```

## License

MIT
