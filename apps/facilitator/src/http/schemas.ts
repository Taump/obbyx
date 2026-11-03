import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { z } from 'zod';

/**
 * Envelope of POST /verify and /settle. Only the fields the HTTP layer relies
 * on are checked here; the scheme mechanisms validate the rest strictly
 * (fail-closed). v1 requirements carry `maxAmountRequired` instead of `amount`.
 */
const requirementsSchema = z
  .object({
    scheme: z.string().min(1),
    network: z.string().min(1),
    payTo: z.string().min(1),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const payloadSchema = z
  .object({
    x402Version: z.number().int(),
    payload: z.record(z.string(), z.unknown()),
  })
  .loose();

export const x402RequestSchema = z.object({
  x402Version: z.number().int().optional(),
  paymentPayload: payloadSchema,
  paymentRequirements: requirementsSchema,
});

export interface X402Request {
  readonly paymentPayload: PaymentPayload;
  readonly paymentRequirements: PaymentRequirements;
}

export function parseX402Request(body: unknown): X402Request | undefined {
  const parsed = x402RequestSchema.safeParse(body);
  if (!parsed.success) return undefined;
  return parsed.data as unknown as X402Request;
}

const page = z.coerce.number().int();
const filters = {
  type: z.string().min(1).optional(),
  payTo: z.string().min(1).optional(),
  scheme: z.string().min(1).optional(),
  network: z.string().min(1).optional(),
  limit: page.min(1).max(100).catch(20).default(20),
};

export const resourcesQuerySchema = z.object({
  ...filters,
  offset: page.min(0).catch(0).default(0),
});

export const searchQuerySchema = z.object({
  ...filters,
  query: z.string().trim().min(1).max(200),
  cursor: page.min(0).catch(0).default(0),
});
