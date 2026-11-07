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
import { screenFinding, screenListing, type ScreenVerdict } from "./screen.js";
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

/** PurseStrings' rail fee on policy-enforced spend, in basis points (0.5%). Accrued, not charged on testnet. */
export const FEE_BPS = 50n;

export function feeOf(spentMicros: bigint): string {
  return fromMicros((spentMicros * FEE_BPS) / 10_000n);
}

/** Refusals at the live-402 check that another merchant's identical product can stand in for. */
const REPLACEABLE = new Set(["payee_changed", "price_changed", "wrong_asset", "wrong_network", "no_payment_challenge", "merchant_unreachable"]);

/** Who is shopping: the Passport agent and its owner, as Kite Passport reports them. */
export interface AgentIdentity {
  agentId: string | undefined;
  agentType: string | undefined;
  userId: string | undefined;
  backend: string | undefined;
  mode: string;
}

export async function readIdentity(passport: Passport): Promise<AgentIdentity> {
  try {
    const env = (await passport.status()) as Record<string, unknown>;
    const agent = (env.agent ?? {}) as Record<string, unknown>;
    const user = (env.user ?? {}) as Record<string, unknown>;
    const backend = (env.backend ?? {}) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return { agentId: s(agent.agent_id), agentType: s(agent.type), userId: s(user.user_id), backend: s(backend.url) ?? s(env.backend), mode: passport.mode };
  } catch {
    return { agentId: undefined, agentType: undefined, userId: undefined, backend: undefined, mode: passport.mode };
  }
}

export interface Receipt {
  sessionId: string | undefined;
  spentTotalUsd: string | undefined;
  chainId: number | undefined;
  network: string | undefined;
  transaction: string | undefined;
  simulated: boolean;
  /** The wallet the merchant says paid, from its receipt. */
  paidBy?: string;
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
  /** A fact PurseStrings adds to the explanation, e.g. that Passport's limits alone would have paid. */
  note?: string;
  receipt?: Receipt;
  response?: unknown;
}

export interface Quarantine {
  merchant: string;
  source: string;
  /** The pattern scan reads the words; the SERV screen reads the meaning. */
  detectedBy: "pattern scan" | "SERV screen";
  /** SERV's serv_prompt_guard refused the listing outright. */
  guardBlocked?: boolean;
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
  | { type: "identity"; identity: AgentIdentity }
  | { type: "catalog"; merchant: string; source: string; products: number; screen?: Pick<ScreenVerdict, "verdict" | "requestId" | "reason"> }
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
  | { type: "fallback"; index: number; refused: PlanStep; alternative: PlanStep }
  | { type: "stopped"; reason: string };

export interface RunSummary {
  runId: string;
  identity: AgentIdentity | undefined;
  plan: Plan | undefined;
  sessionId: string | undefined;
  quarantined: Quarantine[];
  redTeam: RedTeamOutcome | undefined;
  outcomes: StepOutcome[];
  spentUsd: string;
  /** PurseStrings' 0.5% rail fee on what was spent; accrued, not charged on testnet. */
  feeUsd: string;
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
  let identity: AgentIdentity | undefined;
  const summary = (plan: Plan | undefined, sessionId: string | undefined, spent: string, stoppedReason?: string): RunSummary => ({
    runId,
    identity,
    plan,
    sessionId,
    quarantined,
    redTeam,
    outcomes,
    spentUsd: spent,
    feeUsd: feeOf(toMicros(spent)),
    stoppedReason,
  });
  const stop = async (plan: Plan | undefined, sessionId: string | undefined, spent: string, reason: string) => {
    emit({ type: "stopped", reason });
    await ledger.append(runId, "run", { stopped: reason, spentUsd: spent });
    return summary(plan, sessionId, spent, reason);
  };

  // 0. Who is shopping: the Passport agent identity every session and payment belongs to.
  identity = await readIdentity(passport);
  await ledger.append(runId, "identity", { ...identity });
  emit({ type: "identity", identity });

  // 1. Discover merchants. Only their origins may ever be paid, and a merchant whose
  //    listing tries to instruct or steer the agent is quarantined before the planner
  //    sees it: the pattern scan reads the words, then SERV reads the meaning.
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
      const screen = await screenListing(serv, config.serv.fastModel, catalog.listing);
      if (screen.verdict !== "steering") {
        catalogs.push(catalog);
        const screened = { verdict: screen.verdict, requestId: screen.requestId, reason: screen.reason };
        discovered.push({ source: catalog.source, merchant: catalog.name, status: "ok", products: catalog.products.length, screen: screened });
        emit({ type: "catalog", merchant: catalog.name, source: catalog.source, products: catalog.products.length, screen: screened });
        continue;
      }
      // SERV's reason is the explanation: one call, no second one to explain it.
      const record: Quarantine = { merchant: catalog.name, source: catalog.source, detectedBy: "SERV screen", ...(screen.guardBlocked ? { guardBlocked: true } : {}), findings: [screenFinding(screen)], addresses: [], explanation: screen.reason, explanationId: screen.requestId };
      quarantined.push(record);
      quarantinedCatalogs.push(catalog);
      discovered.push({ ...record, status: "quarantined", products: catalog.products.length });
      emit({ type: "quarantine", quarantine: record });
      continue;
    }
    const findings = rankFindings(catalog.findings);
    const worst = findings[0]!;
    const facts: DecisionFacts = { outcome: "quarantined", merchant: catalog.name, refusedBy: "PurseStrings", code: "prompt_injection", detail: KIND_LABEL[worst.kind], quote: worst.excerpt };
    const explained = await explainDecision(serv, config.serv.fastModel, facts);
    const record: Quarantine = { merchant: catalog.name, source: catalog.source, detectedBy: "pattern scan", findings, addresses: addressesIn(findings), explanation: explained.text, explanationId: explained.requestId };
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

  // What each approved session has spent, as Passport reports it.
  const main = { id: sessionId, plan, spent: 0n };
  let spentElsewhere = 0n;
  const totalSpent = () => main.spent + spentElsewhere;

  // 3b. Red team: what if the injection had worked? Ask Passport to pay the
  //     quarantined merchant's real demand, with PurseStrings' own checks off.
  if (options.redTeam) {
    redTeam = await attemptInjectedPayment();
    if (redTeam) {
      if (redTeam.receipt?.spentTotalUsd) main.spent = toMicros(redTeam.receipt.spentTotalUsd);
      await ledger.append(runId, "redteam", { ...redTeam });
      emit({ type: "redteam", outcome: redTeam });
    }
  }

  // 4. Pay step by step. A step refused at the live-402 check may be replaced by the
  //    same product from another merchant, under a new limit the user approves.
  const refusedOrigins = new Set<string>();
  for (const [index, step] of plan.steps.entries()) {
    emit({ type: "step-start", index, step });
    const result = await payStep(step, index, main, `${runId}-${index}`);
    if (result.status === "refused" && result.code && REPLACEABLE.has(result.code)) {
      refusedOrigins.add(new URL(step.product.url).origin);
      await replace(step, index);
    }
  }
  const spentUsd = fromMicros(totalSpent());
  await ledger.append(runId, "run", {
    finished: true,
    spentUsd,
    feeUsd: feeOf(totalSpent()),
    paid: outcomes.filter((o) => o.status === "paid").length,
    refused: outcomes.filter((o) => o.status === "refused").length,
  });
  return summary(plan, sessionId, spentUsd);

  /** Checks one step in code, then asks Passport to pay it from the given session. */
  async function payStep(step: PlanStep, index: number, session: { id: string; plan: Plan; spent: bigint }, idempotencyKey: string): Promise<StepOutcome> {
    const base = { index, merchant: step.product.shopName, item: step.product.title, priceUsd: step.product.priceUsd };
    const refuse = async (refusedBy: NonNullable<DecisionFacts["refusedBy"]>, code: string, detail: string, remedy?: string, note?: string) => {
      const facts: DecisionFacts = { outcome: "refused", merchant: base.merchant, item: base.item, priceUsd: base.priceUsd, refusedBy, code, detail, remedy };
      const explained = await explainDecision(serv, config.serv.fastModel, facts);
      const outcome: StepOutcome = { ...base, status: "refused", refusedBy, code, explanation: explained.text, explanationId: explained.requestId, ...(note ? { note } : {}) };
      outcomes.push(outcome);
      await ledger.append(runId, "refusal", { ...outcome, url: step.product.url, sessionId: session.id, detail });
      emit({ type: "step", outcome });
      return outcome;
    };

    const decision = checkStep(session.plan, step, fromMicros(session.spent), allowedOrigins);
    if (!decision.ok) return refuse("PurseStrings", decision.code, decision.detail);
    let challenge: Challenge | undefined;
    let challengeDecision;
    try {
      challenge = await probeChallenge(fetchFn, step);
      challengeDecision = checkChallenge(step, challenge, catalog);
    } catch (error) {
      challengeDecision = { ok: false as const, code: "merchant_unreachable", detail: (error as Error).message };
    }
    if (!challengeDecision.ok) {
      // Passport's session caps amounts; it has no rule about who is paid or what was
      // listed. Say so when the session alone would have let this payment through.
      const asked = challenge?.priceUsd !== undefined ? toMicros(usd(challenge.priceUsd) ?? "0") : undefined;
      const caps = session.plan;
      const withinCaps = asked !== undefined && asked <= toMicros(caps.perTxCapUsd) && session.spent + asked <= toMicros(caps.totalUsd);
      const note = withinCaps ? `Your Passport limits alone would have allowed this payment ($${usd(challenge?.priceUsd)} is within the $${caps.perTxCapUsd} cap): they cap amounts, not who is paid.` : undefined;
      return refuse("PurseStrings", challengeDecision.code, challengeDecision.detail, undefined, note);
    }
    const req = stepRequest(step);
    const headers = req.body ? { "content-type": "application/json" } : undefined;
    try {
      const paid = await passport.execute({ url: req.url, method: req.method, headers, body: req.body, idempotencyKey, sessionId: session.id });
      const status = paid.x402?.status_code ?? 0;
      if (status < 200 || status >= 300) return refuse("merchant", `merchant_http_${status}`, `the merchant answered HTTP ${status}`);
      const receipt = receiptOf(paid as unknown as Record<string, unknown>);
      const before = session.spent;
      session.spent = receipt.spentTotalUsd ? toMicros(receipt.spentTotalUsd) : session.spent + toMicros(step.product.priceUsd);
      if (session !== main) spentElsewhere += session.spent - before;
      const explanation = templateExplanation({ outcome: "paid", merchant: base.merchant, item: base.item, priceUsd: base.priceUsd });
      const response = paid.x402?.parsed_response_body ?? paid.x402?.response_body;
      const paidBy = response && typeof response === "object" ? (response as Record<string, unknown>).paidBy : undefined;
      const outcome: StepOutcome = { ...base, status: "paid", explanation, receipt: { ...receipt, ...(typeof paidBy === "string" ? { paidBy } : {}) }, response };
      outcomes.push(outcome);
      await ledger.append(runId, "payment", { ...outcome, url: req.url, sessionId: session.id, agentId: identity?.agentId, why: step.why });
      emit({ type: "step", outcome });
      return outcome;
    } catch (error) {
      if (!(error instanceof KpassError)) throw error;
      return refuse(error.code === "merchant_request_failed" ? "merchant" : "Kite Passport", error.code, error.plainMessage, error.info.remedy);
    }
  }

  /**
   * The same product from another merchant: same category, same facts, same inputs.
   * It needs its own limit, so the user approves a new session for just this item.
   */
  async function replace(refused: PlanStep, index: number): Promise<void> {
    const sameFacts = (a: Product, b: Product) => JSON.stringify(Object.entries(a.facts).sort()) === JSON.stringify(Object.entries(b.facts).sort());
    const sameInputs = (a: Product, b: Product) => a.params.map((p) => p.name).sort().join() === b.params.map((p) => p.name).sort().join();
    const candidates = catalog.products
      .filter((p) => p.category === refused.product.category && sameFacts(p, refused.product) && sameInputs(p, refused.product))
      .filter((p) => !refusedOrigins.has(new URL(p.url).origin) && p.url !== refused.product.url)
      .sort((a, b) => (toMicros(a.priceUsd) < toMicros(b.priceUsd) ? -1 : 1));
    const product = candidates[0];
    if (!product) return;
    const others = plan.steps.filter((s) => s !== refused).reduce((acc, s) => acc + toMicros(s.product.priceUsd), 0n);
    if (others + toMicros(product.priceUsd) > toMicros(plan.budgetUsd)) return;
    const alternative: PlanStep = { product, inputs: refused.inputs, why: `same ${refused.product.title} from ${product.shopName}, after ${refused.product.shopName} was refused` };
    emit({ type: "fallback", index, refused, alternative });
    const altPlan: Plan = { ...plan, steps: [alternative], totalUsd: product.priceUsd, perTxCapUsd: product.priceUsd, rationale: alternative.why, unmet: [], problems: [] };
    const delegation = delegationFromPlan(altPlan, options.ttlSeconds);
    const preview = await passport.previewSession(delegation);
    const question = typeof preview.user_message === "string" ? preview.user_message : `Approve a separate $${product.priceUsd} limit for ${product.shopName}?`;
    emit({ type: "preview", message: question });
    if (!(await options.confirm(question))) {
      await ledger.append(runId, "fallback", { index, refused: refused.product.url, alternative: product.url, approved: false });
      return;
    }
    const request = await passport.requestSession(delegation);
    emit({ type: "approval", message: String(request.user_message ?? ""), url: request.approval_url });
    const approval = await passport.waitForApproval(request.request_id);
    if (approval.state !== "approved") {
      await ledger.append(runId, "fallback", { index, refused: refused.product.url, alternative: product.url, approved: false });
      return;
    }
    const altSession = { id: approval.approved.session_id, plan: altPlan, spent: 0n };
    await ledger.append(runId, "session", { sessionId: altSession.id, requestId: request.request_id, delegation, expiresAt: approval.approved.session.expires_at, mode: passport.mode, replaces: refused.product.url });
    emit({ type: "approved", sessionId: altSession.id, expiresAt: approval.approved.session.expires_at });
    emit({ type: "step-start", index, step: alternative });
    await payStep(alternative, index, altSession, `${runId}-${index}-alt`);
  }

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
