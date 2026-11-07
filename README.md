# PurseStrings

**Your agent shops. You hold the purse strings.**

PurseStrings is a shopping and payments agent bounded by a Kite Agent Passport session the user approves once with a passkey: per-transaction cap, total budget, allowed merchants and a time limit. SERV Reasoning explains every payment and every refusal in plain language, and guards the agent against injected instructions.

## Status

Built for SERV Hackathon Edition 02 (Kite track). Working today:
- the agent loop (`pursestrings run`): discover, plan with SERV, approve limits with a passkey, pay over x402, explain;
- demo merchants on the Kite testnet, live on Render, including MegaDeals, a deliberately malicious one;
- prompt-injection defences, and a red-team mode that tests the Passport session directly;
- an audit view of every run (`pursestrings ledger`).

Verified live (evidence below):
- real x402 settlement of pieUSD on Kite testnet to the deployed merchant;
- SERV Reasoning planning on Kronos and explaining decisions, each call traceable in the SERV console;
- the real Kite Passport (dev backend, passkey-approved session) refusing the injected payment.

Not yet: live Passport payments to our own merchants. Kite Passport only pays hosts in Kite's catalog, so it refuses `pursestrings-merchant.onrender.com` with `payment_target_forbidden` until Kite allowlists it. Until then the honest purchases run against the built-in Passport simulator, which enforces the same caps.

Everything runs with zero credentials against the simulator.

## Quick start

Requires Node.js 20.12 or later. One command, no clone:

```bash
npx github:big14way/pursestrings doctor
npx github:big14way/pursestrings run "Get me the cheapest 1GB data bundle under \$0.50 for +2348012345678 and a ride quote from Yaba to Victoria Island" --red-team
```

Or from a clone:

```bash
npm install          # also builds dist/
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
3. **Kite Passport bounds the session.** Even an agent that was fully fooled can only spend inside the session you approved with your passkey. `run --red-team` shows this. After approval it plays the fooled agent: it asks Passport to pay MegaDeals' $1.00 demand directly, with PurseStrings' own checks off. In the simulator Passport refuses with `session_rule_exceeded` (over the $0.30 per-payment cap). Against the real Kite Passport (dev backend, session approved with a passkey) it refuses with `payment_target_forbidden` (`host_not_in_executable_catalog`). Either way nothing is paid. Red-team mode only ever targets Kite testnet merchants.

SERV's `serv_prompt_guard` is declared on every call that carries merchant text, and its verdicts appear in the SERV console's Safety report. It targets attempts to extract or override the system prompt, and in our tests it let the MegaDeals text through to the model (which then explained the block correctly), so PurseStrings does not rely on it alone.

## How SERV Reasoning powers it

PurseStrings calls SERV Reasoning through the OpenAI SDK at `https://inference-api.openserv.ai/v1`.

- **Planning on Kronos.** The planner runs on `claude-sonnet-5-serv-kronos`, so the Kronos audit checks the planning prompt. It declares `serv_prompt_guard` and `serv_shadow_agent` (its hint: every step must be a catalog id, inputs must come from the task, the total must fit the budget). The model only names catalog product ids; code validates the plan.
- **One-sentence explanations.** Every quarantine and every refusal is explained by `claude-haiku-4.5`, with the merchant's text passed as quoted data and the guard declared. The subject is whoever decided: PurseStrings, Kite Passport or the merchant.
- **Traceable.** Each call's `x-openserv-request-id` goes into the ledger, and the SERV console lists the same id under Usage > Activity, so every decision can be matched to its call, cost and latency.
- **Cheap.** A full run costs a few cents of SERV credit (two to eight cents in our runs); responses are cached locally while developing.

## The ledger

Every run is appended to `.pursestrings/ledger.jsonl`. Its entries are: the merchants found or quarantined, the plan with its SERV request id, the limits you approved, the red-team attempt, each payment with its transaction, and each refusal with who refused and why.

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

## Evidence

| What | Where |
| --- | --- |
| x402 payment to the deployed merchant (0.02 pieUSD, ride quote) | [0x4381…a95a](https://testnet.kitescan.ai/tx/0x438173217add452680c80fddda55302e1934046b5831f9fc73dc39d9a9c5a95a) |
| x402 payment to the merchant (0.30 pieUSD, 1 GB bundle) | [0xb453…ca34](https://testnet.kitescan.ai/tx/0xb453c167de285c6652a95c8ad3579e945429d30d8cbd1127b72c002c999aca34) |
| Merchant receiving wallet | [0x706F…89cc](https://testnet.kitescan.ai/address/0x706F739AE390375A1Df4046879a47DC2D46389cc) |
| Live MegaDeals listing (the injection) | [pursestrings-megadeals.onrender.com/catalog](https://pursestrings-megadeals.onrender.com/catalog) |
| Real Kite Passport refusing the injected payment | `payment_target_forbidden`, session approved by passkey on the dev backend |

Both payments were made with `merchant/scripts/buy.ts` (an x402 client paying from a testnet wallet), not through Passport.

## Business model

- **0.5% on policy-enforced spend:** a rail fee on payments that settle inside the limits the user approved.
- **Merchant listings:** a fee for merchants that want PurseStrings agents to find them.

## Development

```bash
npm run check   # typecheck, tests, build
npm run dev -- doctor --offline
```

## License

MIT
