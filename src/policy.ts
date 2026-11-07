import type { Catalog } from "./catalog.js";
import type { Delegation } from "./kpass/types.js";
import { toMicros } from "./money.js";
import type { Plan, PlanStep } from "./planner.js";
import { sameAmount, type Challenge } from "./x402.js";

/**
 * PurseStrings' own spending rules, checked in code before every Passport call.
 * Passport enforces its caps too, but its endpoint scope is recorded rather than
 * enforced, so the merchant allowlist and price checks live here.
 */

export type Decision = { ok: true } | { ok: false; code: string; detail: string };

export function delegationFromPlan(plan: Plan, ttlSeconds = 3600): Delegation {
  const summary = `PurseStrings: ${plan.task}`.replace(/\s+/g, " ");
  const endpoints = new Map<string, { method: string; host: string; path_prefix: string }>();
  for (const { product } of plan.steps) {
    const url = new URL(product.url);
    endpoints.set(`${product.method} ${url.host}${url.pathname}`, { method: product.method, host: url.host, path_prefix: url.pathname });
  }
  return {
    task: { summary: summary.length > 80 ? `${summary.slice(0, 77)}...` : summary },
    payment_policy: { max_amount_per_tx: plan.perTxCapUsd, max_total_amount: plan.totalUsd, ttl_seconds: ttlSeconds, currency: "USD" },
    execution_constraints: { x402: { scope_mode: "scoped", allowed_endpoints: [...endpoints.values()] } },
  };
}

/** Is this step one the user approved, at the approved price, within what is left? */
export function checkStep(plan: Plan, step: PlanStep, spentUsd: string, allowedOrigins: Set<string>): Decision {
  const url = new URL(step.product.url);
  if (!allowedOrigins.has(url.origin)) return { ok: false, code: "merchant_not_in_allowlist", detail: `${url.host} is not one of the merchants you approved` };
  if (!plan.steps.includes(step)) return { ok: false, code: "step_not_in_plan", detail: "this purchase is not in the approved plan" };
  const price = toMicros(step.product.priceUsd);
  if (price > toMicros(plan.perTxCapUsd)) return { ok: false, code: "over_per_tx_cap", detail: `$${step.product.priceUsd} is over the $${plan.perTxCapUsd} per-payment cap` };
  if (toMicros(spentUsd) + price > toMicros(plan.totalUsd)) return { ok: false, code: "over_budget", detail: `$${step.product.priceUsd} would take spending past the approved $${plan.totalUsd}` };
  return { ok: true };
}

/** Does the merchant's live 402 ask for what the catalog promised? */
export function checkChallenge(step: PlanStep, challenge: Challenge | undefined, catalog: Pick<Catalog, "network" | "asset">): Decision {
  if (!challenge) return { ok: false, code: "no_payment_challenge", detail: "the merchant did not answer with an x402 payment request" };
  if (challenge.network !== catalog.network) return { ok: false, code: "wrong_network", detail: `the merchant asked for payment on ${challenge.network}, not ${catalog.network}` };
  if (challenge.asset.toLowerCase() !== catalog.asset.address.toLowerCase()) return { ok: false, code: "wrong_asset", detail: `the merchant asked for an unexpected token ${challenge.asset}` };
  if (!challenge.priceUsd || !sameAmount(challenge.priceUsd, step.product.priceUsd)) {
    return { ok: false, code: "price_changed", detail: `the merchant now asks $${challenge.priceUsd ?? "?"} instead of the listed $${step.product.priceUsd}` };
  }
  return { ok: true };
}

/** The HTTP request for a step: GET inputs go in the query, POST inputs in a JSON body. */
export function stepRequest(step: PlanStep): { url: string; method: "GET" | "POST"; body?: Record<string, string> } {
  if (step.product.method === "GET") {
    const url = new URL(step.product.url);
    for (const [k, v] of Object.entries(step.inputs)) url.searchParams.set(k, v);
    return { url: url.toString(), method: "GET" };
  }
  return { url: step.product.url, method: "POST", body: step.inputs };
}
