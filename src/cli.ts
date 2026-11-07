#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv, type Config } from "./config.js";
import { formatReport, runDoctor } from "./doctor.js";
import { runTask } from "./executor.js";
import { mockExplainResponder } from "./explain.js";
import { createMerchantPreflight } from "./kpass/merchant-preflight.js";
import { createPassport } from "./kpass/passport.js";
import { Ledger } from "./ledger.js";
import { toMicros } from "./money.js";
import { mockPlanResponder } from "./planner.js";
import { renderEvent, renderSummary } from "./render.js";
import { createServClient } from "./serv/client.js";

export const DEFAULT_MERCHANT = "https://pursestrings-merchant.onrender.com";

const HELP = `pursestrings: your agent shops, you hold the purse strings.

Usage:
  pursestrings run "<task>" [--budget 1.00] [--merchant <url>]... [--yes]
  pursestrings doctor [--offline] [--probe-serv] [--json]
  pursestrings --version

Commands:
  run      Plan the task with SERV Reasoning, ask Kite Passport for a spending
           session bounded by the plan (you approve it with a passkey), then pay
           each merchant, explaining every payment and refusal.
  doctor   Check SERV Reasoning, Kite Passport and the Kite testnet, and report
           what payments settle on.

Options for run:
  --budget <usd>    Most the whole task may spend (default 1.00)
  --merchant <url>  Merchant to shop from; repeat for several
                    (default ${DEFAULT_MERCHANT}, or PURSESTRINGS_MERCHANTS)
  --yes             Accept the spending limits without asking

Options for doctor:
  --offline     Skip the Kite RPC and facilitator probes
  --probe-serv  Also probe serv_prompt_guard and Kronos (spends a few SERV credits)
  --json        Print the report as JSON

Everything runs with zero credentials: SERV in mock mode, Passport in the built-in
simulator. See .env.example for SERV_API_KEY, SERV_MODE, KPASS_MODE, KPASS_BASE_URL.
`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

function servClient(config: Config) {
  return createServClient(config, { mockResponders: { plan: mockPlanResponder, explain: mockExplainResponder } });
}

async function ask(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question}\nApprove these limits? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      offline: { type: "boolean" },
      "probe-serv": { type: "boolean" },
      json: { type: "boolean" },
      budget: { type: "string" },
      merchant: { type: "string", multiple: true },
      yes: { type: "boolean", short: "y" },
    },
  });

  if (values.version) {
    console.log(version());
    return 0;
  }
  const command = positionals[0];
  if (values.help || !command) {
    console.log(HELP);
    return command || values.help ? 0 : 1;
  }

  loadDotEnv();
  const config = loadConfig();

  switch (command) {
    case "doctor": {
      const report = await runDoctor({ config, serv: servClient(config), passport: createPassport(config) }, { offline: values.offline, probeServ: values["probe-serv"] });
      console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
      return report.checks.some((c) => c.state === "fail") ? 1 : 0;
    }
    case "run": {
      const task = positionals.slice(1).join(" ").trim();
      if (!task) {
        console.error('Give the task in quotes, e.g. pursestrings run "cheapest 1GB data bundle under $0.50 for +2348012345678"');
        return 1;
      }
      const budgetUsd = values.budget ?? "1.00";
      toMicros(budgetUsd);
      const merchants = values.merchant?.length ? values.merchant : (process.env.PURSESTRINGS_MERCHANTS?.split(",").map((m) => m.trim()).filter(Boolean) ?? [DEFAULT_MERCHANT]);
      const ledger = new Ledger(join(config.stateDir, "ledger.jsonl"));
      const passport = createPassport(config, { preflight: createMerchantPreflight() });
      const backend = passport.mode === "live" && config.kpass.baseURL ? ` (${config.kpass.baseURL})` : passport.mode === "sim" ? " (simulator, no funds move)" : "";
      console.log(`SERV: ${config.serv.mode}   Passport: ${passport.mode}${backend}   Budget: $${budgetUsd}`);
      const summary = await runTask(
        { config, serv: servClient(config), passport, ledger },
        {
          task,
          budgetUsd,
          merchants,
          confirm: values.yes ? async () => true : ask,
          onEvent: (event) => console.log(renderEvent(event)),
        },
      );
      console.log(renderSummary(summary, ledger.path));
      return summary.outcomes.some((o) => o.status === "paid") || summary.stoppedReason === undefined ? 0 : 1;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
