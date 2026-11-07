import { createHash, randomUUID } from "node:crypto";
import { fromMicros, toMicros } from "../money.js";
import type { KpassResult, KpassRunner, Transcript } from "./runner.js";
import type { AllowedEndpoint, Delegation, KpassEnvelope, SessionRecord } from "./types.js";

/**
 * A local stand-in for kpass used when the CLI is not installed or not logged in.
 * It mirrors the documented JSON envelopes and enforces the session caps, so the
 * agent loop and the demo run with zero credentials. It never moves real funds.
 */

export interface PreflightResult {
  /** HTTP status of the unpaid request; 402 means a payment is required. */
  status: number;
  /** Price in the session's budget currency (USD), as a decimal string. */
  price?: string;
  asset?: string;
  /** CAIP-2 network the merchant advertises, e.g. eip155:2368. */
  network?: string;
  /** Body the merchant returns once paid, when known up front. */
  paidBody?: unknown;
  /**
   * Completes the purchase after the caps pass, e.g. against a merchant running the
   * simulated facilitator. Never called for a refused payment.
   */
  pay?: () => Promise<{ status: number; body: unknown }>;
}

export type Preflight = (request: { url: string; method: string; headers?: Record<string, string>; body?: string }) => Promise<PreflightResult>;

export interface SimOptions {
  preflight?: Preflight;
  /** When false, approval requests stay pending until approve() is called. */
  autoApprove?: boolean;
  /** Network reported when a merchant does not advertise one. */
  defaultNetwork?: string;
  walletBalance?: string;
  /**
   * Refuse calls outside the session's allowed_endpoints. Off by default, like live
   * Passport, which records the endpoint scope but does not enforce it on paid calls.
   */
  enforceEndpointScope?: boolean;
  transcript?: Transcript;
  now?: () => number;
}

interface SimRequest {
  id: string;
  delegation: Delegation;
  state: "pending" | "approved" | "rejected";
  sessionId?: string;
}

interface SimSession extends SessionRecord {
  spent: bigint;
}

const EXIT = { ok: 0, usage: 2, auth: 3, allowance: 4, policy: 6 } as const;

export function endpointMatches(endpoint: AllowedEndpoint, method: string, url: URL): boolean {
  return endpoint.method.toUpperCase() === method.toUpperCase() && endpoint.host.toLowerCase() === url.host.toLowerCase() && url.pathname.startsWith(endpoint.path_prefix);
}

function chainIdOf(network: string | undefined): number | undefined {
  const match = /^eip155:(\d+)$/.exec(network ?? "");
  return match ? Number(match[1]) : undefined;
}

interface ParsedArgs {
  words: string[];
  flags: Map<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(["--separate", "--preview", "--wait", "--no-reuse", "--no-browser", "--no-interactive", "--use-allowance", "--version", "--help"]);

function parseArgs(args: string[]): ParsedArgs {
  const words: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--")) {
      words.push(arg);
    } else if (BOOLEAN_FLAGS.has(arg)) {
      flags.set(arg, true);
    } else {
      flags.set(arg, args[i + 1] ?? "");
      i++;
    }
  }
  return { words, flags };
}

export class SimKpass implements KpassRunner {
  readonly mode = "sim" as const;
  private readonly requests = new Map<string, SimRequest>();
  private readonly sessions = new Map<string, SimSession>();
  private readonly settled = new Map<string, KpassEnvelope>();
  private currentSessionId: string | undefined;
  private readonly now: () => number;
  private counter = 0;

  private readonly options: SimOptions;

  constructor(options: SimOptions = {}) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Approves a pending request, as the user would with their passkey. */
  approve(requestId: string): void {
    const request = this.requests.get(requestId);
    if (request) this.activate(request);
  }

  reject(requestId: string): void {
    const request = this.requests.get(requestId);
    if (request) request.state = "rejected";
  }

  async run(args: string[]): Promise<KpassResult> {
    const started = this.now();
    const [exitCode, envelope] = await this.dispatch(parseArgs(args));
    const result: KpassResult = { args, exitCode, envelope, stdout: JSON.stringify(envelope), stderr: "", durationMs: this.now() - started, mode: "sim" };
    await this.options.transcript?.record(result);
    return result;
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_sim${String(this.counter).padStart(4, "0")}`;
  }

  private async dispatch({ words, flags }: ParsedArgs): Promise<[number, KpassEnvelope]> {
    if (flags.has("--version")) return [EXIT.ok, { status: "success", text: "kpass (pursestrings simulator)" }];
    const command = words.join(" ");
    switch (command) {
      case "status":
        return [EXIT.ok, { _version: "1", status: "success", backend: "simulator", authenticated: true, agent_registered: true, current_session_id: this.currentSessionId ?? null, sandbox: true }];
      case "sandbox status":
        return [EXIT.ok, { _version: "1", status: "success", sandbox: true, hint: "The simulator is always sandboxed; no funds move." }];
      case "health":
        return [EXIT.ok, { _version: "1", status: "success", backend: "simulator" }];
      case "me":
        return [EXIT.ok, { _version: "1", status: "success", email: "sim@pursestrings.local", user_id: "user_sim" }];
      case "wallet balance":
        return [EXIT.ok, { _version: "1", status: "success", wallet_address: "0x5150000000000000000000000000000000000001", balances: [{ asset: "USDC", amount: this.options.walletBalance ?? "25.00", network: this.options.defaultNetwork ?? "simulated" }] }];
      case "session create":
        return this.create(flags);
      case "session status":
        return this.status(flags);
      case "session list":
        return [EXIT.ok, { _version: "1", status: "success", sessions: [...this.sessions.values()].map(({ spent: _spent, ...s }) => s) }];
      case "session use": {
        const id = String(flags.get("--session-id") ?? "");
        if (!this.sessions.has(id)) return [EXIT.usage, { _version: "1", status: "error", error: `unknown session ${id}`, error_code: "session_not_found" }];
        this.currentSessionId = id;
        return [EXIT.ok, { _version: "1", status: "success", current_session_id: id }];
      }
      case "session execute":
        return this.execute(flags);
      default:
        return [EXIT.usage, { _version: "1", status: "error", error: `simulator does not implement "kpass ${command}"`, error_code: "unknown_command" }];
    }
  }

  private create(flags: Map<string, string | true>): [number, KpassEnvelope] {
    const raw = flags.get("--delegation");
    if (typeof raw !== "string") return [EXIT.usage, { _version: "1", status: "error", error: "--delegation is required", error_code: "invalid_delegation" }];
    let delegation: Delegation;
    try {
      delegation = JSON.parse(raw) as Delegation;
      toMicros(delegation.payment_policy.max_amount_per_tx);
      if (delegation.payment_policy.max_total_amount) toMicros(delegation.payment_policy.max_total_amount);
      if (!delegation.task.summary || !(delegation.payment_policy.ttl_seconds > 0)) throw new Error("missing fields");
    } catch (error) {
      return [EXIT.usage, { _version: "1", status: "error", error: `invalid delegation: ${(error as Error).message}`, error_code: "invalid_delegation" }];
    }
    const policy = delegation.payment_policy;
    const caps = `up to USD ${policy.max_amount_per_tx} per call and USD ${policy.max_total_amount ?? "unlimited"} in total for ${Math.round(policy.ttl_seconds / 60)} minutes`;
    if (!flags.has("--separate") && !flags.has("--preview")) {
      return [EXIT.allowance, { _version: "1", status: "error", error: "The account allowance cannot pay: no allowance is set up.", error_code: "allowance_unavailable", hint: "Ask the user before creating a separate session.", next_command: "kpass session create --delegation '<JSON>' --separate --preview --output json" }];
    }
    if (flags.has("--preview")) {
      return [EXIT.ok, { _version: "1", status: "success", preview: true, user_message: `I can ask for a separate spending limit: ${caps}. A passkey page will open for you to approve. Should I set it up?`, on_yes_command: "kpass session create --delegation '<JSON>' --separate --output json", caps: { max_amount_per_tx: policy.max_amount_per_tx, max_total_amount: policy.max_total_amount, validity: `${policy.ttl_seconds} seconds` }, next_command: "" }];
    }
    const request: SimRequest = { id: this.nextId("req"), delegation, state: "pending" };
    this.requests.set(request.id, request);
    const approvalUrl = `sim://agentpassport/approve/${request.id}`;
    return [EXIT.ok, { _version: "1", status: "human_action_required", action: "approve_session", request_id: request.id, approval_url: approvalUrl, expires_at: new Date(this.now() + 10 * 60_000).toISOString(), user_message: `Approve with your passkey: ${approvalUrl}. It allows ${caps}. (simulated)`, reply_first: true, browser_opened: false, wait_command: `kpass session status --request-id ${request.id} --wait --output json`, next_command: "" }];
  }

  private activate(request: SimRequest): SimSession {
    if (request.sessionId) return this.sessions.get(request.sessionId)!;
    const session: SimSession = {
      id: this.nextId("session"),
      status: "active",
      expires_at: new Date(this.now() + request.delegation.payment_policy.ttl_seconds * 1000).toISOString(),
      delegation: request.delegation,
      usage: { spent_total: "0.00", reserved_total: "0.00" },
      spent: 0n,
    };
    this.sessions.set(session.id, session);
    request.state = "approved";
    request.sessionId = session.id;
    this.currentSessionId = session.id;
    return session;
  }

  private status(flags: Map<string, string | true>): [number, KpassEnvelope] {
    const id = String(flags.get("--request-id") ?? "");
    const request = this.requests.get(id);
    if (!request) return [EXIT.usage, { _version: "1", status: "error", error: `unknown request ${id}`, error_code: "request_not_found" }];
    if (request.state === "pending" && flags.has("--wait") && this.options.autoApprove !== false) this.activate(request);
    if (request.state === "rejected") return [EXIT.auth, { _version: "1", status: "error", error: "Session request was rejected by the user.", next_command: "" }];
    if (request.state === "pending") return [EXIT.ok, { _version: "1", status: "pending", request_id: id, user_message: "Still waiting for passkey approval (simulated).", next_command: "" }];
    const { spent: _spent, ...session } = this.sessions.get(request.sessionId!)!;
    return [EXIT.ok, { _version: "1", status: "success", request_id: id, session_id: session.id, session, current_session_id: session.id, hint: `Session approved and set as current. Expires at ${session.expires_at}.`, next_command: "" }];
  }

  private async execute(flags: Map<string, string | true>): Promise<[number, KpassEnvelope]> {
    const rawUrl = flags.get("--url");
    if (typeof rawUrl !== "string" || !rawUrl) return [EXIT.usage, { _version: "1", status: "error", error: "Missing --url flag", error_code: "missing_url" }];
    const method = String(flags.get("--method") ?? "POST").toUpperCase();
    const key = flags.get("--idempotency-key");
    if (typeof key === "string" && this.settled.has(key)) return [EXIT.ok, this.settled.get(key)!];

    const sessionId = typeof flags.get("--session-id") === "string" ? String(flags.get("--session-id")) : this.currentSessionId;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || Date.parse(session.expires_at) <= this.now()) {
      return [EXIT.allowance, { _version: "1", status: "error", error: "No usable session and no account allowance.", error_code: "allowance_unavailable" }];
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return [EXIT.usage, { _version: "1", status: "error", error: `invalid --url ${rawUrl}`, error_code: "invalid_url" }];
    }
    const scope = session.delegation.execution_constraints?.x402;
    if (this.options.enforceEndpointScope && scope?.scope_mode === "scoped" && !scope.allowed_endpoints.some((e) => endpointMatches(e, method, url))) {
      return [EXIT.policy, { _version: "1", status: "error", error: `${method} ${url.host}${url.pathname} is not in the session's allowed endpoints.`, error_code: "session_endpoint_forbidden" }];
    }

    const headersRaw = flags.get("--headers");
    const body = flags.get("--body");
    if (!this.options.preflight) {
      return [EXIT.usage, { _version: "1", status: "error", error: "The simulator has no merchant preflight configured.", error_code: "no_payment_requirement" }];
    }
    const preflight = await this.options.preflight({
      url: rawUrl,
      method,
      headers: typeof headersRaw === "string" ? (JSON.parse(headersRaw) as Record<string, string>) : undefined,
      body: typeof body === "string" ? body : undefined,
    });
    if (preflight.status !== 402 || !preflight.price) {
      return [EXIT.usage, { _version: "1", status: "error", error: `Merchant returned HTTP ${preflight.status} with no x402 price.`, error_code: "no_payment_requirement" }];
    }
    const price = toMicros(preflight.price);
    const policy = session.delegation.payment_policy;
    if (price > toMicros(policy.max_amount_per_tx)) {
      return [EXIT.policy, { _version: "1", status: "error", error: `Payment of ${preflight.price} exceeds the per-transaction limit of ${policy.max_amount_per_tx}.`, error_code: "session_rule_exceeded" }];
    }
    const spent = session.spent;
    if (policy.max_total_amount && spent + price > toMicros(policy.max_total_amount)) {
      return [EXIT.policy, { _version: "1", status: "error", error: `Payment of ${preflight.price} would take total spend past the budget of ${policy.max_total_amount}.`, error_code: "session_total_exceeded" }];
    }
    let paid: { status: number; body: unknown } | undefined;
    if (preflight.pay) {
      paid = await preflight.pay();
      if (paid.status < 200 || paid.status >= 300) {
        // Like a real merchant failure before settlement: nothing is charged.
        return [1, { _version: "1", status: "error", error: `Merchant answered HTTP ${paid.status}; nothing was charged.`, error_code: "merchant_request_failed", details: { body: paid.body } }];
      }
    }
    session.spent = spent + price;
    session.usage = { spent_total: fromMicros(spent + price), reserved_total: "0.00" };
    const network = preflight.network ?? this.options.defaultNetwork;
    const opKey = typeof key === "string" ? key : randomUUID();
    // Labelled sim_ so it can never be mistaken for an on-chain transaction.
    const txHash = `sim_${createHash("sha256").update(`${session.id}:${opKey}`).digest("hex").slice(0, 32)}`;
    const responseBody = paid?.body ?? (preflight.paidBody === undefined ? { simulated: true } : preflight.paidBody);
    const envelope: KpassEnvelope = {
      _version: "1",
      status: "success",
      session_id: session.id,
      session_status: "active",
      delegation: session.delegation,
      usage: session.usage,
      payment_requirement: { asset: preflight.asset ?? "USDC", amount: preflight.price },
      x402: {
        status_code: 200,
        response_body: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
        parsed_response_body: typeof responseBody === "string" ? undefined : responseBody,
        wallet_address: "0x5150000000000000000000000000000000000001",
        chain_id: chainIdOf(network),
        network,
        tx_hash: txHash,
        simulated: true,
      },
      hint: `x402 request to ${rawUrl} completed with HTTP 200 (simulated settlement).`,
      next_command: "",
    };
    if (typeof key === "string") this.settled.set(key, envelope);
    return [EXIT.ok, envelope];
  }
}
