/** Exact USD arithmetic in micro-units (6 decimals), so caps never drift with floats. */

export function toMicros(amount: string): bigint {
  const value = amount.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`not a decimal amount: ${amount}`);
  const [whole = "0", frac = ""] = value.split(".");
  if (frac.length > 6 && /[1-9]/.test(frac.slice(6))) throw new Error(`more than 6 decimal places: ${amount}`);
  return BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}

export function fromMicros(micros: bigint): string {
  const whole = micros / 1_000_000n;
  const frac = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac.length === 0 ? `${whole}.00` : frac.length === 1 ? `${whole}.${frac}0` : `${whole}.${frac}`;
}

export function sumUsd(amounts: string[]): string {
  return fromMicros(amounts.reduce((acc, a) => acc + toMicros(a), 0n));
}

export function maxUsd(amounts: string[]): string {
  return fromMicros(amounts.reduce((acc, a) => (toMicros(a) > acc ? toMicros(a) : acc), 0n));
}
