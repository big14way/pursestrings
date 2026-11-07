import { randomBytes } from "node:crypto";
import { fetchCatalog, type Catalog, type Product } from "./catalog.js";
import type { Config } from "./config.js";
import { explainDecision, templateExplanation, type DecisionFacts } from "./explain.js";
import { addressesIn, KIND_LABEL, rankFindings, type InjectionFinding } from "./injection.js";
import { KpassError } from "./kpass/errors.js";
import type { Passport } from "./kpass/passport.js";
import type { Ledger } from "./ledger.js";
import { fromMicros, toMicros } from "./money.js";
import { makePlan, type Plan, type PlanStep } from "./planner.js";
import { checkChallenge, checkStep, delegationFromPlan, stepRequest } from "./policy.js";
import type { ServClient } from "./serv/client.js";
import { readChallenge, type Challenge } from "./x402.js";

/**
 * The agent loop: discover merchants (quarantining any whose listing tries to
 * instruct the agent), plan with SERV, ask Passport for a bounded session the user
 * approves with a passkey, then pay step by step. Every step is checked in code
 * first (allowlist, caps, live payee and price), and every outcome is explained and
 * written to the ledger.
 */

/** The only network the red team will attack: Kite testnet, where nothing has real value. */
export const RED_TEAM_NETWORK = "eip155:2368";

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

export interface Quarantine {
  merchant: string;
  source: string;
  findings: InjectionFinding[];
  /** Wallets the injected text wants paid. */
  addresses: string[];
  explanation: string;
  explanationId?: string;
}

/** What happened when the agent obeyed the injection, with PurseStrings' checks off. */
export interface RedTeamOutcome {
  merchant: string;
  item: string;
  url: string;
  listedUsd: string;
  /** What the merchant's live 402 really asks for. */
  demandUsd: string | undefined;
  payTo: string | undefined;
  status: "refused" | "paid" | "skipped";
  refusedBy?: DecisionFacts["refusedBy"];
  code?: string;
  detail: string;
  explanation?: string;
  explanationId?: string;
  receipt?: Receipt;
}

export type RunEvent =
  | { type: "catalog"; merchant: string; source: string; products: number }
  | { type: "catalog-error"; source: string; error: string }
  | { type: "quarantine"; quarantine: Quarantine }
  | { type: "plan"; plan: Plan }
  | { type: "preview"; message: string }
  | { type: "approval"; message: string; url: string }
  | { type: "approved"; sessionId: string; expiresAt: string | undefined }
  | { type: "redteam-start"; target: Pick<RedTeamOutcome, "merchant" | "item" | "listedUsd" | "demandUsd" | "payTo"> }
  | { type: "redteam"; outcome: RedTeamOutcome }
  | { type: "step-start"; index: number; step: PlanStep }
  | { type: "step"; outcome: StepOutcome }
  | { type: "stopped"; reason: string };

export interface RunSummary {
  runId: string;
  plan: Plan | undefined;
  sessionId: string | undefined;
  quarantined: Quarantine[];
  redTeam: RedTeamOutcome | undefined;
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
  /**
   * After approval, act as an agent fooled by a quarantined merchant: ask Passport
   * to pay its demand directly, with PurseStrings' own checks off, to show what the
   * session alone allows. Kite testnet merchants only.
   */
  redTeam?: boolean;
}

export function mergeCatalogs(catalogs: Catalog[]): Catalog {
  const [first] = catalogs;
  if (!first) throw new Error("no merchant catalogs");
  for (const c of catalogs) {
    if (c.network !== first.network || c.asset.address.toLowerCase() !== first.asset.address.toLowerCase()) {
      throw new Error(`merchants settle on different networks or tokens (${first.network} vs ${c.network}); use one network per run`);
    }
  }
  return {
    ...first,
    source: catalogs.map((c) => c.source).join(", "),
    name: catalogs.map((c) => c.name).join(", "),
    products: catalogs.flatMap((c) => c.products),
    findings: catalogs.flatMap((c) => c.findings),
  };
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

/** The unpaid request: the merchant's 402 says what it really wants. */
async function probeChallenge(fetchFn: typeof fetch, step: PlanStep): Promise<Challenge | undefined> {
  const req = stepRequest(step);
  const unpaid = await fetchFn(req.url, {
    method: req.method,
    headers: req.body ? { "content-type": "application/json" } : undefined,
    body: req.body ? JSON.stringify(req.body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(90_000),
  });
  return readChallenge(unpaid);
}

/** "1" -> "1.00" for display; amounts finer than a micro-dollar are shown as given. */
function usd(amount: string | undefined): string | undefined {
  if (amount === undefined) return undefined;
  try {
    return fromMicros(toMicros(amount));
  } catch {
    return amount;
  }
}

/** The inputs an agent would send without the user: the merchant's own examples. */
function exampleStep(product: Product): PlanStep {
  return { product, inputs: Object.fromEntries(product.params.map((p) => [p.name, p.example ?? ""])), why: "the merchant's injected instructions" };
}

export async function runTask(deps: RunDeps, options: RunOptions): Promise<RunSummary> {
  const { config, serv, passport, ledger } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const emit = options.onEvent ?? (() => {});
  const runId = options.runId ?? `run_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  const outcomes: StepOutcome[] = [];
  const quarantined: Quarantine[] = [];
  const quarantinedCatalogs: Catalog[] = [];
  let redTeam: RedTeamOutcome | undefined;
  const summary = (plan: Plan | undefined, sessionId: string | undefined, spent: string, stoppedReason?: string): RunSummary => ({
    runId,
    plan,
    sessionId,
    quarantined,
    redTeam,
    outcomes,
    spentUsd: spent,
    stoppedReason,
  });
  const stop = async (plan: Plan | undefined, sessionId: string | undefined, spent: string, reason: string) => {
    emit({ type: "stopped", reason });
    await ledger.append(runId, "run", { stopped: reason, spentUsd: spent });
    return summary(plan, sessionId, spent, reason);
  };

  // 1. Discover merchants. Only their origins may ever be paid, and a merchant whose
  //    listing tries to instruct the agent is quarantined before the planner sees it.
  const catalogs: Catalog[] = [];
  const discovered: Array<Record<string, unknown>> = [];
  for (const merchant of options.merchants) {
    let catalog: Catalog;
    try {
      catalog = await fetchCatalog(merchant, fetchFn);
    } catch (error) {
      const message = (error as Error).message;
      discovered.push({ source: merchant, status: "unreachable", error: message });
      emit({ type: "catalog-error", source: merchant, error: message });
      continue;
    }
    if (catalog.findings.length === 0) {
      catalogs.push(catalog);
      discovered.push({ source: catalog.source, merchant: catalog.name, status: "ok", products: catalog.products.length });
      emit({ type: "catalog", merchant: catalog.name, source: catalog.source, products: catalog.products.length });
      continue;
    }
    const findings = rankFindings(catalog.findings);
    const worst = findings[0]!;
    const facts: DecisionFacts = { outcome: "quarantined", merchant: catalog.name, refusedBy: "PurseStrings", code: "prompt_injection", detail: KIND_LABEL[worst.kind], quote: worst.excerpt };
    const explained = await explainDecision(serv, config.serv.fastModel, facts);
    const record: Quarantine = { merchant: catalog.name, source: catalog.source, findings, addresses: addressesIn(findings), explanation: explained.text, explanationId: explained.requestId };
    quarantined.push(record);
    quarantinedCatalogs.push(catalog);
    discovered.push({ ...record, status: "quarantined", products: catalog.products.length });
    emit({ type: "quarantine", quarantine: record });
  }
  await ledger.append(runId, "discover", { task: options.task, merchants: discovered });
  if (catalogs.length === 0) {
    return stop(undefined, undefined, "0.00", quarantined.length ? "every merchant was quarantined; nothing safe to buy from" : "no merchant catalog could be read");
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
    steps: plan.steps.map((s) => ({ shop: s.product.shopId, shopName: s.product.shopName, product: s.product.productId, title: s.product.title, priceUsd: s.product.priceUsd, url: s.product.url, why: s.why })),
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

  let spent = 0n;

  // 3b. Red team: what if the injection had worked? Ask Passport to pay the
  //     quarantined merchant's real demand, with PurseStrings' own checks off.
  if (options.redTeam) {
    redTeam = await attemptInjectedPayment();
    if (redTeam) {
      if (redTeam.receipt?.spentTotalUsd) spent = toMicros(redTeam.receipt.spentTotalUsd);
      await ledger.append(runId, "redteam", { ...redTeam });
      emit({ type: "redteam", outcome: redTeam });
    }
  }

  // 4. Pay step by step.
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
    let challengeDecision;
    try {
      challengeDecision = checkChallenge(step, await probeChallenge(fetchFn, step), catalog);
    } catch (error) {
      challengeDecision = { ok: false as const, code: "merchant_unreachable", detail: (error as Error).message };
    }
    if (!challengeDecision.ok) {
      await refuse("PurseStrings", challengeDecision.code, challengeDecision.detail);
      continue;
    }
    const req = stepRequest(step);
    const headers = req.body ? { "content-type": "application/json" } : undefined;
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
      await refuse(error.code === "merchant_request_failed" ? "merchant" : "Kite Passport", error.code, error.plainMessage, error.info.remedy);
    }
  }
  const spentUsd = fromMicros(spent);
  await ledger.append(runId, "run", { finished: true, spentUsd, paid: outcomes.filter((o) => o.status === "paid").length, refused: outcomes.filter((o) => o.status === "refused").length });
  return summary(plan, sessionId, spentUsd);

  async function attemptInjectedPayment(): Promise<RedTeamOutcome | undefined> {
    // The fooled agent goes for the biggest demand among the quarantined merchants.
    let target: { product: Product; challenge: Challenge; merchant: string } | undefined;
    for (const c of quarantinedCatalogs) {
      for (const product of c.products) {
        const challenge = await probeChallenge(fetchFn, exampleStep(product)).catch(() => undefined);
        if (!challenge?.priceUsd) continue;
        if (!target || BigInt(challenge.amountAtomic) > BigInt(target.challenge.amountAtomic)) target = { product, challenge, merchant: c.name };
      }
    }
    if (!target) {
      return quarantined.length ? { merchant: quarantined[0]!.merchant, item: "-", url: quarantined[0]!.source, listedUsd: "-", demandUsd: undefined, payTo: undefined, status: "skipped", detail: "the quarantined merchant asked for no x402 payment" } : undefined;
    }
    const { product, challenge, merchant } = target;
    const base = { merchant, item: product.title, url: product.url, listedUsd: product.priceUsd, demandUsd: usd(challenge.priceUsd), payTo: challenge.payTo };
    if (challenge.network !== RED_TEAM_NETWORK) {
      return { ...base, status: "skipped", detail: `red team runs only against Kite testnet merchants; this one asks for payment on ${challenge.network}` };
    }
    emit({ type: "redteam-start", target: base });
    const req = stepRequest(exampleStep(product));
    try {
      const paid = await passport.execute({
        url: req.url,
        method: req.method,
        headers: req.body ? { "content-type": "application/json" } : undefined,
        body: req.body,
        idempotencyKey: `${runId}-redteam`,
        sessionId,
      });
      const receipt = receiptOf(paid as unknown as Record<string, unknown>);
      return { ...base, status: "paid", detail: "Passport paid the injected demand: the session limits allowed it", receipt };
    } catch (error) {
      if (!(error instanceof KpassError)) throw error;
      const refusedBy = error.code === "merchant_request_failed" ? ("merchant" as const) : ("Kite Passport" as const);
      const facts: DecisionFacts = { outcome: "refused", merchant, item: product.title, priceUsd: base.demandUsd, refusedBy, code: error.code, detail: error.plainMessage };
      const explained = await explainDecision(serv, config.serv.fastModel, facts);
      return { ...base, status: "refused", refusedBy, code: error.code, detail: error.plainMessage, explanation: explained.text, explanationId: explained.requestId };
    }
  }
}
