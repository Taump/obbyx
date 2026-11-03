import { type ObyteNetwork, type Verdict, accept, reject, verifySignedPackage } from '@obbyx/obyte';
import { z } from 'zod';

/**
 * Facilitator ↔ seller-watcher protocol (ADR-0003), JSON over WebSocket at
 * `/watcher`.
 *
 *   F → W  challenge   {challenge}
 *   W → F  hello       {network, login: signed {purpose, challenge, network, expires}, cursor, bytesBalance}
 *   F → W  welcome     {seller}               then replays the journal after `cursor`
 *   F → W  commitment  {seq, ...voucher}      (pending or committed)
 *   W → F  ack         {seq}                  ONLY after the voucher is durably stored
 *   W → F  heartbeat   {cursor, bytesBalance, closing?}   closing: channels the seller is closing (no new vouchers)
 *   F → W  error       {message}              then close
 *
 * The login is an Obyte signed message by the seller's address (payTo), so
 * only the seller's watcher receives that seller's vouchers. Vouchers are
 * bearer-sensitive (ADR-0001): never log `signedPackage`.
 */
export const WATCHER_LOGIN_PURPOSE = 'obbyx-watcher-login';

export const commitmentMessageSchema = z.object({
  type: z.literal('commitment'),
  seq: z.number().int().positive(),
  network: z.string(),
  aa: z.string(),
  period: z.number().int().positive(),
  amountSpent: z.string().regex(/^\d+$/),
  paymentAmount: z.string().regex(/^\d+$/),
  binding: z.string(),
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

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    network: z.string(),
    login: z.record(z.string(), z.unknown()),
    cursor: z.number().int().nonnegative(),
    bytesBalance: z.string().regex(/^\d+$/),
    closing: z.array(z.string()).max(10_000).optional(),
  }),
  z.object({ type: z.literal('ack'), seq: z.number().int().positive() }),
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
