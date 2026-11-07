import { createHash } from "node:crypto";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SupportedResponse } from "@x402/core/types";

/**
 * A stand-in facilitator for local, zero-credential runs. It checks that the payment
 * matches the challenge but verifies no signature and moves no funds. Settlements are
 * labelled "sim_" so they can never be mistaken for on-chain transactions.
 * The merchant refuses to start with it on a hosted deployment.
 */
export interface SimulatedSettlement {
  transaction: string;
  network: string;
  payTo: string;
  /** Atomic amount of the asset. */
  amount: string;
}

export function createSimulatedFacilitator(network: `${string}:${string}`): FacilitatorClient & { readonly settlements: SimulatedSettlement[] } {
  const settlements: SimulatedSettlement[] = [];
  const supported: SupportedResponse = { kinds: [{ x402Version: 2, scheme: "exact", network }], extensions: [], signers: {} };

  const check = (payload: PaymentPayload, requirements: PaymentRequirements): string | undefined => {
    const accepted = payload.accepted;
    if (!accepted) return "missing_accepted_requirements";
    if (accepted.network !== requirements.network || accepted.asset !== requirements.asset) return "network_or_asset_mismatch";
    if (accepted.payTo.toLowerCase() !== requirements.payTo.toLowerCase()) return "pay_to_mismatch";
    if (accepted.amount !== requirements.amount) return "amount_mismatch";
    return undefined;
  };

  const payerOf = (payload: PaymentPayload): string | undefined => {
    const auth = (payload.payload as { authorization?: { from?: unknown } } | undefined)?.authorization;
    return typeof auth?.from === "string" ? auth.from : undefined;
  };

  return {
    settlements,
    getSupported: async () => supported,
    verify: async (payload, requirements) => {
      const reason = check(payload, requirements);
      return reason ? { isValid: false, invalidReason: reason } : { isValid: true, payer: payerOf(payload) };
    },
    settle: async (payload, requirements) => {
      const reason = check(payload, requirements);
      if (reason) return { success: false, errorReason: reason, transaction: "", network: requirements.network };
      const transaction = `sim_${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32)}`;
      settlements.push({ transaction, network: requirements.network, payTo: requirements.payTo, amount: requirements.amount });
      return { success: true, transaction, network: requirements.network, payer: payerOf(payload) };
    },
  };
}
