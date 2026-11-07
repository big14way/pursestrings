import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Append-only record of every decision: merchants found, plan, session, payments and refusals. */

export type LedgerKind = "discover" | "plan" | "session" | "redteam" | "payment" | "refusal" | "run";

export interface LedgerEntry {
  runId: string;
  at: string;
  kind: LedgerKind;
  [key: string]: unknown;
}

export class Ledger {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async append(runId: string, kind: LedgerKind, data: Record<string, unknown>): Promise<LedgerEntry> {
    const entry: LedgerEntry = { runId, at: new Date().toISOString(), kind, ...data };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  async read(runId?: string): Promise<LedgerEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LedgerEntry];
        } catch {
          return [];
        }
      })
      .filter((e) => !runId || e.runId === runId);
  }
}
