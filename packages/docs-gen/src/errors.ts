/**
 * Catalog of every machine-readable reason obbyx returns. A test checks that
 * every reason constant and every `invalid_* / payment_* / settlement_*`
 * literal in the sources is documented here.
 */
export type Where = 'facilitator' | 'seller' | 'client';

export interface ErrorDoc {
  readonly code: string;
  readonly where: Where;
  /** Why it happens. */
  readonly cause: string;
  /** What the reader of the error should do. */
  readonly action: string;
}

export interface ErrorGroup {
  readonly title: string;
  readonly intro: string;
  readonly errors: readonly ErrorDoc[];
}

const f = (code: string, cause: string, action: string): ErrorDoc => ({
  code,
  where: 'facilitator',
  cause,
  action,
});
const s = (code: string, cause: string, action: string): ErrorDoc => ({
  code,
  where: 'seller',
  cause,
  action,
});
const c = (code: string, cause: string, action: string): ErrorDoc => ({
  code,
  where: 'client',
  cause,
  action,
});

const RETRY_SAME = 'Repeat the same request later; it never pays twice.';
const CLIENT_BUG = 'Client or SDK bug: report it with the request id from the logs.';

export const ERROR_GROUPS: readonly ErrorGroup[] = [
  {
    title: 'Common (any scheme)',
    intro: 'Returned by /verify (`invalidReason`) and /settle (`errorReason`) for any scheme.',
    errors: [
      f(
        'settlement_pending',
        'The payment is valid and in progress but not final yet (exact: waiting for stability; batch: waiting for the seller watcher).',
        RETRY_SAME + ' `transaction` holds the unit hash / commitment id to track.',
      ),
      f(
        'invalid_payment_requirements',
        'The requirements are malformed, or `accepted` in the payload differs from what the seller asked for.',
        'Seller: check the offer (amount, asset, payTo, extra). Client: pay the offer exactly as received.',
      ),
      f(
        'invalid_network',
        'Network is not an Obyte network served here, or the payload and the requirements name different networks.',
        'Use a network listed in GET /supported.',
      ),
      f(
        'unsupported_scheme',
        'The scheme/network pair is not registered on this facilitator.',
        'Use a kind listed in GET /supported.',
      ),
      f(
        'invalid_x402_version',
        'x402Version is not supported for this request (v1 is accepted for exact only).',
        'Use x402 v2 (v1 only for exact).',
      ),
      f('invalid_payload', 'The payment payload has the wrong shape for its scheme.', CLIENT_BUG),
      f(
        'missing_parameters',
        'The request body lacks paymentPayload or paymentRequirements.',
        'Send `{x402Version, paymentPayload, paymentRequirements}`.',
      ),
      f(
        'invalid_json',
        'The request body is not valid JSON.',
        'Send `content-type: application/json` with a JSON body.',
      ),
      f(
        'unexpected_verify_error',
        'Internal error during /verify (logged with the request id).',
        'Retry; if it repeats, the operator checks the facilitator logs.',
      ),
      f(
        'unexpected_settle_error',
        'Internal error during /settle (logged with the request id).',
        RETRY_SAME,
      ),
      f(
        'unauthorized',
        'FACILITATOR_API_KEYS is set and the request has no valid key (HTTP 401).',
        'Send `Authorization: Bearer <key>` (HTTPFacilitatorClient `createAuthHeaders`).',
      ),
      f(
        'rate_limited',
        'More than RATE_LIMIT_PER_MINUTE requests from this key or IP (HTTP 429).',
        'Slow down; the operator can raise the limit.',
      ),
      f(
        'package_corrupt',
        'A stored channel package cannot be decrypted (wrong PACKAGE_KEY_FILE or a tampered row); the operation fails closed.',
        'Operator: restore the original key file. Never replace it while channel payments are pending.',
      ),
      f(
        'package_not_encrypted',
        'A stored channel package is not encrypted (database written by an older build).',
        'Operator: let pending channel payments finish on the old build, then start the new one on a fresh database.',
      ),
    ],
  },
  {
    title: 'exact',
    intro: 'The client signs a complete Obyte unit; the facilitator checks it and broadcasts it.',
    errors: [
      f(
        'invalid_exact_obyte_unsupported_unit',
        'The unit has fields, messages or authors outside the supported profile (one author, payment + data messages).',
        'Compose the payment with ExactObyteClient.',
      ),
      f(
        'invalid_exact_obyte_unit_too_large',
        'The unit exceeds the size limit.',
        'Use fewer inputs (consolidate coins).',
      ),
      f(
        'invalid_exact_obyte_network',
        'The unit version/alt does not belong to the requested network (e.g. a livenet unit on testnet).',
        'Sign the unit for the network of the offer.',
      ),
      f('invalid_exact_obyte_unit_hash', 'The unit hash does not match its content.', CLIENT_BUG),
      f(
        'invalid_exact_obyte_payload_hash',
        'A message payload hash does not match the payload.',
        CLIENT_BUG,
      ),
      f(
        'invalid_exact_obyte_definition',
        'The address definition does not match the author address.',
        CLIENT_BUG,
      ),
      f(
        'invalid_exact_obyte_definition_required',
        'The address is not known on the ledger yet and the unit does not include its definition.',
        'Include the definition in the first unit from a new address (ExactObyteClient does this).',
      ),
      f(
        'invalid_exact_obyte_signature',
        'The author signature is invalid.',
        'Check the wallet key; re-sign.',
      ),
      f(
        'invalid_exact_obyte_commissions',
        'Header/payload commissions do not match the unit size.',
        'Recompose the unit with current parent/witness data.',
      ),
      f(
        'invalid_exact_obyte_recipient_mismatch',
        'No output pays exactly `payTo`.',
        'Pay the seller address of the offer.',
      ),
      f(
        'invalid_exact_obyte_amount_mismatch',
        'The amount paid to `payTo` differs from the offer.',
        'Pay exactly `amount`.',
      ),
      f(
        'invalid_exact_obyte_asset_mismatch',
        'The unit pays a different asset than the offer (or an asset not allowed here).',
        'Pay the `asset` of the offer.',
      ),
      f(
        'invalid_exact_obyte_binding_mismatch',
        'The data message does not carry the binding/quoteId of the offer.',
        'Pay the current offer; a payment for one request cannot pay for another.',
      ),
      f(
        'invalid_exact_obyte_payer',
        'The payer equals payTo, or is one of the facilitator operator addresses.',
        'Pay from your own wallet.',
      ),
      f(
        'invalid_exact_obyte_payto_is_aa',
        'payTo is an autonomous agent: a payment to it triggers the AA, which may bounce the funds back to the payer.',
        'Seller: use a plain address as payTo.',
      ),
      f(
        'invalid_exact_obyte_inputs',
        'An input does not exist, is not an output of the payer, or has the wrong asset/amount.',
        'Refresh the wallet coins and recompose.',
      ),
      f(
        'invalid_exact_obyte_stale',
        'The unit timestamp is outside maxTimeoutSeconds (+ clock skew), or its last ball is older than MAX_LAST_BALL_AGE_SECONDS (the network stable point lags).',
        'Compose a fresh unit and check the client clock; for a lagging network see the operations guide (slow stabilization).',
      ),
      f(
        'invalid_exact_obyte_quote_expired',
        'The offer `validUntil` has passed.',
        'Request a new offer (repeat the request without payment).',
      ),
      f(
        'invalid_exact_obyte_publication_window_expired',
        'The verified unit was not settled within PUBLISH_WINDOW_SECONDS.',
        'Pay again with a fresh offer.',
      ),
      f(
        'invalid_exact_obyte_rejected_by_network',
        'The hub rejected the unit (e.g. inputs already spent).',
        'Recompose with unspent coins.',
      ),
      f(
        'invalid_exact_obyte_double_spend',
        'The unit became final-bad (non-serial): the payer double-spent.',
        'The payment is void; do not serve.',
      ),
      f(
        'invalid_exact_obyte_ledger_unavailable',
        'The hub did not answer in time while checking the unit; the outcome is unknown.',
        RETRY_SAME,
      ),
    ],
  },
  {
    title: 'batch-settlement (payment channels)',
    intro:
      'The client signs an off-chain voucher for an Obyte AA channel; the seller watcher stores it before the facilitator confirms.',
    errors: [
      f(
        'invalid_batch_settlement_obyte_payload',
        'The voucher or channel fields are malformed.',
        CLIENT_BUG,
      ),
      f(
        'invalid_batch_settlement_obyte_voucher_signature',
        'The voucher signature does not verify for the channel client address.',
        'Sign with the wallet that opened the channel.',
      ),
      f(
        'invalid_batch_settlement_obyte_channel_not_found',
        'The channel AA does not exist on the ledger (or its definition is not stable yet).',
        'Wait until the open/deposit unit is stable, then retry.',
      ),
      f(
        'invalid_batch_settlement_obyte_channel_params',
        'The channel parameters do not name this seller/client/asset.',
        'Open a channel to the seller of the offer.',
      ),
      f(
        'invalid_batch_settlement_obyte_channel_timeout',
        'The channel dispute window is shorter than the seller minimum (`minTimeout`).',
        'Open a channel with --window ≥ minTimeout.',
      ),
      f(
        'invalid_batch_settlement_obyte_period_mismatch',
        'The voucher period differs from the current channel period.',
        'Resync the channel state (`obbyx channel status`).',
      ),
      f(
        'invalid_batch_settlement_obyte_channel_closing',
        'The channel is closing; it cannot accept new payments.',
        'Wait for the close to finish and open a new channel.',
      ),
      f(
        'invalid_batch_settlement_obyte_cumulative_exceeds_balance',
        'The cumulative amount exceeds the channel deposit.',
        'Top up: `obbyx channel deposit`.',
      ),
      f(
        'invalid_batch_settlement_obyte_cumulative_amount_mismatch',
        'The cumulative amount is not previous + price.',
        'Resync the channel state; the client store is behind or ahead.',
      ),
      f(
        'invalid_batch_settlement_obyte_payment_amount_mismatch',
        'The voucher increment differs from the offer amount.',
        'Pay exactly `amount`.',
      ),
      f(
        'invalid_batch_settlement_obyte_binding_mismatch',
        'The voucher does not carry the binding of the offer.',
        'Pay the current offer.',
      ),
      f(
        'invalid_batch_settlement_obyte_asset',
        'The channel asset is not accepted here.',
        'Use a channel in an allowed asset.',
      ),
      f(
        'invalid_batch_settlement_obyte_channel_busy',
        'Another voucher of this channel is in flight (one at a time per channel).',
        'Retry after the previous payment completes.',
      ),
      f(
        'invalid_batch_settlement_obyte_watcher_unavailable',
        'The seller watcher is offline, its heartbeat is stale, or it is underfunded.',
        'Seller: start the watcher and fund it (WATCHER_MIN_BYTES).',
      ),
      f(
        'invalid_batch_settlement_obyte_voucher_refused',
        "The seller's watcher signed a refusal (nack) of this voucher: it is cancelled, not charged, and the channel is free again.",
        'Client: pay again (a new voucher). Seller: check the watcher log for the reason.',
      ),
      f(
        'invalid_batch_settlement_obyte_ledger_unavailable',
        'The hub did not answer while reading the channel; the outcome is unknown.',
        RETRY_SAME,
      ),
      f(
        'invalid_batch_settlement_obyte_quote_expired',
        'The offer `validUntil` has passed.',
        'Request a new offer.',
      ),
    ],
  },
  {
    title: 'Signed packages and channel definitions',
    intro: 'Low-level validation reasons, surfaced inside the messages of the scheme errors above.',
    errors: [
      f(
        'invalid_signed_package',
        'The signed package has the wrong shape or extra fields.',
        CLIENT_BUG,
      ),
      f(
        'invalid_signed_package_definition',
        'The package definition does not match the signer address.',
        CLIENT_BUG,
      ),
      f(
        'invalid_signed_package_signature',
        'The package signature is invalid.',
        'Re-sign with the right key.',
      ),
      f(
        'invalid_signed_package_signer',
        'The package is signed by an unexpected address.',
        'Sign with the channel client wallet.',
      ),
      f(
        'invalid_signed_package_network',
        'The package was signed for another network.',
        'Sign for the network of the offer.',
      ),
      f(
        'invalid_channel_params',
        'The channel AA parameters are malformed.',
        'Use a channel created by obbyx / aa-channels-lib.',
      ),
      f(
        'invalid_channel_definition',
        'The address is not a channel of the supported base AA.',
        'Use a channel of the supported base AA.',
      ),
    ],
  },
  {
    title: 'Seller (ObytePaywall / ObyteExactServer)',
    intro:
      'HTTP errors the paid API returns to the client (JSON `{"error": code}` or a 402 with the reason).',
    errors: [
      s(
        'invalid_payment_header',
        'The PAYMENT-SIGNATURE header is not valid base64 JSON.',
        CLIENT_BUG,
      ),
      s(
        'invalid_binding',
        'The payment was made for another request (method, URL, body or price differ).',
        'Pay the offer of THIS request.',
      ),
      s(
        'invalid_payment_reused',
        'This proof was already used with a different binding.',
        'Do not reuse payments across requests.',
      ),
      s(
        'payment_already_used',
        'This proof already served a request (official middleware path).',
        'Pay again; one payment serves one operation.',
      ),
      s(
        'payment_in_progress',
        'The same payment (or payment-identifier) is being served right now.',
        'Wait and repeat the same request.',
      ),
      s(
        'payment_failed',
        'The payment definitely failed earlier (e.g. rejected or double-spent).',
        'Pay again with a fresh offer.',
      ),
      s(
        'quote_expired',
        'The offer expired before the payment arrived.',
        'Repeat the request without payment to get a new offer.',
      ),
      s(
        'invalid_payment',
        'The facilitator rejected the payment (the 402 carries its reason).',
        'See the facilitator reason in the 402 body.',
      ),
      s(
        'facilitator_unavailable',
        'The facilitator did not answer.',
        'Retry later (seller: check FACILITATOR_URL and its /health).',
      ),
      s(
        'missing_stored_response',
        'The proof is marked served but its stored response is missing (store damaged).',
        'Seller: check the proofs database; the client should contact the seller.',
      ),
      s(
        'payment_identifier_required',
        'The seller requires the payment-identifier extension and none was sent.',
        'Send a payment id (payingFetch does this automatically).',
      ),
      s(
        'invalid_payment_identifier',
        'The payment id is not 16–128 chars of [A-Za-z0-9_-].',
        'Use a valid id.',
      ),
      s(
        'payment_identifier_conflict',
        'The payment id was already used for a different operation.',
        'Use a new id for a new operation.',
      ),
      s(
        'invalid_price',
        'The route price is not `{asset, amount}` or `"<n> bytes"` / `"<x> GBYTE"`.',
        'Seller: fix the route configuration.',
      ),
    ],
  },
  {
    title: 'Client (SDK and CLI)',
    intro: 'Thrown as `ObbyxError` with this `code`.',
    errors: [
      c(
        'payment_pending',
        'The payment was made but is not final within the wait time.',
        'Retry later with the same payment (`obbyx pay … --payment <header>`).',
      ),
      c(
        'invalid_402',
        'The server answered 402 without a PAYMENT-REQUIRED header.',
        'The server is not an x402 server.',
      ),
      c(
        'invalid_amount',
        'An amount is not a valid non-negative number in the expected precision.',
        'Check --max/--deposit values (GBYTE, up to 9 decimals).',
      ),
      c('ledger_unavailable', 'The hub did not answer.', 'Retry; check --hub.'),
      c(
        'invalid_config',
        'An environment variable is invalid (all problems are listed).',
        'Fix the listed variables (see the configuration reference).',
      ),
      c('invalid_key', 'Internal: a storage key was built from empty parts.', CLIENT_BUG),
    ],
  },
];

export function renderErrors(): string {
  const lines = [
    '<!-- Generated by packages/docs-gen from packages/docs-gen/src/errors.ts. Do not edit. -->',
    '',
    '# Error codes',
    '',
    'Every machine-readable reason obbyx returns, why it happens and what to do.',
    '`settlement_pending` and the `*_ledger_unavailable` reasons mean "outcome unknown yet":',
    'repeat the same request later; it never pays twice.',
    '',
  ];
  for (const g of ERROR_GROUPS) {
    lines.push(
      `## ${g.title}`,
      '',
      g.intro,
      '',
      '| Code | Cause | What to do |',
      '| --- | --- | --- |',
    );
    for (const e of g.errors) lines.push(`| \`${e.code}\` | ${e.cause} | ${e.action} |`);
    lines.push('');
  }
  return lines.join('\n');
}
