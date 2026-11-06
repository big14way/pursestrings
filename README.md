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

## Development

```bash
npm run check   # typecheck, tests, build
npm run dev -- doctor --offline
```

## License

MIT
