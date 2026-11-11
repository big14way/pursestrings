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
import { listRuns, renderRun, renderRunList } from "./ledger-view.js";
import { toMicros } from "./money.js";
import { mockPlanResponder } from "./planner.js";
import { mockScreenResponder } from "./screen.js";
import { renderEvent, renderSummary } from "./render.js";
import { createServClient } from "./serv/client.js";

export const DEFAULT_MERCHANT = "https://pursestrings-merchant.onrender.com";

/** The honest marketplace plus the three deceptive fixtures, all live on Kite testnet. */
export const DEMO_MERCHANTS = [
  DEFAULT_MERCHANT,
  "https://pursestrings-megadeals.onrender.com",
  "https://pursestrings-datadash.onrender.com",
  "https://pursestrings-quickdata.onrender.com",
];
export const DEMO_TASK = "Buy the cheapest 1GB data bundle under $0.50 for +2348012345678 and book a ride from Yaba to Victoria Island";

const HELP = `pursestrings: your agent shops, you hold the purse strings.

Usage:
  pursestrings run "<task>" [--budget 1.00] [--merchant <url>]... [--yes] [--red-team]
  pursestrings run --demo
  pursestrings ledger [<run id> | last | verify] [--json]
  pursestrings doctor [--offline] [--probe-serv] [--json]
  pursestrings --version

Commands:
  run      Plan the task with SERV Reasoning, ask Kite Passport for a spending
           session bounded by the plan (you approve it with a passkey), then pay
           each merchant, explaining every payment and refusal. A merchant
           whose listing tries to instruct or steer the agent is quarantined
           (a pattern scan, then a SERV screen of the listing's meaning).
  ledger   The audit trail: recent runs, or one run in full (agent identity,
           merchants, plan, approved limits, payments with transaction links,
           refusals). Entries are hash-chained; "ledger verify" checks the chain.
  doctor   Check SERV Reasoning, Kite Passport and the Kite testnet, and report
           what payments settle on.

Options for run:
  --budget <usd>    Most the whole task may spend (default 1.00)
  --merchant <url>  Merchant to shop from; repeat for several
                    (default ${DEFAULT_MERCHANT}, or PURSESTRINGS_MERCHANTS)
  --yes             Accept the spending limits without asking
  --demo            The full demo: the honest marketplace and the three deceptive
                    merchants on Render, the red team on, and a sample task.
                    The first request wakes each free-plan host (up to a minute).
  --red-team        After approval, act as if a quarantined merchant's injected
                    instructions had worked: ask Passport to pay its demand with
                    PurseStrings' own checks off, to show what the session alone
                    allows. Kite testnet merchants only.

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
  return createServClient(config, { mockResponders: { plan: mockPlanResponder, explain: mockExplainResponder, screen: mockScreenResponder } });
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
      "red-team": { type: "boolean" },
      demo: { type: "boolean" },
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
  const config = loadConfig({ kpassDefault: command === "run" && values.demo ? "sim" : "auto" });

  switch (command) {
    case "doctor": {
      const report = await runDoctor({ config, serv: servClient(config), passport: createPassport(config) }, { offline: values.offline, probeServ: values["probe-serv"] });
      console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
      return report.checks.some((c) => c.state === "fail") ? 1 : 0;
    }
    case "run": {
      const task = positionals.slice(1).join(" ").trim() || (values.demo ? DEMO_TASK : "");
      if (!task) {
        console.error('Give the task in quotes, e.g. pursestrings run "cheapest 1GB data bundle under $0.50 for +2348012345678"');
        return 1;
      }
      const budgetUsd = values.budget ?? "1.00";
      toMicros(budgetUsd);
      const merchants = values.merchant?.length ? values.merchant : values.demo ? DEMO_MERCHANTS : (process.env.PURSESTRINGS_MERCHANTS?.split(",").map((m) => m.trim()).filter(Boolean) ?? [DEFAULT_MERCHANT]);
      if (values.demo) console.log(`Demo: ${merchants.length} merchants on Render (free plan: the first request may take up to a minute each). Task: ${task}`);
      const ledger = new Ledger(join(config.stateDir, "ledger.jsonl"));
      const passport = createPassport(config, { preflight: createMerchantPreflight() });
      const backend = passport.mode === "live" && config.kpass.baseURL ? ` (${config.kpass.baseURL})` : passport.mode === "sim" ? " (simulator, no funds move)" : "";
      console.log(`SERV: ${config.serv.mode}   Passport: ${passport.mode}${backend}   Budget: $${budgetUsd}`);
      if (values.demo && passport.mode === "sim" && config.kpass.bin && !process.env.KPASS_MODE) {
        console.log("kpass is installed, but the demo uses the simulator. Set KPASS_MODE=live to use your own Passport session (Kite Passport refuses these merchants until Kite allowlists them).");
      }
      const summary = await runTask(
        { config, serv: servClient(config), passport, ledger },
        {
          task,
          budgetUsd,
          merchants,
          confirm: values.yes ? async () => true : ask,
          onEvent: (event) => console.log(renderEvent(event)),
          redTeam: values["red-team"] || values.demo,
        },
      );
      if (values["red-team"] && !summary.redTeam && summary.sessionId) console.log("Red team: no quarantined merchant to test against; add one with --merchant.");
      console.log(renderSummary(summary, ledger.path));
      return summary.outcomes.some((o) => o.status === "paid") || summary.stoppedReason === undefined ? 0 : 1;
    }
    case "ledger": {
      const ledger = new Ledger(join(config.stateDir, "ledger.jsonl"));
      const which = positionals[1];
      if (which === "verify") {
        const report = await ledger.verify();
        if (values.json) console.log(JSON.stringify(report, null, 2));
        else if (report.ok) console.log(`Ledger intact: ${report.chained} chained entries${report.unchained ? ` (after ${report.unchained} older unchained ones)` : ""}, head ${report.head ?? "none"}.`);
        else console.log(`Ledger BROKEN at line ${report.brokenAt}: ${report.reason}.`);
        return report.ok ? 0 : 1;
      }
      const entries = await ledger.read();
      if (!which) {
        const runs = listRuns(entries);
        console.log(values.json ? JSON.stringify(runs, null, 2) : renderRunList(runs));
        return 0;
      }
      const runId = which === "last" ? listRuns(entries)[0]?.runId : which;
      const run = entries.filter((e) => e.runId === runId);
      if (run.length === 0) {
        console.error(`No run ${which} in ${ledger.path}. List runs with: pursestrings ledger`);
        return 1;
      }
      console.log(values.json ? JSON.stringify(run, null, 2) : renderRun(run));
      return 0;
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
