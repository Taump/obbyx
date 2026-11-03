/**
 * OpenAPI 3.1 description of the facilitator HTTP API. Served at
 * GET /openapi.json and rendered into docs/reference/facilitator-api.md.
 * A test checks that the documented paths are exactly the registered routes.
 */

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});
const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const PaymentRequirements = obj(
  {
    scheme: { type: 'string', enum: ['exact', 'batch-settlement'] },
    network: str('CAIP-2 id: obyte:testnet or obyte:livenet (v1: obyte-testnet / obyte-livenet)'),
    asset: str('"base" (GBYTE) or an Obyte asset id'),
    amount: str('Amount in the smallest units (v1: maxAmountRequired)'),
    payTo: str('Seller Obyte address'),
    maxTimeoutSeconds: { type: 'integer' },
    extra: obj(
      {
        binding: str('64 hex chars: HMAC binding of this offer to one request'),
        quoteId: str(),
        validUntil: { type: 'integer', description: 'Unix seconds' },
        paymentFlow: { type: 'string', enum: ['authorization', 'upfront', 'escrow'] },
        baseAa: str('batch-settlement: channel base AA'),
        minTimeout: { type: 'integer', description: 'batch-settlement: minimum dispute window, s' },
      },
      ['binding', 'quoteId', 'validUntil'],
    ),
  },
  ['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds', 'extra'],
);

const PaymentPayload = obj(
  {
    x402Version: { type: 'integer', enum: [1, 2] },
    accepted: ref('PaymentRequirements'),
    resource: obj({ url: str(), description: str(), mimeType: str() }),
    payload: obj(
      {
        unit: { type: 'object', description: 'exact: the signed, unbroadcast Obyte unit' },
        voucher: { type: 'object', description: 'batch-settlement: the signed channel voucher' },
      },
      [],
    ),
    extensions: { type: 'object', additionalProperties: true },
  },
  ['x402Version', 'payload'],
);

const Request = obj(
  {
    x402Version: { type: 'integer', enum: [1, 2] },
    paymentPayload: ref('PaymentPayload'),
    paymentRequirements: ref('PaymentRequirements'),
  },
  ['x402Version', 'paymentPayload', 'paymentRequirements'],
);

const VerifyResponse = obj(
  {
    isValid: { type: 'boolean' },
    invalidReason: str('Machine-readable reason, see the error codes reference'),
    invalidMessage: str(),
    payer: str('Payer Obyte address'),
  },
  ['isValid'],
);

const SettleResponse = obj(
  {
    success: { type: 'boolean' },
    errorReason: str('e.g. settlement_pending (retry the same request later)'),
    errorMessage: str(),
    payer: str(),
    transaction: str(
      'Unit hash (exact) or commitment id (batch-settlement); non-empty when pending',
    ),
    network: str(),
    amount: str(),
    extra: { type: 'object', additionalProperties: true },
  },
  ['success', 'transaction', 'network'],
);

const Supported = obj(
  {
    kinds: {
      type: 'array',
      items: obj(
        {
          x402Version: { type: 'integer' },
          scheme: str(),
          network: str(),
          extra: { type: 'object', additionalProperties: true },
        },
        ['x402Version', 'scheme', 'network'],
      ),
    },
    extensions: { type: 'array', items: str() },
    signers: { type: 'object', additionalProperties: { type: 'array', items: str() } },
  },
  ['kinds'],
);

const DiscoveryResource = obj(
  {
    resource: str(),
    type: str(),
    x402Version: { type: 'integer' },
    accepts: { type: 'array', items: ref('PaymentRequirements') },
    lastUpdated: { type: 'string', format: 'date-time' },
    description: str(),
    mimeType: str(),
    serviceName: str(),
    tags: { type: 'array', items: str() },
    extensions: { type: 'object', additionalProperties: true },
  },
  ['resource', 'type', 'x402Version', 'accepts', 'lastUpdated'],
);

const filters = ['type', 'payTo', 'scheme', 'network'].map((name) => ({
  name,
  in: 'query',
  required: false,
  schema: { type: 'string' },
}));
const limit = {
  name: 'limit',
  in: 'query',
  required: false,
  schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
};

const refused = {
  '401': json(ref('Refusal'), 'Missing or wrong API key (when FACILITATOR_API_KEYS is set)'),
  '429': json(ref('Refusal'), 'Rate limit exceeded (RATE_LIMIT_PER_MINUTE)'),
  '400': json(ref('Refusal'), 'invalid_json / missing_parameters'),
  '413': { description: 'Body larger than BODY_LIMIT_BYTES' },
};

export function buildOpenApi(version = '0.0.0') {
  return {
    openapi: '3.1.0',
    info: {
      title: 'obbyx facilitator',
      version,
      description:
        'x402 facilitator for the Obyte network (schemes exact and batch-settlement). ' +
        'Non-custodial: it never holds funds. /verify is read-only; /settle broadcasts (exact) or ' +
        'commits a voucher via the seller watcher (batch-settlement) and is idempotent.',
    },
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } },
      schemas: {
        PaymentRequirements,
        PaymentPayload,
        Request,
        VerifyResponse,
        SettleResponse,
        Supported,
        DiscoveryResource,
        Refusal: { type: 'object', additionalProperties: true },
      },
    },
    paths: {
      '/verify': {
        post: {
          summary: 'Check a payment without moving funds',
          security: [{ apiKey: [] }, {}],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('Request') } },
          },
          responses: {
            '200': {
              ...json(ref('VerifyResponse'), 'Verification result (also for an invalid payment)'),
              headers: {
                'EXTENSION-RESPONSES': {
                  description: 'base64 JSON, e.g. {"bazaar":{"status":"success"}}',
                  schema: { type: 'string' },
                },
              },
            },
            ...refused,
          },
        },
      },
      '/settle': {
        post: {
          summary: 'Settle a verified payment (idempotent; repeat the same request while pending)',
          security: [{ apiKey: [] }, {}],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('Request') } },
          },
          responses: {
            '200': json(
              ref('SettleResponse'),
              'Settlement result; errorReason settlement_pending means "retry later"',
            ),
            ...refused,
          },
        },
      },
      '/supported': {
        get: {
          summary: 'Schemes, networks and extensions this facilitator serves',
          responses: { '200': json(ref('Supported'), 'Supported kinds') },
        },
      },
      '/discovery/resources': {
        get: {
          summary: 'Bazaar: list cataloged paid resources',
          parameters: [
            ...filters,
            limit,
            {
              name: 'offset',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
          ],
          responses: {
            '200': json(
              obj({
                x402Version: { type: 'integer' },
                items: { type: 'array', items: ref('DiscoveryResource') },
                pagination: obj({
                  limit: { type: 'integer' },
                  offset: { type: 'integer' },
                  total: { type: 'integer' },
                }),
              }),
              'One page of resources',
            ),
            '404': { description: 'Discovery is disabled' },
          },
        },
      },
      '/discovery/search': {
        get: {
          summary: 'Bazaar: search cataloged resources (all words must match)',
          parameters: [
            { name: 'query', in: 'query', required: true, schema: { type: 'string' } },
            ...filters,
            limit,
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '200': json(
              obj({
                x402Version: { type: 'integer' },
                resources: { type: 'array', items: ref('DiscoveryResource') },
                pagination: obj({
                  limit: { type: 'integer' },
                  cursor: { type: ['string', 'null'] },
                }),
              }),
              'Matching resources',
            ),
            '400': { description: 'query is required' },
            '404': { description: 'Discovery is disabled' },
          },
        },
      },
      '/health': {
        get: {
          summary: 'Liveness and basic state',
          responses: {
            '200': json(
              obj({
                ok: { type: 'boolean' },
                networks: { type: 'array', items: str() },
                finality: { type: 'string', enum: ['stable', 'accepted'] },
                activeSettlements: { type: 'integer' },
              }),
              'Service is up',
            ),
          },
        },
      },
      '/openapi.json': {
        get: {
          summary: 'This document',
          responses: { '200': { description: 'OpenAPI 3.1 JSON' } },
        },
      },
    },
  };
}
