import obyte from "obyte";
import {
  getBase64Hash,
  getHeadersSize,
  getTotalPayloadSize,
  getUnitHash,
  getUnitHashToSign,
  verify,
} from "obyte/lib/internal.js";
import {
  BYTES_ASSET,
  DEFAULT_MAX_UNIT_BYTES,
  ERR_AMOUNT,
  ERR_ASSET,
  ERR_BINDING,
  ERR_COMMISSIONS,
  ERR_DEFINITION,
  ERR_DEFINITION_REQUIRED,
  ERR_NETWORK,
  ERR_PAYER,
  ERR_PAYLOAD_HASH,
  ERR_RECIPIENT,
  ERR_SIGNATURE,
  ERR_UNIT_HASH,
  ERR_UNIT_TOO_LARGE,
  ERR_UNSUPPORTED_UNIT,
  type ObyteNetwork,
  UNIT_VERSIONS,
} from "./constants";
import type { Check, ExactUnitFacts, InputRef, SigDefinition } from "./types";
import { fail, hasOnlyKeys, isAddress, isAssetId, isHash, isPlainObject, pass } from "./utils";

/** What the payment unit must pay, from the requirements. */
export interface ExactUnitExpectation {
  readonly network: ObyteNetwork;
  readonly payTo: string;
  /** `base` or an asset id. */
  readonly asset: string;
  readonly amount: bigint;
  readonly binding: string;
  readonly quoteId: string;
  /** The facilitator's own addresses: they must never be the payer. */
  readonly facilitatorAddresses?: readonly string[];
  readonly maxUnitBytes?: number;
}

const UNIT_KEYS = new Set([
  "version",
  "alt",
  "messages",
  "authors",
  "parent_units",
  "last_ball",
  "last_ball_unit",
  "timestamp",
  "headers_commission",
  "payload_commission",
  "tps_fee",
  "burn_fee",
  "max_aa_responses",
  "unit",
]);
const AUTHOR_KEYS = new Set(["address", "authentifiers", "definition"]);
const MESSAGE_KEYS = new Set(["app", "payload_location", "payload_hash", "payload"]);
const PAYMENT_KEYS = new Set(["asset", "inputs", "outputs"]);
const INPUT_KEYS = new Set(["unit", "message_index", "output_index"]);
const OUTPUT_KEYS = new Set(["address", "amount"]);
const X402_DATA_KEYS = new Set(["binding", "quoteId"]);

/** Length of one base64 secp256k1 signature, as counted by obyte.js. */
const SIGNATURE_SIZE = 88;

const isIndex = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isPositiveAmount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/**
 * Whether a value is a single-signature definition `['sig', {pubkey}]`.
 *
 * @param value - Candidate definition.
 * @returns True for the supported definition profile.
 */
export function isSigDefinition(value: unknown): value is SigDefinition {
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== "sig") return false;
  const params: unknown = value[1];
  return (
    isPlainObject(params) &&
    hasOnlyKeys(params, new Set(["pubkey"])) &&
    typeof params["pubkey"] === "string" &&
    params["pubkey"].length === 44
  );
}

/**
 * Commissions ocore expects for an already signed single-author unit (sizes
 * counted with keys). obyte.js `getHeadersSize` adds one signature for the
 * unsigned unit; on a signed unit it is already counted, so it is subtracted.
 *
 * @param unit - Signed unit.
 * @returns Expected headers and payload commissions.
 */
export function expectedCommissions(unit: object): { headers: number; payload: number } {
  return {
    headers: getHeadersSize(unit, true) - SIGNATURE_SIZE,
    payload: getTotalPayloadSize(unit, true),
  };
}

/**
 * Ledger-independent validation of a client-signed unit against the supported
 * profile: structure and size, network, unit and payload hashes, author
 * definition and signature, message set, outputs, the signed binding and the
 * commissions. Anything outside the profile is rejected. The order of the
 * checks is part of the contract: the first failing one decides the reason.
 *
 * @param unit - The unit from the payment payload.
 * @param expect - What the unit must pay.
 * @param options - Author definition read from the ledger, when not embedded.
 * @param options.authorDefinition - Definition of the author address.
 * @returns The unit facts, or the first failed check.
 */
export function validateExactUnit(
  unit: unknown,
  expect: ExactUnitExpectation,
  options: { authorDefinition?: SigDefinition } = {},
): Check<ExactUnitFacts> {
  const shaped = checkShape(unit, expect);
  if (!shaped.ok) return shaped;
  const u = shaped.value;
  const hashed = checkUnitHash(u);
  if (!hashed.ok) return hashed;
  const { unitHash, messages, authors } = hashed.value;
  const author = checkAuthor(u, authors, options.authorDefinition);
  if (!author.ok) return author;
  const { payer, definitionFromLedger } = author.value;
  if (payer === expect.payTo) return fail(ERR_PAYER, "Payer and payTo must differ");
  if (expect.facilitatorAddresses?.includes(payer)) {
    return fail(ERR_PAYER, "A facilitator address must never be the payer");
  }
  const payments = checkMessages(messages, expect);
  if (!payments.ok) return payments;
  const transfers = checkTransfers(payments.value, payer, expect);
  if (!transfers.ok) return transfers;
  const commissions = expectedCommissions(u);
  if (
    commissions.headers !== u["headers_commission"] ||
    commissions.payload !== u["payload_commission"]
  ) {
    return fail(ERR_COMMISSIONS, "Commissions do not match the unit size");
  }
  return pass({
    unitHash,
    payer,
    inputs: transfers.value.inputs,
    lastBallUnit: u["last_ball_unit"] as string,
    parentUnits: u["parent_units"] as string[],
    timestamp: u["timestamp"] as number,
    outputTotals: transfers.value.outputTotals,
    commissions,
    definitionFromLedger,
  });
}

/**
 * A failure for a unit outside the supported profile.
 *
 * @param why - What is outside the profile.
 * @returns The failure.
 */
function unsupported(why: string): { ok: false; reason: string; message: string } {
  return fail(ERR_UNSUPPORTED_UNIT, why);
}

/**
 * Structure, size, network and header fields.
 *
 * @param unit - Candidate unit.
 * @param expect - Expected network and size limit.
 * @returns The unit as a record, or the failure.
 */
function checkShape(unit: unknown, expect: ExactUnitExpectation): Check<Record<string, unknown>> {
  if (!isPlainObject(unit)) return unsupported("Unit must be an object");
  let serialized: string;
  try {
    serialized = JSON.stringify(unit);
  } catch {
    return unsupported("Unit is not serializable");
  }
  if (serialized.length > (expect.maxUnitBytes ?? DEFAULT_MAX_UNIT_BYTES)) {
    return fail(ERR_UNIT_TOO_LARGE, "Unit exceeds the size limit");
  }
  if (!hasOnlyKeys(unit, UNIT_KEYS)) return unsupported("Unit has fields outside the profile");

  const version = UNIT_VERSIONS[expect.network];
  if (unit["version"] !== version.version || unit["alt"] !== version.alt) {
    return fail(ERR_NETWORK, `Unit version/alt do not match ${expect.network}`);
  }
  const parents = unit["parent_units"];
  if (!Array.isArray(parents) || parents.length === 0 || !parents.every(isHash)) {
    return unsupported("Invalid parent_units");
  }
  if (!isHash(unit["last_ball"]) || !isHash(unit["last_ball_unit"])) {
    return unsupported("Invalid last ball");
  }
  if (!Number.isSafeInteger(unit["timestamp"])) return unsupported("Invalid timestamp");
  for (const fee of ["headers_commission", "payload_commission"] as const) {
    if (!Number.isSafeInteger(unit[fee]) || (unit[fee] as number) <= 0) {
      return unsupported(`Invalid ${fee}`);
    }
  }
  for (const fee of ["tps_fee", "burn_fee", "max_aa_responses"] as const) {
    if (fee in unit && !isIndex(unit[fee])) return unsupported(`Invalid ${fee}`);
  }
  return pass(unit);
}

/**
 * The unit hash is present and matches the content.
 *
 * @param unit - The unit.
 * @returns Hash, messages and authors, or the failure.
 */
function checkUnitHash(
  unit: Record<string, unknown>,
): Check<{ unitHash: string; messages: unknown[]; authors: unknown[] }> {
  if (!isHash(unit["unit"])) return fail(ERR_UNIT_HASH, "Missing unit hash");
  const messages = unit["messages"];
  const authors = unit["authors"];
  if (!Array.isArray(messages) || !Array.isArray(authors)) return unsupported("Malformed unit");
  let unitHash: string;
  try {
    unitHash = getUnitHash(unit);
  } catch {
    return fail(ERR_UNIT_HASH, "Unit cannot be hashed");
  }
  if (unitHash !== unit["unit"]) return fail(ERR_UNIT_HASH, "Unit hash does not match content");
  return pass({ unitHash, messages, authors });
}

/**
 * One author with a single-sig definition (embedded or from the ledger) and a valid signature.
 *
 * @param unit - The unit (for the signed hash).
 * @param authors - Its authors.
 * @param ledgerDefinition - Definition read from the ledger, if any.
 * @returns The payer and where its definition came from, or the failure.
 */
function checkAuthor(
  unit: Record<string, unknown>,
  authors: unknown[],
  ledgerDefinition: SigDefinition | undefined,
): Check<{ payer: string; definitionFromLedger: boolean }> {
  if (authors.length !== 1) return unsupported("Exactly one author is supported");
  const author: unknown = authors[0];
  if (!isPlainObject(author) || !hasOnlyKeys(author, AUTHOR_KEYS)) {
    return unsupported("Malformed author");
  }
  const payer = author["address"];
  if (!isAddress(payer)) return unsupported("Invalid author address");
  const embedded = "definition" in author;
  const definition: unknown = embedded ? author["definition"] : ledgerDefinition;
  if (definition === undefined) {
    return fail(
      ERR_DEFINITION_REQUIRED,
      "Author definition is not embedded; read it from the ledger",
    );
  }
  if (!isSigDefinition(definition)) {
    return fail(ERR_DEFINITION, "Only ['sig', {pubkey}] author definitions are supported");
  }
  if (obyte.utils.getChash160([...definition]) !== payer) {
    return fail(ERR_DEFINITION, "Definition does not match the author address");
  }
  const authentifiers = author["authentifiers"];
  if (!isPlainObject(authentifiers) || !hasOnlyKeys(authentifiers, new Set(["r"]))) {
    return fail(ERR_SIGNATURE, 'Expected a single authentifier "r"');
  }
  if (!verifySignature(getUnitHashToSign(unit), authentifiers["r"], definition[1].pubkey)) {
    return fail(ERR_SIGNATURE, "Signature is invalid");
  }
  return pass({ payer, definitionFromLedger: !embedded });
}

/**
 * Inline messages with matching hashes: exactly one data message carrying the
 * binding, one payment per asset, bytes always and only the expected asset besides.
 *
 * @param messages - Messages of the unit.
 * @param expect - Expected binding and asset.
 * @returns Payment payloads by asset, or the failure.
 */
function checkMessages(
  messages: unknown[],
  expect: ExactUnitExpectation,
): Check<Map<string, Record<string, unknown>>> {
  let dataCount = 0;
  const payments = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    if (!isPlainObject(message) || !hasOnlyKeys(message, MESSAGE_KEYS)) {
      return unsupported("Malformed message");
    }
    if (message["payload_location"] !== "inline" || !("payload" in message)) {
      return unsupported("Only inline payloads are supported");
    }
    if (getBase64Hash(message["payload"], true) !== message["payload_hash"]) {
      return fail(ERR_PAYLOAD_HASH, "payload_hash does not match payload");
    }
    const payload = message["payload"];
    if (message["app"] === "data") {
      dataCount += 1;
      const binding = checkBinding(payload, expect);
      if (!binding.ok) return binding;
    } else if (message["app"] === "payment") {
      const asset = paymentAsset(payload);
      if (!asset.ok) return asset;
      if (payments.has(asset.value)) return unsupported("One payment message per asset");
      payments.set(asset.value, payload as Record<string, unknown>);
    } else {
      return unsupported("Only payment and data messages are supported");
    }
  }
  if (dataCount !== 1) {
    return fail(ERR_BINDING, "Exactly one data message with the binding is required");
  }
  if (!payments.has(BYTES_ASSET)) return unsupported("A bytes payment message is required");
  for (const asset of payments.keys()) {
    if (asset !== BYTES_ASSET && asset !== expect.asset) {
      return fail(ERR_ASSET, "Payment in an unexpected asset");
    }
  }
  if (!payments.has(expect.asset)) return fail(ERR_ASSET, "No payment in the required asset");
  return pass(payments);
}

/**
 * The asset of a payment message (`base` when omitted).
 *
 * @param payload - Payment payload.
 * @returns The asset, or the failure.
 */
function paymentAsset(payload: unknown): Check<string> {
  if (!isPlainObject(payload) || !hasOnlyKeys(payload, PAYMENT_KEYS)) {
    return unsupported("Malformed payment");
  }
  const asset = "asset" in payload ? payload["asset"] : BYTES_ASSET;
  if (asset === BYTES_ASSET && "asset" in payload)
    return unsupported("Bytes payment must omit asset");
  if (!isAssetId(asset)) return unsupported("Invalid payment asset");
  return pass(asset);
}

/**
 * Transfer inputs only (no duplicates); sorted outputs that go to payTo
 * (exactly once, the exact amount, the expected asset) or back to the payer.
 *
 * @param payments - Payment payloads by asset.
 * @param payer - The payer address.
 * @param expect - Expected recipient, asset and amount.
 * @returns Inputs and output totals, or the failure.
 */
function checkTransfers(
  payments: Map<string, Record<string, unknown>>,
  payer: string,
  expect: ExactUnitExpectation,
): Check<{ inputs: InputRef[]; outputTotals: Record<string, bigint> }> {
  const inputs: InputRef[] = [];
  const seenInputs = new Set<string>();
  const outputTotals: Record<string, bigint> = {};
  let paidToPayTo = 0n;
  let outputsToPayTo = 0;
  for (const [asset, payment] of payments) {
    const ins = payment["inputs"];
    const outs = payment["outputs"];
    if (!Array.isArray(ins) || ins.length === 0 || !Array.isArray(outs) || outs.length === 0) {
      return unsupported("Payment needs inputs and outputs");
    }
    for (const input of ins) {
      const ref = transferInput(input, asset);
      if (ref === undefined) return unsupported("Only transfer inputs are supported");
      const key = `${ref.unit}:${ref.messageIndex}:${ref.outputIndex}`;
      if (seenInputs.has(key)) return unsupported("Duplicate input");
      seenInputs.add(key);
      inputs.push(ref);
    }
    let total = 0n;
    let previous: { address: string; amount: number } | undefined;
    for (const output of outs) {
      if (
        !isPlainObject(output) ||
        !hasOnlyKeys(output, OUTPUT_KEYS) ||
        !isAddress(output["address"]) ||
        !isPositiveAmount(output["amount"])
      ) {
        return unsupported("Malformed output");
      }
      // ocore requires outputs sorted by address, then amount; duplicates are
      // outside the profile.
      const current = { address: output["address"], amount: output["amount"] };
      if (previous !== undefined && compareOutputs(previous, current) >= 0) {
        return unsupported("Outputs must be sorted by address and amount without duplicates");
      }
      previous = current;
      total += BigInt(current.amount);
      if (current.address === expect.payTo) {
        if (asset !== expect.asset)
          return fail(ERR_RECIPIENT, "payTo receives an unexpected asset");
        outputsToPayTo += 1;
        paidToPayTo += BigInt(current.amount);
      } else if (current.address !== payer) {
        return fail(ERR_RECIPIENT, "Outputs may only go to payTo or back to the payer");
      }
    }
    outputTotals[asset] = total;
  }
  if (outputsToPayTo !== 1) return fail(ERR_RECIPIENT, "Exactly one output to payTo is required");
  if (paidToPayTo !== expect.amount) return fail(ERR_AMOUNT, "Amount paid to payTo does not match");
  return pass({ inputs, outputTotals });
}

/**
 * A transfer input (unit, message_index, output_index).
 *
 * @param input - Candidate input.
 * @param asset - Asset of its payment.
 * @returns The input, or undefined for anything else.
 */
function transferInput(input: unknown, asset: string): InputRef | undefined {
  if (
    !isPlainObject(input) ||
    !hasOnlyKeys(input, INPUT_KEYS) ||
    !isHash(input["unit"]) ||
    !isIndex(input["message_index"]) ||
    !isIndex(input["output_index"])
  ) {
    return undefined;
  }
  return {
    asset,
    unit: input["unit"],
    messageIndex: input["message_index"],
    outputIndex: input["output_index"],
  };
}

/**
 * Orders outputs the way ocore requires (address, then amount).
 *
 * @param a - First output.
 * @param a.address - Its address.
 * @param a.amount - Its amount.
 * @param b - Second output.
 * @param b.address - Its address.
 * @param b.amount - Its amount.
 * @returns Negative, zero or positive.
 */
export function compareOutputs(
  a: { address: string; amount: number },
  b: { address: string; amount: number },
): number {
  if (a.address !== b.address) return a.address < b.address ? -1 : 1;
  return a.amount - b.amount;
}

/**
 * Checks the data message `{x402: {binding, quoteId}}` against the requirements.
 *
 * @param payload - Data message payload.
 * @param expect - Expected binding and quote id.
 * @returns Success, or a binding failure.
 */
function checkBinding(payload: unknown, expect: ExactUnitExpectation): Check<null> {
  const shape = "Data message must be exactly {x402: {binding, quoteId}}";
  if (!isPlainObject(payload) || !hasOnlyKeys(payload, new Set(["x402"]))) {
    return fail(ERR_BINDING, shape);
  }
  const x402 = payload["x402"];
  if (!isPlainObject(x402) || !hasOnlyKeys(x402, X402_DATA_KEYS)) return fail(ERR_BINDING, shape);
  if (x402["binding"] !== expect.binding || x402["quoteId"] !== expect.quoteId) {
    return fail(ERR_BINDING, "Signed binding does not match this operation");
  }
  return pass(null);
}

/**
 * Verifies a secp256k1 signature without throwing.
 *
 * @param hash - Signed hash.
 * @param signature - Base64 signature.
 * @param pubkey - Base64 public key.
 * @returns True when valid.
 */
function verifySignature(hash: Uint8Array, signature: unknown, pubkey: string): boolean {
  if (typeof signature !== "string") return false;
  try {
    return verify(hash, signature, pubkey);
  } catch {
    return false;
  }
}
