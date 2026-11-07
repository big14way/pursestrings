import { execFile } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { KpassMode } from "../config.js";
import type { KpassEnvelope } from "./types.js";

export interface KpassResult {
  args: string[];
  exitCode: number;
  envelope: KpassEnvelope;
  stdout: string;
  stderr: string;
  durationMs: number;
  mode: KpassMode;
}

export interface KpassRunner {
  readonly mode: KpassMode;
  run(args: string[]): Promise<KpassResult>;
}

export interface ExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecFn = (bin: string, args: string[], options: { timeoutMs: number }) => Promise<ExecOutput>;

/** Runs a binary without a shell, so task text in --delegation can never be interpreted. */
export const execBinary: ExecFn = (bin, args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      let exitCode = 0;
      if (error) {
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        exitCode = typeof code === "number" ? code : error.killed ? 124 : 127;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? (error ? String(error.message) : ""), exitCode });
    });
  });

/** Returns every top-level {...} block in the text, skipping braces inside strings. */
export function extractJsonObjects(text: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) blocks.push(text.slice(start, i + 1));
    }
  }
  return blocks;
}

/**
 * kpass 6.x prints a JSON envelope with --output json; on errors it prints a second,
 * thinner copy after it. Use the first object that parses, tolerate log lines around
 * it, and fall back to a synthetic envelope for plain text such as --version.
 */
export function parseEnvelope(stdout: string, exitCode: number): KpassEnvelope {
  const text = stdout.trim();
  for (const block of extractJsonObjects(text)) {
    try {
      const parsed: unknown = JSON.parse(block);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const envelope = parsed as KpassEnvelope;
        if (typeof envelope.status !== "string") envelope.status = exitCode === 0 ? "success" : "error";
        return envelope;
      }
    } catch {
      // try the next block
    }
  }
  return exitCode === 0
    ? { status: "success", text }
    : { status: "error", error_code: "unparseable_output", error: text || `exit code ${exitCode}`, text };
}

const SECRET_FLAGS = new Set(["--code", "--exchange-token"]);
const SECRET_KEY = /token|secret|password|private/i;

export function redactArgs(args: string[]): string[] {
  return args.map((arg, i) => (i > 0 && SECRET_FLAGS.has(args[i - 1] ?? "") ? "[redacted]" : arg));
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && typeof v === "string" ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

/** Appends every kpass exchange to a JSONL file: the recorded fallback and the audit trail. */
export class Transcript {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async record(result: KpassResult): Promise<void> {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      mode: result.mode,
      args: redactArgs(result.args),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      envelope: redact(result.envelope),
      stderr: result.stderr.slice(0, 2000) || undefined,
    });
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${line}\n`);
  }
}

export interface LiveRunnerOptions {
  bin: string;
  /** Passport backend URL, e.g. https://passport.dev.gokite.ai. Omit for the kpass default. */
  baseURL?: string;
  timeoutMs: number;
  transcript?: Transcript;
  exec?: ExecFn;
  now?: () => number;
}

/** The command words of a kpass call, e.g. ["session", "execute"], ignoring flags and their values. */
export function commandWords(args: string[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--output" || arg === "--base-url") i++;
    else if (arg.startsWith("--")) {
      if (words.length > 0) break;
    } else words.push(arg);
  }
  return words;
}

export function wantsJson(args: string[]): boolean {
  return !args.includes("--version") && !args.includes("--help");
}

export function createLiveRunner(options: LiveRunnerOptions): KpassRunner {
  const exec = options.exec ?? execBinary;
  const now = options.now ?? Date.now;
  return {
    mode: "live",
    async run(args) {
      // Global flags go first: kpass 6.13 rejects `sandbox status --no-interactive` as an unknown command.
      const globals = ["--output", "json", "--no-interactive", ...(options.baseURL ? ["--base-url", options.baseURL] : [])];
      const fullArgs = wantsJson(args) ? [...globals, ...args] : args;
      const started = now();
      const out = await exec(options.bin, fullArgs, { timeoutMs: options.timeoutMs });
      const result: KpassResult = {
        args: fullArgs,
        exitCode: out.exitCode,
        envelope: parseEnvelope(out.stdout, out.exitCode),
        stdout: out.stdout,
        stderr: out.stderr,
        durationMs: now() - started,
        mode: "live",
      };
      await options.transcript?.record(result);
      return result;
    },
  };
}
