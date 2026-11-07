import type { RunEvent, RunSummary } from "./executor.js";

/** Terminal rendering of a run: the plan, the limits, every payment and refusal. */

const rule = "─".repeat(64);

export function renderEvent(event: RunEvent): string {
  switch (event.type) {
    case "catalog":
      return `• ${event.merchant}: ${event.products} products`;
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
    case "step-start":
      return `→ ${event.step.product.shopName}: ${event.step.product.title} ($${event.step.product.priceUsd})`;
    case "step": {
      const o = event.outcome;
      if (o.status === "paid") {
        const r = o.receipt;
        const where = r ? [r.network ?? (r.chainId ? `chain ${r.chainId}` : undefined), r.transaction ? `tx ${r.transaction}` : undefined, r.simulated ? "simulated" : undefined].filter(Boolean).join(", ") : "";
        const delivered = describeResponse(o.response);
        return `  ✓ ${o.explanation}${where ? `\n    ${where}` : ""}${delivered ? `\n    delivered: ${delivered}` : ""}`;
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
  return [rule, `Run ${summary.runId}: ${paid} paid, ${refused} refused, $${summary.spentUsd} spent.`, `Ledger: ${ledgerPath}`].join("\n");
}
