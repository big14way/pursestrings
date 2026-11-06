import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Config } from "../config.js";
import { KpassError } from "./errors.js";
import { createLiveRunner, Transcript, type KpassResult, type KpassRunner } from "./runner.js";
import { SimKpass, type SimOptions } from "./sim.js";
import type { ApprovalRequested, Delegation, ExecuteSucceeded, KpassEnvelope, SessionApproved, SessionPreview } from "./types.js";

export interface ExecuteRequest {
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  /** Same key on every retry of one payment; a fresh one per new payment. */
  idempotencyKey?: string;
  sessionId?: string;
}

export type ApprovalOutcome = { state: "approved"; approved: SessionApproved } | { state: "pending"; envelope: KpassEnvelope };

/** Statuses that mean "the call worked" even though nothing settled yet. */
const NON_ERROR_STATUSES = new Set(["success", "human_action_required", "pending"]);

export class Passport {
  constructor(readonly runner: KpassRunner) {}

  get mode() {
    return this.runner.mode;
  }

  /** Runs a command and throws a KpassError on any error envelope or non-zero exit. */
  async call<T extends KpassEnvelope = KpassEnvelope>(args: string[]): Promise<T> {
    const result = await this.runner.run(args);
    return expectOk<T>(result);
  }

  /** Runs a command and returns the raw result, errors included. Used by doctor. */
  probe(args: string[]): Promise<KpassResult> {
    return this.runner.run(args);
  }

  status() {
    return this.call(["status"]);
  }

  me() {
    return this.call(["me"]);
  }

  walletBalance() {
    return this.call(["wallet", "balance"]);
  }

  /** Asks kpass to phrase the approval question. Sends nothing. */
  previewSession(delegation: Delegation) {
    return this.call<SessionPreview>(["session", "create", "--delegation", JSON.stringify(delegation), "--separate", "--preview"]);
  }

  /** Creates the passkey approval request for a new, separately approved session. */
  requestSession(delegation: Delegation) {
    return this.call<ApprovalRequested>(["session", "create", "--delegation", JSON.stringify(delegation), "--separate", "--no-reuse"]);
  }

  /** Polls until the user approves (kpass waits up to five minutes). */
  async waitForApproval(requestId: string): Promise<ApprovalOutcome> {
    const envelope = await this.call(["session", "status", "--request-id", requestId, "--wait"]);
    if (envelope.status === "success" && typeof envelope.session_id === "string") return { state: "approved", approved: envelope as SessionApproved };
    return { state: "pending", envelope };
  }

  execute(request: ExecuteRequest) {
    const args = ["session", "execute", "--url", request.url, "--method", request.method, "--idempotency-key", request.idempotencyKey ?? randomUUID()];
    if (request.headers) args.push("--headers", JSON.stringify(request.headers));
    if (request.body !== undefined) args.push("--body", JSON.stringify(request.body));
    if (request.sessionId) args.push("--session-id", request.sessionId);
    return this.call<ExecuteSucceeded>(args);
  }
}

export function expectOk<T extends KpassEnvelope>(result: KpassResult): T {
  const { envelope, exitCode } = result;
  if (exitCode !== 0 || !NON_ERROR_STATUSES.has(envelope.status)) {
    throw new KpassError(envelope, exitCode, result.args.filter((a) => !a.startsWith("{")).slice(0, 3).join(" "));
  }
  return envelope as T;
}

export function createPassport(config: Config, simOptions: SimOptions = {}): Passport {
  const transcript = new Transcript(join(config.stateDir, "kpass-transcript.jsonl"));
  if (config.kpass.mode === "live" && config.kpass.bin) {
    return new Passport(createLiveRunner({ bin: config.kpass.bin, timeoutMs: config.kpass.timeoutMs, transcript }));
  }
  return new Passport(new SimKpass({ transcript, ...simOptions }));
}
