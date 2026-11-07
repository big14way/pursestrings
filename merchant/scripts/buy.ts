/**
 * Dev check: pay one merchant URL directly with x402 from a self-custodied testnet
 * wallet (DEV_BUYER_KEY), so the Pieverse facilitator settles on the Kite testnet.
 * This bypasses Kite Passport on purpose; it proves the merchant settles for real.
 *
 *   node --env-file=../.env scripts/buy.ts <url> [GET|POST] ['{"phone":"+2348012345678"}']
 */
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const PIEUSD = "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A";
/** Never pay more than 1 pieUSD in one call from the test wallet. */
const MAX_ATOMIC = "1000000000000000000";

const [url, method = "GET", body] = process.argv.slice(2);
const key = process.env.DEV_BUYER_KEY;
if (!url) throw new Error("usage: buy.ts <url> [GET|POST] [json body]");
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("DEV_BUYER_KEY is missing from the environment");

const account = privateKeyToAccount(key as `0x${string}`);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
client.setSpendControls({ allowedAssets: [{ network: "eip155:2368", asset: PIEUSD, maxAmountPerPayment: MAX_ATOMIC }] });
const payingFetch = wrapFetchWithPayment(fetch, client);

console.log(`buyer ${account.address} -> ${method} ${url}`);
const response = await payingFetch(url, {
  method,
  headers: body ? { "content-type": "application/json" } : undefined,
  body,
});
console.log(`HTTP ${response.status}`);
const receipt = response.headers.get("payment-response");
if (receipt) console.log("settlement", JSON.stringify(decodePaymentResponseHeader(receipt)));
console.log((await response.text()).slice(0, 1500));
