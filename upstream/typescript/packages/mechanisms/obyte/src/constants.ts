/** x402 scheme identifier. */
export const SCHEME_EXACT = "exact";

/** CAIP-2 family pattern of every Obyte network. */
export const OBYTE_CAIP_FAMILY = "obyte:*";

/**
 * CAIP-2 network identifiers. The `obyte` namespace is not registered in
 * ChainAgnostic/namespaces yet; these identifiers are proposed by the scheme
 * specification.
 */
export const OBYTE_LIVENET = "obyte:livenet";
export const OBYTE_TESTNET = "obyte:testnet";

/** Network identifiers this package supports. */
export const SUPPORTED_OBYTE_NETWORKS = [OBYTE_LIVENET, OBYTE_TESTNET] as const;

/** A supported Obyte CAIP-2 network identifier. */
export type ObyteNetwork = (typeof SUPPORTED_OBYTE_NETWORKS)[number];

/** Default hub (light vendor) of each network. */
export const DEFAULT_OBYTE_HUBS: Readonly<Record<ObyteNetwork, string>> = {
  [OBYTE_LIVENET]: "wss://obyte.org/bb",
  [OBYTE_TESTNET]: "wss://obyte.org/bb-test",
};

/** Unit `version` and `alt` of each network (current unit version only). */
export const UNIT_VERSIONS: Readonly<Record<ObyteNetwork, { version: string; alt: string }>> = {
  [OBYTE_LIVENET]: { version: "4.0", alt: "1" },
  [OBYTE_TESTNET]: { version: "4.0t", alt: "2" },
};

/** The native asset (bytes). */
export const BYTES_ASSET = "base";

/** Decimals of the native asset when expressed in GBYTE. */
export const BYTES_DECIMALS = 9;

/** Maximum serialized size of a payment unit, in characters. */
export const DEFAULT_MAX_UNIT_BYTES = 16 * 1024;

/** Default lifetime of an offer issued by the resource server, seconds. */
export const DEFAULT_QUOTE_TTL_SECONDS = 300;

/** Default time a claimed unit may still be broadcast, seconds. */
export const DEFAULT_PUBLISH_WINDOW_SECONDS = 300;

/** How long a unit that was posted is still looked for after the publication window, seconds. */
export const POSTED_UNIT_GRACE_SECONDS = 86_400;

/** Default tolerated clock difference between client, hub and facilitator, seconds. */
export const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 120;

/**
 * Default oldest accepted `last_ball` of a payment unit, seconds (3 h). With
 * little traffic the network's stable point normally lags up to about 2 h.
 */
export const DEFAULT_MAX_LAST_BALL_AGE_SECONDS = 10_800;

/** Default timeout of one hub request, milliseconds. */
export const DEFAULT_HUB_TIMEOUT_MS = 15_000;

/** Default time a request may hold a payment in `serving` before a retry takes it over, seconds. */
export const DEFAULT_SERVING_LEASE_SECONDS = 300;

/** Error: the payload or the unit is malformed. */
export const ERR_INVALID_PAYLOAD = "invalid_payload";
/** Error: the requirements are malformed or outside this scheme. */
export const ERR_INVALID_REQUIREMENTS = "invalid_payment_requirements";
/** Error: the network is not an Obyte network served here. */
export const ERR_INVALID_NETWORK = "invalid_network";
/** Error: the scheme is not `exact`. */
export const ERR_UNSUPPORTED_SCHEME = "unsupported_scheme";
/** Error: the x402 version is not 2. */
export const ERR_INVALID_VERSION = "invalid_x402_version";

/** Error: the unit is outside the supported profile. */
export const ERR_UNSUPPORTED_UNIT = "invalid_exact_obyte_unsupported_unit";
/** Error: the unit exceeds the size limit. */
export const ERR_UNIT_TOO_LARGE = "invalid_exact_obyte_unit_too_large";
/** Error: the unit's version or alt belongs to another network. */
export const ERR_NETWORK = "invalid_exact_obyte_network";
/** Error: the unit hash does not match its content. */
export const ERR_UNIT_HASH = "invalid_exact_obyte_unit_hash";
/** Error: a payload hash does not match its payload. */
export const ERR_PAYLOAD_HASH = "invalid_exact_obyte_payload_hash";
/** Error: the author definition is unsupported or does not match the address. */
export const ERR_DEFINITION = "invalid_exact_obyte_definition";
/** Error: the definition is not embedded and must be read from the ledger. */
export const ERR_DEFINITION_REQUIRED = "invalid_exact_obyte_definition_required";
/** Error: the author signature is invalid. */
export const ERR_SIGNATURE = "invalid_exact_obyte_signature";
/** Error: the commissions do not match the unit size. */
export const ERR_COMMISSIONS = "invalid_exact_obyte_commissions";
/** Error: outputs go to an address other than payTo or the payer. */
export const ERR_RECIPIENT = "invalid_exact_obyte_recipient_mismatch";
/** Error: the amount paid to payTo differs from the requirements. */
export const ERR_AMOUNT = "invalid_exact_obyte_amount_mismatch";
/** Error: the payment is in an unexpected or not accepted asset. */
export const ERR_ASSET = "invalid_exact_obyte_asset_mismatch";
/** Error: the signed binding does not match this operation. */
export const ERR_BINDING = "invalid_exact_obyte_binding_mismatch";
/** Error: the payer is payTo or a facilitator address. */
export const ERR_PAYER = "invalid_exact_obyte_payer";
/** Error: the network rejected the unit. */
export const ERR_REJECTED_BY_NETWORK = "invalid_exact_obyte_rejected_by_network";
/** Error: the unit became final-bad (double spend). */
export const ERR_DOUBLE_SPEND = "invalid_exact_obyte_double_spend";
/** Error: the unit was not published within the publication window. */
export const ERR_PUBLICATION_WINDOW_EXPIRED = "invalid_exact_obyte_publication_window_expired";
/** Error: the hub could not be read; the outcome is unknown. */
export const ERR_LEDGER_UNAVAILABLE = "invalid_exact_obyte_ledger_unavailable";
/** Error: the inputs do not exist, are not the payer's, are spent or do not balance. */
export const ERR_INPUTS = "invalid_exact_obyte_inputs";
/** Error: the unit or its last ball is too old. */
export const ERR_STALE = "invalid_exact_obyte_stale";
/** Error: the offer (`extra.validUntil`) has expired. */
export const ERR_QUOTE_EXPIRED = "invalid_exact_obyte_quote_expired";
/** Error: payTo is an autonomous agent. */
export const ERR_PAYTO_IS_AA = "invalid_exact_obyte_payto_is_aa";
/** Error: the payment is already bound to another operation. */
export const ERR_PAYMENT_REUSED = "invalid_exact_obyte_payment_reused";
/** Client: the price is above the configured or per-payment limit. */
export const ERR_AMOUNT_OVER_LIMIT = "amount_over_limit";
/** Client: the network fee of the composed unit is above the limit. */
export const ERR_FEE_OVER_LIMIT = "fee_over_limit";
/** Not final yet; retry with the same payment. Carries the unit hash. */
export const ERR_SETTLEMENT_PENDING = "settlement_pending";
/** Resource server: the payment already served a request. */
export const ERR_PAYMENT_ALREADY_USED = "invalid_exact_obyte_payment_already_used";
/** Resource server: another request is serving this payment right now. */
export const ERR_PAYMENT_IN_PROGRESS = "invalid_exact_obyte_payment_in_progress";
