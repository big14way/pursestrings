import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Append-only record of every decision: the agent identity, merchants found, plan,
 * sessions, payments and refusals. Each entry carries the hash of the one before it,
 * so editing, removing or reordering any past entry breaks the chain, and
 * `pursestrings ledger verify` says where.
 */

export type LedgerKind = "identity" | "discover" | "plan" | "session" | "redteam" | "payment" | "refusal" | "fallback" | "run";

export interface LedgerEntry {
  runId: string;
  at: string;
  kind: LedgerKind;
  /** Hash of the previous entry ("genesis" for the first chained one). */
  prev?: string;
  /** sha256 over this entry without its hash. */
  hash?: string;
  [key: string]: unknown;
}

export const GENESIS = "genesis";

/** An entry before its own hash is added. */
export interface EntryBody {
  runId: string;
  at: string;
  kind: LedgerKind;
  prev?: string;
  [key: string]: unknown;
}

export function entryHash(entry: EntryBody): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

export interface ChainReport {
  ok: boolean;
  entries: number;
  chained: number;
  /** Entries written before the ledger was chained; they precede the first chained one. */
  unchained: number;
  /** 1-based line of the first broken link, when not ok. */
  brokenAt?: number;
  reason?: string;
  head?: string;
}

/** Checks every link: each chained entry's prev is the hash before it, and its own hash is intact. */
export function verifyChain(lines: string[]): ChainReport {
  let prev: string | undefined;
  let chained = 0;
  let unchained = 0;
  for (const [i, line] of lines.entries()) {
    let entry: LedgerEntry;
    try {
      entry = JSON.parse(line) as LedgerEntry;
    } catch {
      return { ok: false, entries: lines.length, chained, unchained, brokenAt: i + 1, reason: "the line is not valid JSON" };
    }
    if (entry.hash === undefined) {
      if (prev !== undefined) return { ok: false, entries: lines.length, chained, unchained, brokenAt: i + 1, reason: "an entry without a hash follows chained entries" };
      unchained++;
      continue;
    }
    const { hash, ...rest } = entry;
    const expectedPrev = prev ?? GENESIS;
    if (entry.prev !== expectedPrev) return { ok: false, entries: lines.length, chained, unchained, brokenAt: i + 1, reason: "it does not point at the entry before it (an entry was removed, reordered or inserted)" };
    if (entryHash(rest) !== hash) return { ok: false, entries: lines.length, chained, unchained, brokenAt: i + 1, reason: "its content no longer matches its hash (it was edited)" };
    prev = hash;
    chained++;
  }
  return { ok: true, entries: lines.length, chained, unchained, head: prev };
}

export class Ledger {
  readonly path: string;
  private last: string | undefined | null = null;
  /** Appends run one at a time, so concurrent runs sharing a ledger keep one unbroken chain. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  private async lines(): Promise<string[]> {
    try {
      return (await readFile(this.path, "utf8")).split("\n").filter((line) => line.trim());
    } catch {
      return [];
    }
  }

  /** Hash of the newest chained entry, read once from disk. */
  private async head(): Promise<string | undefined> {
    if (this.last !== null) return this.last;
    const lines = await this.lines();
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const hash = (JSON.parse(lines[i]!) as LedgerEntry).hash;
        if (typeof hash === "string") return (this.last = hash);
      } catch {
        // skip a damaged line; verify reports it
      }
    }
    return (this.last = undefined);
  }

  append(runId: string, kind: LedgerKind, data: Record<string, unknown>): Promise<LedgerEntry> {
    const next = this.queue.then(() => this.write(runId, kind, data));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async write(runId: string, kind: LedgerKind, data: Record<string, unknown>): Promise<LedgerEntry> {
    const { prev: _p, hash: _h, ...clean } = data;
    const body: EntryBody = { runId, at: new Date().toISOString(), kind, ...clean, prev: (await this.head()) ?? GENESIS };
    const entry: LedgerEntry = { ...body, hash: entryHash(body) };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`);
    this.last = entry.hash;
    return entry;
  }

  async read(runId?: string): Promise<LedgerEntry[]> {
    return (await this.lines())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LedgerEntry];
        } catch {
          return [];
        }
      })
      .filter((e) => !runId || e.runId === runId);
  }

  async verify(): Promise<ChainReport> {
    return verifyChain(await this.lines());
  }
}
