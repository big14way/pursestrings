/**
 * Shapes of `kpass ... --output json` replies, taken from the Kite passport-skills
 * command references. Every reply carries the common envelope fields.
 */

export type EnvelopeStatus = "success" | "error" | "human_action_required" | "pending";

export interface KpassEnvelope {
  _version?: string;
  status: EnvelopeStatus | (string & {});
  error?: string;
  error_code?: string;
  hint?: string;
  next_command?: string;
  user_message?: string;
  [key: string]: unknown;
}

export interface AllowedEndpoint {
  method: string;
  host: string;
  path_prefix: string;
}

/** The inner delegation object; kpass wraps it in {"delegation": ...} itself. */
export interface Delegation {
  task: { summary: string };
  payment_policy: {
    max_amount_per_tx: string;
    max_total_amount?: string;
    ttl_seconds: number;
    currency?: string;
  };
  execution_constraints?: {
    x402: { scope_mode: "scoped"; allowed_endpoints: AllowedEndpoint[] };
  };
}

export interface SessionUsage {
  spent_total: string;
  reserved_total: string;
}

export interface SessionRecord {
  id: string;
  status: string;
  expires_at: string;
  delegation: Delegation;
  usage: SessionUsage;
}

/** `session create --separate`: the user must approve with a passkey. */
export interface ApprovalRequested extends KpassEnvelope {
  status: "human_action_required";
  request_id: string;
  approval_url: string;
  expires_at: string;
  wait_command?: string;
}

/** `session create --separate --preview`: nothing sent, a question for the user. */
export interface SessionPreview extends KpassEnvelope {
  preview: true;
  on_yes_command: string;
  caps?: { max_amount_per_tx?: string; max_total_amount?: string; validity?: string };
}

/** `session status --wait` once the user approved. */
export interface SessionApproved extends KpassEnvelope {
  status: "success";
  request_id: string;
  session_id: string;
  session: SessionRecord;
}

/** `session execute` after a settled x402 call. */
export interface ExecuteSucceeded extends KpassEnvelope {
  status: "success";
  session_id?: string;
  usage?: SessionUsage;
  payment_requirement?: { asset?: string; amount?: string };
  x402: {
    status_code: number;
    response_body?: string;
    parsed_response_body?: unknown;
    wallet_address?: string;
    /** Numeric chain id the payment settled on; absent for Solana. */
    chain_id?: number;
    [key: string]: unknown;
  };
}
