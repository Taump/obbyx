import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import express from 'express';
import { HTTPFacilitatorClient } from '@x402/core/http';
import { loadConfig } from '@obbyx/obyte/config';
import { createLoggerFromEnv, moduleLogger } from '@obbyx/obyte/logger';
import { ConsumedProofsStore, ObytePaywall } from '@obbyx/sdk';
import { demoEnvSchema } from './config.js';
import { playground } from './playground/playground.js';
import { OBYTE_NETWORKS, getNetwork } from '@obbyx/obyte';

/**
 * Demo seller: a tiny paid API on Obyte testnet.
 *
 *   PAY_TO=<your Obyte address> SELLER_SECRET=<32+ chars> pnpm --filter @obbyx/demo dev
 */
const config = loadConfig(demoEnvSchema, process.env);

const logger = createLoggerFromEnv('obbyx-demo');
const log = moduleLogger(logger, 'demo');
mkdirSync(dirname(config.DB_PATH), { recursive: true });

const paywall = new ObytePaywall({
  facilitator: new HTTPFacilitatorClient({
    url: config.FACILITATOR_URL,
    ...(config.FACILITATOR_API_KEY === undefined
      ? {}
      : {
          createAuthHeaders: async () => {
            const headers = { Authorization: `Bearer ${config.FACILITATOR_API_KEY}` };
            return { verify: headers, settle: headers };
          },
        }),
  }),
  network: config.NETWORK,
  payTo: config.PAY_TO,
  sellerId: config.SELLER_ID,
  secret: config.SELLER_SECRET,
  store: new ConsumedProofsStore(config.DB_PATH),
  logger,
  ...(config.BATCH_MIN_CHANNEL_TIMEOUT === undefined
    ? {}
    : { batch: { minChannelTimeoutSeconds: config.BATCH_MIN_CHANNEL_TIMEOUT } }),
});

const FORTUNES = [
  'A paid request is a happy request.',
  'Your next API call will be worth every byte.',
  'Stability comes to those who wait for the main chain.',
];

const app = express();
app.use(express.json({ limit: '16kb' }));

app.get('/', (_req, res) => {
  res.json({
    service: 'obbyx demo',
    network: config.NETWORK,
    payTo: config.PAY_TO,
    routes: {
      'GET /api/fortune': '10000 bytes',
      'POST /api/echo': '20000 bytes',
    },
  });
});

app.get(
  '/api/fortune',
  paywall.paid(
    { price: { amount: '10000' }, description: 'A fortune', mimeType: 'application/json' },
    () => ({
      body: { fortune: FORTUNES[Math.floor(Math.random() * FORTUNES.length)] },
    }),
  ),
);

app.post(
  '/api/echo',
  paywall.paid(
    {
      price: { amount: '20000' },
      description: 'Echo your JSON back',
      mimeType: 'application/json',
    },
    (req) => ({
      body: { echo: req.body as unknown, at: new Date().toISOString() },
    }),
  ),
);

if (config.PLAYGROUND_BUYER_HOME !== undefined) {
  const network = getNetwork(config.NETWORK);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.HOST);
  if (network !== OBYTE_NETWORKS.testnet || !loopback) {
    log.fatal(
      'the playground runs only on testnet with a loopback HOST (it spends the buyer wallet)',
    );
    process.exit(1);
  }
  app.use(
    playground({
      network,
      buyerHome: config.PLAYGROUND_BUYER_HOME,
      sellerUrl: `http://${config.HOST}:${config.PORT}`,
      routes: {
        fortune: { method: 'GET', path: '/api/fortune', price: 10_000n },
        echo: { method: 'POST', path: '/api/echo', price: 20_000n },
      },
      logger,
      ...(config.HUB_URL === undefined ? {} : { hubUrl: config.HUB_URL }),
    }),
  );
  log.info({ url: `http://${config.HOST}:${config.PORT}/playground` }, 'playground enabled');
}

app.listen(config.PORT, config.HOST, () => {
  log.info(
    {
      url: `http://${config.HOST}:${config.PORT}`,
      facilitator: config.FACILITATOR_URL,
      payTo: config.PAY_TO,
    },
    'demo seller started',
  );
});
