import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GENESIS, Ledger, verifyChain } from "../src/ledger.js";

describe("ledger chain", () => {
  it("links each entry to the one before and starts from genesis", async () => {
    const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "ps-ledger-")), "ledger.jsonl"));
    const a = await ledger.append("r", "plan", { totalUsd: "0.32" });
    const b = await ledger.append("r", "run", { spentUsd: "0.32", hash: "forged", prev: "forged" });
    expect(a.prev).toBe(GENESIS);
    expect(b.prev).toBe(a.hash);
    expect(b.hash).not.toBe("forged");
    expect(await ledger.verify()).toMatchObject({ ok: true, chained: 2, head: b.hash });
    // A new Ledger on the same file continues the chain from disk.
    const again = new Ledger(ledger.path);
    expect((await again.append("r2", "plan", {})).prev).toBe(b.hash);
  });

  it("accepts older unchained entries only before the chain starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-ledger-"));
    const path = join(dir, "ledger.jsonl");
    writeFileSync(path, `${JSON.stringify({ runId: "old", at: "t", kind: "run" })}\n`);
    const ledger = new Ledger(path);
    await ledger.append("new", "plan", {});
    expect(await ledger.verify()).toMatchObject({ ok: true, unchained: 1, chained: 1 });
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(verifyChain([...lines, lines[0]!])).toMatchObject({ ok: false, brokenAt: 3, reason: expect.stringMatching(/without a hash/) });
    expect(verifyChain([...lines, "{not json"])).toMatchObject({ ok: false, brokenAt: 3 });
  });
});
