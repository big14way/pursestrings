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

/**
 * kpass prints one JSON object with --output json. Tolerate log lines before it,
 * and fall back to a synthetic envelope for plain-text output such as --version.
 */
export function parseEnvelope(stdout: string, exitCode: number): KpassEnvelope {
  const text = stdout.trim();
  const candidates = [text];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.trimStart().startsWith("{")) {
      candidates.push(lines.slice(i).join("\n"));
      break;
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const envelope = parsed as KpassEnvelope;
        if (typeof envelope.status !== "string") envelope.status = exitCode === 0 ? "success" : "error";
        return envelope;
      }
    } catch {
      // try the next candidate
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
  constructor(readonly path: string) {}

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
  timeoutMs: number;
  transcript?: Transcript;
  exec?: ExecFn;
  now?: () => number;
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
      const fullArgs = wantsJson(args) ? [...args, "--output", "json", "--no-interactive"] : args;
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
