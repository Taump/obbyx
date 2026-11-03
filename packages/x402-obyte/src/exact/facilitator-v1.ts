import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import { getNetwork, isObyteNetwork } from '@obbyx/obyte';
import type { ExactObyteFacilitator } from './facilitator.js';
import { EXACT_SCHEME } from './requirements.js';

/**
 * x402 **v1** for the Obyte `exact` scheme.
 *
 * v1 differs in shape only: plain network names (`obyte-testnet`),
 * `maxAmountRequired`, `resource`/`mimeType` inside the requirements, and a
 * payload without `accepted`. This adapter converts to the v2 shapes and runs
 * the SAME v2 mechanism with the SAME store: settlement keys use the CAIP-2 id,
 * so a proof spent through v1 can never be spent again through v2 (and vice versa).
 */
export interface PaymentRequirementsV1 {
  readonly scheme: string;
  readonly network: string;
  readonly maxAmountRequired: string;
  readonly resource: string;
  readonly description: string;
  readonly mimeType: string;
  readonly outputSchema?: Record<string, unknown>;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly asset: string;
  readonly extra: Record<string, unknown>;
}

export interface PaymentPayloadV1 {
  readonly x402Version: 1;
  readonly scheme: string;
  readonly network: string;
  readonly payload: Record<string, unknown>;
}

export function requirementsV1ToV2(req: PaymentRequirementsV1): PaymentRequirements {
  return {
    scheme: req.scheme,
    network: getNetwork(req.network).caip2,
    asset: req.asset,
    amount: req.maxAmountRequired,
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    extra: req.extra ?? {},
  };
}

export function requirementsV2ToV1(
  req: PaymentRequirements,
  resource: { url: string; description?: string; mimeType?: string },
): PaymentRequirementsV1 {
  return {
    scheme: req.scheme,
    network: getNetwork(req.network).v1Name,
    maxAmountRequired: req.amount,
    resource: resource.url,
    description: resource.description ?? '',
    mimeType: resource.mimeType ?? '',
    outputSchema: {},
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    asset: req.asset,
    extra: req.extra,
  };
}

export class ExactObyteFacilitatorV1 implements SchemeNetworkFacilitator {
  readonly scheme = EXACT_SCHEME;
  readonly caipFamily = 'obyte-*';

  constructor(private readonly v2: ExactObyteFacilitator) {}

  getExtra(network: Network): Record<string, unknown> | undefined {
    return this.v2.getExtra(getNetwork(network).caip2);
  }

  getSigners(): string[] {
    return [];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const converted = this.convert(payload, requirements);
    if (!converted.ok) return { isValid: false, invalidReason: converted.reason };
    return this.v2.verify(converted.payload, converted.requirements);
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const converted = this.convert(payload, requirements);
    const v1Network = (requirements as unknown as PaymentRequirementsV1).network as Network;
    if (!converted.ok)
      return { success: false, errorReason: converted.reason, transaction: '', network: v1Network };
    const res = await this.v2.settle(converted.payload, converted.requirements);
    return { ...res, network: v1Network };
  }

  private convert(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ):
    | { ok: true; payload: PaymentPayload; requirements: PaymentRequirements }
    | { ok: false; reason: string } {
    const p = payload as unknown as PaymentPayloadV1;
    const r = requirements as unknown as PaymentRequirementsV1;
    if (p.x402Version !== 1) return { ok: false, reason: 'invalid_x402_version' };
    if (p.scheme !== EXACT_SCHEME || r.scheme !== EXACT_SCHEME)
      return { ok: false, reason: 'unsupported_scheme' };
    if (!isObyteNetwork(r.network) || p.network !== r.network)
      return { ok: false, reason: 'invalid_network' };
    if (typeof r.maxAmountRequired !== 'string')
      return { ok: false, reason: 'invalid_payment_requirements' };
    const v2req = requirementsV1ToV2(r);
    // v1 has no `accepted`: the client paid the requirements the server sent.
    return {
      ok: true,
      requirements: v2req,
      payload: {
        x402Version: 2,
        resource: { url: r.resource, description: r.description, mimeType: r.mimeType },
        accepted: v2req,
        payload: p.payload,
      },
    };
  }
}
