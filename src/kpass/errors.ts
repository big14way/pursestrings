import type { KpassEnvelope } from "./types.js";

export type ErrorKind = "policy" | "funds" | "merchant" | "auth" | "pending" | "usage" | "transient" | "unknown";

export interface ErrorInfo {
  kind: ErrorKind;
  /** Short label for the ledger and the terminal. */
  title: string;
  /** What PurseStrings tells the user to do next. */
  remedy: string;
}

/**
 * Error codes documented for `kpass session create` and `kpass session execute`.
 * Policy errors are the ones the demo surfaces: the session itself refused to pay.
 */
export const KNOWN_ERRORS: Record<string, ErrorInfo> = {
  session_rule_exceeded: { kind: "policy", title: "Over the per-transaction cap", remedy: "Raise the per-transaction cap in a new session, or skip this step." },
  session_total_exceeded: { kind: "policy", title: "Over the session budget", remedy: "Approve a new session with a larger budget, or stop here." },
  separate_session_used_up: { kind: "policy", title: "Session budget used up", remedy: "Approve a new session, or stop here." },
  session_endpoint_forbidden: { kind: "policy", title: "Endpoint outside the approved scope", remedy: "Approve a session that includes this merchant, or skip it." },
  session_asset_forbidden: { kind: "policy", title: "Asset not allowed by the session", remedy: "Approve a session that allows this asset, or skip it." },
  payment_target_forbidden: { kind: "merchant", title: "Merchant not in Kite's payable catalog", remedy: "Skip this merchant; Passport only pays hosts listed in the Kite catalog (ksearch service list) or allowlisted for the account." },
  merchant_not_allowed: { kind: "merchant", title: "Merchant not allowlisted by Passport", remedy: "Skip this merchant, or check it is listed in the Kite catalog." },
  payment_cap_exceeded: { kind: "policy", title: "Over the Passport system cap", remedy: "Choose a cheaper option." },
  payment_redirect_not_allowed: { kind: "merchant", title: "Merchant redirected during payment", remedy: "Use the merchant's final URL." },
  merchant_request_failed: { kind: "merchant", title: "Merchant failed before settlement", remedy: "Nothing was charged; check the order details and try again." },
  no_payment_requirement: { kind: "merchant", title: "Merchant asked for no payment", remedy: "Check the HTTP method for this endpoint." },
  merchant_unsupported: { kind: "merchant", title: "Merchant payment scheme unsupported", remedy: "Skip this merchant." },
  insufficient_balance: { kind: "funds", title: "Wallet balance too low", remedy: "Fund the Passport wallet (testnet: kpass faucet drop)." },
  wallet_empty: { kind: "funds", title: "Wallet is empty", remedy: "Fund the Passport wallet (testnet: kpass faucet drop)." },
  allowance_unavailable: { kind: "policy", title: "No account allowance", remedy: "Approve a separate session for this task." },
  allowance_disabled: { kind: "policy", title: "Allowance turned off for this agent", remedy: "Approve a separate session for this task." },
  allowance_too_small: { kind: "policy", title: "Allowance cannot cover this price", remedy: "Approve a separate session for this task." },
  recurring_budget_exhausted: { kind: "policy", title: "Allowance used up", remedy: "Wait for the reset or approve a separate session." },
  idempotency_key_required: { kind: "usage", title: "Missing idempotency key", remedy: "Internal error: every payment must carry a key." },
  payment_outcome_pending: { kind: "pending", title: "Payment outcome pending", remedy: "Retry once later with the same idempotency key." },
  recurring_payment_unknown: { kind: "pending", title: "Payment outcome unknown", remedy: "Retry once later with the same idempotency key." },
  payment_not_settled: { kind: "pending", title: "Payment not settled", remedy: "Retry once later with the same idempotency key." },
  provider_unavailable: { kind: "transient", title: "Passport provider unavailable", remedy: "Try again shortly." },
  sandbox_mode_forbidden: { kind: "usage", title: "Not available in sandbox mode", remedy: "Run kpass sandbox off, or stay on x402." },
};

export class KpassError extends Error {
  readonly code: string;
  readonly info: ErrorInfo;
  readonly envelope: KpassEnvelope;
  readonly exitCode: number;
  readonly command: string;

  constructor(envelope: KpassEnvelope, exitCode: number, command: string) {
    const code = envelope.error_code ?? (exitCode === 3 ? "not_authorized" : "unknown_error");
    super(envelope.error ?? envelope.hint ?? `kpass ${command} failed with exit code ${exitCode}`);
    this.name = "KpassError";
    this.envelope = envelope;
    this.exitCode = exitCode;
    this.command = command;
    this.code = code;
    this.info = describeError(code);
  }

  get isPolicyRefusal(): boolean {
    return this.info.kind === "policy";
  }

  /** The message without kpass's trailing key="value" list, keeping the reason. */
  get plainMessage(): string {
    return plainMessage(this.message);
  }
}

/**
 * kpass refusals end with a list like (url="…", host="…", reason="host_not_in_executable_catalog").
 * The sentence and the reason are what a person needs; the URL is in the ledger already.
 */
export function plainMessage(message: string): string {
  const m = /^(.*?)\s*\(((?:\s*[\w-]+="[^"]*"\s*,?)+)\)\s*\.?\s*$/s.exec(message);
  if (!m?.[1]) return message;
  const reason = /\breason="([^"]*)"/.exec(m[2] ?? "")?.[1];
  return reason ? `${m[1]} (${reason})` : m[1];
}

export function describeError(code: string): ErrorInfo {
  return KNOWN_ERRORS[code] ?? { kind: "unknown", title: code.replaceAll("_", " "), remedy: "See the kpass hint for details." };
}
