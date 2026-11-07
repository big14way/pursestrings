import { randomBytes } from "node:crypto";
import { fetchCatalog, type Catalog } from "./catalog.js";
import type { Config } from "./config.js";
import { explainDecision, templateExplanation, type DecisionFacts } from "./explain.js";
import { KpassError } from "./kpass/errors.js";
import type { Passport } from "./kpass/passport.js";
import type { Ledger } from "./ledger.js";
import { fromMicros, toMicros } from "./money.js";
import { makePlan, type Plan, type PlanStep } from "./planner.js";
import { checkChallenge, checkStep, delegationFromPlan, stepRequest } from "./policy.js";
import type { ServClient } from "./serv/client.js";
import { readChallenge } from "./x402.js";

/**
 * The agent loop: discover merchants, plan with SERV, ask Passport for a bounded
 * session the user approves with a passkey, then pay step by step. Every step is
 * checked in code first (allowlist, caps, live price), and every outcome is
 * explained and written to the ledger.
 */

export interface Receipt {
  sessionId: string | undefined;
  spentTotalUsd: string | undefined;
  chainId: number | undefined;
  network: string | undefined;
  transaction: string | undefined;
  simulated: boolean;
}

export interface StepOutcome {
  index: number;
  merchant: string;
  item: string;
  priceUsd: string;
  status: "paid" | "refused";
  refusedBy?: DecisionFacts["refusedBy"];
  code?: string;
  explanation: string;
  explanationId?: string;
  receipt?: Receipt;
  response?: unknown;
}

export type RunEvent =
  | { type: "catalog"; merchant: string; products: number }
  | { type: "plan"; plan: Plan }
  | { type: "preview"; message: string }
  | { type: "approval"; message: string; url: string }
  | { type: "approved"; sessionId: string; expiresAt: string | undefined }
  | { type: "step-start"; index: number; step: PlanStep }
  | { type: "step"; outcome: StepOutcome }
  | { type: "stopped"; reason: string };

export interface RunSummary {
  runId: string;
  plan: Plan | undefined;
  sessionId: string | undefined;
  outcomes: StepOutcome[];
  spentUsd: string;
  stoppedReason: string | undefined;
}

export interface RunDeps {
  config: Config;
  serv: ServClient;
  passport: Passport;
  ledger: Ledger;
  fetchFn?: typeof fetch;
}

export interface RunOptions {
  task: string;
  budgetUsd: string;
  merchants: string[];
  /** Asked once, with Passport's own wording of the limits, before any approval request. */
  confirm: (question: string) => Promise<boolean>;
  onEvent?: (event: RunEvent) => void;
  runId?: string;
  ttlSeconds?: number;
}

export function mergeCatalogs(catalogs: Catalog[]): Catalog {
  const [first] = catalogs;
  if (!first) throw new Error("no merchant catalogs");
  for (const c of catalogs) {
    if (c.network !== first.network || c.asset.address.toLowerCase() !== first.asset.address.toLowerCase()) {
      throw new Error(`merchants settle on different networks or tokens (${first.network} vs ${c.network}); use one network per run`);
    }
  }
  return { ...first, source: catalogs.map((c) => c.source).join(", "), products: catalogs.flatMap((c) => c.products) };
}

function receiptOf(envelope: Record<string, unknown>): Receipt {
  const x402 = (envelope.x402 ?? {}) as Record<string, unknown>;
  const usage = (envelope.usage ?? {}) as Record<string, unknown>;
  const tx = x402.tx_hash ?? x402.transaction ?? x402.transaction_hash;
  return {
    sessionId: typeof envelope.session_id === "string" ? envelope.session_id : undefined,
    spentTotalUsd: typeof usage.spent_total === "string" ? usage.spent_total : undefined,
    chainId: typeof x402.chain_id === "number" ? x402.chain_id : undefined,
    network: typeof x402.network === "string" ? x402.network : undefined,
    transaction: typeof tx === "string" ? tx : undefined,
    simulated: x402.simulated === true,
  };
}

export async function runTask(deps: RunDeps, options: RunOptions): Promise<RunSummary> {
  const { config, serv, passport, ledger } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const emit = options.onEvent ?? (() => {});
  const runId = options.runId ?? `run_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  const outcomes: StepOutcome[] = [];
  const summary = (plan: Plan | undefined, sessionId: string | undefined, spent: string, stoppedReason?: string): RunSummary => ({ runId, plan, sessionId, outcomes, spentUsd: spent, stoppedReason });
  const stop = async (plan: Plan | undefined, sessionId: string | undefined, spent: string, reason: string) => {
    emit({ type: "stopped", reason });
    await ledger.append(runId, "run", { stopped: reason, spentUsd: spent });
    return summary(plan, sessionId, spent, reason);
  };

  // 1. Discover merchants. Only their origins may ever be paid.
  const catalogs: Catalog[] = [];
  for (const merchant of options.merchants) {
    const catalog = await fetchCatalog(merchant, fetchFn);
    catalogs.push(catalog);
    emit({ type: "catalog", merchant: catalog.source, products: catalog.products.length });
  }
  const catalog = mergeCatalogs(catalogs);
  const allowedOrigins = new Set(catalogs.map((c) => new URL(c.source).origin));

  // 2. Plan with SERV Reasoning; validate in code.
  const plan = await makePlan(serv, options.task, catalog, { model: config.serv.plannerModel, budgetUsd: options.budgetUsd });
  await ledger.append(runId, "plan", {
    task: plan.task,
    budgetUsd: plan.budgetUsd,
    totalUsd: plan.totalUsd,
    perTxCapUsd: plan.perTxCapUsd,
    steps: plan.steps.map((s) => ({ shop: s.product.shopId, product: s.product.productId, priceUsd: s.product.priceUsd, url: s.product.url, why: s.why })),
    rationale: plan.rationale,
    unmet: plan.unmet,
    problems: plan.problems,
    serv: plan.trace,
  });
  emit({ type: "plan", plan });
  if (plan.steps.length === 0) return stop(plan, undefined, "0.00", "nothing in the plan to buy");

  // 3. A Passport session bounded by the plan, approved by the user with a passkey.
  const delegation = delegationFromPlan(plan, options.ttlSeconds);
  const preview = await passport.previewSession(delegation);
  const question = typeof preview.user_message === "string" ? preview.user_message : `Approve up to $${plan.perTxCapUsd} per payment and $${plan.totalUsd} in total?`;
  emit({ type: "preview", message: question });
  if (!(await options.confirm(question))) return stop(plan, undefined, "0.00", "you declined the spending limits");
  const request = await passport.requestSession(delegation);
  emit({ type: "approval", message: String(request.user_message ?? ""), url: request.approval_url });
  const approval = await passport.waitForApproval(request.request_id);
  if (approval.state !== "approved") return stop(plan, undefined, "0.00", String(approval.envelope.user_message ?? "the session is still waiting for passkey approval"));
  const sessionId = approval.approved.session_id;
  await ledger.append(runId, "session", { sessionId, requestId: request.request_id, delegation, expiresAt: approval.approved.session.expires_at, mode: passport.mode });
  emit({ type: "approved", sessionId, expiresAt: approval.approved.session.expires_at });

  // 4. Pay step by step.
  let spent = 0n;
  for (const [index, step] of plan.steps.entries()) {
    emit({ type: "step-start", index, step });
    const base = { index, merchant: step.product.shopName, item: step.product.title, priceUsd: step.product.priceUsd };
    const refuse = async (refusedBy: NonNullable<DecisionFacts["refusedBy"]>, code: string, detail: string, remedy?: string) => {
      const facts: DecisionFacts = { outcome: "refused", merchant: base.merchant, item: base.item, priceUsd: base.priceUsd, refusedBy, code, detail, remedy };
      const explained = await explainDecision(serv, config.serv.fastModel, facts);
      const outcome: StepOutcome = { ...base, status: "refused", refusedBy, code, explanation: explained.text, explanationId: explained.requestId };
      outcomes.push(outcome);
      await ledger.append(runId, "refusal", { ...outcome, url: step.product.url, detail });
      emit({ type: "step", outcome });
    };

    const decision = checkStep(plan, step, fromMicros(spent), allowedOrigins);
    if (!decision.ok) {
      await refuse("PurseStrings", decision.code, decision.detail);
      continue;
    }
    const req = stepRequest(step);
    const headers = req.body ? { "content-type": "application/json" } : undefined;
    let challengeDecision;
    try {
      const unpaid = await fetchFn(req.url, { method: req.method, headers, body: req.body ? JSON.stringify(req.body) : undefined, redirect: "manual", signal: AbortSignal.timeout(90_000) });
      challengeDecision = checkChallenge(step, await readChallenge(unpaid), catalog);
    } catch (error) {
      challengeDecision = { ok: false as const, code: "merchant_unreachable", detail: (error as Error).message };
    }
    if (!challengeDecision.ok) {
      await refuse("PurseStrings", challengeDecision.code, challengeDecision.detail);
      continue;
    }
    try {
      const paid = await passport.execute({ url: req.url, method: req.method, headers, body: req.body, idempotencyKey: `${runId}-${index}`, sessionId });
      const status = paid.x402?.status_code ?? 0;
      if (status < 200 || status >= 300) {
        await refuse("merchant", `merchant_http_${status}`, `the merchant answered HTTP ${status}`);
        continue;
      }
      const receipt = receiptOf(paid as unknown as Record<string, unknown>);
      spent = receipt.spentTotalUsd ? toMicros(receipt.spentTotalUsd) : spent + toMicros(step.product.priceUsd);
      const explanation = templateExplanation({ outcome: "paid", merchant: base.merchant, item: base.item, priceUsd: base.priceUsd });
      const outcome: StepOutcome = { ...base, status: "paid", explanation, receipt, response: paid.x402?.parsed_response_body ?? paid.x402?.response_body };
      outcomes.push(outcome);
      await ledger.append(runId, "payment", { ...outcome, url: req.url, why: step.why });
      emit({ type: "step", outcome });
    } catch (error) {
      if (!(error instanceof KpassError)) throw error;
      await refuse(error.code === "merchant_request_failed" ? "merchant" : "Kite Passport", error.code, error.message, error.info.remedy);
    }
  }
  const spentUsd = fromMicros(spent);
  await ledger.append(runId, "run", { finished: true, spentUsd, paid: outcomes.filter((o) => o.status === "paid").length, refused: outcomes.filter((o) => o.status === "refused").length });
  return summary(plan, sessionId, spentUsd);
}
