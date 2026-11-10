import type { FastifyInstance, FastifyReply } from 'fastify';
import type { x402Facilitator } from '@x402/core/facilitator';
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import { type Logger, fingerprint, withLogContext } from '@obbyx/obyte/logger';
import { settleUnexpected, verifyUnexpected } from '../errors.js';
import { parseX402Request } from '../schemas.js';

export interface PaymentRoutesDeps {
  readonly core: x402Facilitator;
  readonly log: Logger;
  /** Network reported when a request has none (malformed body). */
  readonly defaultNetwork: string;
  /** Runs after a successful settle (Bazaar cataloging); never affects the result. */
  readonly afterSettle?: (
    reply: FastifyReply,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ) => Promise<void>;
}

/**
 * x402 REST: POST /verify (moves no funds and stores no new voucher; it may
 * cancel a stored voucher that is definitely refused), POST /settle
 * (idempotent), GET /supported.
 */
export function registerPaymentRoutes(http: FastifyInstance, deps: PaymentRoutesDeps): void {
  const { core, log } = deps;

  http.post('/verify', async (request, reply): Promise<VerifyResponse> => {
    const body = parseX402Request(request.body);
    if (body === undefined) {
      void reply.status(400);
      return { isValid: false, invalidReason: 'missing_parameters' };
    }
    const { paymentPayload, paymentRequirements } = body;
    return withLogContext(context(request.id, paymentPayload, paymentRequirements), async () => {
      try {
        return await core.verify(paymentPayload, paymentRequirements);
      } catch (err) {
        return verifyUnexpected(err, log);
      }
    });
  });

  http.post('/settle', async (request, reply): Promise<SettleResponse> => {
    const body = parseX402Request(request.body);
    if (body === undefined) {
      void reply.status(400);
      return {
        success: false,
        errorReason: 'missing_parameters',
        transaction: '',
        network: deps.defaultNetwork as SettleResponse['network'],
      };
    }
    const { paymentPayload, paymentRequirements } = body;
    return withLogContext(context(request.id, paymentPayload, paymentRequirements), async () => {
      let result: SettleResponse;
      try {
        result = await core.settle(paymentPayload, paymentRequirements);
      } catch (err) {
        return settleUnexpected(err, paymentPayload, paymentRequirements.network, log);
      }
      if (result.success) await deps.afterSettle?.(reply, paymentPayload, paymentRequirements);
      return result;
    });
  });

  http.get('/supported', async () => core.getSupported());
}

/** Correlation fields for every log line of one payment request. */
function context(requestId: string, payload: PaymentPayload, req: PaymentRequirements) {
  const unit = (payload.payload['unit'] as { unit?: unknown } | undefined)?.unit;
  const binding = req.extra?.['binding'];
  return {
    requestId,
    network: req.network,
    scheme: req.scheme,
    x402Version: payload.x402Version,
    proofId: typeof unit === 'string' ? unit : fingerprint(payload.payload),
    ...(typeof binding === 'string' ? { binding } : {}),
  };
}
