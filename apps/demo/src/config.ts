import { isAddress } from '@obbyx/obyte';
import { envPort } from '@obbyx/obyte/config';
import { z } from 'zod';

/** Demo seller configuration (environment variables). Documented in docs/reference/configuration.md. */
export const demoEnvSchema = z.object({
  PORT: envPort
    .default(3402)
    .describe('HTTP port (3402 because 3000 is often taken by dev servers).'),
  HOST: z.string().default('127.0.0.1').describe('Interface to listen on.'),
  NETWORK: z.string().default('obyte:testnet').describe('CAIP-2 network of the offers.'),
  FACILITATOR_URL: z.url().default('http://127.0.0.1:4021').describe('Facilitator base URL.'),
  FACILITATOR_API_KEY: z
    .string()
    .optional()
    .describe(
      'Key sent as Authorization: Bearer if the facilitator requires one (its FACILITATOR_API_KEYS).',
    ),
  PAY_TO: z
    .string()
    .refine(isAddress, 'PAY_TO must be a valid Obyte address')
    .describe('Required. Seller Obyte address that receives the payments.'),
  SELLER_ID: z.string().default('obbyx-demo').describe('Seller id, part of every payment binding.'),
  SELLER_SECRET: z
    .string()
    .min(32, 'SELLER_SECRET must be at least 32 characters')
    .describe(
      'Required. HMAC secret for payment bindings (32+ chars). Rotating it invalidates open quotes.',
    ),
  DB_PATH: z
    .string()
    .default('./data/demo-proofs.db')
    .describe('SQLite file with consumed payment proofs.'),
  BATCH_MIN_CHANNEL_TIMEOUT: z.coerce
    .number()
    .int()
    .min(60)
    .optional()
    .describe(
      'Enable channel payments (needs the seller watcher running): minimum dispute window, seconds.',
    ),
  PLAYGROUND_BUYER_HOME: z
    .string()
    .optional()
    .describe(
      'Enables /playground: OBBYX_HOME of a TESTNET buyer wallet that pays for playground runs. Testnet and loopback HOST only.',
    ),
  HUB_URL: z
    .url()
    .optional()
    .describe('Obyte hub WebSocket URL for the playground buyer (default: the network hub).'),
});
