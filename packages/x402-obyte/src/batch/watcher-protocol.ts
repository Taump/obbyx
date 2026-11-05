import {
  type ObyteNetwork,
  type Verdict,
  accept,
  isAddress,
  reject,
  verifySignedPackage,
} from '@obbyx/obyte';
import { z } from 'zod';
import { sha256Hex } from '../binding/binding.js';
import { canonical } from '../exact/requirements.js';
import { SHA256_HEX_RE } from '../util/format.js';

/**
 * Facilitator ↔ seller-watcher protocol (ADR-0003), JSON over WebSocket at
 * `/watcher`.
 *
 *   F → W  challenge   {challenge}
 *   W → F  hello       {network, login: signed {purpose, challenge, network, expires}, cursor, bytesBalance}
 *   F → W  welcome     {seller}               then replays the journal after `cursor`
 *   F → W  commitment  {seq, ...voucher}      (pending or committed)
 *   W → F  ack         {seq, receipt}         ONLY after the voucher is durably stored
 *   W → F  nack        {seq, receipt}         the voucher is definitely NOT stored (refused)
 *   W → F  heartbeat   {cursor, bytesBalance, closing?}   closing: channels the seller is closing (no new vouchers)
 *   F → W  error       {message}              then close
 *
 * The login is an Obyte signed message by the seller's address (payTo), so
 * only the seller's watcher receives that seller's vouchers. Vouchers are
 * bearer-sensitive (ADR-0001): never log `signedPackage`.
 *
 * Receipts. ack and nack carry a `receipt`: an Obyte signed message by the
 * seller over {purpose, network, seq, packageHash[, reason]}. Anyone relaying
 * the socket can drop or delay messages but cannot forge a receipt, so the
 * facilitator commits (reports paid) or cancels ONLY the exact package the
 * seller's watcher signed for — never on the strength of a bare seq. The rest
 * of a commitment message (network, amounts, aa…) is NOT signed, so a
 * watcher nacks only on grounds intrinsic to the client-signed package and
 * the on-chain channel (ADR-0003, "Signed receipts").
 */
export const WATCHER_LOGIN_PURPOSE = 'obbyx-watcher-login';
/**
 * Version sent in `hello`. 2 = signed ack/nack receipts. A facilitator refuses
 * other versions at login with a clear error (an old watcher's bare ack would
 * otherwise be dropped as malformed in a reconnect loop). Upgrade order:
 * facilitator first (channel payments fail closed until the watcher follows).
 */
export const WATCHER_PROTOCOL_VERSION = 2;
export const WATCHER_ACK_PURPOSE = 'obbyx-watcher-ack';
export const WATCHER_NACK_PURPOSE = 'obbyx-watcher-nack';

/** Hash identifying a channel package everywhere (journal, watcher, seller): sha256 of canonical JSON. */
export function packageHashOf(signedPackage: unknown): string {
  return sha256Hex(canonical(signedPackage));
}

/** The channel package of a batch-settlement payment payload, if there is one. */
export function voucherPackageOf(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const pkg = payload?.['signedPackage'];
  return pkg !== null && typeof pkg === 'object' ? (pkg as Record<string, unknown>) : undefined;
}

export const commitmentMessageSchema = z.object({
  type: z.literal('commitment'),
  seq: z.number().int().positive(),
  network: z.string().max(64),
  aa: z.string().refine(isAddress, 'aa must be an Obyte address'),
  period: z.number().int().positive(),
  amountSpent: z.string().regex(/^\d{1,30}$/),
  paymentAmount: z.string().regex(/^\d{1,30}$/),
  binding: z.string().regex(SHA256_HEX_RE),
  signedPackage: z.record(z.string(), z.unknown()),
  state: z.enum(['pending', 'committed']),
});
export type CommitmentMessage = z.infer<typeof commitmentMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('challenge'), challenge: z.string() }),
  z.object({ type: z.literal('welcome'), seller: z.string(), network: z.string() }),
  commitmentMessageSchema,
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export type ReceiptKind = 'ack' | 'nack';

const purposeOf = (kind: ReceiptKind) =>
  kind === 'ack' ? WATCHER_ACK_PURPOSE : WATCHER_NACK_PURPOSE;

/** `{type: 'ack' | 'nack', seq, receipt}` from the watcher (the receipt is verified separately). */
const receiptMessageSchema = <K extends ReceiptKind>(type: K) =>
  z.object({
    type: z.literal(type),
    seq: z.number().int().positive(),
    receipt: z.record(z.string(), z.unknown()),
  });

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    /** Absent in version 1 watchers. */
    protocol: z.number().int().optional(),
    network: z.string(),
    login: z.record(z.string(), z.unknown()),
    cursor: z.number().int().nonnegative(),
    bytesBalance: z.string().regex(/^\d+$/),
    closing: z.array(z.string()).max(10_000).optional(),
  }),
  receiptMessageSchema('ack'),
  receiptMessageSchema('nack'),
  z.object({
    type: z.literal('heartbeat'),
    cursor: z.number().int().nonnegative(),
    bytesBalance: z.string().regex(/^\d+$/),
    closing: z.array(z.string()).max(10_000).optional(),
  }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

const loginSchema = z
  .object({
    purpose: z.literal(WATCHER_LOGIN_PURPOSE),
    challenge: z.string(),
    network: z.string(),
    expires: z.number().int(),
  })
  .strict();

export function loginMessage(challenge: string, network: string, now: number) {
  return { purpose: WATCHER_LOGIN_PURPOSE, challenge, network, expires: now + 60 };
}

/** Verifies a watcher login; returns the seller address that signed it. */
export function verifyWatcherLogin(
  login: unknown,
  expected: { challenge: string; network: ObyteNetwork; now: number },
): Verdict<string> {
  const verified = verifySignedPackage<unknown>(login, { network: expected.network });
  if (!verified.ok) return reject('watcher_login', verified.message);
  const body = loginSchema.safeParse(verified.value.message);
  if (!body.success) return reject('watcher_login', 'Malformed login message');
  if (body.data.challenge !== expected.challenge) return reject('watcher_login', 'Wrong challenge');
  if (body.data.network !== expected.network.caip2) return reject('watcher_login', 'Wrong network');
  if (body.data.expires < expected.now) return reject('watcher_login', 'Login expired');
  return accept(verified.value.signer);
}

export interface Receipt {
  readonly seq: number;
  readonly packageHash: string;
  /** nack only: why the watcher refused the voucher. */
  readonly reason?: string;
}

const receiptSchema = z
  .object({
    purpose: z.enum([WATCHER_ACK_PURPOSE, WATCHER_NACK_PURPOSE]),
    network: z.string().max(64),
    seq: z.number().int().positive(),
    packageHash: z.string().regex(SHA256_HEX_RE),
    reason: z.string().max(200).optional(),
  })
  .strict();

/** The message a watcher signs to ack (stored) or nack (refused) one journal entry. */
export function receiptMessage(kind: ReceiptKind, network: string, receipt: Receipt) {
  return {
    purpose: purposeOf(kind),
    network,
    seq: receipt.seq,
    packageHash: receipt.packageHash,
    ...(kind === 'nack' ? { reason: (receipt.reason ?? 'refused').slice(0, 200) } : {}),
  };
}

/**
 * Verifies a watcher receipt: signed by `seller`, of the expected kind and
 * network, for `seq`. Returns the signed packageHash (and reason); the caller
 * must check it against the journal entry before acting on it.
 */
export function verifyWatcherReceipt(
  kind: ReceiptKind,
  receipt: unknown,
  expected: { seller: string; network: ObyteNetwork; seq: number },
): Verdict<Omit<Receipt, 'seq'>> {
  const verified = verifySignedPackage<unknown>(receipt, {
    network: expected.network,
    expectedSigner: expected.seller,
  });
  if (!verified.ok) return reject('watcher_receipt', verified.message);
  const body = receiptSchema.safeParse(verified.value.message);
  if (!body.success) return reject('watcher_receipt', 'Malformed receipt');
  if (body.data.purpose !== purposeOf(kind)) {
    return reject('watcher_receipt', 'Wrong receipt purpose');
  }
  if (body.data.network !== expected.network.caip2)
    return reject('watcher_receipt', 'Wrong network');
  if (body.data.seq !== expected.seq) return reject('watcher_receipt', 'Wrong seq');
  return accept({
    packageHash: body.data.packageHash,
    ...(body.data.reason === undefined ? {} : { reason: body.data.reason }),
  });
}
