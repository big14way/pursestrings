import type { RedTeamOutcome, RunEvent, RunSummary } from "./executor.js";
import { KIND_LABEL } from "./injection.js";

/** Terminal rendering of a run: merchants, the plan, the limits, every payment and refusal. */

export const rule = "─".repeat(64);

const EXPLORERS: Record<number, string> = { 2368: "https://testnet.kitescan.ai" };

/** Block explorer link for a real transaction; none for simulated ones. */
export function explorerTxUrl(chainId: number | undefined, tx: string | undefined): string | undefined {
  if (!chainId || !tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) return undefined;
  const base = EXPLORERS[chainId];
  return base ? `${base}/tx/${tx}` : undefined;
}

function hostOf(source: string): string {
  try {
    return new URL(source).host;
  } catch {
    return source;
  }
}

export function renderRedTeam(o: RedTeamOutcome): string {
  if (o.status === "skipped") return `  Red team skipped: ${o.detail}`;
  if (o.status === "paid") {
    const tx = o.receipt?.transaction ? ` (tx ${o.receipt.transaction})` : "";
    return `  ! Passport PAID the injected demand of $${o.demandUsd}${tx}. The session limits were wide enough to allow it.`;
  }
  return [`  ✗ ${o.refusedBy} refused: ${o.detail}${o.code ? ` (${o.code})` : ""}`, ...(o.explanation ? [`    ${o.explanation}`] : []), `    Nothing was paid to ${o.merchant}.`].join("\n");
}

export function renderEvent(event: RunEvent): string {
  switch (event.type) {
    case "catalog":
      return `• ${event.merchant} (${hostOf(event.source)}): ${event.products} products`;
    case "catalog-error":
      return `• ${hostOf(event.source)}: unreachable, skipped (${event.error})`;
    case "quarantine": {
      const q = event.quarantine;
      const kinds = [...new Set(q.findings.map((f) => KIND_LABEL[f.kind]))].join("; ");
      const lines = [`⚠ ${q.merchant} (${hostOf(q.source)}): QUARANTINED. Its listing ${kinds}.`];
      for (const f of q.findings.slice(0, 3)) lines.push(`    "${f.excerpt}"`);
      lines.push(`    ${q.explanation}${q.explanationId ? ` (SERV trace ${q.explanationId})` : ""}`);
      return lines.join("\n");
    }
    case "plan": {
      const { plan } = event;
      const lines = [rule, `Plan (SERV ${plan.trace.mode}, ${plan.trace.model}${plan.trace.requestId ? `, trace ${plan.trace.requestId}` : ""}${plan.trace.cached ? ", cached" : ""})`];
      plan.steps.forEach((s, i) => {
        const inputs = Object.entries(s.inputs).map(([k, v]) => `${k}=${v}`).join(" ");
        lines.push(`  ${i + 1}. ${s.product.shopName}: ${s.product.title}  $${s.product.priceUsd}${inputs ? `  (${inputs})` : ""}`);
        lines.push(`     why: ${s.why}`);
      });
      lines.push(`  Total $${plan.totalUsd} of $${plan.budgetUsd}; largest single payment $${plan.perTxCapUsd}`);
      if (plan.rationale) lines.push(`  ${plan.rationale}`);
      for (const u of plan.unmet) lines.push(`  ! not covered: ${u}`);
      for (const p of plan.problems) lines.push(`  ! checked out: ${p}`);
      lines.push(rule);
      return lines.join("\n");
    }
    case "preview":
      return `Passport asks: ${event.message}`;
    case "approval":
      return `${event.message || "Approve the session with your passkey:"}\n  ${event.url}\nWaiting for your passkey approval...`;
    case "approved":
      return `Session approved: ${event.sessionId}${event.expiresAt ? ` (until ${event.expiresAt})` : ""}`;
    case "redteam-start": {
      const t = event.target;
      return [
        rule,
        `Red team: what if the agent had obeyed ${t.merchant}?`,
        `→ Asking Passport to pay what ${t.merchant} demands, using this session with PurseStrings' own checks OFF:`,
        `  ${t.item}, listed at $${t.listedUsd}, its 402 asks $${t.demandUsd ?? "?"} payable to ${t.payTo ?? "?"}`,
      ].join("\n");
    }
    case "redteam":
      return `${renderRedTeam(event.outcome)}\n${rule}`;
    case "step-start":
      return `→ ${event.step.product.shopName}: ${event.step.product.title} ($${event.step.product.priceUsd})`;
    case "step": {
      const o = event.outcome;
      if (o.status === "paid") {
        const r = o.receipt;
        const where = r ? [r.network ?? (r.chainId ? `chain ${r.chainId}` : undefined), r.transaction ? `tx ${r.transaction}` : undefined, r.simulated ? "simulated" : undefined].filter(Boolean).join(", ") : "";
        const link = explorerTxUrl(r?.chainId, r?.transaction);
        const delivered = describeResponse(o.response);
        return `  ✓ ${o.explanation}${where ? `\n    ${where}` : ""}${link ? `\n    ${link}` : ""}${delivered ? `\n    delivered: ${delivered}` : ""}`;
      }
      return `  ✗ ${o.explanation}${o.code ? `\n    code ${o.code}${o.explanationId ? `, SERV trace ${o.explanationId}` : ""}` : ""}`;
    }
    case "stopped":
      return `Stopped: ${event.reason}`;
  }
}

/** A one-line summary of what a merchant returned, e.g. an order id or a quote. */
export function describeResponse(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const r = response as Record<string, unknown>;
  if (typeof r.orderId === "string") return `order ${r.orderId}${typeof r.status === "string" ? ` (${r.status})` : ""}`;
  const quote = r.quote as Record<string, unknown> | undefined;
  if (quote && typeof quote === "object") return `quote ${quote.from} → ${quote.to}: NGN ${quote.fareNgn}, ${quote.etaMinutes} min away`;
  return undefined;
}

export function renderSummary(summary: RunSummary, ledgerPath: string): string {
  const paid = summary.outcomes.filter((o) => o.status === "paid").length;
  const refused = summary.outcomes.length - paid;
  const extra = [summary.quarantined.length ? `${summary.quarantined.length} merchant${summary.quarantined.length === 1 ? "" : "s"} quarantined` : "", summary.redTeam?.status === "refused" ? "injected payment refused by Passport" : ""].filter(Boolean);
  return [
    rule,
    `Run ${summary.runId}: ${paid} paid, ${refused} refused, $${summary.spentUsd} spent${extra.length ? `; ${extra.join("; ")}` : ""}.`,
    `Ledger: ${ledgerPath}   View it: pursestrings ledger ${summary.runId}`,
  ].join("\n");
}
