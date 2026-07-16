// Discreetly's Minister id_token + badge verifier now lives in the shared
// `@ministryofmany/minister-verify` package (a generalization of this file's former
// `makeVerifier`). The only app-coupling that was here - the direct pino logger
// import for rejected-badge observability - is now an injectable
// `onRejectedBadges(report)` callback wired up in `production-verifier.ts`.
//
// This re-export keeps every existing `../minister/verify.js` consumer (gate,
// trpc context, tests) unchanged. Remove this shim once consumers import
// `@ministryofmany/minister-verify` directly.
import type { VerifiedIdentity } from '@ministryofmany/minister-verify';

export {
  makeVerifier,
  type VerifiedIdentity,
  type VerifierDeps,
  type RejectedBadgesReport,
} from '@ministryofmany/minister-verify';

/**
 * A `VerifiedIdentity` plus the id_token's `minister_anon_epoch`. The shared
 * `@ministryofmany/minister-verify` package does not surface the epoch (it only
 * passes through `sybil_bucket`), so `production-verifier.ts` reads it from the
 * already-verified token and attaches it here. The epoch authorizes an
 * epoch-gated leaf rotation (audit finding C1); undefined when the token
 * carries no `minister_anon_epoch` claim.
 */
export type VerifiedIdentityWithEpoch = VerifiedIdentity & { minister_anon_epoch?: number };
