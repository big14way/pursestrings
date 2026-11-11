import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export type ServMode = "live" | "mock";
export type KpassMode = "live" | "sim";

export interface Config {
  serv: {
    mode: ServMode;
    apiKey: string | undefined;
    baseURL: string;
    /** Model used for payment decisions. The -serv-kronos suffix turns on the Kronos audit. */
    plannerModel: string;
    /** Cheaper model for one-sentence explanations and probes. */
    fastModel: string;
    cache: boolean;
  };
  kpass: {
    mode: KpassMode;
    /** Resolved path to the kpass binary, if one was found. */
    bin: string | undefined;
    /** Passport backend; kpass has no env var for it, so it is passed as --base-url. */
    baseURL: string | undefined;
    timeoutMs: number;
  };
  /** Local working directory for caches, probes and transcripts. Never committed. */
  stateDir: string;
}

export const SERV_BASE_URL = "https://inference-api.openserv.ai/v1";
export const DEFAULT_PLANNER_MODEL = "claude-sonnet-5-serv-kronos";
export const DEFAULT_FAST_MODEL = "claude-haiku-4.5";
/** kpass documents a 5 minute ceiling for paid calls; leave headroom above it. */
export const DEFAULT_KPASS_TIMEOUT_MS = 330_000;

type Env = Record<string, string | undefined>;

function pick<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (raw === undefined || raw === "") return fallback;
  const value = raw.trim().toLowerCase();
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name} must be one of ${allowed.join(", ")} (got "${raw}")`);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Finds an executable on PATH, then in the locations the Kite installer uses. */
export function resolveBinary(name: string, env: Env = process.env): string | undefined {
  const explicit = env.KPASS_BIN;
  if (explicit) return isExecutable(explicit) ? resolve(explicit) : undefined;
  const home = env.HOME ?? homedir();
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), join(home, ".kpass", "bin"), join(home, ".local", "bin")];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export interface LoadConfigOptions {
  env?: Env;
  cwd?: string;
  resolveBin?: (name: string, env: Env) => string | undefined;
  /** Passport mode when KPASS_MODE is unset. `run --demo` passes "sim" so the demo never needs a login. */
  kpassDefault?: "auto" | "sim";
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const resolveBin = options.resolveBin ?? resolveBinary;

  const apiKey = env.SERV_API_KEY?.trim() || undefined;
  const servPref = pick(env.SERV_MODE, ["auto", "live", "mock"] as const, "auto", "SERV_MODE");
  if (servPref === "live" && !apiKey) throw new Error("SERV_MODE=live needs SERV_API_KEY (create one at console.openserv.ai)");
  const servMode: ServMode = servPref === "mock" ? "mock" : servPref === "live" ? "live" : apiKey ? "live" : "mock";

  const bin = resolveBin("kpass", env);
  const kpassPref = pick(env.KPASS_MODE, ["auto", "live", "sim"] as const, options.kpassDefault ?? "auto", "KPASS_MODE");
  if (kpassPref === "live" && !bin) throw new Error("KPASS_MODE=live but no kpass binary was found (install: curl -fsSL https://cli.gokite.ai/install.sh | bash)");
  const kpassMode: KpassMode = kpassPref === "sim" ? "sim" : kpassPref === "live" ? "live" : bin ? "live" : "sim";

  const timeoutRaw = env.KPASS_TIMEOUT_MS;
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULT_KPASS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("KPASS_TIMEOUT_MS must be a positive number of milliseconds");

  return {
    serv: {
      mode: servMode,
      apiKey,
      baseURL: env.SERV_BASE_URL?.trim() || SERV_BASE_URL,
      plannerModel: env.SERV_PLANNER_MODEL?.trim() || DEFAULT_PLANNER_MODEL,
      fastModel: env.SERV_FAST_MODEL?.trim() || DEFAULT_FAST_MODEL,
      cache: env.SERV_CACHE !== "0",
    },
    kpass: { mode: kpassMode, bin, baseURL: env.KPASS_BASE_URL?.trim() || undefined, timeoutMs },
    stateDir: resolve(cwd, env.PURSESTRINGS_STATE_DIR?.trim() || ".pursestrings"),
  };
}

/** Loads ./.env when present. Real environment variables always win. */
export function loadDotEnv(path = ".env"): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // No .env file: zero-credential mode is the default.
  }
}
