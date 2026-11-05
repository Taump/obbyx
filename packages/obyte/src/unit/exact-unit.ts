// Ambient types for obyte.js internals; a reference (not tsconfig "include") so that
// workspace packages compiling these sources via the @obbyx/source condition see them.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../types/obyte-internal.d.ts" />
import obyte from 'obyte';
import {
  getBase64Hash,
  getHeadersSize,
  getTotalPayloadSize,
  getUnitHash,
  getUnitHashToSign,
} from 'obyte/lib/internal.js';
import { isAddress, isAssetId } from '../channel/definition.js';
import type { ObyteNetwork } from '../core/networks.js';
import { type Verdict, accept, hasOnlyKeys, isPlainObject, reject } from '../core/result.js';
import { type SigDefinition, isSigDefinition, verifySignature } from '../signing/signed-message.js';

/**
 * Local (ledger-independent) validation of a client-signed unit for the x402
 * `exact` scheme — the supported profile of ADR-0002.
 *
 * Checks done here need no hub: structure, network, unit hash, payload hashes,
 * author definition and signature, commissions, message set, outputs and the
 * signed binding. Ledger checks (inputs unspent, last ball recency, author
 * definition when not embedded) are performed by the facilitator with a
 * LedgerPort using {@link ExactUnitFacts}.
 *
 * Anything outside the profile is rejected; the profile is deliberately narrow.
 */

export const EXACT_REASONS = {
  unsupported: 'invalid_exact_obyte_unsupported_unit',
  tooLarge: 'invalid_exact_obyte_unit_too_large',
  network: 'invalid_exact_obyte_network',
  unitHash: 'invalid_exact_obyte_unit_hash',
  payloadHash: 'invalid_exact_obyte_payload_hash',
  definition: 'invalid_exact_obyte_definition',
  definitionRequired: 'invalid_exact_obyte_definition_required',
  signature: 'invalid_exact_obyte_signature',
  commissions: 'invalid_exact_obyte_commissions',
  recipient: 'invalid_exact_obyte_recipient_mismatch',
  amount: 'invalid_exact_obyte_amount_mismatch',
  asset: 'invalid_exact_obyte_asset_mismatch',
  binding: 'invalid_exact_obyte_binding_mismatch',
  payer: 'invalid_exact_obyte_payer',
} as const;

/** Only current unit versions are accepted. */
export const EXACT_UNIT_VERSIONS = { livenet: '4.0', testnet: '4.0t' } as const;
const ALT = { livenet: '1', testnet: '2' } as const;

export const DEFAULT_MAX_UNIT_BYTES = 16 * 1024;

export interface ExactExpectation {
  readonly network: ObyteNetwork;
  readonly payTo: string;
  /** `'base'` or asset id; must be allowlisted by the caller beforehand. */
  readonly asset: string;
  readonly amount: bigint;
  readonly binding: string;
  readonly quoteId: string;
  /** Facilitator's own addresses: they must never be the payer. */
  readonly facilitatorAddresses?: readonly string[];
  readonly maxUnitBytes?: number;
}

export interface InputRef {
  readonly asset: string;
  readonly unit: string;
  readonly messageIndex: number;
  readonly outputIndex: number;
}

export interface ExactUnitFacts {
  readonly unitHash: string;
  readonly payer: string;
  readonly inputs: readonly InputRef[];
  readonly lastBallUnit: string;
  readonly parentUnits: readonly string[];
  readonly timestamp: number;
  /** Sum of outputs per asset ('base' for bytes), used to check inputs balance. */
  readonly outputTotals: Readonly<Record<string, bigint>>;
  readonly commissions: { readonly headers: number; readonly payload: number };
  /** True when the author definition was not embedded and came from the caller. */
  readonly definitionFromLedger: boolean;
}

const UNIT_KEYS = new Set([
  'version',
  'alt',
  'messages',
  'authors',
  'parent_units',
  'last_ball',
  'last_ball_unit',
  'timestamp',
  'headers_commission',
  'payload_commission',
  'tps_fee',
  'burn_fee',
  'max_aa_responses',
  'unit',
]);
const AUTHOR_KEYS = new Set(['address', 'authentifiers', 'definition']);
const MESSAGE_KEYS = new Set(['app', 'payload_location', 'payload_hash', 'payload']);
const PAYMENT_KEYS = new Set(['asset', 'inputs', 'outputs']);
const INPUT_KEYS = new Set(['unit', 'message_index', 'output_index']);
const OUTPUT_KEYS = new Set(['address', 'amount']);
const HASH_RE = /^[A-Za-z0-9+/]{43}=$/;

const isHash = (v: unknown): v is string => typeof v === 'string' && HASH_RE.test(v);
const isIndex = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isPositiveAmount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

export function validateExactUnit(
  unit: unknown,
  expect: ExactExpectation,
  options: { authorDefinition?: SigDefinition } = {},
): Verdict<ExactUnitFacts> {
  // The order of the checks is part of the contract: the first failing one
  // decides the reason code.
  const shaped = checkShape(unit, expect);
  if (!shaped.ok) return shaped;
  const u = shaped.value;
  const hashed = checkUnitHash(u);
  if (!hashed.ok) return hashed;
  const { unitHash, messages, authors } = hashed.value;
  const author = checkAuthor(u, authors, options.authorDefinition);
  if (!author.ok) return author;
  const { payer, definitionFromLedger } = author.value;
  const roles = checkPayer(payer, expect);
  if (!roles.ok) return roles;
  const payments = checkMessages(messages, expect);
  if (!payments.ok) return payments;
  const transfers = checkTransfers(payments.value, payer, expect);
  if (!transfers.ok) return transfers;
  const commissions = expectedCommissions(u);
  if (
    commissions.headers !== u['headers_commission'] ||
    commissions.payload !== u['payload_commission']
  ) {
    return reject(EXACT_REASONS.commissions, 'Commissions do not match the unit size');
  }
  return accept({
    unitHash,
    payer,
    inputs: transfers.value.inputs,
    lastBallUnit: u['last_ball_unit'] as string,
    parentUnits: u['parent_units'] as string[],
    timestamp: u['timestamp'] as number,
    outputTotals: transfers.value.outputTotals,
    commissions,
    definitionFromLedger,
  });
}

const unsupported = (why: string) => reject<never>(EXACT_REASONS.unsupported, why);

/** Structure, size, network and header fields. */
function checkShape(unit: unknown, expect: ExactExpectation): Verdict<Record<string, unknown>> {
  if (!isPlainObject(unit)) return unsupported('Unit must be an object');
  let serialized: string;
  try {
    serialized = JSON.stringify(unit);
  } catch {
    return unsupported('Unit is not serializable');
  }
  if (serialized.length > (expect.maxUnitBytes ?? DEFAULT_MAX_UNIT_BYTES)) {
    return reject(EXACT_REASONS.tooLarge, 'Unit exceeds the size limit');
  }
  if (!hasOnlyKeys(unit, UNIT_KEYS)) return unsupported('Unit has fields outside the profile');

  const net = expect.network.name;
  if (unit['version'] !== EXACT_UNIT_VERSIONS[net] || unit['alt'] !== ALT[net]) {
    return reject(EXACT_REASONS.network, `Unit version/alt do not match ${expect.network.caip2}`);
  }

  const parents = unit['parent_units'];
  if (!Array.isArray(parents) || parents.length === 0 || !parents.every(isHash)) {
    return unsupported('Invalid parent_units');
  }
  if (!isHash(unit['last_ball']) || !isHash(unit['last_ball_unit'])) {
    return unsupported('Invalid last ball');
  }
  if (!Number.isSafeInteger(unit['timestamp'])) return unsupported('Invalid timestamp');
  for (const fee of ['headers_commission', 'payload_commission'] as const) {
    if (!Number.isSafeInteger(unit[fee]) || (unit[fee] as number) <= 0) {
      return unsupported(`Invalid ${fee}`);
    }
  }
  for (const fee of ['tps_fee', 'burn_fee', 'max_aa_responses'] as const) {
    if (fee in unit && !isIndex(unit[fee])) return unsupported(`Invalid ${fee}`);
  }
  return accept(unit);
}

/** The unit hash is present and matches the content. */
function checkUnitHash(
  unit: Record<string, unknown>,
): Verdict<{ unitHash: string; messages: unknown[]; authors: unknown[] }> {
  if (!isHash(unit['unit'])) return reject(EXACT_REASONS.unitHash, 'Missing unit hash');
  const messages = unit['messages'];
  const authors = unit['authors'];
  if (!Array.isArray(messages) || !Array.isArray(authors)) return unsupported('Malformed unit');
  let unitHash: string;
  try {
    unitHash = getUnitHash(unit);
  } catch {
    return reject(EXACT_REASONS.unitHash, 'Unit cannot be hashed');
  }
  if (unitHash !== unit['unit']) {
    return reject(EXACT_REASONS.unitHash, 'Unit hash does not match content');
  }
  return accept({ unitHash, messages, authors });
}

/** One author with a single-sig definition (embedded or from the ledger) and a valid signature. */
function checkAuthor(
  unit: Record<string, unknown>,
  authors: unknown[],
  ledgerDefinition: SigDefinition | undefined,
): Verdict<{ payer: string; definitionFromLedger: boolean }> {
  const R = EXACT_REASONS;
  if (authors.length !== 1) return unsupported('Exactly one author is supported');
  const author: unknown = authors[0];
  if (!isPlainObject(author) || !hasOnlyKeys(author, AUTHOR_KEYS)) {
    return unsupported('Malformed author');
  }
  const payer = author['address'];
  if (!isAddress(payer)) return unsupported('Invalid author address');

  const embedded = 'definition' in author;
  const definition: unknown = embedded ? author['definition'] : ledgerDefinition;
  if (definition === undefined) {
    return reject(
      R.definitionRequired,
      'Author definition is not embedded; fetch it from the ledger',
    );
  }
  if (!isSigDefinition(definition)) {
    return reject(R.definition, "Only ['sig', {pubkey}] author definitions are supported");
  }
  if (obyte.utils.getChash160([...definition]) !== payer) {
    return reject(R.definition, 'Definition does not match the author address');
  }
  const authentifiers = author['authentifiers'];
  if (!isPlainObject(authentifiers) || !hasOnlyKeys(authentifiers, new Set(['r']))) {
    return reject(R.signature, 'Expected a single authentifier "r"');
  }
  if (!verifySignature(getUnitHashToSign(unit), authentifiers['r'], definition[1].pubkey)) {
    return reject(R.signature, 'Signature is invalid');
  }
  return accept({ payer, definitionFromLedger: !embedded });
}

/** The payer is neither the recipient nor the facilitator. */
function checkPayer(payer: string, expect: ExactExpectation): Verdict<null> {
  if (payer === expect.payTo) return reject(EXACT_REASONS.payer, 'Payer and payTo must differ');
  if (expect.facilitatorAddresses?.includes(payer)) {
    return reject(EXACT_REASONS.payer, 'A facilitator address must never be the payer');
  }
  return accept(null);
}

/**
 * Inline messages with matching hashes: exactly one data message carrying the
 * binding, one payment per asset, bytes always and only the expected asset besides.
 */
function checkMessages(
  messages: unknown[],
  expect: ExactExpectation,
): Verdict<Map<string, Record<string, unknown>>> {
  const R = EXACT_REASONS;
  let dataCount = 0;
  const payments = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    if (!isPlainObject(message) || !hasOnlyKeys(message, MESSAGE_KEYS)) {
      return unsupported('Malformed message');
    }
    if (message['payload_location'] !== 'inline' || !('payload' in message)) {
      return unsupported('Only inline payloads are supported');
    }
    // obyte.js throws on null / empty objects / empty arrays in a payload; the
    // unit hash does not cover payloads, so such a unit gets this far.
    let payloadHash: string;
    try {
      payloadHash = getBase64Hash(message['payload'], true);
    } catch {
      return reject(R.payloadHash, 'Payload cannot be hashed');
    }
    if (payloadHash !== message['payload_hash']) {
      return reject(R.payloadHash, 'payload_hash does not match payload');
    }
    const payload = message['payload'];
    if (message['app'] === 'data') {
      dataCount += 1;
      const binding = checkBinding(payload, expect);
      if (binding !== undefined) return binding;
    } else if (message['app'] === 'payment') {
      const asset = paymentAsset(payload);
      if (!asset.ok) return asset;
      if (payments.has(asset.value)) return unsupported('One payment message per asset');
      payments.set(asset.value, payload as Record<string, unknown>);
    } else {
      return unsupported('Only payment and data messages are supported');
    }
  }
  if (dataCount !== 1) {
    return reject(R.binding, 'Exactly one data message with the binding is required');
  }
  if (!payments.has('base')) return unsupported('A bytes payment message is required');
  for (const asset of payments.keys()) {
    if (asset !== 'base' && asset !== expect.asset) {
      return reject(R.asset, 'Payment in an unexpected asset');
    }
  }
  if (!payments.has(expect.asset)) return reject(R.asset, 'No payment in the required asset');
  return accept(payments);
}

/** The asset of a payment message ('base' when omitted). */
function paymentAsset(payload: unknown): Verdict<string> {
  if (!isPlainObject(payload) || !hasOnlyKeys(payload, PAYMENT_KEYS)) {
    return unsupported('Malformed payment');
  }
  const asset = 'asset' in payload ? payload['asset'] : 'base';
  if (asset === 'base' && 'asset' in payload) return unsupported('Bytes payment must omit asset');
  if (!isAssetId(asset)) return unsupported('Invalid payment asset');
  return accept(asset);
}

/**
 * Transfer inputs only (no duplicates); sorted outputs that go to payTo
 * (exactly once, the exact amount, the expected asset) or back to the payer.
 */
function checkTransfers(
  payments: Map<string, Record<string, unknown>>,
  payer: string,
  expect: ExactExpectation,
): Verdict<{ inputs: InputRef[]; outputTotals: Record<string, bigint> }> {
  const R = EXACT_REASONS;
  const inputs: InputRef[] = [];
  const seenInputs = new Set<string>();
  const outputTotals: Record<string, bigint> = {};
  let paidToPayTo = 0n;
  let outputsToPayTo = 0;
  for (const [asset, payment] of payments) {
    const ins = payment['inputs'];
    const outs = payment['outputs'];
    if (!Array.isArray(ins) || ins.length === 0 || !Array.isArray(outs) || outs.length === 0) {
      return unsupported('Payment needs inputs and outputs');
    }
    for (const input of ins) {
      const ref = transferInput(input, asset);
      if (ref === undefined) return unsupported('Only transfer inputs are supported');
      const key = `${ref.unit}:${ref.messageIndex}:${ref.outputIndex}`;
      if (seenInputs.has(key)) return unsupported('Duplicate input');
      seenInputs.add(key);
      inputs.push(ref);
    }
    let total = 0n;
    let previous: { address: string; amount: number } | undefined;
    for (const output of outs) {
      if (
        !isPlainObject(output) ||
        !hasOnlyKeys(output, OUTPUT_KEYS) ||
        !isAddress(output['address']) ||
        !isPositiveAmount(output['amount'])
      ) {
        return unsupported('Malformed output');
      }
      // ocore requires outputs sorted by address, then amount; duplicates are
      // outside our profile.
      const current = { address: output['address'], amount: output['amount'] };
      if (previous !== undefined && compareOutputs(previous, current) >= 0) {
        return unsupported('Outputs must be sorted by address and amount without duplicates');
      }
      previous = current;
      total += BigInt(current.amount);
      if (current.address === expect.payTo) {
        if (asset !== expect.asset)
          return reject(R.recipient, 'payTo receives an unexpected asset');
        outputsToPayTo += 1;
        paidToPayTo += BigInt(current.amount);
      } else if (current.address !== payer) {
        return reject(R.recipient, 'Outputs may only go to payTo or back to the payer');
      }
    }
    outputTotals[asset] = total;
  }
  if (outputsToPayTo !== 1) return reject(R.recipient, 'Exactly one output to payTo is required');
  if (paidToPayTo !== expect.amount) return reject(R.amount, 'Amount paid to payTo does not match');
  return accept({ inputs, outputTotals });
}

/** A transfer input (unit, message_index, output_index), or undefined for anything else. */
function transferInput(input: unknown, asset: string): InputRef | undefined {
  if (
    !isPlainObject(input) ||
    !hasOnlyKeys(input, INPUT_KEYS) ||
    !isHash(input['unit']) ||
    !isIndex(input['message_index']) ||
    !isIndex(input['output_index'])
  ) {
    return undefined;
  }
  return {
    asset,
    unit: input['unit'],
    messageIndex: input['message_index'],
    outputIndex: input['output_index'],
  };
}

/** Length of one base64 secp256k1 signature, as counted by obyte.js. */
const SIGNATURE_SIZE = 88;

/**
 * Commissions ocore expects for an already SIGNED single-author unit (v4,
 * sizes counted with keys). obyte.js `getHeadersSize` is meant for the
 * unsigned unit during compose (authentifiers hold a path placeholder) and
 * adds SIGNATURE_SIZE itself; on a signed unit the real signature is already
 * counted, so it is subtracted. Verified against testnet unit DxPSVW8p…
 * (headers 452, payload 432).
 */
export function expectedCommissions(unit: object): { headers: number; payload: number } {
  return {
    headers: getHeadersSize(unit, true) - SIGNATURE_SIZE,
    payload: getTotalPayloadSize(unit, true),
  };
}

export function compareOutputs(
  a: { address: string; amount: number },
  b: { address: string; amount: number },
): number {
  if (a.address !== b.address) return a.address < b.address ? -1 : 1;
  return a.amount - b.amount;
}

/** The data message is exactly `{x402: {binding, quoteId}}` of this operation (undefined when it is). */
function checkBinding(payload: unknown, expect: ExactExpectation): Verdict<never> | undefined {
  const R = EXACT_REASONS;
  if (!isPlainObject(payload) || !hasOnlyKeys(payload, new Set(['x402']))) {
    return reject(R.binding, 'Data message must be exactly {x402: {binding, quoteId}}');
  }
  const x402 = payload['x402'];
  if (!isPlainObject(x402) || !hasOnlyKeys(x402, new Set(['binding', 'quoteId']))) {
    return reject(R.binding, 'Data message must be exactly {x402: {binding, quoteId}}');
  }
  if (x402['binding'] !== expect.binding || x402['quoteId'] !== expect.quoteId) {
    return reject(R.binding, 'Signed binding does not match this operation');
  }
  return undefined;
}
