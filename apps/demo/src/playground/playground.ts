import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Router } from 'express';
import { z } from 'zod';
import obyte from 'obyte';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from '@x402/core/http';
import { type ObyteNetwork, explorerUnitUrl } from '@obbyx/obyte';
import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import {
  BatchObyteClient,
  ClientChannelStore,
  CoinReservations,
  ExactObyteClient,
  ReservingComposer,
  startHeartbeat,
} from '@obbyx/x402-obyte';
import { PaymentPendingError, payingFetch } from '@obbyx/sdk';
import { loadWallet } from '@obbyx/obyte/wallet';

/**
 * Playground: runs a real x402 payment against this demo seller with a
 * server-side TESTNET buyer wallet and returns every step (request → 402 offer
 * → signed payment → settlement → response) for the page in playground.html.
 *
 * Safety: enabled only with PLAYGROUND_BUYER_HOME, only on testnet, only when
 * the demo listens on a loopback address; one run at a time; each run may
 * spend at most the route price. Private keys and full units never leave the
 * server (only unit hashes / channel ids are shown).
 */
export interface PlaygroundOptions {
  readonly network: ObyteNetwork;
  readonly buyerHome: string;
  readonly sellerUrl: string;
  readonly routes: Readonly<
    Record<string, { method: 'GET' | 'POST'; path: string; price: bigint }>
  >;
  readonly logger: Logger;
  readonly hubUrl?: string;
}

export type Step =
  | { kind: 'request'; method: string; url: string; payment?: PaymentSummary }
  | {
      kind: 'response';
      status: number;
      offer?: OfferSummary[];
      settlement?: Record<string, unknown>;
      explorer?: string;
      body?: unknown;
    }
  | { kind: 'pending'; transaction: string; paymentHeader: string }
  | { kind: 'error'; message: string };

interface OfferSummary {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  binding?: string;
  validUntil?: number;
}

interface PaymentSummary {
  scheme: string;
  x402Version: number;
  unit?: string;
  channel?: string;
  cumulative?: string;
}

/** POST /playground/run body. */
const runSchema = z.object({
  route: z.string().max(64),
  data: z.unknown().optional(),
  paymentHeader: z.string().max(65_536).optional(),
  pay: z.boolean().optional(),
});

const html = readFileSync(new URL('./playground.html', import.meta.url), 'utf8');

export function playground(options: PlaygroundOptions): Router {
  const log = moduleLogger(options.logger, 'demo.playground');
  const router = express.Router();
  const { network } = options;
  const env = { ...process.env, OBBYX_HOME: options.buyerHome };
  const wallet = loadWallet(network, env);
  const client = new obyte.Client(options.hubUrl ?? network.defaultHubUrl, {
    testnet: network.testnet,
    reconnect: true,
  });
  startHeartbeat(client);
  const composer = new ReservingComposer({
    client,
    network: network.caip2,
    address: wallet.address,
    reservations: new CoinReservations(join(options.buyerHome, `coins-${network.name}.db`)),
    logger: options.logger,
  });
  const channels = new ClientChannelStore(join(options.buyerHome, `channels-${network.name}.db`));
  let busy = false;

  router.get('/playground', (_req, res) => {
    res.type('html').send(html);
  });

  router.get('/playground/info', (_req, res) => {
    res.json({
      network: network.caip2,
      buyer: wallet.address,
      routes: Object.fromEntries(
        Object.entries(options.routes).map(([k, r]) => [k, { ...r, price: r.price.toString() }]),
      ),
    });
  });

  router.post('/playground/run', express.json({ limit: '16kb' }), async (req, res) => {
    const parsedBody = runSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: 'invalid request' });
      return;
    }
    const body = parsedBody.data;
    const route = Object.hasOwn(options.routes, body.route)
      ? options.routes[body.route]
      : undefined;
    if (route === undefined) {
      res.status(400).json({ error: 'unknown route' });
      return;
    }
    if (busy) {
      res.status(409).json({ error: 'another run is in progress' });
      return;
    }
    busy = true;
    const steps: Step[] = [];
    const tracing = tracingFetch(steps, network);
    const url = `${options.sellerUrl}${route.path}`;
    const init: RequestInit = {
      method: route.method,
      ...(route.method === 'POST'
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body.data ?? {}) }
        : {}),
    };
    try {
      if (body.pay === false) {
        await tracing(url, init); // just show the 402 offer
      } else {
        const maxAmount = new Map([['base', route.price]]);
        await payingFetch(
          url,
          { ...init, ...(body.paymentHeader ? { paymentHeader: body.paymentHeader } : {}) },
          {
            mechanisms: {
              exact: new ExactObyteClient({
                client,
                network: network.caip2,
                privateKey: wallet.privateKey,
                logger: options.logger,
                composer,
                maxFee: 10_000n,
              }),
              batch: new BatchObyteClient({
                client,
                network,
                privateKey: wallet.privateKey,
                store: channels,
                logger: options.logger,
                maxAmount,
                composer,
              }),
            },
            network: network.caip2,
            maxAmount,
            logger: options.logger,
            pendingTimeoutMs: 20_000,
            fetch: tracing,
          },
        );
      }
    } catch (err) {
      if (err instanceof PaymentPendingError) {
        steps.push({
          kind: 'pending',
          transaction: err.transaction,
          paymentHeader: err.paymentHeader,
        });
      } else {
        log.warn({ err }, 'playground run failed');
        steps.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      busy = false;
    }
    res.json({ buyer: wallet.address, steps });
  });

  return router;
}

/** fetch that records each request/response with decoded x402 headers. */
export function tracingFetch(steps: Step[], network: ObyteNetwork): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const method = init?.method ?? request?.method ?? 'GET';
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const signature = new Headers(init?.headers ?? request?.headers).get('PAYMENT-SIGNATURE');
    steps.push({
      kind: 'request',
      method,
      url,
      ...(signature ? { payment: summarizePayment(signature) } : {}),
    });
    const res = await fetch(input, init);
    const required = res.headers.get('PAYMENT-REQUIRED');
    const response = res.headers.get('PAYMENT-RESPONSE');
    const settlement = response
      ? (decodePaymentResponseHeader(response) as Record<string, unknown>)
      : undefined;
    const tx = typeof settlement?.['transaction'] === 'string' ? settlement['transaction'] : '';
    let parsed: unknown;
    const text = await res.clone().text();
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text.slice(0, 2000);
    }
    steps.push({
      kind: 'response',
      status: res.status,
      ...(required ? { offer: summarizeOffer(required) } : {}),
      ...(settlement ? { settlement } : {}),
      ...(settlement?.['success'] === true && /^[A-Za-z0-9+/]{43}=$/.test(tx)
        ? { explorer: explorerUnitUrl(network, tx) }
        : {}),
      ...(res.status === 402 ? {} : { body: parsed }),
    });
    return res;
  };
}

function summarizeOffer(header: string): OfferSummary[] {
  return decodePaymentRequiredHeader(header).accepts.map((a) => {
    const extra = a.extra as { binding?: string; validUntil?: number };
    return {
      scheme: a.scheme,
      network: a.network,
      asset: a.asset,
      amount: a.amount,
      payTo: a.payTo,
      ...(extra.binding ? { binding: `${extra.binding.slice(0, 12)}…` } : {}),
      ...(extra.validUntil ? { validUntil: extra.validUntil } : {}),
    };
  });
}

function summarizePayment(header: string): PaymentSummary {
  const p = decodePaymentSignatureHeader(header);
  const payload = p.payload as {
    unit?: { unit?: string };
    signedPackage?: { signed_message?: { aa_address?: string; amount_spent?: number } };
  };
  const voucher = payload.signedPackage?.signed_message;
  return {
    scheme: p.accepted.scheme,
    x402Version: p.x402Version,
    ...(payload.unit?.unit ? { unit: payload.unit.unit } : {}),
    ...(voucher?.aa_address ? { channel: voucher.aa_address } : {}),
    ...(voucher?.amount_spent !== undefined ? { cumulative: String(voucher.amount_spent) } : {}),
  };
}
