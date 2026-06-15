/**
 * Browser stub for `@discreetly/circuits`.
 *
 * The real package reads circuit artifacts from disk with `node:fs` at module
 * load (for Node prove/verify defaults). In the browser we always pass explicit
 * `Uint8Array` artifacts to `generateRLNProof`, and never call `verifyRLNProof`,
 * so these defaults are unused. Aliasing the package to this stub keeps the
 * client bundle free of `node:fs` while preserving the symbol surface.
 *
 * `rlnVerificationKey` is a harmless placeholder: `new RLNVerifier(...)` only
 * inspects the key when `verifyProof` is called, which never happens client-side.
 */
export const rlnWasmPath = '';
export const rlnZkeyPath = '';
export const rlnVerificationKey: unknown = {};
