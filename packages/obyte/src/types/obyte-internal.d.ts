/**
 * Types for obyte.js internals used directly (ADR-0006). obyte.js publishes
 * types only for its public API; these helpers live in `lib/internal.js`.
 * The obyte.js version is pinned exactly; conformance tests against testnet
 * ledger data catch behavioural drift on upgrade.
 */
declare module 'obyte/lib/internal.js' {
  export function getUnitHash(unit: object): string;
  export function getUnitHashToSign(unit: object): Uint8Array;
  export function getSignedPackageHashToSign(pkg: object): Uint8Array;
  export function getBase64Hash(obj: unknown, jsonBased: boolean): string;
  export function getHeadersSize(unit: object, withKeys: boolean): number;
  export function getTotalPayloadSize(unit: object, withKeys: boolean): number;
  export function sign(hash: Uint8Array, privateKey: Uint8Array): string;
  export function verify(hash: Uint8Array, signature: string, pubkey: string): boolean;
  export function toPublicKey(privateKey: Uint8Array): string;
  export function getSourceString(obj: unknown): string;
  export function chashGetChash160(sourceString: string): string;
}
