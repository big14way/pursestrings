import type { LedgerEntry } from "./ledger.js";
import { explorerTxUrl, rule } from "./render.js";

/**
 * The audit view of the ledger: for each run, the merchants found and quarantined,
 * the plan and its SERV trace, the limits approved with a passkey, the red-team
 * attempt, every payment with its transaction link, every refusal and who made it.
 */

export interface RunListing {
  runId: string;
  startedAt: string;
  task: string;
  paid: number;
  refused: number;
  quarantined: number;
  spentUsd: string;
  status: string;
}

type Obj = Record<string, unknown>;

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback);
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function groupByRun(entries: LedgerEntry[]): Map<string, LedgerEntry[]> {
  const runs = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    const list = runs.get(e.runId) ?? [];
    list.push(e);
    runs.set(e.runId, list);
  }
  return runs;
}

/** Most recent first. */
export function listRuns(entries: LedgerEntry[]): RunListing[] {
  const listings: RunListing[] = [];
  for (const [runId, list] of groupByRun(entries)) {
    const discover = list.find((e) => e.kind === "discover");
    const plan = list.find((e) => e.kind === "plan");
    const run = list.findLast((e) => e.kind === "run");
    const quarantined = arr(discover?.merchants).filter((m) => obj(m).status === "quarantined").length;
    listings.push({
      runId,
      startedAt: list[0]!.at,
      task: str(plan?.task, str(discover?.task, "?")),
      paid: list.filter((e) => e.kind === "payment").length,
      refused: list.filter((e) => e.kind === "refusal").length,
      quarantined,
      spentUsd: str(run?.spentUsd, "0.00"),
      status: run ? (run.stopped ? `stopped: ${str(run.stopped)}` : "finished") : "incomplete",
    });
  }
  return listings.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function hostOf(source: string): string {
  try {
    return new URL(source).host;
  } catch {
    return source;
  }
}

function when(iso: string): string {
  return iso.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, " UTC");
}

export function renderRunList(listings: RunListing[], limit = 20): string {
  if (listings.length === 0) return "No runs in the ledger yet. Try: pursestrings run \"<task>\"";
  const lines = ["Recent runs (newest first). Show one: pursestrings ledger <run id>   or   pursestrings ledger last", ""];
  for (const r of listings.slice(0, limit)) {
    const counts = [`${r.paid} paid`, `${r.refused} refused`, r.quarantined ? `${r.quarantined} quarantined` : ""].filter(Boolean).join(", ");
    lines.push(`${r.runId}  ${when(r.startedAt)}  $${r.spentUsd}  ${counts}  ${r.status === "finished" ? "" : `[${r.status}]`}`.trimEnd());
    lines.push(`  ${r.task.length > 90 ? `${r.task.slice(0, 87)}...` : r.task}`);
  }
  return lines.join("\n");
}

/** The full audit trail of one run. */
export function renderRun(list: LedgerEntry[]): string {
  if (list.length === 0) return "No such run in the ledger.";
  const runId = list[0]!.runId;
  const identity = list.find((e) => e.kind === "identity");
  const discover = list.find((e) => e.kind === "discover");
  const plan = list.find((e) => e.kind === "plan");
  const sessions = list.filter((e) => e.kind === "session");
  const session = sessions[0];
  const redteam = list.find((e) => e.kind === "redteam");
  const run = list.findLast((e) => e.kind === "run");
  const traces: string[] = [];
  const lines: string[] = [];

  lines.push(rule, `Run ${runId}   ${when(list[0]!.at)}${session ? `   Passport: ${str(session.mode)}` : ""}${plan ? `   SERV: ${str(obj(plan.serv).mode)}` : ""}`);
  lines.push(`Task: ${str(plan?.task, str(discover?.task, "?"))}`);
  if (identity?.agentId) lines.push(`Agent ${str(identity.agentId)}${identity.agentType ? ` (${str(identity.agentType)})` : ""}${identity.userId ? `, owned by ${str(identity.userId)}` : ""}`);

  if (discover) {
    lines.push("", "Merchants");
    for (const m of arr(discover.merchants).map(obj)) {
      const host = (() => {
        try {
          return new URL(str(m.source)).host;
        } catch {
          return str(m.source);
        }
      })();
      const screen = obj(m.screen);
      if (screen.requestId) traces.push(`${str(screen.requestId)} (screen ${str(m.merchant)})`);
      if (m.status === "ok") lines.push(`  ✓ ${str(m.merchant)} (${host}): ${str(m.products)} product${m.products === 1 ? "" : "s"}${screen.verdict ? `, SERV screen ${str(screen.verdict)}` : ""}`);
      else if (m.status === "unreachable") lines.push(`  - ${host}: unreachable (${str(m.error)})`);
      else {
        lines.push(`  ⚠ ${str(m.merchant)} (${host}): quarantined by the ${str(m.detectedBy, "pattern scan")}${m.guardBlocked ? " (serv_prompt_guard blocked it)" : ""}`);
        const first = obj(arr(m.findings)[0]);
        if (first.excerpt) lines.push(`      "${str(first.excerpt)}"`);
        if (m.explanation) lines.push(`      ${str(m.explanation)}`);
        if (m.explanationId) traces.push(`${str(m.explanationId)} (quarantine)`);
      }
    }
  }

  if (plan) {
    const serv = obj(plan.serv);
    lines.push("", `Plan (SERV ${str(serv.model)}${serv.requestId ? `, trace ${str(serv.requestId)}` : ""})`);
    if (serv.requestId) traces.push(`${str(serv.requestId)} (plan)`);
    arr(plan.steps).map(obj).forEach((s, i) => lines.push(`  ${i + 1}. ${str(s.shopName, str(s.shop))}: ${str(s.title, str(s.product))}  $${str(s.priceUsd)}`));
    if (plan.rationale) lines.push(`  ${str(plan.rationale)}`);
    for (const u of arr(plan.unmet)) lines.push(`  ! not covered: ${str(u)}`);
  }

  if (session) {
    lines.push("", "Limits approved with your passkey");
    for (const s of sessions) {
      const policy = obj(obj(s.delegation).payment_policy);
      const endpoints = arr(obj(obj(obj(s.delegation).execution_constraints).x402).allowed_endpoints).length;
      const minutes = Math.round(Number(policy.ttl_seconds ?? 0) / 60);
      lines.push(`  session ${str(s.sessionId)}: $${str(policy.max_amount_per_tx)} per payment, $${str(policy.max_total_amount)} in total, ${minutes} min, ${endpoints} endpoint${endpoints === 1 ? "" : "s"}${s.replaces ? `, for a stand-in after ${hostOf(str(s.replaces))} was refused` : ""}`);
    }
  } else if (plan) {
    lines.push("", "No spending session was approved.");
  }

  if (redteam) {
    lines.push("", "Red team (PurseStrings' own checks off)");
    if (redteam.status === "skipped") lines.push(`  skipped: ${str(redteam.detail)}`);
    else {
      lines.push(`  asked Passport to pay ${str(redteam.merchant)} $${str(redteam.demandUsd, "?")} (listed $${str(redteam.listedUsd)}) payable to ${str(redteam.payTo, "?")}`);
      lines.push(redteam.status === "refused" ? `  ✗ refused by ${str(redteam.refusedBy)}: ${str(redteam.code)}. Nothing was paid.` : `  ! PAID: the session limits allowed it`);
      if (redteam.explanation) lines.push(`    ${str(redteam.explanation)}`);
      if (redteam.explanationId) traces.push(`${str(redteam.explanationId)} (red team)`);
    }
  }

  const steps = list.filter((e) => e.kind === "payment" || e.kind === "refusal");
  if (steps.length) {
    lines.push("", "Payments");
    for (const e of steps) {
      if (e.kind === "payment") {
        const r = obj(e.receipt);
        const chainId = typeof r.chainId === "number" ? r.chainId : undefined;
        const tx = str(r.transaction);
        lines.push(`  ✓ $${str(e.priceUsd)}  ${str(e.merchant)}: ${str(e.item)}`);
        if (tx) lines.push(`      ${r.simulated ? "simulated " : ""}tx ${tx}${r.network ? ` on ${str(r.network)}` : ""}`);
        if (r.paidBy) lines.push(`      receipt: paid by ${str(r.paidBy)}`);
        const link = explorerTxUrl(chainId, tx);
        if (link) lines.push(`      ${link}`);
        if (e.why) lines.push(`      why: ${str(e.why)}`);
      } else {
        lines.push(`  ✗ $${str(e.priceUsd)}  ${str(e.merchant)}: ${str(e.item)}  refused by ${str(e.refusedBy)} (${str(e.code)})`);
        lines.push(`      ${str(e.explanation)}`);
        if (e.note) lines.push(`      ${str(e.note)}`);
        if (e.explanationId) traces.push(`${str(e.explanationId)} (refusal)`);
      }
    }
  }

  lines.push("");
  if (run?.stopped) lines.push(`Stopped: ${str(run.stopped)}. Spent $${str(run.spentUsd, "0.00")}.`);
  else if (run) {
    const approved = session ? str(obj(obj(session.delegation).payment_policy).max_total_amount) : "0";
    const approvedTotal = sessions.reduce((acc, s) => acc + Number(str(obj(obj(s.delegation).payment_policy).max_total_amount, "0")), 0);
    const approvedText = sessions.length > 1 ? approvedTotal.toFixed(2) : approved;
    lines.push(`Spent $${str(run.spentUsd)} of $${approvedText} approved${plan ? ` (budget $${str(plan.budgetUsd)})` : ""}: ${str(run.paid)} paid, ${str(run.refused)} refused.`);
    if (run.feeUsd) lines.push(`PurseStrings fee at 0.5%: $${str(run.feeUsd)} (accrued, not charged on testnet).`);
  } else lines.push("This run did not finish (no closing ledger entry).");
  const live = traces.filter((t) => !t.startsWith("mock_"));
  if (live.length) lines.push(`SERV request ids (console.openserv.ai > Usage > Activity): ${live.join(", ")}`);
  else if (traces.length) lines.push("SERV ran in mock mode: no console traces for this run.");
  lines.push(rule);
  return lines.join("\n");
}
