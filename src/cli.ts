#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "./config.js";
import { formatReport, runDoctor } from "./doctor.js";
import { createPassport } from "./kpass/passport.js";
import { createServClient } from "./serv/client.js";

const HELP = `pursestrings: your agent shops, you hold the purse strings.

Usage:
  pursestrings doctor [--offline] [--probe-serv] [--json]
  pursestrings --version

Commands:
  doctor   Check SERV Reasoning, Kite Passport and the Kite testnet, and report
           what payments settle on. Runs with zero credentials in mock/simulator mode.

Options for doctor:
  --offline     Skip the Kite RPC and facilitator probes
  --probe-serv  Also probe serv_prompt_guard and Kronos (spends a few SERV credits)
  --json        Print the report as JSON

Environment (see .env.example):
  SERV_API_KEY   SERV Reasoning key; without it SERV runs in mock mode
  SERV_MODE      auto | live | mock
  KPASS_MODE     auto | live | sim  (auto uses kpass when it is installed)
`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
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
      const report = await runDoctor({ config, serv: createServClient(config), passport: createPassport(config) }, { offline: values.offline, probeServ: values["probe-serv"] });
      console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
      return report.checks.some((c) => c.state === "fail") ? 1 : 0;
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
